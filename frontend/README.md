# EvidencePlatform — Frontend

React + TypeScript frontend for EvidencePlatform. Built with Vite and TanStack Query.

## Pages

| Route | Page | Description |
|-------|------|-------------|
| `/` | ProjectsPage | Project list with creation entry point |
| `/projects/new` | NewProjectPage | Project creation form |
| `/projects/:id` | ProjectPage | Project overview: import, overlap, screening, extraction, labels, taxonomy |
| `/projects/:id/import` | ImportPage | File upload (RIS, MEDLINE, BibTeX) and import history |
| `/projects/:id/records` | RecordsPage | Paginated record browser |
| `/projects/:id/overlap` | OverlapPage | Cross-source overlap summary, Euler diagram, pairwise matrix, cluster list |
| `/projects/:id/screen` | ScreeningWorkspace | Sequential and mixed-mode TA/FT/extraction workspace |
| `/projects/:id/labels` | LabelsPage | Label management and per-label article list |
| `/projects/:id/extractions` | ExtractionLibrary | Extraction library (TA+FT included papers with extractions only); "Citation Search" button triggers snowballing |
| `/projects/:id/citations` | CitationSourcingPage | Citation search history — list of past runs; new search form with direction, scope, and custom paper selection |
| `/projects/:id/citations/:searchId` | CitationSourcingPage | Candidate review — checkbox selection, select-all, filter by source article, delete candidates, import selected |
| `/projects/:id/thematic` | ThematicAnalysis | Codebook themes, codes, evidence assignments |
| `/projects/:id/ontology` | OntologyPage | Hierarchical concept graph with 3D view |
| `/projects/:id/llm-screening` | LLMScreeningPage | LLM-assisted screening runs and results |
| `/projects/:projectId/team` | TeamPage | Project membership, invitations, roles |
| `/projects/:projectId/consensus` | ConsensusPage | Conflict detection, adjudication, inter-rater reliability |

## Development

```bash
npm install
npm run dev        # start dev server at http://localhost:5173
npm run build      # production build
npm run typecheck  # tsc --noEmit
npx vitest run     # run Vitest unit tests
```

The frontend expects the backend API at `http://localhost:8000`. This is proxied via the Vite config in development.

## Key dependencies

| Package | Purpose |
|---------|---------|
| React 18 | UI framework |
| TypeScript | Type safety |
| Vite | Build tool and dev server |
| TanStack Query | Server state, caching, and mutations |
| React Router v6 | Client-side routing |
| lucide-react | Icon set |
| rapidfuzz (backend) | Fuzzy matching (backend only) |

## Design system

Global CSS tokens and component classes are in `src/index.css`. Key classes:

- `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger` — button variants
- `.btn-lg`, `.btn-sm` — size modifiers
- `.card`, `.page`, `.section-header` — layout primitives
- `--brand`, `--surface`, `--border`, `--text`, `--text-muted` — CSS custom properties