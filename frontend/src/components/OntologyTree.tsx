/**
 * OntologyTree — interactive hierarchical taxonomy visualizer.
 *
 * Renders a collapsible tree from a flat depth-first node list.
 * Emits callbacks for selection, add, edit, and delete so the parent page
 * owns mutation state.
 *
 * Each row:
 *   [▶/▼] [color dot] name  [namespace badge]  [+ child] [✎] [✕]
 */
import { useState, useMemo, useCallback, useRef } from "react";
import type { OntologyNode, OntologyNamespace } from "../api/client";

// ── Namespace styling ─────────────────────────────────────────────────────────

export const NS_COLORS: Record<OntologyNamespace | string, string> = {
  level:        "#3b82f6",
  dimension:    "#10b981",
  concept:      "#6366f1",
  population:   "#8b5cf6",
  intervention: "#f97316",
  outcome:      "#14b8a6",
  other:        "#9ca3af",
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TreeNode extends OntologyNode {
  children: TreeNode[];
}

interface Props {
  nodes: OntologyNode[];           // flat list from server (depth-first order)
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAddChild: (parentId: string | null) => void;
  onDelete: (node: OntologyNode) => void;
  onReparent: (nodeId: string, newParentId: string | null) => void;
  searchQuery: string;
}

// ── Build tree from flat list ────────────────────────────────────────────────

function buildTree(flat: OntologyNode[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  flat.forEach((n) => map.set(n.id, { ...n, children: [] }));

  const roots: TreeNode[] = [];
  flat.forEach((n) => {
    const node = map.get(n.id)!;
    if (n.parent_id && map.has(n.parent_id)) {
      map.get(n.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

// ── Collect all descendant IDs ───────────────────────────────────────────────

function collectIds(node: TreeNode): Set<string> {
  const ids = new Set<string>([node.id]);
  node.children.forEach((c) => collectIds(c).forEach((id) => ids.add(id)));
  return ids;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function OntologyTree({
  nodes,
  selectedId,
  onSelect,
  onAddChild,
  onDelete,
  onReparent,
  searchQuery,
}: Props) {
  // All root-level nodes start expanded
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    nodes.filter((n) => n.depth === 0).forEach((n) => s.add(n.id));
    return s;
  });

  // Drag state — ref for immediate access in event handlers, state for rendering
  const draggedIdRef = useRef<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(nodes), [nodes]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Expand all ancestors when search is active so matches are visible
  const matchIds = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const q = searchQuery.toLowerCase();
    return new Set(nodes.filter((n) => n.name.toLowerCase().includes(q)).map((n) => n.id));
  }, [nodes, searchQuery]);

  // ── Drag handlers ──────────────────────────────────────────────────────────

  // Build descendant set for cycle prevention
  const descendantMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    function getDescendants(id: string): Set<string> {
      if (map.has(id)) return map.get(id)!;
      const s = new Set<string>([id]);
      nodes.filter((n) => n.parent_id === id).forEach((n) => getDescendants(n.id).forEach((d) => s.add(d)));
      map.set(id, s);
      return s;
    }
    nodes.forEach((n) => getDescendants(n.id));
    return map;
  }, [nodes]);

  const handleDragStart = useCallback((id: string) => {
    draggedIdRef.current = id;
    setDraggedId(id);
  }, []);

  const handleDragOver = useCallback(
    (id: string) => {
      const dId = draggedIdRef.current;
      if (!dId) return;
      // Don't allow dropping onto self or own descendants
      const descendants = descendantMap.get(dId);
      if (descendants?.has(id)) return;
      setDragOverId(id);
    },
    [descendantMap]
  );

  const handleDragEnd = useCallback(() => {
    draggedIdRef.current = null;
    setDraggedId(null);
    setDragOverId(null);
  }, []);

  const handleDrop = useCallback(
    (targetId: string) => {
      const dId = draggedIdRef.current;
      if (dId && dId !== targetId) {
        const descendants = descendantMap.get(dId);
        if (!descendants?.has(targetId)) {
          onReparent(dId, targetId);
        }
      }
      draggedIdRef.current = null;
      setDraggedId(null);
      setDragOverId(null);
    },
    [descendantMap, onReparent]
  );

  const handleDropRoot = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const dId = draggedIdRef.current;
      if (dId) {
        onReparent(dId, null);
      }
      draggedIdRef.current = null;
      setDraggedId(null);
      setDragOverId(null);
    },
    [onReparent]
  );

  if (tree.length === 0) {
    return (
      <div style={{ padding: "40px 20px", textAlign: "center", color: "#9ca3af", fontSize: 14 }}>
        No nodes yet.{" "}
        <button
          onClick={() => onAddChild(null)}
          style={{ background: "none", border: "none", color: "#6366f1", cursor: "pointer", fontSize: 14, textDecoration: "underline" }}
        >
          Add a root concept
        </button>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 13 }}>
      {/* Drop zone to promote a node to root */}
      {draggedId && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOverId("__root__"); }}
          onDragLeave={() => setDragOverId(null)}
          onDrop={handleDropRoot}
          style={{
            margin: "0 4px 6px",
            padding: "6px 12px",
            borderRadius: 6,
            border: `2px dashed ${dragOverId === "__root__" ? "#6366f1" : "#d1d5db"}`,
            background: dragOverId === "__root__" ? "#ede9fe" : "transparent",
            color: dragOverId === "__root__" ? "#6366f1" : "#9ca3af",
            fontSize: 12,
            textAlign: "center",
            transition: "all 0.1s",
          }}
        >
          Drop here to make root
        </div>
      )}
      {tree.map((root) => (
        <TreeNodeRow
          key={root.id}
          node={root}
          expanded={expanded}
          onToggle={toggle}
          selectedId={selectedId}
          onSelect={onSelect}
          onAddChild={onAddChild}
          onDelete={onDelete}
          matchIds={matchIds}
          searchQuery={searchQuery}
          draggedId={draggedId}
          dragOverId={dragOverId}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
        />
      ))}
    </div>
  );
}

