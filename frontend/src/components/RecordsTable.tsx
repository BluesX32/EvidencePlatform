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

interface Props {
  records: RecordItem[];
  sort: string;
  onSortChange: (sort: string) => void;
  isLoading: boolean;
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
    <th
      onClick={() => onChange(next)}
      style={{ cursor: "pointer", userSelect: "none" }}
    >
      {label}{arrow}
    </th>
  );
}

export default function RecordsTable({ records, sort, onSortChange, isLoading }: Props) {
  if (isLoading && records.length === 0) {
    return <p>Loading records…</p>;
  }

  if (!isLoading && records.length === 0) {
    return <p className="muted">No records match your search.</p>;
  }

  return (
    <div className="table-wrapper">
      <table className="records-table">
        <thead>
          <tr>
            <SortHeader label="Title" asc="title_asc" desc="title_desc" current={sort} onChange={onSortChange} />
            <th>Authors</th>
            <SortHeader label="Year" asc="year_asc" desc="year_desc" current={sort} onChange={onSortChange} />
            <th>Journal</th>
            <th>DOI</th>
            <th>Sources</th>
            <th>Dedup</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id}>
              <td title={r.title ?? ""}>{truncate(r.title, 80)}</td>
              <td>{formatAuthors(r.authors)}</td>
              <td>{r.year ?? "—"}</td>
              <td>{truncate(r.journal, 40)}</td>
              <td>
                {r.doi ? (
                  <a href={`https://doi.org/${r.doi}`} target="_blank" rel="noreferrer">
                    {r.doi}
                  </a>
                ) : "—"}
              </td>
              <td>{r.sources.length > 0 ? r.sources.join(", ") : "—"}</td>
              <td><MatchBasisBadge basis={r.match_basis} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
