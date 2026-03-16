/**
 * OntologyPage — lightweight taxonomy/ontology editor.
 *
 * Layout:
 *   ┌─ Top bar: breadcrumb · search · actions (Add root / Sync / Export) ─────┐
 *   ├─ Stats strip: total nodes · namespaces · max depth ──────────────────────┤
 *   ├─ Left: collapsible tree ──────────┬─ Right: node editor panel ───────────┤
 *   │  (OntologyTree)                   │  (name, description, namespace,      │
 *   │                                   │   parent, color)                     │
 *   └───────────────────────────────────┴──────────────────────────────────────┘
 *
 * Interactive:
 *   • Click node → select, right panel shows editable fields
 *   • "+" button on row → add child; "✕" → delete (promote children)
 *   • "Add root" button → add at root level
 *   • "Sync levels" → pull project.criteria.levels into ontology
 *   • "Export" → download JSON tree
 *   • Search → highlight + show matching nodes
 *   • Namespace filter → show only nodes of selected namespace
 *   • Parent selector in editor → reparent node (cycle-safe)
 */
import React, { useState, useMemo, useEffect, useRef, useCallback, Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ontologyApi,
  projectsApi,
  ONTOLOGY_NAMESPACES,
  type OntologyNode,
  type OntologyNamespace,
} from "../api/client";
import OntologyTree, { NS_COLORS } from "../components/OntologyTree";
import Graph3DCanvas from "../components/Graph3DCanvas";
import type { G3DNode } from "../components/Graph3DCanvas";

