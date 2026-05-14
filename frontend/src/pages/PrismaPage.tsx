import { useRef } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { projectsApi, screeningApi } from "../api/client";

// ── Layout ──────────────────────────────────────────────────────────────────
const PHASE_W = 130;
const PHASE_X = 10;
const MAIN_X  = 155;
const MAIN_W  = 330;
const SIDE_X  = MAIN_X + MAIN_W + 36;
const SIDE_W  = 290;
const W       = SIDE_X + SIDE_W + 24;
const ROW_GAP = 40;

// Box geometry
const BOX_RX    = 10;
const MAIN_MIN_H = 88;
const SIDE_MIN_H = 88;
const LINE_H    = 15;  // reason row height
const REASON_TOP = 44; // y inside box where first reason starts

// Colors
const C = {
  id:      { fill: "#eff6ff", stroke: "#2563eb", head: "#1d4ed8", body: "#1e40af" },
  dedup:   { fill: "#f5f3ff", stroke: "#7c3aed", head: "#5b21b6", body: "#4c1d95" },
  screen:  { fill: "#ecfdf5", stroke: "#059669", head: "#065f46", body: "#047857" },
  excl:    { fill: "#fff1f2", stroke: "#e11d48", head: "#9f1239", body: "#be123c" },
  incl:    { fill: "#f0fdf4", stroke: "#16a34a", head: "#14532d", body: "#15803d" },
  arrow:   "#94a3b8",
  muted:   "#64748b",
  rule:    "#fda4af",
};

