/**
 * OntologyCanvas2D — interactive 2D canvas for the ontology.
 *
 * Replaces the 1D collapsible list with a proper 2D node-graph canvas:
 *   - Dagre TB layout automatically arranges the tree hierarchy
 *   - Gray smoothstep edges for parent → child hierarchy
 *   - Orange animated bezier edges for semantic relationships
 *   - Drag a node onto another node to reparent it (overlap detection)
 *   - Drag from the orange ● handle (right side) to another node to create
 *     a new relationship edge
 *   - Click a node → open node editor in right panel
 *   - Click an orange edge → open edge editor in right panel
 *   - Search query highlights matching nodes in yellow
 *
 * Built on @xyflow/react v12 + @dagrejs/dagre.
 * Node types are defined at module scope (required by React Flow to avoid
 * unmount/remount on every parent render).
 */
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  Position,
  Handle,
  type Node as RFNode,
  type Edge as RFEdge,
  type Connection,
  type NodeProps,
  type OnConnect,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Dagre from "@dagrejs/dagre";
import type { OntologyNode, OntologyEdge } from "../api/client";
import { NS_COLORS } from "./OntologyTree";

// ── Constants ─────────────────────────────────────────────────────────────────

const NODE_W = 172;
const NODE_H = 60;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Callbacks stored in a ref so node card components always call the latest version. */
export interface OntologyCanvasActions {
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (edgeId: string | null) => void;
  onAddChild: (parentId: string | null) => void;
  onDelete: (node: OntologyNode) => void;
  onDeleteEdge: (edge: OntologyEdge) => void;
  onCreateEdge: (sourceId: string, targetId: string) => void;
  onReparent: (nodeId: string, newParentId: string | null) => void;
}

interface NodeData extends Record<string, unknown> {
  node: OntologyNode;
  isSelected: boolean;
  isDragTarget: boolean;
  isSearchMatch: boolean;
  actionsRef: React.MutableRefObject<OntologyCanvasActions>;
}

interface EdgeData extends Record<string, unknown> {
  linkType: "hierarchy" | "relationship";
  edge?: OntologyEdge;
}

type RFOntologyNode = RFNode<NodeData, "ontologyNode">;
type RFOntologyEdge = RFEdge<EdgeData>;

// ── Dagre layout ──────────────────────────────────────────────────────────────

function computeDagreLayout(
  nodes: OntologyNode[]
): Map<string, { x: number; y: number }> {
  const g = new Dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 90, marginx: 40, marginy: 40 });

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  nodes.filter((n) => n.parent_id).forEach((n) => g.setEdge(n.parent_id!, n.id));

  Dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    const p = g.node(n.id);
    // Fallback: spread disconnected nodes horizontally
    positions.set(n.id, p
      ? { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 }
      : { x: (i % 5) * (NODE_W + 40), y: Math.floor(i / 5) * (NODE_H + 60) }
    );
  });
  return positions;
}

// ── Custom node card ──────────────────────────────────────────────────────────

