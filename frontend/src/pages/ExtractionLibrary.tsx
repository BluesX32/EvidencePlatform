import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { extractionLibraryApi, projectsApi, screeningApi } from "../api/client";
import type {
  ExtractionLibraryItem,
  ExtractionJson,
  ExtractionTemplateRow,
  ScreeningNextItem,
} from "../api/client";
import { PDFFetchButton } from "../components/PDFFetchButton";
import { PDFViewerPanel } from "../components/PDFViewerPanel";
import { PDFUploadPanel } from "../components/PDFUploadPanel";

// ---------------------------------------------------------------------------
// Constants (same vocabulary as ScreeningWorkspace)
// ---------------------------------------------------------------------------

const LEVELS = [
  "gene", "molecular", "cellular", "tissue/organ",
  "patient/clinical", "population", "societal",
];

const DIMENSIONS = ["objective", "subjective", "societal"];

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function Chip({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color: "blue" | "purple" | "green";
  onClick?: () => void;
}) {
  const colors = {
    blue:   { border: active ? "#1a73e8" : "#dadce0", bg: active ? "#e8f0fe" : "#f8f9fa", text: active ? "#1a73e8" : "#5f6368" },
    purple: { border: active ? "#7c4dff" : "#dadce0", bg: active ? "#ede7f6" : "#f8f9fa", text: active ? "#7c4dff" : "#5f6368" },
    green:  { border: active ? "#188038" : "#dadce0", bg: active ? "#e6f4ea" : "#f8f9fa", text: active ? "#188038" : "#5f6368" },
  }[color];
  return (
    <span
      onClick={onClick}
      style={{
        display: "inline-block",
        padding: "0.15rem 0.55rem",
        borderRadius: "1rem",
        border: `1.5px solid ${colors.border}`,
        background: colors.bg,
        color: colors.text,
        fontSize: "0.75rem",
        fontWeight: active ? 600 : 400,
        cursor: onClick ? "pointer" : "default",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function FilterRow({
  label,
  values,
  active,
  color,
  onToggle,
}: {
  label: string;
  values: string[];
  active: Set<string>;
  color: "blue" | "purple";
  onToggle: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontSize: "0.8rem", color: "#5f6368", minWidth: 70 }}>{label}:</span>
      {values.map((v) => (
        <Chip
          key={v}
          label={v}
          active={active.has(v)}
          color={color}
          onClick={() => onToggle(v)}
        />
      ))}
      {active.size > 0 && (
        <button
          onClick={() => active.forEach((v) => onToggle(v))}
          style={{
            background: "none", border: "none", cursor: "pointer",
            fontSize: "0.75rem", color: "#c5221f", padding: "0 0.25rem",
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Template table: read-only preview (summary row)
// ---------------------------------------------------------------------------

function TablePreview({
  table,
  rows,
}: {
  table: Record<string, string | string[]>;
  rows: ExtractionTemplateRow[];
}) {
  const filled = rows.filter((r) => {
    const v = table[r.id];
    return Array.isArray(v) ? v.length > 0 : !!(v ?? "").trim();
  });
  if (rows.length === 0) return <span style={{ fontSize: "0.75rem", color: "#aaa" }}>—</span>;
  return (
    <span style={{ fontSize: "0.75rem", color: filled.length === rows.length ? "#188038" : "#5f6368" }}>
      {filled.length}/{rows.length} fields
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline edit panel
// ---------------------------------------------------------------------------

function EditPanel({
  item,
  projectId,
  templateRows,
  onClose,
}: {
  item: ExtractionLibraryItem;
  projectId: string;
  templateRows: ExtractionTemplateRow[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [pdfOpen, setPdfOpen] = useState(false);

  // Build a minimal ScreeningNextItem-compatible object for PDF components
  const pdfItem: ScreeningNextItem = {
    done: false,
    record_id: item.record_id ?? null,
    cluster_id: item.cluster_id ?? null,
  };

  // Template table state
  const [editTable, setEditTable] = useState<Record<string, string | string[]>>(
    item.extracted_json.table ?? {}
  );

  // Legacy metadata
  const [editLevels, setEditLevels] = useState<string[]>(item.extracted_json.levels ?? []);
  const [editDims, setEditDims] = useState<string[]>(item.extracted_json.dimensions ?? []);
  const [editNote, setEditNote] = useState<string>(item.extracted_json.free_note ?? "");
  const [editFrameworkUpdated, setEditFrameworkUpdated] = useState<boolean>(
    item.extracted_json.framework_updated ?? false
  );
  const [editFrameworkNote, setEditFrameworkNote] = useState<string>(
    item.extracted_json.framework_update_note ?? ""
  );

  // ── Table cell helpers ───────────────────────────────────────────────────

  function strVal(rowId: string): string {
    const v = editTable[rowId];
    return typeof v === "string" ? v : (Array.isArray(v) ? v.join("; ") : "");
  }
  function arrVal(rowId: string): string[] {
    const v = editTable[rowId];
    return Array.isArray(v) ? v : (v ? [v] : []);
  }
  function setStr(rowId: string, val: string) {
    setEditTable((prev) => ({ ...prev, [rowId]: val }));
  }
  function toggleMulti(rowId: string, option: string) {
    setEditTable((prev) => {
      const cur = Array.isArray(prev[rowId]) ? (prev[rowId] as string[]) : [];
      return {
        ...prev,
        [rowId]: cur.includes(option) ? cur.filter((x) => x !== option) : [...cur, option],
      };
    });
  }

  // ── Group rows by domain ────────────────────────────────────────────────

  const domains: string[] = [];
  const byDomain: Record<string, ExtractionTemplateRow[]> = {};
  for (const row of templateRows) {
    if (!byDomain[row.domain]) {
      domains.push(row.domain);
      byDomain[row.domain] = [];
    }
    byDomain[row.domain].push(row);
  }

  // ── Save ────────────────────────────────────────────────────────────────

  const saveMutation = useMutation({
    mutationFn: () => {
      const updatedJson: ExtractionJson = {
        ...item.extracted_json,
        table: editTable,
        levels: editLevels,
        dimensions: editDims,
        free_note: editNote,
        framework_updated: editFrameworkUpdated,
        framework_update_note: editFrameworkNote,
      };
      return screeningApi.submitExtraction(projectId, {
        record_id: item.record_id ?? undefined,
        cluster_id: item.cluster_id ?? undefined,
        extracted_json: updatedJson,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["extractions-library", projectId] });
      onClose();
    },
  });

  const sectionHead: React.CSSProperties = {
    fontSize: "0.8rem", fontWeight: 700, color: "#3c4043",
    marginBottom: "0.5rem", marginTop: "1.25rem",
    textTransform: "uppercase", letterSpacing: "0.04em",
  };
  const fieldLabel: React.CSSProperties = {
    fontSize: "0.78rem", fontWeight: 600, color: "#5f6368",
    marginBottom: "0.25rem",
  };

  return (
    <div style={{ background: "#f8f9fa", borderTop: "2px solid #4f46e5", padding: "1.25rem 1.5rem" }}>

      {/* ── PDF controls ──────────────────────────────────────────────── */}
      <div style={{ marginBottom: "1rem" }}>
        <PDFFetchButton projectId={projectId} item={pdfItem} />
        <PDFUploadPanel projectId={projectId} item={pdfItem} />
        <div style={{ marginTop: "0.4rem" }}>
          <button
            onClick={() => setPdfOpen((v) => !v)}
            style={{
              fontSize: "0.75rem", fontWeight: 600,
              padding: "0.18rem 0.65rem", borderRadius: "1rem",
              border: "1px solid #c7d7fd",
              background: pdfOpen ? "#4f46e5" : "#fff",
              color: pdfOpen ? "#fff" : "#1558d6",
              cursor: "pointer",
            }}
          >
            📄 {pdfOpen ? "Hide PDF" : "View PDF"}
          </button>
        </div>
        {pdfOpen && (
          <PDFViewerPanel projectId={projectId} item={pdfItem} onClose={() => setPdfOpen(false)} />
        )}
      </div>

      {/* ── Extraction template table ──────────────────────────────────── */}
      {templateRows.length > 0 && (
        <>
          <div style={sectionHead}>Extraction Table</div>
          {domains.map((domain) => (
            <div key={domain} style={{ marginBottom: "1rem" }}>
              {/* Domain header */}
              <div style={{
                fontSize: "0.72rem", fontWeight: 700, color: "#fff",
                background: "#6b7280", padding: "0.2rem 0.6rem",
                borderRadius: "0.25rem 0.25rem 0 0", display: "inline-block",
                marginBottom: "0.5rem",
              }}>
                {domain}
              </div>
              <div style={{
                border: "1px solid #dadce0", borderRadius: "0 0.375rem 0.375rem 0.375rem",
                overflow: "hidden",
              }}>
                {byDomain[domain].map((row, idx) => (
                  <div
                    key={row.id}
                    style={{
                      display: "grid", gridTemplateColumns: "200px 1fr",
                      borderBottom: idx < byDomain[domain].length - 1 ? "1px solid #f0f0f0" : "none",
                      background: "#fff",
                    }}
                  >
                    {/* Item label */}
                    <div style={{
                      padding: "0.6rem 0.75rem",
                      borderRight: "1px solid #f0f0f0",
                      fontSize: "0.8rem", fontWeight: 500, color: "#374151",
                      background: "#fafafa",
                    }}>
                      {row.item}
                    </div>

                    {/* Editable cell */}
                    <div style={{ padding: "0.5rem 0.75rem" }}>
                      {row.type === "string" && (
                        <textarea
                          value={strVal(row.id)}
                          onChange={(e) => setStr(row.id, e.target.value)}
                          rows={2}
                          style={{
                            width: "100%", boxSizing: "border-box",
                            border: "1px solid #dadce0", borderRadius: "0.25rem",
                            padding: "0.3rem 0.5rem", fontSize: "0.83rem",
                            fontFamily: "inherit", resize: "vertical",
                          }}
                        />
                      )}

                      {row.type === "single_select" && (
                        <select
                          value={strVal(row.id)}
                          onChange={(e) => setStr(row.id, e.target.value)}
                          style={{
                            border: "1px solid #dadce0", borderRadius: "0.25rem",
                            padding: "0.3rem 0.5rem", fontSize: "0.83rem",
                            background: "#fff", minWidth: 160,
                          }}
                        >
                          <option value="">— select —</option>
                          {row.options.map((o) => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                          {/* keep custom value if it's not in options */}
                          {strVal(row.id) && !row.options.includes(strVal(row.id)) && (
                            <option value={strVal(row.id)}>{strVal(row.id)}</option>
                          )}
                        </select>
                      )}

                      {row.type === "multi_select" && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
                          {row.options.map((o) => (
                            <Chip
                              key={o}
                              label={o}
                              active={arrVal(row.id).includes(o)}
                              color="green"
                              onClick={() => toggleMulti(row.id, o)}
                            />
                          ))}
                          {/* show any custom values not in options */}
                          {arrVal(row.id)
                            .filter((v) => !row.options.includes(v))
                            .map((v) => (
                              <Chip
                                key={v}
                                label={v}
                                active={true}
                                color="green"
                                onClick={() => toggleMulti(row.id, v)}
                              />
                            ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {/* ── Levels ────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: "0.75rem" }}>
        <div style={sectionHead}>Levels</div>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          {LEVELS.map((l) => (
            <Chip
              key={l} label={l}
              active={editLevels.includes(l)}
              color="blue"
              onClick={() =>
                setEditLevels((prev) =>
                  prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]
                )
              }
            />
          ))}
        </div>
      </div>

      {/* ── Dimensions ────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: "0.75rem" }}>
        <div style={sectionHead}>Dimensions</div>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          {DIMENSIONS.map((d) => (
            <Chip
              key={d} label={d}
              active={editDims.includes(d)}
              color="purple"
              onClick={() =>
                setEditDims((prev) =>
                  prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
                )
              }
            />
          ))}
        </div>
      </div>

      {/* ── Free note ─────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: "0.75rem" }}>
        <div style={sectionHead}>Notes</div>
        <textarea
          value={editNote}
          onChange={(e) => setEditNote(e.target.value)}
          rows={4}
          style={{
            width: "100%", boxSizing: "border-box",
            padding: "0.4rem 0.5rem",
            border: "1px solid #dadce0", borderRadius: "0.375rem",
            fontSize: "0.85rem", fontFamily: "inherit", resize: "vertical",
          }}
          placeholder="Free notes about this paper…"
        />
      </div>

      {/* ── Framework novelty ─────────────────────────────────────────────── */}
      <div style={{ marginBottom: "1rem" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontSize: "0.85rem" }}>
          <input
            type="checkbox"
            checked={editFrameworkUpdated}
            onChange={(e) => setEditFrameworkUpdated(e.target.checked)}
          />
          This paper introduced new framework concepts
        </label>
        {editFrameworkUpdated && (
          <textarea
            value={editFrameworkNote}
            onChange={(e) => setEditFrameworkNote(e.target.value)}
            rows={2}
            placeholder="Describe what was new…"
            style={{
              marginTop: "0.5rem", width: "100%", boxSizing: "border-box",
              padding: "0.4rem 0.5rem",
              border: "1px solid #dadce0", borderRadius: "0.375rem",
              fontSize: "0.83rem", fontFamily: "inherit", resize: "vertical",
            }}
          />
        )}
      </div>

      {/* ── Actions ───────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button
          className="btn-primary"
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
          style={{ fontSize: "0.85rem" }}
        >
          {saveMutation.isPending ? "Saving…" : "Save"}
        </button>
        <button
          className="btn-secondary"
          onClick={onClose}
          style={{ fontSize: "0.85rem" }}
        >
          Cancel
        </button>
        {saveMutation.isError && (
          <span style={{ color: "#c5221f", fontSize: "0.82rem" }}>
            Save failed — please retry.
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ExtractionLibrary() {
  const { id: projectId } = useParams<{ id: string }>();

  const [search, setSearch] = useState("");
  const [filterLevels, setFilterLevels] = useState<Set<string>>(new Set());
  const [filterDims, setFilterDims] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["extractions-library", projectId],
    queryFn: () => extractionLibraryApi.list(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  // Fetch template rows so EditPanel can render the table
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });
  const templateRows: ExtractionTemplateRow[] = project?.extraction_template?.rows ?? [];

  // ── Client-side filter ───────────────────────────────────────────────────
  const visible = items.filter((item) => {
    const text = [item.title ?? "", item.doi ?? "", ...(item.authors ?? [])]
      .join(" ")
      .toLowerCase();
    const matchSearch = !search || text.includes(search.toLowerCase());
    const levels = item.extracted_json.levels ?? [];
    const dims = item.extracted_json.dimensions ?? [];
    const matchLevels =
      filterLevels.size === 0 || [...filterLevels].every((l) => levels.includes(l));
    const matchDims =
      filterDims.size === 0 || [...filterDims].every((d) => dims.includes(d));
    return matchSearch && matchLevels && matchDims;
  });

  function toggleFilter(
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    v: string,
  ) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────

  // Grid columns: Title | Year | Sources | Table | Levels | Dims | Notes
  const COLS = templateRows.length > 0
    ? "1fr 52px 110px 80px 140px 110px 28px"
    : "1fr 52px 110px 140px 110px 28px";

  return (
    <div className="page">
      <header className="page-header">
        <Link to={`/projects/${projectId}`} className="back-link">
          ← Project
        </Link>
        <span style={{ color: "#5f6368", fontSize: "0.9rem", marginLeft: "1rem" }}>
          Extraction Library
        </span>
      </header>

      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", marginBottom: "1.25rem" }}>
          <h2 style={{ margin: 0 }}>Extraction Library</h2>
          {!isLoading && (
            <span style={{ color: "#5f6368", fontSize: "0.88rem" }}>
              {items.length} article{items.length !== 1 ? "s" : ""} extracted
              {visible.length !== items.length && ` · ${visible.length} shown`}
            </span>
          )}
        </div>

        {/* ── Filters ─────────────────────────────────────────────────────── */}
        <div
          style={{
            background: "#f8f9fa", border: "1px solid #dadce0",
            borderRadius: "0.5rem", padding: "0.9rem 1rem",
            marginBottom: "1.25rem", display: "flex",
            flexDirection: "column", gap: "0.6rem",
          }}
        >
          <input
            type="search"
            className="input"
            placeholder="Search title, authors, DOI…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 400, fontSize: "0.88rem" }}
          />
          <FilterRow
            label="Levels"
            values={LEVELS}
            active={filterLevels}
            color="blue"
            onToggle={(v) => toggleFilter(setFilterLevels, v)}
          />
          <FilterRow
            label="Dimensions"
            values={DIMENSIONS}
            active={filterDims}
            color="purple"
            onToggle={(v) => toggleFilter(setFilterDims, v)}
          />
        </div>

        {/* ── Table ───────────────────────────────────────────────────────── */}
        {isLoading ? (
          <p style={{ color: "#888" }}>Loading…</p>
        ) : items.length === 0 ? (
          <div
            style={{
              textAlign: "center", padding: "3rem 2rem",
              background: "#f8f9fa", border: "1px solid #dadce0",
              borderRadius: "0.75rem", color: "#5f6368",
            }}
          >
            <p style={{ marginBottom: "1rem" }}>No extractions yet.</p>
            <Link to={`/projects/${projectId}`} className="btn-secondary">
              ← Back to project
            </Link>
          </div>
        ) : visible.length === 0 ? (
          <p style={{ color: "#5f6368" }}>No articles match the current filters.</p>
        ) : (
          <div style={{ border: "1px solid #dadce0", borderRadius: "0.5rem", overflow: "hidden" }}>
            {/* Header row */}
            <div
              style={{
                display: "grid", gridTemplateColumns: COLS,
                gap: "0.5rem", padding: "0.5rem 1rem",
                background: "#f1f3f4", borderBottom: "1px solid #dadce0",
                fontSize: "0.78rem", fontWeight: 600, color: "#5f6368",
                textTransform: "uppercase", letterSpacing: "0.03em",
              }}
            >
              <span>Title</span>
              <span>Year</span>
              <span>Sources</span>
              {templateRows.length > 0 && <span>Table</span>}
              <span>Levels</span>
              <span>Dimensions</span>
              <span></span>
            </div>

            {visible.map((item) => {
              const isExpanded = expandedId === item.id;
              const levels = item.extracted_json.levels ?? [];
              const dims = item.extracted_json.dimensions ?? [];
              const hasNote = !!(item.extracted_json.free_note ?? "").trim();

              return (
                <div key={item.id} style={{ borderBottom: "1px solid #ececec" }}>
                  {/* Main row */}
                  <div
                    onClick={() => setExpandedId((prev) => (prev === item.id ? null : item.id))}
                    style={{
                      display: "grid", gridTemplateColumns: COLS,
                      gap: "0.5rem", padding: "0.65rem 1rem",
                      cursor: "pointer",
                      background: isExpanded ? "#eef3ff" : "transparent",
                      transition: "background 0.1s", alignItems: "start",
                    }}
                    onMouseEnter={(e) => {
                      if (!isExpanded) (e.currentTarget as HTMLElement).style.background = "#f8f9fa";
                    }}
                    onMouseLeave={(e) => {
                      if (!isExpanded) (e.currentTarget as HTMLElement).style.background = "transparent";
                    }}
                  >
                    {/* Title + authors */}
                    <div>
                      <div style={{ fontSize: "0.88rem", fontWeight: 500, color: "#202124", lineHeight: 1.35, marginBottom: "0.15rem" }}>
                        {item.title ?? <em style={{ color: "#888" }}>Untitled</em>}
                      </div>
                      {item.authors.length > 0 && (
                        <div style={{ fontSize: "0.75rem", color: "#5f6368" }}>
                          {item.authors.slice(0, 3).join(", ")}
                          {item.authors.length > 3 && " et al."}
                        </div>
                      )}
                    </div>

                    {/* Year */}
                    <div style={{ fontSize: "0.85rem", color: "#5f6368", paddingTop: "0.1rem" }}>
                      {item.year ?? "—"}
                    </div>

                    {/* Sources */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                      {item.source_names.length > 0
                        ? item.source_names.map((s) => (
                            <span key={s} style={{ fontSize: "0.72rem", background: "#f1f3f4", border: "1px solid #dadce0", borderRadius: "0.25rem", padding: "0.1rem 0.35rem", color: "#3c4043" }}>
                              {s}
                            </span>
                          ))
                        : <span style={{ fontSize: "0.75rem", color: "#aaa" }}>—</span>}
                    </div>

                    {/* Table fill indicator */}
                    {templateRows.length > 0 && (
                      <div style={{ paddingTop: "0.1rem" }}>
                        <TablePreview table={item.extracted_json.table ?? {}} rows={templateRows} />
                      </div>
                    )}

                    {/* Levels chips */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                      {levels.length > 0
                        ? levels.map((l) => <Chip key={l} label={l} active={true} color="blue" />)
                        : <span style={{ fontSize: "0.75rem", color: "#aaa" }}>—</span>}
                    </div>

                    {/* Dimensions chips */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                      {dims.length > 0
                        ? dims.map((d) => <Chip key={d} label={d} active={true} color="purple" />)
                        : <span style={{ fontSize: "0.75rem", color: "#aaa" }}>—</span>}
                    </div>

                    {/* Notes indicator */}
                    <div style={{ fontSize: "0.85rem", textAlign: "center", paddingTop: "0.1rem" }}>
                      {hasNote
                        ? <span title="Has notes" style={{ color: "#1a73e8" }}>📝</span>
                        : <span style={{ color: "#dadce0" }}>·</span>}
                    </div>
                  </div>

                  {/* Expanded edit panel */}
                  {isExpanded && projectId && (
                    <EditPanel
                      item={item}
                      projectId={projectId}
                      templateRows={templateRows}
                      onClose={() => setExpandedId(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
