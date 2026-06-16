# EvidencePlatform

**Open-source research infrastructure for scalable, reproducible evidence synthesis.**

---

## Overview

EvidencePlatform is an end-to-end systematic review and evidence synthesis platform built for researchers, policy analysts, and evidence synthesis teams. It transforms the fragmented, error-prone process of conducting a systematic review — from raw literature imports to final thematic synthesis — into a structured, auditable, and collaborative workflow.

Designed as durable community infrastructure rather than a disposable research prototype, EvidencePlatform is engineered for scientific rigor: every decision is traceable, every AI-assisted step is logged, and every output is reproducible from documented inputs.

---

## Mission

> *Move research teams from evidence to action with confidence — faster, more transparently, and with fewer errors than conventional workflows.*

Traditional systematic reviews are labor-intensive and prone to inconsistency: duplicate references slip through, screening decisions go unrecorded, and thematic patterns emerge only after extensive manual coding. EvidencePlatform automates the mechanical steps, enforces methodological consistency, and keeps human judgment at the center of every scientific decision.

---

## Who It Is For

| Audience | Use Case |
|---|---|
| Academic researchers | Conduct PRISMA-aligned systematic reviews with full audit trails |
| Policy analysts | Synthesize evidence bases for rapid, defensible briefings |
| Research teams | Multi-reviewer screening with inter-rater reliability tracking |
| Evidence synthesis labs | Reusable infrastructure for repeated review workflows |

---

## Core Capabilities

### 1. Multi-Source Literature Import
Import and parse citation files from any major database. The parser engine handles **RIS**, **MEDLINE/PubMed**, and similar formats with automatic encoding detection (UTF-8, Latin-1) and zero-space tag normalization. Duplicate author-formatting variants and malformed DOIs are corrected at ingestion.

Each import is tagged to a named **Source** (e.g. PubMed 2024, Embase, Scopus). Sources can be deleted by project admins; records that exist only in the deleted source are removed while records shared with other sources are preserved.

### 2. Intelligent Deduplication
A three-tier **Union-Find deduplication engine** identifies duplicate records across sources using configurable matching strategies:
- Exact DOI or PMID match
- Normalized title + year + first author
- Fuzzy title similarity (RapidFuzz) with author confirmation

Match strategies are configurable per project and stored for reproducibility. Every deduplication run is isolated behind an advisory lock, ensuring safe concurrent imports.

### 3. Cross-Source Overlap Detection
A five-tier **OverlapDetector** identifies the same paper appearing across multiple imported databases — a distinct problem from deduplication. Blocking keys (DOI buckets, title-prefix + year buckets) keep comparison complexity tractable at scale. Results are visualized as:
- **Euler diagram** — quantitative, area-proportional overlap map
- **Pairwise overlap matrix** — heatmap of shared cluster counts across all source pairs
- **Top intersection summary** — ranked list of highest-overlap source combinations

Overlap clusters can be manually linked, locked against algorithmic reruns, or resolved member-by-member.

### 4. Structured Screening Workflow
A full **PRISMA-aligned** title-abstract (TA) and full-text (FT) screening pipeline supporting:
- **Sequential mode** — TA screening → FT screening → extraction, in order
- **Mixed mode** — flexible stage navigation with automatic TA inclusion when FT is submitted directly
- **Claim-based soft locking** — 30-minute TTL claims prevent concurrent reviewers from screening the same item
- **Browse buckets** — reviewers can jump to any stage bucket (TA-included, FT-included, extracted) without losing progress
- **Back/forward navigation** — full review history within a session
- **Full-text link resolution** — automatic links to Unpaywall, PMC, PubMed, and Google Scholar per record
- **Custom exclusion reasons** — reviewers can type and save their own exclusion reasons as persistent chips alongside the built-in reason set; custom reasons are stored locally and reusable across sessions
- **Anchored annotations** — select any passage in the metadata or notes pane, add a comment, and it is stored as a structured annotation linked to the record; annotations are shown in a collapsible drawer during review
- **Inline label tagging** — assign project labels directly during screening; new labels can be created inline and are saved for future use
- **Inline concept tagging** — tag papers with ontology concepts during screening; new concepts can be created inline and are saved to the project ontology

