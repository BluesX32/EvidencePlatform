# EvidencePlatform — Development Roadmap

> This document is the authoritative plan for what gets built, in what order, and why.
> Changes to MVP scope require an explicit decision recorded here — not organic accumulation.

---

## The Systematic Review Workflow (What the Software Must Mirror)

Evidence synthesis follows an invariant sequence. The software must respect this order because each step produces data that feeds the next. You cannot design around this.

| Step | Description | Volume |
|------|-------------|--------|
| 1. Protocol | Pre-register PICO question, inclusion/exclusion criteria, planned analyses | Once |
| 2. Search | Query multiple databases; record search strategy as evidence | ~100–50,000 records |
| 3. Deduplication | Remove cross-database duplicates; every decision is logged | Significant overlap |
| 4. Title/Abstract Screening | Two blinded reviewers: Include / Exclude / Uncertain + reason | High volume |
| 5. Full-Text Screening | Smaller set; deeper review with explicit exclusion reasons | ~10–30% of above |
| 6. Data Extraction | Structured PICO, study design, outcomes, sample size | Included set only |
| 7. Quality / Risk of Bias | Per-study validity assessment using structured tools | Included set only |
| 8. Synthesis | Narrative or quantitative aggregation | One per review |
| 9. Reporting | PRISMA flow, evidence tables, summary of findings | One per review |

**Key constraint:** Every phase boundary in the software maps to a step boundary in this workflow. Do not blur them.

---

## MVP Definition

### The Test
Could a researcher use this system to complete a real systematic review from literature import through full-text screening, and hand off a PRISMA-ready, fully auditable record set?

If yes: MVP achieved.

### Explicitly IN

- Protocol creation with PICO fields, inclusion/exclusion criteria, and immutable versioned snapshots
- Literature import: RIS, BibTeX, PubMed XML parsers with field normalization
- Deduplication: rule-based engine (exact DOI + fuzzy title/author), manual review queue for uncertain pairs, every decision logged
- Title/abstract screening: two-reviewer blinded workflow, disagreement detection, adjudication step
- Full-text screening: same model as title/abstract, with mandatory reason-for-exclusion
- Screening progress dashboard with live counts and conflict queue
- Basic structured extraction: fixed PICO form + study design + sample size, per-reviewer with field-level consensus
- PRISMA flow counts derived automatically from decision logs (never manually entered)
- Audit trail export: who decided what, when, for every record
- Project snapshot: full reproducible export of protocol + records + decisions + extractions as structured JSON
- Export: included/excluded record sets as RIS and CSV

### Explicitly OUT of MVP

