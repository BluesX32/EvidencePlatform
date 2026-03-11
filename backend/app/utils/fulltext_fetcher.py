"""Full-text acquisition for LLM screening.

Priority order:
  1. Uploaded PDF (stored in fulltext_pdfs table → storage_path → pdfplumber)
  2. Unpaywall open-access PDF (if DOI available)
  3. Europe PMC full text XML (if PMID available)
  4. PubMed Central full text XML (if PMCID in raw_data)
  5. Abstract-only fallback

Returns (text: str | None, source: str) where source is one of:
  uploaded_pdf / unpaywall / europe_pmc / pubmed_central / abstract_only
"""
from __future__ import annotations

import io
import logging
import os
import xml.etree.ElementTree as ET
from typing import Optional

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.fulltext_pdf import FulltextPdf

logger = logging.getLogger(__name__)

UNPAYWALL_EMAIL = os.environ.get("UNPAYWALL_EMAIL", "")
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "uploads")

_TIMEOUT = 30.0
_MAX_WORDS = 8000


def _words_up_to(text: str, max_words: int) -> str:
    """Return up to max_words words from text."""
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words])


def _extract_pdf_text(pdf_bytes: bytes) -> Optional[str]:
    """Extract text from PDF bytes using pdfplumber. Returns None on error."""
    try:
        import pdfplumber  # type: ignore

        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            parts: list[str] = []
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    parts.append(page_text)
            full = "\n".join(parts).strip()
            return full if full else None
    except Exception:
        logger.debug("pdfplumber extraction failed", exc_info=True)
        return None


def _strip_xml_tags(xml_text: str) -> str:
    """Parse XML and return concatenated text content of all elements."""
    try:
        root = ET.fromstring(xml_text)
        texts = [t for t in root.itertext() if t and t.strip()]
        return " ".join(texts)
    except ET.ParseError:
        return xml_text


async def _text_from_uploaded_pdf(
    record_id: Optional[object],
    project_id: Optional[object],
    db: AsyncSession,
) -> Optional[str]:
    """Query fulltext_pdfs table for storage_path, extract text via pdfplumber."""
    try:
        import uuid as _uuid

        stmt = select(FulltextPdf).where(
            FulltextPdf.project_id == project_id,
            FulltextPdf.record_id == record_id,
        )
        row: Optional[FulltextPdf] = (await db.execute(stmt)).scalar_one_or_none()
        if row is None:
            return None
        import pathlib

        path = pathlib.Path(row.storage_path)
        if not path.exists():
            return None
        pdf_bytes = path.read_bytes()
        text = _extract_pdf_text(pdf_bytes)
        if text:
            return _words_up_to(text, _MAX_WORDS)
        return None
    except Exception:
        logger.debug("_text_from_uploaded_pdf failed", exc_info=True)
        return None


async def _text_from_unpaywall(doi: str) -> Optional[str]:
    """Fetch open-access PDF URL from Unpaywall, download PDF, extract text."""
    if not doi or not UNPAYWALL_EMAIL:
        return None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(
                f"https://api.unpaywall.org/v2/{doi}",
                params={"email": UNPAYWALL_EMAIL},
            )
            if resp.status_code != 200:
                return None
            data = resp.json()
            best = data.get("best_oa_location") or {}
            pdf_url = best.get("url_for_pdf")
            if not pdf_url:
                return None
            pdf_resp = await client.get(pdf_url)
            if pdf_resp.status_code != 200:
                return None
            text = _extract_pdf_text(pdf_resp.content)
            if text:
                return _words_up_to(text, _MAX_WORDS)
            return None
    except Exception:
        logger.debug("_text_from_unpaywall failed", exc_info=True)
        return None


async def _text_from_europe_pmc(pmid: str) -> Optional[str]:
    """Fetch full text XML from Europe PMC and extract text content."""
    if not pmid:
        return None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(
                f"https://www.ebi.ac.uk/europepmc/webservices/rest/{pmid}/fullTextXML"
            )
            if resp.status_code != 200:
                return None
            text = _strip_xml_tags(resp.text)
            if text and text.strip():
                return _words_up_to(text, _MAX_WORDS)
            return None
    except Exception:
        logger.debug("_text_from_europe_pmc failed", exc_info=True)
        return None


async def _text_from_pubmed_central(pmcid: str) -> Optional[str]:
    """Fetch full text XML from PubMed Central efetch and extract text content."""
    if not pmcid:
        return None
    # Normalise: strip leading "PMC" if present for the efetch id param
    clean_id = pmcid.upper().lstrip("PMC")
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(
                "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
                params={
                    "db": "pmc",
                    "id": clean_id,
                    "rettype": "xml",
                    "retmode": "xml",
                },
            )
            if resp.status_code != 200:
                return None
            text = _strip_xml_tags(resp.text)
            if text and text.strip():
                return _words_up_to(text, _MAX_WORDS)
            return None
    except Exception:
        logger.debug("_text_from_pubmed_central failed", exc_info=True)
        return None


async def get_full_text(
    record_id: Optional[object],
    project_id: Optional[object],
    doi: Optional[str],
    pmid: Optional[str],
    pmcid: Optional[str],
    db: AsyncSession,
) -> tuple[Optional[str], str]:
    """Fetch full text for a paper using a prioritised source cascade.

    Returns (text, source) where source is one of:
      uploaded_pdf / unpaywall / europe_pmc / pubmed_central / abstract_only
    """
    # 1. Uploaded PDF
    if record_id is not None:
        text = await _text_from_uploaded_pdf(record_id, project_id, db)
        if text:
            return text, "uploaded_pdf"

    # 2. Unpaywall
    if doi:
        text = await _text_from_unpaywall(doi)
        if text:
            return text, "unpaywall"

    # 3. Europe PMC (PMID-based)
    if pmid:
        text = await _text_from_europe_pmc(pmid)
        if text:
            return text, "europe_pmc"

    # 4. PubMed Central (PMCID-based)
    if pmcid:
        text = await _text_from_pubmed_central(pmcid)
        if text:
            return text, "pubmed_central"

    # 5. Abstract-only fallback
    return None, "abstract_only"
