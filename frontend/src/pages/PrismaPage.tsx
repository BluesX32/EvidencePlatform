import { useRef } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { projectsApi, screeningApi } from "../api/client";

// ── Layout ──────────────────────────────────────────────────────────────────
const PHASE_W  = 128;
const PHASE_X  = 10;
const MAIN_X   = PHASE_X + PHASE_W + 18;
const MAIN_W   = 330;
const SIDE_GAP = 38;
const SIDE_X   = MAIN_X + MAIN_W + SIDE_GAP;
const SIDE_W   = 296;
const W        = SIDE_X + SIDE_W + 20;
const ROW_GAP  = 42;
const BOX_RX   = 10;
const MAIN_MIN_H = 92;
const SIDE_MIN_H = 92;
const LINE_H     = 16;
const REASON_TOP = 48; // y-offset inside side box where first reason row starts

// Colors
const C = {
  id:     { fill: "#eff6ff", stroke: "#2563eb", head: "#1e40af", body: "#1d4ed8" },
  dedup:  { fill: "#f5f3ff", stroke: "#7c3aed", head: "#4c1d95", body: "#6d28d9" },
  screen: { fill: "#ecfdf5", stroke: "#059669", head: "#064e3b", body: "#047857" },
  excl:   { fill: "#fff1f2", stroke: "#e11d48", head: "#9f1239", body: "#be123c" },
  incl:   { fill: "#f0fdf4", stroke: "#16a34a", head: "#14532d", body: "#166534" },
  arrow:  "#94a3b8",
  muted:  "#64748b",
  phase:  "#475569",
};