| Feature | Reason Deferred |
|---------|----------------|
| LLM assistance (screening, extraction, dedup) | Core workflow must be correct without AI before AI is layered in |
| Custom extraction form builder | Fixed schema validates the data model first; builder is a sub-project |
| Risk of bias assessment tools | Domain-complex; separate phase |
| Meta-analysis / quantitative synthesis | Separate problem domain; export to R (metafor) instead |
| Full-text PDF upload and parsing | PDF extraction is unreliable; out of scope until core workflow is stable |
| Live API search (PubMed, Scopus) | File-based import covers the workflow; live search adds auth and rate-limit complexity |
| Real-time collaborative editing | Single-record locking is sufficient for MVP; true collaboration is post-MVP |
| Inter-rater reliability statistics (Cohen's kappa) | Post-MVP analytics layer |
| PRISMA diagram image generation | Counts are derived; diagram rendering is deferred |
| PDF or Word output | Export structured data; researchers format it |

---

## Phases

### Phase 0 — Foundation
**Weeks 1–3**

The schema is the most important artifact in this project. Getting it wrong cascades into every subsequent phase. Build this slowly and correctly.

**Deliverables:**
- PostgreSQL schema covering the full workflow, even for features not yet built:
  - `projects`, `project_members` (roles: Admin, Reviewer, Observer)
  - `protocols` (immutable versioned snapshots as JSONB)
  - `record_sources` (raw imported records, never mutated)
  - `records` (canonical deduplicated records, derived from sources)
  - `dedup_pairs` (pairs under review, confidence score, decision, rationale)
  - `screening_decisions` (per-reviewer per-record, not a status on the record)
  - `extraction_forms` (form definition, version-locked to protocol)
  - `extracted_data` (append-only; history is queryable)
  - `users`, audit columns (`created_at`, `created_by`, `updated_at`) on all mutation tables
- FastAPI project structure with routes organized by domain
- JWT authentication with project-scoped authorization
- Alembic migration baseline
- Docker Compose development environment (API, PostgreSQL, frontend dev server)
- CI pipeline: lint, type-check, test on every PR

**Schema decisions that must be made now and not revisited:**
1. `record_sources` and `records` are separate tables. Raw imports are preserved; canonical records are derived. This is non-negotiable for auditability.
2. `screening_decisions` is per-reviewer per-record. Record status is derived from decisions, never directly set.
3. Protocol versions are immutable. Store as JSONB with integer version numbers. Append only.
4. `extracted_data` is append-only. Every change produces a new row. The current value is the latest row.
5. Outcomes are a child table of `records` (one-to-many). Design for this now or pay for it in Phase 3.
6. Include a `metadata` JSONB column on `records` for future extensibility without migrations.

**Gate condition:** Schema reviewed by a domain expert (systematic review methodologist or research librarian) before Phase 1 begins.

---

### Phase 1 — Import and Deduplication
**Weeks 4–7**

Without records in the system, nothing else can be built or tested. Import and dedup must be solid before screening begins — screening operates on the deduplicated set.

**Deliverables:**
- File upload endpoint: accept RIS, BibTeX, PubMed XML
- Parser pipeline: raw bytes → format detection → field parsing → normalization → `record_sources` rows
  - Field normalization: title case, Unicode normalization, whitespace, ISSN/ISBN cleaning
  - Idempotent: re-uploading the same file does not create duplicate `record_sources`
- Deduplication pipeline, in stages:
  - Stage 1 — Exact DOI match: deterministic, auto-resolved, no manual review
  - Stage 2 — Fuzzy title + author overlap: creates `dedup_pairs` with confidence score using `rapidfuzz`
  - Stage 3 — Manual review queue: all uncertain pairs above a configurable threshold surface here
- Dedup review UI: side-by-side record comparison, Accept Duplicate / Reject / Flag for Later, rationale field
- Import job tracking: async background task, job table with status, record counts, source file metadata
- Import history view per project

**Key decisions:**
- Use `rapidfuzz` for string similarity — not an ML model. Predictable, auditable, fast.
- Deduplication must be re-runnable idempotently. Confidence thresholds are project-configurable.
- The dedup review queue is a first-class researcher UI, not an admin panel. Researchers own this step.
- Every dedup decision (including auto-resolved Stage 1 decisions) is written to `dedup_pairs` with reason.

**Gate condition:** 1,000-record import completes without data loss; deduplication produces correct results on a test corpus with known duplicates.

---

### Phase 2 — Screening Workflow
**Weeks 8–13**

The highest-volume, most cognitively demanding part of a review. Ergonomics here directly affect research quality. This is the most important UX phase.

**Deliverables:**
- Screening round management: title/abstract and full-text are distinct phases with separate completion gates
- Reviewer assignment: configurable workload distribution, assignment tracking
- Screening decision API: Include / Exclude / Uncertain + reason; optimistic locking per record
- Reason-for-exclusion: configurable controlled vocabulary per protocol, with free-text overflow; not free-text only (unstructured) and not rigid fixed list (insufficiently expressive)
- Blinded review enforcement: reviewer cannot see counterpart's decision before submitting their own
- Disagreement detection: after both reviewers decide, conflicts are automatically flagged
- Adjudication workflow: third reviewer or designated arbitrator resolves conflicts with logged rationale
- Screening UI:
  - Single-record view: title, abstract, full citation, protocol criteria visible in sidebar
  - Keyboard-navigable (include, exclude, next without mouse)
  - Decision summary bar showing progress, conflict count, remaining
- Screening progress dashboard: counts by status per reviewer, conflict queue, completion percentages
- Uncertainty handling: Uncertain is a valid terminal state that routes to adjudication, not coerced to include/exclude

**Key decisions:**
- Keyboard shortcuts are not a nice-to-have. A reviewer processing 3,000 records needs them.
- Per-record row-level locking in the database during concurrent access. Not optimistic-only.
- Blinded review is enforced at the API layer, not just the UI layer.
- Do not allow bypassing two-reviewer model in MVP. Single-reviewer mode is a post-MVP configuration option.

**Gate condition:** A complete end-to-end screening cycle (import → dedup → assign → screen → adjudicate) is demonstrable with two distinct user accounts.

---

### Phase 3 — Data Extraction
**Weeks 14–18**

Extraction is post-screening by definition and more domain-complex than screening. Start with a fixed schema to validate the data model before building a form builder.

**Deliverables:**
- Fixed extraction form covering:
  - Population: description, N (total), setting/country
  - Intervention: name, type, dose/intensity, duration
  - Comparator: name, type (active control / placebo / usual care / none)
  - Outcomes: primary and secondary (name, measurement tool, timepoint, direction) — one-to-many
  - Study design: RCT, cohort, case-control, cross-sectional, qualitative, other (specify)
  - Sample size: total enrolled, per arm, analyzed
  - Notes: free text, not for structured data
- `not_reported` as an explicit value on all fields (distinct from null / not yet extracted)
- Extraction assignment: same reviewer-pair model as screening
- Field-level consensus: after both reviewers extract, compare field by field, flag differences, require resolution
- Extraction version history: every field change is an append to `extracted_data`; history is queryable
- Evidence table view: tabulated extracted data with citation keys, sortable, filterable
- Export: CSV and JSON with record IDs for full traceability back to source

**Key decisions:**
- Do not build a form builder yet. Validate the data model with a fixed schema first. The temptation to generalize early is the primary risk in this phase.
- `not_reported` must be first-class. A null field is ambiguous (not extracted vs. not reported); these are methodologically different.
- Extracted data is append-only in the database. The UI shows the latest value per field; the history is accessible.

**Gate condition:** Two reviewers can complete extraction for a set of 10 studies and export a complete evidence table with full traceability to source records.

---

### Phase 4 — Reporting and Export
**Weeks 19–22**

The output phase. Everything prior feeds into this. The artifacts produced here are what researchers archive alongside published reviews.

**Deliverables:**
- PRISMA flow counts: records identified, duplicates removed, screened (title/abstract), excluded with top reasons, full-texts assessed, excluded with reasons, included — all derived from decision logs, never entered manually
- Audit trail export: complete log of all decisions (dedup, screening, extraction, adjudication) with actor, timestamp, rationale — CSV
- Project snapshot: full export of project state as structured JSON (protocol version + all records + all decisions + all extractions); format is documented and stable
- Evidence summary view: protocol, PRISMA counts, included study list, extracted evidence table in one view
- Basic PRISMA checklist: auto-filled fields from project data with indication of what the system can and cannot verify

**Key decisions:**
- PRISMA counts are derived, not entered. If a count requires manual input, the data model is incomplete.
- The project snapshot format is a public, documented artifact. It must be versioned and stable. Researchers will archive it with journals.
- Do not generate PDF or Word. Export structured data. Let researchers and their institutions format it.
- The snapshot must be importable — a researcher must be able to restore a project from a snapshot. Design the schema for this.

**Gate condition:** A domain expert (not the developer) can take the exported artifacts from a test review and use them directly in a manuscript without reformatting. The audit trail satisfies reproducibility requirements.

---

### Phase 5 — LLM Assistance Layer *(Post-MVP)*
**Weeks 23+**

The human review points — dedup queue, screening interface, extraction form — were designed with suggestion display in mind. AI is added into them, not around them.

**Deliverables:**
- Screening suggestion: given title + abstract + inclusion criteria → suggest Include / Exclude / Uncertain + rationale. Displayed alongside human decision interface, never as a default or a gate.
- Extraction pre-fill: given abstract or pasted full text → pre-populate extraction fields. Reviewer confirms or overrides each field. LLM-filled fields are visually flagged with distinct styling.
- Dedup disambiguation: for uncertain pairs in the manual queue → offer LLM comparison with explanation of similarities and differences.
- LLM call logging: every call stored with model ID, prompt hash, response, timestamp — part of the project audit trail.
- Provider abstraction: Anthropic, OpenAI, local (Ollama) behind a common interface. Full offline operation must remain possible.
- Opt-in per project: LLM assistance is disabled by default and enabled explicitly in project settings.

**Gate condition:** LLM assistance cannot ship until Phase 0–4 produces correct results without AI. The human workflow is the ground truth; AI suggestions are annotations on it.

---

### Phase 6 — Custom Extraction Forms *(Post-MVP)*
**Weeks 28+**

**Rationale for deferral:** Custom forms require a form schema definition language, a renderer, a validation engine, and migration logic for existing extractions. That is a significant sub-project. The fixed schema in Phase 3 validates the underlying data model. Build this only after Phase 3 has been used by real researchers and the data model is confirmed stable.

---

## Development Order Summary

```
Phase 0: Schema + Auth + Dev Environment
    │
    ▼
Phase 1: Import + Deduplication
    │
    ▼
Phase 2: Screening Workflow
    │
    ▼
Phase 3: Data Extraction
    │
    ▼
Phase 4: Reporting + Export
    │         ← MVP complete here
    ▼
Phase 5: LLM Assistance (opt-in, post-MVP)
    │
    ▼
Phase 6: Custom Extraction Forms (post-MVP)
```

Each phase gate must pass before the next phase begins. There is no parallel-tracking between phases — the dependency chain is hard.

---

## Risks

### Technical

**Deduplication correctness**
Fuzzy matching thresholds that work for one corpus fail for another. False negatives (missed duplicates) inflate record counts; false positives (merged distinct records) lose papers. Both are scientific errors.
— Mitigation: manual review queue is mandatory, not optional. Log every dedup decision. Allow re-running dedup with different thresholds.

**Schema rigidity across domains**
Clinical reviews (RCT-focused) and policy reviews (qualitative-focused) need different extraction schemas. A schema designed for one will frustrate the other.
— Mitigation: include a `metadata` JSONB column on `records` and `extracted_data` from Phase 0. This allows field extension without breaking migrations. Custom forms address this fully in Phase 6.

**Concurrent screening consistency**
Two reviewers hitting the same record simultaneously without coordination produces split decisions. Optimistic locking alone is insufficient at scale.
— Mitigation: row-level locking in PostgreSQL during screening decision writes. Design this in Phase 2, not as a hotfix.

**Async import failures**
Importing 50,000 records is not a synchronous request. Silent background task failures lose data with no user notification.
— Mitigation: import job table with explicit status, error capture, and retry support from Phase 1. Do not use fire-and-forget background tasks for anything that touches data.

**LLM non-determinism in audit trails**
LLM outputs are non-deterministic. A result produced today cannot be reproduced tomorrow with certainty.
— Mitigation: log every LLM call with model ID, full prompt, full response, and timestamp. The audit trail records what the model said, not what was expected. Temperature set to 0 where possible.

### Domain

**Methodological disagreement**
Evidence synthesis methodology is not fully standardized. The software encodes choices (what counts as a valid exclusion reason, which risk-of-bias tool, what constitutes adequate protocol registration) that some researchers will reject.
— Mitigation: make methodological choices explicit and configurable rather than hardcoded. Document choices and their rationale in the codebase.

**PRISMA guideline versioning**
PRISMA 2020 substantially updated PRISMA 2009. Future revisions will happen. The reporting layer must not hardcode checklist items.
— Mitigation: PRISMA checklist items are a configurable template, not a fixed field set. Version the template alongside the schema.

**Researcher trust in AI**
One visible LLM error (especially a plausible-sounding but wrong extraction) can permanently damage adoption of the entire system.
— Mitigation: LLM assistance is opt-in, clearly labeled, and never blocks a workflow step. Accuracy expectations are set in the UI before a user enables it.

### Scope

**PDF upload pressure**
Researchers will immediately request PDF upload and parsing. PDF extraction is notoriously unreliable for tables and structured fields — especially for older literature.
— Mitigation: explicitly out of scope in MVP with documented rationale. Workaround: paste abstract or relevant text into a notes field for extraction assistance.

**Meta-analysis requests**
Clinical researchers will want forest plots. Quantitative synthesis is a separate domain with its own correctness requirements and testing burden.
— Mitigation: out of scope permanently for v1. Export extraction data to R (metafor) or Python (PyMeta) instead. Document the export format for this use case.

**Protocol creep from early adopters**
Individual feature requests are often reasonable; collectively they prevent MVP completion.
— Mitigation: the MVP definition above is a commitment. Changes require a recorded decision in this document. Build in public and reference this roadmap when declining requests.

---

## Assumptions

| # | Assumption | Validation Method | If Wrong |
|---|------------|------------------|----------|
| 1 | Fixed PICO extraction schema covers the target user domain | Interview 2–3 domain researchers before Phase 3 | Redesign extraction model; defer Phase 3 |
| 2 | Two-reviewer blinded screening is the correct default workflow | Validate with potential users before Phase 2 | Add single-reviewer mode option to Phase 2 |
| 3 | PostgreSQL handles anticipated record volumes without performance engineering | Load test with 100,000 records before first deployment | Add read replicas or partition large tables |
| 4 | File-based import (RIS/BibTeX/XML) covers the search-to-import workflow | Validate with researchers doing active reviews | Add live API search in Phase 5 or 6 |
| 5 | LLM assistance can be layered onto existing UI surfaces without redesign | UI surfaces in Phases 2–3 must include suggestion-display space, even if empty in MVP | Phase 5 will require partial Phase 2/3 UI redesign |
| 6 | Open-source community will include domain experts, not just software contributors | Proactive outreach to systematic review community at time of public release | Software drifts from research practice without methodological input |

---

## Files to Create First

When implementation begins, these are the highest-dependency artifacts. Getting them wrong cascades.

| File | Why It's Critical |
|------|------------------|
| `backend/migrations/versions/001_initial_schema.py` | Every model, route, and service depends on this |
| `backend/app/models/` | ORM definitions that enforce integrity across all phases |
| `backend/app/services/deduplication.py` | Most domain-sensitive algorithm; highest risk of silent correctness failures |
| `backend/app/routers/screening.py` | Most complex state machine in the system |
| `frontend/src/components/screening/ScreeningInterface.tsx` | Highest-impact UX surface; reviewer ergonomics affect research quality |
