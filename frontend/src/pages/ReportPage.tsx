import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Sparkles, Download } from "lucide-react";
import { aiApi } from "../api/client";

function renderMarkdown(text: string): string {
  return text
    .replace(/^### (.+)$/gm, '<h3 style="margin:1.2em 0 0.3em;font-size:1rem;font-weight:700;color:#1e293b">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="margin:1.5em 0 0.4em;font-size:1.1rem;font-weight:700;color:#1e293b;border-bottom:1px solid #e2e8f0;padding-bottom:0.25em">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="margin:0 0 1em;font-size:1.3rem;font-weight:800;color:#0f172a">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li style="margin:0.2em 0">$1</li>')
    .replace(/(<li.*<\/li>\n?)+/g, m => `<ul style="margin:0.4em 0 0.4em 1.5em;padding:0">${m}</ul>`)
    .replace(/\n\n/g, '</p><p style="margin:0.6em 0">')
    .replace(/^(?!<[hul])/gm, '')
    .replace(/^(.+)$(?!<\/)/gm, '$1');
}

export default function ReportPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();
  const [focus, setFocus] = useState("");
  const [maxPapers, setMaxPapers] = useState(30);

  const { data: draftData } = useQuery({
    queryKey: ["synthesis-draft", projectId],
    queryFn: () => aiApi.getSynthesisDraft(projectId!).then(r => r.data),
    enabled: !!projectId,
    retry: false,
  });

  const generateMut = useMutation({
    mutationFn: () => aiApi.synthesize(projectId!, { focus: focus || undefined, max_papers: maxPapers }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["synthesis-draft", projectId] }),
  });

  const report = generateMut.data?.data.report ?? draftData?.report ?? null;
  const paperCount = generateMut.data?.data.paper_count ?? null;

  function downloadReport() {
    if (!report) return;
    const blob = new Blob([report], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `synthesis-report.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-title">
          <Link to={`/projects/${projectId}`} className="back-link">← Project</Link>
          <h1><FileText size={18} style={{ verticalAlign: "middle", marginRight: 6 }} />Evidence Synthesis</h1>
          <span className="subtitle">Generate an AI-assisted synthesis report from your extractions</span>
        </div>
      </header>

      {/* ── Config panel ─────────────────────────────────────────────────────── */}
      <div className="card" style={{ padding: "1.1rem 1.3rem", marginBottom: "1.25rem" }}>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 300px" }}>
            <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
              Focus question <span style={{ fontWeight: 400 }}>(optional — leave blank to synthesize all extractions)</span>
            </label>
            <input
              className="form-input"
              placeholder="e.g. What are the main barriers to implementation?"
              value={focus}
              onChange={e => setFocus(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ minWidth: 120 }}>
            <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
              Max papers
            </label>
            <input
              type="number"
              className="form-input"
              value={maxPapers}
              min={1}
              max={100}
              onChange={e => setMaxPapers(Number(e.target.value))}
              style={{ width: 90 }}
            />
          </div>
          <button
            className="btn-primary"
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              background: generateMut.isPending ? "#a5b4fc" : "linear-gradient(135deg,#6366f1,#8b5cf6)",
              border: "none", cursor: generateMut.isPending ? "default" : "pointer",
            }}
          >
            <Sparkles size={14} />
            {generateMut.isPending ? "Generating…" : "Generate Synthesis"}
          </button>
          {report && (
            <button
              onClick={downloadReport}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "0.45rem 0.9rem", borderRadius: "var(--radius)",
                border: "1px solid var(--border)", background: "var(--surface)",
                fontSize: "0.82rem", fontWeight: 600, color: "var(--text)", cursor: "pointer",
              }}
            >
              <Download size={13} /> Download .md
            </button>
          )}
        </div>
        {generateMut.isError && (
          <p style={{ marginTop: "0.5rem", fontSize: "0.82rem", color: "var(--danger)" }}>
            Generation failed. Please try again.
          </p>
        )}
      </div>

      {/* ── Report display ──────────────────────────────────────────────────── */}
      {generateMut.isPending && (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
          <div className="spinner" style={{ margin: "0 auto 1rem" }} />
          <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
            Reading your extractions and generating synthesis report…<br />
            This may take 20–40 seconds.
          </p>
        </div>
      )}

      {!generateMut.isPending && report && (
        <div className="card" style={{ padding: "1.5rem 1.8rem" }}>
          {paperCount !== null && (
            <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "1rem" }}>
              Synthesized from <strong>{paperCount}</strong> extracted papers.
              {draftData && !generateMut.isSuccess && " (Saved draft from previous run.)"}
            </p>
          )}
          <div
            style={{ fontSize: "0.9rem", lineHeight: 1.7, color: "var(--text)" }}
            dangerouslySetInnerHTML={{ __html: `<p style="margin:0">${renderMarkdown(report)}</p>` }}
          />
        </div>
      )}

      {!generateMut.isPending && !report && !generateMut.isError && (
        <div className="empty-state">
          <Sparkles size={32} color="var(--brand)" style={{ marginBottom: 12 }} />
          <h3>No synthesis yet</h3>
          <p>Configure your focus question and click Generate Synthesis to create a report from your extracted evidence.</p>
        </div>
      )}
    </div>
  );
}
