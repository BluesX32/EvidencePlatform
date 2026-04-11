"""Microsoft OneDrive full-text fetcher.

Uses the Microsoft Graph API to search a user's OneDrive for a PDF matching
the paper title, download it, and extract text via pdfplumber.

Called with a short-lived access token stored in user.api_keys["onedrive_access"].
If the token is expired or the search fails, returns None so the cascade falls
through to Unpaywall / Europe PMC.

Requires env vars: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_GRAPH_BASE = "https://graph.microsoft.com/v1.0"
_TIMEOUT = 30.0


def _sanitize_query(title: str) -> str:
    """Escape single quotes for OData search query syntax and cap length."""
    return title[:100].replace("'", "''")


async def fetch_from_onedrive(
    title: str,
    onedrive_token: str,
) -> Optional[str]:
    """Search the user's OneDrive for a PDF matching the paper title.

    Returns extracted plain text (up to _MAX_WORDS words) or None on any failure.
    The caller should fall through to other sources on None.
    """
    if not title or not onedrive_token:
        return None
    try:
        # Import here to avoid circular import (fulltext_fetcher ↔ onedrive_fetcher)
        from app.utils.fulltext_fetcher import _extract_pdf_text, _words_up_to, _MAX_WORDS  # noqa: PLC0415

        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            headers = {"Authorization": f"Bearer {onedrive_token}"}

            # Graph API file search — select fields needed to download
            search_resp = await client.get(
                f"{_GRAPH_BASE}/me/drive/root/search(q='{_sanitize_query(title)}')",
                headers=headers,
                params={
                    "$select": "id,name,file,@microsoft.graph.downloadUrl",
                    "$top": "10",
                },
            )
            if search_resp.status_code == 401:
                logger.debug("OneDrive token expired for search")
                return None
            if search_resp.status_code != 200:
                logger.debug("OneDrive search returned HTTP %s", search_resp.status_code)
                return None

            items = search_resp.json().get("value", [])
            # Pick the first result whose filename ends with .pdf
            pdf_item = next(
                (i for i in items if i.get("name", "").lower().endswith(".pdf")),
                None,
            )
            if pdf_item is None:
                return None

            # @microsoft.graph.downloadUrl is a pre-signed URL valid ~1h
            download_url = pdf_item.get("@microsoft.graph.downloadUrl")
            if not download_url:
                return None

            pdf_resp = await client.get(download_url)
            if pdf_resp.status_code != 200:
                return None

            text = _extract_pdf_text(pdf_resp.content)
            if text:
                return _words_up_to(text, _MAX_WORDS)
            return None

    except Exception:
        logger.debug("fetch_from_onedrive failed", exc_info=True)
        return None


async def refresh_onedrive_token(
    refresh_token: str,
    client_id: str,
    client_secret: str,
) -> Optional[dict]:
    """Exchange a refresh token for a new access token.

    Returns {"access_token": "...", "refresh_token": "..."} or None on failure.
    """
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                "https://login.microsoftonline.com/common/oauth2/v2.0/token",
                data={
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "refresh_token": refresh_token,
                    "grant_type": "refresh_token",
                    "scope": "files.read offline_access",
                },
            )
        if resp.status_code == 200:
            data = resp.json()
            return {
                "access_token": data.get("access_token"),
                "refresh_token": data.get("refresh_token", refresh_token),
            }
        logger.debug("OneDrive token refresh failed: %s", resp.status_code)
        return None
    except Exception:
        logger.debug("refresh_onedrive_token failed", exc_info=True)
        return None