### 5. LLM-Assisted Screening
AI-powered screening runs that process the entire corpus against project inclusion/exclusion criteria. Supports **15+ large language models** across providers:

| Provider | Models |
|---|---|
| Anthropic (direct) | Claude Sonnet 4.6, Claude Haiku 4.5, Claude Opus 4.6 |
| OpenAI via OpenRouter | GPT-4o, GPT-4.1 |
| Google via OpenRouter | Gemini 2.0 Flash, Gemini 2.5 Pro |
| Meta via OpenRouter | Llama 4 Scout, Llama 4 Maverick |
| DeepSeek via OpenRouter | DeepSeek V3, R1 (reasoning) |
| Mistral via OpenRouter | Mistral Large, Ministral 8B |
| Others via OpenRouter | Qwen 3, Command A, Nemotron |

Each run produces per-record decisions (include / exclude / uncertain) with rationale, matched thematic codes, and newly suggested concepts. Results feed directly into the screening pipeline or can be reviewed and merged independently. Cost and time estimates are shown before launch; all LLM inputs and outputs are logged with model version for audit. Multi-agent pipeline mode dispatches specialized sub-agents per record for higher-quality extraction.

### 6. Team Collaboration & Consensus
Multi-reviewer workflows with:
- **Project membership** — invite-by-token system with role-based access (admin / reviewer)
- **Dual-reviewer isolation** — each reviewer's decisions are stored independently with partial unique indexes
- **Conflict detection** — automatic identification of disagreeing TA or FT decisions across reviewers
- **Adjudication** — owners can adjudicate conflicts and record final consensus decisions
- **Inter-rater reliability** — Cohen's kappa computed per project, per stage, and per reviewer pair
- **Team screening stats** — agreement rates, decision distributions, and coverage per reviewer

### 7. Structured Data Extraction
Reviewers extract structured evidence from included full-text records using a flexible JSONB schema. The **Extraction Library** shows only papers that were included at both the title-abstract and full-text screening stages and have been extracted. The library provides:
- Inline edit panel — edit any field without leaving the list
- Search and filter — by source, label, or free text
- Full metadata enrichment — title, authors, year, DOI, source names per item

### 8. Citation Sourcing (Snowballing)
After data extraction, researchers can discover additional eligible papers through automated citation snowballing — a standard systematic review methodology. For each paper in the Extraction Library (TA+FT included AND extracted), the platform resolves its Semantic Scholar ID and fetches the complete reference list (backward sourcing) and all papers that cite it (forward sourcing). Results are cross-deduplicated, checked against existing project records, and presented for researcher review.

- **Backward sourcing** — fetches the full reference lists of extracted papers
- **Forward sourcing** — fetches papers that cite each extracted paper via the Semantic Scholar API
- **Manual import** — upload a RIS or MEDLINE file directly into the citation sourcing library when Semantic Scholar does not cover a database or paper; tagged with direction and optionally linked to a specific source paper; appending to an existing search is supported
- **Cohort scoping** — four modes: *All*, *New* (papers not yet sourced), *Custom* (researcher selects specific papers), or *Manual* (file upload)
- **Direction-aware deduplication** — same paper can correctly appear as both backward and forward; unique index on `search_id + direction + doi/pmid/s2_paper_id`
- **Robust S2 resolution** — DOI (full prefix normalisation), PMID (regex extraction), title + year search (±2yr / ±5yr / no-year fallback)
- **Rate-limit resilience** — automatic 429 retry: 30s → 60s → 120s; one failing record never aborts the loop
- **Named per-article sources** — each import batch is grouped by source article and given a descriptive Source name (e.g. *← Refs: Smith 2020*); provenance is visible in the Extraction Library
- **Filter by source article** — source article filter buttons are derived directly from candidates in the database, so manually appended papers always appear alongside automatically discovered ones
- **Search history** — every run logged with timestamp, direction, scope, source paper count, candidate count, and already-in-project count

### 9. Thematic Analysis (Taxonomy)
A code-based thematic synthesis module for building and managing an evolving **taxonomy of themes**:
- Create and organize themes and sub-codes
- Assign codes to extracted evidence segments
- View all evidence assigned to a given code
- Track codebook history — every change logged with timestamp and author
- Saturation tracking — consecutive records without new code assignments surfaced as a progress indicator