// ── ErrorBoundary — any WebGL/library error shows a recoverable card
// instead of a white screen.
interface EBState { error: Error | null }
class Graph3DErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null };
  static getDerivedStateFromError(e: Error): EBState { return { error: e }; }
  componentDidCatch(e: Error, info: ErrorInfo) { console.error("[3D Graph]", e, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12, color: "#94a3b8", padding: 40 }}>
          <span style={{ fontSize: "2rem" }}>⚠️</span>
          <p style={{ margin: 0, fontWeight: 600, color: "#f87171" }}>3D engine failed to start</p>
          <p style={{ margin: 0, fontSize: 12, color: "#64748b", maxWidth: 420, textAlign: "center" }}>
            {this.state.error.message}
          </p>
          <button onClick={() => this.setState({ error: null })}
            style={{ marginTop: 8, padding: "6px 16px", borderRadius: 6, border: "1px solid #334155", background: "transparent", color: "#94a3b8", cursor: "pointer", fontSize: 13 }}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_NS: OntologyNamespace = "level";

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OntologyPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const qc = useQueryClient();

  // UI state
  const [viewMode, setViewMode] = useState<"tree" | "graph3d">("tree");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [nsFilter, setNsFilter] = useState<OntologyNamespace | "all">("all");
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const [graphDims, setGraphDims] = useState<{ w: number; h: number } | null>(null);

  // Measure container — retry every RAF tick until ref is attached AND has positive size
  useEffect(() => {
    if (viewMode !== "graph3d") { setGraphDims(null); return; }
    let raf: number;
    const measure = () => {
      const el = graphContainerRef.current;
      if (!el || el.getBoundingClientRect().width === 0) {
        // ref not yet attached or element not yet laid out — keep retrying
        raf = requestAnimationFrame(measure);
        return;
      }
      const { width, height } = el.getBoundingClientRect();
      setGraphDims({ w: Math.floor(width), h: Math.floor(height) });
    };
    raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(() => {
      const el = graphContainerRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setGraphDims({ w: Math.floor(width), h: Math.floor(height) });
    });
    // Attach observer after first successful measure fires via RAF
    setTimeout(() => {
      if (graphContainerRef.current) ro.observe(graphContainerRef.current);
    }, 0);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [viewMode]);

  // Editor form state (for selected node)
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editNs, setEditNs] = useState<OntologyNamespace>(DEFAULT_NS);
  const [editColor, setEditColor] = useState("");
  const [editParentId, setEditParentId] = useState<string>("");
  const [editDirty, setEditDirty] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Add-node form state
  const [addMode, setAddMode] = useState(false);
  const [addParentId, setAddParentId] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  const [addNs, setAddNs] = useState<OntologyNamespace>(DEFAULT_NS);
  const [addColor, setAddColor] = useState("");

  // ── Data ──────────────────────────────────────────────────────────────────

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const {
    data: nodes = [],
    isLoading,
    isError,
  } = useQuery<OntologyNode[]>({
    queryKey: ["ontology", projectId],
    queryFn: () => ontologyApi.list(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["ontology", projectId] });

  // ── Filtered nodes for tree ───────────────────────────────────────────────

  const visibleNodes = useMemo(() => {
    if (nsFilter === "all") return nodes;
    // Include any node whose namespace matches, plus all its ancestors (so tree makes sense)
    const matchingIds = new Set(nodes.filter((n) => n.namespace === nsFilter).map((n) => n.id));
    // Collect ancestor IDs
    const ancestorIds = new Set<string>();
    const idMap = new Map(nodes.map((n) => [n.id, n]));
    matchingIds.forEach((id) => {
      let cur = idMap.get(id);
      while (cur?.parent_id) {
        ancestorIds.add(cur.parent_id);
        cur = idMap.get(cur.parent_id);
      }
    });
    return nodes.filter((n) => matchingIds.has(n.id) || ancestorIds.has(n.id));
  }, [nodes, nsFilter]);

  // ── Stats ─────────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const byNs: Record<string, number> = {};
    nodes.forEach((n) => {
      byNs[n.namespace] = (byNs[n.namespace] ?? 0) + 1;
    });
    const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
    return { total: nodes.length, byNs, maxDepth };
  }, [nodes]);

  // ── Selected node → populate editor ──────────────────────────────────────

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId]
  );

  // Only reset the form when the user selects a DIFFERENT node.
  // Background refetches (after drag/save/create) must NOT wipe editDirty or the user's
  // in-progress edits — that's what caused "Save needs two clicks".
  useEffect(() => {
    if (!selectedId) return;
    const node = nodes.find((n) => n.id === selectedId);
    if (node) {
      setEditName(node.name);
      setEditDesc(node.description ?? "");
      setEditNs(node.namespace);
      setEditColor(node.color ?? "");
      setEditParentId(node.parent_id ?? "");
      setEditDirty(false);
      setFormError(null);
    }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mutations ─────────────────────────────────────────────────────────────

  const createMut = useMutation({
    mutationFn: (body: Parameters<typeof ontologyApi.create>[1]) =>
      ontologyApi.create(projectId!, body),
    onSuccess: (res) => {
      setSelectedId(res.data.id);
      setAddMode(false);
      setAddName("");
      setAddColor("");
      invalidate();
    },
    onError: (e: any) => setFormError(e?.response?.data?.detail ?? "Failed to create node"),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof ontologyApi.update>[2] }) =>
      ontologyApi.update(projectId!, id, body),
    onSuccess: (res) => {
      // Sync form to what the server actually saved (avoids stale fields)
      setEditName(res.data.name);
      setEditDesc(res.data.description ?? "");
      setEditNs(res.data.namespace);
      setEditColor(res.data.color ?? "");
      setEditParentId(res.data.parent_id ?? "");
      setEditDirty(false);
      setFormError(null);
      invalidate();
    },
    onError: (e: any) => setFormError(e?.response?.data?.detail ?? "Failed to update node"),
  });

  // Separate mutation for drag-and-drop reparenting — must not touch the edit form state
  const reparentMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof ontologyApi.update>[2] }) =>
      ontologyApi.update(projectId!, id, body),
    onSuccess: () => invalidate(),
  });

  const deleteMut = useMutation({
    mutationFn: (nodeId: string) => ontologyApi.delete(projectId!, nodeId),
    onSuccess: () => {
      setSelectedId(null);
      invalidate();
    },
  });

  const syncMut = useMutation({
    mutationFn: () => ontologyApi.syncLevels(projectId!, { namespace: "level" }),
    onSuccess: (res) => {
      invalidate();
      alert(`Sync complete: ${res.data.created} created, ${res.data.skipped} already present.`);
    },
  });

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleAddChild = (parentId: string | null) => {
    setAddParentId(parentId);
    setAddMode(true);
    setAddName("");
    setAddNs(DEFAULT_NS);
    setAddColor("");
    setFormError(null);
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!addName.trim()) return;
    createMut.mutate({
      name: addName.trim(),
      parent_id: addParentId ?? null,
      namespace: addNs,
      color: addColor || null,
    });
  };

  const handleSaveEdit = () => {
    if (!selectedId || !editName.trim()) return;
    updateMut.mutate({
      id: selectedId,
      body: {
        name: editName.trim(),
        description: editDesc || null,
        namespace: editNs,
        color: editColor || null,
        clear_color: !editColor,
        parent_id: editParentId ? editParentId : undefined,
        clear_parent: !editParentId,
      },
    });
  };

  const handleReparent = (nodeId: string, newParentId: string | null) => {
    reparentMut.mutate({
      id: nodeId,
      body: newParentId
        ? { parent_id: newParentId }
        : { clear_parent: true },
    });
  };

  // ── 3D Graph data (must be declared BEFORE handle3DNodeDragEnd useCallback) ──
  const graphData = useMemo(() => {
    const graphNodes = nodes.map((n) => ({
      id: n.id,
      name: n.name,
      namespace: n.namespace,
      nodeColor: n.color ?? NS_COLORS[n.namespace] ?? "#9ca3af",
      val: n.parent_id ? 1 : 2.5,
    }));
    const graphLinks = nodes
      .filter((n) => n.parent_id !== null)
      .map((n) => ({ source: n.parent_id!, target: n.id }));
    return { nodes: graphNodes, links: graphLinks };
  }, [nodes]);

  // 3D drag-to-reparent: when drag ends, find the nearest other node;
  // if within proximity threshold, reparent automatically.
  const handle3DNodeDragEnd = useCallback(
    (draggedNode: { id: string; x?: number; y?: number; z?: number }) => {
      const gNodes: Array<{ id: string; x?: number; y?: number; z?: number }> =
        graphData.nodes;
      const dx0 = draggedNode.x ?? 0;
      const dy0 = draggedNode.y ?? 0;
      const dz0 = draggedNode.z ?? 0;

      let nearestId: string | null = null;
      let minDist = Infinity;
      gNodes.forEach((n) => {
        if (n.id === draggedNode.id) return;
        const dx = (n.x ?? 0) - dx0;
        const dy = (n.y ?? 0) - dy0;
        const dz = (n.z ?? 0) - dz0;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < minDist) { minDist = dist; nearestId = n.id; }
      });

      // Only reparent if within a reasonable proximity (heuristic: < 40 units)
      if (nearestId && minDist < 40) {
        // Guard: don't reparent onto a descendant
        const desc = new Set<string>([draggedNode.id]);
        const allNodes: OntologyNode[] = nodes;
        let changed = true;
        while (changed) {
          changed = false;
          allNodes.forEach((n) => {
            if (n.parent_id && desc.has(n.parent_id) && !desc.has(n.id)) {
              desc.add(n.id); changed = true;
            }
          });
        }
        if (!desc.has(nearestId)) {
          handleReparent(draggedNode.id, nearestId);
        }
      }
    },
    [graphData.nodes, nodes, handleReparent]
  );

  const handleDelete = (node: OntologyNode) => {
    if (
      confirm(
        `Delete "${node.name}"? Its children will be promoted to the parent level.`
      )
    ) {
      deleteMut.mutate(node.id);
    }
  };

  const handleExport = async () => {
    const res = await ontologyApi.export(projectId!);
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ontology-${projectId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Parent options for the editor (exclude self + descendants)
  const parentOptions = useMemo(() => {
    if (!selectedId) return nodes;
    // BFS/DFS to collect descendant IDs
    const descendants = new Set<string>();
    const stack = [selectedId];
    while (stack.length) {
      const cur = stack.pop()!;
      descendants.add(cur);
      nodes.filter((n) => n.parent_id === cur).forEach((n) => stack.push(n.id));
    }
    return nodes.filter((n) => !descendants.has(n.id));
  }, [nodes, selectedId]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        height: "100vh",
        background: "#f9fafb",
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* ── Top bar ── */}
      <div
        style={{
          background: "#fff",
          borderBottom: "1px solid #e5e7eb",
          padding: "12px 20px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <Link to={`/projects/${projectId}`} style={{ color: "#6366f1", textDecoration: "none", fontWeight: 500, fontSize: 14 }}>
          {project?.name ?? "Project"}
        </Link>
        <span style={{ color: "#9ca3af" }}>›</span>
        <span style={{ fontWeight: 700, color: "#111827", fontSize: 14 }}>
          Ontology
        </span>

        {/* View toggle */}
        <div className="view-toggle" style={{ marginLeft: 8 }}>
          <button
            className={`view-toggle-btn${viewMode === "tree" ? " active" : ""}`}
            onClick={() => setViewMode("tree")}
          >
            Tree
          </button>
          <button
            className={`view-toggle-btn${viewMode === "graph3d" ? " active" : ""}`}
            onClick={() => setViewMode("graph3d")}
          >
            3D Graph
          </button>
        </div>

        {/* Namespace filter */}
        <select
          value={nsFilter}
          onChange={(e) => setNsFilter(e.target.value as OntologyNamespace | "all")}
          style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 8px", fontSize: 13, marginLeft: 8 }}
        >
          <option value="all">All namespaces</option>
          {ONTOLOGY_NAMESPACES.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>

        {/* Search */}
        <input
          type="search"
          placeholder="Search nodes…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            border: "1px solid #d1d5db",
            borderRadius: 6,
            padding: "4px 10px",
            fontSize: 13,
            width: 200,
          }}
        />

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Btn onClick={() => handleAddChild(null)} color="#6366f1">+ Root node</Btn>
          <Btn
            onClick={() => syncMut.mutate()}
            color="#10b981"
            disabled={syncMut.isPending}
            title="Import extraction levels from project criteria into the ontology"
          >
            ⟳ Sync levels
          </Btn>
          <Btn onClick={handleExport} color="#6b7280">↓ Export JSON</Btn>
        </div>
      </div>

      {/* ── Stats strip ── */}
      {nodes.length > 0 && (
        <div
          style={{
            background: "#fff",
            borderBottom: "1px solid #e5e7eb",
            padding: "8px 20px",
            display: "flex",
            gap: 20,
            flexWrap: "wrap",
            fontSize: 12,
            color: "#6b7280",
          }}
        >
          <span>
            <strong style={{ color: "#111827" }}>{stats.total}</strong> nodes
          </span>
          <span>
            <strong style={{ color: "#111827" }}>{stats.maxDepth + 1}</strong> levels deep
          </span>
          {Object.entries(stats.byNs).map(([ns, count]) => (
            <span key={ns} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: NS_COLORS[ns] ?? "#9ca3af",
                  display: "inline-block",
                }}
              />
              {ns}: {count}
            </span>
          ))}
        </div>
      )}

      {/* ── 3D Graph body ── */}
      {viewMode === "graph3d" && (
        <div
          ref={graphContainerRef}
          style={{ flex: 1, overflow: "hidden", background: "#0f172a", position: "relative" }}
        >
          {nodes.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#94a3b8", fontSize: "0.9rem" }}>
              No nodes yet — add some in Tree view first.
            </div>
          ) : !graphDims ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#94a3b8" }}>
              Initialising 3D engine…
            </div>
          ) : (
            <Graph3DErrorBoundary>
              <Graph3DCanvas
                graphData={graphData}
                width={graphDims.w}
                height={graphDims.h}
                onNodeDragEnd={(node: G3DNode) => handle3DNodeDragEnd(node)}
                onNodeClick={(node: G3DNode) => {
                  setViewMode("tree");
                  setSelectedId(node.id);
                }}
              />
            </Graph3DErrorBoundary>
          )}

          {/* Legend */}
          <div style={{ position: "absolute", top: 14, left: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
            {(["level", "dimension", "relationships"] as const).map((ns) => (
              <span
                key={ns}
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: (NS_COLORS[ns] ?? "#9ca3af") + "33",
                  color: NS_COLORS[ns] ?? "#9ca3af",
                  border: `1px solid ${NS_COLORS[ns] ?? "#9ca3af"}55`,
                  fontWeight: 600,
                }}
              >
                {ns}
              </span>
            ))}
          </div>

          <div style={{ position: "absolute", bottom: 16, right: 20, color: "#475569", fontSize: "0.75rem", textAlign: "right", pointerEvents: "none" }}>
            Left-drag: rotate · Scroll: zoom · Drag node onto another: reparent · Click: edit
          </div>
        </div>
      )}

      {/* ── Tree body ── */}
      <div style={{ display: viewMode === "tree" ? "flex" : "none", flex: 1, overflow: "hidden" }}>
        {/* ── Tree panel ── */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 12px",
            maxWidth: selectedId || addMode ? "60%" : "100%",
          }}
        >
          {isLoading ? (
            <p style={{ color: "#9ca3af", padding: 20 }}>Loading…</p>
          ) : isError ? (
            <p style={{ color: "#ef4444", padding: 20 }}>Failed to load ontology.</p>
          ) : (
            <OntologyTree
              nodes={visibleNodes}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAddChild={handleAddChild}
              onDelete={handleDelete}
              onReparent={handleReparent}
              searchQuery={searchQuery}
            />
          )}
        </div>

        {/* ── Right panel: add form or editor ── */}
        {(addMode || selectedNode) && (
          <div
            style={{
              width: 360,
              flexShrink: 0,
              background: "#fff",
              borderLeft: "1px solid #e5e7eb",
              padding: 20,
              overflowY: "auto",
            }}
          >
            {addMode ? (
              /* ── Add node form ── */
              <form onSubmit={handleAddSubmit}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <h3 style={{ margin: 0, fontSize: 15 }}>
                    {addParentId
                      ? `Add child under "${nodes.find((n) => n.id === addParentId)?.name ?? "…"}"`
                      : "Add root node"}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setAddMode(false)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af" }}
                  >
                    ✕
                  </button>
                </div>

                <Field label="Name *">
                  <input
                    required
                    autoFocus
                    value={addName}
                    onChange={(e) => setAddName(e.target.value)}
                    style={inputSx}
                    placeholder="Concept name…"
                  />
                </Field>

                <Field label="Namespace">
                  <NsSelect value={addNs} onChange={setAddNs} />
                </Field>

                <Field label="Color (optional)">
                  <ColorRow value={addColor} onChange={setAddColor} ns={addNs} />
                </Field>

                {formError && <ErrorBanner>{formError}</ErrorBanner>}

                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button type="submit" disabled={createMut.isPending} style={primaryBtn}>
                    {createMut.isPending ? "Adding…" : "Add node"}
                  </button>
                  <button type="button" onClick={() => setAddMode(false)} style={secondaryBtn}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : selectedNode ? (
              /* ── Edit panel ── */
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <h3 style={{ margin: 0, fontSize: 15 }}>Edit node</h3>
                  <button
                    onClick={() => setSelectedId(null)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af" }}
                  >
                    ✕
                  </button>
                </div>

                {/* Ancestors breadcrumb */}
                <AncestorsBreadcrumb node={selectedNode} allNodes={nodes} />

                <Field label="Name *">
                  <input
                    value={editName}
                    onChange={(e) => { setEditName(e.target.value); setEditDirty(true); }}
                    style={inputSx}
                  />
                </Field>

                <Field label="Description">
                  <textarea
                    value={editDesc}
                    onChange={(e) => { setEditDesc(e.target.value); setEditDirty(true); }}
                    rows={3}
                    style={{ ...inputSx, resize: "vertical", fontFamily: "inherit" }}
                    placeholder="Optional description…"
                  />
                </Field>

                <Field label="Namespace">
                  <NsSelect value={editNs} onChange={(v) => { setEditNs(v); setEditDirty(true); }} />
                </Field>

                <Field label="Color">
                  <ColorRow
                    value={editColor}
                    onChange={(v) => { setEditColor(v); setEditDirty(true); }}
                    ns={editNs}
                    clearable
                  />
                </Field>

                <Field label="Parent">
                  <select
                    value={editParentId}
                    onChange={(e) => { setEditParentId(e.target.value); setEditDirty(true); }}
                    style={inputSx}
                  >
                    <option value="">(root — no parent)</option>
                    {parentOptions.map((n) => (
                      <option key={n.id} value={n.id}>
                        {"  ".repeat(n.depth)}
                        {n.depth > 0 ? "└ " : ""}
                        {n.name}
                      </option>
                    ))}
                  </select>
                </Field>

                {formError && <ErrorBanner>{formError}</ErrorBanner>}

                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button
                    onClick={handleSaveEdit}
                    disabled={!editDirty || updateMut.isPending}
                    style={primaryBtn}
                  >
                    {updateMut.isPending ? "Saving…" : "Save changes"}
                  </button>
                  <button
                    onClick={() => handleDelete(selectedNode)}
                    style={{ ...secondaryBtn, color: "#ef4444", borderColor: "#fca5a5" }}
                  >
                    Delete
                  </button>
                </div>

                {/* Node metadata */}
                <div style={{ marginTop: 20, fontSize: 11, color: "#9ca3af", borderTop: "1px solid #f3f4f6", paddingTop: 12 }}>
                  <div>ID: {selectedNode.id}</div>
                  <div>Created: {new Date(selectedNode.created_at).toLocaleString()}</div>
                  <div>Updated: {new Date(selectedNode.updated_at).toLocaleString()}</div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AncestorsBreadcrumb({
  node,
  allNodes,
}: {
  node: OntologyNode;
  allNodes: OntologyNode[];
}) {
  const ancestors: OntologyNode[] = [];
  const idMap = new Map(allNodes.map((n) => [n.id, n]));
  let cur: OntologyNode | undefined = node;
  while (cur?.parent_id) {
    const p = idMap.get(cur.parent_id);
    if (p) ancestors.unshift(p);
    cur = p;
  }
  if (ancestors.length === 0) return null;
  return (
    <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 2 }}>
      {ancestors.map((a, i) => (
        <span key={a.id}>
          {i > 0 && " › "}
          <span style={{ color: NS_COLORS[a.namespace] ?? "#6366f1" }}>{a.name}</span>
        </span>
      ))}
      <span> › <strong style={{ color: "#111827" }}>{node.name}</strong></span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function NsSelect({
  value,
  onChange,
}: {
  value: OntologyNamespace;
  onChange: (v: OntologyNamespace) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as OntologyNamespace)}
      style={inputSx}
    >
      {ONTOLOGY_NAMESPACES.map((ns) => (
        <option key={ns} value={ns}>
          {ns}
        </option>
      ))}
    </select>
  );
}

const PALETTE = [
  "#3b82f6", "#10b981", "#6366f1", "#8b5cf6",
  "#f97316", "#14b8a6", "#ef4444", "#eab308",
  "#ec4899", "#9ca3af",
];

function ColorRow({
  value,
  onChange,
  ns,
  clearable = false,
}: {
  value: string;
  onChange: (v: string) => void;
  ns: OntologyNamespace;
  clearable?: boolean;
}) {
  const defaultColor = NS_COLORS[ns] ?? "#6366f1";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      {PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          style={{
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: c,
            border: value === c ? "2px solid #1f2937" : "2px solid transparent",
            cursor: "pointer",
            padding: 0,
          }}
        />
      ))}
      {clearable && (
        <button
          type="button"
          onClick={() => onChange("")}
          style={{
            fontSize: 10,
            color: "#9ca3af",
            background: "none",
            border: "1px solid #e5e7eb",
            borderRadius: 4,
            padding: "1px 5px",
            cursor: "pointer",
          }}
          title="Use namespace default color"
        >
          auto
        </button>
      )}
      <span style={{ fontSize: 11, color: "#9ca3af" }}>
        → {value || defaultColor}
      </span>
    </div>
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 8, padding: "6px 10px", background: "#fee2e2", borderRadius: 6, color: "#b91c1c", fontSize: 12 }}>
      {children}
    </div>
  );
}

function Btn({
  children,
  onClick,
  color,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  color: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: disabled ? "#f3f4f6" : color,
        color: disabled ? "#9ca3af" : "#fff",
        border: "none",
        borderRadius: 6,
        padding: "5px 12px",
        fontSize: 13,
        cursor: disabled ? "default" : "pointer",
        fontWeight: 500,
      }}
    >
      {children}
    </button>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputSx: React.CSSProperties = {
  width: "100%",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

const primaryBtn: React.CSSProperties = {
  background: "#6366f1",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
  fontWeight: 600,
};

const secondaryBtn: React.CSSProperties = {
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};
