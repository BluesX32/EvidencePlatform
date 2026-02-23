import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { recordsApi } from "../api/client";

export default function OverlapPage() {
  const { id: projectId } = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ["overlap", projectId],
    queryFn: () => recordsApi.overlap(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  return (
    <div className="page">
      <header className="page-header">
        <Link to={`/projects/${projectId}`} className="back-link">← Project</Link>
      </header>
      <main>
        <h2>Source overlap</h2>
        <p className="muted" style={{ marginBottom: "1.5rem" }}>
          Overlap is calculated on canonical records deduplicated by DOI. Records without a DOI are
          not matched across sources and appear only in their original source totals.
        </p>

        {isLoading && <p>Loading…</p>}
        {error && <p className="error">Failed to load overlap data.</p>}

        {data && (
          <>
            <section style={{ marginBottom: "2rem" }}>
              <h3>Per-source totals</h3>
              {data.sources.length === 0 ? (
                <p className="muted">No sources found for this project.</p>
              ) : (
                <table className="import-table">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Total records</th>
                      <th>With DOI</th>
                      <th>Without DOI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sources.map((s) => (
                      <tr key={s.id}>
                        <td>{s.name}</td>
                        <td>{s.total}</td>
                        <td>{s.with_doi}</td>
                        <td>{s.total - s.with_doi}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section>
              <h3>Pairwise overlap</h3>
              {data.pairs.length === 0 ? (
                <p className="muted">
                  {data.sources.length < 2
                    ? "Import from at least two sources to see overlap."
                    : "No shared records found between any pair of sources."}
                </p>
              ) : (
                <table className="import-table">
                  <thead>
                    <tr>
                      <th>Source A</th>
                      <th>Source B</th>
                      <th>Shared records</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pairs.map((p) => (
                      <tr key={`${p.source_a_id}-${p.source_b_id}`}>
                        <td>{p.source_a_name}</td>
                        <td>{p.source_b_name}</td>
                        <td>{p.shared_records}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