// IMPORTANT: defined at module scope so React Flow does not recreate on every
// parent render (which would cause all nodes to unmount/remount).
function OntologyNodeCard({ id, data }: NodeProps<RFOntologyNode>) {
  const { node, isSelected, isDragTarget, isSearchMatch, actionsRef } = data;
  const nsColor = NS_COLORS[node.namespace] ?? "#9ca3af";
  const dotColor = node.color ?? nsColor;

  let borderColor = "#e5e7eb";
  let bgColor = "#ffffff";
  let shadow = "0 1px 4px rgba(0,0,0,0.08)";

  if (isDragTarget) {
    borderColor = "#3b82f6";
    bgColor = "#eff6ff";
    shadow = "0 0 0 3px #3b82f640, 0 2px 8px rgba(0,0,0,0.15)";
  } else if (isSelected) {
    borderColor = dotColor;
    bgColor = dotColor + "0e";
    shadow = `0 0 0 3px ${dotColor}30, 0 2px 8px rgba(0,0,0,0.15)`;
  } else if (isSearchMatch) {
    bgColor = "#fef9c3";
    borderColor = "#fbbf24";
    shadow = "0 0 0 2px #fbbf2440";
  }

  return (
    <div style={{ position: "relative" }}>
      {/* Hierarchy target (top, hidden) */}
      <Handle
        type="target"
        id="hier"
        position={Position.Top}
        style={{ background: "#d1d5db", width: 7, height: 7, border: "2px solid #fff" }}
      />

      {/* Relationship target (left, orange) */}
      <Handle
        type="target"
        id="rel"
        position={Position.Left}
        style={{ background: "#f97316", width: 10, height: 10, border: "2px solid #fff", left: -5 }}
      />

      {/* Card body */}
      <div
        style={{
          width: NODE_W,
          minHeight: NODE_H,
          padding: "9px 12px 7px",
          borderRadius: 10,
          border: `2px solid ${borderColor}`,
          background: bgColor,
          boxShadow: shadow,
          transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
          cursor: "grab",
          userSelect: "none",
          display: "flex",
          flexDirection: "column",
          gap: 5,
        }}
      >
        {/* Name row */}
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: dotColor,
              flexShrink: 0,
              display: "inline-block",
            }}
          />
          <span
            style={{
              flex: 1,
              fontSize: 13,
              fontWeight: isSelected ? 700 : 500,
              color: "#111827",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {node.name}
          </span>
          <span
            style={{
              fontSize: 9,
              padding: "1px 5px",
              borderRadius: 999,
              background: nsColor + "22",
              color: nsColor,
              fontWeight: 700,
              flexShrink: 0,
              letterSpacing: "0.02em",
            }}
          >
            {node.namespace}
          </span>
        </div>

        {/* Action buttons */}
        <div
          style={{ display: "flex", gap: 3 }}
          onMouseDown={(e) => e.stopPropagation()} // prevent drag from starting on buttons
        >
          <NodeBtn
            label="+ child"
            color="#6366f1"
            onClick={() => actionsRef.current.onAddChild(node.id)}
            title="Add child node"
          />
          <NodeBtn
            label="✕ delete"
            color="#ef4444"
            onClick={() => actionsRef.current.onDelete(node)}
            title="Delete node (children promoted)"
          />
        </div>
      </div>

      {/* Hierarchy source (bottom, hidden) */}
      <Handle
        type="source"
        id="hier"
        position={Position.Bottom}
        style={{ background: "#d1d5db", width: 7, height: 7, border: "2px solid #fff" }}
      />

      {/* Relationship source (right, orange) — drag from here to create a relationship */}
      <Handle
        type="source"
        id="rel"
        position={Position.Right}
        style={{ background: "#f97316", width: 12, height: 12, border: "2px solid #fff", right: -6 }}
        title="Drag to create a relationship"
      />
    </div>
  );
}

function NodeBtn({
  label, color, onClick, title,
}: {
  label: string; color: string; onClick: () => void; title: string;
}) {
  return (
    <button
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 4,
        border: `1px solid ${color}44`,
        background: color + "11",
        color,
        cursor: "pointer",
        lineHeight: 1.5,
      }}
    >
      {label}
    </button>
  );
}

