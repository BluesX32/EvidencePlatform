/**
 * EulerDiagram — quantitative area-proportional Euler/Venn diagram.
 *
 * Circle radii are proportional to total records per source (area ∝ total).
 * Pairwise distances are optimised so overlap areas approximate the number of
 * shared paper groups between each pair of sources under the active strategy.
 *
 * Layout is computed by iterative spring-relaxation in eulerLayout.ts.
 *
 * Labels are placed outside the circles with thin leader lines to keep the
 * diagram readable regardless of circle sizes or overlap density.
 *
 * Interaction:
 *   - Hover a circle → info bar below shows per-source stats
 *   - Click a circle → call onSourceClick(id) to filter the cluster list
 *   - Click again   → onSourceClick(null) to clear filter
 */
import { useMemo, useState } from "react";
import type { OverlapVisualSummary, OverlapSourceItem } from "../api/client";
import { layoutEuler } from "../utils/eulerLayout";

// ── Colour palette ────────────────────────────────────────────────────────────
// Exported so OverlapPage can assign the same colour to source badges.
export const SOURCE_COLORS = [
  "#4285f4", // blue
  "#34a853", // green
  "#ea4335", // red
  "#f9ab00", // amber
  "#ff7f00", // orange
  "#9c27b0", // purple
  "#00acc1", // teal
  "#8d6e63", // brown
];

// ── Layout / rendering constants ──────────────────────────────────────────────
const R_MAX     = 85;   // max circle radius in layout space
const ITERATIONS = 350; // relaxation steps
const PAD       = 28;   // viewBox padding around circle bounding box
const LABEL_W   = 148;  // extra SVG units reserved on each side for labels
const LABEL_GAP = 14;   // horizontal gap from diagram edge to leader endpoint
const MIN_VGAP  = 22;   // minimum vertical spacing between labels (SVG units)
const LABEL_FS  = 10.5; // label font size

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Stack label y-positions with a minimum vertical gap.
 * Forward pass pushes crowded labels downward; backward pass then pulls them
 * up if there is room, keeping them centred around their ideal positions.
 */
function stackLabelYs(desired: number[]): number[] {
  if (desired.length === 0) return [];
  const ys = [...desired];
  // Push down
  for (let i = 1; i < ys.length; i++) {
    if (ys[i] < ys[i - 1] + MIN_VGAP) ys[i] = ys[i - 1] + MIN_VGAP;
  }
  // Pull up
  for (let i = ys.length - 2; i >= 0; i--) {
    if (ys[i + 1] < ys[i] + MIN_VGAP) ys[i] = ys[i + 1] - MIN_VGAP;
  }
  return ys;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  visualData: OverlapVisualSummary;
  sourceTotals: OverlapSourceItem[];
  selectedSourceId: string | null;
  onSourceClick: (id: string | null) => void;
}

