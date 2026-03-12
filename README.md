# EvidencePlatform

Open-source infrastructure for systematic, reproducible evidence synthesis. Import literature from multiple databases, resolve duplicates, screen articles, extract structured evidence, and organize findings — with full auditability at every step.

---

## What it does

| Step | What happens |
|------|-------------|
| **Import** | Upload RIS, MEDLINE, or BibTeX files from PubMed, Embase, Cochrane, etc. |
| **Deduplication** | Automatically merges duplicate records within each source using a 3-tier Union-Find engine |
| **Overlap detection** | Identifies cross-source duplicates with a configurable 5-tier strategy (exact DOI/PMID, title+year+author, fuzzy); manual linking and locking supported |
| **Screening** | Title/abstract → full-text pipeline with configurable inclusion/exclusion criteria, custom exclusion reasons, anchored annotations, back/forward navigation, and full-text link resolution (Unpaywall/DOI/PMC/PubMed/Scholar) |
| **Extraction** | Structured evidence capture (populations, interventions, outcomes, study design) with a saturation counter that tracks diminishing returns |
| **Thematic analysis** | Codebook-driven thematic mapping — create themes and codes, assign evidence excerpts, and review coded passages |
| **Labels & Taxonomy** | Tag articles with colour-coded labels; build a hierarchical concept taxonomy for the project |
| **PDF viewer** | Attach full-text PDFs per record or cluster; view inline with freehand drawing (pen + eraser), text selection, and anchored annotation notes that persist as highlighted passages across sessions |

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

The test suite covers parsers, deduplication, overlap detection, screening workflow, extraction logic, thematic analysis, team collaboration, and strategy history (485 backend tests + 23 Vitest frontend tests).

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
│   ├── alembic/             # Alembic migrations (020 versions)
│   └── tests/               # pytest test suite
├── frontend/
│   ├── src/
│   │   ├── pages/           # Route-level page components
│   │   ├── components/      # Reusable UI components
│   │   ├── api/             # API client (TanStack Query)
│   │   └── utils/           # Pure helpers
│   └── index.html
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

## Contributing

1. Fork the repository and create a feature branch.
2. Follow the principles in `CLAUDE.md` — reproducibility, auditability, simplicity.
3. Add tests for any logic that processes or transforms evidence data.
4. Open a pull request with a clear description of what changed and why.

---

## License

MIT
