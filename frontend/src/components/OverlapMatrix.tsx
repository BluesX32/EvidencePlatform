import React from "react";
import type { OverlapVisualSummary } from "../api/client";

interface Props {
  data: OverlapVisualSummary;
  onCellClick?: (sourceAId: string, sourceBId: string) => void;
  highlightPair?: [string, string] | null;
}

const MAX_LABEL_LEN = 14;

function truncate(s: string): string {
  return s.length > MAX_LABEL_LEN ? s.slice(0, MAX_LABEL_LEN) + "…" : s;
}

export default function OverlapMatrix({ data, onCellClick, highlightPair }: Props) {
  const { sources, matrix, unique_counts } = data;
  const n = sources.length;

  if (n === 0) return null;

  function isHighlighted(i: number, j: number): boolean {
    if (!highlightPair) return false;
    const [aId, bId] = highlightPair;
    return (
      (sources[i].id === aId && sources[j].id === bId) ||
      (sources[i].id === bId && sources[j].id === aId)
    );
  }

  const maxCount = Math.max(
    1,
    ...matrix.flatMap((row, i) => row.filter((_, j) => i !== j))
  );

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: "0.82rem",
          minWidth: `${(n + 1) * 74}px`,
        }}
      >
        <thead>
          <tr>
            {/* empty top-left cell */}
            <th style={headerCell}></th>
            {sources.map((s) => (
              <th
                key={s.id}
                title={s.name}
                style={{ ...headerCell, maxWidth: 100 }}
              >
                {truncate(s.name)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sources.map((rowSource, i) => (
            <tr key={rowSource.id}>
              <th
                title={rowSource.name}
                style={{ ...headerCell, textAlign: "right", maxWidth: 120 }}
              >
                {truncate(rowSource.name)}
              </th>
              {sources.map((colSource, j) => {
                const isDiag = i === j;
                const count = isDiag
                  ? (unique_counts[rowSource.id] ?? 0)
                  : matrix[i]?.[j] ?? 0;
                const highlighted = !isDiag && isHighlighted(i, j);
                const clickable =
                  !isDiag && !!onCellClick && (matrix[i]?.[j] ?? 0) > 0;
                const intensity = isDiag
                  ? 0
                  : Math.min(0.12 + (count / maxCount) * 0.55, 0.67);

                return (
                  <td
                    key={colSource.id}
                    onClick={
                      clickable
                        ? () => onCellClick!(rowSource.id, colSource.id)
                        : undefined
                    }
                    title={
                      isDiag
                        ? `${rowSource.name}: ${count} unique records`
                        : count > 0
                        ? `${rowSource.name} ∩ ${colSource.name}: ${count} shared cluster${count !== 1 ? "s" : ""}`
                        : "No overlap detected"
                    }
                    style={{
                      ...dataCell,
                      background: isDiag
                        ? "#f1f3f4"
                        : highlighted
                        ? "#fce8e6"
                        : count > 0
                        ? `rgba(26, 115, 232, ${intensity})`
                        : "transparent",
                      color: isDiag
                        ? "#80868b"
                        : highlighted
                        ? "#c5221f"
                        : count > 0
                        ? "#1a73e8"
                        : "#ccc",
                      fontStyle: isDiag ? "italic" : "normal",
                      cursor: clickable ? "pointer" : "default",
                      border: highlighted
                        ? "2px solid #ea4335"
                        : "1px solid #e0e0e0",
                      fontWeight: isDiag ? 400 : count > 0 ? 600 : 400,
                    }}
                  >
                    {isDiag ? count : count > 0 ? count : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const headerCell: React.CSSProperties = {
  padding: "0.35rem 0.55rem",
  fontWeight: 600,
  background: "#f8f9fa",
  border: "1px solid #e0e0e0",
  textAlign: "center",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  fontSize: "0.8rem",
  color: "#3c4043",
};

const dataCell: React.CSSProperties = {
  padding: "0.35rem 0.55rem",
  textAlign: "center",
  border: "1px solid #e0e0e0",
  minWidth: 56,
  transition: "background 0.12s",
};
