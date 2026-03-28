/**
 * LabelPicker — inline label assignment widget for ScreeningWorkspace.
 *
 * Labels = anything users want to create: free-form tags for organizing papers.
 */
import { useState, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { labelsApi, type ProjectLabel } from "../api/client";

interface Props {
  projectId: string;
  recordId?: string | null;
  clusterId?: string | null;
}

const LABEL_COLORS = [
  "#6366f1", "#0ea5e9", "#10b981", "#f59e0b",
  "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6",
];

export default function LabelPicker({ projectId, recordId, clusterId }: Props) {
  const qc = useQueryClient();
  const itemKey = recordId ?? clusterId;
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: allLabels = [] } = useQuery<ProjectLabel[]>({
    queryKey: ["labels", projectId],
    queryFn: () => labelsApi.list(projectId).then((r) => r.data),
  });

  const { data: itemLabels = [] } = useQuery<ProjectLabel[]>({
    queryKey: ["item-labels", projectId, itemKey],
    queryFn: () =>
      labelsApi.getItemLabels(projectId, {
        record_id: recordId ?? undefined,
        cluster_id: clusterId ?? undefined,
      }).then((r) => r.data),
    enabled: !!itemKey,
  });

  const assignedIds = new Set(itemLabels.map((l) => l.id));

  const assignMut = useMutation({
    mutationFn: (labelId: string) =>
      labelsApi.assign(projectId, { record_id: recordId ?? null, cluster_id: clusterId ?? null, label_id: labelId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item-labels", projectId, itemKey] });
      qc.invalidateQueries({ queryKey: ["labeled-articles", projectId] });
    },
  });

  const unassignMut = useMutation({
    mutationFn: (labelId: string) =>
      labelsApi.unassign(projectId, { record_id: recordId ?? null, cluster_id: clusterId ?? null, label_id: labelId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item-labels", projectId, itemKey] });
      qc.invalidateQueries({ queryKey: ["labeled-articles", projectId] });
    },
  });

  const createAndAssignMut = useMutation({
    mutationFn: async (name: string) => {
      const color = LABEL_COLORS[allLabels.length % LABEL_COLORS.length];
      const created = await labelsApi.create(projectId, { name: name.trim(), color });
      await labelsApi.assign(projectId, {
        record_id: recordId ?? null,
        cluster_id: clusterId ?? null,
        label_id: created.data.id,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["labels", projectId] });
      qc.invalidateQueries({ queryKey: ["item-labels", projectId, itemKey] });
      qc.invalidateQueries({ queryKey: ["labeled-articles", projectId] });
      setNewName("");
      setAdding(false);
    },
  });

  const toggle = (labelId: string) => {
    if (assignedIds.has(labelId)) unassignMut.mutate(labelId);
    else assignMut.mutate(labelId);
  };

  const submitNew = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const exists = allLabels.find((l) => l.name.toLowerCase() === trimmed.toLowerCase());
    if (exists) {
      if (!assignedIds.has(exists.id)) assignMut.mutate(exists.id);
      setNewName("");
      setAdding(false);
      return;
    }
    createAndAssignMut.mutate(trimmed);
  };

  return (
    <div>
      {/* Section header — click to collapse */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: collapsed ? 0 : 6, background: "none", border: "none", padding: 0, cursor: "pointer", width: "100%", textAlign: "left" }}
      >
        <span style={{ fontSize: 10, color: "#9ca3af", lineHeight: 1 }}>{collapsed ? "▸" : "▾"}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Labels
        </span>
        {collapsed ? (
          <span style={{ fontSize: 11, color: "#9ca3af" }}>
            {assignedIds.size > 0 ? `${assignedIds.size} assigned` : allLabels.length > 0 ? `${allLabels.length} available` : "none"}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: "#9ca3af" }}>— anything you want to tag this paper with</span>
        )}
      </button>

      {!collapsed && <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
        {allLabels.map((lbl) => {
          const active = assignedIds.has(lbl.id);
          return (
            <button
              key={lbl.id}
              onClick={() => toggle(lbl.id)}
              title={active ? `Remove "${lbl.name}"` : `Add "${lbl.name}"`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 9px",
                borderRadius: 999,
                border: `1.5px solid ${lbl.color}`,
                background: active ? lbl.color : "transparent",
                color: active ? "#fff" : lbl.color,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                transition: "all 0.12s",
                lineHeight: 1.5,
              }}
            >
              {active && <span style={{ fontSize: 9, lineHeight: 1 }}>✓</span>}
              {lbl.name}
            </button>
          );
        })}

        {allLabels.length === 0 && !adding && (
          <span style={{ fontSize: 11, color: "#d1d5db", fontStyle: "italic" }}>No labels yet</span>
        )}

        {adding ? (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <input
              ref={inputRef}
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNew();
                if (e.key === "Escape") { setAdding(false); setNewName(""); }
              }}
              placeholder="Label name…"
              style={{
                fontSize: 12,
                padding: "2px 8px",
                borderRadius: 999,
                border: "1px solid #d1d5db",
                outline: "none",
                width: 110,
              }}
              disabled={createAndAssignMut.isPending}
            />
            <button
              onClick={submitNew}
              disabled={!newName.trim() || createAndAssignMut.isPending}
              style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, border: "none", background: "#6366f1", color: "#fff", cursor: "pointer" }}
            >
              Add
            </button>
            <button
              onClick={() => { setAdding(false); setNewName(""); }}
              style={{ fontSize: 11, padding: "2px 6px", borderRadius: 999, border: "none", background: "transparent", color: "#9ca3af", cursor: "pointer" }}
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={() => { setAdding(true); setTimeout(() => inputRef.current?.focus(), 0); }}
            title="Create and assign a new label"
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 999,
              border: "1px dashed #d1d5db",
              background: "transparent",
              color: "#9ca3af",
              cursor: "pointer",
            }}
          >
            + new label
          </button>
        )}
      </div>}
    </div>
  );
}
