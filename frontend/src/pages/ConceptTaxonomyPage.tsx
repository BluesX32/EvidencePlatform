/**
 * ConceptTaxonomyPage — aggregated concept view with hierarchy and merge.
 *
 * Features:
 *  - Flat list (default) and Tree view toggle
 *  - Parent-child via drag-and-drop OR "Set parent" dropdown
 *  - Multi-select + Merge to canonical
 *  - Push selected to Ontology
 */
import { useMemo, useState, useRef, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  conceptExtractionApi,
  conceptTaxonomyApi,
  projectsApi,
  aiPilotApi,
  type ConceptTaxonomyEntry,
  type ConceptFieldType,
  type ConceptTaxonomyNode,
} from "../api/client";
import { useReviewerView } from "../context/ReviewerViewContext";
import { useToast } from "../components/Feedback";

// ── Constants ────────────────────────────────────────────────────────────────

const TAB_LABELS: Record<string, string> = {
  entity: "Entities",
  relation: "Relations",
  metadata: "Other",
};
const TAB_COLORS: Record<string, string> = {
  entity: "#4f46e5",
  relation: "#0891b2",
  metadata: "#6b7280",
};
const NAMESPACE_DEFAULTS: Record<string, string> = {
  entity: "concept",
  relation: "relationships",
  metadata: "concept",
};

// ── Types ────────────────────────────────────────────────────────────────────

/** A unified view entry — either a raw value or a curated taxonomy node. */
interface ViewEntry {
  /** Unique React key */
  key: string;
  value: string;
  count: number;
  record_ids: string[];
  field_id: string;
  field_label: string;
  field_type: ConceptFieldType;
  /** If promoted to a taxonomy node */
  node: ConceptTaxonomyNode | null;
  /** Aliases for display (merged values) */
  aliases: string[];
}

