/**
 * LabelManager — create, rename, recolor, and delete project-level labels.
 *
 * Rendered as a collapsible panel inside ProjectPage.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { labelsApi, type ProjectLabel } from "../api/client";

// ── Preset color palette ────────────────────────────────────────────────────

const PALETTE = [
  "#6366f1", // indigo
  "#3b82f6", // blue
  "#06b6d4", // cyan
  "#10b981", // emerald
  "#84cc16", // lime
  "#eab308", // yellow
  "#f97316", // orange
  "#ef4444", // red
  "#ec4899", // pink
  "#8b5cf6", // violet
  "#14b8a6", // teal
  "#f59e0b", // amber
];

interface Props {
  projectId: string;
}

export default function LabelManager({ projectId }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(PALETTE[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: labels = [] } = useQuery<ProjectLabel[]>({
    queryKey: ["labels", projectId],
    queryFn: () => labelsApi.list(projectId).then((r) => r.data),
    enabled: open,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["labels", projectId] });

  const createMut = useMutation({
    mutationFn: () => labelsApi.create(projectId, { name: newName.trim(), color: newColor }),
    onSuccess: () => {
      setNewName("");
      setError(null);
      invalidate();
    },
    onError: (e: any) => {
      setError(e?.response?.data?.detail ?? "Failed to create label");
    },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, name, color }: { id: string; name: string; color: string }) =>
      labelsApi.update(projectId, id, { name: name.trim(), color }),
    onSuccess: () => {
      setEditingId(null);
      setError(null);
      invalidate();
    },
    onError: (e: any) => {
      setError(e?.response?.data?.detail ?? "Failed to update label");
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => labelsApi.delete(projectId, id),
    onSuccess: () => invalidate(),
  });

  const startEdit = (lbl: ProjectLabel) => {
    setEditingId(lbl.id);
    setEditName(lbl.name);
    setEditColor(lbl.color);
    setError(null);
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    createMut.mutate();
  };

  const handleUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId || !editName.trim()) return;
    updateMut.mutate({ id: editingId, name: editName, color: editColor });
  };

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
      {/* Header */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 16px",
          background: "#f9fafb",
          border: "none",
          cursor: "pointer",
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        <span>🏷️ Labels</span>
        <span style={{ color: "#9ca3af" }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ padding: 16 }}>
          {/* Error banner */}
          {error && (
            <div style={{ marginBottom: 10, padding: "6px 10px", background: "#fee2e2", borderRadius: 6, color: "#b91c1c", fontSize: 13 }}>
              {error}
            </div>
          )}

          {/* Existing labels */}
          <div style={{ marginBottom: 14 }}>
            {labels.length === 0 && (
              <p style={{ color: "#9ca3af", fontSize: 13 }}>No labels yet. Create one below.</p>
            )}
            {labels.map((lbl) =>
              editingId === lbl.id ? (
                /* Edit row */
                <form
                  key={lbl.id}
                  onSubmit={handleUpdate}
                  style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}
                >
                  <ColorPicker value={editColor} onChange={setEditColor} />
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    style={inputStyle}
                    autoFocus
                  />
                  <button type="submit" style={btnStyle("#10b981")}>Save</button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    style={btnStyle("#6b7280")}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                /* Display row */
                <div
                  key={lbl.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 6,
                    padding: "4px 8px",
                    borderRadius: 6,
                    background: "#f9fafb",
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      background: lbl.color,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ flex: 1, fontSize: 13 }}>{lbl.name}</span>
                  <button
                    onClick={() => startEdit(lbl)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#6b7280", fontSize: 12 }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete label "${lbl.name}"? This will remove it from all articles.`)) {
                        deleteMut.mutate(lbl.id);
                      }
                    }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#ef4444", fontSize: 12 }}
                  >
                    ✕
                  </button>
                </div>
              )
            )}
          </div>

          {/* Create form */}
          <form onSubmit={handleCreate} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <ColorPicker value={newColor} onChange={setNewColor} />
            <input
              placeholder="New label name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              type="submit"
              disabled={!newName.trim() || createMut.isPending}
              style={btnStyle("#6366f1")}
            >
              Add
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

// ── Color picker (palette grid) ─────────────────────────────────────────────

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: value,
          border: "2px solid #fff",
          boxShadow: "0 0 0 1px #d1d5db",
          cursor: "pointer",
          flexShrink: 0,
        }}
      />
      {open && (
        <div
          style={{
            position: "absolute",
            top: 28,
            left: 0,
            zIndex: 50,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: 8,
            display: "grid",
            gridTemplateColumns: "repeat(4, 22px)",
            gap: 4,
            boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
          }}
        >
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
              style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: c,
                border: value === c ? "2px solid #1f2937" : "2px solid transparent",
                cursor: "pointer",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shared micro-styles ──────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 13,
  outline: "none",
};

const btnStyle = (bg: string): React.CSSProperties => ({
  background: bg,
  color: "#fff",
  border: "none",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
  whiteSpace: "nowrap",
});