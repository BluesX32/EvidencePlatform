/**
 * LabelPicker — inline label assignment widget for ScreeningWorkspace.
 *
 * Shows all project labels as toggleable chips.
 * Toggling a chip assigns or unassigns the label for the current article.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { labelsApi, type ProjectLabel } from "../api/client";

interface Props {
  projectId: string;
  recordId?: string | null;
  clusterId?: string | null;
}

export default function LabelPicker({ projectId, recordId, clusterId }: Props) {
  const qc = useQueryClient();
  const itemKey = recordId ?? clusterId;

  // All project labels
  const { data: allLabels = [] } = useQuery<ProjectLabel[]>({
    queryKey: ["labels", projectId],
    queryFn: () => labelsApi.list(projectId).then((r) => r.data),
  });

  // Labels currently applied to this item
  const { data: itemLabels = [] } = useQuery<ProjectLabel[]>({
    queryKey: ["item-labels", projectId, itemKey],
    queryFn: () =>
      labelsApi
        .getItemLabels(projectId, {
          record_id: recordId ?? undefined,
          cluster_id: clusterId ?? undefined,
        })
        .then((r) => r.data),
    enabled: !!itemKey,
  });

  const assignedIds = new Set(itemLabels.map((l) => l.id));

  const assignMut = useMutation({
    mutationFn: (labelId: string) =>
      labelsApi.assign(projectId, {
        record_id: recordId ?? null,
        cluster_id: clusterId ?? null,
        label_id: labelId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item-labels", projectId, itemKey] });
      qc.invalidateQueries({ queryKey: ["labeled-articles", projectId] });
    },
  });

  const unassignMut = useMutation({
    mutationFn: (labelId: string) =>
      labelsApi.unassign(projectId, {
        record_id: recordId ?? null,
        cluster_id: clusterId ?? null,
        label_id: labelId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item-labels", projectId, itemKey] });
      qc.invalidateQueries({ queryKey: ["labeled-articles", projectId] });
    },
  });

  if (allLabels.length === 0) return null;

  const toggle = (labelId: string) => {
    if (assignedIds.has(labelId)) {
      unassignMut.mutate(labelId);
    } else {
      assignMut.mutate(labelId);
    }
  };

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
        Labels
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
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
                gap: 5,
                padding: "3px 10px",
                borderRadius: 999,
                border: `2px solid ${lbl.color}`,
                background: active ? lbl.color : "transparent",
                color: active ? "#fff" : lbl.color,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {active && <span style={{ fontSize: 10 }}>✓</span>}
              {lbl.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
