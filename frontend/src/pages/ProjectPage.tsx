import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Upload, BookOpen, GitMerge, CheckSquare, FlaskConical, Tag, Network, GitBranch, Bot, Users, Scale } from "lucide-react";
import {
  projectsApi,
  importsApi,
  sourcesApi,
  strategiesApi,
  dedupJobsApi,
  overlapsApi,
  labelsApi,
  ontologyApi,
  screeningApi,
  DEFAULT_OVERLAP_CONFIG,
} from "../api/client";
import type { ImportJob, OverlapConfig, ProjectCriteria, CriterionItem, ExtractionTemplateRow, ExtractionCellType, ProjectLabel, OntologyNode, ScreeningSource } from "../api/client";
import StartScreeningModal from "../components/StartScreeningModal";
import LabelManager from "../components/LabelManager";

// ---------------------------------------------------------------------------
// Field chip definitions for the overlap strategy builder (9 fields)
// ---------------------------------------------------------------------------

interface FieldDef {
  key: string;
  label: string;
  description: string;
}

const FIELD_DEFS: FieldDef[] = [
  { key: "doi",          label: "DOI",          description: "Match on exact Digital Object Identifier" },
  { key: "pmid",         label: "PubMed ID",    description: "Match on exact PubMed / MEDLINE accession number" },
  { key: "title",        label: "Title",        description: "Match on normalized title" },
  { key: "year",         label: "Year",         description: "Match on publication year" },
  { key: "first_author", label: "First Author", description: "Match on first author last name" },
  { key: "all_authors",  label: "All Authors",  description: "Match on all author last names (requires at least one shared)" },
  { key: "volume",       label: "Volume",       description: "Match on journal volume number" },
  { key: "pages",        label: "Pages",        description: "Match on page range" },
  { key: "journal",      label: "Journal",      description: "Match on journal name" },
];

// ---------------------------------------------------------------------------
// Preset configurations
// ---------------------------------------------------------------------------

interface PresetDef {
  label: string;
  tooltip: string;
  fields: string[];
  warn?: boolean;
}

const PRESETS: PresetDef[] = [
  {
    label: "Recommended",
    tooltip: "DOI · PMID · Title + Year + First Author + Volume — good balance of precision and recall",
    fields: ["doi", "pmid", "title", "year", "first_author", "volume"],
  },
  {
    label: "Strict",
    tooltip: "Requires more fields to match — fewer false positives, may miss some duplicates",
    fields: ["doi", "pmid", "title", "year", "first_author", "volume", "journal"],
  },
  {
    label: "Loose",
    tooltip: "Title + Year only — faster but may produce false positives for short titles",
    fields: ["doi", "pmid", "title", "year"],
    warn: true,
  },
];

// ---------------------------------------------------------------------------
// Live rule summary (mirrors _make_config_summary on the backend)
// ---------------------------------------------------------------------------

// ── Extraction template paste parser ─────────────────────────────────────────
// Handles tab-delimited (Excel / Google Sheets / Word tables) and CSV.
//
// Key behaviours:
//  • Merged domain cells: carries the last non-empty Domain value forward so
//    rows with an empty first column still receive the correct domain.
//  • Section-header rows (domain text, no item) are used to update the domain
//    but do not produce a data row.
//  • Auto-detects cell type from inline annotations in the Data Item text:
//      (multi-select): opt1; opt2      → multi_select + options
//      (single-select: opt1, opt2)     → single_select + options
//      (Y/N)                           → single_select, options=[Yes, No]
//      (Checkbox: opt1, opt2)          → multi_select + options
//    The annotation is stripped from the displayed item label.
//  • Optional explicit Type (col 3) and Options (col 4) columns override
//    annotation detection when present.
//  • Header rows whose first cell matches a known column label are skipped.

const HEADER_WORDS = new Set(["domain", "data item", "item", "field", "category", "type", "options"]);

/** Split one line: tab-delimited first, else proper CSV. */
function splitLine(line: string): string[] {
  if (line.includes("\t")) return line.split("\t");
  const cells: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inQ)                       { inQ = true; continue; }
    if (ch === '"' && inQ && line[i+1] === '"')   { cur += '"'; i++; continue; }
    if (ch === '"' && inQ)                         { inQ = false; continue; }
    if (ch === ',' && !inQ)                       { cells.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

const _c = (s?: string) => (s ?? "").replace(/^["'\s]+|["'\s]+$/g, "").trim();

/** Split an options string on comma / semicolon / pipe; strip stray "and". */
function splitOpts(s: string): string[] {
  return s.split(/[,;|]/)
    .map((o) => o.replace(/^\s*and\s+/i, "").trim())
    .filter(Boolean);
}

/**
 * Inspect a raw Data Item string for an inline type annotation.
 * Returns the cleaned label, inferred type, and options list.
 */
function detectAnnotation(raw: string): { label: string; type: ExtractionCellType; options: string[] } {
  // (multi-select): opt1; opt2  OR  (multi-select)  OR  multi-select: opt1, opt2
  const mColon = raw.match(/^(.*?)\s*\(multi[- ]?select(?:ion)?[^)]*\)\s*:?\s*(.*)$/i);
  if (mColon) {
    return {
      label: mColon[1].trim() || raw,
      type: "multi_select",
      options: mColon[2].trim() ? splitOpts(mColon[2]) : [],
    };
  }

  // (single-select: opt1, opt2)
  const sInside = raw.match(/^(.*?)\s*\(single[- ]?select[:\s,]+([^)]+)\)/i);
  if (sInside) {
    return {
      label: raw.replace(/\s*\(single[- ]?select[^)]*\)/i, "").trim() || raw,
      type: "single_select",
      options: splitOpts(sInside[2]),
    };
  }
  // (single-select) with no options inside
  const sEmpty = raw.match(/^(.*?)\s*\(single[- ]?select\)/i);
  if (sEmpty) {
    return { label: sEmpty[1].trim() || raw, type: "single_select", options: [] };
  }

  // (Y/N)
  if (/\(Y\/N\)/i.test(raw)) {
    return {
      label: raw.replace(/\s*\(Y\/N\)/i, "").trim() || raw,
      type: "single_select",
      options: ["Yes", "No"],
    };
  }

  // (Checkbox: opt1, opt2)
  const cb = raw.match(/^(.*?)\s*\(checkbox[:\s]+([^)]+)\)/i);
  if (cb) {
    return { label: cb[1].trim() || raw, type: "multi_select", options: splitOpts(cb[2]) };
  }

  return { label: raw, type: "string", options: [] };
}

function parseTemplateTable(text: string): ExtractionTemplateRow[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const rows: ExtractionTemplateRow[] = [];
  let lastDomain = "";

  for (const line of lines) {
    const parts = splitLine(line);
    const col0  = _c(parts[0]);
    const col1  = _c(parts[1] ?? "");

    // Skip the very first line if it looks like a header
    if (!rows.length && !lastDomain && HEADER_WORDS.has(col0.toLowerCase())) continue;

    // Carry forward merged domain
    if (col0) lastDomain = col0;
    const domain = lastDomain;

    // For a single-column paste the whole line is the item text
    const rawItem = parts.length === 1 ? col0 : col1;

    // A row with a domain value but no item is a section-header — update domain only
    if (!rawItem) continue;

    // Explicit Type / Options columns override annotation detection
    const colType = _c(parts[2] ?? "").toLowerCase().replace(/[\s-]+/g, "_");
    const VALID: ExtractionCellType[] = ["string", "single_select", "multi_select"];
    const explicitType = VALID.includes(colType as ExtractionCellType)
      ? (colType as ExtractionCellType) : null;
    const colOpts = _c(parts[3] ?? "");

    const { label, type: detectedType, options: detectedOpts } = detectAnnotation(rawItem);

    rows.push({
      id: crypto.randomUUID(),
      domain,
      item: label,
      type: explicitType ?? detectedType,
      options: colOpts ? splitOpts(colOpts) : detectedOpts,
    });
  }

  return rows;
}

