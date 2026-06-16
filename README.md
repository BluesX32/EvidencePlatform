# EvidencePlatform

Open-source infrastructure for systematic, reproducible evidence synthesis. Import literature from multiple databases, resolve duplicates, screen articles, extract structured evidence, and organize findings — with full auditability at every step.

---

## What it does

| Step | What happens |
|------|-------------|
| **Import** | Upload RIS, MEDLINE, or BibTeX files from PubMed, Embase, Cochrane, and other databases; each file is tagged to a named source; sources and individual records can be permanently deleted by project admins |
| **Deduplication** | Automatically merges duplicate records within each source using a 3-tier Union-Find engine (exact DOI/PMID → title+year+author → fuzzy) |
| **Overlap detection** | Identifies the same paper across multiple databases with a configurable 5-tier strategy; manual linking and cluster locking supported; visualised as Euler diagram, pairwise heatmap, and intersection summary |
| **Human screening** | Title/abstract → full-text pipeline with sequential or mixed mode; configurable inclusion/exclusion criteria; per-reason exclusion tracking; custom exclusion reasons; anchored annotations; back/forward navigation through session history; full-text link resolution (Unpaywall/DOI/PMC/PubMed/Scholar); per-source progress dashboard |
| **LLM-assisted screening** | AI screening runs using 15+ models across Anthropic, OpenAI, Google, Meta, DeepSeek, Mistral, and others; each record receives an include/exclude/uncertain decision with rationale; cost and time estimated before launch; all inputs and outputs logged with model version |
| **Team collaboration** | Invite reviewers by token; dual-reviewer isolation with independent decision storage; automatic conflict detection; adjudication by project owner; Cohen's kappa computed per stage and reviewer pair; team screening statistics |
| **Extraction** | Template-driven structured evidence capture with inline editing; Extraction Library (shows only TA+FT included papers that have been extracted) with search, filter, and edit; saturation counter tracks diminishing returns on new concepts |
| **Citation sourcing** | After extraction, automatically fetch reference lists (backward) and citing papers (forward) for every paper in your Extraction Library via the Semantic Scholar API; manual file import (RIS/MEDLINE) for databases not covered by Semantic Scholar; robust resolution via DOI, PMID, and title+year; 429 rate-limit retry; pagination via S2 `next` cursor |
| **Thematic analysis** | Codebook-driven synthesis — create themes and codes, assign evidence excerpts, review coded passages, track codebook history |
| **Labels & Ontology** | Colour-coded personal labels for retrieval; hierarchical concept ontology with 3D graph view, drag-and-drop reparenting, and tagging during screening |
| **PDF viewer** | Attach full-text PDFs per record or cluster; floating panel with per-reviewer freehand drawing, text selection, and anchored annotation notes |
| **Concept extraction** | Project owners define a concept template (entity / relation / metadata fields); reviewers fill it out per article; aggregated in the Concept Taxonomy view with bulk push to the project ontology |
| **Sub-projects** | Nest a child project inside a parent; optionally share it with the parent's team; random sampling of records for pilot reviews |

---

## Quick start (Docker — recommended)

Docker is the fastest way to run every service with a single command.

### 1. Install Docker Desktop

Download and install **Docker Desktop** for your operating system:

- **macOS** → https://www.docker.com/products/docker-desktop  
  After installing, open Docker Desktop and wait for the whale icon in the menu bar to stop animating (engine is ready).

- **Windows** → same link above. WSL 2 backend is recommended; Docker Desktop will prompt you to enable it.

- **Linux** → install Docker Engine and the Compose plugin:
  ```bash
  # Ubuntu / Debian
  sudo apt-get update
  sudo apt-get install -y docker.io docker-compose-plugin
  sudo systemctl enable --now docker
  sudo usermod -aG docker $USER   # log out and back in after this
  ```

Verify the installation:

```bash
docker --version        # Docker version 24+
docker compose version  # Docker Compose version v2+
```

### 2. Clone the repository

```bash
git clone https://github.com/BluesX32/EvidencePlatform.git
cd EvidencePlatform
```

### 3. Configure environment (optional)

The defaults work out of the box for local development. To change the JWT secret key (recommended for any shared or production use):

```bash
# macOS / Linux
export SECRET_KEY="your-secret-key-here"

# Windows PowerShell
$env:SECRET_KEY = "your-secret-key-here"
```

### 4. Start all services

Make sure you are inside the `EvidencePlatform` directory (the one containing `docker-compose.yml`) before running this command:

```bash
docker compose up -d --build
```

This builds and starts three containers:

| Container | Purpose | Port |
|-----------|---------|------|
| `db` | PostgreSQL 16 database | `5433` (host) |
| `backend` | FastAPI API server (auto-migrates on start — runs all 44 migrations) | `8000` |
| `frontend` | Vite dev server (React) | `5173` |

Wait about 30 seconds on the first run for images to build. Then open:

```
http://localhost:5173
```

Register an account and the onboarding tour will guide you through the rest.

### Useful commands

```bash
# View live backend logs
make logs
# or: docker compose logs -f backend

# Stop all services (data is preserved)
make down

# Wipe all data and start fresh
make reset

# Run migrations manually (rarely needed — happens automatically on start)
make migrate
```

---

## Manual setup (without Docker)

Use this approach if you want to run services natively for development.

### Prerequisites

| Tool | Minimum version | Install |
|------|----------------|---------|
| Python | 3.9+ | https://python.org |
| Node.js | 18+ | https://nodejs.org |
| PostgreSQL | 14+ | https://www.postgresql.org/download |

### 1. Database

Create a PostgreSQL database and user:

```sql
CREATE USER evidence WITH PASSWORD 'evidence';
CREATE DATABASE evidenceplatform OWNER evidence;
```

