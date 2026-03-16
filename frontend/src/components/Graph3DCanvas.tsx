/**
 * Graph3DCanvas — lightweight React wrapper around `3d-force-graph`.
 *
 * Deliberately uses the lower-level `3d-force-graph` package (pure three.js)
 * instead of `react-force-graph` to avoid the aframe / VR / AR dependency
 * chain which triggers an AFRAME.registerComponent ReferenceError when
 * Vite pre-bundles the whole library into a single ESM file.
 *
 * API: imperative (kapsule pattern).  We create the graph once on mount,
 * then call `.graphData()`, `.width()`, `.height()` reactively via effects.
 *
 * Link types:
 *   "hierarchy"    — parent-child tree edge (gray, thin)
 *   "relationship" — explicit ontology edge (orange, thicker, labeled)
 */
import { useEffect, useRef, memo } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ForceGraph3DInstance = any;

export interface G3DNode {
  id: string;
  name: string;
  namespace: string;
  nodeColor: string;
  val: number;
  // injected by force-simulation at runtime:
  x?: number;
  y?: number;
  z?: number;
}

export interface G3DLink {
  source: string;
  target: string;
  linkType?: "hierarchy" | "relationship";
  label?: string;
  edgeId?: string; // OntologyEdge.id — only set for relationship links
}

export interface G3DData {
  nodes: G3DNode[];
  links: G3DLink[];
}

interface Props {
  graphData: G3DData;
  width: number;
  height: number;
  onNodeClick?: (node: G3DNode) => void;
  onNodeDragEnd?: (node: G3DNode) => void;
  onLinkClick?: (link: G3DLink) => void;
  /** When truthy, the node with this id is highlighted as the connect-mode source. */
  connectSourceId?: string | null;
}

function Graph3DCanvas({
  graphData,
  width,
  height,
  onNodeClick,
  onNodeDragEnd,
  onLinkClick,
  connectSourceId,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance>(null);

  // ── Init (mount only) ────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    let g: ForceGraph3DInstance;

    // Dynamic import keeps 3d-force-graph out of the main bundle.
    import("3d-force-graph").then((mod) => {
      // kapsule pattern: ForceGraph3D() returns a factory, factory(el) attaches
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ForceGraph3D = (mod as any).default ?? mod;
      g = ForceGraph3D()(containerRef.current!)
        .backgroundColor("#0f172a")
        .nodeLabel((n: G3DNode) => `${n.name} [${n.namespace}]`)
        .nodeColor((n: G3DNode) => n.nodeColor)
        .nodeVal((n: G3DNode) => n.val)
        // Link styling by type
        .linkColor((l: G3DLink) =>
          l.linkType === "relationship" ? "#f97316" : "rgba(148,163,184,0.35)"
        )
        .linkWidth((l: G3DLink) =>
          l.linkType === "relationship" ? 2.5 : 1.2
        )
        .linkLabel((l: G3DLink) => l.label ?? "")
        .linkDirectionalArrowLength((l: G3DLink) =>
          l.linkType === "relationship" ? 7 : 4
        )
        .linkDirectionalArrowRelPos(1)
        .linkDirectionalParticles((l: G3DLink) =>
          l.linkType === "relationship" ? 2 : 1
        )
        .linkDirectionalParticleSpeed((l: G3DLink) =>
          l.linkType === "relationship" ? 0.006 : 0.004
        )
        .linkDirectionalParticleColor((l: G3DLink) =>
          l.linkType === "relationship" ? "#f97316" : "rgba(148,163,184,0.7)"
        )
        .width(width)
        .height(height)
        .graphData(graphData);

      if (onNodeClick)   g.onNodeClick(onNodeClick);
      if (onNodeDragEnd) g.onNodeDragEnd(onNodeDragEnd);
      if (onLinkClick)   g.onLinkClick(onLinkClick);

      graphRef.current = g;
    }).catch((err) => {
      console.error("[Graph3DCanvas] failed to load 3d-force-graph:", err);
    });

    return () => {
      // Clean up WebGL context and animation loop
      try { graphRef.current?._destructor?.(); } catch (_) { /* ignore */ }
      graphRef.current = null;
    };
    // run only once — callbacks are set once and close over stable refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reactive updates ─────────────────────────────────────────────────────
  useEffect(() => {
    graphRef.current?.graphData(graphData);
  }, [graphData]);

  useEffect(() => {
    if (width > 0 && height > 0) graphRef.current?.width(width).height(height);
  }, [width, height]);

  // Highlight the connect-mode source node with a distinct color
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    g.nodeColor((n: G3DNode) => {
      if (connectSourceId && n.id === connectSourceId) return "#facc15"; // yellow
      return n.nodeColor;
    });
  }, [connectSourceId]);

  return (
    <div
      ref={containerRef}
      style={{ width, height, overflow: "hidden" }}
    />
  );
}

export default memo(Graph3DCanvas);
