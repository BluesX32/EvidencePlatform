import { useState } from "react";
import type { RecordItem } from "../api/client";

const BASIS_LABELS: Record<string, string> = {
  doi: "DOI",
  title_author_year: "Title+Author+Year",
  title_year: "Title+Year",
  title_author: "Title+Author",
  none: "—",
};

const BASIS_COLORS: Record<string, string> = {
  doi: "#1a73e8",
  title_author_year: "#188038",
  title_year: "#e37400",
  title_author: "#9334e6",
  none: "#888",
};

function MatchBasisBadge({ basis }: { basis: string | null }) {
  if (!basis) return <span style={{ color: "#aaa" }}>—</span>;
  const label = BASIS_LABELS[basis] ?? basis;
  const color = BASIS_COLORS[basis] ?? "#888";
  return (
    <span
      title={`Deduplicated by: ${label}`}
      style={{
        display: "inline-block",
        fontSize: "0.72rem",
        fontWeight: 600,
        color,
        background: `${color}18`,
        border: `1px solid ${color}44`,
        borderRadius: "0.25rem",
        padding: "0.1rem 0.35rem",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function formatAuthors(authors: string[] | null): string {
  if (!authors || authors.length === 0) return "—";
  if (authors.length === 1) return authors[0];
  return `${authors[0]} et al.`;
}

function truncate(s: string | null, max: number): string {
  if (!s) return "—";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function SortHeader({ label, asc, desc, current, onChange }: {
  label: string;
  asc: string;
  desc: string;
  current: string;
  onChange: (s: string) => void;
}) {
  const isAsc = current === asc;
  const isDesc = current === desc;
  const next = isDesc ? asc : desc;
  const arrow = isAsc ? " ↑" : isDesc ? " ↓" : "";
  return (
    <th onClick={() => onChange(next)} style={{ cursor: "pointer", userSelect: "none" }}>
      {label}{arrow}
    </th>
  );
}

// Optional columns that can be toggled
export interface ColumnVisibility {
  abstract: boolean;
  issn: boolean;
  keywords: boolean;
}

export const DEFAULT_COLUMNS: ColumnVisibility = {
  abstract: false,
  issn: false,
  keywords: false,
};

function ExpandedRow({
  record,
  colSpan,
}: {
  record: RecordItem;
  colSpan: number;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        style={{
          background: "var(--surface-alt, #f8f9fa)",
          borderTop: "none",
          padding: "0.75rem 1rem 1rem",
        }}
      >
        {/* Full authors */}
        {record.authors && record.authors.length > 1 && (
          <div style={{ marginBottom: "0.5rem" }}>
            <strong>Authors:</strong>{" "}
            <span>{record.authors.join("; ")}</span>
          </div>
        )}
        {/* Abstract */}
        {record.abstract ? (
          <div style={{ marginBottom: "0.5rem" }}>
            <strong>Abstract:</strong>
            <div
              style={{
                marginTop: "0.25rem",
                maxHeight: "10rem",
                overflowY: "auto",
                fontSize: "0.9rem",
                lineHeight: 1.5,
                color: "#444",
              }}
            >
              {record.abstract}
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: "0.5rem", color: "#888" }}>No abstract available.</div>
        )}
        {/* Keywords */}
        {record.keywords && record.keywords.length > 0 && (
          <div style={{ marginBottom: "0.4rem" }}>
            <strong>Keywords:</strong>{" "}
            <span style={{ color: "#555" }}>{record.keywords.join(", ")}</span>
          </div>
        )}
        {/* ISSN */}
        {record.issn && (
          <div style={{ marginBottom: "0.4rem" }}>
            <strong>ISSN:</strong> <span>{record.issn}</span>
          </div>
        )}
        {/* Match info */}
        <div style={{ color: "#888", fontSize: "0.8rem", marginTop: "0.25rem" }}>
          Match basis: {BASIS_LABELS[record.match_basis ?? ""] ?? record.match_basis ?? "none"}
        </div>
      </td>
    </tr>
  );
}

interface Props {
  records: RecordItem[];
  sort: string;
  onSortChange: (sort: string) => void;
  isLoading: boolean;
  columns?: ColumnVisibility;
  onColumnsChange?: (c: ColumnVisibility) => void;
}

export default function RecordsTable({
  records,
  sort,
  onSortChange,
  isLoading,
  columns = DEFAULT_COLUMNS,
  onColumnsChange,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showColPicker, setShowColPicker] = useState(false);

  if (isLoading && records.length === 0) {
    return <p>Loading records…</p>;
  }

  if (!isLoading && records.length === 0) {
    return <p className="muted">No records match your search.</p>;
  }

  // +2 for the expand toggle column (none visible) and Dedup column
  const optionalColCount =
    (columns.abstract ? 1 : 0) + (columns.issn ? 1 : 0) + (columns.keywords ? 1 : 0);
  const totalCols = 7 + optionalColCount;

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  return (
    <div className="table-wrapper">
      {/* Column picker */}
      {onColumnsChange && (
        <div style={{ marginBottom: "0.5rem", textAlign: "right" }}>
          <button
            className="btn-ghost"
            style={{ fontSize: "0.8rem" }}
            onClick={() => setShowColPicker((v) => !v)}
          >
            Columns ▾
          </button>
          {showColPicker && (
            <div
              style={{
                display: "inline-flex",
                gap: "0.75rem",
                alignItems: "center",
                marginLeft: "0.5rem",
                background: "#fff",
                border: "1px solid var(--border, #dadce0)",
                borderRadius: "0.375rem",
                padding: "0.4rem 0.75rem",
                fontSize: "0.85rem",
              }}
            >
              {(["abstract", "issn", "keywords"] as const).map((col) => (
                <label key={col} style={{ cursor: "pointer", userSelect: "none" }}>
                  <input
                    type="checkbox"
                    checked={columns[col]}
                    onChange={(e) =>
                      onColumnsChange({ ...columns, [col]: e.target.checked })
                    }
                    style={{ marginRight: "0.3rem" }}
                  />
                  {col.charAt(0).toUpperCase() + col.slice(1)}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <table className="records-table">
        <thead>
          <tr>
            <th style={{ width: "1.5rem" }} />
            <SortHeader label="Title" asc="title_asc" desc="title_desc" current={sort} onChange={onSortChange} />
            <th>Authors</th>
            <SortHeader label="Year" asc="year_asc" desc="year_desc" current={sort} onChange={onSortChange} />
            <th>Journal</th>
            <th>DOI</th>
            {columns.abstract && <th>Abstract</th>}
            {columns.issn && <th>ISSN</th>}
            {columns.keywords && <th>Keywords</th>}
            <th>Sources</th>
            <th>Dedup</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => {
            const isExpanded = expandedId === r.id;
            return (
              <>
                <tr
                  key={r.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => toggleExpand(r.id)}
                >
                  <td style={{ textAlign: "center", color: "#888", fontSize: "0.75rem" }}>
                    {isExpanded ? "▲" : "▶"}
                  </td>
                  <td title={r.title ?? ""}>{truncate(r.title, 80)}</td>
                  <td>{formatAuthors(r.authors)}</td>
                  <td>{r.year ?? "—"}</td>
                  <td>{truncate(r.journal, 40)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {r.doi ? (
                      <a href={`https://doi.org/${r.doi}`} target="_blank" rel="noreferrer">
                        {r.doi}
                      </a>
                    ) : "—"}
                  </td>
                  {columns.abstract && (
                    <td style={{ maxWidth: "16rem" }}>{truncate(r.abstract, 120)}</td>
                  )}
                  {columns.issn && <td>{r.issn ?? "—"}</td>}
                  {columns.keywords && (
                    <td>{r.keywords ? r.keywords.slice(0, 3).join(", ") : "—"}</td>
                  )}
                  <td>{r.sources.length > 0 ? r.sources.join(", ") : "—"}</td>
                  <td><MatchBasisBadge basis={r.match_basis} /></td>
                </tr>
                {isExpanded && (
                  <ExpandedRow key={`${r.id}-expanded`} record={r} colSpan={totalCols} />
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
