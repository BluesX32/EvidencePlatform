/**
 * ConceptPicker — inline concept assignment for ScreeningWorkspace.
 *
 * Concepts = thematic analysis / taxonomy words (e.g. disease severity terms).
 * Stored as ontology nodes with namespace = "thematic".
 * Empty by default; users add words manually.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ontologyApi, conceptsApi, type OntologyNode } from "../api/client";

interface Props {
  projectId: string;
  recordId?: string | null;
  clusterId?: string | null;
}

const CONCEPT_COLOR = "#7c3aed";

export default function ConceptPicker({ projectId, recordId, clusterId }: Props) {
  const qc = useQueryClient();
  const itemKey = recordId ?? clusterId;
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");

  // Only thematic-namespace nodes
  const { data: allNodes = [] } = useQuery<OntologyNode[]>({
    queryKey: ["ontology", projectId],
    queryFn: () => ontologyApi.list(projectId).then((r) => r.data),
  });
  const conceptNodes = allNodes.filter((n) => n.namespace === "thematic");

  const { data: itemNodes = [] } = useQuery<OntologyNode[]>({
    queryKey: ["item-concepts", projectId, itemKey],
    queryFn: () =>
      conceptsApi.getItemConcepts(projectId, {
        record_id: recordId ?? undefined,
        cluster_id: clusterId ?? undefined,
      }).then((r) => r.data),
    enabled: !!itemKey,
  });
  const assignedIds = new Set(itemNodes.map((n) => n.id));

  const assignMut = useMutation({
    mutationFn: (nodeId: string) =>
      conceptsApi.assign(projectId, { record_id: recordId ?? null, cluster_id: clusterId ?? null, node_id: nodeId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["item-concepts", projectId, itemKey] }),
  });

  const unassignMut = useMutation({
    mutationFn: (nodeId: string) =>
      conceptsApi.unassign(projectId, { record_id: recordId ?? null, cluster_id: clusterId ?? null, node_id: nodeId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["item-concepts", projectId, itemKey] }),
  });

  const createAndAssignMut = useMutation({
    mutationFn: async (name: string) => {
      const created = await ontologyApi.create(projectId, { name: name.trim(), namespace: "thematic" });
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
    if (assignedIds.has(nodeId)) unassignMut.mutate(nodeId);
    else assignMut.mutate(nodeId);
  };

  const submitNew = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const exists = conceptNodes.find((n) => n.name.toLowerCase() === trimmed.toLowerCase());
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
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Concepts
        </span>
        <span style={{ fontSize: 11, color: "#9ca3af" }}>— thematic analysis / taxonomy</span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
        {conceptNodes.map((node) => {
          const active = assignedIds.has(node.id);
          const color = node.color ?? CONCEPT_COLOR;
          return (
            <button
              key={node.id}
              onClick={() => toggle(node.id)}
              title={active ? `Remove "${node.name}"` : `Tag with "${node.name}"`}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "2px 9px", borderRadius: 4,
                border: `1.5px solid ${color}`,
                background: active ? color : "transparent",
                color: active ? "#fff" : color,
                fontSize: 12, fontWeight: 500, cursor: "pointer", transition: "all 0.12s", lineHeight: 1.5,
              }}
            >
              {active && <span style={{ fontSize: 9, lineHeight: 1 }}>✓</span>}
              {node.name}
            </button>
          );
        })}

        {conceptNodes.length === 0 && !adding && (
          <span style={{ fontSize: 11, color: "#d1d5db", fontStyle: "italic" }}>No concepts yet — add below</span>
        )}

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
              placeholder="e.g. mild, moderate, severe…"
              style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, border: "1px solid #d1d5db", outline: "none", width: 170 }}
              disabled={createAndAssignMut.isPending}
            />
            <button
              onClick={submitNew}
              disabled={!newName.trim() || createAndAssignMut.isPending}
              style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "none", background: CONCEPT_COLOR, color: "#fff", cursor: "pointer" }}
            >
              Add
            </button>
            <button
              onClick={() => { setAdding(false); setNewName(""); }}
              style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, border: "none", background: "transparent", color: "#9ca3af", cursor: "pointer" }}
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            title="Add a new concept word"
            style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px dashed #c4b5fd", background: "transparent", color: "#7c3aed", cursor: "pointer" }}
          >
            + add concept
          </button>
        )}
      </div>
    </div>
  );
}
