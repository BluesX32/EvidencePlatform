import React, { useState, useEffect, useRef, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { extractionLibraryApi, projectsApi, screeningApi, conceptExtractionApi, teamApi } from "../api/client";
import type {
  ExtractionLibraryItem,
  ExtractionJson,
  ExtractionTemplateRow,
  ScreeningNextItem,
  ConceptTemplate,
  ConceptExtractionRecord,
  TeamMember,
} from "../api/client";
import { PDFFetchButton } from "../components/PDFFetchButton";
import { PDFViewerPanel } from "../components/PDFViewerPanel";
import { PDFUploadPanel } from "../components/PDFUploadPanel";
import ConceptExtractionForm from "../components/ConceptExtractionForm";

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

function ConceptPreview({ ce, template }: { ce: ConceptExtractionRecord | undefined; template: ConceptTemplate | null }) {
  if (!template || template.fields.length === 0) return <span style={{ fontSize: "0.75rem", color: "#aaa" }}>—</span>;
  if (!ce) return <span style={{ fontSize: "0.75rem", color: "#aaa" }}>—</span>;
  const cells = ce.extracted_json.cells ?? {};
  const filled = template.fields.filter((f) => {
    const v = cells[f.id];
    return Array.isArray(v) ? v.length > 0 : !!(v ?? "").trim();
  });
  return (
    <span style={{ fontSize: "0.75rem", color: filled.length === template.fields.length ? "#6d28d9" : "#5f6368" }}>
      {filled.length}/{template.fields.length}
    </span>
  );
}

function EditPanel({
  item,
  projectId,
  templateRows,
  conceptTemplate,
  allExtractions,
  onClose,
}: {
  item: ExtractionLibraryItem;
  projectId: string;
  templateRows: ExtractionTemplateRow[];
  conceptTemplate: ConceptTemplate | null;
  allExtractions: ConceptExtractionRecord[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [pdfOpen, setPdfOpen] = useState(false);
  const [confirmExclude, setConfirmExclude] = useState(false);
  const [excludeReason, setExcludeReason] = useState("");
  const [dataExpanded, setDataExpanded] = useState(true);
  const [conceptExpanded, setConceptExpanded] = useState(true);

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

  // Only true when a field was changed by the user (not on initial mount)
  const userEdited = useRef(false);

  // ── Table cell helpers ───────────────────────────────────────────────────

  // Per-row custom options added during this session (not persisted to template)
  const [customOpts, setCustomOpts] = useState<Record<string, string[]>>({});
  const [customInput, setCustomInput] = useState<Record<string, string>>({});

  function addCustomOption(rowId: string) {
    const val = (customInput[rowId] ?? "").trim();
    if (!val) return;
    setCustomOpts((prev) => ({ ...prev, [rowId]: [...(prev[rowId] ?? []), val] }));
    setCustomInput((prev) => ({ ...prev, [rowId]: "" }));
  }

  function strVal(rowId: string): string {
    const v = editTable[rowId];
    return typeof v === "string" ? v : (Array.isArray(v) ? v.join("; ") : "");
  }
  function arrVal(rowId: string): string[] {
    const v = editTable[rowId];
    return Array.isArray(v) ? v : (v ? [v] : []);
  }
  function setStr(rowId: string, val: string) {
    userEdited.current = true;
    setEditTable((prev) => ({ ...prev, [rowId]: val }));
  }
  function toggleMulti(rowId: string, option: string) {
    userEdited.current = true;
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

  // ── Auto-save ───────────────────────────────────────────────────────────

  const buildJson = (): ExtractionJson => ({
    ...item.extracted_json,
    table: editTable,
    levels: editLevels,
    dimensions: editDims,
    free_note: editNote,
    framework_updated: editFrameworkUpdated,
    framework_update_note: editFrameworkNote,
  });

  const autoSaveMut = useMutation({
    mutationFn: () =>
      screeningApi.submitExtraction(projectId, {
        record_id: item.record_id ?? undefined,
        cluster_id: item.cluster_id ?? undefined,
        extracted_json: buildJson(),
      }),
    onSuccess: () => {
      userEdited.current = false;
      queryClient.invalidateQueries({ queryKey: ["extractions-library", projectId] });
    },
  });

  // Debounced auto-save — fires 700 ms after the last user change
  useEffect(() => {
    if (!userEdited.current) return;
    const t = setTimeout(() => { autoSaveMut.mutate(); }, 700);
    return () => clearTimeout(t);
  }, [editTable, editLevels, editDims, editNote, editFrameworkUpdated, editFrameworkNote]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Close (explicit) ─────────────────────────────────────────────────────

  const saveMutation = useMutation({
    mutationFn: () =>
      screeningApi.submitExtraction(projectId, {
        record_id: item.record_id ?? undefined,
        cluster_id: item.cluster_id ?? undefined,
        extracted_json: buildJson(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["extractions-library", projectId] });
      onClose();
    },
  });

  const excludeMutation = useMutation({
    mutationFn: () =>
      screeningApi.submitDecision(projectId, {
        record_id: item.record_id ?? null,
        cluster_id: item.cluster_id ?? null,
        stage: "FT",
        decision: "exclude",
        notes: excludeReason.trim() || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["extractions-library", projectId] });
      onClose();
    },
  });

  const SH: React.CSSProperties = {
    fontSize: "0.72rem", fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.06em",
    marginBottom: "0.4rem", marginTop: "1rem",
  };

  const CollapseHeader = ({
    label, expanded, onToggle, extra,
  }: { label: string; expanded: boolean; onToggle: () => void; extra?: React.ReactNode }) => (
    <button
      type="button"
      onClick={onToggle}
      style={{
        display: "flex", alignItems: "center", gap: "0.5rem",
        width: "100%", background: "#f1f3f4", border: "none",
        borderRadius: expanded ? "0.4rem 0.4rem 0 0" : "0.4rem",
        padding: "0.45rem 0.75rem", cursor: "pointer",
        marginBottom: expanded ? 0 : "0.5rem",
      }}
    >
      <span style={{ fontSize: "0.7rem", color: "#6b7280" }}>{expanded ? "▾" : "▸"}</span>
      <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em", flex: 1, textAlign: "left" }}>
        {label}
      </span>
      {extra}
    </button>
  );

  // ── Data extraction section content ──────────────────────────────────────
  const dataContent = (
    <div style={{ border: "1px solid #e5e7eb", borderTop: "none", borderRadius: "0 0 0.4rem 0.4rem", padding: "0.85rem 1rem", background: "#fff", marginBottom: "0.75rem" }}>
      {/* Extraction table */}
      {templateRows.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <div style={SH}>Extraction Table</div>
          {domains.map((domain) => (
            <div key={domain} style={{ marginBottom: "0.75rem" }}>
              <div style={{
                fontSize: "0.68rem", fontWeight: 700, color: "#fff",
                background: "#6b7280", padding: "0.15rem 0.55rem",
                borderRadius: "0.2rem 0.2rem 0 0", display: "inline-block",
              }}>
                {domain}
              </div>
              <div style={{ border: "1px solid #e5e7eb", borderRadius: "0 0.3rem 0.3rem 0.3rem", overflow: "hidden" }}>
                {byDomain[domain].map((row, idx) => (
                  <div key={row.id} style={{
                    display: "grid", gridTemplateColumns: "180px 1fr",
                    borderBottom: idx < byDomain[domain].length - 1 ? "1px solid #f3f4f6" : "none",
                    background: "#fff",
                  }}>
                    <div style={{
                      padding: "0.5rem 0.65rem", borderRight: "1px solid #f3f4f6",
                      fontSize: "0.78rem", fontWeight: 500, color: "#374151",
                      background: "#f9fafb", display: "flex", alignItems: "flex-start",
                    }}>
                      {row.item}
                    </div>
                    <div style={{ padding: "0.45rem 0.65rem" }}>
                      {row.type === "string" && (
                        <textarea
                          value={strVal(row.id)}
                          onChange={(e) => setStr(row.id, e.target.value)}
                          rows={2}
                          style={{
                            width: "100%", boxSizing: "border-box",
                            border: "1px solid #e5e7eb", borderRadius: "0.25rem",
                            padding: "0.28rem 0.45rem", fontSize: "0.82rem",
                            fontFamily: "inherit", resize: "vertical", background: "#fafafa",
                          }}
                        />
                      )}
                      {row.type === "single_select" && (() => {
                        const allOpts = [...row.options, ...(customOpts[row.id] ?? [])];
                        return (
                          <div>
                            <select
                              value={strVal(row.id)}
                              onChange={(e) => setStr(row.id, e.target.value)}
                              style={{
                                border: "1px solid #e5e7eb", borderRadius: "0.25rem",
                                padding: "0.28rem 0.45rem", fontSize: "0.82rem",
                                background: "#fafafa", width: "100%",
                              }}
                            >
                              <option value="">— select —</option>
                              {allOpts.map((o) => <option key={o} value={o}>{o}</option>)}
                              {strVal(row.id) && !allOpts.includes(strVal(row.id)) && (
                                <option value={strVal(row.id)}>{strVal(row.id)}</option>
                              )}
                            </select>
                            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                              <input
                                value={customInput[row.id] ?? ""}
                                onChange={(e) => setCustomInput((p) => ({ ...p, [row.id]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === "Enter") addCustomOption(row.id); }}
                                placeholder="+ custom option…"
                                style={{ fontSize: "0.75rem", padding: "0.15rem 0.4rem", border: "1px dashed #d1d5db", borderRadius: "0.25rem", flex: 1, outline: "none" }}
                              />
                              <button type="button" onClick={() => addCustomOption(row.id)}
                                style={{ fontSize: "0.7rem", padding: "0.15rem 0.45rem", borderRadius: "0.2rem", border: "none", background: "#6366f1", color: "#fff", cursor: "pointer" }}>
                                Add
                              </button>
                            </div>
                          </div>
                        );
                      })()}
                      {row.type === "multi_select" && (() => {
                        const allOpts = [...row.options, ...(customOpts[row.id] ?? [])];
                        return (
                          <div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", marginBottom: "0.3rem" }}>
                              {allOpts.map((o) => (
                                <Chip key={o} label={o} active={arrVal(row.id).includes(o)} color="green" onClick={() => toggleMulti(row.id, o)} />
                              ))}
                              {arrVal(row.id).filter((v) => !allOpts.includes(v)).map((v) => (
                                <Chip key={v} label={v} active={true} color="green" onClick={() => toggleMulti(row.id, v)} />
                              ))}
                            </div>
                            <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                              <input
                                value={customInput[row.id] ?? ""}
                                onChange={(e) => setCustomInput((p) => ({ ...p, [row.id]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === "Enter") addCustomOption(row.id); }}
                                placeholder="+ custom option…"
                                style={{ fontSize: "0.75rem", padding: "0.15rem 0.4rem", border: "1px dashed #d1d5db", borderRadius: "0.25rem", flex: 1, outline: "none" }}
                              />
                              <button type="button" onClick={() => addCustomOption(row.id)}
                                style={{ fontSize: "0.7rem", padding: "0.15rem 0.45rem", borderRadius: "0.2rem", border: "none", background: "#6366f1", color: "#fff", cursor: "pointer" }}>
                                Add
                              </button>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Levels */}
      <div style={{ marginBottom: "0.65rem" }}>
        <div style={SH}>Levels</div>
        <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
          {LEVELS.map((l) => (
            <Chip key={l} label={l} active={editLevels.includes(l)} color="blue"
              onClick={() => { userEdited.current = true; setEditLevels((p) => p.includes(l) ? p.filter((x) => x !== l) : [...p, l]); }} />
          ))}
        </div>
      </div>

      {/* Dimensions */}
      <div style={{ marginBottom: "0.65rem" }}>
        <div style={SH}>Dimensions</div>
        <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
          {DIMENSIONS.map((d) => (
            <Chip key={d} label={d} active={editDims.includes(d)} color="purple"
              onClick={() => { userEdited.current = true; setEditDims((p) => p.includes(d) ? p.filter((x) => x !== d) : [...p, d]); }} />
          ))}
        </div>
      </div>

      {/* Notes */}
      <div style={{ marginBottom: "0.65rem" }}>
        <div style={SH}>Notes</div>
        <textarea
          value={editNote}
          onChange={(e) => { userEdited.current = true; setEditNote(e.target.value); }}
          rows={3}
          placeholder="Free notes about this paper…"
          style={{
            width: "100%", boxSizing: "border-box",
            padding: "0.35rem 0.45rem",
            border: "1px solid #e5e7eb", borderRadius: "0.3rem",
            fontSize: "0.83rem", fontFamily: "inherit", resize: "vertical", background: "#fafafa",
          }}
        />
      </div>

      {/* Framework novelty */}
      <div>
        <label style={{ display: "flex", alignItems: "center", gap: "0.45rem", cursor: "pointer", fontSize: "0.83rem", color: "#374151" }}>
          <input type="checkbox" checked={editFrameworkUpdated}
            onChange={(e) => { userEdited.current = true; setEditFrameworkUpdated(e.target.checked); }} />
          This paper introduced new framework concepts
        </label>
        {editFrameworkUpdated && (
          <textarea
            value={editFrameworkNote}
            onChange={(e) => { userEdited.current = true; setEditFrameworkNote(e.target.value); }}
            rows={2}
            placeholder="Describe what was new…"
            style={{
              marginTop: "0.4rem", width: "100%", boxSizing: "border-box",
              padding: "0.35rem 0.45rem",
              border: "1px solid #e5e7eb", borderRadius: "0.3rem",
              fontSize: "0.81rem", fontFamily: "inherit", resize: "vertical", background: "#fafafa",
            }}
          />
        )}
      </div>
    </div>
  );

  return (
    <div style={{ background: "#f8f9fa", borderTop: "2px solid #4f46e5", padding: "1rem 1.25rem 1.25rem" }}>

      {/* ── PDF controls ─────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem", paddingBottom: "0.75rem", borderBottom: "1px solid #e5e7eb" }}>
        <PDFFetchButton projectId={projectId} item={pdfItem} />
        <PDFUploadPanel projectId={projectId} item={pdfItem} />
        <button
          onClick={() => setPdfOpen((v) => !v)}
          style={{
            fontSize: "0.75rem", fontWeight: 600,
            padding: "0.2rem 0.65rem", borderRadius: "1rem",
            border: "1px solid #c7d7fd",
            background: pdfOpen ? "#4f46e5" : "#fff",
            color: pdfOpen ? "#fff" : "#1558d6",
            cursor: "pointer",
          }}
        >
          📄 {pdfOpen ? "Hide PDF" : "View PDF"}
        </button>
        {pdfOpen && (
          <PDFViewerPanel projectId={projectId} item={pdfItem} onClose={() => setPdfOpen(false)} />
        )}
      </div>

      {/* ── Data extraction (collapsible) ─────────────────────────────────── */}
      <CollapseHeader
        label="Data Extraction"
        expanded={dataExpanded}
        onToggle={() => setDataExpanded((v) => !v)}
        extra={
          <span style={{ fontSize: "0.68rem", color: autoSaveMut.isPending ? "#6b7280" : autoSaveMut.isError ? "#dc2626" : autoSaveMut.isSuccess ? "#16a34a" : "transparent" }}>
            {autoSaveMut.isPending ? "Saving…" : autoSaveMut.isError ? "Save failed" : autoSaveMut.isSuccess ? "Saved ✓" : "·"}
          </span>
        }
      />
      {dataExpanded && dataContent}

      {/* ── Concept extraction (collapsible) ──────────────────────────────── */}
      {conceptTemplate && conceptTemplate.fields.length > 0 && (
        <>
          <CollapseHeader
            label="Concept Extraction"
            expanded={conceptExpanded}
            onToggle={() => setConceptExpanded((v) => !v)}
          />
          {conceptExpanded && (
            <div style={{ border: "1px solid #e0e7ff", borderTop: "none", borderRadius: "0 0 0.4rem 0.4rem", padding: "0.85rem 1rem", background: "#fafafe", marginBottom: "0.75rem" }}>
              <ConceptExtractionForm
                projectId={projectId}
                template={conceptTemplate}
                recordId={item.record_id ?? undefined}
                clusterId={item.cluster_id ?? undefined}
                allExtractions={allExtractions}
              />
            </div>
          )}
        </>
      )}

      {/* ── Action bar ───────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap",
        marginTop: "1rem", paddingTop: "0.75rem", borderTop: "1px solid #e5e7eb",
      }}>
        <button
          className="btn-primary"
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
          style={{ fontSize: "0.85rem" }}
        >
          {saveMutation.isPending ? "Saving…" : "Save & Close"}
        </button>
        <button className="btn-secondary" onClick={onClose} style={{ fontSize: "0.85rem" }}>
          Close
        </button>
        {saveMutation.isError && (
          <span style={{ color: "#c5221f", fontSize: "0.82rem" }}>Save failed — please retry.</span>
        )}
        <div style={{ marginLeft: "auto" }}>
          {!confirmExclude ? (
            <button
              onClick={() => setConfirmExclude(true)}
              style={{
                fontSize: "0.8rem", fontWeight: 600,
                padding: "0.3rem 0.8rem", borderRadius: "0.375rem",
                border: "1px solid #fca5a5", background: "#fff5f5", color: "#c5221f", cursor: "pointer",
              }}
            >
              Exclude from library
            </button>
          ) : (
            <div style={{
              display: "flex", flexDirection: "column", gap: "0.35rem",
              background: "#fff5f5", border: "1px solid #fca5a5",
              borderRadius: "0.4rem", padding: "0.6rem 0.8rem",
            }}>
              <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "#c5221f" }}>
                Exclude this paper? It will be removed from the extraction library.
              </span>
              <input
                type="text"
                value={excludeReason}
                onChange={(e) => setExcludeReason(e.target.value)}
                placeholder="Reason (optional)"
                style={{
                  fontSize: "0.8rem", padding: "0.28rem 0.45rem",
                  border: "1px solid #fca5a5", borderRadius: "0.25rem", fontFamily: "inherit",
                }}
              />
              <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                <button
                  onClick={() => excludeMutation.mutate()}
                  disabled={excludeMutation.isPending}
                  style={{
                    fontSize: "0.8rem", fontWeight: 600, padding: "0.28rem 0.7rem",
                    borderRadius: "0.25rem", border: "none", background: "#c5221f", color: "#fff", cursor: "pointer",
                  }}
                >
                  {excludeMutation.isPending ? "Excluding…" : "Confirm exclude"}
                </button>
                <button
                  onClick={() => { setConfirmExclude(false); setExcludeReason(""); }}
                  style={{
                    fontSize: "0.8rem", padding: "0.28rem 0.7rem", borderRadius: "0.25rem",
                    border: "1px solid #dadce0", background: "#fff", color: "#374151", cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                {excludeMutation.isError && (
                  <span style={{ color: "#c5221f", fontSize: "0.76rem" }}>Failed — retry.</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Concept novelty chart
// ---------------------------------------------------------------------------

function buildSeenValues(
  allExtractions: ConceptExtractionRecord[],
  excludeKey: string | null,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const ce of allExtractions) {
    const key = ce.record_id ?? ce.cluster_id;
    if (key === excludeKey) continue;
    const cells = ce.extracted_json?.cells ?? {};
    for (const [fieldId, val] of Object.entries(cells)) {
      if (!map.has(fieldId)) map.set(fieldId, new Set());
      if (Array.isArray(val)) val.forEach((v) => map.get(fieldId)!.add(v as string));
      else if (val) map.get(fieldId)!.add(val as string);
    }
  }
  return map;
}

function countNovelty(
  ce: ConceptExtractionRecord,
  seenValues: Map<string, Set<string>>,
  entityFieldIds: Set<string>,
): { newCount: number; existingCount: number } {
  const cells = ce.extracted_json?.cells ?? {};
  const storedNovelty = ce.extracted_json?.novelty ?? {};
  let newCount = 0, existingCount = 0;
  for (const [fieldId, val] of Object.entries(cells)) {
    if (!entityFieldIds.has(fieldId)) continue;
    const activeVals = Array.isArray(val) ? val : (val ? [val as string] : []);
    const fieldNovelty = storedNovelty[fieldId] ?? {};
    const seen = seenValues.get(fieldId) ?? new Set<string>();
    for (const v of activeVals) {
      const status = v in fieldNovelty ? fieldNovelty[v] : (seen.has(v) ? "existing" : "new");
      if (status === "new") newCount++;
      else existingCount++;
    }
  }
  return { newCount, existingCount };
}

function ConceptNoveltyChart({
  items,
  conceptExtractions,
  conceptTemplate,
}: {
  items: ExtractionLibraryItem[];
  conceptExtractions: ConceptExtractionRecord[];
  conceptTemplate: ConceptTemplate | null;
}) {
  const entityFieldIds = new Set(
    (conceptTemplate?.fields ?? []).filter((f) => f.field_type === "entity").map((f) => f.id)
  );
  const svgRef = useRef<SVGSVGElement>(null);

  const ceMap = new Map(
    conceptExtractions.map((ce) => [(ce.record_id ?? ce.cluster_id)!, ce])
  );

  const data = items.map((item) => {
    const key = item.record_id ?? item.cluster_id ?? "";
    const ce = ceMap.get(key);
    const seenValues = ce ? buildSeenValues(conceptExtractions, key) : new Map();
    const counts = ce ? countNovelty(ce, seenValues, entityFieldIds) : { newCount: 0, existingCount: 0 };
    const rawTitle = item.title ?? "Untitled";
    // Use "AuthorYear" style label if possible, else truncated title
    const firstAuthor = item.authors?.[0]?.split(",")[0]?.trim() ?? "";
    const label = firstAuthor && item.year
      ? `${firstAuthor} ${item.year}`
      : rawTitle.slice(0, 20);
    return { label, title: rawTitle, year: item.year, ...counts };
  });

  const BAR_W = 44;
  const GAP = 10;
  const ML = 52, MR = 24, MT = 52, MB = 90;
  const plotH = 220;
  const chartW = ML + data.length * (BAR_W + GAP) + MR;
  const chartH = plotH + MT + MB;
  const yMax = Math.max(1, ...data.map((d) => d.newCount + d.existingCount));

  // Nice round tick intervals
  const rawStep = yMax / 4;
  const step = Math.ceil(rawStep) || 1;
  const yTicks: number[] = [];
  for (let v = 0; v <= yMax + step; v += step) yTicks.push(v);

  const hasAnyNovelty = data.some((d) => d.newCount + d.existingCount > 0);

  const NEW_COLOR = "#16a34a";
  const EXIST_COLOR = "#818cf8";
  const AXIS_COLOR = "#94a3b8";
  const GRID_COLOR = "#f1f5f9";
  const TEXT_COLOR = "#1e293b";
  const SUB_COLOR = "#64748b";

  function downloadPng() {
    const svg = svgRef.current;
    if (!svg) return;
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svg);
    const scale = 3;
    const canvas = document.createElement("canvas");
    canvas.width = chartW * scale;
    canvas.height = chartH * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, chartW, chartH);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "concept-novelty.png";
        a.click();
        URL.revokeObjectURL(url);
      }, "image/png");
    };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
  }

  return (
    <div style={{
      background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12,
      padding: "20px 20px 12px", marginBottom: 20,
      boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: TEXT_COLOR, letterSpacing: "-0.01em" }}>
            Concept Novelty by Article
          </div>
          <div style={{ fontSize: 12, color: SUB_COLOR, marginTop: 2 }}>
            Number of new vs. existing concepts introduced per extracted article
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* Legend */}
          <div style={{ display: "flex", gap: 14 }}>
            {([[ NEW_COLOR, "New" ], [ EXIST_COLOR, "Existing" ]] as [string, string][]).map(([color, label]) => (
              <span key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: SUB_COLOR }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block", flexShrink: 0 }} />
                {label}
              </span>
            ))}
          </div>
          <button
            onClick={downloadPng}
            title="Download as PNG"
            style={{
              display: "flex", alignItems: "center", gap: 5,
              fontSize: 12, fontWeight: 600, padding: "5px 12px",
              borderRadius: 6, border: "1px solid #e2e8f0",
              background: "#f8fafc", color: "#374151",
              cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            ↓ Download PNG
          </button>
        </div>
      </div>

      {!hasAnyNovelty ? (
        <div style={{
          textAlign: "center", padding: "28px 0", color: "#94a3b8", fontSize: 13,
          background: "#f8fafc", borderRadius: 8, border: "1px dashed #e2e8f0",
        }}>
          No novelty data yet — open an article and fill concept fields to see the chart.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <svg ref={svgRef} width={chartW} height={chartH} style={{ display: "block", fontFamily: "system-ui, -apple-system, sans-serif" }}>
            {/* White background (needed for PNG export) */}
            <rect width={chartW} height={chartH} fill="#ffffff" />

            {/* Y-axis label */}
            <text
              x={14} y={MT + plotH / 2}
              transform={`rotate(-90, 14, ${MT + plotH / 2})`}
              textAnchor="middle" fontSize={11} fill={SUB_COLOR} fontWeight={500}
            >
              Number of Concepts
            </text>

            {/* Grid lines + Y tick labels */}
            {yTicks.filter((v) => v <= yMax + step / 2).map((v) => {
              const y = MT + plotH - (v / yMax) * plotH;
              return (
                <g key={v}>
                  <line x1={ML} y1={y} x2={chartW - MR} y2={y}
                    stroke={v === 0 ? AXIS_COLOR : GRID_COLOR} strokeWidth={v === 0 ? 1.5 : 1} />
                  <text x={ML - 8} y={y} textAnchor="end" dominantBaseline="middle"
                    fontSize={10} fill={AXIS_COLOR}>{v}</text>
                </g>
              );
            })}

            {/* Left axis */}
            <line x1={ML} y1={MT} x2={ML} y2={MT + plotH} stroke={AXIS_COLOR} strokeWidth={1.5} />

            {/* Bars */}
            {data.map((d, i) => {
              const x = ML + i * (BAR_W + GAP);
              const total = d.newCount + d.existingCount;
              const existH = (d.existingCount / yMax) * plotH;
              const newH   = (d.newCount / yMax) * plotH;
              const totalH = existH + newH;
              const barTop = MT + plotH - totalH;

              return (
                <g key={i}>
                  {/* Existing (bottom segment) */}
                  {existH > 0 && (
                    <g>
                      <rect x={x} y={MT + plotH - existH} width={BAR_W} height={existH}
                        fill={EXIST_COLOR} rx={existH < 4 ? 2 : 0}>
                        <title>{`${d.title} (${d.year ?? "—"}): ${d.existingCount} existing`}</title>
                      </rect>
                      {existH >= 14 ? (
                        <text x={x + BAR_W / 2} y={MT + plotH - existH / 2}
                          textAnchor="middle" dominantBaseline="middle"
                          fontSize={10} fill="#ffffff" fontWeight={700}>
                          {d.existingCount}
                        </text>
                      ) : (
                        <text x={x + BAR_W / 2} y={MT + plotH + 2}
                          textAnchor="middle" dominantBaseline="hanging"
                          fontSize={9} fill={EXIST_COLOR} fontWeight={700}>
                          {d.existingCount}
                        </text>
                      )}
                    </g>
                  )}
                  {/* New (top segment) */}
                  {newH > 0 && (
                    <g>
                      <rect x={x} y={barTop} width={BAR_W} height={newH}
                        fill={NEW_COLOR} rx={2}>
                        <title>{`${d.title} (${d.year ?? "—"}): ${d.newCount} new`}</title>
                      </rect>
                      {newH >= 14 ? (
                        <text x={x + BAR_W / 2} y={barTop + newH / 2}
                          textAnchor="middle" dominantBaseline="middle"
                          fontSize={10} fill="#ffffff" fontWeight={700}>
                          {d.newCount}
                        </text>
                      ) : (
                        <text x={x + BAR_W / 2} y={barTop - 2}
                          textAnchor="middle" dominantBaseline="auto"
                          fontSize={9} fill={NEW_COLOR} fontWeight={700}>
                          {d.newCount}
                        </text>
                      )}
                    </g>
                  )}
                  {/* Total label above bar */}
                  {total > 0 && (
                    <text x={x + BAR_W / 2} y={barTop - (newH < 14 ? 14 : 5)}
                      textAnchor="middle" fontSize={10} fill={TEXT_COLOR} fontWeight={600}>
                      {total}
                    </text>
                  )}
                  {/* X-axis label — rotated */}
                  <text
                    x={x + BAR_W / 2} y={MT + plotH + 10}
                    transform={`rotate(-45, ${x + BAR_W / 2}, ${MT + plotH + 10})`}
                    textAnchor="end" fontSize={10} fill={SUB_COLOR}
                  >
                    {d.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function csvCell(v: unknown): string {
  const s = Array.isArray(v) ? v.join(" | ") : String(v ?? "");
  // Wrap in quotes if the value contains commas, quotes, or newlines
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCsv(
  items: ExtractionLibraryItem[],
  templateRows: ExtractionTemplateRow[],
  filename = "extractions.csv",
) {
  const headers = [
    "Title", "Authors", "Year", "DOI", "Sources",
    ...templateRows.map((r) => `${r.domain} — ${r.item}`),
    "Levels", "Dimensions", "Notes",
    "Framework Updated", "Framework Note",
    "Extracted Date",
  ];

  const rows = items.map((item) => {
    const tbl = item.extracted_json.table ?? {};
    return [
      item.title ?? "",
      (item.authors ?? []).join("; "),
      item.year ?? "",
      item.doi ?? "",
      (item.source_names ?? []).join("; "),
      ...templateRows.map((r) => {
        const v = tbl[r.id];
        return Array.isArray(v) ? v.join(" | ") : (v ?? "");
      }),
      (item.extracted_json.levels ?? []).join("; "),
      (item.extracted_json.dimensions ?? []).join("; "),
      item.extracted_json.free_note ?? "",
      item.extracted_json.framework_updated ? "Yes" : "No",
      item.extracted_json.framework_update_note ?? "",
      item.created_at
        ? new Date(item.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
        : "",
    ].map(csvCell);
  });

  const csv = [headers.map(csvCell), ...rows].map((r) => r.join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }); // BOM for Excel
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ExtractionLibrary() {
  const { id: projectId } = useParams<{ id: string }>();

  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showChart, setShowChart] = useState(true);
  const [orderedItems, setOrderedItems] = useState<ExtractionLibraryItem[]>([]);
  const dragIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [selectedReviewerId, setSelectedReviewerId] = useState<string | null>(null);

  // Fetch project (for role check + template)
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const isOwnerOrAdmin = project?.my_role === "owner" || project?.my_role === "admin";

  // Fetch team members so owner/admin can filter by reviewer
  const { data: members = [] } = useQuery<TeamMember[]>({
    queryKey: ["team-members", projectId],
    queryFn: () => teamApi.getMembers(projectId!).then((r) => r.data),
    enabled: !!projectId && isOwnerOrAdmin,
  });

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["extractions-library", projectId, selectedReviewerId],
    queryFn: () =>
      extractionLibraryApi.list(projectId!, selectedReviewerId ?? undefined).then((r) => r.data),
    enabled: !!projectId,
  });

  // Sync server data into orderedItems, preserving any custom drag order
  useEffect(() => {
    if (items.length === 0) { setOrderedItems([]); return; }
    setOrderedItems((prev) => {
      const itemMap = new Map(items.map((i) => [i.id, i]));
      const prevIds = new Set(prev.map((i) => i.id));
      const newItems = items.filter((i) => !prevIds.has(i.id));
      const updated = prev.map((p) => itemMap.get(p.id)).filter(Boolean) as ExtractionLibraryItem[];
      return [...updated, ...newItems];
    });
  }, [items]);

  const handleDragStart = useCallback((_e: React.DragEvent, idx: number) => {
    dragIdx.current = idx;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOverIdx(idx);
  }, []);

  const handleDrop = useCallback((_e: React.DragEvent, dropIdx: number) => {
    const from = dragIdx.current;
    if (from === null || from === dropIdx) { dragIdx.current = null; setDragOverIdx(null); return; }
    setOrderedItems((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(dropIdx, 0, moved);
      return next;
    });
    dragIdx.current = null;
    setDragOverIdx(null);
  }, []);

  const templateRows: ExtractionTemplateRow[] = project?.extraction_template?.rows ?? [];
  const conceptTemplate: ConceptTemplate | null = project?.concept_template ?? null;

  const { data: conceptExtractions = [] } = useQuery({
    queryKey: ["concept-extractions-list", projectId],
    queryFn: () => conceptExtractionApi.list(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  // Build lookup: record_id or cluster_id → ConceptExtractionRecord
  const conceptMap = new Map<string, ConceptExtractionRecord>(
    conceptExtractions.map((ce) => [(ce.record_id ?? ce.cluster_id)!, ce])
  );

  // ── Client-side filter (search only; applied on top of drag order) ───────
  const visible = orderedItems.filter((item) => {
    if (!search) return true;
    const text = [item.title ?? "", item.doi ?? "", ...(item.authors ?? [])]
      .join(" ").toLowerCase();
    return text.includes(search.toLowerCase());
  });

  // ── Render ───────────────────────────────────────────────────────────────

  const hasConceptTemplate = conceptTemplate && conceptTemplate.fields.length > 0;
  // Grid: ⠿ | Title | Year | Sources | [Extraction] | [Concepts] | Date | Note
  const COLS = [
    "20px", "1fr", "48px", "100px",
    ...(templateRows.length > 0 ? ["72px"] : []),
    ...(hasConceptTemplate ? ["68px"] : []),
    "90px", "24px",
  ].join(" ");

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
              {orderedItems.length} article{orderedItems.length !== 1 ? "s" : ""} extracted
              {visible.length !== orderedItems.length && ` · ${visible.length} shown`}
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: "0.5rem", alignItems: "center" }}>
            {isOwnerOrAdmin && members.length > 0 && (
              <select
                value={selectedReviewerId ?? ""}
                onChange={(e) => setSelectedReviewerId(e.target.value || null)}
                className="input"
                style={{ fontSize: "0.82rem", padding: "4px 8px", height: 32 }}
                title="Filter by reviewer"
              >
                <option value="">All reviewers</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name || m.email}
                  </option>
                ))}
              </select>
            )}
            <button
              className="btn-secondary"
              onClick={() => setShowChart((v) => !v)}
              style={{ fontSize: "0.82rem", whiteSpace: "nowrap" }}
            >
              {showChart ? "Hide Chart" : "Show Chart"}
            </button>
            <button
              className="btn-secondary"
              disabled={visible.length === 0}
              onClick={() => downloadCsv(visible, templateRows, `extractions-${projectId}.csv`)}
              title="Download all visible rows as a spreadsheet"
              style={{ fontSize: "0.82rem", whiteSpace: "nowrap" }}
            >
              ↓ Download CSV
            </button>
            <Link
              to={`/projects/${projectId}/citations`}
              className="btn-primary"
              style={{
                fontSize: "0.82rem",
                whiteSpace: "nowrap",
                textDecoration: "none",
                opacity: orderedItems.length === 0 ? 0.5 : 1,
                pointerEvents: orderedItems.length === 0 ? "none" : "auto",
              }}
              title={orderedItems.length === 0 ? "Extract papers first before running citation search" : "Find papers that reference or cite your extracted studies"}
            >
              Citation Search
            </Link>
          </div>
        </div>

        {/* ── Concept novelty chart ────────────────────────────────────────── */}
        {showChart && (
          <ConceptNoveltyChart items={visible} conceptExtractions={conceptExtractions} conceptTemplate={conceptTemplate} />
        )}

        {/* ── Search ──────────────────────────────────────────────────────── */}
        <div style={{ marginBottom: "1rem" }}>
          <input
            type="search"
            className="input"
            placeholder="Search title, authors, DOI…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 400, fontSize: "0.88rem" }}
          />
        </div>

        {/* ── Table ───────────────────────────────────────────────────────── */}
        {isLoading ? (
          <p style={{ color: "#888" }}>Loading…</p>
        ) : orderedItems.length === 0 ? (
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
              <span title="Drag to reorder" style={{ color: "#aaa" }}>⠿</span>
              <span>Title</span>
              <span>Year</span>
              <span>Sources</span>
              {templateRows.length > 0 && <span>Extraction</span>}
              {hasConceptTemplate && <span>Concepts</span>}
              <span>Extracted</span>
              <span />
            </div>

            {visible.map((item, rowIdx) => {
              const isExpanded = expandedId === item.id;
              const isDragTarget = dragOverIdx === rowIdx;
              const hasNote = !!(item.extracted_json.free_note ?? "").trim();
              const dateStr = item.created_at
                ? new Date(item.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                : "—";

              return (
                <div
                  key={item.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, rowIdx)}
                  onDragOver={(e) => handleDragOver(e, rowIdx)}
                  onDrop={(e) => handleDrop(e, rowIdx)}
                  onDragEnd={() => { dragIdx.current = null; setDragOverIdx(null); }}
                  style={{
                    borderBottom: "1px solid #ececec",
                    borderTop: isDragTarget ? "2px solid #4f46e5" : undefined,
                    transition: "border-color 0.1s",
                  }}
                >
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
                    {/* Drag handle */}
                    <div
                      style={{ color: "#c4c9d4", fontSize: "0.85rem", paddingTop: "0.05rem", cursor: "grab", userSelect: "none" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      ⠿
                    </div>

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

                    {/* Concept extraction indicator */}
                    {hasConceptTemplate && (
                      <div style={{ paddingTop: "0.1rem" }}>
                        <ConceptPreview
                          ce={conceptMap.get(item.record_id ?? item.cluster_id ?? "")}
                          template={conceptTemplate}
                        />
                      </div>
                    )}

                    {/* Extracted timestamp */}
                    <div style={{ fontSize: "0.78rem", color: "#6b7280", paddingTop: "0.1rem" }}>
                      {dateStr}
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
                      conceptTemplate={conceptTemplate}
                      allExtractions={conceptExtractions}
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
