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
import { useState, useMemo, useEffect, Suspense, lazy, useRef } from "react";
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

// Lazy-load ForceGraph3D — react-force-graph is a named export, not a default
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph3D = lazy(() =>
  import("react-force-graph").then((m) => ({ default: (m as any).ForceGraph3D }))
);

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_NS: OntologyNamespace = "concept";

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

  useEffect(() => {
    if (selectedNode) {
      setEditName(selectedNode.name);
      setEditDesc(selectedNode.description ?? "");
      setEditNs(selectedNode.namespace);
      setEditColor(selectedNode.color ?? "");
      setEditParentId(selectedNode.parent_id ?? "");
      setEditDirty(false);
      setFormError(null);
    }
  }, [selectedNode]);

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
    onSuccess: () => {
      setEditDirty(false);
      setFormError(null);
      invalidate();
    },
    onError: (e: any) => setFormError(e?.response?.data?.detail ?? "Failed to update node"),
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

  // ── 3D Graph data ─────────────────────────────────────────────────────────
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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f9fafb",
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
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
        <div ref={graphContainerRef} style={{ flex: 1, overflow: "hidden", background: "#0f172a", position: "relative" }}>
          {nodes.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#94a3b8", fontSize: "0.9rem" }}>
              No nodes yet — add some in Tree view first.
            </div>
          ) : (
            <Suspense fallback={
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#94a3b8" }}>
                Loading 3D graph…
              </div>
            }>
              <ForceGraph3D
                graphData={graphData}
                nodeLabel="name"
                nodeColor={(n: { nodeColor: string }) => n.nodeColor}
                nodeVal={(n: { val: number }) => n.val}
                linkColor={() => "rgba(148,163,184,0.4)"}
                linkWidth={1.5}
                linkDirectionalArrowLength={4}
                linkDirectionalArrowRelPos={1}
                backgroundColor="#0f172a"
                width={graphContainerRef.current?.clientWidth ?? (typeof window !== "undefined" ? window.innerWidth - 220 : 900)}
                height={graphContainerRef.current?.clientHeight ?? (typeof window !== "undefined" ? window.innerHeight - 130 : 600)}
                onNodeClick={(node: { id: string }) => {
                  setViewMode("tree");
                  setSelectedId(node.id);
                }}
              />
            </Suspense>
          )}
          <div style={{ position: "absolute", bottom: 16, right: 20, color: "#475569", fontSize: "0.75rem", textAlign: "right", pointerEvents: "none" }}>
            Drag to rotate · Scroll to zoom · Click a node to edit
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
