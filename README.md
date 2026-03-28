# EvidencePlatform

Open-source infrastructure for systematic, reproducible evidence synthesis. Import literature from multiple databases, resolve duplicates, screen articles, extract structured evidence, and organize findings — with full auditability at every step.

---

## What it does

| Step | What happens |
|------|-------------|
| **Import** | Upload RIS, MEDLINE, or BibTeX files from PubMed, Embase, Cochrane, and other databases |
| **Deduplication** | Automatically merges duplicate records within each source using a 3-tier Union-Find engine (exact DOI/PMID → title+year+author → fuzzy) |
| **Overlap detection** | Identifies the same paper across multiple databases with a configurable 5-tier strategy; manual linking and cluster locking supported; visualised as Euler diagram, pairwise heatmap, and intersection summary |
| **Human screening** | Title/abstract → full-text pipeline with sequential or mixed mode; configurable inclusion/exclusion criteria; per-reason exclusion tracking; custom exclusion reasons; anchored annotations; back/forward navigation through session history; full-text link resolution (Unpaywall/DOI/PMC/PubMed/Scholar); per-corpus progress dashboard |
| **LLM-assisted screening** | AI screening runs using 15+ models across Anthropic, OpenAI, Google, Meta, DeepSeek, Mistral, and others; each record receives an include/exclude/uncertain decision with rationale; cost and time estimated before launch; all inputs and outputs logged with model version |
| **Team collaboration** | Invite reviewers by token; dual-reviewer isolation with independent decision storage; automatic conflict detection; adjudication by project owner; Cohen's kappa computed per stage and reviewer pair; team screening statistics |
| **Extraction** | Template-driven structured evidence capture with inline editing; Extraction Library with search, filter, and edit; saturation counter tracks diminishing returns on new concepts |
| **Thematic analysis** | Codebook-driven synthesis — create themes and codes, assign evidence excerpts, review coded passages, track codebook history |
| **Labels & Ontology** | Colour-coded personal labels for retrieval; hierarchical concept ontology with 3D graph view, drag-and-drop reparenting, and tagging during screening |
| **PDF viewer** | Attach full-text PDFs per record or cluster; floating panel with freehand drawing (pen + eraser), text selection, anchored annotation notes, and session history navigation |

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
git clone https://github.com/your-org/EvidencePlatform.git
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

```bash
docker compose up -d --build
```

This builds and starts three containers:

| Container | Purpose | Port |
|-----------|---------|------|
| `db` | PostgreSQL 16 database | `5433` (host) |
| `backend` | FastAPI API server (auto-migrates on start) | `8000` |
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

The test suite covers parsers, deduplication, overlap detection, screening workflow, extraction logic, thematic analysis, team collaboration, and strategy history (485+ backend tests + 23 Vitest frontend tests). Run a specific module with `-k <name>`, e.g. `pytest tests/ -k screening`.

---

## PDF Viewer and Annotation

Every article in the full-text screening and data extraction stages has a built-in PDF workspace. Click **View PDF** to open a floating panel that:

- Renders the PDF page-by-page using PDF.js (no browser plugin required)
- Lets you draw freehand annotations with a **Pen** tool (choose colour and stroke width) and erase them with the **Eraser** tool
- Saves all drawings automatically to the database — they persist across sessions and reload when you reopen the panel
- Lets you **clear** all drawings on the current page with one click
- Provides a **Notes drawer** at the bottom where you can write and save text notes anchored to the paper

The panel is **draggable** (drag the header to move it) and **resizable** (drag the left edge). All drawing data is stored as structured JSON in the database (one entry per PDF, keyed by page number), so your annotations survive backend restarts and are visible to team members with access to the project.

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

In Chrome or Edge, navigate to:

```
chrome://extensions
```

or

```
edge://extensions
```

**Step 2 — Enable Developer mode**

Toggle **Developer mode** on (top-right corner of the Extensions page).

**Step 3 — Load the extension**

Click **Load unpacked**, then select the `browser-extension/` folder inside this repository:

```
EvidencePlatform/
└── browser-extension/   ← select this folder
    ├── manifest.json
    ├── background.js
    ├── content.js
    ├── popup.html
    └── popup.js
```

The extension named **EvidencePlatform PDF Capture** will appear in your extensions list.

**Step 4 — Configure the backend URL** *(only needed once)*

Click the extension icon in the toolbar and set the **Backend URL** to match your running instance:

| Environment | Backend URL |
|-------------|------------|
| Local (default) | `http://localhost:8000` |
| Custom host/port | `http://your-server:8000` |

Click **Save**. If EvidencePlatform was already open in a tab before you installed the extension, click **Reload EvidencePlatform tab** so the content script is injected.

**Step 5 — Pin the extension** *(optional but convenient)*

Click the puzzle-piece icon in Chrome's toolbar → click the pin icon next to **EvidencePlatform PDF Capture** so it is always visible.

### Extension status indicators

The popup shows a coloured dot indicating the current state:

| Dot colour | Meaning |
|-----------|---------|
| Green | Idle — ready to watch for a download |
| Yellow (pulsing) | Actively watching — open the publisher site and download the PDF now |
| Red | Error — see the message for details |

### Troubleshooting the extension

**Extension captures a web page instead of a PDF**
Some publishers use single-use download tokens; after Chrome's native download consumes the token, re-fetching the URL returns an HTML login page. The extension detects this (Content-Type check + PDF magic-byte validation) and shows a clear error. Try clicking the PDF link again from within the active capture session.

**Upload fails with "401 Unauthorised"**
You are not logged in to EvidencePlatform, or your session expired. Log in and start a new capture session.

**Extension not visible in toolbar**
Go to `chrome://extensions`, confirm the extension is enabled, and pin it via the puzzle-piece menu.

---

## Project structure

```
EvidencePlatform/
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI app + router registration
│   │   ├── models/          # SQLAlchemy ORM models
│   │   ├── routers/         # API endpoints (one file per domain)
│   │   ├── services/        # Business logic
│   │   ├── repositories/    # Database queries
│   │   ├── parsers/         # RIS / MEDLINE / BibTeX parsers
│   │   └── utils/           # Dedup, overlap detection, matching
│   ├── migrations/          # Alembic migrations (024 versioned)
│   └── tests/               # pytest test suite
├── frontend/
│   ├── src/
│   │   ├── pages/           # Route-level page components
│   │   ├── components/      # Reusable UI components
│   │   ├── api/             # API client (TanStack Query)
│   │   └── utils/           # Pure helpers
│   └── index.html
├── browser-extension/       # Chrome MV3 extension for PDF capture
│   ├── manifest.json
│   ├── background.js        # Service worker — intercepts & uploads PDFs
│   ├── content.js           # Content script — bridges page ↔ background
│   ├── popup.html           # Extension popup UI
│   └── popup.js
├── docker-compose.yml
├── Makefile                 # make up / down / reset / migrate / logs
└── CLAUDE.md                # AI coding guidelines for this project
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

---

## Troubleshooting

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
