/**
 * ThematicAnalysis — iterative code/theme management for scoping reviews.
 *
 * Layout: left panel (theme tree) + right panel (code detail + evidence).
 * Themes and codes are stored as ontology_nodes; code_extractions links
 * codes to extraction_records with optional supporting snippets.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  thematicApi,
  extractionLibraryApi,
  type ThemeItem,
  type ThemeCode,
  type CodeEvidence,
  type ThematicHistoryEntry,
  type ExtractionLibraryItem,
} from "../api/client";

// ── Colour helpers ─────────────────────────────────────────────────────────────

const PALETTE = [
  "#6366f1", "#f59e0b", "#10b981", "#ef4444", "#3b82f6",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#84cc16",
];

function colorDot(color: string | null, size = 10) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color ?? "#94a3b8",
        marginRight: 6,
        flexShrink: 0,
      }}
    />
  );
}

// ── Action label map ───────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  create_theme: "Theme created",
  create_code: "Code created",
  assign_theme: "Code moved to theme",
  remove_theme: "Code ungrouped",
  rename_code: "Code renamed",
  rename_theme: "Theme renamed",
};

// ── Modal: Create Theme ────────────────────────────────────────────────────────

function CreateThemeModal({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[0]);

  const mut = useMutation({
    mutationFn: () => thematicApi.createTheme(projectId, { name: name.trim(), color }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["thematic", projectId] });
      onClose();
    },
  });

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 1rem" }}>New Theme</h3>
        <label style={labelStyle}>Theme name</label>
        <input
          style={inputStyle}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Barriers to Care"
          autoFocus
        />
        <label style={labelStyle}>Colour</label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: "1rem" }}>
          {PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: c,
                border: color === c ? "2px solid #1e293b" : "2px solid transparent",
                cursor: "pointer",
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!name.trim() || mut.isPending}
            onClick={() => mut.mutate()}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Modal: Create Code ─────────────────────────────────────────────────────────

function CreateCodeModal({
  projectId,
  themes,
  defaultThemeId,
  onClose,
}: {
  projectId: string;
  themes: ThemeItem[];
  defaultThemeId?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [themeId, setThemeId] = useState<string>(defaultThemeId ?? "");
  const [description, setDescription] = useState("");

  const mut = useMutation({
    mutationFn: () =>
      thematicApi.createCode(projectId, {
        name: name.trim(),
        theme_id: themeId || null,
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["thematic", projectId] });
      onClose();
    },
  });

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 1rem" }}>New Code</h3>
        <label style={labelStyle}>Code name</label>
        <input
          style={inputStyle}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Financial barriers"
          autoFocus
        />
        <label style={labelStyle}>Description (optional)</label>
        <textarea
          style={{ ...inputStyle, resize: "vertical" }}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="When to apply this code..."
        />
        <label style={labelStyle}>Assign to theme</label>
        <select
          style={inputStyle}
          value={themeId}
          onChange={(e) => setThemeId(e.target.value)}
        >
          <option value="">— Ungrouped —</option>
          {themes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: "0.5rem" }}>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!name.trim() || mut.isPending}
            onClick={() => mut.mutate()}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Modal: Assign Code to Extraction ──────────────────────────────────────────

function AssignModal({
  projectId,
  codeId,
  codeName,
  onClose,
}: {
  projectId: string;
  codeId: string;
  codeName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snippet, setSnippet] = useState("");
  const [note, setNote] = useState("");

  const { data: extractions = [], isLoading } = useQuery({
    queryKey: ["extractions-library", projectId],
    queryFn: () => extractionLibraryApi.list(projectId).then((r) => r.data),
    staleTime: 60_000,
  });

  const filtered = extractions.filter((e) => {
    const q = search.toLowerCase();
    return (
      !q ||
      e.title?.toLowerCase().includes(q) ||
      e.authors?.some((a) => a.toLowerCase().includes(q)) ||
      String(e.year ?? "").includes(q)
    );
  });

  const mut = useMutation({
    mutationFn: () =>
      thematicApi.assignCode(projectId, {
        code_id: codeId,
        extraction_id: selectedId!,
        snippet_text: snippet.trim() || undefined,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["code-evidence", projectId, codeId] });
      qc.invalidateQueries({ queryKey: ["thematic", projectId] });
      onClose();
    },
  });

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div
        style={{ ...modalStyle, maxWidth: 640, maxHeight: "80vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: "0 0 0.75rem" }}>
          Assign paper to <em>{codeName}</em>
        </h3>
        <input
          style={{ ...inputStyle, marginBottom: "0.5rem" }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by title, author, year…"
        />
        <div style={{ flex: 1, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, marginBottom: "0.75rem" }}>
          {isLoading ? (
            <p style={{ padding: "1rem", color: "var(--text-muted)" }}>Loading extractions…</p>
          ) : filtered.length === 0 ? (
            <p style={{ padding: "1rem", color: "var(--text-muted)" }}>No extractions found. Complete some extractions first.</p>
          ) : (
            filtered.map((e) => (
              <div
                key={e.id}
                onClick={() => setSelectedId(e.id)}
                style={{
                  padding: "0.5rem 0.75rem",
                  cursor: "pointer",
                  background: selectedId === e.id ? "#ede9fe" : "transparent",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "flex-start",
                }}
              >
                <input
                  type="radio"
                  readOnly
                  checked={selectedId === e.id}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontWeight: 500, fontSize: "0.85rem" }}>
                    {e.title ?? "(Untitled)"}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    {e.year} · {e.authors?.slice(0, 2).join(", ") ?? "Unknown"}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
        {selectedId && (
          <>
            <label style={labelStyle}>Supporting snippet (optional)</label>
            <textarea
              style={{ ...inputStyle, resize: "vertical" }}
              rows={2}
              value={snippet}
              onChange={(e) => setSnippet(e.target.value)}
              placeholder="Paste the relevant quote from the paper…"
            />
            <label style={labelStyle}>Note (optional)</label>
            <input
              style={inputStyle}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why does this paper illustrate the code?"
            />
          </>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: "0.5rem" }}>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!selectedId || mut.isPending}
            onClick={() => mut.mutate()}
          >
            Assign
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Code Detail Panel ──────────────────────────────────────────────────────────

function CodeDetail({
  projectId,
  code,
  themes,
  currentThemeId,
  onDeselect,
}: {
  projectId: string;
  code: ThemeCode;
  themes: ThemeItem[];
  currentThemeId: string | null;
  onDeselect: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(code.name);
  const [editDesc, setEditDesc] = useState(code.description ?? "");
  const [showAssign, setShowAssign] = useState(false);
  const [activeTab, setActiveTab] = useState<"evidence" | "history">("evidence");

  const { data: evidence = [], isLoading: evLoading } = useQuery({
    queryKey: ["code-evidence", projectId, code.id],
    queryFn: () => thematicApi.getCodeEvidence(projectId, code.id).then((r) => r.data),
    staleTime: 30_000,
  });

  const { data: history = [] } = useQuery({
    queryKey: ["thematic-history", projectId],
    queryFn: () => thematicApi.getHistory(projectId).then((r) => r.data),
    staleTime: 30_000,
    enabled: activeTab === "history",
  });

  const codeHistory = history.filter((h) => h.code_id === code.id);

  const moveMut = useMutation({
    mutationFn: (themeId: string | null) =>
      thematicApi.updateCode(projectId, code.id, {
        theme_id: themeId ?? undefined,
        clear_theme: themeId === null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["thematic", projectId] }),
  });

  const saveMut = useMutation({
    mutationFn: () =>
      thematicApi.updateCode(projectId, code.id, {
        name: editName.trim(),
        description: editDesc.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["thematic", projectId] });
      setEditing(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => thematicApi.deleteCode(projectId, code.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["thematic", projectId] });
      onDeselect();
    },
  });

  const removeEvMut = useMutation({
    mutationFn: (assignmentId: string) => thematicApi.removeAssignment(projectId, assignmentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["code-evidence", projectId, code.id] });
      qc.invalidateQueries({ queryKey: ["thematic", projectId] });
    },
  });

  const currentThemeName = themes.find((t) => t.id === currentThemeId)?.name ?? null;

  return (
    <div style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem", height: "100%", overflowY: "auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
        {colorDot(code.color, 14)}
        <div style={{ flex: 1 }}>
          {editing ? (
            <>
              <input
                style={{ ...inputStyle, fontSize: "1.05rem", fontWeight: 600, marginBottom: 6 }}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                autoFocus
              />
              <textarea
                style={{ ...inputStyle, resize: "vertical" }}
                rows={2}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Description…"
              />
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  className="btn-primary"
                  style={{ fontSize: "0.8rem" }}
                  disabled={!editName.trim() || saveMut.isPending}
                  onClick={() => saveMut.mutate()}
                >
                  Save
                </button>
                <button className="btn-ghost" style={{ fontSize: "0.8rem" }} onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>{code.name}</div>
              {code.description && (
                <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 2 }}>
                  {code.description}
                </div>
              )}
            </>
          )}
        </div>
        {!editing && (
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button
              className="btn-ghost"
              style={{ fontSize: "0.75rem" }}
              onClick={() => { setEditing(true); setEditName(code.name); setEditDesc(code.description ?? ""); }}
            >
              Edit
            </button>
            <button
              className="btn-ghost"
              style={{ fontSize: "0.75rem", color: "#ef4444" }}
              disabled={deleteMut.isPending}
              onClick={() => {
                if (window.confirm(`Delete code "${code.name}"? This removes all its evidence links.`)) {
                  deleteMut.mutate();
                }
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {/* Theme assignment */}
      <div style={{ background: "var(--surface)", borderRadius: 8, padding: "0.6rem 0.75rem" }}>
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 4 }}>
          Theme
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 500 }}>{currentThemeName ?? "— Ungrouped —"}</span>
          <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>Move to:</span>
          <select
            style={{ ...inputStyle, margin: 0, padding: "0.2rem 0.4rem", fontSize: "0.8rem" }}
            value={currentThemeId ?? ""}
            onChange={(e) => moveMut.mutate(e.target.value || null)}
          >
            <option value="">— Ungrouped —</option>
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {moveMut.isPending && <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Saving…</span>}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)" }}>
        {(["evidence", "history"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: "0.4rem 1rem",
              background: "none",
              border: "none",
              borderBottom: activeTab === tab ? "2px solid #6366f1" : "2px solid transparent",
              color: activeTab === tab ? "#6366f1" : "var(--text-muted)",
              fontWeight: activeTab === tab ? 600 : 400,
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            {tab === "evidence" ? `Evidence (${evidence.length})` : "History"}
          </button>
        ))}
      </div>

      {/* Evidence tab */}
      {activeTab === "evidence" && (
        <div>
          <button
            className="btn-ghost"
            style={{ fontSize: "0.8rem", marginBottom: "0.75rem" }}
            onClick={() => setShowAssign(true)}
          >
            + Assign to paper
          </button>
          {evLoading ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>Loading…</p>
          ) : evidence.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
              No papers linked yet. Click "Assign to paper" to connect this code to an extraction.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {evidence.map((ev) => (
                <EvidenceCard
                  key={ev.assignment_id}
                  ev={ev}
                  onRemove={() => removeEvMut.mutate(ev.assignment_id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* History tab */}
      {activeTab === "history" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {codeHistory.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>No history yet.</p>
          ) : (
            codeHistory.map((h) => (
              <div
                key={h.id}
                style={{
                  fontSize: "0.8rem",
                  padding: "0.4rem 0.6rem",
                  background: "var(--surface)",
                  borderRadius: 6,
                }}
              >
                <span style={{ fontWeight: 500 }}>{ACTION_LABELS[h.action] ?? h.action}</span>
                {h.old_theme_name && h.new_theme_name && (
                  <span style={{ color: "var(--text-muted)" }}>
                    {" "}
                    {h.old_theme_name} → {h.new_theme_name}
                  </span>
                )}
                {h.new_theme_name && !h.old_theme_name && h.action === "create_code" && (
                  <span style={{ color: "var(--text-muted)" }}> under {h.new_theme_name}</span>
                )}
                <div style={{ color: "var(--text-muted)" }}>
                  {new Date(h.changed_at).toLocaleString()}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {showAssign && (
        <AssignModal
          projectId={projectId}
          codeId={code.id}
          codeName={code.name}
          onClose={() => setShowAssign(false)}
        />
      )}
    </div>
  );
}

function EvidenceCard({ ev, onRemove }: { ev: CodeEvidence; onRemove: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "0.6rem 0.75rem",
        background: "var(--surface)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>
            {ev.title ?? "(Untitled)"}
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            {ev.year} · {ev.authors?.slice(0, 2).join(", ") ?? "Unknown authors"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0, marginLeft: 8 }}>
          {(ev.snippet_text || ev.note) && (
            <button
              className="btn-ghost"
              style={{ fontSize: "0.7rem" }}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Hide" : "Show"} detail
            </button>
          )}
          <button
            className="btn-ghost"
            style={{ fontSize: "0.7rem", color: "#ef4444" }}
            onClick={onRemove}
          >
            Remove
          </button>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: "0.5rem" }}>
          {ev.snippet_text && (
            <blockquote
              style={{
                margin: "0 0 0.4rem 0",
                padding: "0.4rem 0.6rem",
                borderLeft: "3px solid #6366f1",
                background: "#ede9fe",
                borderRadius: "0 4px 4px 0",
                fontSize: "0.8rem",
                fontStyle: "italic",
              }}
            >
              {ev.snippet_text}
            </blockquote>
          )}
          {ev.note && (
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
              Note: {ev.note}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Theme Panel (left) ─────────────────────────────────────────────────────────

function ThemeSection({
  theme,
  selectedCodeId,
  onSelect,
  onAddCode,
  onDeleteTheme,
  projectId,
}: {
  theme: ThemeItem;
  selectedCodeId: string | null;
  onSelect: (code: ThemeCode, themeId: string) => void;
  onAddCode: (themeId: string) => void;
  onDeleteTheme: (themeId: string) => void;
  projectId: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const qc = useQueryClient();

  const renameMut = useMutation({
    mutationFn: (name: string) => thematicApi.updateTheme(projectId, theme.id, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["thematic", projectId] }),
  });

  function handleRename() {
    const name = window.prompt("New theme name:", theme.name);
    if (name && name.trim() && name.trim() !== theme.name) {
      renameMut.mutate(name.trim());
    }
  }

  return (
    <div style={{ marginBottom: "0.25rem" }}>
      {/* Theme header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0.35rem 0.5rem",
          borderRadius: 6,
          cursor: "pointer",
          userSelect: "none",
          background: "var(--surface)",
        }}
      >
        <button
          onClick={() => setCollapsed((v) => !v)}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: "0.7rem", color: "var(--text-muted)" }}
        >
          {collapsed ? "▶" : "▼"}
        </button>
        {colorDot(theme.color, 9)}
        <span
          style={{ flex: 1, fontWeight: 600, fontSize: "0.875rem" }}
          onDoubleClick={handleRename}
          title="Double-click to rename"
        >
          {theme.name}
        </span>
        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", background: "#e2e8f0", borderRadius: 10, padding: "1px 6px" }}>
          {theme.codes.length}
        </span>
        <button
          onClick={() => onAddCode(theme.id)}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: "0.7rem", color: "#6366f1", padding: "0 2px" }}
          title="Add code to this theme"
        >
          +
        </button>
        <button
          onClick={() => {
            if (window.confirm(`Delete theme "${theme.name}"? Its codes will become ungrouped.`)) {
              onDeleteTheme(theme.id);
            }
          }}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: "0.7rem", color: "#94a3b8", padding: "0 2px" }}
          title="Delete theme"
        >
          ×
        </button>
      </div>

      {/* Codes */}
      {!collapsed && (
        <div style={{ paddingLeft: "1.25rem" }}>
          {theme.codes.map((code) => (
            <CodeRow
              key={code.id}
              code={code}
              selected={selectedCodeId === code.id}
              onSelect={() => onSelect(code, theme.id)}
            />
          ))}
          {theme.codes.length === 0 && (
            <div
              style={{ fontSize: "0.75rem", color: "var(--text-muted)", padding: "0.2rem 0.4rem", fontStyle: "italic" }}
            >
              No codes yet
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CodeRow({
  code,
  selected,
  onSelect,
}: {
  code: ThemeCode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0.25rem 0.5rem",
        borderRadius: 5,
        cursor: "pointer",
        background: selected ? "#ede9fe" : "transparent",
        borderLeft: selected ? "3px solid #6366f1" : "3px solid transparent",
        marginBottom: 1,
      }}
    >
      {colorDot(code.color, 7)}
      <span style={{ flex: 1, fontSize: "0.85rem" }}>{code.name}</span>
      {code.evidence_count > 0 && (
        <span
          style={{
            fontSize: "0.68rem",
            background: "#dbeafe",
            color: "#1d4ed8",
            borderRadius: 10,
            padding: "1px 5px",
          }}
        >
          {code.evidence_count}
        </span>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function ThematicAnalysis() {
  const { id: projectId } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const [viewMode, setViewMode] = useState<"coding" | "map">("coding");
  const [selectedCodeId, setSelectedCodeId] = useState<string | null>(null);
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [showCreateTheme, setShowCreateTheme] = useState(false);
  const [showCreateCode, setShowCreateCode] = useState(false);
  const [createCodeThemeId, setCreateCodeThemeId] = useState<string | undefined>();

  const { data, isLoading, error } = useQuery({
    queryKey: ["thematic", projectId],
    queryFn: () => thematicApi.getMap(projectId!).then((r) => r.data),
    staleTime: 30_000,
    enabled: !!projectId,
  });

  const deleteThemeMut = useMutation({
    mutationFn: (themeId: string) => thematicApi.deleteTheme(projectId!, themeId),
    onSuccess: (_, themeId) => {
      if (selectedThemeId === themeId) {
        setSelectedCodeId(null);
        setSelectedThemeId(null);
      }
      qc.invalidateQueries({ queryKey: ["thematic", projectId] });
    },
  });

  if (!projectId) return null;
  if (isLoading) return <p style={{ padding: "2rem" }}>Loading thematic map…</p>;
  if (error) return <p style={{ padding: "2rem", color: "#ef4444" }}>Failed to load.</p>;

  const { themes = [], ungrouped_codes = [] } = data ?? {};

  // Find selected code object across all themes + ungrouped
  const allCodes: { code: ThemeCode; themeId: string | null }[] = [
    ...themes.flatMap((t) => t.codes.map((c) => ({ code: c, themeId: t.id }))),
    ...ungrouped_codes.map((c) => ({ code: c, themeId: null })),
  ];
  const selectedEntry = allCodes.find((e) => e.code.id === selectedCodeId) ?? null;

  function openAddCode(themeId?: string) {
    setCreateCodeThemeId(themeId);
    setShowCreateCode(true);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* Page header */}
      <div
        style={{
          padding: "1rem 1.5rem",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          background: "var(--surface)",
          flexShrink: 0,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700 }}>Taxonomy</h1>
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-muted)" }}>
            {themes.length} categor{themes.length !== 1 ? "ies" : "y"} ·{" "}
            {allCodes.length} concept{allCodes.length !== 1 ? "s" : ""} ·{" "}
            {allCodes.reduce((s, e) => s + e.code.evidence_count, 0)} evidence links
          </p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {/* View toggle */}
          <div className="view-toggle">
            <button
              className={`view-toggle-btn${viewMode === "coding" ? " active" : ""}`}
              onClick={() => setViewMode("coding")}
            >
              Coding
            </button>
            <button
              className={`view-toggle-btn${viewMode === "map" ? " active" : ""}`}
              onClick={() => setViewMode("map")}
            >
              Concept Map
            </button>
          </div>
          <button className="btn-ghost btn-sm" onClick={() => openAddCode(undefined)}>
            + Concept
          </button>
          <button className="btn-primary" onClick={() => setShowCreateTheme(true)}>
            + Category
          </button>
        </div>
      </div>

      {/* Body — Concept Map view */}
      {viewMode === "map" && (
        <ConceptMapView
          themes={themes}
          ungroupedCodes={ungrouped_codes}
          onSelectCode={(id) => { setSelectedCodeId(id); setViewMode("coding"); }}
        />
      )}

      {/* Body — Coding workspace */}
      <div style={{ display: viewMode === "coding" ? "flex" : "none", flex: 1, overflow: "hidden" }}>
        {/* Left: theme/code tree */}
        <div
          style={{
            width: 280,
            flexShrink: 0,
            borderRight: "1px solid var(--border)",
            overflowY: "auto",
            padding: "0.75rem 0.5rem",
          }}
        >
          {themes.length === 0 && ungrouped_codes.length === 0 ? (
            <div style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.875rem" }}>
              <p>No themes or codes yet.</p>
              <p>Create a theme, then add codes to start your analysis.</p>
            </div>
          ) : (
            <>
              {themes.map((theme) => (
                <ThemeSection
                  key={theme.id}
                  theme={theme}
                  selectedCodeId={selectedCodeId}
                  onSelect={(code, themeId) => {
                    setSelectedCodeId(code.id);
                    setSelectedThemeId(themeId);
                  }}
                  onAddCode={(themeId) => openAddCode(themeId)}
                  onDeleteTheme={(themeId) => deleteThemeMut.mutate(themeId)}
                  projectId={projectId}
                />
              ))}
              {ungrouped_codes.length > 0 && (
                <div style={{ marginTop: "0.5rem" }}>
                  <div
                    style={{
                      fontSize: "0.72rem",
                      color: "var(--text-muted)",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      padding: "0.25rem 0.5rem",
                    }}
                  >
                    Ungrouped ({ungrouped_codes.length})
                  </div>
                  {ungrouped_codes.map((code) => (
                    <CodeRow
                      key={code.id}
                      code={code}
                      selected={selectedCodeId === code.id}
                      onSelect={() => {
                        setSelectedCodeId(code.id);
                        setSelectedThemeId(null);
                      }}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Right: code detail */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {selectedEntry ? (
            <CodeDetail
              key={selectedEntry.code.id}
              projectId={projectId}
              code={selectedEntry.code}
              themes={themes}
              currentThemeId={selectedEntry.themeId}
              onDeselect={() => { setSelectedCodeId(null); setSelectedThemeId(null); }}
            />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--text-muted)",
                fontSize: "0.9rem",
                textAlign: "center",
              }}
            >
              <div>
                <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🗂</div>
                <p>Select a code from the left panel to see its evidence and history.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showCreateTheme && (
        <CreateThemeModal projectId={projectId} onClose={() => setShowCreateTheme(false)} />
      )}
      {showCreateCode && (
        <CreateCodeModal
          projectId={projectId}
          themes={themes}
          defaultThemeId={createCodeThemeId}
          onClose={() => setShowCreateCode(false)}
        />
      )}
    </div>
  );
}

// ── Concept Map View ───────────────────────────────────────────────────────────

function ConceptMapView({
  themes,
  ungroupedCodes,
  onSelectCode,
}: {
  themes: ThemeItem[];
  ungroupedCodes: ThemeCode[];
  onSelectCode: (id: string) => void;
}) {
  return (
    <div className="concept-map-scroll">
      <div className="concept-map-grid">
        {themes.map((theme) => (
          <div
            key={theme.id}
            className="concept-map-category"
            style={{ "--cat-color": theme.color ?? "#6366f1" } as React.CSSProperties}
          >
            <div className="concept-map-category-header">
              <span className="concept-map-dot" style={{ background: theme.color ?? "#6366f1" }} />
              <span className="concept-map-category-name">{theme.name}</span>
              <span className="concept-map-badge">{theme.codes.length}</span>
            </div>
            {theme.description && (
              <p className="concept-map-synthesis">{theme.description}</p>
            )}
            <div className="concept-map-concepts">
              {theme.codes.map((code) => (
                <button
                  key={code.id}
                  className="concept-map-concept"
                  onClick={() => onSelectCode(code.id)}
                  style={{ borderColor: code.color ?? theme.color ?? "#6366f1" }}
                >
                  <span
                    className="concept-map-dot"
                    style={{ background: code.color ?? theme.color ?? "#6366f1", width: 8, height: 8 }}
                  />
                  <span style={{ flex: 1, textAlign: "left" }}>{code.name}</span>
                  {code.evidence_count > 0 && (
                    <span className="concept-map-evidence-badge">{code.evidence_count}</span>
                  )}
                </button>
              ))}
              {theme.codes.length === 0 && (
                <p className="concept-map-empty">No concepts yet — add one from the Coding view</p>
              )}
            </div>
          </div>
        ))}

        {ungroupedCodes.length > 0 && (
          <div className="concept-map-category concept-map-ungrouped">
            <div className="concept-map-category-header">
              <span className="concept-map-category-name" style={{ color: "var(--text-muted)" }}>
                Ungrouped concepts
              </span>
              <span className="concept-map-badge">{ungroupedCodes.length}</span>
            </div>
            <div className="concept-map-concepts">
              {ungroupedCodes.map((code) => (
                <button
                  key={code.id}
                  className="concept-map-concept"
                  onClick={() => onSelectCode(code.id)}
                >
                  <span style={{ flex: 1, textAlign: "left" }}>{code.name}</span>
                  {code.evidence_count > 0 && (
                    <span className="concept-map-evidence-badge">{code.evidence_count}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {themes.length === 0 && ungroupedCodes.length === 0 && (
          <div style={{ padding: "3rem", color: "var(--text-muted)", textAlign: "center" }}>
            <p>No categories or concepts yet.</p>
            <p style={{ fontSize: "0.85rem" }}>
              Switch to Coding view to create a category, then add concepts to it.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared styles ──────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const modalStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  padding: "1.5rem",
  width: "100%",
  maxWidth: 440,
  boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.8rem",
  fontWeight: 500,
  color: "var(--text-muted)",
  marginBottom: 4,
  marginTop: "0.75rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.6rem",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.875rem",
  boxSizing: "border-box",
};