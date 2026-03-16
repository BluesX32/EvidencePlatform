/**
 * ConceptPicker — inline ontology concept assignment for ScreeningWorkspace.
 *
 * Shows ontology nodes (namespace = "concept") as toggleable chips.
 * Includes an inline "+" input to create a new concept node and immediately assign it.
 * Newly created nodes are saved to the project ontology and available in future sessions.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ontologyApi, conceptsApi, type OntologyNode } from "../api/client";

interface Props {
  projectId: string;
  recordId?: string | null;
  clusterId?: string | null;
}

// Namespace color map (mirrors OntologyTree.tsx NS_COLORS)
const CONCEPT_COLOR = "#7c3aed";

export default function ConceptPicker({ projectId, recordId, clusterId }: Props) {
  const qc = useQueryClient();
  const itemKey = recordId ?? clusterId;
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");

  // All ontology nodes for this project
  const { data: allNodes = [] } = useQuery<OntologyNode[]>({
    queryKey: ["ontology", projectId],
    queryFn: () => ontologyApi.list(projectId).then((r) => r.data),
  });

  // Only concept-namespace nodes shown as selectable chips
  const conceptNodes = allNodes.filter((n) => n.namespace === "concept");

  // Nodes currently assigned to this item
  const { data: itemNodes = [] } = useQuery<OntologyNode[]>({
    queryKey: ["item-concepts", projectId, itemKey],
    queryFn: () =>
      conceptsApi
        .getItemConcepts(projectId, {
          record_id: recordId ?? undefined,
          cluster_id: clusterId ?? undefined,
        })
        .then((r) => r.data),
    enabled: !!itemKey,
  });

  const assignedIds = new Set(itemNodes.map((n) => n.id));

  const assignMut = useMutation({
    mutationFn: (nodeId: string) =>
      conceptsApi.assign(projectId, {
        record_id: recordId ?? null,
        cluster_id: clusterId ?? null,
        node_id: nodeId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item-concepts", projectId, itemKey] });
    },
  });

  const unassignMut = useMutation({
    mutationFn: (nodeId: string) =>
      conceptsApi.unassign(projectId, {
        record_id: recordId ?? null,
        cluster_id: clusterId ?? null,
        node_id: nodeId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item-concepts", projectId, itemKey] });
    },
  });

  const createAndAssignMut = useMutation({
    mutationFn: async (name: string) => {
      const created = await ontologyApi.create(projectId, {
        name: name.trim(),
        namespace: "concept",
      });
      await conceptsApi.assign(projectId, {
        record_id: recordId ?? null,
        cluster_id: clusterId ?? null,
        node_id: created.data.id,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ontology", projectId] });
      qc.invalidateQueries({ queryKey: ["item-concepts", projectId, itemKey] });
      setNewName("");
      setAdding(false);
    },
  });

  const toggle = (nodeId: string) => {
    if (assignedIds.has(nodeId)) {
      unassignMut.mutate(nodeId);
    } else {
      assignMut.mutate(nodeId);
    }
  };

  const submitNew = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const exists = conceptNodes.find(
      (n) => n.name.toLowerCase() === trimmed.toLowerCase()
    );
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
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "#6b7280",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 6,
        }}
      >
        Concepts
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {conceptNodes.map((node) => {
          const active = assignedIds.has(node.id);
          const color = node.color ?? CONCEPT_COLOR;
          return (
            <button
              key={node.id}
              onClick={() => toggle(node.id)}
              title={active ? `Remove "${node.name}"` : `Tag "${node.name}"`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 10px",
                borderRadius: 999,
                border: `2px solid ${color}`,
                background: active ? color : "transparent",
                color: active ? "#fff" : color,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {active && <span style={{ fontSize: 10 }}>✓</span>}
              {node.name}
            </button>
          );
        })}

        {adding ? (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNew();
                if (e.key === "Escape") { setAdding(false); setNewName(""); }
              }}
              placeholder="Concept name…"
              style={{
                fontSize: 12,
                padding: "2px 8px",
                borderRadius: 999,
                border: "1px solid #d1d5db",
                outline: "none",
                width: 130,
              }}
              disabled={createAndAssignMut.isPending}
            />
            <button
              onClick={submitNew}
              disabled={!newName.trim() || createAndAssignMut.isPending}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                border: "none",
                background: CONCEPT_COLOR,
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Add
            </button>
            <button
              onClick={() => { setAdding(false); setNewName(""); }}
              style={{
                fontSize: 11,
                padding: "2px 6px",
                borderRadius: 999,
                border: "none",
                background: "transparent",
                color: "#9ca3af",
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            title="Tag with a new concept"
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
            + new
          </button>
        )}
      </div>
    </div>
  );
}
