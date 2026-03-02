import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { extractionLibraryApi, screeningApi } from "../api/client";
import type { ExtractionLibraryItem, ExtractionJson } from "../api/client";

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
// Inline edit panel (shown as an expanded row)
// ---------------------------------------------------------------------------

function EditPanel({
  item,
  projectId,
  onClose,
}: {
  item: ExtractionLibraryItem;
  projectId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [editLevels, setEditLevels] = useState<string[]>(
    item.extracted_json.levels ?? []
  );
  const [editDims, setEditDims] = useState<string[]>(
    item.extracted_json.dimensions ?? []
  );
  const [editNote, setEditNote] = useState<string>(
    item.extracted_json.free_note ?? ""
  );

  function toggleLevel(l: string) {
    setEditLevels((prev) =>
      prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]
    );
  }
  function toggleDim(d: string) {
    setEditDims((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    );
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      const updatedJson: ExtractionJson = {
        ...item.extracted_json,
        levels: editLevels,
        dimensions: editDims,
        free_note: editNote,
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

  return (
    <div
      style={{
        background: "#f8f9fa",
        borderTop: "1px solid #dadce0",
        padding: "1rem 1.25rem",
      }}
    >
      {/* Levels */}
      <div style={{ marginBottom: "0.75rem" }}>
        <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#3c4043", marginBottom: "0.4rem" }}>
          Levels
        </div>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          {LEVELS.map((l) => (
            <Chip
              key={l}
              label={l}
              active={editLevels.includes(l)}
              color="blue"
              onClick={() => toggleLevel(l)}
            />
          ))}
        </div>
      </div>

      {/* Dimensions */}
      <div style={{ marginBottom: "0.75rem" }}>
        <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#3c4043", marginBottom: "0.4rem" }}>
          Dimensions
        </div>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          {DIMENSIONS.map((d) => (
            <Chip
              key={d}
              label={d}
              active={editDims.includes(d)}
              color="purple"
              onClick={() => toggleDim(d)}
            />
          ))}
        </div>
      </div>

      {/* Free note */}
      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#3c4043", marginBottom: "0.4rem" }}>
          Notes
        </div>
        <textarea
          value={editNote}
          onChange={(e) => setEditNote(e.target.value)}
          rows={5}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "0.4rem 0.5rem",
            border: "1px solid #dadce0",
            borderRadius: "0.375rem",
            fontSize: "0.85rem",
            fontFamily: "inherit",
            resize: "vertical",
          }}
          placeholder="Free notes about this paper…"
        />
      </div>

      <div style={{ display: "flex", gap: "0.5rem" }}>
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
          <span style={{ color: "#c5221f", fontSize: "0.82rem", alignSelf: "center" }}>
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

  function handleRowClick(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  // ── Render ───────────────────────────────────────────────────────────────

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
            background: "#f8f9fa",
            border: "1px solid #dadce0",
            borderRadius: "0.5rem",
            padding: "0.9rem 1rem",
            marginBottom: "1.25rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.6rem",
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
              textAlign: "center",
              padding: "3rem 2rem",
              background: "#f8f9fa",
              border: "1px solid #dadce0",
              borderRadius: "0.75rem",
              color: "#5f6368",
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
          <div
            style={{
              border: "1px solid #dadce0",
              borderRadius: "0.5rem",
              overflow: "hidden",
            }}
          >
            {/* Header row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 56px 120px 160px 120px 36px",
                gap: "0.5rem",
                padding: "0.5rem 1rem",
                background: "#f1f3f4",
                borderBottom: "1px solid #dadce0",
                fontSize: "0.78rem",
                fontWeight: 600,
                color: "#5f6368",
                textTransform: "uppercase",
                letterSpacing: "0.03em",
              }}
            >
              <span>Title</span>
              <span>Year</span>
              <span>Sources</span>
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
                <div
                  key={item.id}
                  style={{
                    borderBottom: "1px solid #ececec",
                  }}
                >
                  {/* Main row */}
                  <div
                    onClick={() => handleRowClick(item.id)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 56px 120px 160px 120px 36px",
                      gap: "0.5rem",
                      padding: "0.65rem 1rem",
                      cursor: "pointer",
                      background: isExpanded ? "#e8f0fe" : "transparent",
                      transition: "background 0.1s",
                      alignItems: "start",
                    }}
                    onMouseEnter={(e) => {
                      if (!isExpanded)
                        (e.currentTarget as HTMLElement).style.background = "#f8f9fa";
                    }}
                    onMouseLeave={(e) => {
                      if (!isExpanded)
                        (e.currentTarget as HTMLElement).style.background = "transparent";
                    }}
                  >
                    {/* Title + authors */}
                    <div>
                      <div
                        style={{
                          fontSize: "0.88rem",
                          fontWeight: 500,
                          color: "#202124",
                          lineHeight: 1.35,
                          marginBottom: "0.15rem",
                        }}
                      >
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
                            <span
                              key={s}
                              style={{
                                fontSize: "0.72rem",
                                background: "#f1f3f4",
                                border: "1px solid #dadce0",
                                borderRadius: "0.25rem",
                                padding: "0.1rem 0.35rem",
                                color: "#3c4043",
                              }}
                            >
                              {s}
                            </span>
                          ))
                        : <span style={{ fontSize: "0.75rem", color: "#aaa" }}>—</span>}
                    </div>

                    {/* Levels chips */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                      {levels.length > 0
                        ? levels.map((l) => (
                            <Chip key={l} label={l} active={true} color="blue" />
                          ))
                        : <span style={{ fontSize: "0.75rem", color: "#aaa" }}>—</span>}
                    </div>

                    {/* Dimensions chips */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                      {dims.length > 0
                        ? dims.map((d) => (
                            <Chip key={d} label={d} active={true} color="purple" />
                          ))
                        : <span style={{ fontSize: "0.75rem", color: "#aaa" }}>—</span>}
                    </div>

                    {/* Notes indicator */}
                    <div
                      style={{
                        fontSize: "0.85rem",
                        textAlign: "center",
                        paddingTop: "0.1rem",
                      }}
                    >
                      {hasNote ? (
                        <span title="Has notes" style={{ color: "#1a73e8" }}>📝</span>
                      ) : (
                        <span style={{ color: "#dadce0" }}>·</span>
                      )}
                    </div>
                  </div>

                  {/* Expanded edit panel */}
                  {isExpanded && projectId && (
                    <EditPanel
                      item={item}
                      projectId={projectId}
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