function fmtReason(code: string | null): string {
  if (!code) return "No reason recorded";
  return code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function groupSources(raw: { name: string; count: number }[]) {
  let bwN = 0, bwCount = 0, fwN = 0, fwCount = 0;
  const dbs: { name: string; count: number }[] = [];
  for (const s of raw) {
    // Strip leading non-alphabetic characters (← → arrows, spaces) before checking prefix
    const core = s.name.replace(/^[^A-Za-z]+/, "");
    if (core.startsWith("Refs:") || core.startsWith("Refs "))           { bwN += s.count; bwCount++; }
    else if (core.startsWith("Citing:") || core.startsWith("Citing "))  { fwN += s.count; fwCount++; }
    else dbs.push(s);
  }
  const out = [...dbs];
  if (bwN > 0) out.push({ name: `Backward citations (${bwCount} seed${bwCount > 1 ? "s" : ""})`, count: bwN });
  if (fwN > 0) out.push({ name: `Forward citations (${fwCount} seed${fwCount > 1 ? "s" : ""})`, count: fwN });
  return out;
}

function sideH(reasons: { reason_code: string | null; count: number }[]): number {
  return Math.max(SIDE_MIN_H, REASON_TOP + reasons.length * LINE_H + 10);
}

// ── SVG primitives ──────────────────────────────────────────────────────────
const mainCx = MAIN_X + MAIN_W / 2;
const sideCx  = SIDE_X + SIDE_W / 2;

/** Renders "n =" in a small muted weight, then the big bold number. */
function BigN({
  x, y, value, color, size = 20,
}: { x: number; y: number; value: number; color: string; size?: number }) {
  return (
    <text x={x} y={y} textAnchor="middle">
      <tspan fontSize={size * 0.58} fontWeight="500" fill={color} opacity={0.55}>n = </tspan>
      <tspan fontSize={size} fontWeight="800" fill={color}>{value.toLocaleString()}</tspan>
    </text>
  );
}

/** Main flow box with optional top accent stripe. */
function Box({
  x, y, w, h, fill, stroke, accent = true, children,
}: {
  x: number; y: number; w: number; h: number;
  fill: string; stroke: string; accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <g filter="url(#shadow)">
      <rect x={x} y={y} width={w} height={h} rx={BOX_RX} fill={fill} stroke={stroke} strokeWidth={1.6} />
      {accent && (
        <rect x={x + 2} y={y + 2} width={w - 4} height={6} rx={4} fill={stroke} opacity={0.14} />
      )}
      {children}
    </g>
  );
}

function DownArrow({ x, y1, y2 }: { x: number; y1: number; y2: number }) {
  return <line x1={x} y1={y1} x2={x} y2={y2 - 8} stroke={C.arrow} strokeWidth={2} markerEnd="url(#ah)" />;
}

function RightArrow({ x1, x2, y }: { x1: number; x2: number; y: number }) {
  return <line x1={x1} y1={y} x2={x2 - 8} y2={y} stroke={C.arrow} strokeWidth={2} markerEnd="url(#ah)" />;
}

/** Reason rows: label left-aligned, count right-aligned — reads like a table. */
function ReasonRows({
  reasons, boxY,
}: { reasons: { reason_code: string | null; count: number }[]; boxY: number }) {
  if (reasons.length === 0) return null;
  return (
    <>
      {/* separator */}
      <line
        x1={SIDE_X + 10} y1={boxY + REASON_TOP - 8}
        x2={SIDE_X + SIDE_W - 10} y2={boxY + REASON_TOP - 8}
        stroke="#fca5a5" strokeWidth={0.8} strokeDasharray="3 3"
      />
      {reasons.map((r, i) => {
        const ry = boxY + REASON_TOP + i * LINE_H;
        const isEven = i % 2 === 0;
        return (
          <g key={i}>
            {isEven && (
              <rect
                x={SIDE_X + 4} y={ry - 11}
                width={SIDE_W - 8} height={LINE_H}
                rx={2} fill="#fef2f2" opacity={0.7}
              />
            )}
            {/* reason label */}
            <text x={SIDE_X + 10} y={ry} fontSize={9.5} fill="#374151">
              {fmtReason(r.reason_code)}
            </text>
            {/* count right-aligned */}
            <text x={SIDE_X + SIDE_W - 10} y={ry} textAnchor="end" fontSize={9.5} fontWeight="700" fill={C.excl.stroke}>
              {r.count.toLocaleString()}
            </text>
          </g>
        );
      })}
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
  const grouped      = groupSources(
    prisma?.by_source ?? indivSources.map((s) => ({ name: s.name, count: s.record_count })),
  );

  // Counts
  const totalIdentified  = prisma?.total_identified ?? grouped.reduce((a, s) => a + s.count, 0);
  const duplicatesRemoved = prisma?.duplicates_removed ?? 0;
  const afterDedup       = prisma?.total_unique ?? (allSource?.record_count ?? 0);
  const taScreened       = allSource?.ta_screened ?? 0;
  const taIncluded       = allSource?.ta_included ?? 0;
  const taExcluded       = allSource?.ta_excluded ?? (taScreened - taIncluded);
  const taUncertain      = allSource?.ta_uncertain ?? 0;
  const taNotScreened    = Math.max(0, afterDedup - taScreened);
  const ftScreened       = allSource?.ft_screened ?? 0;
  const ftIncluded       = allSource?.ft_included ?? 0;
  const ftExcluded       = ftScreened - ftIncluded;
  const ftAwaiting       = Math.max(0, taIncluded - ftScreened);
  const extracted        = allSource?.extracted_count ?? 0;
  const taReasons        = prisma?.ta_exclude_reasons ?? [];
  const ftReasons        = prisma?.ft_exclude_reasons ?? [];

  // Row heights — main boxes grow to match their side box when the side box is taller
  // +26 when there is a "Total" line (separator line + text + bottom padding)
  const ID_H       = Math.max(MAIN_MIN_H, 58 + grouped.length * 18 + (grouped.length > 1 ? 26 : 0));
  const DD_MAIN_H  = MAIN_MIN_H;
  const DD_SIDE_H  = SIDE_MIN_H;
  const TA_SIDE_H  = sideH(taReasons);
  const TA_MAIN_H  = Math.max(MAIN_MIN_H, TA_SIDE_H);
  const FT_SIDE_H  = sideH(ftReasons);
  const FT_MAIN_H  = Math.max(MAIN_MIN_H, FT_SIDE_H);
  const IN_H       = 96;

  // Y positions
  const R: Record<string, number> = { id: 50 };
  R.dd  = R.id + ID_H + ROW_GAP;
  R.ta  = R.dd + Math.max(DD_MAIN_H, DD_SIDE_H) + ROW_GAP;
  R.ft  = R.ta + Math.max(TA_MAIN_H, TA_SIDE_H) + ROW_GAP;
  R.inc = R.ft + Math.max(FT_MAIN_H, FT_SIDE_H) + ROW_GAP;
  const H = R.inc + IN_H + 52;

  // Phase rail spans the full diagram height
  const railTop = R.id - 6;
  const railBot = R.inc + IN_H + 6;

  // Phase label segments with dividers
  const phases = [
    { label: "Identification", y: R.id,  h: ID_H },
    { label: "Deduplication",  y: R.dd,  h: Math.max(DD_MAIN_H, DD_SIDE_H) },
    { label: "Screening",      y: R.ta,  h: Math.max(TA_MAIN_H, TA_SIDE_H) },
    { label: "Eligibility",    y: R.ft,  h: Math.max(FT_MAIN_H, FT_SIDE_H) },
    { label: "Included",       y: R.inc, h: IN_H },
  ];

  function downloadJPG() {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const scale = 2; // 2× for crisp output
    const svgW  = Number(svgEl.getAttribute("width"));
    const svgH  = Number(svgEl.getAttribute("height"));

    // Clone and add a white background rect so the JPEG has no transparency artifacts
    const clone = svgEl.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", "0"); bg.setAttribute("y", "0");
    bg.setAttribute("width", String(svgW)); bg.setAttribute("height", String(svgH));
    bg.setAttribute("fill", "white");
    clone.insertBefore(bg, clone.firstChild);

    const svgStr = new XMLSerializer().serializeToString(clone);
    const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    const canvas = document.createElement("canvas");
    canvas.width  = svgW * scale;
    canvas.height = svgH * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const img = new Image();
    img.onload = () => {
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "prisma-diagram.jpg";
        a.click();
        URL.revokeObjectURL(a.href);
      }, "image/jpeg", 0.95);
    };
    img.src = url;
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
        <button className="btn-primary" onClick={downloadJPG}>Download JPG</button>
      </header>

      <div style={{
        overflowX: "auto",
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: "0.75rem",
        boxShadow: "0 2px 12px rgba(0,0,0,.07)",
        display: "inline-block",
        padding: "10px",
      }}>
        <svg
          ref={svgRef}
          width={W} height={H}
          viewBox={`0 0 ${W} ${H}`}
          xmlns="http://www.w3.org/2000/svg"
          style={{ display: "block", fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }}
        >
          <defs>
            <marker id="ah" markerWidth={9} markerHeight={6} refX={8} refY={3} orient="auto">
              <polygon points="0 0, 9 3, 0 6" fill={C.arrow} />
            </marker>
            <filter id="shadow" x="-10%" y="-10%" width="120%" height="128%">
              <feDropShadow dx={0} dy={2} stdDeviation={3.5} floodColor="#00000016" />
            </filter>
          </defs>

          {/* ── Phase label rail (one unified sidebar) ───────────────── */}
          <rect
            x={PHASE_X} y={railTop}
            width={PHASE_W} height={railBot - railTop}
            rx={8} fill="#f8fafc" stroke="#e2e8f0" strokeWidth={1}
          />
          {phases.map(({ label, y, h }, i) => {
            const midY = y + h / 2;
            return (
              <g key={label}>
                {/* divider between phases */}
                {i > 0 && (
                  <line
                    x1={PHASE_X + 10} y1={y}
                    x2={PHASE_X + PHASE_W - 10} y2={y}
                    stroke="#e2e8f0" strokeWidth={0.8}
                  />
                )}
                <text
                  x={PHASE_X + PHASE_W / 2} y={midY + 4}
                  textAnchor="middle" fontSize={10.5} fontWeight="700"
                  fill={C.phase} letterSpacing="0.2"
                >
                  {label}
                </text>
              </g>
            );
          })}

          {/* ══ ROW 1 — Identification ══════════════════════════════ */}
          <Box x={MAIN_X} y={R.id} w={MAIN_W} h={ID_H} fill={C.id.fill} stroke={C.id.stroke}>
            <text x={mainCx} y={R.id + 24} textAnchor="middle" fontSize={12.5} fontWeight="700" fill={C.id.head}>
              Records identified in databases
            </text>
            {grouped.map((s, i) => (
              <text key={s.name} x={mainCx} y={R.id + 42 + i * 18} textAnchor="middle" fontSize={11} fill={C.id.body}>
                {s.name}
                <tspan fontWeight="700">  n = {s.count.toLocaleString()}</tspan>
              </text>
            ))}
            {grouped.length > 1 && (
              <>
                <line
                  x1={MAIN_X + 20} y1={R.id + 42 + grouped.length * 18 - 10}
                  x2={MAIN_X + MAIN_W - 20} y2={R.id + 42 + grouped.length * 18 - 10}
                  stroke={C.id.stroke} strokeWidth={0.6} opacity={0.4}
                />
                <text x={mainCx} y={R.id + 42 + grouped.length * 18 + 5} textAnchor="middle" fontSize={11.5} fontWeight="800" fill={C.id.head}>
                  Total  n = {totalIdentified.toLocaleString()}
                </text>
              </>
            )}
          </Box>

          <DownArrow x={mainCx} y1={R.id + ID_H} y2={R.dd} />

          {/* ══ ROW 2 — Deduplication ═══════════════════════════════ */}
          <Box x={MAIN_X} y={R.dd} w={MAIN_W} h={DD_MAIN_H} fill={C.dedup.fill} stroke={C.dedup.stroke}>
            <text x={mainCx} y={R.dd + 28} textAnchor="middle" fontSize={12} fontWeight="700" fill={C.dedup.head}>
              Records after removing duplicates
            </text>
            <BigN x={mainCx} y={R.dd + 66} value={afterDedup} color={C.dedup.stroke} size={22} />
          </Box>

          <RightArrow x1={MAIN_X + MAIN_W} x2={SIDE_X} y={R.dd + DD_MAIN_H / 2} />
          <Box x={SIDE_X} y={R.dd} w={SIDE_W} h={DD_SIDE_H} fill={C.excl.fill} stroke={C.excl.stroke}>
            <text x={sideCx} y={R.dd + 28} textAnchor="middle" fontSize={12} fontWeight="700" fill={C.excl.head}>
              Duplicates removed
            </text>
            <BigN x={sideCx} y={R.dd + 66} value={duplicatesRemoved} color={C.excl.stroke} size={22} />
          </Box>

          <DownArrow x={mainCx} y1={R.dd + DD_MAIN_H} y2={R.ta} />

          {/* ══ ROW 3 — Title & Abstract Screening ══════════════════ */}
          <Box x={MAIN_X} y={R.ta} w={MAIN_W} h={TA_MAIN_H} fill={C.screen.fill} stroke={C.screen.stroke}>
            <text x={mainCx} y={R.ta + 28} textAnchor="middle" fontSize={12} fontWeight="700" fill={C.screen.head}>
              Records screened
            </text>
            <text x={mainCx} y={R.ta + 44} textAnchor="middle" fontSize={10} fill={C.muted}>
              (title &amp; abstract)
            </text>
            <BigN x={mainCx} y={R.ta + 70} value={taScreened} color={C.screen.stroke} size={22} />
            {taNotScreened > 0 && (
              <text x={mainCx} y={R.ta + 88} textAnchor="middle" fontSize={9.5} fill={C.muted}>
                awaiting screening: n = {taNotScreened.toLocaleString()}
              </text>
            )}
            {taUncertain > 0 && (
              <text x={mainCx} y={R.ta + (taNotScreened > 0 ? 102 : 88)} textAnchor="middle" fontSize={9.5} fill="#92400e">
                uncertain: n = {taUncertain.toLocaleString()}
              </text>
            )}
          </Box>

          <RightArrow x1={MAIN_X + MAIN_W} x2={SIDE_X} y={R.ta + TA_SIDE_H / 2} />
          <Box x={SIDE_X} y={R.ta} w={SIDE_W} h={TA_SIDE_H} fill={C.excl.fill} stroke={C.excl.stroke}>
            <text x={sideCx} y={R.ta + 22} textAnchor="middle" fontSize={12} fontWeight="700" fill={C.excl.head}>
              Records excluded (TA)
            </text>
            <BigN x={sideCx} y={R.ta + 42} value={taExcluded} color={C.excl.stroke} size={14} />
            <ReasonRows reasons={taReasons} boxY={R.ta} />
          </Box>

          <DownArrow x={mainCx} y1={R.ta + TA_MAIN_H} y2={R.ft} />

          {/* ══ ROW 4 — Full-text Eligibility ═══════════════════════ */}
          <Box x={MAIN_X} y={R.ft} w={MAIN_W} h={FT_MAIN_H} fill={C.screen.fill} stroke={C.screen.stroke}>
            <text x={mainCx} y={R.ft + 28} textAnchor="middle" fontSize={12} fontWeight="700" fill={C.screen.head}>
              Full-text articles assessed
            </text>
            <text x={mainCx} y={R.ft + 44} textAnchor="middle" fontSize={10} fill={C.muted}>
              (eligibility)
            </text>
            <BigN x={mainCx} y={R.ft + 70} value={ftScreened} color={C.screen.stroke} size={22} />
            {ftAwaiting > 0 && (
              <text x={mainCx} y={R.ft + 88} textAnchor="middle" fontSize={9.5} fill={C.muted}>
                awaiting review: n = {ftAwaiting.toLocaleString()}
              </text>
            )}
          </Box>

          <RightArrow x1={MAIN_X + MAIN_W} x2={SIDE_X} y={R.ft + FT_SIDE_H / 2} />
          <Box x={SIDE_X} y={R.ft} w={SIDE_W} h={FT_SIDE_H} fill={C.excl.fill} stroke={C.excl.stroke}>
            <text x={sideCx} y={R.ft + 22} textAnchor="middle" fontSize={12} fontWeight="700" fill={C.excl.head}>
              Articles excluded (FT)
            </text>
            <BigN x={sideCx} y={R.ft + 42} value={ftExcluded} color={C.excl.stroke} size={14} />
            <ReasonRows reasons={ftReasons} boxY={R.ft} />
          </Box>

          <DownArrow x={mainCx} y1={R.ft + FT_MAIN_H} y2={R.inc} />

          {/* ══ ROW 5 — Included ════════════════════════════════════ */}
          <Box x={MAIN_X} y={R.inc} w={MAIN_W} h={IN_H} fill={C.incl.fill} stroke={C.incl.stroke}>
            <text x={mainCx} y={R.inc + 26} textAnchor="middle" fontSize={12.5} fontWeight="700" fill={C.incl.head}>
              Studies included in review
            </text>
            <BigN x={mainCx} y={R.inc + 64} value={ftIncluded} color={C.incl.stroke} size={26} />
            {extracted > 0 && (
              <text x={mainCx} y={R.inc + 84} textAnchor="middle" fontSize={9.5} fill={C.muted}>
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