export default function EulerDiagram({
  visualData,
  sourceTotals,
  selectedSourceId,
  onSourceClick,
}: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const { sources, matrix } = visualData;
  const n = sources.length;

  // Build lookup: source id → totals row
  const totalsMap: Record<string, OverlapSourceItem> = {};
  for (const t of sourceTotals) totalsMap[t.id] = t;

  // Run area-proportional layout (memoised on meaningful data changes)
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

  if (n === 0 || circles.length === 0) return null;

  // Precompute cross-source cluster connection count per source (matrix row sum)
  const crossCountMap: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    crossCountMap[sources[i].id] = matrix[i].reduce(
      (s, v, j) => (j !== i ? s + v : s),
      0
    );
  }

  // Attach colour and name to each layout circle
  const enriched = circles.map((c, i) => ({
    ...c,
    color: SOURCE_COLORS[i % SOURCE_COLORS.length],
    name: sources.find((s) => s.id === c.id)?.name ?? c.id,
  }));

  // ── Diagram bounding box (circles only) ──────────────────────────────────
  const dMinX = Math.min(...circles.map((c) => c.x - c.r)) - PAD;
  const dMinY = Math.min(...circles.map((c) => c.y - c.r)) - PAD;
  const dMaxX = Math.max(...circles.map((c) => c.x + c.r)) + PAD;
  const dMaxY = Math.max(...circles.map((c) => c.y + c.r)) + PAD;

  // Horizontal anchor x for leader line endpoints
  const leftAnchorX  = dMinX - LABEL_GAP;
  const rightAnchorX = dMaxX + LABEL_GAP;

  // ── Assign circles to left / right label columns ──────────────────────────
  // Circles left of the centroid get left-side labels; others go right.
  const centX = enriched.reduce((s, c) => s + c.x, 0) / n;

  const leftGroup  = enriched.filter((c) => c.x < centX - 1).sort((a, b) => a.y - b.y);
  const rightGroup = enriched.filter((c) => c.x >= centX - 1).sort((a, b) => a.y - b.y);

  const leftYs  = stackLabelYs(leftGroup.map((c) => c.y));
  const rightYs = stackLabelYs(rightGroup.map((c) => c.y));

  type LabelEntry = { lx: number; ly: number; side: "left" | "right" };
  const labelMap = new Map<string, LabelEntry>();
  leftGroup.forEach((c, i) =>
    labelMap.set(c.id, { lx: leftAnchorX,  ly: leftYs[i],  side: "left"  })
  );
  rightGroup.forEach((c, i) =>
    labelMap.set(c.id, { lx: rightAnchorX, ly: rightYs[i], side: "right" })
  );

  // ── Full viewBox: include label columns + vertical extent of all labels ───
  const allLabelYs = [...labelMap.values()].map((l) => l.ly);
  const vbX = dMinX - LABEL_W;
  const vbY = Math.min(dMinY, ...allLabelYs) - 8;
  const vbW = dMaxX + LABEL_W - vbX;
  const vbH = Math.max(dMaxY, ...allLabelYs) - vbY + 8;

  // ── Render order: hovered / selected circles drawn on top ────────────────
  const renderOrder = [...enriched].sort((a, b) => {
    const aFront = a.id === selectedSourceId || a.id === hoveredId ? 1 : 0;
    const bFront = b.id === selectedSourceId || b.id === hoveredId ? 1 : 0;
    return aFront - bFront;
  });

  const hoveredTotals = hoveredId ? totalsMap[hoveredId] : null;
  const hoveredName   = hoveredId ? sources.find((s) => s.id === hoveredId)?.name : null;

  return (
    <div>
      {/* ── Clear selection ─────────────────────────────────────────────── */}
      {selectedSourceId && (
        <div style={{ marginBottom: "0.3rem", fontSize: "0.82rem", color: "#3c4043" }}>
          Filtering by{" "}
          <strong>{sources.find((s) => s.id === selectedSourceId)?.name}</strong>.{" "}
          <button
            onClick={() => onSourceClick(null)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#1a73e8",
              fontSize: "0.82rem",
              padding: 0,
            }}
          >
            Clear selection
          </button>
        </div>
      )}

      <svg
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        style={{ width: "100%", maxWidth: 780, display: "block" }}
        aria-label="Source overlap map"
      >
        {/* ── Circles ────────────────────────────────────────────────────── */}
        {renderOrder.map((pos) => {
          const isSelected = selectedSourceId === pos.id;
          const isHovered  = hoveredId === pos.id;
          const isDimmed   = selectedSourceId !== null && !isSelected;
          const totals     = totalsMap[pos.id];

          const fillOp   = isDimmed ? 0.06 : isSelected ? 0.28 : isHovered ? 0.22 : 0.13;
          const strokeOp = isDimmed ? 0.20 : isSelected || isHovered ? 0.90 : 0.50;
          const sw       = isSelected || isHovered ? 2.4 : 1.2;

          // Native browser tooltip (shows on extended hover)
          const uniqueRec   = totals?.unique_count ?? totals?.total ?? 0;
          const internalDup = totals?.internal_overlaps ?? 0;
          const crossCt     = crossCountMap[pos.id] ?? 0;
          const tooltipText =
            `${pos.name}\n` +
            `Total: ${(totals?.total ?? 0).toLocaleString()} records\n` +
            `Unique: ${uniqueRec.toLocaleString()} records\n` +
            `Within-source duplicates: ${internalDup}\n` +
            `Cross-source cluster connections: ${crossCt}`;

          return (
            <g
              key={pos.id}
              style={{ cursor: "pointer" }}
              onClick={() => onSourceClick(isSelected ? null : pos.id)}
              onMouseEnter={() => setHoveredId(pos.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <title>{tooltipText}</title>
              <circle
                cx={pos.x}
                cy={pos.y}
                r={pos.r}
                fill={pos.color}
                fillOpacity={fillOp}
                stroke={pos.color}
                strokeWidth={sw}
                strokeOpacity={strokeOp}
              />
            </g>
          );
        })}

        {/* ── External labels + leader lines ──────────────────────────────── */}
        {enriched.map((pos) => {
          const label      = labelMap.get(pos.id);
          if (!label) return null;

          const totals     = totalsMap[pos.id];
          const isSelected = selectedSourceId === pos.id;
          const isHovered  = hoveredId === pos.id;
          const isDimmed   = selectedSourceId !== null && !isSelected;

          // Point on the circle boundary in the direction of the label anchor
          const ddx  = label.lx - pos.x;
          const ddy  = label.ly - pos.y;
          const dlen = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
          const bx   = pos.x + (ddx / dlen) * (pos.r + 3);
          const by   = pos.y + (ddy / dlen) * (pos.r + 3);

          const lineOp  = isDimmed ? 0.16 : isSelected || isHovered ? 0.65 : 0.36;
          const textOp  = isDimmed ? 0.28 : 1.0;
          const fw      = isSelected || isHovered ? 700 : 500;
          // Text offset: small gap after leader endpoint
          const textX   = label.lx + (label.side === "left" ? -4 : 4);
          const labelStr = totals
            ? `${pos.name} — ${totals.total.toLocaleString()} records`
            : pos.name;

          return (
            <g key={`lbl-${pos.id}`} style={{ pointerEvents: "none" }}>
              {/* Leader line */}
              <line
                x1={bx} y1={by}
                x2={label.lx} y2={label.ly}
                stroke={pos.color}
                strokeWidth={0.9}
                strokeOpacity={lineOp}
              />
              {/* Dot at the circle boundary */}
              <circle
                cx={bx} cy={by} r={1.8}
                fill={pos.color}
                fillOpacity={lineOp}
              />
              {/* Label text */}
              <text
                x={textX}
                y={label.ly}
                textAnchor={label.side === "left" ? "end" : "start"}
                dominantBaseline="middle"
                fontSize={LABEL_FS}
                fontWeight={fw}
                fill={pos.color}
                fillOpacity={textOp}
                style={{ userSelect: "none" }}
              >
                {labelStr}
              </text>
            </g>
          );
        })}
      </svg>

      {/* ── Info bar ───────────────────────────────────────────────────── */}
      <div
        style={{
          minHeight: 26,
          borderTop: "1px solid #f1f3f4",
          marginTop: "0.1rem",
          padding: "0.25rem 0.5rem",
          fontSize: "0.82rem",
          color: "#3c4043",
        }}
      >
        {hoveredTotals ? (
          <>
            <strong>{hoveredName}</strong>
            {" — "}
            {hoveredTotals.total.toLocaleString()} total &middot;{" "}
            {(hoveredTotals.unique_count ?? hoveredTotals.total).toLocaleString()} unique &middot;{" "}
            {hoveredTotals.internal_overlaps ?? 0} within-source duplicates
            {(crossCountMap[hoveredId!] ?? 0) > 0 && (
              <>
                {" "}&middot;{" "}
                {crossCountMap[hoveredId!]} cross-source cluster connection
                {crossCountMap[hoveredId!] !== 1 ? "s" : ""}
              </>
            )}
          </>
        ) : (
          <span style={{ color: "#80868b" }}>
            Hover to see source statistics &middot; Click to filter paper groups below
          </span>
        )}
      </div>

      {/* ── Caption ─────────────────────────────────────────────────────── */}
      <p style={{ fontSize: "0.76rem", color: "#80868b", margin: "0.2rem 0.5rem 0" }}>
        Circle size proportional to total records. Overlaps approximate pairwise
        shared paper-group counts under the active strategy.
      </p>
    </div>
  );
}
