import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Upload, BookOpen, GitMerge, CheckSquare, FlaskConical, Tag, Network, GitBranch, Bot, Users, Scale, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
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
  aiPilotApi,
  DEFAULT_OVERLAP_CONFIG,
} from "../api/client";
import type { ImportJob, OverlapConfig, ProjectCriteria, CriterionItem, ExtractionTemplateRow, ExtractionCellType, ProjectLabel, OntologyNode, ScreeningSource, ConceptTemplateField, ConceptFieldType, ConceptInputType } from "../api/client";
import StartScreeningModal from "../components/StartScreeningModal";
import LabelManager from "../components/LabelManager";
import { useToast } from "../components/Feedback";
import CreateSubProjectModal from "../components/CreateSubProjectModal";

// ---------------------------------------------------------------------------
// Safe UUID generator — genId() requires HTTPS (secure context).
// This fallback works on HTTP (AWS without TLS) as well.
// ---------------------------------------------------------------------------
function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return genId();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

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
      id: genId(),
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

// ---------------------------------------------------------------------------
// CollapsibleSection — accordion panel with persistent open/close state
// ---------------------------------------------------------------------------

function CollapsibleSection({
  id,
  title,
  subtitle,
  defaultOpen = true,
  badge,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  badge?: string | number;
  children: React.ReactNode;
}) {
  const storageKey = `ep_section_${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored !== null ? stored === "true" : defaultOpen;
    } catch {
      return defaultOpen;
    }
  });

  function toggle() {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* ignore */ }
  }

  return (
    <section style={{ marginTop: "1.75rem" }}>
      <button
        type="button"
        onClick={toggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          width: "100%",
          textAlign: "left",
          background: "none",
          border: "none",
          padding: "0.5rem 0",
          cursor: "pointer",
          borderBottom: `2px solid ${open ? "#e5e7eb" : "#f3f4f6"}`,
          marginBottom: open ? "0.75rem" : 0,
        }}
      >
        <span style={{ color: "#9ca3af", flexShrink: 0 }}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <span style={{ fontWeight: 700, fontSize: "1rem", color: "#111827", flex: 1 }}>{title}</span>
        {badge !== undefined && (
          <span style={{
            fontSize: "0.72rem", fontWeight: 600, color: "#6366f1",
            background: "#eef2ff", border: "1px solid #c7d2fe",
            borderRadius: "1rem", padding: "0.1rem 0.55rem",
          }}>
            {badge}
          </span>
        )}
        {subtitle && !open && (
          <span style={{ fontSize: "0.78rem", color: "#9ca3af", fontStyle: "italic", marginRight: "0.25rem" }}>
            {subtitle}
          </span>
        )}
      </button>
      {open && <div>{children}</div>}
    </section>
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

  const toast = useToast();

  // Screening modal
  const [showScreeningModal, setShowScreeningModal] = useState(false);
  const [showSubProjectModal, setShowSubProjectModal] = useState(false);
  const [confirmDeleteSubProject, setConfirmDeleteSubProject] = useState<{ id: string; name: string } | null>(null);

  // Criteria state
  const [localCriteria, setLocalCriteria] = useState<ProjectCriteria>({ inclusion: [], exclusion: [] });

  // AI draft setup state
  const [showAiDraftPanel, setShowAiDraftPanel] = useState(false);
  const [aiDraftModel, setAiDraftModel] = useState("anthropic/claude-haiku-4-5");
  const [aiDraftQuestion, setAiDraftQuestion] = useState("");

  // Extraction template state
  const [templateRows, setTemplateRows] = useState<ExtractionTemplateRow[]>([]);
  const [templatePasteText, setTemplatePasteText] = useState("");
  const [templatePasteOpen, setTemplatePasteOpen] = useState(false);

  // Concept template state
  const [conceptFields, setConceptFields] = useState<ConceptTemplateField[]>([]);
  const [conceptAiInstructions, setConceptAiInstructions] = useState<string>("");

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

  // Sync concept template fields from server data
  useEffect(() => {
    if (project?.concept_template?.fields) {
      setConceptFields(project.concept_template.fields);
    }
    if (project?.concept_template?.ai_instructions !== undefined) {
      setConceptAiInstructions(project.concept_template.ai_instructions ?? "");
    }
  }, [project?.concept_template]);

  const activeStrategy = strategies?.find((s) => s.is_active);
  const lastDedupJob = dedupJobs?.[0];
  const isJobRunning =
    lastDedupJob?.status === "pending" || lastDedupJob?.status === "running";

  const { data: screeningSources } = useQuery<ScreeningSource[]>({
    queryKey: ["screening-sources", id],
    queryFn: () => screeningApi.getSources(id!).then((r) => r.data),
    enabled: !!id && (project?.record_count ?? 0) > 0,
    staleTime: 0,
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
      toast("Strategy saved and activated.", "success");
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
      toast("Overlap detection started. Results will appear on the Overlap Resolution page once complete.", "success");
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
      toast("Criteria saved.", "success");
    },
    onError: () => {
      toast("Failed to save criteria.", "error");
    },
  });

  const draftSetupMut = useMutation({
    mutationFn: () => aiPilotApi.draftSetup(id!, { model: aiDraftModel, research_question: aiDraftQuestion || project?.name || "" }),
    onSuccess: (r) => {
      const draft = r.data;
      const toItems = (arr: { text: string; active: boolean }[]) =>
        arr.map(item => ({ id: Math.random().toString(36).slice(2), text: item.text, active: item.active }));
      setLocalCriteria({
        inclusion: toItems(draft.criteria.inclusion),
        exclusion: toItems(draft.criteria.exclusion),
      });
      setShowAiDraftPanel(false);
      toast("AI draft applied — review and save below.", "success");
    },
    onError: () => toast("AI draft failed — check API key.", "error"),
  });

  const templateMutation = useMutation({
    mutationFn: (rows: ExtractionTemplateRow[]) =>
      projectsApi.updateExtractionTemplate(id!, rows),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", id] });
      toast("Extraction template saved.", "success");
    },
    onError: () => {
      toast("Failed to save template.", "error");
    },
  });

  const conceptTemplateMutation = useMutation({
    mutationFn: ({ fields, ai_instructions }: { fields: ConceptTemplateField[]; ai_instructions: string }) =>
      projectsApi.updateConceptTemplate(id!, fields, ai_instructions || undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", id] });
      toast("Concept template saved.", "success");
    },
    onError: () => {
      toast("Failed to save concept template.", "error");
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

  const deleteSource = useMutation({
    mutationFn: (sourceId: string) => sourcesApi.delete(id!, sourceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources", id] });
      queryClient.invalidateQueries({ queryKey: ["records", id] });
      queryClient.invalidateQueries({ queryKey: ["project", id] });
      toast("Corpus deleted. Exclusively-owned records have been removed.", "success");
    },
    onError: () => {
      toast("Failed to delete corpus.", "error");
    },
  });

  const [confirmDeleteSourceId, setConfirmDeleteSourceId] = useState<string | null>(null);

  const deleteSubProject = useMutation({
    mutationFn: (subProjectId: string) => projectsApi.deleteProject(subProjectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", id] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setConfirmDeleteSubProject(null);
      toast("Sub-project deleted.", "success");
    },
    onError: () => {
      toast("Failed to delete sub-project.", "error");
    },
  });

  async function toggleSharedWithTeam(subProjectId: string, currentShared: boolean) {
    try {
      await projectsApi.setSharedWithTeam(subProjectId, !currentShared);
      queryClient.invalidateQueries({ queryKey: ["project", id] });
      toast(currentShared ? "Sub-project unshared." : "Sub-project shared with team.", "success");
    } catch {
      toast("Failed to update sharing.", "error");
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  function addCriterion(type: "inclusion" | "exclusion") {
    setLocalCriteria((prev) => ({
      ...prev,
      [type]: [...prev[type], { id: genId(), text: "" }],
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
      <header className="page-header">
        <Link to="/projects" className="back-link">← Projects</Link>
        {project?.parent_project_id && project.sample_info && (
          <span style={{ marginLeft: 8, fontSize: 13, color: "var(--text-muted)" }}>
            ↳ Sub-project of{" "}
            <Link to={`/projects/${project.parent_project_id}`} style={{ color: "var(--brand)" }}>
              {project.sample_info.parent_project_name}
            </Link>
            {" "}(seed {project.sample_info.seed} · {project.sample_info.n_per_corpus} per corpus)
          </span>
        )}
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

            {!project?.parent_project_id && (project?.my_role === "owner" || project?.my_role === "admin") && (
              <button onClick={() => setShowSubProjectModal(true)} style={{ ...MC("#eef2ff","#c7d2fe"), fontFamily: "inherit" }}>
                <div style={MI("#c7d2fe")}><GitBranch size={16} color="#4338ca" /></div>
                <span style={{ fontWeight: 700, fontSize: "0.875rem", color: "#4338ca" }}>Sub-project</span>
                <span style={MD}>Sample articles for reliability</span>
              </button>
            )}

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
                      const taAllDone = src.record_count > 0 && src.ta_screened >= src.record_count;
                      const ftAllDone = src.ta_included === 0 || src.ft_screened >= src.ta_included;
                      const exAllDoneByCount = src.ft_included === 0 || src.extracted_count >= src.ft_included;
                      const exAllDone = exAllDoneByCount || (ftAllDone && !!src.threshold_reached);
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
                            {!!src.threshold_reached ? (
                              <span title={`Reached streak threshold after ${src.threshold_reached_at} consecutive papers with no new themes`} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", background: "#fef9c3", color: "#a16207", borderRadius: "1rem", padding: "0.1rem 0.5rem", fontSize: "0.75rem", fontWeight: 700, cursor: "default" }}>
                                ⚡ {src.threshold_reached_at}/{src.ft_included}
                              </span>
                            ) : (
                              cell(src.extracted_count, src.ft_included)
                            )}
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
        <CollapsibleSection
          id="labels"
          title="Labels"
          subtitle="Manage article tags"
          defaultOpen={false}
          badge={allLabels.length > 0 ? allLabels.length : undefined}
        >
          <p className="muted" style={{ marginBottom: "0.75rem" }}>
            Create labels to categorize articles during screening. Apply them from the
            Screening Workspace and explore them on the{" "}
            <Link to={`/projects/${id}/labels`} style={{ color: "#6366f1" }}>Labels page</Link>.
          </p>
          {id && <LabelManager projectId={id} />}
        </CollapsibleSection>

        {/* ── Screening Criteria ───────────────────────────────────────────── */}
        <CollapsibleSection
          id="criteria"
          title="Screening Criteria"
          subtitle="Inclusion / exclusion rules"
          defaultOpen={true}
          badge={
            (localCriteria.inclusion.length + localCriteria.exclusion.length) > 0
              ? localCriteria.inclusion.length + localCriteria.exclusion.length
              : undefined
          }
        >
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "1rem" }}>
            <p className="muted" style={{ margin: 0 }}>
              Define inclusion and exclusion criteria for this systematic review. These will
              be visible as a reference panel during screening.
            </p>
            <button
              onClick={() => setShowAiDraftPanel(v => !v)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, marginLeft: "1rem",
                padding: "0.28rem 0.65rem", borderRadius: "0.375rem", border: "none",
                background: showAiDraftPanel ? "#ede9fe" : "linear-gradient(135deg,#6366f1,#8b5cf6)",
                color: showAiDraftPanel ? "#6d28d9" : "#fff", fontSize: "0.78rem", fontWeight: 600, cursor: "pointer",
              }}
            >✦ Draft with AI</button>
          </div>
          {showAiDraftPanel && (
            <div style={{ padding: "0.85rem 1rem", background: "#faf5ff", borderRadius: "0.4rem", border: "1px solid #ede9fe", marginBottom: "1rem" }}>
              <div style={{ fontWeight: 700, fontSize: "0.83rem", color: "#6d28d9", marginBottom: "0.5rem" }}>✦ Draft Criteria with AI</div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}>
                <div>
                  <label style={{ fontSize: "0.72rem", fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 2 }}>Model</label>
                  <select value={aiDraftModel} onChange={e => setAiDraftModel(e.target.value)}
                    style={{ fontSize: "0.78rem", padding: "0.25rem 0.4rem", borderRadius: "0.25rem", border: "1px solid #d1d5db" }}>
                    <option value="anthropic/claude-haiku-4-5">Claude Haiku (OpenRouter)</option>
                    <option value="anthropic/claude-sonnet-4-5">Claude Sonnet (OpenRouter)</option>
                  </select>
                </div>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <label style={{ fontSize: "0.72rem", fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 2 }}>Research question (optional)</label>
                  <input className="form-input" value={aiDraftQuestion} onChange={e => setAiDraftQuestion(e.target.value)}
                    placeholder="e.g. What interventions improve adherence to ART?" style={{ width: "100%", fontSize: "0.82rem" }} />
                </div>
                <button
                  disabled={draftSetupMut.isPending}
                  onClick={() => draftSetupMut.mutate()}
                  style={{ padding: "0.35rem 0.85rem", borderRadius: "0.375rem", border: "none", background: "#7c3aed", color: "#fff", fontSize: "0.82rem", fontWeight: 600, cursor: "pointer" }}
                >{draftSetupMut.isPending ? "Thinking…" : "Generate Draft"}</button>
              </div>
              {draftSetupMut.isError && <p style={{ color: "#c5221f", fontSize: "0.78rem", marginTop: "0.35rem" }}>Failed — check your API key in LLM Screening settings.</p>}
              <p style={{ color: "#6b7280", fontSize: "0.75rem", marginTop: "0.35rem", margin: "0.35rem 0 0" }}>
                AI will draft criteria based on the project name and research question. Review and save after applying.
              </p>
            </div>
          )}
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
        </CollapsibleSection>

        {/* ── Extraction Template ──────────────────────────────────────────── */}
        <CollapsibleSection
          id="extraction-template"
          title="Data Extraction Template"
          subtitle="Structured fields for evidence capture"
          defaultOpen={true}
          badge={templateRows.length > 0 ? templateRows.length : undefined}
        >
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
                            const color = node.color ?? (node.namespace === "relationship" ? "#7c3aed" : "#3b82f6");
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
                      id: genId(),
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
                      toast(`${parsed.length} row${parsed.length > 1 ? "s" : ""} imported from table.`, "success");
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
                          toast(`${parsed.length} row${parsed.length > 1 ? "s" : ""} imported.`, "success");
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
        </CollapsibleSection>

        {/* ── Concept Extraction Template ───────────────────────────────────── */}
        <CollapsibleSection
          id="concept-template"
          title="Concept Extraction Template"
          subtitle="Define entities, relations, and other concept fields to extract from included papers"
          defaultOpen={false}
          badge={conceptFields.length > 0 ? conceptFields.length : undefined}
        >
          <p className="muted" style={{ marginBottom: "1rem" }}>
            Define the concept fields to extract from each included paper. Fields tagged as{" "}
            <strong>Entity</strong> will populate the entity taxonomy; fields tagged as{" "}
            <strong>Relation</strong> will populate the relation taxonomy. Both can then be pushed
            to the Ontology. This form appears in the screening workspace after data extraction.
          </p>

          <div style={{ border: "1px solid #dadce0", borderRadius: "0.5rem", background: "#fafafa", overflow: "hidden" }}>
            {/* Table header */}
            {conceptFields.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 140px 130px 1fr 32px", gap: "0.5rem", padding: "0.5rem 0.6rem 0.5rem 1rem", background: "#f1f3f4", borderBottom: "1px solid #dadce0", fontSize: "0.75rem", fontWeight: 700, color: "#5f6368", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                <span>Field Label</span>
                <span>Field Type</span>
                <span>Input Type</span>
                <span>Options (for selects)</span>
                <span />
              </div>
            )}

            {/* Rows */}
            <div style={{ padding: conceptFields.length > 0 ? "0.5rem 1rem" : "0" }}>
              {conceptFields.map((field, idx) => {
                const isSelect = field.input_type === "single_select" || field.input_type === "multi_select";
                const fieldTypeColor = field.field_type === "entity" ? "#4f46e5" : field.field_type === "relation" ? "#0891b2" : "#6b7280";

                return (
                  <div key={field.id} style={{ marginBottom: "0.6rem", border: "1px solid #e8eaed", borderRadius: "0.375rem", background: "#fff", overflow: "hidden" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 140px 130px 1fr 32px", gap: "0.5rem", alignItems: "center", padding: "0.4rem 0.6rem" }}>
                      <input
                        type="text"
                        className="input"
                        placeholder="e.g. Entity Name…"
                        value={field.label}
                        onChange={(e) => setConceptFields((prev) => prev.map((f, i) => i === idx ? { ...f, label: e.target.value } : f))}
                        style={{ fontSize: "0.84rem" }}
                      />
                      <select
                        value={field.field_type}
                        onChange={(e) => setConceptFields((prev) => prev.map((f, i) => i === idx ? { ...f, field_type: e.target.value as ConceptFieldType } : f))}
                        style={{ fontSize: "0.84rem", padding: "0.3rem 0.45rem", border: `1px solid ${fieldTypeColor}`, borderRadius: "0.25rem", background: "#fff", color: fieldTypeColor, fontWeight: 600 }}
                      >
                        <option value="entity">Entity</option>
                        <option value="relation">Relation</option>
                        <option value="metadata">Metadata</option>
                      </select>
                      <select
                        value={field.input_type}
                        onChange={(e) => setConceptFields((prev) => prev.map((f, i) => i === idx ? { ...f, input_type: e.target.value as ConceptInputType } : f))}
                        style={{ fontSize: "0.84rem", padding: "0.3rem 0.45rem", border: "1px solid #dadce0", borderRadius: "0.25rem", background: "#fff" }}
                      >
                        <option value="string">Free text</option>
                        <option value="single_select">Single select</option>
                        <option value="multi_select">Multi select</option>
                      </select>
                      <input
                        type="text"
                        className="input"
                        placeholder={isSelect ? "opt1, opt2…" : "—"}
                        disabled={!isSelect}
                        value={field.options.join(", ")}
                        onChange={(e) => setConceptFields((prev) => prev.map((f, i) => i === idx ? { ...f, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : f))}
                        style={{ fontSize: "0.84rem", background: !isSelect ? "#f3f4f6" : "#fff", color: !isSelect ? "#aaa" : undefined }}
                      />
                      <button
                        type="button"
                        onClick={() => setConceptFields((prev) => prev.filter((_, i) => i !== idx))}
                        title="Remove field"
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#c5221f", fontSize: "1rem", lineHeight: 1, padding: "0.2rem" }}
                      >×</button>
                    </div>
                    {/* Extra options */}
                    <div style={{ display: "flex", alignItems: "center", gap: "1rem", padding: "0.25rem 0.6rem 0.35rem", borderTop: "1px solid #f1f3f4", background: "#fafafa" }}>
                      {isSelect && (
                        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.76rem", color: "#5f6368", cursor: "pointer", userSelect: "none" }}>
                          <input
                            type="checkbox"
                            checked={field.allow_custom_options ?? false}
                            onChange={(e) => setConceptFields((prev) => prev.map((f, i) => i === idx ? { ...f, allow_custom_options: e.target.checked } : f))}
                            style={{ accentColor: "#4f46e5" }}
                          />
                          Allow reviewers to add custom options
                        </label>
                      )}
                      <input
                        type="text"
                        className="input"
                        placeholder="Placeholder hint…"
                        value={field.placeholder ?? ""}
                        onChange={(e) => setConceptFields((prev) => prev.map((f, i) => i === idx ? { ...f, placeholder: e.target.value } : f))}
                        style={{ fontSize: "0.78rem", maxWidth: 200 }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer actions */}
            <div style={{ padding: "0.75rem 1rem", borderTop: conceptFields.length > 0 ? "1px solid #e8eaed" : undefined, display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              {/* Quick-add entity / relation buttons */}
              <button
                type="button"
                className="btn-secondary"
                style={{ fontSize: "0.82rem" }}
                onClick={() => setConceptFields((prev) => [...prev, { id: genId(), label: "", field_type: "entity", input_type: "string", options: [], allow_custom_options: false }])}
              >
                + Entity field
              </button>
              <button
                type="button"
                className="btn-secondary"
                style={{ fontSize: "0.82rem" }}
                onClick={() => setConceptFields((prev) => [...prev, { id: genId(), label: "", field_type: "relation", input_type: "string", options: [], allow_custom_options: false }])}
              >
                + Relation field
              </button>
              <button
                type="button"
                className="btn-secondary"
                style={{ fontSize: "0.82rem" }}
                onClick={() => setConceptFields((prev) => [...prev, { id: genId(), label: "", field_type: "metadata", input_type: "string", options: [], allow_custom_options: false }])}
              >
                + Other field
              </button>

              {/* Preset for ontology construction */}
              {conceptFields.length === 0 && (
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ fontSize: "0.82rem", borderStyle: "dashed" }}
                  onClick={() => setConceptFields([
                    { id: genId(), label: "Entity Name", field_type: "entity", input_type: "string", options: [], allow_custom_options: false, placeholder: "e.g. COVID-19, mortality…" },
                    { id: genId(), label: "Entity Type", field_type: "entity", input_type: "single_select", options: ["Disease", "Phenotype", "Gene", "Drug", "Pathway", "Process", "Other"], allow_custom_options: true },
                    { id: genId(), label: "Relation Type", field_type: "relation", input_type: "single_select", options: ["causes", "associates_with", "inhibits", "activates", "part_of", "is_a", "other"], allow_custom_options: true },
                    { id: genId(), label: "Source Entity", field_type: "relation", input_type: "string", options: [], allow_custom_options: false, placeholder: "Entity at start of relation…" },
                    { id: genId(), label: "Target Entity", field_type: "relation", input_type: "string", options: [], allow_custom_options: false, placeholder: "Entity at end of relation…" },
                  ])}
                >
                  ✦ Load ontology preset
                </button>
              )}

              <div style={{ marginLeft: "auto" }}>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={conceptTemplateMutation.isPending}
                  onClick={() => conceptTemplateMutation.mutate({ fields: conceptFields, ai_instructions: conceptAiInstructions })}
                >
                  {conceptTemplateMutation.isPending ? "Saving…" : "Save template"}
                </button>
              </div>
            </div>

            {/* AI instructions */}
            <div style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: "0.85rem" }}>
              <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: "0.3rem" }}>
                AI extraction instructions <span style={{ fontWeight: 400 }}>(optional — appended to the system prompt sent to the AI)</span>
              </label>
              <textarea
                className="form-input"
                rows={3}
                placeholder={"e.g. Focus on explicitly stated findings only. Use verbatim language from the paper. If a field is not mentioned, leave it empty."}
                value={conceptAiInstructions}
                onChange={(e) => setConceptAiInstructions(e.target.value)}
                style={{ width: "100%", fontFamily: "inherit", fontSize: "0.84rem", resize: "vertical" }}
              />
            </div>
          </div>
        </CollapsibleSection>

        {/* ── Sources (Corpora) ─────────────────────────────────────────────── */}
        <CollapsibleSection
          id="sources"
          title="Corpora"
          subtitle="Imported databases"
          defaultOpen={true}
          badge={sources?.length}
        >
          <p className="muted" style={{ marginBottom: "0.85rem" }}>
            Each imported file is tagged to a corpus (e.g. PubMed, Scopus, Embase).
            Deleting a corpus permanently removes it and any records that belong
            exclusively to it.
          </p>
          {sources && sources.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginBottom: "1rem" }}>
              {sources.map((s) => (
                <div
                  key={s.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    background: "#f9fafb",
                    border: "1px solid #e5e7eb",
                    borderRadius: "0.5rem",
                    padding: "0.45rem 0.75rem",
                    maxWidth: 480,
                  }}
                >
                  <Link
                    to={`/projects/${id}/records?source_id=${s.id}`}
                    style={{ flex: 1, fontWeight: 500, fontSize: "0.875rem", color: "#374151", textDecoration: "none" }}
                  >
                    {s.name}
                  </Link>
                  {confirmDeleteSourceId === s.id ? (
                    <span style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
                      <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>Delete all its records?</span>
                      <button
                        className="btn-danger btn-sm"
                        onClick={() => { deleteSource.mutate(s.id); setConfirmDeleteSourceId(null); }}
                        disabled={deleteSource.isPending}
                      >
                        Delete
                      </button>
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => setConfirmDeleteSourceId(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      className="btn-ghost btn-sm"
                      style={{ color: "#d93025", opacity: 0.6 }}
                      onClick={() => setConfirmDeleteSourceId(s.id)}
                      title="Delete corpus"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <form
            onSubmit={handleAddSource}
            style={{ display: "flex", gap: "0.5rem", maxWidth: 400 }}
          >
            <input
              type="text"
              className="input"
              placeholder="New corpus name (e.g. PubMed 2024)…"
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
        </CollapsibleSection>

        {/* ── Overlap Resolution ───────────────────────────────────────────── */}
        <CollapsibleSection
          id="overlap"
          title="Overlap Resolution"
          subtitle="Deduplication strategy"
          defaultOpen={false}
          badge={activeStrategy?.name}
        >
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
        </CollapsibleSection>

        {/* ── Import history ───────────────────────────────────────────────── */}
        <CollapsibleSection
          id="import-history"
          title="Import History"
          subtitle="File-by-file log"
          defaultOpen={false}
          badge={jobs?.length}
        >
          {!jobs || jobs.length === 0 ? (
            <p className="muted">No imports yet. Upload a RIS or MEDLINE file to get started.</p>
          ) : (
            <table className="import-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Corpus</th>
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
        </CollapsibleSection>

        {/* ── Sub-projects ─────────────────────────────────────────────────── */}
        {!project?.parent_project_id && (
          <CollapsibleSection
            id="sub-projects"
            title="Sub-projects"
            badge={project?.sub_projects.length ?? 0}
            defaultOpen={false}
          >
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>
              A sub-project samples a fixed number of articles per corpus from this project.
              It is a fully independent project — you can screen, extract, and collaborate in it
              just like any other project. Sub-projects are useful for reliability studies,
              pilot screening, and expert-validation workflows.
            </p>

            {(project?.my_role === "owner" || project?.my_role === "admin") && (
              <button
                className="btn-primary btn-sm"
                style={{ marginBottom: 16 }}
                onClick={() => setShowSubProjectModal(true)}
              >
                + Create sub-project
              </button>
            )}

            {project?.sub_projects && project.sub_projects.length > 0 ? (
              <table className="table" style={{ fontSize: 13 }}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Records</th>
                    <th>Seed</th>
                    <th>Per corpus</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {project.sub_projects.map((sp) => (
                    <tr key={sp.id}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {sp.name}
                          {sp.shared_with_team && (
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 99, background: "#e0e7ff", color: "#4338ca", letterSpacing: "0.03em" }}>
                              SHARED
                            </span>
                          )}
                        </div>
                      </td>
                      <td>{sp.record_count.toLocaleString()}</td>
                      <td style={{ fontFamily: "monospace" }}>{sp.seed ?? "—"}</td>
                      <td>{sp.n_per_corpus ?? "—"}</td>
                      <td>{new Date(sp.created_at).toLocaleDateString()}</td>
                      <td style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <Link to={`/projects/${sp.id}`} className="btn-secondary btn-sm">
                          Open →
                        </Link>
                        {(project.my_role === "owner" || project.my_role === "admin") && (
                          <>
                            <button
                              className="btn-ghost btn-sm"
                              title={sp.shared_with_team ? "Unshare from team" : "Share with team"}
                              onClick={() => toggleSharedWithTeam(sp.id, sp.shared_with_team)}
                              style={{ color: sp.shared_with_team ? "#4338ca" : "var(--text-muted)", padding: "3px 6px" }}
                            >
                              <Users size={14} />
                            </button>
                            <button
                              className="btn-ghost btn-sm"
                              title="Delete sub-project"
                              onClick={() => setConfirmDeleteSubProject({ id: sp.id, name: sp.name })}
                              style={{ color: "#dc2626", padding: "3px 6px" }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
                No sub-projects yet.
              </p>
            )}
          </CollapsibleSection>
        )}

        {/* ── Sub-project modal ─────────────────────────────────────────────── */}
        {showSubProjectModal && project && id && (
          <CreateSubProjectModal
            parentProjectId={id}
            parentProjectName={project.name}
            hasExtractionTemplate={!!project.extraction_template}
            hasConceptTemplate={!!project.concept_template}
            onClose={() => setShowSubProjectModal(false)}
          />
        )}

        {/* ── Delete sub-project confirm dialog ───────────────────────────────── */}
        {confirmDeleteSubProject && (
          <div className="modal-backdrop" onClick={() => setConfirmDeleteSubProject(null)}>
            <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2 className="modal-title">Delete sub-project?</h2>
                <button className="btn-ghost" onClick={() => setConfirmDeleteSubProject(null)}>✕</button>
              </div>
              <p style={{ fontSize: 13, marginBottom: 20 }}>
                <strong>{confirmDeleteSubProject.name}</strong> and all its screening decisions,
                extractions, and labels will be permanently deleted. This cannot be undone.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn-secondary" onClick={() => setConfirmDeleteSubProject(null)}>
                  Cancel
                </button>
                <button
                  className="btn-primary"
                  style={{ background: "#dc2626", borderColor: "#dc2626" }}
                  disabled={deleteSubProject.isPending}
                  onClick={() => deleteSubProject.mutate(confirmDeleteSubProject.id)}
                >
                  {deleteSubProject.isPending ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