### 10. Label System
Project-scoped **personal tags** with custom names and colors. Labels are entirely user-defined and carry no predefined structure — researchers use them to organize and retrieve papers however suits their workflow. Labels can be:
- Assigned to any article at any screening stage
- Created inline during screening
- Browsed on the dedicated **Labels page** — per-label article counts, filtered article lists, and progress stats

### 11. Ontology
A **hierarchical concept graph** for organizing the structural dimensions of an evidence base — levels of analysis, intervention types, outcome categories, populations, and other domain-specific dimensions.

- Hierarchical node tree with arbitrary depth (forest structure)
- Node namespaces: `level`, `dimension`, `concept`, `population`, `intervention`, `outcome`, `other`
- Drag-and-drop reparenting with cycle detection
- Sync levels from project criteria
- Export / import full ontology as JSON
- Concept tagging during screening — inline; new concepts saved to ontology for future use
- 3D graph view for exploring large taxonomies

### 12. PDF Viewer and Annotation
Full-text PDFs are uploaded per record or per cluster and stored server-side. A floating, draggable PDF viewer opens inline during the FT screening stage:
- Page navigation — previous/next with current-page indicator
- Freehand drawing — pen tool with configurable color and stroke width; strokes persist across sessions
- Eraser tool — remove individual drawn strokes; clear-page button
- Text selection and anchored notes — select any passage; stored as normalized highlight ({x,y,w,h}) with persistent yellow overlay; clicking a highlight opens the associated note
- Notes drawer — collapsible panel listing all annotations with page badges, quoted text previews, and delete controls
- Drag to reposition / resize — floats at a configurable position within the viewport

### 13. Concept Extraction
Project owners define a **concept template** — a structured set of fields typed as entity, relation, or metadata — that reviewers fill out per article during extraction. Templates support custom field types (text, select, multi-select) with placeholders and option lists. Built-in presets support ontology construction workflows.

Extracted concept data is aggregated per project in the **Concept Taxonomy** view:
- Entity, relation, and metadata tabs with value-frequency aggregation
- Bulk push to the project ontology with namespace and parent-node selection
- Tagging papers with ontology concepts inline during screening

---

## Three Orthogonal Organization Systems

| System | Purpose | Structure | Defined by |
|---|---|---|---|
| **Labels** | Personal retrieval tags | Flat list, no hierarchy | Entirely user-defined |
| **Taxonomy** (Thematic Analysis) | Bottom-up concept synthesis | Themes → sub-codes | Researcher builds from evidence |
| **Ontology** | Structural dimensions of the field | Hierarchical tree (forest) | Partially pre-defined + extensible |

---

## Workflow at a Glance

```
Import literature (RIS / MEDLINE)
        ↓
Auto-deduplication within each source
        ↓
Cross-source overlap detection + visualization
        ↓
Title-abstract screening (manual or LLM-assisted)
  → tag with labels and ontology concepts inline
        ↓
Full-text screening + PDF annotation
  → tag with labels and ontology concepts inline
        ↓
Structured data extraction
        ↓
Citation sourcing (backward + forward snowballing)
  → screen new candidates inline
  → import approved papers → re-enter pipeline
        ↓
Thematic coding + saturation analysis (taxonomy)
        ↓
Evidence synthesis output
```

Every stage generates a complete audit trail. At any point, a project owner can export decisions, review LLM run logs, inspect deduplication clusters, and reproduce the entire pipeline from source files.

---

## Relational Database Diagram

