/**
 * EulerDiagram — quantitative area-proportional Euler/Venn diagram.
 * Pan: drag. Zoom: scroll wheel or +/− buttons. Reset: Reset button.
 *
 * ViewBox is auto-fitted via getBBox() after render so it always shows
 * all circles and labels regardless of where the layout engine places them.
 *
 * ALL hooks are declared before any early return (Rules of Hooks).
 */
import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import type { OverlapVisualSummary, OverlapSourceItem } from "../api/client";
import { layoutEuler } from "../utils/eulerLayout";

export const SOURCE_COLORS = [
  "#4285f4", "#34a853", "#ea4335", "#f9ab00",
  "#ff7f00", "#9c27b0", "#00acc1", "#8d6e63",
];

const R_MAX       = 85;
const ITERATIONS  = 400;
const PAD         = 28;
const LABEL_GAP   = 14;
const MIN_VGAP    = 22;
const LABEL_FS    = 10.5;
const CONTAINER_H = 440;

interface ViewBox { x: number; y: number; w: number; h: number }
const DEFAULT_VB: ViewBox = { x: -400, y: -300, w: 800, h: 600 };

function stackLabelYs(desired: number[]): number[] {
  if (desired.length === 0) return [];
  const ys = [...desired];
  for (let i = 1; i < ys.length; i++)
    if (ys[i] < ys[i - 1] + MIN_VGAP) ys[i] = ys[i - 1] + MIN_VGAP;
  for (let i = ys.length - 2; i >= 0; i--)
    if (ys[i + 1] < ys[i] + MIN_VGAP) ys[i] = ys[i + 1] - MIN_VGAP;
  return ys;
}

interface Props {
  visualData: OverlapVisualSummary;
  sourceTotals: OverlapSourceItem[];
  selectedSourceId: string | null;
  onSourceClick: (id: string | null) => void;
}