function buildRuleSummary(
  fields: Set<string>,
  fuzzyEnabled: boolean,
  fuzzyThreshold: number,
  yearTolerance: number,
): string {
  const parts: string[] = [];

  const ids = ["doi", "pmid"].filter((f) => fields.has(f));
  if (ids.length) parts.push(ids.map((f) => f.toUpperCase()).join(" + "));

  if (fields.has("title")) {
    const titleParts = ["Title"];
    if (fields.has("year"))         titleParts.push("Year");
    if (fields.has("first_author")) titleParts.push("First Author");
    if (fields.has("all_authors"))  titleParts.push("All Authors");
    if (fields.has("volume"))       titleParts.push("Volume");
    if (fields.has("pages"))        titleParts.push("Pages");
    if (fields.has("journal"))      titleParts.push("Journal");
    parts.push(titleParts.join(" + "));
  }

  if (fuzzyEnabled) {
    parts.push(`Fuzzy: on (${Math.round(fuzzyThreshold * 100)}%)`);
  } else {
    parts.push("Fuzzy: off");
  }
  parts.push(yearTolerance === 0 ? "Year: exact" : `Year: ±${yearTolerance}`);

  return parts.join(" · ") || "No fields selected";
}

// ---------------------------------------------------------------------------
// Module card style helpers
// ---------------------------------------------------------------------------

/** Module card wrapper */
const MC = (bg: string, border: string): React.CSSProperties => ({
  display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "0.4rem",
  padding: "0.9rem 1rem",
  borderRadius: "0.625rem",
  border: `1.5px solid ${border}`,
  background: bg,
  textDecoration: "none",
  color: "inherit",
  cursor: "pointer",
  boxSizing: "border-box",
  width: "100%",
  textAlign: "left",
});

/** Module card icon box */
const MI = (bg: string): React.CSSProperties => ({
  width: 32, height: 32,
  borderRadius: "0.375rem",
  background: bg,
  display: "flex", alignItems: "center", justifyContent: "center",
  marginBottom: "0.2rem",
  flexShrink: 0,
});