The platform uses PostgreSQL with 39 tables across 44 versioned Alembic migrations. The diagram below shows every table and its foreign-key relationships. PK = primary key · FK = foreign key · `?` = nullable FK.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              USERS & PROJECTS                                   │
│                                                                                 │
│  ┌───────────────────┐    ┌──────────────────────────────────────────────────┐  │
│  │       users       │    │                   projects                       │  │
│  │───────────────────│    │──────────────────────────────────────────────────│  │
│  │ id (PK)           │◄───│ created_by (FK→users)                            │  │
│  │ email (UNIQUE)    │    │ id (PK)                                          │  │
│  │ password_hash     │    │ name                                             │  │
│  │ name              │    │ description                                      │  │
│  │ is_admin          │    │ criteria (JSONB)                                 │  │
│  │ api_keys (JSONB)? │    │ extraction_template (JSONB)                      │  │
│  │ invite_code_id FK?│    │ concept_template (JSONB)                         │  │
│  │ created_at        │    │ llm_config (JSONB)                               │  │
│  └───────────────────┘    │ parent_project_id (FK→self)?  ← sub-projects     │  │
│                           │ shared_with_team                                 │  │
│  ┌───────────────────┐    │ created_at · updated_at                          │  │
│  │   invite_codes    │    └──────────────────────────────────────────────────┘  │
│  │───────────────────│                                                          │
│  │ id (PK)           │    ┌──────────────────────────────────────────────────┐  │
│  │ code (UNIQUE)     │    │               project_samples                    │  │
│  │ label?            │    │──────────────────────────────────────────────────│  │
│  │ max_uses?         │    │ id (PK)  │  parent_project_id (FK)               │  │
│  │ used_count        │    │ child_project_id (FK)  │  created_by (FK)        │  │
│  │ expires_at?       │    │ seed  │  n_per_corpus  │  sampled_record_ids     │  │
│  │ is_active         │    └──────────────────────────────────────────────────┘  │
│  └───────────────────┘                                                          │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                           TEAM COLLABORATION                                    │
│                                                                                 │
│  ┌─────────────────────┐   ┌────────────────────────┐   ┌──────────────────┐   │
│  │   project_members   │   │  project_invitations   │   │consensus_decision│   │
│  │─────────────────────│   │────────────────────────│   │──────────────────│   │
│  │ id (PK)             │   │ id (PK)                │   │ id (PK)          │   │
│  │ project_id (FK)     │   │ project_id (FK)        │   │ project_id (FK)  │   │
│  │ user_id (FK→users)  │   │ invited_by (FK→users)  │   │ record_id (FK)?  │   │
│  │ invited_by (FK)?    │   │ email                  │   │ cluster_id (FK)? │   │
│  │ role                │   │ role                   │   │ stage (TA|FT)    │   │
│  │ status              │   │ token (UNIQUE)         │   │ decision         │   │
│  └─────────────────────┘   │ status                 │   │ adjudicator_id   │   │
│                            └────────────────────────┘   └──────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                         IMPORT & RECORD PIPELINE                                │
│                                                                                 │
│  ┌──────────────┐    ┌─────────────────┐    ┌──────────────────────────────┐   │
│  │   sources    │    │   import_jobs   │    │           records            │   │
│  │──────────────│    │─────────────────│    │──────────────────────────────│   │
│  │ id (PK)      │◄───│ source_id (FK)? │    │ id (PK)                      │   │
│  │ project_id   │    │ id (PK)         │    │ project_id (FK)              │   │
│  │ name         │    │ project_id (FK) │    │ title · abstract             │   │
│  │ created_at   │    │ created_by (FK) │    │ authors · year · journal     │   │
│  └──────────────┘    │ filename        │    │ doi · issn · pmid            │   │
│         ▲            │ file_format     │    │ volume · pages               │   │
│         │            │ status          │    │ normalized_doi               │   │
│         │            │ record_count    │    │ match_key · match_basis      │   │
│         │            └────────┬────────┘    │ keywords · source_format     │   │
│         │                     │             │ created_at                   │   │
│         │                     │             └──────────────────────────────┘   │
│         │                     ▼                          ▲                     │
│         │          ┌─────────────────────────────────────┤                     │
│         │          │         record_sources              │                     │
│         │          │─────────────────────────────────────│                     │
│         └──────────│ source_id (FK→sources)              │                     │
│                    │ id (PK)                             │                     │
│                    │ record_id (FK→records) ─────────────┘                     │
│                    │ import_job_id (FK)                                        │
│                    │ raw_data (JSONB)                                          │
│                    │ norm_title · norm_first_author                            │
│                    │ match_year · match_doi                                    │
│                    └─────────────────────────────────────────────────────────  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                      DEDUPLICATION & OVERLAP                                    │
│                                                                                 │
│  ┌──────────────────────┐    ┌─────────────────────┐    ┌──────────────────┐   │
│  │   match_strategies   │    │     dedup_jobs       │    │    match_log     │   │
│  │──────────────────────│    │─────────────────────│    │──────────────────│   │
│  │ id (PK)              │◄───│ strategy_id (FK)     │◄───│ dedup_job_id(FK) │   │
│  │ project_id (FK)      │    │ id (PK)              │    │ id (PK)          │   │
│  │ name · preset        │    │ project_id (FK)      │    │ record_src_id    │   │
│  │ config (JSONB)       │    │ created_by (FK)      │    │ old_record_id?   │   │
│  │ selected_fields      │    │ status               │    │ new_record_id    │   │
│  │ is_active            │    │ records_before/after │    │ match_key        │   │
│  └──────────────────────┘    │ merges               │    │ action           │   │
│            ▲                 └──────────────────────┘    └──────────────────┘   │
│            │                                                                    │
│  ┌─────────┴────────────────┐    ┌──────────────────────────────────────────┐  │
│  │  overlap_strategy_runs   │    │            overlap_clusters              │  │
│  │──────────────────────────│    │──────────────────────────────────────────│  │
│  │ id (PK)                  │    │ id (PK)                                  │  │
│  │ project_id (FK)          │    │ project_id (FK)                          │  │
│  │ strategy_id (FK)?        │    │ job_id (FK→dedup_jobs)?                  │  │
│  │ status                   │    │ scope (within_source|cross_source)       │  │
│  │ within/cross counts      │    │ match_tier · match_basis                 │  │
│  │ params_snapshot (JSONB)  │    │ similarity_score                         │  │
│  └──────────────────────────┘    │ origin (auto|manual|mixed)               │  │
│                                  │ locked                                   │  │
│                                  └───────────────────┬──────────────────────┘  │
│                                                      │                         │
│                                       ┌──────────────▼────────────────────┐   │
│                                       │     overlap_cluster_members        │   │
│                                       │────────────────────────────────────│   │
│                                       │ id (PK)                            │   │
│                                       │ cluster_id (FK→overlap_clusters)   │   │
│                                       │ record_source_id (FK→rec_sources)  │   │
│                                       │ source_id (FK→sources)             │   │
│                                       │ role (canonical|duplicate)         │   │
│                                       │ added_by (auto|user) · note        │   │
│                                       └────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                     SCREENING, EXTRACTION & CLAIMS                              │
│                                                                                 │
│  ┌──────────────────────────────────┐   ┌────────────────────────────────────┐ │
│  │       screening_decisions        │   │         extraction_records         │ │
│  │──────────────────────────────────│   │────────────────────────────────────│ │
│  │ id (PK)                          │   │ id (PK)                            │ │
│  │ project_id (FK)                  │   │ project_id (FK)                    │ │
│  │ record_id (FK→records)?          │   │ record_id (FK→records)?            │ │
│  │ cluster_id (FK→ov_clusters)?     │   │ cluster_id (FK→ov_clusters)?       │ │
│  │ stage (TA|FT)                    │   │ extracted_json (JSONB)             │ │
│  │ decision (include|exclude)       │   │ reviewer_id (FK→users)?            │ │
│  │ reason_code · notes              │   │ created_at                         │ │
│  │ reviewer_id (FK→users)?          │   └────────────────────────────────────┘ │
│  │ created_at                       │                                          │
│  └──────────────────────────────────┘   ┌────────────────────────────────────┐ │
│                                         │        screening_claims            │ │
│  ┌──────────────────────────────────┐   │────────────────────────────────────│ │
│  │        screening_queues          │   │ id (PK)                            │ │
│  │──────────────────────────────────│   │ project_id (FK)                    │ │
│  │ id (PK)                          │   │ record_id (FK)?                    │ │
│  │ project_id (FK)                  │   │ cluster_id (FK)?                   │ │
│  │ reviewer_id (FK→users)           │   │ reviewer_id (FK→users)?            │ │
│  │ source_id (text: uuid or "all")  │   │ claimed_at (30-min TTL)            │ │
│  │ stage · seed                     │   └────────────────────────────────────┘ │
│  │ slots (JSONB) · position         │                                          │
│  └──────────────────────────────────┘                                          │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                     ANNOTATIONS, LABELS & PDF                                   │
│                                                                                 │
│  ┌──────────────────────────┐   ┌─────────────────────┐   ┌────────────────┐  │
│  │    record_annotations    │   │   project_labels    │   │ fulltext_pdfs  │  │
│  │──────────────────────────│   │─────────────────────│   │────────────────│  │
│  │ id (PK)                  │   │ id (PK)             │   │ id (PK)        │  │
│  │ project_id (FK)          │   │ project_id (FK)     │◄──│ project_id(FK) │  │
│  │ record_id (FK)?          │   │ name · color        │   │ record_id(FK)? │  │
│  │ cluster_id (FK)?         │   └──────────┬──────────┘   │cluster_id(FK)? │  │
│  │ selected_text · comment  │              │              │ original_fname │  │
│  │ reviewer_id (FK)?        │   ┌──────────▼──────────┐   │ storage_path   │  │
│  │ page_num                 │   │    record_labels     │   │ file_size      │  │
│  │ highlight_rects (JSONB)  │   │─────────────────────│   │ uploaded_by FK?│  │
│  │ created_at               │   │ id (PK)             │   └───────┬────────┘  │
│  └──────────────────────────┘   │ project_id (FK)     │           │           │
│                                 │ record_id (FK)?     │   ┌───────▼────────┐  │
│                                 │ cluster_id (FK)?    │   │pdf_drawing_ann │  │
│                                 │ label_id (FK)       │   │────────────────│  │
│                                 │ reviewer_id (FK)?   │   │ id (PK)        │  │
│                                 └─────────────────────┘   │fulltext_pdf_id │  │
│                                                           │ reviewer_id FK?│  │
│                                                           │drawing_data    │  │
│                                                           │ updated_at     │  │
│                                                           │UNIQUE(pdf,rev) │  │
│                                                           └────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                  ONTOLOGY, CONCEPTS & THEMATIC ANALYSIS                         │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │                          ontology_nodes                                  │  │
│  │──────────────────────────────────────────────────────────────────────────│  │
│  │ id (PK)  │  project_id (FK)  │  parent_id (FK→self)?  │  name           │  │
│  │ namespace (level|dimension|concept|population|intervention|outcome|other) │  │
│  │ description · color · position (JSONB) · created_at · updated_at         │  │
│  └──────┬──────────────────────────────────────────────┬─────────────────── ┘  │
│         │                                              │                        │
│  ┌──────▼───────────────────┐        ┌────────────────▼───────────────────┐   │
│  │      ontology_edges      │        │          record_concepts            │   │
│  │──────────────────────────│        │────────────────────────────────────│   │
│  │ id (PK)                  │        │ id (PK)  │  project_id (FK)        │   │
│  │ project_id (FK)          │        │ record_id (FK→records)?            │   │
│  │ source_id (FK→on_nodes)  │        │ cluster_id (FK→ov_clusters)?       │   │
│  │ target_id (FK→on_nodes)  │        │ node_id (FK→ontology_nodes)        │   │
│  │ label · color            │        │ assigned_by (FK→users)?            │   │
│  └──────────────────────────┘        └────────────────────────────────────┘   │
│                                                                                │
│  ┌─────────────────────────────────┐  ┌────────────────────────────────────┐  │
│  │    concept_taxonomy_nodes       │  │        concept_extractions         │  │
│  │─────────────────────────────────│  │────────────────────────────────────│  │
│  │ id (PK)  │  project_id (FK)     │  │ id (PK)  │  project_id (FK)       │  │
│  │ name (value string)             │  │ record_id (FK)?                    │  │
│  │ field_id  │  field_type         │  │ cluster_id (FK)?                   │  │
│  │ parent_id (FK→self)?            │  │ extracted_json (JSONB)             │  │
│  │ aliases (JSONB)?                │  │ reviewer_id (FK→users)?            │  │
│  │ description?                    │  │ created_at · updated_at            │  │
│  └─────────────────────────────────┘  └────────────────────────────────────┘  │
│                                                                                │
│  ┌─────────────────────────────────┐  ┌────────────────────────────────────┐  │
│  │       code_extractions          │  │       thematic_history             │  │
│  │─────────────────────────────────│  │────────────────────────────────────│  │
│  │ id (PK)                         │  │ id (PK)                            │  │
│  │ project_id (FK)                 │  │ project_id (FK)                    │  │
│  │ code_id (varchar theme ref)     │  │ code_id (snapshot)?                │  │
│  │ extraction_id (FK→extr_records) │  │ code_name (snapshot)               │  │
│  │ snippet_text · note             │  │ action · old/new theme id/name     │  │
│  │ assigned_by (FK→users)?         │  │ changed_by (FK→users)?             │  │
│  └─────────────────────────────────┘  └────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                          LLM SCREENING                                          │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │                       llm_screening_runs                                 │  │
│  │──────────────────────────────────────────────────────────────────────────│  │
│  │ id (PK)  │  project_id (FK)  │  triggered_by (FK→users)?                │  │
│  │ source_id (FK→sources)?  │  model  │  status  │  mode                   │  │
│  │ total/processed/included/excluded/uncertain counts                        │  │
│  │ input_tokens · output_tokens · estimated/actual_cost_usd                 │  │
│  │ agent_mode (single|multi-agent)  │  agent_pipeline (JSONB)               │  │
│  │ saturation_threshold · stopped_at_saturation                             │  │
│  │ started_at · completed_at · created_at                                   │  │
│  └──────────────────────────────┬───────────────────────────────────────────┘  │
│                                 │                                               │
│                    ┌────────────▼──────────────────────────────────────────┐   │
│                    │              llm_screening_results                     │   │
│                    │──────────────────────────────────────────────────────  │   │
│                    │ id (PK)  │  run_id (FK)  │  project_id (FK)           │   │
│                    │ record_id (FK→records)?  │  cluster_id (FK)?          │   │
│                    │ ta_decision · ta_reason  │  ft_decision · ft_reason   │   │
│                    │ matched_codes (JSONB)  │  new_concepts (JSONB)        │   │
│                    │ extracted_json (JSONB) │  agent_outputs (JSONB)       │   │
│                    │ reviewed_by (FK→users)?  │  review_action             │   │
│                    │ input_tokens · output_tokens · model                  │   │
│                    └────────────────────────────────────────────────────── ┘   │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                         CITATION SOURCING                                       │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │                        citation_searches                                 │  │
│  │──────────────────────────────────────────────────────────────────────────│  │
│  │ id (PK)  │  project_id (FK)  │  triggered_by (FK→users)?                │  │
│  │ status (pending|running|completed|failed)                                 │  │
│  │ direction (backward|forward|both)                                         │  │
│  │ scope (all|new|custom|manual)                                             │  │
│  │ source_record_count  │  source_record_ids (JSONB)                        │  │
│  │ candidate_count  │  already_in_project_count                             │  │
│  │ error_msg  │  created_at  │  completed_at                                │  │
│  └──────────────────────────────┬───────────────────────────────────────────┘  │
│                                 │                                               │
│                    ┌────────────▼──────────────────────────────────────────┐   │
│                    │              citation_candidates                        │   │
│                    │──────────────────────────────────────────────────────  │   │
│                    │ id (PK)  │  search_id (FK)  │  project_id (FK)        │   │
│                    │ direction (backward|forward)                           │   │
│                    │ source_record_id (FK→records)?  ← which paper led here│   │
│                    │ s2_paper_id  │  title  │  abstract  │  authors        │   │
│                    │ year  │  doi  │  pmid  │  journal                     │   │
│                    │ in_project  │  project_record_id (FK→records)?        │   │
│                    │ decision (include|null)                                │   │
│                    │ decided_by (FK→users)?  │  decided_at  │  notes       │   │
│                    │ import_job_id (FK→import_jobs)?                       │   │
│                    │ created_at                                             │   │
│                    │                                                        │   │
│                    │ UNIQUE: (search_id, direction, doi) WHERE doi ≠ NULL  │   │
│                    │ UNIQUE: (search_id, direction, pmid) WHERE pmid ≠ NULL│   │
│                    │ UNIQUE: (search_id, direction, s2_paper_id) WHERE ≠ ∅ │   │
│                    └────────────────────────────────────────────────────── ┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Key Structural Patterns

