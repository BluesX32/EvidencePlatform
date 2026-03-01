/**
 * EulerDiagram — SVG-based translucent-circle overlap visualization.
 *
 * Renders each source as a translucent circle arranged in a deterministic
 * circular layout (petal pattern).  For 2–4 sources this resembles a classic
 * Venn diagram; for more sources it produces an overlapping-petal pattern that
 * conveys overlap structure without claiming area-proportional accuracy.
 *
 * Interaction:
 *   - Hover a circle → show per-source stats in info bar below
 *   - Click a circle → call onSourceClick(id) to filter the cluster list
 *   - Click again   → onSourceClick(null) to clear filter
 */
import { useState } from "react";
import type { OverlapVisualSummary, OverlapSourceItem } from "../api/client";

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
const SVG_W = 560;
const SVG_H = 340;
const CX = SVG_W / 2;
const CY = SVG_H / 2;

/**
 * Return the circle radius (r) and placement-ring radius (Rp) for N sources.
 * Values are empirically tuned so adjacent circles overlap by ~30–40%.
 */
function circleParams(n: number): { r: number; Rp: number } {
  if (n <= 1) return { r: 90, Rp: 0   };
  if (n === 2) return { r: 90, Rp: 67  };
  if (n === 3) return { r: 85, Rp: 80  };
  if (n === 4) return { r: 80, Rp: 90  };
  if (n === 5) return { r: 74, Rp: 100 };
  if (n === 6) return { r: 68, Rp: 107 };
  if (n === 7) return { r: 62, Rp: 112 };
  return {
    r:  Math.max(48, 62 - (n - 7) * 3),
    Rp: Math.min(130, 112 + (n - 7) * 7),
  };
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
  if (n === 0) return null;

  const { r, Rp } = circleParams(n);

  // Build lookup: source id → totals row
  const totalsMap: Record<string, OverlapSourceItem> = {};
  for (const t of sourceTotals) totalsMap[t.id] = t;

  // Compute (x, y) for each source circle on the arrangement ring
  const positions = sources.map((s, i) => {
    const angle = (i * 2 * Math.PI) / n - Math.PI / 2;
    return {
      id:    s.id,
      name:  s.name,
      x:     n === 1 ? CX : CX + Rp * Math.cos(angle),
      y:     n === 1 ? CY : CY + Rp * Math.sin(angle),
      color: SOURCE_COLORS[i % SOURCE_COLORS.length],
    };
  });

  // Cross-source cluster connection count for the hovered source
  // (sum of matrix row, excluding diagonal — a cluster spanning A+B+C
  // increments [A,B], [A,C], [B,C] so this is a "connection count" not cluster count)
  const hoveredIdx = hoveredId
    ? sources.findIndex((s) => s.id === hoveredId)
    : -1;
  const crossCount =
    hoveredIdx >= 0
      ? matrix[hoveredIdx].reduce((s, v, j) => (j !== hoveredIdx ? s + v : s), 0)
      : 0;

  const hoveredTotals = hoveredId ? totalsMap[hoveredId] : null;
  const maxLabelLen   = n <= 4 ? 13 : n <= 6 ? 11 : 9;
  const fontSize      = n <= 4 ? 12 : n <= 6 ? 11 : 10;

  // Render order: dimmed circles first (behind), selected/hovered on top
  const renderOrder = [...positions].sort((a, b) => {
    const aFront = a.id === selectedSourceId || a.id === hoveredId ? 1 : 0;
    const bFront = b.id === selectedSourceId || b.id === hoveredId ? 1 : 0;
    return aFront - bFront;
  });

  return (
    <div>
      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        style={{ width: "100%", maxWidth: SVG_W, display: "block" }}
        aria-label="Source overlap map"
      >
        {renderOrder.map((pos) => {
          const isSelected = selectedSourceId === pos.id;
          const isHovered  = hoveredId === pos.id;
          const isDimmed   = selectedSourceId !== null && !isSelected;

          const fillOp  = isDimmed ? 0.07 : isSelected ? 0.30 : isHovered ? 0.26 : 0.20;
          const strokeOp = isDimmed ? 0.18 : 0.72;
          const sw       = isSelected || isHovered ? 2.5 : 1.5;
          const textColor = isDimmed ? "#c5c5c5" : "#3c4043";
          const subColor  = isDimmed ? "#d5d5d5" : "#80868b";

          const label =
            pos.name.length > maxLabelLen
              ? pos.name.slice(0, maxLabelLen) + "…"
              : pos.name;

          const totalRec = totalsMap[pos.id]?.total;

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
                r={r}
                fill={pos.color}
                fillOpacity={fillOp}
                stroke={pos.color}
                strokeWidth={sw}
                strokeOpacity={strokeOp}
              />
              {/* Source name label */}
              <text
                x={pos.x}
                y={totalRec !== undefined ? pos.y - 7 : pos.y}
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
                  y={pos.y + 9}
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

      {/* ── Info bar below the SVG ───────────────────────────────────────── */}
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
            {(hoveredTotals.internal_overlaps ?? 0)} within-source duplicates
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
    </div>
  );
}