// Stable nodeTypes object — must be outside the main component
const nodeTypes = { ontologyNode: OntologyNodeCard };

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  nodes: OntologyNode[];
  edges: OntologyEdge[];
  selectedId: string | null;
  selectedEdgeId: string | null;
  searchQuery: string;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (edgeId: string | null) => void;
  onAddChild: (parentId: string | null) => void;
  onDelete: (node: OntologyNode) => void;
  onDeleteEdge: (edge: OntologyEdge) => void;
  onCreateEdge: (sourceId: string, targetId: string) => void;
  onReparent: (nodeId: string, newParentId: string | null) => void;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function OntologyCanvas2D({
  nodes,
  edges,
  selectedId,
  selectedEdgeId,
  searchQuery,
  onSelectNode,
  onSelectEdge,
  onAddChild,
  onDelete,
  onDeleteEdge,
  onCreateEdge,
  onReparent,
}: Props) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RFOntologyNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RFOntologyEdge>([]);
  const [dragTargetId, setDragTargetId] = useState<string | null>(null);

  // Stable callback ref — node card components always call the latest version
  const actionsRef = useRef<OntologyCanvasActions>({
    onSelectNode, onSelectEdge, onAddChild, onDelete, onDeleteEdge, onCreateEdge, onReparent,
  });
  // Keep ref current on every render (no deps needed)
  actionsRef.current = { onSelectNode, onSelectEdge, onAddChild, onDelete, onDeleteEdge, onCreateEdge, onReparent };

  // Refs for drag handlers (avoid stale closure)
  const rfNodesRef = useRef<RFOntologyNode[]>([]);
  rfNodesRef.current = rfNodes;
  const serverNodesRef = useRef<OntologyNode[]>([]);
  serverNodesRef.current = nodes;
  const dragTargetRef = useRef<string | null>(null);

  // ── Build descendants set for a given node ────────────────────────────────
  const getDescendants = useCallback((nodeId: string): Set<string> => {
    const all = serverNodesRef.current;
    const desc = new Set<string>([nodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      all.forEach((n) => {
        if (n.parent_id && desc.has(n.parent_id) && !desc.has(n.id)) {
          desc.add(n.id); changed = true;
        }
      });
    }
    return desc;
  }, []);

  // ── Effect: rebuild layout when tree structure changes ────────────────────
  useEffect(() => {
    const positions = computeDagreLayout(nodes);

    const newRFNodes: RFOntologyNode[] = nodes.map((n) => ({
      id: n.id,
      type: "ontologyNode" as const,
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      data: {
        node: n,
        isSelected: n.id === selectedId,
        isDragTarget: false,
        isSearchMatch: !!searchQuery && n.name.toLowerCase().includes(searchQuery.toLowerCase()),
        actionsRef,
      },
      selected: n.id === selectedId,
    }));

    const hierarchyEdges: RFOntologyEdge[] = nodes
      .filter((n) => n.parent_id)
      .map((n) => ({
        id: `h-${n.parent_id}-${n.id}`,
        source: n.parent_id!,
        target: n.id,
        sourceHandle: "hier",
        targetHandle: "hier",
        type: "smoothstep",
        style: { stroke: "#94a3b8", strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8", width: 14, height: 14 },
        data: { linkType: "hierarchy" as const },
      }));

    const relEdges: RFOntologyEdge[] = edges.map((e) => ({
      id: `r-${e.id}`,
      source: e.source_id,
      target: e.target_id,
      sourceHandle: "rel",
      targetHandle: "rel",
      type: "default",
      style: { stroke: e.color ?? "#f97316", strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: e.color ?? "#f97316", width: 16, height: 16 },
      label: e.label ?? undefined,
      labelStyle: { fill: "#9a3412", fontWeight: 600, fontSize: 11 },
      labelBgStyle: { fill: "#fff7ed", fillOpacity: 0.95 },
      labelBgPadding: [4, 2] as [number, number],
      animated: true,
      selected: `r-${e.id}` === `r-${selectedEdgeId}`,
      data: { linkType: "relationship" as const, edge: e },
    }));

    setRfNodes(newRFNodes);
    setRfEdges([...hierarchyEdges, ...relEdges]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]); // structural changes only — don't include selectedId/searchQuery here

  // ── Effect: update visual state without re-running layout ────────────────
  useEffect(() => {
    setRfNodes((prev) =>
      prev.map((n) => ({
        ...n,
        data: {
          ...n.data,
          isSelected: n.id === selectedId,
          isDragTarget: n.id === dragTargetId,
          isSearchMatch: !!searchQuery && n.data.node.name.toLowerCase().includes(searchQuery.toLowerCase()),
        },
        selected: n.id === selectedId,
      }))
    );
  }, [selectedId, dragTargetId, searchQuery]);

  // ── Effect: update relationship edge selection ────────────────────────────
  useEffect(() => {
    setRfEdges((prev) =>
      prev.map((e) => ({
        ...e,
        selected: e.data?.linkType === "relationship" && e.id === `r-${selectedEdgeId}`,
      }))
    );
  }, [selectedEdgeId]);

  // ── Drag handlers — detect when a node is dragged onto another ───────────

  const onNodeDrag: OnNodeDrag<RFOntologyNode> = useCallback((_event, draggedNode) => {
    const cx = draggedNode.position.x + NODE_W / 2;
    const cy = draggedNode.position.y + NODE_H / 2;

    let targetId: string | null = null;
    rfNodesRef.current.forEach((n) => {
      if (n.id === draggedNode.id) return;
      const nx = n.position.x, ny = n.position.y;
      // Overlap: dragged node center is inside target node's bounding box + 10px padding
      if (cx >= nx - 10 && cx <= nx + NODE_W + 10 && cy >= ny - 10 && cy <= ny + NODE_H + 10) {
        targetId = n.id;
      }
    });

    if (targetId !== dragTargetRef.current) {
      dragTargetRef.current = targetId;
      setDragTargetId(targetId);
    }
  }, []);

  const onNodeDragStop = useCallback((_event: React.MouseEvent, draggedNode: RFOntologyNode) => {
    const targetId = dragTargetRef.current;
    if (targetId) {
      const isDesc = getDescendants(draggedNode.id).has(targetId);
      if (!isDesc) {
        onReparent(draggedNode.id, targetId);
      }
    }
    dragTargetRef.current = null;
    setDragTargetId(null);
  }, [getDescendants, onReparent]);

  // ── Connection — only allow rel→rel to create relationship edges ──────────

  const isValidConnection = useCallback((connection: Connection) => {
    if (connection.sourceHandle !== "rel" || connection.targetHandle !== "rel") return false;
    if (!connection.source || !connection.target) return false;
    if (connection.source === connection.target) return false;
    // Prevent duplicates client-side (server also enforces this)
    const exists = edges.some(
      (e) => e.source_id === connection.source && e.target_id === connection.target
    );
    return !exists;
  }, [edges]);

  const onConnect: OnConnect = useCallback((connection) => {
    if (connection.source && connection.target) {
      onCreateEdge(connection.source, connection.target);
    }
  }, [onCreateEdge]);

  // ── Derive edge/node map for name lookups in minimap ────────────────────
  const nodeColorFn = useCallback((n: RFOntologyNode) => {
    return n.data.node.color ?? NS_COLORS[n.data.node.namespace] ?? "#9ca3af";
  }, []);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={(_e, n) => onSelectNode(n.id)}
        onEdgeClick={(_e, e) => {
          if (e.data?.linkType === "relationship") {
            const edge = e.data.edge as OntologyEdge | undefined;
            onSelectEdge(edge?.id ?? null);
          }
        }}
        onPaneClick={() => { onSelectNode(null); onSelectEdge(null); }}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        maxZoom={2}
        deleteKeyCode={null} // disable delete key — use explicit buttons
        style={{ background: "#f8fafc" }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e2e8f0" />
        <Controls
          style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.1)", borderRadius: 8 }}
        />
        <MiniMap
          nodeColor={nodeColorFn}
          style={{ borderRadius: 8, border: "1px solid #e5e7eb" }}
          pannable
          zoomable
        />

        {/* Legend overlay */}
        <div
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            display: "flex",
            gap: 8,
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          <LegendChip color="#94a3b8" label="hierarchy" />
          <LegendChip color="#f97316" label="relationship" dashed />
        </div>

        {/* Hint */}
        <div
          style={{
            position: "absolute",
            bottom: 10,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 11,
            color: "#94a3b8",
            pointerEvents: "none",
            textAlign: "center",
            zIndex: 5,
          }}
        >
          Drag node onto another to reparent · Drag orange ● to create a relationship
        </div>
      </ReactFlow>
    </div>
  );
}

function LegendChip({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        padding: "3px 9px",
        borderRadius: 999,
        background: color + "18",
        color,
        border: `1px solid ${color}44`,
        fontWeight: 600,
      }}
    >
      <span
        style={{
          width: 18,
          height: 2,
          background: dashed ? "transparent" : color,
          borderTop: dashed ? `2px dashed ${color}` : "none",
          display: "inline-block",
          borderRadius: 1,
        }}
      />
      {label}
    </span>
  );
}