function fmtReason(code: string | null): string {
  if (!code) return "No reason recorded";
  return code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Group raw source list: collapse "Refs: …" → backward citations, "Citing: …" → forward citations
function groupSources(raw: { name: string; count: number }[]) {
  let bwCount = 0, bwN = 0, fwCount = 0, fwN = 0;
  const dbs: { name: string; count: number }[] = [];
  for (const s of raw) {
    if (s.name.startsWith("Refs:") || s.name.startsWith("Refs ")) { bwN += s.count; bwCount++; }
    else if (s.name.startsWith("Citing:") || s.name.startsWith("Citing ")) { fwN += s.count; fwCount++; }
    else dbs.push(s);
  }
  const out = [...dbs];
  if (bwN > 0) out.push({ name: `Backward citations (${bwCount} seed${bwCount > 1 ? "s" : ""})`, count: bwN });
  if (fwN > 0) out.push({ name: `Forward citations (${fwCount} seed${fwCount > 1 ? "s" : ""})`, count: fwN });
  return out;
}

function sideH(reasons: { reason_code: string | null; count: number }[]): number {
  if (reasons.length === 0) return SIDE_MIN_H;
  return Math.max(SIDE_MIN_H, REASON_TOP + reasons.length * LINE_H + 12);
}

// ── SVG primitives ──────────────────────────────────────────────────────────
const cx = MAIN_X + MAIN_W / 2;
const sxc = SIDE_X + SIDE_W / 2;

function Box({
  x, y, w, h, fill, stroke, shadow = true,
  children,
}: {
  x: number; y: number; w: number; h: number;
  fill: string; stroke: string; shadow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <g filter={shadow ? "url(#shadow)" : undefined}>
      <rect x={x} y={y} width={w} height={h} rx={BOX_RX} fill={fill} stroke={stroke} strokeWidth={1.6} />
      {children}
    </g>
  );
}

function DownArrow({ x, y1, y2 }: { x: number; y1: number; y2: number }) {
  return <line x1={x} y1={y1} x2={x} y2={y2 - 7} stroke={C.arrow} strokeWidth={1.8} markerEnd="url(#ah)" />;
}

function RightArrow({ x1, x2, y }: { x1: number; x2: number; y: number }) {
  return <line x1={x1} y1={y} x2={x2 - 7} y2={y} stroke={C.arrow} strokeWidth={1.8} markerEnd="url(#ah)" />;
}

function PhaseLabel({ label, y, h }: { label: string; y: number; h: number }) {
  const midY = y + h / 2;
  return (
    <g>
      <rect x={PHASE_X} y={y} width={PHASE_W} height={h} rx={6} fill="#f8fafc" stroke="#e2e8f0" strokeWidth={1} />
      <text x={PHASE_X + PHASE_W / 2} y={midY + 4} textAnchor="middle" fontSize={11} fontWeight="700" fill="#475569" letterSpacing="0.3">
        {label}
      </text>
    </g>
  );
}

function ReasonLines({
  reasons, boxY,
}: { reasons: { reason_code: string | null; count: number }[]; boxY: number }) {
  return (
    <>
      {reasons.length > 0 && (
        <line x1={SIDE_X + 10} y1={boxY + 40} x2={SIDE_X + SIDE_W - 10} y2={boxY + 40} stroke={C.rule} strokeWidth={0.8} />
      )}
      {reasons.map((r, i) => (
        <text key={i} x={SIDE_X + 14} y={boxY + REASON_TOP + i * LINE_H} fontSize={9.5} fill="#1e293b">
          <tspan fill={C.excl.stroke} fontWeight="700">·</tspan>
          {" "}{fmtReason(r.reason_code)}: n = {r.count.toLocaleString()}
        </text>
      ))}
    </>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function PrismaPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const svgRef = useRef<SVGSVGElement>(null);

  const { data: sources = [], isLoading: srcLoading } = useQuery({
    queryKey: ["screening-sources", projectId],
    queryFn: () => screeningApi.getSources(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });
  const { data: prisma, isLoading: prismaLoading } = useQuery({
    queryKey: ["prisma-stats", projectId],
    queryFn: () => projectsApi.getPrismaStats(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const allSource    = sources.find((s) => s.id === "all");
  const indivSources = sources.filter((s) => s.id !== "all");
  const grouped      = groupSources(prisma?.by_source ?? indivSources.map((s) => ({ name: s.name, count: s.record_count })));

  // Counts
  const totalIdentified = prisma?.total_identified ?? grouped.reduce((a, s) => a + s.count, 0);
  const duplicatesRemoved = prisma?.duplicates_removed ?? 0;
  const afterDedup   = prisma?.total_unique ?? (allSource?.record_count ?? 0);
  const taScreened   = allSource?.ta_screened ?? 0;
  const taIncluded   = allSource?.ta_included ?? 0;
  const taExcluded   = allSource?.ta_excluded ?? (taScreened - taIncluded);
  const taUncertain  = allSource?.ta_uncertain ?? 0;
  const taNotScreened = Math.max(0, afterDedup - taScreened);
  const ftScreened   = allSource?.ft_screened ?? 0;
  const ftIncluded   = allSource?.ft_included ?? 0;
  const ftExcluded   = ftScreened - ftIncluded;
  const ftAwaiting   = Math.max(0, taIncluded - ftScreened);
  const extracted    = allSource?.extracted_count ?? 0;
  const taReasons    = prisma?.ta_exclude_reasons ?? [];
  const ftReasons    = prisma?.ft_exclude_reasons ?? [];

  // Row heights
  const ID_H = Math.max(MAIN_MIN_H, 56 + grouped.length * 18);
  const DD_H = MAIN_MIN_H;
  const TA_SIDE_H = sideH(taReasons);
  const TA_H  = Math.max(MAIN_MIN_H, TA_SIDE_H);
  const FT_SIDE_H = sideH(ftReasons);
  const FT_H  = Math.max(MAIN_MIN_H, FT_SIDE_H);
  const IN_H  = MAIN_MIN_H;

  // Row Y positions
  const R = {
    id:  50,
    dd:  0, ta: 0, ft: 0, inc: 0,
  };
  R.dd  = R.id  + ID_H + ROW_GAP;
  R.ta  = R.dd  + Math.max(DD_H, SIDE_MIN_H) + ROW_GAP;
  R.ft  = R.ta  + Math.max(TA_H, TA_SIDE_H)  + ROW_GAP;
  R.inc = R.ft  + Math.max(FT_H, FT_SIDE_H)  + ROW_GAP;
  const H = R.inc + IN_H + 48;

  function downloadSVG() {
    if (!svgRef.current) return;
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "prisma-diagram.svg";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (srcLoading || prismaLoading) {
    return <div style={{ padding: "2rem", color: C.muted }}>Loading…</div>;
  }

  return (
    <div style={{ padding: "2rem" }}>
      <header className="page-header">
        <div className="page-title">
          <h1>PRISMA Flow Diagram</h1>
          <span className="subtitle">Preferred Reporting Items for Systematic Reviews and Meta-Analyses · 2020</span>
        </div>
        <button className="btn-primary" onClick={downloadSVG}>Download SVG</button>
      </header>

      <div style={{
        overflowX: "auto",
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: "0.75rem",
        boxShadow: "0 2px 8px rgba(0,0,0,.06)",
        display: "inline-block",
        padding: "8px",
      }}>
        <svg
          ref={svgRef}
          width={W} height={H}
          viewBox={`0 0 ${W} ${H}`}
          xmlns="http://www.w3.org/2000/svg"
          style={{ display: "block", fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }}
        >
          <defs>
            {/* Arrow marker */}
            <marker id="ah" markerWidth={10} markerHeight={7} refX={9} refY={3.5} orient="auto">
              <polygon points="0 0, 10 3.5, 0 7" fill={C.arrow} />
            </marker>
            {/* Drop shadow */}
            <filter id="shadow" x="-8%" y="-8%" width="116%" height="120%">
              <feDropShadow dx={0} dy={2} stdDeviation={3} floodColor="#00000018" />
            </filter>
          </defs>

          {/* ── Phase labels (left rail) ─────────────────────────────── */}
          <PhaseLabel label="Identification" y={R.id} h={ID_H} />
          <PhaseLabel label="Deduplication"  y={R.dd} h={Math.max(DD_H, SIDE_MIN_H)} />
          <PhaseLabel label="Screening"      y={R.ta} h={Math.max(TA_H, TA_SIDE_H)} />
          <PhaseLabel label="Eligibility"    y={R.ft} h={Math.max(FT_H, FT_SIDE_H)} />
          <PhaseLabel label="Included"       y={R.inc} h={IN_H} />

          {/* ══════════════════════════════════════════════════════════
              ROW 1 — Identification
          ══════════════════════════════════════════════════════════ */}
          <Box x={MAIN_X} y={R.id} w={MAIN_W} h={ID_H} fill={C.id.fill} stroke={C.id.stroke}>
            <text x={cx} y={R.id + 22} textAnchor="middle" fontSize={13} fontWeight="700" fill={C.id.head}>
              Records identified in databases
            </text>
            {grouped.map((s, i) => (
              <text key={s.name} x={cx} y={R.id + 40 + i * 18} textAnchor="middle" fontSize={11} fill={C.id.body}>
                {s.name}: n = {s.count.toLocaleString()}
              </text>
            ))}
            {grouped.length > 1 && (
              <text x={cx} y={R.id + 40 + grouped.length * 18} textAnchor="middle" fontSize={11.5} fontWeight="700" fill={C.id.head}>
                Total: n = {totalIdentified.toLocaleString()}
              </text>
            )}
          </Box>

          <DownArrow x={cx} y1={R.id + ID_H} y2={R.dd} />

          {/* ══════════════════════════════════════════════════════════
              ROW 2 — Deduplication
          ══════════════════════════════════════════════════════════ */}
          <Box x={MAIN_X} y={R.dd} w={MAIN_W} h={DD_H} fill={C.dedup.fill} stroke={C.dedup.stroke}>
            <text x={cx} y={R.dd + 28} textAnchor="middle" fontSize={12} fontWeight="700" fill={C.dedup.head}>
              Records after removing duplicates
            </text>
            <text x={cx} y={R.dd + 56} textAnchor="middle" fontSize={18} fontWeight="700" fill={C.dedup.stroke}>
              n = {afterDedup.toLocaleString()}
            </text>
          </Box>

          {/* Dedup side box */}
          <RightArrow x1={MAIN_X + MAIN_W} x2={SIDE_X} y={R.dd + DD_H / 2} />
          <Box x={SIDE_X} y={R.dd} w={SIDE_W} h={SIDE_MIN_H} fill={C.excl.fill} stroke={C.excl.stroke}>
            <text x={sxc} y={R.dd + 26} textAnchor="middle" fontSize={11.5} fontWeight="700" fill={C.excl.head}>
              Duplicates removed
            </text>
            <text x={sxc} y={R.dd + 58} textAnchor="middle" fontSize={18} fontWeight="700" fill={C.excl.stroke}>
              n = {duplicatesRemoved.toLocaleString()}
            </text>
          </Box>

          <DownArrow x={cx} y1={R.dd + DD_H} y2={R.ta} />

          {/* ══════════════════════════════════════════════════════════
              ROW 3 — Title & Abstract Screening
          ══════════════════════════════════════════════════════════ */}
          <Box x={MAIN_X} y={R.ta} w={MAIN_W} h={TA_H} fill={C.screen.fill} stroke={C.screen.stroke}>
            <text x={cx} y={R.ta + 26} textAnchor="middle" fontSize={12} fontWeight="700" fill={C.screen.head}>
              Records screened
            </text>
            <text x={cx} y={R.ta + 44} textAnchor="middle" fontSize={10} fill={C.muted}>(title &amp; abstract)</text>
            <text x={cx} y={R.ta + 66} textAnchor="middle" fontSize={18} fontWeight="700" fill={C.screen.stroke}>
              n = {taScreened.toLocaleString()}
            </text>
            {taNotScreened > 0 && (
              <text x={cx} y={R.ta + 82} textAnchor="middle" fontSize={9.5} fill={C.muted}>
                awaiting screening: n = {taNotScreened.toLocaleString()}
              </text>
            )}
            {taUncertain > 0 && (
              <text x={cx} y={R.ta + (taNotScreened > 0 ? 95 : 82)} textAnchor="middle" fontSize={9.5} fill="#92400e">
                uncertain: n = {taUncertain.toLocaleString()}
              </text>
            )}
          </Box>

          {/* TA exclusion side box */}
          <RightArrow x1={MAIN_X + MAIN_W} x2={SIDE_X} y={R.ta + TA_SIDE_H / 2} />
          <Box x={SIDE_X} y={R.ta} w={SIDE_W} h={TA_SIDE_H} fill={C.excl.fill} stroke={C.excl.stroke}>
            <text x={sxc} y={R.ta + 20} textAnchor="middle" fontSize={11.5} fontWeight="700" fill={C.excl.head}>
              Records excluded (TA)
            </text>
            <text x={sxc} y={R.ta + 38} textAnchor="middle" fontSize={14} fontWeight="700" fill={C.excl.stroke}>
              n = {taExcluded.toLocaleString()}
            </text>
            <ReasonLines reasons={taReasons} boxY={R.ta} />
          </Box>

          <DownArrow x={cx} y1={R.ta + TA_H} y2={R.ft} />

          {/* ══════════════════════════════════════════════════════════
              ROW 4 — Full-text Eligibility
          ══════════════════════════════════════════════════════════ */}
          <Box x={MAIN_X} y={R.ft} w={MAIN_W} h={FT_H} fill={C.screen.fill} stroke={C.screen.stroke}>
            <text x={cx} y={R.ft + 26} textAnchor="middle" fontSize={12} fontWeight="700" fill={C.screen.head}>
              Full-text articles assessed
            </text>
            <text x={cx} y={R.ft + 42} textAnchor="middle" fontSize={10} fill={C.muted}>(eligibility)</text>
            <text x={cx} y={R.ft + 64} textAnchor="middle" fontSize={18} fontWeight="700" fill={C.screen.stroke}>
              n = {ftScreened.toLocaleString()}
            </text>
            {ftAwaiting > 0 && (
              <text x={cx} y={R.ft + 80} textAnchor="middle" fontSize={9.5} fill={C.muted}>
                awaiting review: n = {ftAwaiting.toLocaleString()}
              </text>
            )}
          </Box>

          {/* FT exclusion side box */}
          <RightArrow x1={MAIN_X + MAIN_W} x2={SIDE_X} y={R.ft + FT_SIDE_H / 2} />
          <Box x={SIDE_X} y={R.ft} w={SIDE_W} h={FT_SIDE_H} fill={C.excl.fill} stroke={C.excl.stroke}>
            <text x={sxc} y={R.ft + 20} textAnchor="middle" fontSize={11.5} fontWeight="700" fill={C.excl.head}>
              Articles excluded (FT)
            </text>
            <text x={sxc} y={R.ft + 38} textAnchor="middle" fontSize={14} fontWeight="700" fill={C.excl.stroke}>
              n = {ftExcluded.toLocaleString()}
            </text>
            <ReasonLines reasons={ftReasons} boxY={R.ft} />
          </Box>

          <DownArrow x={cx} y1={R.ft + FT_H} y2={R.inc} />

          {/* ══════════════════════════════════════════════════════════
              ROW 5 — Included
          ══════════════════════════════════════════════════════════ */}
          <Box x={MAIN_X} y={R.inc} w={MAIN_W} h={IN_H} fill={C.incl.fill} stroke={C.incl.stroke}>
            <text x={cx} y={R.inc + 26} textAnchor="middle" fontSize={12} fontWeight="700" fill={C.incl.head}>
              Studies included in review
            </text>
            <text x={cx} y={R.inc + 54} textAnchor="middle" fontSize={22} fontWeight="800" fill={C.incl.stroke}>
              n = {ftIncluded.toLocaleString()}
            </text>
            {extracted > 0 && (
              <text x={cx} y={R.inc + 76} textAnchor="middle" fontSize={9.5} fill={C.muted}>
                data extracted: n = {extracted.toLocaleString()}
              </text>
            )}
          </Box>
        </svg>
      </div>

      <p style={{ fontSize: "0.78rem", color: "#94a3b8", marginTop: "1rem", maxWidth: 680 }}>
        Counts reflect current screening progress. "Duplicates removed" reflects within-source
        deduplication; cross-source overlaps are managed via the Overlap system.
      </p>
    </div>
  );
}