// ── Recursive row ─────────────────────────────────────────────────────────────

interface RowProps {
  node: TreeNode;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAddChild: (parentId: string | null) => void;
  onDelete: (node: OntologyNode) => void;
  matchIds: Set<string> | null;
  searchQuery: string;
  draggedId: string | null;
  dragOverId: string | null;
  onDragStart: (id: string) => void;
  onDragOver: (id: string) => void;
  onDragEnd: () => void;
  onDrop: (targetId: string) => void;
}

function TreeNodeRow({
  node,
  expanded,
  onToggle,
  selectedId,
  onSelect,
  onAddChild,
  onDelete,
  matchIds,
  searchQuery,
  draggedId,
  dragOverId,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: RowProps) {
  const isExpanded = expanded.has(node.id);
  const isSelected = selectedId === node.id;
  const hasChildren = node.children.length > 0;
  const nsColor = NS_COLORS[node.namespace] ?? NS_COLORS.other;
  const isDragging = draggedId === node.id;
  const isDragOver = dragOverId === node.id;

  // Highlight search match
  const isMatch = matchIds ? matchIds.has(node.id) : false;
  const isVisible = matchIds === null || isMatch || node.children.some((c) => matchIds.has(c.id));

  if (!isVisible && matchIds !== null) return null;

  let rowBackground = "transparent";
  if (isDragOver) rowBackground = "#dbeafe";
  else if (isSelected) rowBackground = "#ede9fe";
  else if (isMatch && matchIds) rowBackground = "#fef9c3";

  return (
    <div>
      <div
        draggable
        onClick={() => onSelect(isSelected ? null : node.id)}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", node.id);
          e.dataTransfer.effectAllowed = "move";
          e.stopPropagation();
          onDragStart(node.id);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          e.stopPropagation();
          onDragOver(node.id);
        }}
        onDragLeave={(e) => { e.stopPropagation(); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(node.id); }}
        onDragEnd={(e) => { e.stopPropagation(); onDragEnd(); }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 8px",
          paddingLeft: 8 + node.depth * 20,
          borderRadius: 6,
          background: rowBackground,
          cursor: draggedId ? "copy" : "grab",
          userSelect: "none",
          opacity: isDragging ? 0.4 : 1,
          borderLeft: isDragOver
            ? `3px solid #3b82f6`
            : isSelected
            ? `3px solid ${nsColor}`
            : "3px solid transparent",
          outline: isDragOver ? "1px dashed #93c5fd" : "none",
          transition: "background 0.1s, border-color 0.1s",
        }}
      >
        {/* Expand/collapse toggle */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
          style={{
            background: "none",
            border: "none",
            cursor: hasChildren ? "pointer" : "default",
            width: 16,
            fontSize: 10,
            color: hasChildren ? "#6b7280" : "transparent",
            padding: 0,
            flexShrink: 0,
          }}
          title={hasChildren ? (isExpanded ? "Collapse" : "Expand") : undefined}
        >
          {hasChildren ? (isExpanded ? "▼" : "▶") : "○"}
        </button>

        {/* Color dot */}
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: node.color ?? nsColor,
            flexShrink: 0,
            display: "inline-block",
          }}
        />

        {/* Name */}
        <span
          style={{
            flex: 1,
            fontWeight: isSelected ? 600 : 400,
            color: "#111827",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {highlightMatch(node.name, searchQuery)}
        </span>

        {/* Children count badge */}
        {hasChildren && (
          <span
            style={{
              fontSize: 10,
              color: "#9ca3af",
              background: "#f3f4f6",
              borderRadius: 999,
              padding: "1px 5px",
              flexShrink: 0,
            }}
          >
            {collectIds(node).size - 1}
          </span>
        )}

        {/* Namespace badge */}
        <span
          style={{
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 999,
            background: nsColor + "22",
            color: nsColor,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {node.namespace}
        </span>

        {/* Action buttons — visible on row hover / when selected */}
        <div
          className="tree-row-actions"
          style={{ display: "flex", gap: 2, flexShrink: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          <ActionBtn
            title="Add child node"
            onClick={() => onAddChild(node.id)}
            color="#6366f1"
          >
            +
          </ActionBtn>
          <ActionBtn
            title="Delete node (children promoted)"
            onClick={() => onDelete(node)}
            color="#ef4444"
          >
            ✕
          </ActionBtn>
        </div>
      </div>

      {/* Children */}
      {isExpanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.id}
              node={child}
              expanded={expanded}
              onToggle={onToggle}
              selectedId={selectedId}
              onSelect={onSelect}
              onAddChild={onAddChild}
              onDelete={onDelete}
              matchIds={matchIds}
              searchQuery={searchQuery}
              draggedId={draggedId}
              dragOverId={dragOverId}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDragEnd={onDragEnd}
              onDrop={onDrop}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ActionBtn({
  children,
  title,
  onClick,
  color,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  color: string;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        background: "none",
        border: "none",
        cursor: "pointer",
        color,
        fontSize: 12,
        padding: "1px 4px",
        borderRadius: 4,
        lineHeight: 1,
        opacity: 0.6,
      }}
      onMouseEnter={(e) => ((e.target as HTMLButtonElement).style.opacity = "1")}
      onMouseLeave={(e) => ((e.target as HTMLButtonElement).style.opacity = "0.6")}
    >
      {children}
    </button>
  );
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: "#fde68a", padding: 0 }}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}