interface TreeEntry extends ViewEntry {
  children: TreeEntry[];
  depth: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildViewEntries(
  tabData: ConceptTaxonomyEntry[],
  nodes: ConceptTaxonomyNode[],
  fieldType: ConceptFieldType,
): ViewEntry[] {
  const tabNodes = nodes.filter(n => n.field_type === fieldType);

  // Map each extracted value → node (by name or alias)
  const valueToNode = new Map<string, ConceptTaxonomyNode>();
  for (const node of tabNodes) {
    valueToNode.set(node.name.toLowerCase(), node);
    for (const alias of node.aliases) {
      valueToNode.set(alias.toLowerCase(), node);
    }
  }

  // Aggregate counts per node (canonical name → total)
  const nodeCountMap = new Map<string, { count: number; record_ids: string[] }>();
  const unmappedEntries: ConceptTaxonomyEntry[] = [];

  for (const entry of tabData) {
    const node = valueToNode.get(entry.value.toLowerCase());
    if (node) {
      const key = node.id;
      const cur = nodeCountMap.get(key) ?? { count: 0, record_ids: [] };
      nodeCountMap.set(key, {
        count: cur.count + entry.count,
        record_ids: [...cur.record_ids, ...entry.record_ids],
      });
    } else {
      unmappedEntries.push(entry);
    }
  }

  const result: ViewEntry[] = [];

  // Nodes (with merged counts) — only include nodes that have at least one
  // concept extraction from the current user (enforces the zipper model: a
  // reviewer sees only their own extracted concepts; curated nodes with no
  // matching extractions are invisible to them).
  for (const node of tabNodes) {
    const agg = nodeCountMap.get(node.id) ?? { count: 0, record_ids: [] };
    if (agg.count === 0) continue;
    const fieldInfo = tabData.find(e => valueToNode.get(e.value.toLowerCase())?.id === node.id);
    result.push({
      key: `node:${node.id}`,
      value: node.name,
      count: agg.count,
      record_ids: Array.from(new Set(agg.record_ids)),
      field_id: node.field_id,
      field_label: fieldInfo?.field_label ?? node.field_id,
      field_type: node.field_type as ConceptFieldType,
      node,
      aliases: node.aliases,
    });
  }

  // Unattached raw values
  for (const entry of unmappedEntries) {
    result.push({
      key: `raw:${entry.field_id}::${entry.value}`,
      value: entry.value,
      count: entry.count,
      record_ids: entry.record_ids,
      field_id: entry.field_id,
      field_label: entry.field_label,
      field_type: entry.field_type,
      node: null,
      aliases: [],
    });
  }

  return result.sort((a, b) => b.count - a.count);
}

function buildTree(entries: ViewEntry[]): TreeEntry[] {
  const nodeEntries = entries.filter(e => e.node !== null);
  const rawEntries = entries.filter(e => e.node === null);

  const byNodeId = new Map<string, TreeEntry>(
    nodeEntries.map(e => [e.node!.id, { ...e, children: [], depth: 0 }])
  );

  const roots: TreeEntry[] = [];

  for (const te of byNodeId.values()) {
    const parentId = te.node!.parent_id;
    if (!parentId || !byNodeId.has(parentId)) {
      roots.push(te);
    } else {
      byNodeId.get(parentId)!.children.push(te);
    }
  }

  // Assign depths
  function assignDepth(entry: TreeEntry, depth: number) {
    entry.depth = depth;
    for (const child of entry.children) assignDepth(child, depth + 1);
  }
  for (const root of roots) assignDepth(root, 0);

  // Sort each level by count desc
  function sortChildren(entry: TreeEntry) {
    entry.children.sort((a, b) => b.count - a.count);
    for (const c of entry.children) sortChildren(c);
  }
  roots.sort((a, b) => b.count - a.count);
  for (const root of roots) sortChildren(root);

  // Unattached raw values as pseudo-roots at depth 0
  const rawTreeEntries: TreeEntry[] = rawEntries.map(e => ({ ...e, children: [], depth: 0 }));

  return [...roots, ...rawTreeEntries];
}

function flattenTree(trees: TreeEntry[]): TreeEntry[] {
  const result: TreeEntry[] = [];
  function visit(entry: TreeEntry) {
    result.push(entry);
    for (const child of entry.children) visit(child);
  }
  for (const root of trees) visit(root);
  return result;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AliasBadges({ aliases, color }: { aliases: string[]; color: string }) {
  if (!aliases.length) return null;
  return (
    <span style={{ display: "flex", gap: "0.2rem", flexWrap: "wrap" }}>
      {aliases.map(a => (
        <span key={a} style={{
          fontSize: "0.68rem", padding: "0 0.35rem", borderRadius: 99,
          background: `${color}18`, border: `1px solid ${color}44`, color,
        }}>
          {a}
        </span>
      ))}
    </span>
  );
}

// ── Merge modal ───────────────────────────────────────────────────────────────

function MergeModal({ selected, entries, projectId, fieldType, onClose, onDone }: {
  selected: Set<string>;
  entries: ViewEntry[];
  projectId: string;
  fieldType: ConceptFieldType;
  onClose: () => void;
  onDone: () => void;
}) {
  const selectedEntries = entries.filter(e => selected.has(e.key));
  const [canonicalName, setCanonicalName] = useState(selectedEntries[0]?.value ?? "");
  const qc = useQueryClient();
  const toast = useToast();

  const mergeMut = useMutation({
    mutationFn: () => {
      const nodeIds = selectedEntries.filter(e => e.node).map(e => e.node!.id);
      const extraValues = selectedEntries
        .filter(e => !e.node)
        .map(e => ({ name: e.value, field_id: e.field_id, field_type: e.field_type }));
      const fieldId = selectedEntries[0]?.field_id ?? "";
      return conceptTaxonomyApi.mergeNodes(projectId, {
        node_ids: nodeIds,
        extra_values: extraValues.length ? extraValues : undefined,
        canonical_name: canonicalName.trim(),
        field_id: fieldId,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["concept-taxonomy-nodes", projectId] });
      onDone();
    },
    onError: () => toast("Merge failed — please try again.", "error"),
  });

  const color = TAB_COLORS[fieldType];

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div className="card" style={{ width: 440, maxWidth: "95vw", padding: "1.5rem" }}>
        <h3 style={{ marginTop: 0, marginBottom: "1rem", fontSize: "1rem", fontWeight: 700 }}>
          Merge {selectedEntries.length} concept{selectedEntries.length !== 1 ? "s" : ""}
        </h3>

        <div className="field" style={{ marginBottom: "1rem" }}>
          <label>Canonical name (surviving concept)</label>
          <input
            value={canonicalName}
            onChange={e => setCanonicalName(e.target.value)}
            placeholder="Enter canonical name…"
            style={{ fontSize: "0.875rem" }}
            autoFocus
          />
        </div>

        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
          These values become aliases:
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", marginBottom: "1.25rem" }}>
          {selectedEntries.map(e => (
            <span key={e.key} style={{
              fontSize: "0.8rem", padding: "0.15rem 0.5rem", borderRadius: 99,
              background: `${color}18`, border: `1px solid ${color}44`, color,
            }}>
              {e.value}
              {e.aliases.length > 0 && <span style={{ opacity: 0.6 }}> +{e.aliases.length}</span>}
            </span>
          ))}
        </div>

        <div style={{ display: "flex", gap: "0.6rem", justifyContent: "flex-end" }}>
          <button className="btn-ghost btn-sm" onClick={onClose} disabled={mergeMut.isPending}>
            Cancel
          </button>
          <button
            className="btn-primary btn-sm"
            onClick={() => mergeMut.mutate()}
            disabled={!canonicalName.trim() || mergeMut.isPending}
          >
            {mergeMut.isPending ? "Merging…" : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Parent picker dropdown ────────────────────────────────────────────────────

function ParentPicker({ entry, allEntries, projectId, fieldType, onClose }: {
  entry: ViewEntry;
  allEntries: ViewEntry[];
  projectId: string;
  fieldType: ConceptFieldType;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [_parentKey, _setParentKey] = useState(entry.node?.parent_id ?? "");

  const candidates = allEntries.filter(e =>
    e.key !== entry.key &&
    !(e.node?.id === entry.node?.parent_id) &&
    // exclude self and its descendants when promoted
    true
  );

  const promoteMut = useMutation({
    mutationFn: async (parentNodeId: string | null) => {
      // Ensure child is a node
      let nodeId = entry.node?.id;
      if (!nodeId) {
        const created = await conceptTaxonomyApi.getOrCreateNode(projectId, {
          name: entry.value,
          field_id: entry.field_id,
          field_type: fieldType,
        });
        nodeId = created.data.id;
      }

      if (parentNodeId === null) {
        // Remove parent
        await conceptTaxonomyApi.updateNode(projectId, nodeId, { clear_parent: true });
      } else {
        // Ensure parent is also a node
        const parentEntry = allEntries.find(e => e.node?.id === parentNodeId || e.key === parentNodeId);
        let resolvedParentId = parentNodeId;
        if (parentEntry && !parentEntry.node) {
          const createdParent = await conceptTaxonomyApi.getOrCreateNode(projectId, {
            name: parentEntry.value,
            field_id: parentEntry.field_id,
            field_type: fieldType,
          });
          resolvedParentId = createdParent.data.id;
        }
        await conceptTaxonomyApi.updateNode(projectId, nodeId, { parent_id: resolvedParentId });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["concept-taxonomy-nodes", projectId] });
      onClose();
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail ?? "Failed to set parent";
      toast(msg, "error");
    },
  });

  return (
    <div style={{
      position: "absolute", top: "100%", right: 0, zIndex: 200,
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: "var(--radius)", boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
      minWidth: 260, maxHeight: 300, overflowY: "auto",
    }}>
      <div style={{
        padding: "0.5rem 0.75rem", fontSize: "0.75rem",
        fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase",
        borderBottom: "1px solid var(--border)", background: "var(--surface-2)",
      }}>
        Set parent concept
      </div>
      {entry.node?.parent_id && (
        <div
          onClick={() => promoteMut.mutate(null)}
          style={{
            padding: "0.5rem 0.75rem", cursor: "pointer", fontSize: "0.84rem",
            color: "#dc2626", borderBottom: "1px solid var(--border)",
          }}
        >
          Remove parent (make root)
        </div>
      )}
      {candidates.map(c => (
        <div
          key={c.key}
          onClick={() => promoteMut.mutate(c.node?.id ?? c.key)}
          style={{
            padding: "0.45rem 0.75rem", cursor: "pointer", fontSize: "0.84rem",
            color: "var(--text)",
            background: c.node?.id === entry.node?.parent_id ? "var(--brand-light)" : undefined,
          }}
          className="hover-surface"
        >
          {c.value}
          {c.node?.parent_id && (
            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginLeft: "0.3rem" }}>
              (child node)
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Entry row ─────────────────────────────────────────────────────────────────

function EntryRow({
  entry, depth, selected, onToggle, allEntries, projectId, fieldType, isDropTarget,
  onDragStart, onDragOver, onDragLeave, onDrop,
}: {
  entry: ViewEntry;
  depth: number;
  selected: boolean;
  onToggle: () => void;
  allEntries: ViewEntry[];
  projectId: string;
  fieldType: ConceptFieldType;
  isDropTarget: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const color = TAB_COLORS[entry.field_type] ?? "var(--text-muted)";
  const [showParentPicker, setShowParentPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  const handleParentClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowParentPicker(p => !p);
  }, []);

  return (
    <div
      draggable
      onDragStart={(e) => { e.stopPropagation(); onDragStart(); }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); onDragOver(e); }}
      onDragLeave={(e) => { e.stopPropagation(); onDragLeave(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(e); }}
      onClick={onToggle}
      style={{
        display: "grid",
        gridTemplateColumns: "28px 1fr auto 80px",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.45rem 0.75rem",
        paddingLeft: `calc(0.75rem + ${depth * 20}px)`,
        borderBottom: "1px solid var(--border)",
        borderTop: isDropTarget ? "2px solid var(--brand)" : undefined,
        background: selected
          ? "var(--brand-light)"
          : isDropTarget
          ? "#eff6ff"
          : depth > 0
          ? "var(--surface-2)"
          : "var(--surface)",
        cursor: "grab",
        transition: "background 0.1s",
        position: "relative",
      }}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        onClick={e => e.stopPropagation()}
        style={{ accentColor: color, cursor: "pointer" }}
      />

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
          {depth > 0 && (
            <span style={{ color: "var(--text-muted)", fontSize: "0.8rem", flexShrink: 0 }}>└</span>
          )}
          <span style={{
            fontSize: "0.875rem",
            fontWeight: selected ? 600 : entry.node ? 500 : 400,
            color: "var(--text)",
          }}>
            {entry.value}
          </span>
          {entry.node && <AliasBadges aliases={entry.aliases} color={color} />}
        </div>
        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.1rem", alignItems: "center" }}>
          <span className="badge truncate" style={{ fontSize: "0.7rem" }}>{entry.field_label}</span>
          {entry.node?.parent_id == null && entry.node && (
            <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>root</span>
          )}
        </div>
      </div>

      {/* Parent picker button */}
      <div style={{ position: "relative" }} ref={pickerRef}>
        <button
          className="btn-ghost btn-sm"
          onClick={handleParentClick}
          style={{ fontSize: "0.72rem", padding: "0.15rem 0.4rem", whiteSpace: "nowrap" }}
          title="Set parent concept"
        >
          {entry.node?.parent_id ? "↑ Reparent" : "Set parent"}
        </button>
        {showParentPicker && (
          <ParentPicker
            entry={entry}
            allEntries={allEntries}
            projectId={projectId}
            fieldType={fieldType}
            onClose={() => setShowParentPicker(false)}
          />
        )}
      </div>

      <span style={{
        fontSize: "0.8rem", fontWeight: 700, color, textAlign: "right", whiteSpace: "nowrap",
      }}>
        {entry.count} {entry.count === 1 ? "paper" : "papers"}
      </span>
    </div>
  );
}

// ── Push to ontology panel ────────────────────────────────────────────────────

function PushPanel({ projectId, tab, selected, allEntries, onSuccess }: {
  projectId: string; tab: ConceptFieldType; selected: Set<string>;
  allEntries: ViewEntry[]; onSuccess: () => void;
}) {
  const toast = useToast();
  const [namespace, setNamespace] = useState(NAMESPACE_DEFAULTS[tab] ?? "concept");
  const [parentId, setParentId] = useState<string>("");

  const { data: ontologyNodes = [] } = useQuery({
    queryKey: ["ontology", projectId],
    queryFn: () => import("../api/client").then(m => m.ontologyApi.list(projectId).then(r => r.data)),
    staleTime: 30_000,
  });

  const pushMut = useMutation({
    mutationFn: () => {
      const items = allEntries
        .filter(e => selected.has(e.key))
        .map(e => ({ value: e.value, field_type: e.field_type, namespace, parent_id: parentId || null }));
      return conceptExtractionApi.pushToOntology(projectId, items);
    },
    onSuccess: res => {
      const { created, skipped } = res.data;
      onSuccess();
      toast(`Pushed to ontology: ${created} created, ${skipped} already existed.`, "success");
    },
    onError: () => toast("Failed to push to ontology — please try again.", "error"),
  });

  const selectedEntries = allEntries.filter(e => selected.has(e.key));
  const color = TAB_COLORS[tab];

  return (
    <div className="card" style={{ marginBottom: "1rem", padding: "0.9rem 1rem" }}>
      <div style={{ fontWeight: 600, fontSize: "0.875rem", color: "var(--text)", marginBottom: "0.75rem" }}>
        Push {selectedEntries.length} selected concept{selectedEntries.length !== 1 ? "s" : ""} to Ontology
      </div>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Namespace</label>
          <select value={namespace} onChange={e => setNamespace(e.target.value)} style={{ fontSize: "0.84rem", width: "auto" }}>
            <option value="concept">concept</option>
            <option value="relationships">relationships</option>
            <option value="level">level</option>
            <option value="dimension">dimension</option>
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Parent node (optional)</label>
          <select value={parentId} onChange={e => setParentId(e.target.value)} style={{ fontSize: "0.84rem", maxWidth: 220 }}>
            <option value="">— no parent (root) —</option>
            {(ontologyNodes as any[]).map((n: any) => (
              <option key={n.id} value={n.id}>{n.name} [{n.namespace}]</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => pushMut.mutate()}
          disabled={selectedEntries.length === 0 || pushMut.isPending}
          className="btn-primary btn-sm"
        >
          {pushMut.isPending ? "Pushing…" : `Push ${selectedEntries.length} to Ontology`}
        </button>
      </div>
      {selectedEntries.length > 0 && (
        <div style={{ marginTop: "0.75rem", display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
          {selectedEntries.map(e => (
            <span key={e.key}
              className="badge truncate"
              style={{ background: `${color}18`, borderColor: `${color}55`, color, maxWidth: 200 }}
            >
              {e.value}
              {e.aliases.length > 0 && <span style={{ opacity: 0.6 }}> +{e.aliases.length}</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ConceptTaxonomyPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const { reviewerView } = useReviewerView();
  const activeReviewerView = reviewerView && reviewerView.projectId === projectId ? reviewerView : null;
  const asReviewerId = activeReviewerView?.reviewerId ?? null;

  const [activeTab, setActiveTab] = useState<ConceptFieldType>("entity");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkConceptModel] = useState("anthropic/claude-haiku-4-5");

  const bulkConceptStatus = useQuery({
    queryKey: ["bulk-concepts-status", projectId],
    queryFn: () => aiPilotApi.getBulkConceptsStatus(projectId!).then(r => r.data),
    enabled: !!projectId,
    refetchInterval: (q) => q.state.data?.status === "running" ? 2000 : false,
  });

  const bulkConceptMut = useMutation({
    mutationFn: () => aiPilotApi.startBulkConcepts(projectId!, { model: bulkConceptModel }),
    onSuccess: () => { bulkConceptStatus.refetch(); qc.invalidateQueries({ queryKey: ["concept-taxonomy-aggregate", projectId] }); },
  });
  const [search, setSearch] = useState("");
  const [fieldFilter, setFieldFilter] = useState<string>("__all__");
  const [viewMode, setViewMode] = useState<"flat" | "tree">("flat");
  const [merging, setMerging] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [_expandedNodes, _setExpandedNodes] = useState<Set<string>>(new Set());

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then(r => r.data),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  const { data: aggregate, isLoading: aggLoading, error: aggError } = useQuery({
    queryKey: ["concept-taxonomy-aggregate", projectId, asReviewerId],
    queryFn: () => conceptExtractionApi.getAggregate(projectId!, asReviewerId).then(r => r.data),
    enabled: !!projectId,
    staleTime: 30_000,
  });

  const { data: nodes = [], isLoading: nodesLoading } = useQuery({
    queryKey: ["concept-taxonomy-nodes", projectId],
    queryFn: () => conceptTaxonomyApi.listNodes(projectId!).then(r => r.data),
    enabled: !!projectId,
    staleTime: 15_000,
  });

  const isLoading = aggLoading || nodesLoading;

  // Build view entries for current tab
  const allEntries = useMemo(() => {
    const tabData: ConceptTaxonomyEntry[] = aggregate?.[activeTab] ?? [];
    return buildViewEntries(tabData, nodes, activeTab);
  }, [aggregate, nodes, activeTab]);

  // Filter
  const fieldOptions = useMemo(
    () => Array.from(new Set(allEntries.map(e => e.field_label))),
    [allEntries]
  );
  const filtered = useMemo(() => allEntries.filter(e => {
    const matchSearch = !search || e.value.toLowerCase().includes(search.toLowerCase())
      || e.aliases.some(a => a.toLowerCase().includes(search.toLowerCase()));
    const matchField = fieldFilter === "__all__" || e.field_label === fieldFilter;
    return matchSearch && matchField;
  }), [allEntries, search, fieldFilter]);

  // Tree
  const tree = useMemo(() => buildTree(filtered), [filtered]);
  const flatTree = useMemo(() => flattenTree(tree), [tree]);

  // Selection
  function toggleEntry(key: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  function selectAll() { setSelected(new Set(filtered.map(e => e.key))); }
  function clearAll() { setSelected(new Set()); }

  // Drag-and-drop: drop source onto target → make source a child of target
  const dropMut = useMutation({
    mutationFn: async ({ srcEntry, tgtEntry }: { srcEntry: ViewEntry; tgtEntry: ViewEntry }) => {
      // auto-promote source to node
      let srcNodeId = srcEntry.node?.id;
      if (!srcNodeId) {
        const r = await conceptTaxonomyApi.getOrCreateNode(projectId!, {
          name: srcEntry.value,
          field_id: srcEntry.field_id,
          field_type: activeTab,
        });
        srcNodeId = r.data.id;
      }
      // auto-promote target to node
      let tgtNodeId = tgtEntry.node?.id;
      if (!tgtNodeId) {
        const r = await conceptTaxonomyApi.getOrCreateNode(projectId!, {
          name: tgtEntry.value,
          field_id: tgtEntry.field_id,
          field_type: activeTab,
        });
        tgtNodeId = r.data.id;
      }
      await conceptTaxonomyApi.updateNode(projectId!, srcNodeId, { parent_id: tgtNodeId });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["concept-taxonomy-nodes", projectId] });
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail ?? "Failed to set parent";
      toast(msg, "error");
    },
  });

  function handleDrop(tgtEntry: ViewEntry) {
    if (!dragKey || dragKey === tgtEntry.key) return;
    const srcEntry = filtered.find(e => e.key === dragKey);
    if (!srcEntry) return;
    dropMut.mutate({ srcEntry, tgtEntry });
    setDragKey(null);
    setDropTargetKey(null);
  }

  // Delete node

  const tabColor = TAB_COLORS[activeTab];
  const selectedForTab = new Set([...selected].filter(k => filtered.some(e => e.key === k)));
  const hasTemplate = (project?.concept_template?.fields?.length ?? 0) > 0;

  const displayList = viewMode === "tree" ? flatTree : filtered;

  function resetTab(tab: ConceptFieldType) {
    setActiveTab(tab);
    setSelected(new Set());
    setSearch("");
    setFieldFilter("__all__");
    setDragKey(null);
    setDropTargetKey(null);
  }

  return (
    <div className="page">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="page-header">
        <div className="page-title">
          <Link to={`/projects/${projectId}`} className="back-link">← Project</Link>
          <h1>
            Concept Taxonomy
            {project && <span className="badge" style={{ marginLeft: "0.6rem", fontSize: "0.72rem" }}>{project.name}</span>}
          </h1>
          <span className="subtitle">
            Drag concepts onto each other to set parent-child relationships. Select multiple and click Merge to unify them.
          </span>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {/* Bulk AI concept extraction */}
          {project?.my_role !== "reviewer" && (() => {
            const bj = bulkConceptStatus.data;
            const running = bj?.status === "running";
            return (
              <button
                disabled={running || bulkConceptMut.isPending}
                onClick={() => bulkConceptMut.mutate()}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  padding: "0.3rem 0.7rem", borderRadius: "0.375rem", border: "none",
                  background: running ? "#a5b4fc" : "linear-gradient(135deg,#6366f1,#8b5cf6)",
                  color: "#fff", fontSize: "0.78rem", fontWeight: 600,
                  cursor: running ? "default" : "pointer", whiteSpace: "nowrap",
                }}
                title="Suggest concept extractions for all included papers using AI"
              >
                ✦ {running ? `Extracting… ${bj?.done ?? 0}/${bj?.total ?? "?"}` : "Suggest All with AI"}
              </button>
            );
          })()}
          <Link to={`/projects/${projectId}/ontology`} className="btn-secondary btn-sm">Open Ontology</Link>
        </div>
      </header>

      {!isLoading && !hasTemplate && (
        <div className="alert alert-warning" style={{ marginBottom: "1.25rem" }}>
          <strong>No concept extraction template defined yet.</strong>{" "}
          Go to <Link to={`/projects/${projectId}`} style={{ color: "var(--warning)", fontWeight: 600 }}>Project Overview</Link> to add a template.
        </div>
      )}

      {/* ── Tabs ────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", borderBottom: "2px solid var(--border)", marginBottom: "1.25rem" }}>
        {(["entity", "relation", "metadata"] as ConceptFieldType[]).map(tab => {
          const tabAgg = aggregate?.[tab] ?? [];
          const count = tabAgg.length;
          const active = activeTab === tab;
          const color = TAB_COLORS[tab];
          // Only count curated nodes that have at least one extraction from the
          // current user (mirrors the buildViewEntries filter above).
          const curatedEntries = buildViewEntries(tabAgg, nodes, tab);
          const nodeCount = curatedEntries.filter(e => e.node !== null).length;
          return (
            <button
              key={tab}
              onClick={() => resetTab(tab)}
              style={{
                padding: "0.55rem 1.1rem", border: "none", background: "transparent",
                cursor: "pointer", fontSize: "0.875rem",
                fontWeight: active ? 700 : 400,
                color: active ? color : "var(--text-muted)",
                borderBottom: `3px solid ${active ? color : "transparent"}`,
                marginBottom: -2, transition: "color 0.1s",
              }}
            >
              {TAB_LABELS[tab]}
              <span className="badge" style={{
                marginLeft: "0.4rem",
                background: active ? `${color}18` : "var(--surface-2)",
                color: active ? color : "var(--text-muted)",
                borderColor: active ? `${color}44` : "var(--border)",
              }}>
                {count}
              </span>
              {nodeCount > 0 && (
                <span title={`${nodeCount} curated nodes`} style={{
                  marginLeft: "0.25rem", fontSize: "0.68rem",
                  color: active ? color : "var(--text-muted)",
                }}>
                  ({nodeCount} curated)
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Merge modal ─────────────────────────────────────────────── */}
      {merging && (
        <MergeModal
          selected={selectedForTab}
          entries={filtered}
          projectId={projectId!}
          fieldType={activeTab}
          onClose={() => setMerging(false)}
          onDone={() => { setMerging(false); setSelected(new Set()); qc.invalidateQueries({ queryKey: ["concept-taxonomy-nodes", projectId] }); }}
        />
      )}

      {/* ── Push panel ──────────────────────────────────────────────── */}
      {selectedForTab.size > 0 && !merging && (
        <PushPanel
          projectId={projectId!} tab={activeTab}
          selected={selectedForTab} allEntries={filtered}
          onSuccess={() => { setSelected(new Set()); qc.invalidateQueries({ queryKey: ["ontology", projectId] }); }}
        />
      )}

      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
        <input
          type="text" placeholder="Search values or aliases…" value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 160, fontSize: "0.875rem" }}
        />
        {fieldOptions.length > 1 && (
          <select value={fieldFilter} onChange={e => setFieldFilter(e.target.value)} style={{ fontSize: "0.84rem" }}>
            <option value="__all__">All fields</option>
            {fieldOptions.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        )}
        {/* View mode toggle */}
        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
          {(["flat", "tree"] as const).map(mode => (
            <button key={mode} onClick={() => setViewMode(mode)} style={{
              padding: "0.3rem 0.65rem", border: "none", cursor: "pointer",
              fontSize: "0.8rem", fontWeight: viewMode === mode ? 700 : 400,
              background: viewMode === mode ? "var(--brand)" : "var(--surface)",
              color: viewMode === mode ? "#fff" : "var(--text-muted)",
            }}>
              {mode === "flat" ? "Flat" : "Tree"}
            </button>
          ))}
        </div>
        <button onClick={selectAll} className="btn-ghost btn-sm" style={{ color: tabColor }}>Select all</button>
        {selected.size > 0 && (
          <>
            <button onClick={clearAll} className="btn-ghost btn-sm">Clear ({selected.size})</button>
            {selectedForTab.size >= 2 && (
              <button
                onClick={() => setMerging(true)}
                className="btn-primary btn-sm"
                style={{ background: "#7c3aed" }}
              >
                Merge {selectedForTab.size} concepts
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Drag hint ───────────────────────────────────────────────── */}
      {!isLoading && filtered.length > 0 && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.5rem", display: "flex", gap: "1rem" }}>
          <span>⠿ Drag a row onto another to make it a child</span>
          <span>· Click "Set parent" for dropdown selection</span>
          <span>· Select 2+ and click Merge to combine</span>
        </div>
      )}

      {/* ── Table ───────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="empty-state"><div className="spinner" style={{ margin: "0 auto" }} /></div>
      ) : aggError ? (
        <div className="alert alert-danger">Failed to load concept data.</div>
      ) : displayList.length === 0 ? (
        <div className="empty-state" style={{ border: "1px dashed var(--border)", borderRadius: "var(--radius-lg)" }}>
          <p>{allEntries.length === 0
            ? `No ${TAB_LABELS[activeTab].toLowerCase()} extracted yet.`
            : "No values match your search."}
          </p>
        </div>
      ) : (
        <div className="table-wrapper">
          {/* Column header */}
          <div style={{
            display: "grid", gridTemplateColumns: "28px 1fr auto 80px",
            gap: "0.5rem", padding: "0.4rem 0.75rem",
            background: "var(--surface-2)", borderBottom: "1px solid var(--border)",
            fontSize: "0.72rem", fontWeight: 700, color: "var(--text-muted)",
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>
            <span />
            <span>Value {viewMode === "tree" ? "(tree)" : ""}</span>
            <span>Parent</span>
            <span style={{ textAlign: "right" }}>Count</span>
          </div>

          {displayList.map(entry => (
            <EntryRow
              key={entry.key}
              entry={entry}
              depth={viewMode === "tree" ? (entry as TreeEntry).depth : 0}
              selected={selectedForTab.has(entry.key)}
              onToggle={() => toggleEntry(entry.key)}
              allEntries={filtered}
              projectId={projectId!}
              fieldType={activeTab}
              isDropTarget={dropTargetKey === entry.key}
              onDragStart={() => setDragKey(entry.key)}
              onDragOver={() => setDropTargetKey(entry.key)}
              onDragLeave={() => { if (dropTargetKey === entry.key) setDropTargetKey(null); }}
              onDrop={() => handleDrop(entry)}
            />
          ))}
        </div>
      )}

      {displayList.length > 0 && (
        <div style={{ marginTop: "0.6rem", fontSize: "0.78rem", color: "var(--text-muted)", display: "flex", gap: "1rem" }}>
          <span>Showing {displayList.length} of {allEntries.length} concepts</span>
          {selectedForTab.size > 0 && <span>{selectedForTab.size} selected</span>}
          {nodes.filter(n => n.field_type === activeTab).length > 0 && (
            <span>{nodes.filter(n => n.field_type === activeTab).length} curated · {filtered.filter(e => !e.node).length} unattached</span>
          )}
        </div>
      )}
    </div>
  );
}