### 2. Backend

```bash
cd backend

# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

Create a `.env` file in `backend/`:

```env
DATABASE_URL=postgresql+asyncpg://evidence:evidence@localhost:5432/evidenceplatform
SECRET_KEY=local-dev-secret-key-change-in-production
ACCESS_TOKEN_EXPIRE_HOURS=24
BACKEND_CORS_ORIGINS=http://localhost:5173

# Optional: Semantic Scholar API key for citation sourcing (raises rate limit from 1 to 100 RPS)
# Request a free key at https://www.semanticscholar.org/product/api
SEMANTIC_SCHOLAR_API_KEY=

# Optional: OpenRouter API key for non-Anthropic LLM screening models
OPENROUTER_API_KEY=

# Optional: Anthropic API key for LLM-assisted screening
ANTHROPIC_API_KEY=
```

```bash
# Run database migrations
alembic -c alembic.ini upgrade head

# Start the API server
uvicorn app.main:app --reload --port 8000
```

API is now available at `http://localhost:8000`.  
Interactive docs: `http://localhost:8000/docs`.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend is now available at `http://localhost:5173`.

---

## Running tests

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/ -v --tb=short
```

The test suite covers parsers, deduplication, overlap detection, screening workflow, extraction logic, thematic analysis, team collaboration, citation sourcing, and strategy history (485+ backend tests + 23 Vitest frontend tests). Run a specific module with `-k <name>`, e.g. `pytest tests/ -k screening`.

> **Admin-only operations** — deleting individual records (`DELETE /projects/{id}/records/{record_id}`) and deleting entire sources (`DELETE /projects/{id}/sources/{source_id}`) require admin/owner role. Source deletion removes all records that belong exclusively to that source; records shared with other sources are preserved.

---

## PDF Viewer and Annotation

Every article in the full-text screening and data extraction stages has a built-in PDF workspace. Click **View PDF** to open a floating panel that:

- Renders the PDF page-by-page using PDF.js (no browser plugin required)
- Lets you draw freehand annotations with a **Pen** tool (choose colour and stroke width) and erase them with the **Eraser** tool
- Saves drawings **per reviewer** — each team member's strokes are isolated in `pdf_drawing_annotations`; no one's drawings overwrite another's
- Provides a **Notes drawer** at the bottom where you can write and save text notes anchored to a specific passage and page number

The panel is **draggable** (drag the header to move it) and **resizable** (drag the left edge). The underlying PDF file is shared across all team members, but each reviewer's drawing layer and text notes are stored independently.

---

## Browser Extension (PDF Capture)

Many publisher sites use institutional SSO authentication. The browser extension lets you capture PDFs from those sites and send them directly to EvidencePlatform — without ever leaving your browser or needing to download and re-upload files manually.

### How it works

1. Navigate to an article's **full-text** screening or extraction stage in EvidencePlatform.
2. Click **Find PDF → ⬇ Capture** to start a capture session.
3. The extension watches for any PDF download that occurs in the next few minutes.
4. Complete authentication on the publisher site (institutional SSO, paywall, etc.) and click the PDF download link as normal.
5. The extension intercepts the download, validates it is a real PDF (magic-byte check), re-fetches it using your browser's authenticated cookies, and uploads it to the platform automatically.
6. The PDF appears instantly in the article's viewer panel — no manual file selection needed.

### Installing the extension (Chrome / Edge — unpacked)

The extension is a local Chrome MV3 extension that you load manually (it is not published to the Chrome Web Store).

**Step 1 — Open the Extensions page**

In Chrome or Edge, navigate to `chrome://extensions` or `edge://extensions`.

**Step 2 — Enable Developer mode**

Toggle **Developer mode** on (top-right corner of the Extensions page).

**Step 3 — Load the extension**

Click **Load unpacked**, then select the `browser-extension/` folder inside this repository.

**Step 4 — Configure the backend URL** *(only needed once)*

Click the extension icon in the toolbar and set the **Backend URL** to `http://localhost:8000` (or your server address). Click **Save**.

**Step 5 — Pin the extension** *(optional)*

Click the puzzle-piece icon → pin **EvidencePlatform PDF Capture** so it is always visible.

---

## Project structure

