"""Resolve candidate full-text PDF/landing-page URLs for a given paper.

Priority order:
  1. Open-access PDF from Unpaywall (direct download, no auth required)
  2. PMC free full-text PDF (if PMCID known)
  3. PMC full-text HTML page
  4. DOI landing page (institutional proxy may intercept)
  5. Unpaywall landing page
  6. PubMed abstract (links to free PMC when available)
  7. Google Scholar (title search)
"""
from __future__ import annotations

import urllib.parse
from typing import Optional

import httpx
from pydantic import BaseModel

_UNPAYWALL_EMAIL = "evidenceplatform@jhu.edu"
_UNPAYWALL_TIMEOUT = 6.0  # seconds


class FulltextLink(BaseModel):
    url: str
    label: str
    source: str   # unpaywall_oa | pmc_pdf | pmc_html | doi | unpaywall | pubmed | scholar
    is_oa: bool   # known open-access
    is_pdf: bool  # direct PDF download (vs landing page)


async def resolve_links(
    doi: Optional[str],
    pmid: Optional[str],
    pmcid: Optional[str],
    title: Optional[str],
) -> list[FulltextLink]:
    links: list[FulltextLink] = []
    seen_sources: set[str] = set()

    # 1. Unpaywall — best OA PDF URL
    if doi:
        try:
            oa_pdf_url = await _unpaywall_best_pdf(doi)
            if oa_pdf_url:
                links.append(FulltextLink(
                    url=oa_pdf_url,
                    label="Open Access PDF",
                    source="unpaywall_oa",
                    is_oa=True,
                    is_pdf=True,
                ))
                seen_sources.add("unpaywall_oa")
        except Exception:
            pass  # non-fatal; fall through to other sources

    # 2. PMC free PDF (direct download)
    if pmcid:
        links.append(FulltextLink(
            url=f"https://www.ncbi.nlm.nih.gov/pmc/articles/{pmcid}/pdf/",
            label="PMC Free PDF",
            source="pmc_pdf",
            is_oa=True,
            is_pdf=True,
        ))
        # 3. PMC full-text HTML
        links.append(FulltextLink(
            url=f"https://www.ncbi.nlm.nih.gov/pmc/articles/{pmcid}",
            label="PMC Full Text",
            source="pmc_html",
            is_oa=True,
            is_pdf=False,
        ))

    # 4. Publisher via DOI
    if doi:
        links.append(FulltextLink(
            url=f"https://doi.org/{doi}",
            label="Publisher Page (DOI)",
            source="doi",
            is_oa=False,
            is_pdf=False,
        ))
        # 5. Unpaywall landing page (shows all OA locations)
        if "unpaywall_oa" not in seen_sources:
            links.append(FulltextLink(
                url=f"https://unpaywall.org/{doi}",
                label="Unpaywall",
                source="unpaywall",
                is_oa=False,
                is_pdf=False,
            ))

    # 6. PubMed abstract
    if pmid:
        links.append(FulltextLink(
            url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}",
            label="PubMed",
            source="pubmed",
            is_oa=False,
            is_pdf=False,
        ))

    # 7. Google Scholar fallback (title search)
    if title:
        q = urllib.parse.quote(title)
        links.append(FulltextLink(
            url=f"https://scholar.google.com/scholar?q={q}",
            label="Google Scholar",
            source="scholar",
            is_oa=False,
            is_pdf=False,
        ))

    return links


async def _unpaywall_best_pdf(doi: str) -> Optional[str]:
    """Return the best OA PDF URL from Unpaywall, or None."""
    encoded = urllib.parse.quote(doi, safe="")
    url = f"https://api.unpaywall.org/v2/{encoded}?email={_UNPAYWALL_EMAIL}"
    async with httpx.AsyncClient(timeout=_UNPAYWALL_TIMEOUT) as client:
        resp = await client.get(url, headers={"User-Agent": "EvidencePlatform/1.0"})
        if resp.status_code != 200:
            return None
        data = resp.json()
    best = data.get("best_oa_location") or {}
    return best.get("url_for_pdf") or best.get("url") or None
