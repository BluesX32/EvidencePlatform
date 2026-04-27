import { useRef } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { screeningApi } from "../api/client";

export default function PrismaPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const svgRef = useRef<SVGSVGElement>(null);

  const { data: sources = [], isLoading } = useQuery({
    queryKey: ["screening-sources", projectId],
    queryFn: () => screeningApi.getSources(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const allSource = sources.find((s) => s.id === "all");
  const indivSources = sources.filter((s) => s.id !== "all");

  const totalIdentified =
    indivSources.length > 0
      ? indivSources.reduce((sum, s) => sum + s.record_count, 0)
      : allSource?.record_count ?? 0;
  const taScreened = allSource?.ta_screened ?? 0;
  const taIncluded = allSource?.ta_included ?? 0;
  const taExcluded = taScreened - taIncluded;
  const ftScreened = allSource?.ft_screened ?? 0;
  const ftIncluded = allSource?.ft_included ?? 0;
  const ftExcluded = ftScreened - ftIncluded;
  const extracted = allSource?.extracted_count ?? 0;

  // ── SVG layout ──────────────────────────────────────────────────────────
  const W = 700;
  const MAIN_X = 130;
  const MAIN_W = 315;
  const SIDE_X = 490;
  const SIDE_W = 188;
  const ROW_H = 90;
  const GAP = 48;
  const PHASE_W = 108;

  // Identification box height grows with number of sources
  const ID_LINES = Math.max(1, indivSources.length);
  const ID_BOX_H = 50 + ID_LINES * 18 + (indivSources.length > 1 ? 20 : 0);

  const row1Y = 50;
  const row2Y = row1Y + ID_BOX_H + GAP;
  const row3Y = row2Y + ROW_H + GAP;
  const row4Y = row3Y + ROW_H + GAP;
  const H = row4Y + ROW_H + 40;

  const idFill = "#eff6ff";
  const idStroke = "#3b82f6";
  const screenFill = "#f0fdf4";
  const screenStroke = "#15803d";
  const exclFill = "#fef2f2";
  const exclStroke = "#dc2626";
  const arrowColor = "#9ca3af";
  const darkText = "#1e293b";
  const mutedText = "#6b7280";

  function downloadSVG() {
    if (!svgRef.current) return;
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], {
      type: "image/svg+xml",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `prisma-diagram.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (isLoading) {
    return <div style={{ padding: "2rem", color: mutedText }}>Loading…</div>;
  }

  const phaseLabelY = [
    { label: "Identification", y: row1Y + ID_BOX_H / 2 },
    { label: "Screening", y: row2Y + ROW_H / 2 },
    { label: "Eligibility", y: row3Y + ROW_H / 2 },
    { label: "Included", y: row4Y + ROW_H / 2 },
  ];

  return (
    <div style={{ padding: "2rem" }}>
      {/* Header */}
      <header className="page-header">
        <div className="page-title">
          <h1>PRISMA Flow Diagram</h1>
          <span className="subtitle">Preferred Reporting Items for Systematic Reviews and Meta-Analyses · 2020</span>
        </div>
        <button className="btn-primary" onClick={downloadSVG}>Download SVG</button>
      </header>

      {/* Diagram */}
      <div
        style={{
          overflowX: "auto",
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: "0.5rem",
          display: "inline-block",
        }}
      >
        <svg
          ref={svgRef}
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          xmlns="http://www.w3.org/2000/svg"
          style={{
            display: "block",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          <defs>
            <marker
              id="ah"
              markerWidth={8}
              markerHeight={6}
              refX={7}
              refY={3}
              orient="auto"
            >
              <polygon points="0 0, 8 3, 0 6" fill={arrowColor} />
            </marker>
          </defs>

          {/* ── Phase labels ─────────────────────────────────────────── */}
          {phaseLabelY.map(({ label, y }) => (
            <g key={label}>
              <rect
                x={8}
                y={y - 14}
                width={PHASE_W}
                height={28}
                rx={4}
                fill="#f8fafc"
                stroke="#e2e8f0"
                strokeWidth={1}
              />
              <text
                x={8 + PHASE_W / 2}
                y={y + 5}
                textAnchor="middle"
                fontSize={11}
                fontWeight="bold"
                fill="#475569"
              >
                {label}
              </text>
            </g>
          ))}

          {/* ── Row 1: Identification ─────────────────────────────────── */}
          <rect
            x={MAIN_X}
            y={row1Y}
            width={MAIN_W}
            height={ID_BOX_H}
            rx={6}
            fill={idFill}
            stroke={idStroke}
            strokeWidth={1.5}
          />
          <text
            x={MAIN_X + MAIN_W / 2}
            y={row1Y + 20}
            textAnchor="middle"
            fontSize={12}
            fontWeight="bold"
            fill="#1e40af"
          >
            Records identified in databases
          </text>
          {indivSources.map((s, i) => (
            <text
              key={s.id}
              x={MAIN_X + MAIN_W / 2}
              y={row1Y + 38 + i * 18}
              textAnchor="middle"
              fontSize={11}
              fill={darkText}
            >
              {s.name}: n = {s.record_count.toLocaleString()}
            </text>
          ))}
          {indivSources.length === 0 && (
            <text
              x={MAIN_X + MAIN_W / 2}
              y={row1Y + 38}
              textAnchor="middle"
              fontSize={12}
              fontWeight="bold"
              fill="#1e40af"
            >
              n = {totalIdentified.toLocaleString()}
            </text>
          )}
          {indivSources.length > 1 && (
            <text
              x={MAIN_X + MAIN_W / 2}
              y={row1Y + 38 + indivSources.length * 18}
              textAnchor="middle"
              fontSize={11}
              fontWeight="bold"
              fill={darkText}
            >
              Total: n = {totalIdentified.toLocaleString()}
            </text>
          )}

          {/* Down arrow: identification → screening */}
          <line
            x1={MAIN_X + MAIN_W / 2}
            y1={row1Y + ID_BOX_H}
            x2={MAIN_X + MAIN_W / 2}
            y2={row2Y - 6}
            stroke={arrowColor}
            strokeWidth={1.5}
            markerEnd="url(#ah)"
          />

          {/* ── Row 2: Screening ──────────────────────────────────────── */}
          <rect
            x={MAIN_X}
            y={row2Y}
            width={MAIN_W}
            height={ROW_H}
            rx={6}
            fill={screenFill}
            stroke={screenStroke}
            strokeWidth={1.5}
          />
          <text
            x={MAIN_X + MAIN_W / 2}
            y={row2Y + 24}
            textAnchor="middle"
            fontSize={12}
            fontWeight="bold"
            fill="#14532d"
          >
            Records screened
          </text>
          <text
            x={MAIN_X + MAIN_W / 2}
            y={row2Y + 46}
            textAnchor="middle"
            fontSize={14}
            fontWeight="bold"
            fill={screenStroke}
          >
            n = {taScreened.toLocaleString()}
          </text>
          <text
            x={MAIN_X + MAIN_W / 2}
            y={row2Y + 65}
            textAnchor="middle"
            fontSize={10}
            fill={mutedText}
          >
            (title &amp; abstract)
          </text>

          {/* Right arrow → excluded at TA */}
          <line
            x1={MAIN_X + MAIN_W}
            y1={row2Y + ROW_H / 2}
            x2={SIDE_X - 6}
            y2={row2Y + ROW_H / 2}
            stroke={arrowColor}
            strokeWidth={1.5}
            markerEnd="url(#ah)"
          />
          <rect
            x={SIDE_X}
            y={row2Y + 8}
            width={SIDE_W}
            height={ROW_H - 16}
            rx={6}
            fill={exclFill}
            stroke={exclStroke}
            strokeWidth={1.5}
          />
          <text
            x={SIDE_X + SIDE_W / 2}
            y={row2Y + 28}
            textAnchor="middle"
            fontSize={11}
            fontWeight="bold"
            fill="#7f1d1d"
          >
            Records excluded
          </text>
          <text
            x={SIDE_X + SIDE_W / 2}
            y={row2Y + 51}
            textAnchor="middle"
            fontSize={14}
            fontWeight="bold"
            fill={exclStroke}
          >
            n = {taExcluded.toLocaleString()}
          </text>

          {/* Down arrow: screening → eligibility */}
          <line
            x1={MAIN_X + MAIN_W / 2}
            y1={row2Y + ROW_H}
            x2={MAIN_X + MAIN_W / 2}
            y2={row3Y - 6}
            stroke={arrowColor}
            strokeWidth={1.5}
            markerEnd="url(#ah)"
          />

          {/* ── Row 3: Eligibility ────────────────────────────────────── */}
          <rect
            x={MAIN_X}
            y={row3Y}
            width={MAIN_W}
            height={ROW_H}
            rx={6}
            fill={screenFill}
            stroke={screenStroke}
            strokeWidth={1.5}
          />
          <text
            x={MAIN_X + MAIN_W / 2}
            y={row3Y + 24}
            textAnchor="middle"
            fontSize={12}
            fontWeight="bold"
            fill="#14532d"
          >
            Full-text articles assessed
          </text>
          <text
            x={MAIN_X + MAIN_W / 2}
            y={row3Y + 46}
            textAnchor="middle"
            fontSize={14}
            fontWeight="bold"
            fill={screenStroke}
          >
            n = {ftScreened.toLocaleString()}
          </text>
          <text
            x={MAIN_X + MAIN_W / 2}
            y={row3Y + 65}
            textAnchor="middle"
            fontSize={10}
            fill={mutedText}
          >
            (eligibility)
          </text>

          {/* Right arrow → excluded at FT */}
          <line
            x1={MAIN_X + MAIN_W}
            y1={row3Y + ROW_H / 2}
            x2={SIDE_X - 6}
            y2={row3Y + ROW_H / 2}
            stroke={arrowColor}
            strokeWidth={1.5}
            markerEnd="url(#ah)"
          />
          <rect
            x={SIDE_X}
            y={row3Y + 8}
            width={SIDE_W}
            height={ROW_H - 16}
            rx={6}
            fill={exclFill}
            stroke={exclStroke}
            strokeWidth={1.5}
          />
          <text
            x={SIDE_X + SIDE_W / 2}
            y={row3Y + 28}
            textAnchor="middle"
            fontSize={11}
            fontWeight="bold"
            fill="#7f1d1d"
          >
            Articles excluded
          </text>
          <text
            x={SIDE_X + SIDE_W / 2}
            y={row3Y + 51}
            textAnchor="middle"
            fontSize={14}
            fontWeight="bold"
            fill={exclStroke}
          >
            n = {ftExcluded.toLocaleString()}
          </text>

          {/* Down arrow: eligibility → included */}
          <line
            x1={MAIN_X + MAIN_W / 2}
            y1={row3Y + ROW_H}
            x2={MAIN_X + MAIN_W / 2}
            y2={row4Y - 6}
            stroke={arrowColor}
            strokeWidth={1.5}
            markerEnd="url(#ah)"
          />

          {/* ── Row 4: Included ───────────────────────────────────────── */}
          <rect
            x={MAIN_X}
            y={row4Y}
            width={MAIN_W}
            height={ROW_H}
            rx={6}
            fill="#dcfce7"
            stroke="#16a34a"
            strokeWidth={2}
          />
          <text
            x={MAIN_X + MAIN_W / 2}
            y={row4Y + 24}
            textAnchor="middle"
            fontSize={12}
            fontWeight="bold"
            fill="#14532d"
          >
            Studies included in review
          </text>
          <text
            x={MAIN_X + MAIN_W / 2}
            y={row4Y + 48}
            textAnchor="middle"
            fontSize={16}
            fontWeight="bold"
            fill="#16a34a"
          >
            n = {ftIncluded.toLocaleString()}
          </text>
          {extracted > 0 && (
            <text
              x={MAIN_X + MAIN_W / 2}
              y={row4Y + 70}
              textAnchor="middle"
              fontSize={10}
              fill={mutedText}
            >
              Data extracted: n = {extracted.toLocaleString()}
            </text>
          )}
        </svg>
      </div>

      <p style={{ fontSize: "0.78rem", color: "#9ca3af", marginTop: "1rem", maxWidth: 680 }}>
        Counts reflect current screening progress and update automatically. Cross-source
        duplicate detection is managed via the Overlap system.
      </p>
    </div>
  );
}