/** Module card description text */
const MD: React.CSSProperties = {
  fontSize: "0.775rem",
  color: "#64748b",
  lineHeight: 1.4,
  overflowWrap: "break-word",
  wordBreak: "break-word",
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function statusBadge(status: ImportJob["status"]) {
  const colors: Record<string, string> = {
    pending:    "#888",
    processing: "#1a73e8",
    completed:  "#188038",
    failed:     "#c5221f",
  };
  return (
    <span style={{ color: colors[status] ?? "#888", fontWeight: 600 }}>
      {status}
    </span>
  );
}

function FieldChip({
  fieldDef,
  enabled,
  onChange,
}: {
  fieldDef: FieldDef;
  enabled: boolean;
  onChange: (key: string, value: boolean) => void;
}) {
  return (
    <button
      type="button"
      title={fieldDef.description}
      onClick={() => onChange(fieldDef.key, !enabled)}
      style={{
        padding: "0.3rem 0.8rem",
        borderRadius: "1rem",
        border: `2px solid ${enabled ? "#1a73e8" : "#dadce0"}`,
        background: enabled ? "#e8f0fe" : "#f8f9fa",
        color: enabled ? "#1a73e8" : "#5f6368",
        fontWeight: enabled ? 600 : 400,
        fontSize: "0.85rem",
        cursor: "pointer",
        transition: "all 0.12s",
      }}
    >
      {fieldDef.label}
    </button>
  );
}

// Simple auto-dismiss toast
function Toast({ message, type, onDismiss }: { message: string; type: "success" | "error"; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      style={{
        position: "fixed",
        bottom: "1.5rem",
        right: "1.5rem",
        zIndex: 1000,
        background: type === "success" ? "#e6f4ea" : "#fce8e6",
        border: `1px solid ${type === "success" ? "#b7dfc4" : "#f28b82"}`,
        borderRadius: "0.5rem",
        padding: "0.75rem 1.25rem",
        boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
        maxWidth: 420,
        fontSize: "0.88rem",
        color: type === "success" ? "#188038" : "#c5221f",
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
      }}
    >
      <span style={{ flex: 1 }}>{message}</span>
      <button
        onClick={onDismiss}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: "1rem", lineHeight: 1, color: "inherit", padding: 0 }}
      >
        ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [newSourceName, setNewSourceName] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);

  // Strategy builder state
  const [selectedFields, setSelectedFields] = useState<Set<string>>(
    new Set(DEFAULT_OVERLAP_CONFIG.selected_fields)
  );
  const [fuzzyEnabled, setFuzzyEnabled] = useState(DEFAULT_OVERLAP_CONFIG.fuzzy_enabled);
  const [fuzzyThreshold, setFuzzyThreshold] = useState(DEFAULT_OVERLAP_CONFIG.fuzzy_threshold);
  const [yearTolerance, setYearTolerance] = useState(DEFAULT_OVERLAP_CONFIG.year_tolerance);
  const [newStrategyName, setNewStrategyName] = useState("");
  const [overlapError, setOverlapError] = useState<string | null>(null);

  // Toast
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  // Screening modal
  const [showScreeningModal, setShowScreeningModal] = useState(false);

  // Criteria state
  const [localCriteria, setLocalCriteria] = useState<ProjectCriteria>({ inclusion: [], exclusion: [] });

  // Extraction template state
  const [templateRows, setTemplateRows] = useState<ExtractionTemplateRow[]>([]);
  const [templatePasteText, setTemplatePasteText] = useState("");
  const [templatePasteOpen, setTemplatePasteOpen] = useState(false);

  // ── Data queries ──────────────────────────────────────────────────────────

  const { data: project, isLoading: loadingProject } = useQuery({
    queryKey: ["project", id],
    queryFn: () => projectsApi.get(id!).then((r) => r.data),
    enabled: !!id,
  });

  const { data: jobs } = useQuery({
    queryKey: ["imports", id],
    queryFn: () => importsApi.list(id!).then((r) => r.data),
    enabled: !!id,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 3000;
      return data.some((j) => j.status === "pending" || j.status === "processing")
        ? 1500
        : false;
    },
  });

  const { data: sources } = useQuery({
    queryKey: ["sources", id],
    queryFn: () => sourcesApi.list(id!).then((r) => r.data),
    enabled: !!id,
  });

  const { data: strategies } = useQuery({
    queryKey: ["strategies", id],
    queryFn: () => strategiesApi.list(id!).then((r) => r.data),
    enabled: !!id,
  });

  const { data: dedupJobs, refetch: refetchDedupJobs } = useQuery({
    queryKey: ["dedup-jobs", id],
    queryFn: () => dedupJobsApi.list(id!).then((r) => r.data),
    enabled: !!id,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5000;
      return data.some((j) => j.status === "pending" || j.status === "running")
        ? 2000
        : false;
    },
  });

  // Labels and ontology nodes (for linking to extraction template rows)
  const { data: allLabels = [] } = useQuery<ProjectLabel[]>({
    queryKey: ["labels", id],
    queryFn: () => labelsApi.list(id!).then((r) => r.data),
    enabled: !!id,
  });
  const { data: allNodes = [] } = useQuery<OntologyNode[]>({
    queryKey: ["ontology", id],
    queryFn: () => ontologyApi.list(id!).then((r) => r.data),
    enabled: !!id,
  });
  // Track which row's link panel is open (row id or null)
  const [linkOpenFor, setLinkOpenFor] = useState<string | null>(null);

  // Sync local criteria from server data
  useEffect(() => {
    if (project?.criteria) setLocalCriteria(project.criteria);
  }, [project?.criteria]);

  // Sync extraction template rows from server data
  useEffect(() => {
    if (project?.extraction_template?.rows) {
      setTemplateRows(project.extraction_template.rows);
    }
  }, [project?.extraction_template]);

  const activeStrategy = strategies?.find((s) => s.is_active);
  const lastDedupJob = dedupJobs?.[0];
  const isJobRunning =
    lastDedupJob?.status === "pending" || lastDedupJob?.status === "running";

  const { data: screeningSources } = useQuery<ScreeningSource[]>({
    queryKey: ["screening-sources", id],
    queryFn: () => screeningApi.getSources(id!).then((r) => r.data),
    enabled: !!id && (project?.record_count ?? 0) > 0,
    staleTime: 30_000,
  });

  // Derived strategy state
  const enabledFieldCount = selectedFields.size;
  const fuzzyValid = !fuzzyEnabled || (fuzzyThreshold >= 0.70 && fuzzyThreshold <= 1.0);
  const canSave = newStrategyName.trim().length > 0 && enabledFieldCount > 0 && fuzzyValid;
  const ruleSummary = buildRuleSummary(selectedFields, fuzzyEnabled, fuzzyThreshold, yearTolerance);

  // Last completed import
  const lastImport = jobs?.find((j) => j.status === "completed");

  // ── Mutations ─────────────────────────────────────────────────────────────

  const createStrategy = useMutation({
    mutationFn: ({ name, overlapConfig }: { name: string; overlapConfig: OverlapConfig }) =>
      strategiesApi.create(id!, name, "custom", true, null, overlapConfig),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["strategies", id] });
      queryClient.invalidateQueries({ queryKey: ["strategies-active", id] });
      setNewStrategyName("");
      setOverlapError(null);
      setToast({ message: "Strategy saved and activated.", type: "success" });
    },
    onError: (err: any) => {
      const detail = err.response?.data?.detail ?? "Failed to create strategy";
      setOverlapError(typeof detail === "string" ? detail : JSON.stringify(detail));
    },
  });

  const runOverlapDetection = useMutation({
    mutationFn: (strategyId: string) => overlapsApi.run(id!, strategyId),
    onSuccess: () => {
      refetchDedupJobs();
      queryClient.invalidateQueries({ queryKey: ["project", id] });
      queryClient.invalidateQueries({ queryKey: ["overlap", id] });
      setOverlapError(null);
      setToast({
        message: "Overlap detection started. Results will appear on the Overlap Resolution page once complete.",
        type: "success",
      });
    },
    onError: (err: any) => {
      const detail =
        err.response?.data?.detail ?? "Failed to start overlap detection";
      setOverlapError(
        typeof detail === "object" && detail.message
          ? detail.message
          : typeof detail === "string"
          ? detail
          : JSON.stringify(detail)
      );
    },
  });

  const criteriaMutation = useMutation({
    mutationFn: (c: ProjectCriteria) => projectsApi.updateCriteria(id!, c),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", id] });
      setToast({ message: "Criteria saved.", type: "success" });
    },
    onError: () => {
      setToast({ message: "Failed to save criteria.", type: "error" });
    },
  });

  const templateMutation = useMutation({
    mutationFn: (rows: ExtractionTemplateRow[]) =>
      projectsApi.updateExtractionTemplate(id!, rows),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", id] });
      setToast({ message: "Extraction template saved.", type: "success" });
    },
    onError: () => {
      setToast({ message: "Failed to save template.", type: "error" });
    },
  });

  const addSource = useMutation({
    mutationFn: (name: string) => sourcesApi.create(id!, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources", id] });
      setNewSourceName("");
      setSourceError(null);
    },
    onError: (err: any) => {
      const detail = err.response?.data?.detail ?? "Failed to add source";
      setSourceError(typeof detail === "string" ? detail : JSON.stringify(detail));
    },
  });

  // ── Handlers ──────────────────────────────────────────────────────────────

  function addCriterion(type: "inclusion" | "exclusion") {
    setLocalCriteria((prev) => ({
      ...prev,
      [type]: [...prev[type], { id: crypto.randomUUID(), text: "" }],
    }));
  }

  function updateCriterion(type: "inclusion" | "exclusion", itemId: string, text: string) {
    setLocalCriteria((prev) => ({
      ...prev,
      [type]: prev[type].map((c) => (c.id === itemId ? { ...c, text } : c)),
    }));
  }

  function removeCriterion(type: "inclusion" | "exclusion", itemId: string) {
    setLocalCriteria((prev) => ({
      ...prev,
      [type]: prev[type].filter((c) => c.id !== itemId),
    }));
  }

  function criteriaChanged(): boolean {
    const server = project?.criteria ?? { inclusion: [], exclusion: [] };
    return JSON.stringify(localCriteria) !== JSON.stringify(server);
  }

  function handleAddSource(e: React.FormEvent) {
    e.preventDefault();
    const name = newSourceName.trim();
    if (!name) return;
    addSource.mutate(name);
  }

  function handleFieldToggle(key: string, value: boolean) {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function handlePreset(fields: readonly string[]) {
    setSelectedFields(new Set(fields));
  }

  function handleRunOverlap() {
    if (activeStrategy) runOverlapDetection.mutate(activeStrategy.id);
  }

  function handleSaveAndRun() {
    if (!canSave) return;
    const overlapConfig: OverlapConfig = {
      selected_fields: Array.from(selectedFields),
      fuzzy_enabled: fuzzyEnabled,
      fuzzy_threshold: fuzzyThreshold,
      year_tolerance: yearTolerance,
    };
    createStrategy.mutate({ name: newStrategyName.trim(), overlapConfig });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loadingProject) return <div className="page"><p>Loading…</p></div>;

  return (
    <div className="page">
      {showScreeningModal && id && (
        <StartScreeningModal
          projectId={id}
          onClose={() => setShowScreeningModal(false)}
        />
      )}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={() => setToast(null)}
        />
      )}

      <header className="page-header">
        <Link to="/projects" className="back-link">← Projects</Link>
      </header>
      <main>
        <div className="project-hero">
          <h2>{project?.name}</h2>
          {project?.description && <p>{project.description}</p>}
          <div className="project-stats">
            <span title="Canonical records after overlap resolution">
              <strong>{project?.record_count ?? 0}</strong> records
            </span>
            <span title="Completed import jobs">
              <strong>{project?.import_count ?? 0}</strong> imports
            </span>
            {(project?.failed_import_count ?? 0) > 0 && (
              <span style={{ color: "#c5221f" }}>
                <strong>{project?.failed_import_count}</strong> failed
              </span>
            )}
          </div>
        </div>

        {/* ── Status bar ───────────────────────────────────────────────────── */}
        {(lastImport || lastDedupJob || isJobRunning) && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "1.25rem",
              background: "#f8f9fa",
              border: "1px solid #dadce0",
              borderRadius: "0.375rem",
              padding: "0.5rem 0.9rem",
              marginBottom: "1rem",
              fontSize: "0.82rem",
              color: "#5f6368",
            }}
          >
            {lastImport && (
              <span>
                <strong style={{ color: "#3c4043" }}>Last import:</strong>{" "}
                {lastImport.filename}{" "}
                · {lastImport.record_count?.toLocaleString() ?? "?"} records{" "}
                · {new Date(lastImport.completed_at ?? lastImport.created_at).toLocaleString()}
              </span>
            )}
            {isJobRunning && (
              <span style={{ color: "#1a73e8" }}>
                ⏳ Overlap detection running…
              </span>
            )}
            {!isJobRunning && lastDedupJob?.status === "completed" && (
              <span>
                <strong style={{ color: "#3c4043" }}>Last overlap run:</strong>{" "}
                {lastDedupJob.strategy?.name ?? activeStrategy?.name ?? "—"}{" "}
                · {lastDedupJob.clusters_created?.toLocaleString() ?? 0} groups{" "}
                · {new Date(lastDedupJob.completed_at!).toLocaleString()}
              </span>
            )}
          </div>
        )}

        {/* ── Module navigation ──────────────────────────────────────────── */}
        <div style={{ marginBottom: "2rem" }}>
          <Link to={`/projects/${id}/import`} className="btn-primary btn-lg">
            <Upload size={18} /> Import literature
          </Link>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
            gap: "0.75rem",
            marginTop: "1.25rem",
          }}>

            {(project?.record_count ?? 0) > 0 && (
              <Link to={`/projects/${id}/records`} style={MC("#eff6ff","#bfdbfe")}>
                <div style={MI("#bfdbfe")}><BookOpen size={16} color="#1d4ed8" /></div>
                <span style={{ fontWeight: 700, fontSize: "0.875rem", color: "#1d4ed8" }}>Records</span>
                <span style={MD}>Browse imported articles</span>
              </Link>
            )}

            {(sources?.length ?? 0) >= 2 && (
              <Link to={`/projects/${id}/overlap`} style={MC("#f5f3ff","#ddd6fe")}>
                <div style={MI("#ddd6fe")}><GitMerge size={16} color="#7c3aed" /></div>
                <span style={{ fontWeight: 700, fontSize: "0.875rem", color: "#7c3aed" }}>Overlap</span>
                <span style={MD}>Detect cross-source duplicates</span>
              </Link>
            )}

            {(project?.record_count ?? 0) > 0 && (
              <button onClick={() => setShowScreeningModal(true)} style={{ ...MC("#f0fdf4","#bbf7d0"), fontFamily: "inherit" }}>
                <div style={MI("#bbf7d0")}><CheckSquare size={16} color="#15803d" /></div>
                <span style={{ fontWeight: 700, fontSize: "0.875rem", color: "#15803d" }}>Screening</span>
                <span style={MD}>TA and full-text review</span>
              </button>
            )}

            {(project?.record_count ?? 0) > 0 && (
              <Link to={`/projects/${id}/llm-screening`} style={MC("#fff7ed","#fed7aa")}>
                <div style={MI("#fed7aa")}><Bot size={16} color="#ea580c" /></div>
                <span style={{ fontWeight: 700, fontSize: "0.875rem", color: "#ea580c" }}>LLM Screening</span>
                <span style={MD}>AI-assisted article screening</span>
              </Link>
            )}

            {(project?.record_count ?? 0) > 0 && (
              <Link to={`/projects/${id}/extractions`} style={MC("#ecfeff","#a5f3fc")}>
                <div style={MI("#a5f3fc")}><FlaskConical size={16} color="#0891b2" /></div>
                <span style={{ fontWeight: 700, fontSize: "0.875rem", color: "#0891b2" }}>Extractions</span>
                <span style={MD}>Structured evidence library</span>
              </Link>
            )}

            <Link to={`/projects/${id}/labels`} style={MC("#fff1f2","#fecdd3")}>
              <div style={MI("#fecdd3")}><Tag size={16} color="#e11d48" /></div>
              <span style={{ fontWeight: 700, fontSize: "0.875rem", color: "#e11d48" }}>Labels</span>
              <span style={MD}>Tag and categorize articles</span>
            </Link>

            <Link to={`/projects/${id}/thematic`} style={MC("#f0fdfa","#99f6e4")}>
              <div style={MI("#99f6e4")}><GitBranch size={16} color="#0d9488" /></div>
              <span style={{ fontWeight: 700, fontSize: "0.875rem", color: "#0d9488" }}>Thematic</span>
              <span style={MD}>Build codebooks and themes</span>
            </Link>

            <Link to={`/projects/${id}/ontology`} style={MC("#fdf4ff","#e9d5ff")}>
              <div style={MI("#e9d5ff")}><Network size={16} color="#9333ea" /></div>
              <span style={{ fontWeight: 700, fontSize: "0.875rem", color: "#9333ea" }}>Ontology</span>
              <span style={MD}>Concept mapping and relations</span>
            </Link>

            <Link to={`/projects/${id}/team`} style={MC("#f8fafc","#e2e8f0")}>
              <div style={MI("#e2e8f0")}><Users size={16} color="#475569" /></div>
              <span style={{ fontWeight: 700, fontSize: "0.875rem", color: "#475569" }}>Team</span>
              <span style={MD}>Manage reviewers and access</span>
            </Link>

            <Link to={`/projects/${id}/consensus`} style={MC("#fffbeb","#fde68a")}>
              <div style={MI("#fde68a")}><Scale size={16} color="#b45309" /></div>
              <span style={{ fontWeight: 700, fontSize: "0.875rem", color: "#b45309" }}>Consensus</span>
              <span style={MD}>Resolve conflicts and adjudicate</span>
            </Link>

          </div>
        </div>

        {/* ── Screening Progress by Corpus ─────────────────────────────────── */}
        {screeningSources && (() => {
          const perSource = screeningSources.filter((s) => s.id !== "all" && s.record_count > 0);
          if (perSource.length === 0 || perSource.every((s) => s.ta_screened === 0)) return null;

          // Render one progress cell: % bar when in progress, ✓ when done, — when not started
          function cell(screened: number, total: number) {
            if (total === 0) return <span style={{ color: "#d1d5db", fontSize: "0.78rem" }}>—</span>;
            if (screened >= total) {
              return <span style={{ color: "#15803d", fontWeight: 700, fontSize: "0.82rem" }}>✓</span>;
            }
            if (screened === 0) return <span style={{ color: "#d1d5db", fontSize: "0.78rem" }}>—</span>;
            const pct = Math.round((screened / total) * 100);
            return (
              <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 52 }}>
                <span style={{ fontSize: "0.73rem", color: "#4f46e5", fontWeight: 600 }}>{pct}%</span>
                <div style={{ height: 4, width: 52, background: "#e5e7eb", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: "#4f46e5", borderRadius: 2 }} />
                </div>
              </div>
            );
          }

          const thStyle: React.CSSProperties = {
            padding: "0.4rem 0.75rem", borderBottom: "2px solid #e5e7eb",
            color: "#6b7280", fontWeight: 600, fontSize: "0.73rem",
            textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "center" as const,
          };

          return (
            <section style={{ marginTop: "2rem" }}>
              <h3 style={{ marginBottom: "0.75rem" }}>Screening Progress</h3>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.83rem" }}>
                  <thead>
                    <tr>
                      <th style={{ ...thStyle, textAlign: "left", width: "40%" }}>Corpus</th>
                      <th style={thStyle}>TA Screening</th>
                      <th style={thStyle}>Full-text Review</th>
                      <th style={thStyle}>Extraction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perSource.map((src, i) => {
                      // A corpus is fully done when:
                      //  • every record has a TA decision
                      //  • every TA-included record has a FT decision (or none were included)
                      //  • every FT-included record has an extraction (or none were included)
                      const taAllDone = src.record_count > 0 && src.ta_screened >= src.record_count;
                      const ftAllDone = src.ta_included === 0 || src.ft_screened >= src.ta_included;
                      const exAllDone = src.ft_included === 0 || src.extracted_count >= src.ft_included;
                      const allDone = taAllDone && ftAllDone && exAllDone;
                      return (
                        <tr key={src.id} style={{ background: allDone ? "#f0fdf4" : i % 2 === 0 ? "#fff" : "#f9fafb" }}>
                          <td style={{ padding: "0.55rem 0.75rem", borderBottom: "1px solid #f3f4f6", fontWeight: 500, color: allDone ? "#15803d" : "#374151" }}>
                            {allDone && <span style={{ marginRight: "0.3rem" }}>✓</span>}{src.name}
                          </td>
                          <td style={{ padding: "0.55rem 0.75rem", borderBottom: "1px solid #f3f4f6", textAlign: "center" }}>
                            {cell(src.ta_screened, src.record_count)}
                          </td>
                          <td style={{ padding: "0.55rem 0.75rem", borderBottom: "1px solid #f3f4f6", textAlign: "center" }}>
                            {cell(src.ft_screened, src.ta_included)}
                          </td>
                          <td style={{ padding: "0.55rem 0.75rem", borderBottom: "1px solid #f3f4f6", textAlign: "center" }}>
                            {cell(src.extracted_count, src.ft_included)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })()}

        {/* ── Labels ───────────────────────────────────────────────────────── */}
        <section style={{ marginTop: "2rem" }}>
          <h3>Labels</h3>
          <p className="muted" style={{ marginBottom: "0.75rem" }}>
            Create labels to categorize articles during screening. Apply them from the
            Screening Workspace and explore them on the{" "}
            <Link to={`/projects/${id}/labels`} style={{ color: "#6366f1" }}>Labels page</Link>.
          </p>
          {id && <LabelManager projectId={id} />}
        </section>

        {/* ── Screening Criteria ───────────────────────────────────────────── */}
        <section style={{ marginTop: "2rem" }}>
          <h3>Screening Criteria</h3>
          <p className="muted" style={{ marginBottom: "1rem" }}>
            Define inclusion and exclusion criteria for this systematic review. These will
            be visible as a reference panel during screening.
          </p>
          <div
            style={{
              border: "1px solid #dadce0",
              borderRadius: "0.5rem",
              padding: "1.25rem",
              background: "#fafafa",
            }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
              {/* Inclusion column */}
              <div>
                <div
                  style={{
                    color: "#188038",
                    fontWeight: 600,
                    marginBottom: "0.75rem",
                    fontSize: "0.9rem",
                  }}
                >
                  ✓ Include if
                </div>
                {localCriteria.inclusion.map((c: CriterionItem) => (
                  <div
                    key={c.id}
                    style={{
                      display: "flex",
                      gap: "0.4rem",
                      alignItems: "center",
                      marginBottom: "0.5rem",
                    }}
                  >
                    <input
                      type="text"
                      className="input"
                      value={c.text}
                      placeholder="Criterion…"
                      onChange={(e) => updateCriterion("inclusion", c.id, e.target.value)}
                      style={{ flex: 1, fontSize: "0.85rem" }}
                    />
                    <button
                      type="button"
                      onClick={() => removeCriterion("inclusion", c.id)}
                      title="Remove"
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "#c5221f",
                        fontSize: "1rem",
                        lineHeight: 1,
                        padding: "0.2rem",
                        flexShrink: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => addCriterion("inclusion")}
                  style={{ marginTop: "0.25rem", fontSize: "0.82rem" }}
                >
                  + Add inclusion
                </button>
              </div>

              {/* Exclusion column */}
              <div>
                <div
                  style={{
                    color: "#c5221f",
                    fontWeight: 600,
                    marginBottom: "0.75rem",
                    fontSize: "0.9rem",
                  }}
                >
                  ✕ Exclude if
                </div>
                {localCriteria.exclusion.map((c: CriterionItem) => (
                  <div
                    key={c.id}
                    style={{
                      display: "flex",
                      gap: "0.4rem",
                      alignItems: "center",
                      marginBottom: "0.5rem",
                    }}
                  >
                    <input
                      type="text"
                      className="input"
                      value={c.text}
                      placeholder="Criterion…"
                      onChange={(e) => updateCriterion("exclusion", c.id, e.target.value)}
                      style={{ flex: 1, fontSize: "0.85rem" }}
                    />
                    <button
                      type="button"
                      onClick={() => removeCriterion("exclusion", c.id)}
                      title="Remove"
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "#c5221f",
                        fontSize: "1rem",
                        lineHeight: 1,
                        padding: "0.2rem",
                        flexShrink: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => addCriterion("exclusion")}
                  style={{ marginTop: "0.25rem", fontSize: "0.82rem" }}
                >
                  + Add exclusion
                </button>
              </div>
            </div>

            <div style={{ marginTop: "1.25rem", display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn-primary"
                disabled={!criteriaChanged() || criteriaMutation.isPending}
                onClick={() => criteriaMutation.mutate(localCriteria)}
              >
                {criteriaMutation.isPending ? "Saving…" : "Save criteria"}
              </button>
            </div>
          </div>
        </section>

        {/* ── Extraction Template ──────────────────────────────────────────── */}
        <section style={{ marginTop: "2rem" }}>
          <h3>Data Extraction Template</h3>
          <p className="muted" style={{ marginBottom: "1rem" }}>
            Define the rows of your extraction table. During data extraction each included paper
            will show this table with columns: <strong>Domain</strong>, <strong>Data Item</strong>,
            and <strong>Data Extraction</strong>. Each row's cell type controls how reviewers enter
            values (free text, single choice, or multiple choices).
          </p>

          <div
            style={{
              border: "1px solid #dadce0",
              borderRadius: "0.5rem",
              background: "#fafafa",
              overflow: "hidden",
            }}
          >
            {/* Table header */}
            {templateRows.length > 0 && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 130px 1fr 32px",
                  gap: "0.5rem",
                  padding: "0.5rem 0.6rem 0.5rem 1rem",
                  background: "#f1f3f4",
                  borderBottom: "1px solid #dadce0",
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  color: "#5f6368",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                <span>Domain</span>
                <span>Data Item</span>
                <span>Cell Type</span>
                <span>Options (for selects)</span>
                <span />
              </div>
            )}

            {/* Rows */}
            <div style={{ padding: templateRows.length > 0 ? "0.5rem 1rem" : "0" }}>
              {templateRows.map((row, idx) => {
                const isSelect = row.type === "single_select" || row.type === "multi_select";
                const linkOpen = linkOpenFor === row.id;
                const linkedLabelIds = row.linked_label_ids ?? [];
                const linkedNodeIds = row.linked_node_ids ?? [];
                const hasLinks = linkedLabelIds.length > 0 || linkedNodeIds.length > 0;

                return (
                  <div
                    key={row.id}
                    style={{
                      marginBottom: "0.6rem",
                      border: "1px solid #e8eaed",
                      borderRadius: "0.375rem",
                      background: "#fff",
                      overflow: "hidden",
                    }}
                  >
                    {/* Main row */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 130px 1fr 32px", gap: "0.5rem", alignItems: "center", padding: "0.4rem 0.6rem" }}>
                      <input
                        type="text"
                        className="input"
                        placeholder="Domain…"
                        value={row.domain}
                        onChange={(e) => setTemplateRows((prev) => prev.map((r, i) => (i === idx ? { ...r, domain: e.target.value } : r)))}
                        style={{ fontSize: "0.84rem" }}
                      />
                      <input
                        type="text"
                        className="input"
                        placeholder="Data item…"
                        value={row.item}
                        onChange={(e) => setTemplateRows((prev) => prev.map((r, i) => (i === idx ? { ...r, item: e.target.value } : r)))}
                        style={{ fontSize: "0.84rem" }}
                      />
                      <select
                        value={row.type}
                        onChange={(e) => setTemplateRows((prev) => prev.map((r, i) => i === idx ? { ...r, type: e.target.value as ExtractionCellType } : r))}
                        style={{ fontSize: "0.84rem", padding: "0.3rem 0.45rem", border: "1px solid #dadce0", borderRadius: "0.25rem", background: "#fff" }}
                      >
                        <option value="string">Free text</option>
                        <option value="single_select">Single select</option>
                        <option value="multi_select">Multi select</option>
                      </select>
                      <input
                        type="text"
                        className="input"
                        placeholder={row.type === "string" ? "—" : "opt1, opt2, opt3…"}
                        disabled={row.type === "string"}
                        value={row.options.join(", ")}
                        onChange={(e) => setTemplateRows((prev) => prev.map((r, i) => i === idx ? { ...r, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : r))}
                        style={{ fontSize: "0.84rem", background: row.type === "string" ? "#f3f4f6" : "#fff", color: row.type === "string" ? "#aaa" : undefined }}
                      />
                      <button
                        type="button"
                        onClick={() => setTemplateRows((prev) => prev.filter((_, i) => i !== idx))}
                        title="Remove row"
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#c5221f", fontSize: "1rem", lineHeight: 1, padding: "0.2rem" }}
                      >
                        ×
                      </button>
                    </div>

                    {/* Extra options row */}
                    <div style={{ display: "flex", alignItems: "center", gap: "1rem", padding: "0.25rem 0.6rem 0.35rem", borderTop: "1px solid #f1f3f4", background: "#fafafa", flexWrap: "wrap" }}>
                      {/* Allow custom options — only for select types */}
                      {isSelect && (
                        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.76rem", color: "#5f6368", cursor: "pointer", userSelect: "none" }}>
                          <input
                            type="checkbox"
                            checked={row.allow_custom_options ?? false}
                            onChange={(e) => setTemplateRows((prev) => prev.map((r, i) => i === idx ? { ...r, allow_custom_options: e.target.checked } : r))}
                            style={{ accentColor: "#4f46e5" }}
                          />
                          Allow reviewers to add custom options
                        </label>
                      )}

                      {/* Link labels / ontology */}
                      <button
                        type="button"
                        onClick={() => setLinkOpenFor(linkOpen ? null : row.id)}
                        style={{
                          fontSize: "0.74rem", padding: "0.1rem 0.55rem", borderRadius: "1rem",
                          border: `1px solid ${hasLinks ? "#c7d2fe" : "#e0e0e0"}`,
                          background: hasLinks ? "#eef3ff" : "transparent",
                          color: hasLinks ? "#4f46e5" : "#9ca3af",
                          cursor: "pointer", fontWeight: hasLinks ? 600 : 400,
                        }}
                      >
                        {hasLinks ? `🔗 Linked (${linkedLabelIds.length + linkedNodeIds.length})` : "🔗 Link labels / concepts"}
                      </button>

                      {/* Show linked chips inline */}
                      {hasLinks && !linkOpen && (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {linkedLabelIds.map((lid) => {
                            const lbl = allLabels.find((l) => l.id === lid);
                            return lbl ? <span key={lid} style={{ fontSize: 11, padding: "1px 7px", borderRadius: 999, background: lbl.color + "22", color: lbl.color, border: `1px solid ${lbl.color}` }}>{lbl.name}</span> : null;
                          })}
                          {linkedNodeIds.map((nid) => {
                            const node = allNodes.find((n) => n.id === nid);
                            return node ? <span key={nid} style={{ fontSize: 11, padding: "1px 7px", borderRadius: 3, background: "#f3e8ff", color: "#7c3aed", border: "1px solid #c4b5fd" }}>{node.name}</span> : null;
                          })}
                        </div>
                      )}
                    </div>

                    {/* Link panel — expanded */}
                    {linkOpen && (
                      <div style={{ padding: "0.6rem 0.85rem", borderTop: "1px solid #e8eaed", background: "#f8f9fa" }}>
                        <div style={{ fontSize: "0.74rem", fontWeight: 600, color: "#6b7280", marginBottom: "0.4rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                          Labels
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: "0.6rem" }}>
                          {allLabels.length === 0 && <span style={{ fontSize: 12, color: "#bbb", fontStyle: "italic" }}>No labels defined yet</span>}
                          {allLabels.map((lbl) => {
                            const active = linkedLabelIds.includes(lbl.id);
                            return (
                              <button key={lbl.id} type="button"
                                onClick={() => setTemplateRows((prev) => prev.map((r, i) => i !== idx ? r : { ...r, linked_label_ids: active ? (r.linked_label_ids ?? []).filter((x) => x !== lbl.id) : [...(r.linked_label_ids ?? []), lbl.id] }))}
                                style={{ fontSize: 12, padding: "2px 9px", borderRadius: 999, border: `1.5px solid ${lbl.color}`, background: active ? lbl.color : "transparent", color: active ? "#fff" : lbl.color, cursor: "pointer", fontWeight: 500 }}
                              >
                                {active && "✓ "}{lbl.name}
                              </button>
                            );
                          })}
                        </div>

                        <div style={{ fontSize: "0.74rem", fontWeight: 600, color: "#6b7280", marginBottom: "0.4rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                          Concepts / Ontology
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                          {allNodes.length === 0 && <span style={{ fontSize: 12, color: "#bbb", fontStyle: "italic" }}>No ontology nodes defined yet</span>}
                          {allNodes.map((node) => {
                            const active = linkedNodeIds.includes(node.id);
                            const color = node.color ?? (node.namespace === "thematic" ? "#7c3aed" : "#3b82f6");
                            return (
                              <button key={node.id} type="button"
                                onClick={() => setTemplateRows((prev) => prev.map((r, i) => i !== idx ? r : { ...r, linked_node_ids: active ? (r.linked_node_ids ?? []).filter((x) => x !== node.id) : [...(r.linked_node_ids ?? []), node.id] }))}
                                style={{ fontSize: 12, padding: "2px 9px", borderRadius: 4, border: `1.5px solid ${color}`, background: active ? color : "transparent", color: active ? "#fff" : color, cursor: "pointer", fontWeight: 500 }}
                              >
                                {active && "✓ "}{node.name}
                                <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 3 }}>{node.namespace}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Footer actions */}
            <div
              style={{
                padding: "0.75rem 1rem",
                borderTop: templateRows.length > 0 ? "1px solid #e8eaed" : undefined,
                display: "flex",
                gap: "0.5rem",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                style={{ fontSize: "0.82rem" }}
                onClick={() =>
                  setTemplateRows((prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      domain: "",
                      item: "",
                      type: "string",
                      options: [],
                      allow_custom_options: false,
                      linked_label_ids: [],
                      linked_node_ids: [],
                    },
                  ])
                }
              >
                + Add row
              </button>

              <button
                type="button"
                className="btn-secondary"
                style={{ fontSize: "0.82rem" }}
                onClick={() => setTemplatePasteOpen((v) => !v)}
              >
                📋 Paste table
              </button>

              <div style={{ marginLeft: "auto" }}>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={templateMutation.isPending}
                  onClick={() => templateMutation.mutate(templateRows)}
                >
                  {templateMutation.isPending ? "Saving…" : "Save template"}
                </button>
              </div>
            </div>

            {/* Paste area */}
            {templatePasteOpen && (
              <div
                style={{
                  padding: "0.75rem 1rem 1rem",
                  borderTop: "1px solid #e8eaed",
                  background: "#fff",
                }}
              >
                <p style={{ fontSize: "0.82rem", color: "#5f6368", marginBottom: "0.4rem" }}>
                  Copy cells from <strong>Excel</strong> or <strong>Google Sheets</strong> and
                  paste below — the table is imported instantly.
                  Columns: <strong>Domain</strong>, <strong>Data Item</strong>,{" "}
                  <em>Type</em> (optional: <code>string</code> / <code>single_select</code> /{" "}
                  <code>multi_select</code>), <em>Options</em> (optional, separated by{" "}
                  <code>;</code>). Header rows are skipped automatically.
                </p>

                {/* Preview list — shown after a paste that produced rows */}
                {templatePasteText && (() => {
                  const preview = parseTemplateTable(templatePasteText);
                  return preview.length > 0 ? (
                    <div
                      style={{
                        background: "#f0fdf4",
                        border: "1px solid #bbf7d0",
                        borderRadius: "0.25rem",
                        padding: "0.5rem 0.75rem",
                        marginBottom: "0.5rem",
                        fontSize: "0.8rem",
                        color: "#166534",
                      }}
                    >
                      <strong>{preview.length} row{preview.length > 1 ? "s" : ""} ready to import:</strong>
                      <ul style={{ margin: "0.3rem 0 0 1rem", padding: 0, lineHeight: 1.7 }}>
                        {preview.slice(0, 6).map((r, i) => (
                          <li key={i}>
                            <strong>{r.domain}</strong>
                            {r.item ? ` · ${r.item}` : ""}
                            <span style={{ color: "#15803d", marginLeft: 6, fontStyle: "italic" }}>
                              ({r.type}{r.options.length ? `: ${r.options.join(", ")}` : ""})
                            </span>
                          </li>
                        ))}
                        {preview.length > 6 && <li>…and {preview.length - 6} more</li>}
                      </ul>
                    </div>
                  ) : (
                    <div style={{ color: "#b45309", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
                      ⚠ Could not detect table rows. Make sure you have at least a Domain and Data Item column.
                    </div>
                  );
                })()}

                <textarea
                  autoFocus
                  value={templatePasteText}
                  placeholder="⌘V / Ctrl+V here — table is detected automatically"
                  rows={4}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    fontFamily: "monospace",
                    fontSize: "0.8rem",
                    border: "1px solid #dadce0",
                    borderRadius: "0.25rem",
                    padding: "0.4rem 0.5rem",
                    resize: "vertical",
                    background: templatePasteText ? "#fafafa" : "#fffde7",
                  }}
                  onChange={(e) => setTemplatePasteText(e.target.value)}
                  onPaste={(e) => {
                    // Read plain text from clipboard (handles tab-delimited from Excel/Sheets)
                    const text = e.clipboardData.getData("text/plain");
                    e.preventDefault();           // don't fill textarea with raw text
                    const parsed = parseTemplateTable(text);
                    if (parsed.length > 0) {
                      setTemplateRows((prev) => [...prev, ...parsed]);
                      setTemplatePasteText("");
                      setTemplatePasteOpen(false);
                      setToast({ message: `${parsed.length} row${parsed.length > 1 ? "s" : ""} imported from table.`, type: "success" });
                    } else {
                      // Nothing parsed — show raw text so user can see what was pasted
                      setTemplatePasteText(text);
                    }
                  }}
                />

                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                  {templatePasteText && (
                    <button
                      type="button"
                      className="btn-primary"
                      style={{ fontSize: "0.82rem" }}
                      onClick={() => {
                        const parsed = parseTemplateTable(templatePasteText);
                        if (parsed.length > 0) {
                          setTemplateRows((prev) => [...prev, ...parsed]);
                          setTemplatePasteText("");
                          setTemplatePasteOpen(false);
                          setToast({ message: `${parsed.length} row${parsed.length > 1 ? "s" : ""} imported.`, type: "success" });
                        }
                      }}
                    >
                      Import rows
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ fontSize: "0.82rem" }}
                    onClick={() => {
                      setTemplatePasteText("");
                      setTemplatePasteOpen(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ── Sources ──────────────────────────────────────────────────────── */}
        <section style={{ marginTop: "2rem" }}>
          <h3>Sources</h3>
          <p className="muted" style={{ marginBottom: "0.75rem" }}>
            Tag each imported file with the database it came from (e.g. PubMed, Scopus).
          </p>
          {sources && sources.length > 0 && (
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                flexWrap: "wrap",
                marginBottom: "1rem",
              }}
            >
              {sources.map((s) => (
                <Link
                  key={s.id}
                  to={`/projects/${id}/records?source_id=${s.id}`}
                  style={{
                    background: "var(--surface-alt, #f1f3f4)",
                    border: "1px solid var(--border, #dadce0)",
                    borderRadius: "1rem",
                    padding: "0.2rem 0.75rem",
                    fontSize: "0.85rem",
                    fontWeight: 500,
                    textDecoration: "none",
                    color: "inherit",
                  }}
                >
                  {s.name}
                </Link>
              ))}
            </div>
          )}
          <form
            onSubmit={handleAddSource}
            style={{ display: "flex", gap: "0.5rem", maxWidth: 360 }}
          >
            <input
              type="text"
              className="input"
              placeholder="New source name…"
              value={newSourceName}
              onChange={(e) => setNewSourceName(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              type="submit"
              className="btn-secondary"
              disabled={!newSourceName.trim() || addSource.isPending}
            >
              Add
            </button>
          </form>
          {sourceError && (
            <p className="error" style={{ marginTop: "0.5rem" }}>
              {sourceError}
            </p>
          )}
        </section>

        {/* ── Overlap Resolution ───────────────────────────────────────────── */}
        <section style={{ marginTop: "2rem" }}>
          <h3>Overlap Resolution</h3>
          <p className="muted" style={{ marginBottom: "1rem" }}>
            Detect duplicate records within a single source and the same paper
            appearing across multiple databases. Select the matching fields below
            to control how overlaps are identified.
          </p>

          {/* Active strategy pill */}
          {activeStrategy && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.4rem",
                background: "#e8f0fe",
                border: "1px solid #c5d9f7",
                borderRadius: "0.5rem",
                padding: "0.4rem 0.85rem",
                marginBottom: "1rem",
                fontSize: "0.875rem",
              }}
            >
              <span style={{ color: "#1a73e8", fontWeight: 600 }}>Active:</span>
              <span>{activeStrategy.name}</span>
              {activeStrategy.preset !== "custom" && (
                <span className="muted">({activeStrategy.preset_label})</span>
              )}
            </div>
          )}

          {/* Last run status */}
          {lastDedupJob?.status === "completed" && (
            <p className="muted" style={{ marginBottom: "0.75rem", fontSize: "0.9rem" }}>
              Last run:{" "}
              {new Date(lastDedupJob.completed_at!).toLocaleString()} —{" "}
              {lastDedupJob.clusters_created ?? 0} overlap groups detected
              {(lastDedupJob.merges ?? 0) > 0 &&
                ` (${lastDedupJob.merges} duplicates resolved)`}
            </p>
          )}
          {isJobRunning && (
            <p style={{ color: "#1a73e8", marginBottom: "0.75rem" }}>
              ⏳ Overlap detection running…
            </p>
          )}

          {/* ── Preset buttons ─────────────────────────────────────────────── */}
          <div style={{ marginBottom: "0.75rem" }}>
            <span style={{ fontSize: "0.82rem", color: "#5f6368", marginRight: "0.5rem" }}>
              Presets:
            </span>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                title={p.tooltip}
                onClick={() => handlePreset(p.fields)}
                style={{
                  marginRight: "0.4rem",
                  padding: "0.2rem 0.65rem",
                  borderRadius: "0.3rem",
                  border: "1px solid #dadce0",
                  background: "#f8f9fa",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                  color: p.warn ? "#e37400" : "#3c4043",
                }}
              >
                {p.label}
                {p.warn && " ⚠"}
              </button>
            ))}
          </div>

          {/* Strategy builder — field chip selector */}
          <div style={{ marginBottom: "1.25rem" }}>
            <p style={{ fontWeight: 500, marginBottom: "0.5rem", fontSize: "0.9rem" }}>
              Matching rules{" "}
              <span className="muted" style={{ fontWeight: 400 }}>
                (toggle fields used to identify overlaps):
              </span>
            </p>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                flexWrap: "wrap",
                marginBottom: "0.75rem",
              }}
            >
              {FIELD_DEFS.map((fd) => (
                <FieldChip
                  key={fd.key}
                  fieldDef={fd}
                  enabled={selectedFields.has(fd.key)}
                  onChange={handleFieldToggle}
                />
              ))}
            </div>

            {/* Live rule summary */}
            <p
              style={{
                fontSize: "0.8rem",
                color: enabledFieldCount === 0 ? "#c5221f" : "#5f6368",
                marginBottom: "0.5rem",
                fontStyle: "italic",
              }}
            >
              Rule: {ruleSummary}
            </p>

            {/* Fuzzy matching toggle + options */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "1rem",
                marginTop: "0.25rem",
                flexWrap: "wrap",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  color: "#5f6368",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                }}
              >
                <input
                  type="checkbox"
                  checked={fuzzyEnabled}
                  onChange={(e) => setFuzzyEnabled(e.target.checked)}
                />
                Fuzzy title matching
              </label>
              {fuzzyEnabled && (
                <label style={{ color: "#5f6368", display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem" }}>
                  Similarity threshold:
                  <input
                    type="range"
                    min={0.7}
                    max={1.0}
                    step={0.01}
                    value={fuzzyThreshold}
                    onChange={(e) => setFuzzyThreshold(parseFloat(e.target.value))}
                    style={{ width: 100 }}
                  />
                  <strong>{Math.round(fuzzyThreshold * 100)}%</strong>
                </label>
              )}
              <label style={{ color: "#5f6368", fontSize: "0.85rem" }}>
                Year:&nbsp;
                <select
                  value={yearTolerance}
                  onChange={(e) => setYearTolerance(parseInt(e.target.value, 10))}
                  style={{ fontSize: "0.85rem" }}
                >
                  <option value={0}>Exact year</option>
                  <option value={1}>Allow ±1 year</option>
                </select>
              </label>
            </div>
          </div>

          {/* Action buttons */}
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {activeStrategy && (
              <button
                className="btn-primary"
                disabled={isJobRunning || runOverlapDetection.isPending}
                onClick={handleRunOverlap}
                title="Run overlap detection with the active strategy"
              >
                {isJobRunning ? "⏳ Running…" : "Run overlap detection"}
              </button>
            )}

            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="text"
                className="input"
                placeholder="Strategy name…"
                value={newStrategyName}
                onChange={(e) => setNewStrategyName(e.target.value)}
                style={{ width: 190 }}
              />
              <button
                className={activeStrategy ? "btn-secondary" : "btn-primary"}
                disabled={!canSave || createStrategy.isPending}
                onClick={handleSaveAndRun}
                title={
                  !newStrategyName.trim()
                    ? "Enter a strategy name"
                    : enabledFieldCount === 0
                    ? "Select at least one field"
                    : !fuzzyValid
                    ? "Fuzzy threshold must be between 70% and 100%"
                    : "Save these rules as a new strategy and activate it"
                }
              >
                {createStrategy.isPending ? "Saving…" : "Save & activate"}
              </button>
            </div>
          </div>

          {enabledFieldCount === 0 && (
            <p
              className="muted"
              style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "#c5221f" }}
            >
              Select at least one matching field to enable overlap detection.
            </p>
          )}
          {overlapError && (
            <p className="error" style={{ marginTop: "0.5rem" }}>
              {overlapError}
            </p>
          )}

          {/* Link to full overlap report */}
          {(sources?.length ?? 0) >= 2 && (
            <p style={{ marginTop: "0.75rem", fontSize: "0.9rem" }}>
              <Link
                to={`/projects/${id}/overlap`}
                style={{ color: "#1a73e8", textDecoration: "none" }}
              >
                View full Overlap Resolution report →
              </Link>
            </p>
          )}
        </section>

        {/* ── Import history ───────────────────────────────────────────────── */}
        <section style={{ marginTop: "2rem" }}>
          <h3>Import history</h3>
          {!jobs || jobs.length === 0 ? (
            <p className="muted">No imports yet. Upload a RIS or MEDLINE file to get started.</p>
          ) : (
            <table className="import-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Records</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const sourceName = job.source_id
                    ? sources?.find((s) => s.id === job.source_id)?.name ?? "—"
                    : "—";
                  return (
                    <tr key={job.id}>
                      <td>{job.filename}</td>
                      <td>{sourceName}</td>
                      <td>{statusBadge(job.status)}</td>
                      <td>{job.record_count ?? "—"}</td>
                      <td>{new Date(job.created_at).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  );
}