```
EvidencePlatform/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app + router registration
│   │   ├── database.py          # Async SQLAlchemy engine + session
│   │   ├── dependencies.py      # Auth deps + role constants
│   │   ├── models/              # SQLAlchemy ORM models (39 tables)
│   │   ├── routers/             # API endpoints (one file per domain)
│   │   │   ├── auth.py          # POST /register, POST /token, GET /me
│   │   │   ├── projects.py      # CRUD + criteria + sub-projects
│   │   │   ├── sources.py       # Source management
│   │   │   ├── imports.py       # File upload + parse + ingest
│   │   │   ├── records.py       # Record list, detail, delete
│   │   │   ├── strategies.py    # Match strategy CRUD
│   │   │   ├── dedup_jobs.py    # Run/status dedup jobs
│   │   │   ├── overlaps.py      # Overlap detection, clusters, Euler
│   │   │   ├── screening.py     # TA/FT decisions, extractions, claims
│   │   │   ├── extractions.py   # Extraction library
│   │   │   ├── annotations.py   # Anchored text annotations
│   │   │   ├── labels.py        # Project labels + assignments
│   │   │   ├── ontology.py      # Ontology nodes + edges
│   │   │   ├── thematic.py      # Themes, codes, evidence assignments
│   │   │   ├── concept_extraction.py  # Per-reviewer concept forms
│   │   │   ├── concept_taxonomy.py    # Aggregated taxonomy view
│   │   │   ├── fulltext.py      # PDF upload/download/drawing
│   │   │   ├── llm_screening.py # LLM run management + results
│   │   │   ├── citations.py     # Snowballing via Semantic Scholar
│   │   │   ├── teams.py         # Members, invitations, permissions
│   │   │   └── consensus.py     # Conflict detection + adjudication
│   │   ├── services/            # Business logic
│   │   ├── repositories/        # Database queries
│   │   ├── parsers/             # RIS / MEDLINE / BibTeX parsers
│   │   └── utils/               # Dedup, overlap detection, matching
│   ├── migrations/
│   │   └── versions/            # 44 versioned Alembic migrations
│   └── tests/                   # pytest test suite (485+ tests)
├── frontend/
│   ├── src/
│   │   ├── pages/               # 22 route-level page components
│   │   ├── components/          # 19 reusable UI components
│   │   ├── api/                 # Axios client + TanStack Query hooks
│   │   └── utils/               # Pure helpers (Euler layout, etc.)
│   └── index.html
├── browser-extension/           # Chrome MV3 extension for PDF capture
│   ├── manifest.json
│   ├── background.js            # Service worker — intercepts & uploads PDFs
│   ├── content.js               # Content script — bridges page ↔ background
│   ├── popup.html
│   └── popup.js
├── docker-compose.yml
├── Makefile                     # make up / down / reset / migrate / logs
└── CLAUDE.md                    # Development guidelines
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.9+, FastAPI, SQLAlchemy (async), Alembic |
| Frontend | TypeScript, React, Vite, TanStack Query |
| Database | PostgreSQL 14+ |
| Auth | JWT (python-jose + passlib/bcrypt) |
| Parsing | rispy (RIS), custom MEDLINE/BibTeX parsers |
| Matching | rapidfuzz (fuzzy title deduplication) |
| PDF rendering | PDF.js (pdfjs-dist) |
| AI/LLM | Anthropic SDK + OpenRouter (15+ models) |
| Citation sourcing | Semantic Scholar API |

---

## Database Schema

The platform uses PostgreSQL with **39 tables** across **44 versioned Alembic migrations**. Tables are organized into nine domains below. All tables have a UUID primary key named `id` unless noted otherwise.

> **Key notation:** `PK` = primary key · `FK` = foreign key · `?` = nullable · `→` = references · `UNIQUE` = unique constraint · `CHECK` = check constraint

---

### Domain 1 — Users & Access Control

#### `users`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `email` | VARCHAR | UNIQUE NOT NULL |
| `password_hash` | TEXT | bcrypt |
| `name` | VARCHAR | derived from email on register |
| `is_admin` | BOOLEAN | default false; admin portal access |
| `invite_code_id` | UUID? | FK → invite_codes (nullable) |
| `api_keys` | JSONB? | stored API keys (Anthropic, OpenRouter) |
| `created_at` | TIMESTAMPTZ | |

#### `invite_codes`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `code` | VARCHAR | UNIQUE |
| `label` | VARCHAR? | human-readable description |
| `max_uses` | INTEGER? | null = unlimited |
| `used_count` | INTEGER | default 0 |
| `expires_at` | TIMESTAMPTZ? | |
| `is_active` | BOOLEAN | default true |
| `created_by_user_id` | UUID? | FK → users |

---

### Domain 2 — Projects & Team

#### `projects`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `name` | VARCHAR | NOT NULL |
| `description` | TEXT? | |
| `created_by` | UUID | FK → users |
| `criteria` | JSONB? | inclusion/exclusion criteria |
| `extraction_template` | JSONB? | field schema for structured extraction |
| `concept_template` | JSONB? | entity/relation/metadata concept fields |
| `llm_config` | JSONB? | per-project LLM settings |
| `parent_project_id` | UUID? | FK → projects (self-ref, for sub-projects) |
| `shared_with_team` | BOOLEAN | default false; sub-project team access |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

#### `project_members`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `user_id` | UUID | FK → users CASCADE |
| `role` | VARCHAR | `reviewer` \| `admin` |
| `invited_by` | UUID? | FK → users |
| `status` | VARCHAR | `active` \| `invited` |
| `permissions` | JSONB? | `{"allowed_sections": [...], "record_ids": [...]}` — null = full access |
| `created_at` | TIMESTAMPTZ | |
| UNIQUE | | `(project_id, user_id)` |

#### `project_invitations`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `invited_by` | UUID | FK → users |
| `email` | VARCHAR | |
| `role` | VARCHAR | |
| `token` | VARCHAR | UNIQUE; sent in invite URL |
| `status` | VARCHAR | `pending` \| `accepted` \| `cancelled` |
| `created_at` | TIMESTAMPTZ | |
| `accepted_at` | TIMESTAMPTZ? | |

#### `project_samples`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `parent_project_id` | UUID | FK → projects |
| `child_project_id` | UUID | FK → projects |
| `seed` | INTEGER | random seed used for sampling |
| `n_per_corpus` | INTEGER | records drawn per source |
| `created_by` | UUID | FK → users |
| `sampled_record_ids` | JSONB | array of sampled record UUIDs |
| `created_at` | TIMESTAMPTZ | |

#### `consensus_decisions`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `record_id` | UUID? | FK → records (nullable) |
| `cluster_id` | UUID? | FK → overlap_clusters (nullable) |
| `stage` | VARCHAR | `TA` \| `FT` |
| `decision` | VARCHAR | `include` \| `exclude` |
| `reason_code` | VARCHAR? | |
| `notes` | TEXT? | |
| `adjudicator_id` | UUID? | FK → users |
| `created_at` | TIMESTAMPTZ | |
| CHECK | | exactly one of `record_id` / `cluster_id` is non-null |

---

### Domain 3 — Import & Records

#### `sources`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `name` | VARCHAR | NOT NULL |
| `created_at` | TIMESTAMPTZ | |

#### `import_jobs`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `created_by` | UUID | FK → users |
| `source_id` | UUID? | FK → sources |
| `filename` | VARCHAR | |
| `file_format` | VARCHAR | `ris` \| `medline` \| `bibtex` |
| `status` | VARCHAR | `pending` \| `running` \| `done` \| `failed` |
| `record_count` | INTEGER? | |
| `error_msg` | TEXT? | |
| `created_at` | TIMESTAMPTZ | |
| `completed_at` | TIMESTAMPTZ? | |

#### `records`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `title` | TEXT? | |
| `abstract` | TEXT? | |
| `authors` | TEXT? | semicolon-separated |
| `year` | INTEGER? | |
| `journal` | TEXT? | |
| `volume` | VARCHAR? | |
| `issue` | VARCHAR? | |
| `pages` | VARCHAR? | |
| `doi` | VARCHAR? | raw as imported |
| `normalized_doi` | VARCHAR? | lowercased, prefix-stripped |
| `issn` | VARCHAR? | |
| `pmid` | VARCHAR? | |
| `keywords` | TEXT? | |
| `source_format` | VARCHAR? | |
| `match_key` | TEXT? | canonical dedup key |
| `match_basis` | VARCHAR? | tier used to deduplicate |
| `created_at` | TIMESTAMPTZ | |

#### `record_sources`
Junction between `records` and `sources`; also holds per-import normalised fields used for matching.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `record_id` | UUID | FK → records CASCADE |
| `source_id` | UUID | FK → sources CASCADE |
| `import_job_id` | UUID? | FK → import_jobs |
| `raw_data` | JSONB? | original parsed fields |
| `norm_title` | TEXT? | NFKD-normalised title |
| `norm_first_author` | VARCHAR? | |
| `match_year` | INTEGER? | |
| `match_doi` | VARCHAR? | |
| `created_at` | TIMESTAMPTZ | |

---

### Domain 4 — Deduplication

#### `match_strategies`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `name` | VARCHAR | |
| `preset` | VARCHAR? | |
| `config` | JSONB? | `StrategyConfig` flags |
| `selected_fields` | JSONB? | `OverlapConfig` dict for overlap runs |
| `is_active` | BOOLEAN | default true |
| `created_at` | TIMESTAMPTZ | |

#### `dedup_jobs`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `strategy_id` | UUID? | FK → match_strategies |
| `created_by` | UUID | FK → users |
| `status` | VARCHAR | `pending` \| `running` \| `done` \| `failed` |
| `records_before` | INTEGER? | |
| `records_after` | INTEGER? | |
| `merges` | INTEGER? | |
| `clusters_created` | INTEGER? | |
| `clusters_deleted` | INTEGER? | |
| `error_msg` | TEXT? | |
| `created_at` | TIMESTAMPTZ | |
| `completed_at` | TIMESTAMPTZ? | |

#### `match_log`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `dedup_job_id` | UUID | FK → dedup_jobs CASCADE |
| `record_src_id` | UUID? | FK → record_sources |
| `old_record_id` | UUID? | FK → records |
| `new_record_id` | UUID? | FK → records |
| `match_key` | TEXT? | |
| `match_basis` | VARCHAR? | |
| `action` | VARCHAR | `merge` \| `keep` \| `skip` |
| `created_at` | TIMESTAMPTZ | |

---

### Domain 5 — Overlap Detection

#### `overlap_clusters`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `job_id` | UUID? | FK → dedup_jobs |
| `scope` | VARCHAR | `within_source` \| `cross_source` |
| `match_tier` | INTEGER? | 1–5 (tier that created the cluster) |
| `match_basis` | VARCHAR? | |
| `match_reason` | TEXT? | |
| `reason_json` | JSONB? | structured match evidence |
| `similarity_score` | FLOAT? | |
| `origin` | VARCHAR | `auto` \| `manual` \| `mixed` |
| `locked` | BOOLEAN | default false; survives algorithmic reruns |
| `created_at` | TIMESTAMPTZ | |

#### `overlap_cluster_members`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `cluster_id` | UUID | FK → overlap_clusters CASCADE |
| `record_source_id` | UUID | FK → record_sources |
| `source_id` | UUID | FK → sources |
| `role` | VARCHAR | `canonical` \| `duplicate` |
| `added_by` | VARCHAR | `auto` \| `user` |
| `note` | TEXT? | |
| `created_at` | TIMESTAMPTZ | |

#### `overlap_strategy_runs`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `strategy_id` | UUID? | FK → match_strategies |
| `triggered_by` | UUID? | FK → users |
| `status` | VARCHAR | `running` \| `done` \| `failed` |
| `started_at` | TIMESTAMPTZ | |
| `finished_at` | TIMESTAMPTZ? | |
| `within_source_groups` | INTEGER? | |
| `within_source_records` | INTEGER? | |
| `cross_source_groups` | INTEGER? | |
| `cross_source_records` | INTEGER? | |
| `sources_count` | INTEGER? | |
| `params_snapshot` | JSONB? | config at time of run |
| `error_message` | TEXT? | |

---

### Domain 6 — Screening & Decisions

#### `screening_decisions`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `record_id` | UUID? | FK → records (nullable) |
| `cluster_id` | UUID? | FK → overlap_clusters (nullable) |
| `stage` | VARCHAR | `TA` \| `FT` |
| `decision` | VARCHAR | `include` \| `exclude` |
| `reason_code` | VARCHAR? | exclusion reason |
| `notes` | TEXT? | |
| `reviewer_id` | UUID? | FK → users |
| `created_at` | TIMESTAMPTZ | |
| CHECK | | exactly one of `record_id` / `cluster_id` is non-null |
| UNIQUE (partial) | | `(project_id, record_id, stage, reviewer_id)` where `record_id IS NOT NULL` |
| UNIQUE (partial) | | `(project_id, cluster_id, stage, reviewer_id)` where `cluster_id IS NOT NULL` |

#### `screening_claims`
Soft-locks that prevent two reviewers from being served the same item concurrently. TTL = 30 minutes.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `record_id` | UUID? | FK → records |
| `cluster_id` | UUID? | FK → overlap_clusters |
| `reviewer_id` | UUID? | FK → users |
| `claimed_at` | TIMESTAMPTZ | refreshed on `ON CONFLICT DO UPDATE` |

#### `screening_queues`
Per-reviewer ordered queue for random-seeded sampling of articles.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `reviewer_id` | UUID | FK → users CASCADE |
| `source_id` | TEXT | UUID string or `"all"` |
| `stage` | VARCHAR | `TA` \| `FT` \| `extract` |
| `seed` | INTEGER | random seed |
| `slots` | JSONB | ordered array of record/cluster IDs |
| `position` | INTEGER | current cursor into slots |
| `created_at` | TIMESTAMPTZ | |

#### `extraction_records`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `record_id` | UUID? | FK → records (nullable) |
| `cluster_id` | UUID? | FK → overlap_clusters (nullable) |
| `extracted_json` | JSONB? | structured extraction fields |
| `reviewer_id` | UUID? | FK → users |
| `created_at` | TIMESTAMPTZ | |
| CHECK | | exactly one of `record_id` / `cluster_id` is non-null |
| UNIQUE (partial) | | `(project_id, record_id, reviewer_id)` where `record_id IS NOT NULL` |
| UNIQUE (partial) | | `(project_id, cluster_id, reviewer_id)` where `cluster_id IS NOT NULL` |

#### `concept_extractions`
Per-reviewer concept template responses (entity / relation / metadata fields).

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `record_id` | UUID? | FK → records (nullable) |
| `cluster_id` | UUID? | FK → overlap_clusters (nullable) |
| `extracted_json` | JSONB? | concept template responses |
| `reviewer_id` | UUID? | FK → users |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |
| CHECK | | exactly one of `record_id` / `cluster_id` is non-null |

---

### Domain 7 — Annotations, Labels & PDFs

#### `record_annotations`
Anchored text comments — linked to a specific passage (selected text + page number + highlight rects) within a record or cluster. Each annotation is authored by a specific reviewer; the list endpoint returns all annotations for an article across all team members.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `record_id` | UUID? | FK → records (nullable) |
| `cluster_id` | UUID? | FK → overlap_clusters (nullable) |
| `selected_text` | TEXT | the quoted passage |
| `comment` | TEXT | reviewer's note |
| `page_num` | INTEGER? | PDF page number (1-indexed) |
| `highlight_rects` | JSONB? | `[{x, y, w, h}]` normalised 0–1 fractions |
| `reviewer_id` | UUID? | FK → users |
| `created_at` | TIMESTAMPTZ | |
| CHECK | | exactly one of `record_id` / `cluster_id` is non-null |

#### `project_labels`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `name` | VARCHAR | |
| `color` | VARCHAR | hex color string |
| `created_at` | TIMESTAMPTZ | |

#### `record_labels`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `record_id` | UUID? | FK → records (nullable) |
| `cluster_id` | UUID? | FK → overlap_clusters (nullable) |
| `label_id` | UUID | FK → project_labels CASCADE |
| `reviewer_id` | UUID? | FK → users |
| `created_at` | TIMESTAMPTZ | |

#### `fulltext_pdfs`
One PDF file per article (record or cluster), **shared across all team members**. Stored on the server filesystem under `uploads/<project_id>/`. Each team member may read and download the file; only the original uploader or a project admin/owner can replace or delete it.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `record_id` | UUID? | FK → records CASCADE (nullable) |
| `cluster_id` | UUID? | FK → overlap_clusters CASCADE (nullable) |
| `original_filename` | VARCHAR(500) | |
| `storage_path` | TEXT | server-side file path |
| `file_size` | INTEGER | bytes |
| `content_type` | VARCHAR | default `application/pdf` |
| `uploaded_by` | UUID? | FK → users SET NULL |
| `uploaded_at` | TIMESTAMPTZ | |
| CHECK | | exactly one of `record_id` / `cluster_id` is non-null |
| UNIQUE (partial) | | `(project_id, record_id)` where `record_id IS NOT NULL` |
| UNIQUE (partial) | | `(project_id, cluster_id)` where `cluster_id IS NOT NULL` |

#### `pdf_drawing_annotations`
Per-reviewer freehand stroke data. Each reviewer owns exactly one drawing layer per PDF; saving new strokes UPSERTs into this table rather than overwriting a shared row. Format: `{"1": [{"color": "#000", "width": 2, "points": [[x,y], ...]}], ...}` keyed by page number.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `fulltext_pdf_id` | UUID | FK → fulltext_pdfs CASCADE |
| `reviewer_id` | UUID? | FK → users SET NULL |
| `drawing_data` | JSONB | strokes keyed by page number (1-indexed strings) |
| `updated_at` | TIMESTAMPTZ | refreshed on every save |
| UNIQUE | | `(fulltext_pdf_id, reviewer_id)` |

---

### Domain 8 — Ontology & Thematic Analysis

#### `ontology_nodes`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `parent_id` | UUID? | FK → ontology_nodes (self-ref) |
| `name` | VARCHAR | |
| `description` | TEXT? | |
| `namespace` | VARCHAR | `level` \| `dimension` \| `concept` \| `population` \| `intervention` \| `outcome` \| `other` |
| `color` | VARCHAR? | hex color |
| `position` | JSONB? | `{x, y, z}` for 3D graph layout |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

#### `ontology_edges`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `source_id` | UUID | FK → ontology_nodes |
| `target_id` | UUID | FK → ontology_nodes |
| `label` | VARCHAR? | |
| `color` | VARCHAR? | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

#### `record_concepts`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `record_id` | UUID? | FK → records (nullable) |
| `cluster_id` | UUID? | FK → overlap_clusters (nullable) |
| `node_id` | UUID | FK → ontology_nodes |
| `assigned_by` | UUID? | FK → users |
| `assigned_at` | TIMESTAMPTZ | |

#### `concept_taxonomy_nodes`
Aggregated taxonomy values derived from concept extractions — used by the Concept Taxonomy page for ontology construction.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `name` | VARCHAR | value string |
| `field_id` | VARCHAR | concept template field ID |
| `field_type` | VARCHAR | `entity` \| `relation` \| `metadata` |
| `parent_id` | UUID? | FK → concept_taxonomy_nodes (self-ref) |
| `aliases` | JSONB? | array of alternate strings |
| `description` | TEXT? | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

#### `code_extractions`
Assignments linking a thematic code to a specific extraction record.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `code_id` | VARCHAR | theme/code identifier |
| `extraction_id` | UUID | FK → extraction_records |
| `snippet_text` | TEXT? | quoted evidence segment |
| `note` | TEXT? | |
| `assigned_by` | UUID? | FK → users |
| `assigned_at` | TIMESTAMPTZ | |

#### `thematic_history`
Audit log for every codebook change (create, rename, merge, move, delete).

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `code_id` | VARCHAR? | |
| `code_name` | VARCHAR? | |
| `action` | VARCHAR | `create` \| `rename` \| `merge` \| `move` \| `delete` |
| `old_theme_id` | VARCHAR? | |
| `old_theme_name` | VARCHAR? | |
| `new_theme_id` | VARCHAR? | |
| `new_theme_name` | VARCHAR? | |
| `note` | TEXT? | |
| `changed_by` | UUID? | FK → users |
| `changed_at` | TIMESTAMPTZ | |

---

### Domain 9 — LLM Screening

#### `llm_screening_runs`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `triggered_by` | UUID? | FK → users |
| `status` | VARCHAR | `pending` \| `running` \| `done` \| `failed` \| `stopped` |
| `model` | VARCHAR | model ID string |
| `mode` | VARCHAR | `ta` \| `ft` \| `extract` \| `two_phase` |
| `source_id` | UUID? | FK → sources (null = all) |
| `agent_mode` | BOOLEAN | multi-agent pipeline |
| `agent_pipeline` | JSONB? | pipeline config |
| `saturation_threshold` | INTEGER? | stop after N consecutive non-novel records |
| `include_extraction` | BOOLEAN | |
| `total_records` | INTEGER? | |
| `processed_records` | INTEGER? | |
| `included_count` | INTEGER? | |
| `excluded_count` | INTEGER? | |
| `uncertain_count` | INTEGER? | |
| `abstract_only_count` | INTEGER? | |
| `new_concepts_count` | INTEGER? | |
| `input_tokens` | INTEGER? | |
| `output_tokens` | INTEGER? | |
| `estimated_cost_usd` | FLOAT? | shown before launch |
| `actual_cost_usd` | FLOAT? | |
| `stopped_at_saturation` | BOOLEAN | |
| `started_at` | TIMESTAMPTZ? | |
| `completed_at` | TIMESTAMPTZ? | |
| `stopped_at` | TIMESTAMPTZ? | |
| `created_at` | TIMESTAMPTZ | |
| `source_run_id` | UUID? | FK → llm_screening_runs (retry chain) |

#### `llm_screening_results`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `run_id` | UUID | FK → llm_screening_runs CASCADE |
| `project_id` | UUID | FK → projects CASCADE |
| `record_id` | UUID? | FK → records |
| `cluster_id` | UUID? | FK → overlap_clusters |
| `ta_decision` | VARCHAR? | `include` \| `exclude` \| `uncertain` |
| `ta_reason` | TEXT? | |
| `ft_decision` | VARCHAR? | |
| `ft_reason` | TEXT? | |
| `reason_code` | VARCHAR? | |
| `matched_codes` | JSONB? | thematic codes matched |
| `new_concepts` | JSONB? | novel concepts suggested |
| `full_text_source` | VARCHAR? | where FT text was obtained |
| `extracted_json` | JSONB? | extraction output (if enabled) |
| `agent_outputs` | JSONB? | per-agent outputs (multi-agent mode) |
| `input_tokens` | INTEGER? | |
| `output_tokens` | INTEGER? | |
| `model` | VARCHAR? | |
| `reviewed_by` | UUID? | FK → users |
| `reviewed_at` | TIMESTAMPTZ? | |
| `review_action` | VARCHAR? | `accepted` \| `rejected` \| `modified` |
| `created_at` | TIMESTAMPTZ | |

---

### Domain 10 — Citation Sourcing

#### `citation_searches`
One row per snowballing run (triggered by a user or completed automatically).

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `project_id` | UUID | FK → projects CASCADE |
| `triggered_by` | UUID? | FK → users |
| `status` | VARCHAR | `pending` \| `running` \| `done` \| `failed` |
| `direction` | VARCHAR | `backward` \| `forward` \| `both` \| `manual` |
| `scope` | VARCHAR | `all` \| `new` \| `custom` \| `manual` |
| `source_record_count` | INTEGER? | number of source articles searched |
| `source_record_ids` | JSONB? | array of source record UUIDs |
| `candidate_count` | INTEGER? | total candidates found |
| `already_in_project_count` | INTEGER? | candidates already in project |
| `error_msg` | TEXT? | |
| `created_at` | TIMESTAMPTZ | |
| `completed_at` | TIMESTAMPTZ? | |

#### `citation_candidates`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `search_id` | UUID | FK → citation_searches CASCADE |
| `project_id` | UUID | FK → projects |
| `direction` | VARCHAR | `backward` \| `forward` |
| `source_record_id` | UUID? | FK → records (the citing/cited article) |
| `source_record_ids` | JSONB? | array (for multiple sources) |
| `s2_paper_id` | VARCHAR? | Semantic Scholar internal ID |
| `title` | TEXT? | |
| `abstract` | TEXT? | |
| `authors` | TEXT? | |
| `year` | INTEGER? | |
| `doi` | VARCHAR? | |
| `pmid` | VARCHAR? | |
| `journal` | VARCHAR? | |
| `in_project` | BOOLEAN | true if already in this project |
| `project_record_id` | UUID? | FK → records (if already in project) |
| `decision` | VARCHAR? | `import` \| `skip` \| null |
| `decided_by` | UUID? | FK → users |
| `decided_at` | TIMESTAMPTZ? | |
| `notes` | TEXT? | |
| `import_job_id` | UUID? | FK → import_jobs (after importing) |
| `created_at` | TIMESTAMPTZ | |
| UNIQUE | | `(search_id, direction, doi)` — prevents same paper twice per run |

---

### Entity-Relationship Overview

```
users ──────────────────────────────────────────────────────────────────────────────┐
  │                                                                                  │
  ├──► projects ◄── parent_project_id (self-ref sub-projects)                       │
  │       │                                                                          │
  │       ├──► project_members (user_id → users)                                    │
  │       ├──► project_invitations (invited_by → users)                             │
  │       ├──► project_samples (child_project_id → projects)                        │
  │       │                                                                          │
  │       ├──► sources                                                               │
  │       │       └──► import_jobs (created_by → users)                             │
  │       │                 └──► record_sources ◄── records ◄── (project_id)        │
  │       │                           └──► records (canonical)                      │
  │       │                                                                          │
  │       ├──► match_strategies                                                      │
  │       │       ├──► dedup_jobs ──► match_log                                     │
  │       │       └──► overlap_strategy_runs                                         │
  │       │                                                                          │
  │       ├──► overlap_clusters                                                      │
  │       │       └──► overlap_cluster_members (record_sources ←→ sources)          │
  │       │                                                                          │
  │       ├──► screening_decisions  (record_id? | cluster_id?, reviewer → users)    │
  │       ├──► screening_claims     (record_id? | cluster_id?, reviewer → users)    │
  │       ├──► screening_queues     (reviewer → users)                              │
  │       ├──► consensus_decisions  (record_id? | cluster_id?, adjudicator → users) │
  │       ├──► extraction_records   (record_id? | cluster_id?, reviewer → users)    │
  │       ├──► concept_extractions  (record_id? | cluster_id?, reviewer → users)    │
  │       │                                                                          │
  │       ├──► record_annotations   (record_id? | cluster_id?, reviewer → users)    │
  │       ├──► project_labels ──► record_labels (record_id? | cluster_id?)         │
  │       │                                                                          │
  │       ├──► fulltext_pdfs (record_id? | cluster_id?, uploaded_by → users)       │
  │       │       └──► pdf_drawing_annotations (reviewer_id → users)                │
  │       │                                                                          │
  │       ├──► ontology_nodes (parent_id self-ref) ──► ontology_edges               │
  │       │       └──► record_concepts (record_id? | cluster_id?)                   │
  │       ├──► concept_taxonomy_nodes (parent_id self-ref)                          │
  │       │                                                                          │
  │       ├──► code_extractions (extraction_id → extraction_records)                │
  │       ├──► thematic_history                                                      │
  │       │                                                                          │
  │       ├──► llm_screening_runs ──► llm_screening_results                         │
  │       └──► citation_searches ──► citation_candidates                            │
  │                                                                                  │
  └──► invite_codes (created_by_user_id → users)                               ─────┘
