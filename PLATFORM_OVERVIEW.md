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
Import and parse citation files from any major database. The parser engine handles **RIS**, **MEDLINE/PubMed**, **BibTeX**, and similar formats with automatic encoding detection (UTF-8, Latin-1) and zero-space tag normalization. Duplicate author-formatting variants and malformed DOIs are corrected at ingestion.

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
| OpenAI via OpenRouter | GPT-4o, GPT-4.1, GPT-5.4 Pro |
| Google via OpenRouter | Gemini 2.0 Flash, Gemini 2.5 Pro, Gemini 3.x Preview |
| Meta via OpenRouter | Llama 4 Scout (10M context), Llama 4 Maverick |
| DeepSeek via OpenRouter | DeepSeek V3, V3.2, R1 (reasoning) |
| Mistral via OpenRouter | Mistral Large 2512, Ministral 8B |
| Alibaba via OpenRouter | Qwen 3.5 Plus, Qwen 3 Max (Thinking) |
| NVIDIA via OpenRouter | Nemotron 3 Super (free tier) |
| Cohere via OpenRouter | Command A (open weights, 256k context) |

Each run produces per-record decisions (include / exclude / uncertain) with rationale, matched thematic codes, and newly suggested concepts. Results feed directly into the screening pipeline or can be reviewed and merged independently. Cost and time estimates are shown before launch; all LLM inputs and outputs are logged with model version for audit.

### 6. Team Collaboration & Consensus
Multi-reviewer workflows with:
- **Project membership** — invite-by-token system with role-based access (owner / member)
- **Dual-reviewer isolation** — each reviewer's decisions are stored independently with partial unique indexes
- **Conflict detection** — automatic identification of disagreeing TA or FT decisions across reviewers
- **Adjudication** — owners can adjudicate conflicts and record final consensus decisions
- **Inter-rater reliability** — Cohen's kappa computed per project, per stage, and per reviewer pair
- **Team screening stats** — agreement rates, decision distributions, and coverage per reviewer

### 7. Structured Data Extraction
Reviewers extract structured evidence from included full-text records using a flexible JSONB schema. The **Extraction Library** shows only papers that were included at both the title-abstract and full-text screening stages and have been extracted — papers that merely passed one stage or have no extraction are excluded. The library provides:
- Inline edit panel — edit any field without leaving the list
- Search and filter — by source, label, or free text
- Full metadata enrichment — title, authors, year, DOI, source names per item

### 8. Citation Sourcing (Snowballing)
After data extraction, researchers can discover additional eligible papers through automated citation snowballing — a standard systematic review methodology. For each paper in the Extraction Library (TA+FT included AND extracted), the platform resolves its Semantic Scholar ID and fetches the complete reference list (backward sourcing) and all papers that cite it (forward sourcing). Results are cross-deduplicated across all source papers, checked against records already in the project, and presented for researcher review.

- **Backward sourcing** — fetches the full reference lists of extracted papers; each reference is a candidate
- **Forward sourcing** — fetches papers that cite each extracted paper via the Semantic Scholar API
- **Extraction Library cohort** — sourcing always starts from the validated set: TA=include, FT=include, AND extracted; candidates are never based on partially-screened papers
- **Cohort scoping** — three modes: *All* (every paper in the Extraction Library), *New* (papers not yet used as source in any prior completed search), or *Custom* (researcher selects specific papers via a checklist); supports iterative snowballing across multiple rounds
- **Cross-paper deduplication** — the same paper referenced by multiple included studies produces a single candidate row (partial-unique indexes on DOI, PMID, and Semantic Scholar paper ID)
- **Project membership check** — candidates already present in the project are automatically flagged
- **Checkbox selection** — select individual papers or use Select All to mark the full page; no include/exclude decisions required
- **Named per-article sources** — each import batch is grouped by the source article that led to the discovery and given a descriptive Source name (e.g. *← Refs: Smith 2020* or *→ Citing: Jones 2021*); this name appears in the Extraction Library's Sources column so the provenance chain is always visible
- **Delete candidates** — remove individual candidates or entire search runs to keep the workspace clean
- **Filter by source article** — view only candidates discovered from a specific extracted paper
- **Search history** — every run is logged with timestamp, direction, scope, source paper count, candidate count, and already-in-project count
- **Semantic Scholar integration** — uses the free Semantic Scholar Graph API (1 RPS without key; 100 RPS with a free API key set via `SEMANTIC_SCHOLAR_API_KEY`)
- **Background execution** — the fetch runs asynchronously; the UI polls every 3 seconds and shows a live status badge

### 9. Thematic Analysis (Taxonomy)
A code-based thematic synthesis module for building and managing an evolving **taxonomy of themes**. Concepts extracted from papers are gathered and organized into themes and sub-codes — answering the question *what patterns emerge across the literature?*:
- Create and organize themes and sub-codes
- Assign codes to extracted evidence segments
- View all evidence assigned to a given code
- Track codebook history — every change is logged with timestamp and author
- Saturation tracking — consecutive records without new code assignments surfaced as a progress indicator