**Record vs. Cluster polymorphism** — Twelve tables (`screening_decisions`, `extraction_records`, `concept_extractions`, `screening_claims`, `record_annotations`, `record_labels`, `record_concepts`, `fulltext_pdfs`, `llm_screening_results`, `consensus_decisions`, `citation_candidates`, `overlap_cluster_members`) link to *either* a single `records` row (standalone paper) *or* an `overlap_clusters` row (clustered group), enforced via a CHECK constraint and partial unique indexes on each nullable FK column.

**Per-reviewer drawing isolation** — `pdf_drawing_annotations` gives each reviewer their own freehand stroke layer on the shared PDF file. Saving strokes UPSERTs on the `UNIQUE (fulltext_pdf_id, reviewer_id)` index so no two reviewers overwrite each other.

**JSONB for flexible schemas** — Extraction data, LLM outputs, overlap configs, strategy snapshots, concept templates, PDF drawing strokes, and citation search inputs are stored as typed JSONB rather than additional tables, avoiding schema churn while retaining queryability.

**Partial unique indexes** — Used throughout to enforce business rules that depend on NULL values: e.g., a reviewer can have at most one TA decision per record (`UNIQUE WHERE record_id IS NOT NULL`), and each citation candidate is direction-scoped (`UNIQUE (search_id, direction, doi) WHERE doi IS NOT NULL`).