```

> **Polymorphic item pattern** — 12 tables store per-item data for either a canonical `record` or an overlap `cluster` using a pair of nullable foreign keys (`record_id`, `cluster_id`) guarded by a `CHECK` constraint ensuring exactly one is non-null. This pattern is used by: `screening_decisions`, `screening_claims`, `extraction_records`, `concept_extractions`, `record_annotations`, `record_labels`, `record_concepts`, `consensus_decisions`, `fulltext_pdfs`, `citation_candidates`, and `llm_screening_results`.

---

## API Reference

The interactive API documentation is available at `http://localhost:8000/docs` when the backend is running. Below is a summary of all API domains.

| Domain | Base path | Key endpoints |
|--------|-----------|--------------|
| Auth | `/` | `POST /register`, `POST /token`, `GET /me`, `PATCH /me`, `POST /me/change-password` |
| Projects | `/projects` | CRUD, `PATCH /{id}/criteria`, `PATCH /{id}/extraction-template`, `PATCH /{id}/concept-template`, `PATCH /{id}/llm-config`, `PATCH /{id}/shared-with-team`, sub-projects |
| Sources | `/projects/{id}/sources` | List, delete |
| Imports | `/projects/{id}/imports` | `POST` (upload file), `GET /{job_id}` (status) |
| Records | `/projects/{id}/records` | List (paginated), `GET /{record_id}`, `DELETE /{record_id}` |
| Strategies | `/projects/{id}/strategies` | CRUD match strategies |
| Dedup | `/projects/{id}/dedup-jobs` | `POST` (run), `GET` (list), `GET /{job_id}` |
| Overlaps | `/projects/{id}/overlaps` | GET summary, GET clusters (paginated), GET visual-summary, GET intersections, POST manual-link, POST lock, DELETE member, strategy CRUD, run history |
| Screening | `/projects/{id}/screening` | GET /sources, GET /next, POST /decisions, GET /decisions, POST /extractions, GET /extractions, GET /saturation |
| Extractions | `/projects/{id}/extractions` | GET (library, enriched with metadata) |
| Annotations | `/projects/{id}/annotations` | `POST`, `GET` (?record_id= or ?cluster_id=), `DELETE /{ann_id}` |
| Labels | `/projects/{id}/labels` | CRUD labels, `POST /assign`, `DELETE /assign`, `GET /item`, `GET /articles` |
| Ontology | `/projects/{id}/ontology` | CRUD nodes + edges, `POST /sync-levels`, export/import |
| Thematic | `/projects/{id}/thematic` | GET map, CRUD themes/codes, GET evidence, POST/DELETE assignments, GET history |
| Concept extraction | `/projects/{id}/concept-extraction` | `POST` (upsert), `GET /item`, `GET /aggregate`, `POST /push-to-ontology` |
| Concept taxonomy | `/projects/{id}/concept-taxonomy` | CRUD taxonomy nodes |
| Full text | `/projects/{id}/fulltext` | `POST` (upload), `GET` (meta + current user's drawing), `GET /{id}/download`, `DELETE /{id}`, `PATCH /{id}/drawing`, `GET /links` |
| LLM screening | `/projects/{id}/llm-screening` | `POST /runs`, `GET /runs`, `GET /runs/{id}`, `GET /runs/{id}/results`, `POST /runs/{id}/accept`, `GET /missing-pdfs`, `GET /models` |
| Citations | `/projects/{id}/citations` | `POST /searches`, `GET /searches`, `GET /searches/{id}/candidates`, `POST /candidates/{id}/decision`, `POST /import` |
| Teams | `/projects/{id}/team` | `GET /me`, `GET /members`, `POST /invite`, `DELETE /invitations/{id}`, `PATCH /members/{uid}`, `DELETE /members/{uid}`, `POST /accept` |
| Consensus | `/projects/{id}/consensus` | `GET /conflicts`, `GET /resolved`, `POST /adjudicate`, `GET /reliability`, `GET /stats`, `GET /team-decisions` |
| Admin | `/admin` | `POST /invite-codes`, `GET /invite-codes`, `PATCH /invite-codes/{id}`, `DELETE /invite-codes/{id}`, `GET /stats` |

---

## Troubleshooting

**`no configuration file provided: not found`**  
You ran `docker compose` from the wrong directory. `cd` into the project folder first:
```bash
cd EvidencePlatform
docker compose up -d --build
```

**Port already in use**  
Change the host-side port in `docker-compose.yml`. For example, `"8001:8000"` exposes the backend on port 8001.

**Docker build fails on Apple Silicon (M1/M2/M3)**  
Docker Desktop handles ARM natively; no changes are needed. If a base image causes issues, add `platform: linux/amd64` to the affected service.

**Database connection refused (manual setup)**  
Run `pg_isready` to confirm PostgreSQL is running and check that the `DATABASE_URL` in `.env` matches your local credentials.

**Migrations fail**  
Ensure the database user has `CREATE` privileges, then re-run `alembic upgrade head`.

**Frontend shows "Failed to load"**  
Verify the backend is running on port 8000 and that `BACKEND_CORS_ORIGINS` in `.env` includes your frontend URL.

**PDF drawing annotations not saving**  
Each reviewer's drawing layer is isolated in `pdf_drawing_annotations`. Only the reviewer's own strokes load when they open the PDF; this is intentional for dual-reviewer workflows.

**Replacing or deleting a PDF fails with 403**  
Only the original uploader or a project owner/admin can replace or delete the shared PDF. Contact your project admin if you need to replace it.

---

## Roadmap

Features currently in development or planned for upcoming sprints.

### LLM Partial Screening (same pipeline as human reviewers)

Today's LLM screening runs as a separate batch process — it produces decisions but they are stored independently and reviewed after the run. The planned upgrade makes LLM decisions **first-class citizens in the same screening pipeline** used by human reviewers:

- LLM runs through the same TA → FT → Extraction queue, processing one article at a time
- Each decision is recorded in `screening_decisions` with the LLM treated as a reviewer (using a service account or a designated model identity)
- Exclusion reasons are recorded in `reason_code` — the same field used by humans
- LLM decisions appear in the conflict detection and adjudication flow alongside human decisions, so disagreements between a human and an LLM reviewer are surfaced and can be adjudicated
- Cohen's kappa and team statistics include LLM reviewers, enabling quantitative human–AI agreement analysis
- Partial runs are supported: the LLM can screen one source or bucket at a time, leaving others for human reviewers

This enables hybrid workflows where the LLM pre-screens the full corpus and humans adjudicate uncertain cases — without any separate import/merge step.

### Enhanced Team Workflows

- **Reviewer assignment** — assign specific articles or sources to specific team members rather than relying on claim-based first-come-first-served allocation
- **Reviewer progress dashboard** — per-reviewer completion rate, speed, and agreement trends in one view
- **Consensus export** — one-click export of final adjudicated decisions with dissenting votes and rationale, formatted for PRISMA flow diagrams
- **Observer role** — read-only project access for advisors or external auditors without screening rights

---

## Contributing

1. Fork the repository and create a feature branch.
2. Follow the principles in `CLAUDE.md` — reproducibility, auditability, simplicity.
3. Add tests for any logic that processes or transforms evidence data.
4. Open a pull request with a clear description of what changed and why.

---

## License

MIT