export default function EulerDiagram({ visualData, sourceTotals, selectedSourceId, onSourceClick }: Props) {

  // ── ALL HOOKS (before any early return) ──────────────────────────────────
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [vb, setVb]               = useState<ViewBox>(DEFAULT_VB);
  const [grabbing, setGrabbing]   = useState(false);

  const svgRef     = useRef<SVGSVGElement>(null);
  const gRef       = useRef<SVGGElement>(null);       // wraps all SVG content → used for getBBox
  const vbRef      = useRef<ViewBox>(DEFAULT_VB);
  const fittedRef  = useRef<ViewBox>(DEFAULT_VB);     // last auto-fitted vb, used by Reset
  const dragRef    = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0, moved: false });
  const touchRef   = useRef({ prevDist: 0, prevMidX: 0, prevMidY: 0 });

  useEffect(() => { vbRef.current = vb; }, [vb]);

  // ── Data / layout ────────────────────────────────────────────────────────
  const { sources, matrix } = visualData;
  const n = sources.length;

  const totalsMap = useMemo(() => {
    const m: Record<string, OverlapSourceItem> = {};
    for (const t of sourceTotals) m[t.id] = t;
    return m;
  }, [sourceTotals]);

  const layoutInputs = useMemo(
    () => sources.map((s) => ({ id: s.id, total: totalsMap[s.id]?.total ?? 0 })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sources.map((s) => s.id).join(","), sourceTotals.map((t) => t.total).join(",")]
  );

  const circles = useMemo(
    () => layoutEuler(layoutInputs, matrix, R_MAX, ITERATIONS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutInputs.map((s) => `${s.id}:${s.total}`).join("|"), matrix.flat().join(",")]
  );

  // Key that changes whenever the layout result changes — drives auto-fit
  const circlesKey = circles.map((c) => `${c.id}:${c.x.toFixed(1)}:${c.y.toFixed(1)}:${c.r.toFixed(1)}`).join("|");

  // ── Auto-fit viewBox via getBBox after each layout change ────────────────
  // getBBox() returns actual SVG-coordinate bounds of all rendered content,
  // independent of the current viewBox — so this always shows everything.
  useEffect(() => {
    if (circles.length === 0) return;
    const id = requestAnimationFrame(() => {
      const g = gRef.current;
      if (!g) return;
      try {
        const bbox = g.getBBox();
        if (bbox.width > 0 && bbox.height > 0) {
          const px = Math.max(bbox.width  * 0.06, 28);
          const py = Math.max(bbox.height * 0.06, 28);
          const fitted: ViewBox = {
            x: bbox.x - px,
            y: bbox.y - py,
            w: bbox.width  + 2 * px,
            h: bbox.height + 2 * py,
          };
          fittedRef.current = fitted;
          setVb(fitted);
        }
      } catch (_) { /* getBBox can throw if SVG not attached */ }
    });
    return () => cancelAnimationFrame(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circlesKey]);

  // ── Non-passive wheel zoom ───────────────────────────────────────────────
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      setVb((v) => {
        const sx = v.w / rect.width, sy = v.h / rect.height;
        const mx = v.x + (e.clientX - rect.left) * sx;
        const my = v.y + (e.clientY - rect.top)  * sy;
        return { x: mx - (mx - v.x) * factor, y: my - (my - v.y) * factor, w: v.w * factor, h: v.h * factor };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ── Non-passive touch pan + pinch zoom ──────────────────────────────────
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        dragRef.current = { active: true, sx: e.touches[0].clientX, sy: e.touches[0].clientY,
          ox: vbRef.current.x, oy: vbRef.current.y, moved: false };
      } else if (e.touches.length === 2) {
        dragRef.current.active = false;
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        touchRef.current = {
          prevDist: Math.sqrt(dx * dx + dy * dy),
          prevMidX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          prevMidY: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.touches.length === 1 && dragRef.current.active) {
        const v = vbRef.current;
        const dx = (e.touches[0].clientX - dragRef.current.sx) * (v.w / rect.width);
        const dy = (e.touches[0].clientY - dragRef.current.sy) * (v.h / rect.height);
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragRef.current.moved = true;
        setVb({ ...v, x: dragRef.current.ox - dx, y: dragRef.current.oy - dy });
      } else if (e.touches.length === 2) {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const factor = touchRef.current.prevDist / dist;
        setVb((v) => {
          const sx = v.w / rect.width, sy = v.h / rect.height;
          const mx = v.x + (midX - rect.left) * sx;
          const my = v.y + (midY - rect.top)  * sy;
          const pdx = (midX - touchRef.current.prevMidX) * sx;
          const pdy = (midY - touchRef.current.prevMidY) * sy;
          return { x: mx - (mx - v.x) * factor - pdx, y: my - (my - v.y) * factor - pdy, w: v.w * factor, h: v.h * factor };
        });
        touchRef.current = { prevDist: dist, prevMidX: midX, prevMidY: midY };
      }
    };
    const onTouchEnd = () => { dragRef.current.active = false; };
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove",  onTouchMove,  { passive: false });
    el.addEventListener("touchend",   onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove",  onTouchMove);
      el.removeEventListener("touchend",   onTouchEnd);
    };
  }, []);

  // ── Mouse handlers ───────────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    dragRef.current = { active: true, sx: e.clientX, sy: e.clientY,
      ox: vbRef.current.x, oy: vbRef.current.y, moved: false };
    setGrabbing(true);
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragRef.current.active) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const v = vbRef.current;
    const dx = (e.clientX - dragRef.current.sx) * (v.w / rect.width);
    const dy = (e.clientY - dragRef.current.sy) * (v.h / rect.height);
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragRef.current.moved = true;
    setVb({ ...v, x: dragRef.current.ox - dx, y: dragRef.current.oy - dy });
  }, []);

  const stopDrag = useCallback(() => { dragRef.current.active = false; setGrabbing(false); }, []);
  const resetView = useCallback(() => setVb(fittedRef.current), []);
  const zoomBy    = useCallback((factor: number) => {
    setVb((v) => {
      const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
      return { x: cx - v.w * factor / 2, y: cy - v.h * factor / 2, w: v.w * factor, h: v.h * factor };
    });
  }, []);

  // ── Early return (safe — all hooks above) ────────────────────────────────
  if (n === 0 || circles.length === 0) return null;

  // ── Derive label positions ───────────────────────────────────────────────
  const crossCountMap: Record<string, number> = {};
  for (let i = 0; i < n; i++)
    crossCountMap[sources[i].id] = matrix[i].reduce((s, v, j) => j !== i ? s + v : s, 0);

  const enriched = circles.map((c, i) => ({
    ...c,
    color: SOURCE_COLORS[i % SOURCE_COLORS.length],
    name: sources.find((s) => s.id === c.id)?.name ?? c.id,
  }));

  const dMinX = Math.min(...circles.map((c) => c.x - c.r)) - PAD;
  const dMaxX = Math.max(...circles.map((c) => c.x + c.r)) + PAD;

  const centX      = enriched.reduce((s, c) => s + c.x, 0) / n;
  const leftGroup  = enriched.filter((c) => c.x < centX - 1).sort((a, b) => a.y - b.y);
  const rightGroup = enriched.filter((c) => c.x >= centX - 1).sort((a, b) => a.y - b.y);
  const leftYs     = stackLabelYs(leftGroup.map((c) => c.y));
  const rightYs    = stackLabelYs(rightGroup.map((c) => c.y));

  type LabelEntry = { lx: number; ly: number; side: "left" | "right" };
  const labelMap = new Map<string, LabelEntry>();
  leftGroup.forEach((c, i)  => labelMap.set(c.id, { lx: dMinX - LABEL_GAP,  ly: leftYs[i],  side: "left"  }));
  rightGroup.forEach((c, i) => labelMap.set(c.id, { lx: dMaxX + LABEL_GAP,  ly: rightYs[i], side: "right" }));

  const renderOrder = [...enriched].sort((a, b) => {
    const aF = a.id === selectedSourceId || a.id === hoveredId ? 1 : 0;
    const bF = b.id === selectedSourceId || b.id === hoveredId ? 1 : 0;
    return aF - bF;
  });

  const hoveredTotals = hoveredId ? totalsMap[hoveredId] : null;
  const hoveredName   = hoveredId ? sources.find((s) => s.id === hoveredId)?.name : null;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", marginBottom: "0.4rem" }}>
        <button className="btn-ghost btn-sm" onClick={() => zoomBy(1 / 1.3)}
          style={{ fontWeight: 700, fontSize: "1rem", lineHeight: 1, padding: "0.1rem 0.5rem" }} title="Zoom in">+</button>
        <button className="btn-ghost btn-sm" onClick={() => zoomBy(1.3)}
          style={{ fontWeight: 700, fontSize: "1rem", lineHeight: 1, padding: "0.1rem 0.5rem" }} title="Zoom out">−</button>
        <button className="btn-ghost btn-sm" onClick={resetView}>Reset</button>
        <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginLeft: "0.25rem" }}>
          Scroll to zoom · Drag to pan
        </span>
        {selectedSourceId && (
          <button onClick={() => onSourceClick(null)} className="btn-ghost btn-sm"
            style={{ marginLeft: "auto", color: "var(--danger)", fontSize: "0.78rem" }}>
            ✕ Clear filter
          </button>
        )}
      </div>

      {/* Canvas */}
      <div style={{ width: "100%", height: CONTAINER_H, border: "1px solid var(--border)",
          borderRadius: "var(--radius)", overflow: "hidden", background: "var(--surface)" }}>
        <svg
          ref={svgRef}
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ width: "100%", height: "100%", display: "block",
            cursor: grabbing ? "grabbing" : "grab", userSelect: "none" }}
          aria-label="Source overlap map"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={stopDrag}
          onMouseLeave={stopDrag}
        >
          {/* Single <g> so getBBox() captures all content */}
          <g ref={gRef}>
            {/* Circles */}
            {renderOrder.map((pos) => {
              const isSelected = selectedSourceId === pos.id;
              const isHovered  = hoveredId === pos.id;
              const isDimmed   = selectedSourceId !== null && !isSelected;
              const totals     = totalsMap[pos.id];
              const fillOp    = isDimmed ? 0.06 : isSelected ? 0.28 : isHovered ? 0.22 : 0.13;
              const strokeOp  = isDimmed ? 0.20 : isSelected || isHovered ? 0.90 : 0.50;
              const sw        = isSelected || isHovered ? 2.4 : 1.2;
              const tooltip   =
                `${pos.name}\nTotal: ${(totals?.total ?? 0).toLocaleString()}\n` +
                `Unique: ${(totals?.unique_count ?? totals?.total ?? 0).toLocaleString()}\n` +
                `Within-source dups: ${totals?.internal_overlaps ?? 0}\n` +
                `Cross-source connections: ${crossCountMap[pos.id] ?? 0}`;
              return (
                <g key={pos.id}
                  style={{ cursor: grabbing ? "grabbing" : "pointer" }}
                  onClick={() => { if (!dragRef.current.moved) onSourceClick(isSelected ? null : pos.id); }}
                  onMouseEnter={() => setHoveredId(pos.id)}
                  onMouseLeave={() => setHoveredId(null)}
                >
                  <title>{tooltip}</title>
                  <circle cx={pos.x} cy={pos.y} r={pos.r}
                    fill={pos.color} fillOpacity={fillOp}
                    stroke={pos.color} strokeWidth={sw} strokeOpacity={strokeOp} />
                </g>
              );
            })}

            {/* Labels + leader lines */}
            {enriched.map((pos) => {
              const label = labelMap.get(pos.id);
              if (!label) return null;
              const totals     = totalsMap[pos.id];
              const isSelected = selectedSourceId === pos.id;
              const isHovered  = hoveredId === pos.id;
              const isDimmed   = selectedSourceId !== null && !isSelected;
              const ddx  = label.lx - pos.x, ddy = label.ly - pos.y;
              const dlen = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
              const bx   = pos.x + (ddx / dlen) * (pos.r + 3);
              const by   = pos.y + (ddy / dlen) * (pos.r + 3);
              const lineOp = isDimmed ? 0.16 : isSelected || isHovered ? 0.65 : 0.36;
              const textOp = isDimmed ? 0.28 : 1.0;
              const fw     = isSelected || isHovered ? 700 : 500;
              const textX  = label.lx + (label.side === "left" ? -4 : 4);
              const str    = totals ? `${pos.name} — ${totals.total.toLocaleString()}` : pos.name;
              return (
                <g key={`lbl-${pos.id}`} style={{ pointerEvents: "none" }}>
                  <line x1={bx} y1={by} x2={label.lx} y2={label.ly}
                    stroke={pos.color} strokeWidth={0.9} strokeOpacity={lineOp} />
                  <circle cx={bx} cy={by} r={1.8} fill={pos.color} fillOpacity={lineOp} />
                  <text x={textX} y={label.ly}
                    textAnchor={label.side === "left" ? "end" : "start"}
                    dominantBaseline="middle" fontSize={LABEL_FS} fontWeight={fw}
                    fill={pos.color} fillOpacity={textOp} style={{ userSelect: "none" }}>
                    {str}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* Info bar */}
      <div style={{ minHeight: 26, borderTop: "1px solid var(--border)", marginTop: "0.25rem",
          padding: "0.25rem 0.5rem", fontSize: "0.82rem", color: "var(--text)" }}>
        {hoveredTotals ? (
          <>
            <strong>{hoveredName}</strong>{" — "}
            {hoveredTotals.total.toLocaleString()} total &middot;{" "}
            {(hoveredTotals.unique_count ?? hoveredTotals.total).toLocaleString()} unique &middot;{" "}
            {hoveredTotals.internal_overlaps ?? 0} within-source dups
            {(crossCountMap[hoveredId!] ?? 0) > 0 && (
              <> &middot; {crossCountMap[hoveredId!]} cross-source connection{crossCountMap[hoveredId!] !== 1 ? "s" : ""}</>
            )}
          </>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>
            Hover a circle for stats · Click to filter · Scroll to zoom · Drag to pan
          </span>
        )}
      </div>

      <p style={{ fontSize: "0.76rem", color: "var(--text-muted)", margin: "0.15rem 0.5rem 0" }}>
        Circle area ∝ total records. Overlaps reflect pairwise shared paper-group counts.
      </p>
    </div>
  );
}