**Sub-project tree** — `projects.parent_project_id` self-references for nested projects. `projects.shared_with_team` allows a sub-project's records to be visible to the parent project's team without re-inviting members.

**Advisory locking** — Import and deduplication mutations acquire a per-project PostgreSQL advisory lock (`pg_try_advisory_lock`) to serialize writes without blocking reads.

---

## Technical Specifications

| Component | Technology |
|---|---|
| Backend API | Python 3.9, FastAPI, SQLAlchemy (async) |
| Database | PostgreSQL with asyncpg driver |
| Frontend | React 18, TypeScript, Vite |
| State management | TanStack Query (React Query) |
| LLM integrations | Anthropic SDK, OpenAI SDK (OpenRouter-compatible) |
| Dedup algorithm | Union-Find with 3-tier blocking |
| Overlap algorithm | Union-Find with 5-tier blocking + RapidFuzz |
| PDF parsing | pdfplumber |
| Schema migrations | Alembic (44 versioned migrations) |
| Citation sourcing | Semantic Scholar Graph API (httpx async; 1–100 RPS) |
| Test suite | pytest + pytest-asyncio; 485+ backend tests, 23 Vitest frontend tests |
| Auth | JWT-based; project membership enforced on all endpoints |

### Key Architectural Guarantees

- **Advisory locking** — deduplication and import mutations are serialized per project to prevent data races
- **JSONB flexibility** — extraction schemas, overlap configs, and strategy snapshots stored as typed JSONB
- **Chunked SQL** — asyncpg's 32,767-parameter limit is respected via 500-record batch processing
- **Deterministic dedup** — same inputs always produce the same dedup clusters
- **LLM auditability** — model ID, prompt, response, and token counts logged per record per run
- **Migration safety** — all schema changes are versioned; raw imported data is never mutated

---

## Design Principles

**Reproducibility above all.** Every output is traceable to documented inputs. Non-deterministic steps (LLM calls) are logged with all inputs, model version, and full output.

**AI assists — never decides.** LLM components propose; researchers decide. Every AI-assisted step has a human review point. Measurement validity and governance take precedence over model novelty.

**Simplicity over cleverness.** Modules are independently understandable without cross-cutting context. The right level of abstraction is the minimum required.

**Auditability as a first-class feature.** Sources, confidence levels, and provenance are always visible. The system never hides how it reached a conclusion.

---

## Current Status

EvidencePlatform is under active development as open-source research infrastructure, emerging from evidence synthesis methodology research at Johns Hopkins University. The core screening, deduplication, extraction, thematic analysis, ontology, team collaboration, LLM-assisted screening, and citation sourcing modules are fully implemented and covered by a comprehensive automated test suite (30 migrations, 32 tables, 485+ backend tests).

---

*EvidencePlatform — Built for the evidence synthesis community. Designed to outlast the research that created it.*
