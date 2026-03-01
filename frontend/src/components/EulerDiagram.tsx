/**
 * EulerDiagram — quantitative area-proportional Euler/Venn diagram.
 *
 * Circle radii are proportional to total records per source (area ∝ total).
 * Pairwise distances are optimised so overlap areas approximate the number of
 * shared paper groups between each pair of sources under the active strategy.
 *
 * Layout is computed by iterative spring-relaxation in eulerLayout.ts.
 *
 * Interaction:
 *   - Hover a circle → show per-source stats in the info bar below
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

// ── Layout constants ──────────────────────────────────────────────────────────
const R_MAX = 85;       // max circle radius in layout space
const ITERATIONS = 350; // relaxation steps
const PAD = 22;         // viewBox padding around bounding box

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

  // Compute viewBox from bounding box of all circles
  const minX = Math.min(...circles.map((c) => c.x - c.r)) - PAD;
  const minY = Math.min(...circles.map((c) => c.y - c.r)) - PAD;
  const maxX = Math.max(...circles.map((c) => c.x + c.r)) + PAD;
  const maxY = Math.max(...circles.map((c) => c.y + c.r)) + PAD;
  const vbW = maxX - minX;
  const vbH = maxY - minY;

  // Attach colour and name to each layout circle
  const enriched = circles.map((c, i) => ({
    ...c,
    color: SOURCE_COLORS[i % SOURCE_COLORS.length],
    name: sources.find((s) => s.id === c.id)?.name ?? c.id,
  }));

  // Cross-source cluster connection count for the hovered source
  const hoveredIdx = hoveredId
    ? sources.findIndex((s) => s.id === hoveredId)
    : -1;
  const crossCount =
    hoveredIdx >= 0
      ? matrix[hoveredIdx].reduce((s, v, j) => (j !== hoveredIdx ? s + v : s), 0)
      : 0;

  const hoveredTotals = hoveredId ? totalsMap[hoveredId] : null;
  const maxLabelLen = n <= 4 ? 13 : n <= 6 ? 11 : 9;
  const fontSize = n <= 3 ? 13 : n <= 5 ? 12 : 11;

  // Render order: dimmed circles first, selected/hovered on top
  const renderOrder = [...enriched].sort((a, b) => {
    const aFront = a.id === selectedSourceId || a.id === hoveredId ? 1 : 0;
    const bFront = b.id === selectedSourceId || b.id === hoveredId ? 1 : 0;
    return aFront - bFront;
  });

  return (
    <div>
      <svg
        viewBox={`${minX} ${minY} ${vbW} ${vbH}`}
        style={{ width: "100%", maxWidth: 580, display: "block" }}
        aria-label="Source overlap map"
      >
        {renderOrder.map((pos) => {
          const isSelected = selectedSourceId === pos.id;
          const isHovered  = hoveredId === pos.id;
          const isDimmed   = selectedSourceId !== null && !isSelected;

          const fillOp   = isDimmed ? 0.07 : isSelected ? 0.32 : isHovered ? 0.28 : 0.20;
          const strokeOp = isDimmed ? 0.18 : 0.72;
          const sw       = isSelected || isHovered ? 2.5 : 1.5;
          const textColor = isDimmed ? "#c5c5c5" : "#3c4043";
          const subColor  = isDimmed ? "#d5d5d5" : "#80868b";

          const label =
            pos.name.length > maxLabelLen
              ? pos.name.slice(0, maxLabelLen) + "…"
              : pos.name;

          const totalRec = totalsMap[pos.id]?.total;
          // Centre labels relative to circle centre; offset based on radius
          const labelY    = totalRec !== undefined ? pos.y - pos.r * 0.12 : pos.y;
          const subLabelY = pos.y + pos.r * 0.18;

          return (
            <g
              key={pos.id}
              style={{ cursor: "pointer" }}
              onClick={() => onSourceClick(isSelected ? null : pos.id)}
              onMouseEnter={() => setHoveredId(pos.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
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
              {/* Source name */}
              <text
                x={pos.x}
                y={labelY}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={fontSize}
                fontWeight={700}
                fill={textColor}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {label}
              </text>
              {/* Record count sub-label */}
              {totalRec !== undefined && (
                <text
                  x={pos.x}
                  y={subLabelY}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={fontSize - 1}
                  fill={subColor}
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >
                  {totalRec.toLocaleString()} records
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* ── Info bar ───────────────────────────────────────────────────── */}
      <div
        style={{
          minHeight: 26,
          borderTop: "1px solid #f1f3f4",
          marginTop: "0.15rem",
          padding: "0.25rem 0.5rem",
          fontSize: "0.82rem",
          color: "#3c4043",
        }}
      >
        {hoveredTotals ? (
          <>
            <strong>{sources.find((s) => s.id === hoveredId)?.name}</strong>
            {" — "}
            {hoveredTotals.total.toLocaleString()} total &middot;{" "}
            {(hoveredTotals.unique_count ?? hoveredTotals.total).toLocaleString()} unique &middot;{" "}
            {hoveredTotals.internal_overlaps ?? 0} within-source duplicates
            {crossCount > 0 && (
              <> &middot; {crossCount} cross-source cluster connection{crossCount !== 1 ? "s" : ""}</>
            )}
          </>
        ) : selectedSourceId ? (
          <>
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
              Clear
            </button>
          </>
        ) : (
          <span style={{ color: "#80868b" }}>
            Hover to see source statistics &middot; Click to filter paper groups below
          </span>
        )}
      </div>

      {/* ── Caption ────────────────────────────────────────────────────── */}
      <p style={{ fontSize: "0.76rem", color: "#80868b", margin: "0.2rem 0.5rem 0" }}>
        Circle size proportional to total records. Overlaps approximate pairwise
        shared paper-group counts under the active strategy.
      </p>
    </div>
  );
}
