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
import { useState, useMemo, useCallback } from "react";
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
  searchQuery,
}: Props) {
  // All root-level nodes start expanded
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    nodes.filter((n) => n.depth === 0).forEach((n) => s.add(n.id));
    return s;
  });

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
}: RowProps) {
  const isExpanded = expanded.has(node.id);
  const isSelected = selectedId === node.id;
  const hasChildren = node.children.length > 0;
  const nsColor = NS_COLORS[node.namespace] ?? NS_COLORS.other;

  // Highlight search match
  const isMatch = matchIds ? matchIds.has(node.id) : false;
  const isVisible = matchIds === null || isMatch || node.children.some((c) => matchIds.has(c.id));

  if (!isVisible && matchIds !== null) return null;

  return (
    <div>
      <div
        onClick={() => onSelect(isSelected ? null : node.id)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 8px",
          paddingLeft: 8 + node.depth * 20,
          borderRadius: 6,
          background: isSelected
            ? "#ede9fe"
            : isMatch && matchIds
            ? "#fef9c3"
            : "transparent",
          cursor: "pointer",
          userSelect: "none",
          borderLeft: isSelected ? `3px solid ${nsColor}` : "3px solid transparent",
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