### 10. Label System
Project-scoped **personal tags** with custom names and colors. Labels are entirely user-defined and carry no predefined structure — researchers use them to organize and retrieve papers however suits their workflow (sub-populations, study designs, methodological flags, reading status, etc.). Labels can be:
- Assigned to any article at any screening stage
- Created inline during screening (new labels are saved immediately to the project)
- Browsed on the dedicated **Labels page** — per-label article counts, filtered article lists, and progress stats

Labels are independent of taxonomy and ontology: they are not required to be linked to themes or structured dimensions.

### 11. Ontology
A **hierarchical concept graph** for organizing the structural dimensions of an evidence base — levels of analysis, intervention types, outcome categories, populations, and other domain-specific dimensions. Unlike labels (personal/flexible) and thematic codes (bottom-up from evidence), the ontology is **partially pre-defined** and provides shared vocabulary across a project.

- Hierarchical node tree with arbitrary depth (forest structure)
- Node namespaces: `level`, `dimension`, `concept`, `population`, `intervention`, `outcome`, `other`
- Drag-and-drop reparenting with cycle detection
- Sync levels from project criteria
- Export / import full ontology as JSON
- **Concept tagging during screening** — tag papers with ontology concepts inline; new concepts created during screening are saved to the project ontology for future use
- 3D graph view for exploring large taxonomies
- Color-coding per node or namespace

Researchers are not required to use all three organization systems (labels, taxonomy, ontology) in a single study — each is independently optional.

---

## Citation Sourcing Loop

Citation sourcing closes the feedback loop between extraction and import: papers discovered through snowballing re-enter the import pipeline and are subject to the same deduplication, overlap detection, and screening workflow as records imported from databases. This ensures a single, auditable provenance chain for every record in the project regardless of how it was discovered.

### 12. PDF Viewer and Annotation
Full-text PDFs are uploaded per record or per cluster and stored server-side (one per record/cluster). A floating, draggable PDF viewer opens inline during the FT screening stage and provides:

- **Page navigation** — previous/next page with current-page indicator
- **Freehand drawing** — pen tool with configurable color and stroke width; strokes are saved to the database and persist across sessions
- **Eraser tool** — remove individual drawn strokes; clear-page button wipes all drawings on the current page
- **Text selection and anchored notes** — select any text passage in select mode; a popup appears to add a note; the selection is stored as a normalised highlight (fractional `{x,y,w,h}` coordinates) and rendered as a persistent yellow overlay on the PDF; clicking a highlight opens the associated note in the notes drawer; clicking a note jumps to its page
- **Notes drawer** — collapsible panel at the bottom of the viewer listing all annotations for the document with page badges, quoted text previews, and delete controls
- **Drag to reposition / drag left edge to resize** — the panel floats at a configurable position within the viewport
- **Download** — direct download of the uploaded PDF from the viewer header

---

## Three Orthogonal Organization Systems

EvidencePlatform provides three distinct, independently optional systems for organizing literature. They serve different purposes and can be used together or separately:

| System | Purpose | Structure | Defined by |
|---|---|---|---|
| **Labels** | Personal retrieval tags | Flat list, no hierarchy | Entirely user-defined; created freely |
| **Taxonomy** (Thematic Analysis) | Bottom-up concept synthesis | Themes → sub-codes | Researcher builds from evidence |
| **Ontology** | Structural dimensions of the field | Hierarchical tree (forest) | Partially pre-defined + extensible |

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
| Schema migrations | Alembic (29 versioned migrations) |
| Citation sourcing | Semantic Scholar Graph API (httpx async client; 1–100 RPS) |
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

## Workflow at a Glance

```
Import literature (RIS / MEDLINE / BibTeX)
        ↓
Auto-deduplication within each source
        ↓
Cross-source overlap detection + visualization
        ↓
Title-abstract screening (manual or LLM-assisted)
  → tag with labels and ontology concepts inline
        ↓
Full-text screening
  → tag with labels and ontology concepts inline
        ↓
Structured data extraction
  → tag with labels and ontology concepts inline
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

## Design Principles

**Reproducibility above all.** Every output is traceable to documented inputs. Non-deterministic steps (LLM calls) are logged with all inputs, model version, and full output.

**AI assists — never decides.** LLM components propose; researchers decide. Every AI-assisted step has a human review point. Measurement validity and governance take precedence over model novelty.

**Simplicity over cleverness.** Modules are independently understandable without cross-cutting context. The right level of abstraction is the minimum required.

**Auditability as a first-class feature.** Sources, confidence levels, and provenance are always visible. The system never hides how it reached a conclusion.

---

## Current Status

EvidencePlatform is under active development as open-source research infrastructure, emerging from evidence synthesis methodology research at Johns Hopkins University. The core screening, deduplication, extraction, thematic analysis, ontology, and team collaboration modules are fully implemented and covered by a comprehensive automated test suite.

---

*EvidencePlatform — Built for the evidence synthesis community. Designed to outlast the research that created it.*
