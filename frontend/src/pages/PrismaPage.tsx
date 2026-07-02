import { useRef, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckSquare, ArrowRight } from "lucide-react";
import { projectsApi, screeningApi } from "../api/client";

// ── Color palette ─────────────────────────────────────────────────────────────
const C = {
  id:     { bg: "#eff6ff", border: "#2563eb", title: "#1e40af", body: "#1d4ed8" },
  dedup:  { bg: "#f5f3ff", border: "#7c3aed", title: "#4c1d95", body: "#6d28d9" },
  screen: { bg: "#ecfdf5", border: "#059669", title: "#064e3b", body: "#047857" },
  excl:   { bg: "#fff1f2", border: "#e11d48", title: "#9f1239", body: "#be123c" },
  incl:   { bg: "#f0fdf4", border: "#16a34a", title: "#14532d", body: "#166534" },
  arrow:  "#94a3b8",
  phase:  "#475569",
  phBg:   "#f8fafc",
  phBd:   "#e2e8f0",
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtReason(code: string | null): string {
  if (!code) return "No reason recorded";
  return code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function groupSources(raw: { name: string; count: number }[]) {
  let bwN = 0, bwCount = 0, fwN = 0, fwCount = 0;
  const dbs: { name: string; count: number }[] = [];
  for (const s of raw) {
    const core = s.name.replace(/^[^A-Za-z]+/, "");
    if (core.startsWith("Refs:") || core.startsWith("Refs "))          { bwN += s.count; bwCount++; }
    else if (core.startsWith("Citing:") || core.startsWith("Citing ")) { fwN += s.count; fwCount++; }
    else dbs.push(s);
  }
  const out = [...dbs];
  if (bwN > 0) out.push({ name: `Backward citations (${bwCount} seed${bwCount > 1 ? "s" : ""})`, count: bwN });
  if (fwN > 0) out.push({ name: `Forward citations (${fwCount} seed${fwCount > 1 ? "s" : ""})`, count: fwN });
  return out;
}

// ── Inline-editable number ────────────────────────────────────────────────────
function EN({
  value, color, size = 22, onSave,
}: { value: number; color: string; size?: number; onSave: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const commit = () => {
    const n = parseInt(draft.replace(/,/g, ""), 10);
    if (!isNaN(n) && n >= 0) onSave(n);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        autoFocus
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        style={{
          width: 90, border: "none", borderBottom: `2px solid ${color}`,
          background: "transparent", textAlign: "center",
          fontSize: size, fontWeight: 800, color, outline: "none",
        }}
      />
    );
  }

  return (
    <span
      title="Click to edit"
      onClick={() => { setDraft(String(value)); setEditing(true); }}
      style={{
        fontSize: size, fontWeight: 800, color, cursor: "text",
        borderBottom: `1.5px dashed ${color}44`, paddingBottom: 1,
      }}
    >
      {value.toLocaleString()}
    </span>
  );
}

function NLine({
  label = "n = ", value, color, size = 22, onSave,
}: { label?: string; value: number; color: string; size?: number; onSave: (v: number) => void }) {
  return (
    <div style={{ textAlign: "center", marginTop: 10 }}>
      <span style={{ fontSize: size * 0.55, color, opacity: 0.55 }}>{label}</span>
      <EN value={value} color={color} size={size} onSave={onSave} />
    </div>
  );
}

// ── Structural primitives ─────────────────────────────────────────────────────
function PhaseBadge({ label }: { label: string }) {
  return (
    <div style={{
      width: 110, minWidth: 110, display: "flex", alignItems: "center", justifyContent: "center",
      background: C.phBg, border: `1px solid ${C.phBd}`, borderRadius: 8,
      fontSize: 10.5, fontWeight: 700, color: C.phase, letterSpacing: "0.06em",
      textTransform: "uppercase", writingMode: "horizontal-tb", padding: "6px 8px",
      textAlign: "center", lineHeight: 1.3,
    }}>
      {label}
    </div>
  );
}

function VArrow() {
  return (
    <div style={{ display: "flex", gap: 0 }}>
      <div style={{ width: 110, minWidth: 110 }} />
      <div style={{ width: 48 }} />
      <div style={{ width: 320, display: "flex", justifyContent: "center" }}>
        <svg width="20" height="36" viewBox="0 0 20 36">
          <line x1="10" y1="0" x2="10" y2="28" stroke={C.arrow} strokeWidth="2" />
          <polygon points="4,26 16,26 10,36" fill={C.arrow} />
        </svg>
      </div>
    </div>
  );
}

function HArrow({ yOffset = 0 }: { yOffset?: number }) {
  return (
    <div style={{
      width: 48, minWidth: 48, display: "flex", alignItems: "center",
      paddingTop: yOffset,
    }}>
      <svg width="48" height="20" viewBox="0 0 48 20">
        <line x1="0" y1="10" x2="38" y2="10" stroke={C.arrow} strokeWidth="2" />
        <polygon points="36,5 48,10 36,15" fill={C.arrow} />
      </svg>
    </div>
  );
}

function FlowBox({
  color, children, minH = 90,
}: { color: typeof C.id; children: React.ReactNode; minH?: number }) {
  return (
    <div style={{
      width: 320, minWidth: 320, minHeight: minH,
      background: color.bg,
      border: `1.6px solid ${color.border}`,
      borderRadius: 10,
      boxShadow: "0 2px 10px rgba(0,0,0,0.07)",
      padding: "16px 20px",
      position: "relative",
      display: "flex", flexDirection: "column", justifyContent: "center",
    }}>
      <div style={{
        position: "absolute", top: 2, left: 2, right: 2, height: 6,
        background: color.border, borderRadius: "8px 8px 0 0", opacity: 0.13,
      }} />
      {children}
    </div>
  );
}

function SideBox({ color, children }: { color: typeof C.excl; children: React.ReactNode }) {
  return (
    <div style={{
      minWidth: 260, maxWidth: 320, flex: "1 1 280px",
      background: color.bg,
      border: `1.6px solid ${color.border}`,
      borderRadius: 10,
      boxShadow: "0 2px 10px rgba(0,0,0,0.07)",
      padding: "14px 16px 10px",
      position: "relative",
    }}>
      <div style={{
        position: "absolute", top: 2, left: 2, right: 2, height: 6,
        background: color.border, borderRadius: "8px 8px 0 0", opacity: 0.13,
      }} />
      {children}
    </div>
  );
}

// Editable reason row
function ReasonRow({
  code, count, color, onSaveCount,
}: { code: string | null; count: number; color: string; onSaveCount: (v: number) => void }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "3px 0", gap: 8,
    }}>
      <span style={{ fontSize: 10.5, color: "#374151", lineHeight: 1.3 }}>
        {fmtReason(code)}
      </span>
      <span style={{ fontSize: 10.5, fontWeight: 700, color, whiteSpace: "nowrap", flexShrink: 0 }}>
        <EN value={count} color={color} size={10.5} onSave={onSaveCount} />
      </span>
    </div>
  );
}

// ── SVG export helpers (separate from display) ────────────────────────────────
const SVG_PHASE_W = 128, SVG_PHASE_X = 10, SVG_MAIN_X = 166, SVG_MAIN_W = 330;
const SVG_SIDE_GAP = 38, SVG_SIDE_X = SVG_MAIN_X + SVG_MAIN_W + SVG_SIDE_GAP, SVG_SIDE_W = 296;
const SVG_W = SVG_SIDE_X + SVG_SIDE_W + 20;
const SVG_ROW_GAP = 42, SVG_MAIN_MIN_H = 92, SVG_SIDE_MIN_H = 92, SVG_LINE_H = 16, SVG_REASON_TOP = 48;
const SVG_BOX_RX = 10;
const SVG_ARROW_COLOR = "#94a3b8";
const mainCx = SVG_MAIN_X + SVG_MAIN_W / 2;
const sideCx  = SVG_SIDE_X + SVG_SIDE_W / 2;

function svgSideH(reasons: { reason_code: string | null; count: number }[]) {
  return Math.max(SVG_SIDE_MIN_H, SVG_REASON_TOP + reasons.length * SVG_LINE_H + 10);
}

function buildExportSVG(data: {
  grouped: { name: string; count: number }[];
  totalIdentified: number; duplicatesRemoved: number; afterDedup: number;
  taScreened: number; taExcluded: number; taNotScreened: number; taUncertain: number;
  ftScreened: number; ftIncluded: number; ftExcluded: number; ftAwaiting: number;
  extracted: number;
  taReasons: { reason_code: string | null; count: number }[];
  ftReasons: { reason_code: string | null; count: number }[];
}): string {
  const { grouped, totalIdentified, duplicatesRemoved, afterDedup,
    taScreened, taExcluded, taNotScreened,
    ftScreened, ftIncluded, ftExcluded, ftAwaiting, extracted,
    taReasons, ftReasons } = data;

  const ID_H = Math.max(SVG_MAIN_MIN_H, 58 + grouped.length * 18 + (grouped.length > 1 ? 26 : 0));
  const TA_SIDE_H = svgSideH(taReasons), FT_SIDE_H = svgSideH(ftReasons);
  const TA_MAIN_H = Math.max(SVG_MAIN_MIN_H, TA_SIDE_H), FT_MAIN_H = Math.max(SVG_MAIN_MIN_H, FT_SIDE_H);
  const IN_H = 96;

  const R: Record<string, number> = { id: 50 };
  R.dd  = R.id + ID_H + SVG_ROW_GAP;
  R.ta  = R.dd + Math.max(SVG_MAIN_MIN_H, SVG_SIDE_MIN_H) + SVG_ROW_GAP;
  R.ft  = R.ta + Math.max(TA_MAIN_H, TA_SIDE_H) + SVG_ROW_GAP;
  R.inc = R.ft + Math.max(FT_MAIN_H, FT_SIDE_H) + SVG_ROW_GAP;
  const H = R.inc + IN_H + 52;

  const phases = [
    { label: "Identification", y: R.id,  h: ID_H },
    { label: "Deduplication",  y: R.dd,  h: Math.max(SVG_MAIN_MIN_H, SVG_SIDE_MIN_H) },
    { label: "Screening",      y: R.ta,  h: Math.max(TA_MAIN_H, TA_SIDE_H) },
    { label: "Eligibility",    y: R.ft,  h: Math.max(FT_MAIN_H, FT_SIDE_H) },
    { label: "Included",       y: R.inc, h: IN_H },
  ];

  const railTop = R.id - 6, railBot = R.inc + IN_H + 6;

  const box = (x: number, y: number, w: number, h: number, fill: string, stroke: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${SVG_BOX_RX}" fill="${fill}" stroke="${stroke}" stroke-width="1.6" filter="url(#sh)"/>
     <rect x="${x+2}" y="${y+2}" width="${w-4}" height="6" rx="4" fill="${stroke}" opacity="0.14"/>`;

  const bigN = (x: number, y: number, v: number, color: string, sz = 20) =>
    `<text x="${x}" y="${y}" text-anchor="middle">
       <tspan font-size="${sz*0.58}" font-weight="500" fill="${color}" opacity="0.55">n = </tspan>
       <tspan font-size="${sz}" font-weight="800" fill="${color}">${v.toLocaleString()}</tspan>
     </text>`;

  const t = (x: number, y: number, anchor: string, sz: number, fw: string, fill: string, txt: string) =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${sz}" font-weight="${fw}" fill="${fill}">${txt}</text>`;

  const downarrow = (x: number, y1: number, y2: number) =>
    `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2-8}" stroke="${SVG_ARROW_COLOR}" stroke-width="2" marker-end="url(#ah)"/>`;

  const rightarrow = (x1: number, x2: number, y: number) =>
    `<line x1="${x1}" y1="${y}" x2="${x2-8}" y2="${y}" stroke="${SVG_ARROW_COLOR}" stroke-width="2" marker-end="url(#ah)"/>`;

  const reasonRows = (reasons: { reason_code: string | null; count: number }[], boxY: number) => {
    if (!reasons.length) return "";
    let out = `<line x1="${SVG_SIDE_X+10}" y1="${boxY+SVG_REASON_TOP-8}" x2="${SVG_SIDE_X+SVG_SIDE_W-10}" y2="${boxY+SVG_REASON_TOP-8}" stroke="#fca5a5" stroke-width="0.8" stroke-dasharray="3 3"/>`;
    reasons.forEach((r, i) => {
      const ry = boxY + SVG_REASON_TOP + i * SVG_LINE_H;
      if (i % 2 === 0) out += `<rect x="${SVG_SIDE_X+4}" y="${ry-11}" width="${SVG_SIDE_W-8}" height="${SVG_LINE_H}" rx="2" fill="#fef2f2" opacity="0.7"/>`;
      out += t(SVG_SIDE_X+10, ry, "start", 9.5, "400", "#374151", fmtReason(r.reason_code));
      out += t(SVG_SIDE_X+SVG_SIDE_W-10, ry, "end", 9.5, "700", "#be123c", r.count.toLocaleString());
    });
    return out;
  };

  return `<svg width="${SVG_W}" height="${H}" viewBox="0 0 ${SVG_W} ${H}"
    xmlns="http://www.w3.org/2000/svg"
    style="font-family:'Inter',system-ui,sans-serif;background:white">
  <defs>
    <marker id="ah" markerWidth="9" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0 0, 9 3, 0 6" fill="${SVG_ARROW_COLOR}"/>
    </marker>
    <filter id="sh" x="-10%" y="-10%" width="120%" height="128%">
      <feDropShadow dx="0" dy="2" stdDeviation="3.5" flood-color="#00000016"/>
    </filter>
  </defs>

  <rect x="${SVG_PHASE_X}" y="${railTop}" width="${SVG_PHASE_W}" height="${railBot-railTop}" rx="8" fill="#f8fafc" stroke="#e2e8f0" stroke-width="1"/>
  ${phases.map((p, i) => `
    ${i > 0 ? `<line x1="${SVG_PHASE_X+10}" y1="${p.y}" x2="${SVG_PHASE_X+SVG_PHASE_W-10}" y2="${p.y}" stroke="#e2e8f0" stroke-width="0.8"/>` : ""}
    ${t(SVG_PHASE_X + SVG_PHASE_W/2, p.y + p.h/2 + 4, "middle", 10.5, "700", "#475569", p.label)}
  `).join("")}

  ${box(SVG_MAIN_X, R.id, SVG_MAIN_W, ID_H, "#eff6ff", "#2563eb")}
  ${t(mainCx, R.id+24, "middle", 12.5, "700", "#1e40af", "Records identified in databases")}
  ${grouped.map((s, i) => t(mainCx, R.id+42+i*18, "middle", 11, "400", "#1d4ed8", `${s.name}    n = ${s.count.toLocaleString()}`)).join("")}
  ${grouped.length > 1 ? `
    <line x1="${SVG_MAIN_X+20}" y1="${R.id+42+grouped.length*18-10}" x2="${SVG_MAIN_X+SVG_MAIN_W-20}" y2="${R.id+42+grouped.length*18-10}" stroke="#2563eb" stroke-width="0.6" opacity="0.4"/>
    ${t(mainCx, R.id+42+grouped.length*18+5, "middle", 11.5, "800", "#1e40af", `Total  n = ${totalIdentified.toLocaleString()}`)}
  ` : ""}

  ${downarrow(mainCx, R.id + ID_H, R.dd)}

  ${box(SVG_MAIN_X, R.dd, SVG_MAIN_W, SVG_MAIN_MIN_H, "#f5f3ff", "#7c3aed")}
  ${t(mainCx, R.dd+28, "middle", 12, "700", "#4c1d95", "Records after removing duplicates")}
  ${bigN(mainCx, R.dd+66, afterDedup, "#7c3aed", 22)}

  ${rightarrow(SVG_MAIN_X+SVG_MAIN_W, SVG_SIDE_X, R.dd+SVG_MAIN_MIN_H/2)}
  ${box(SVG_SIDE_X, R.dd, SVG_SIDE_W, SVG_SIDE_MIN_H, "#fff1f2", "#e11d48")}
  ${t(sideCx, R.dd+28, "middle", 12, "700", "#9f1239", "Duplicates removed")}
  ${bigN(sideCx, R.dd+66, duplicatesRemoved, "#e11d48", 22)}

  ${downarrow(mainCx, R.dd+SVG_MAIN_MIN_H, R.ta)}

  ${box(SVG_MAIN_X, R.ta, SVG_MAIN_W, TA_MAIN_H, "#ecfdf5", "#059669")}
  ${t(mainCx, R.ta+28, "middle", 12, "700", "#064e3b", "Records screened")}
  ${t(mainCx, R.ta+44, "middle", 10, "400", "#64748b", "(title &amp; abstract)")}
  ${bigN(mainCx, R.ta+70, taScreened, "#059669", 22)}
  ${taNotScreened > 0 ? t(mainCx, R.ta+88, "middle", 9.5, "400", "#64748b", `awaiting screening: n = ${taNotScreened.toLocaleString()}`) : ""}

  ${rightarrow(SVG_MAIN_X+SVG_MAIN_W, SVG_SIDE_X, R.ta+svgSideH(taReasons)/2)}
  ${box(SVG_SIDE_X, R.ta, SVG_SIDE_W, svgSideH(taReasons), "#fff1f2", "#e11d48")}
  ${t(sideCx, R.ta+22, "middle", 12, "700", "#9f1239", "Records excluded (TA)")}
  ${bigN(sideCx, R.ta+42, taExcluded, "#e11d48", 14)}
  ${reasonRows(taReasons, R.ta)}

  ${downarrow(mainCx, R.ta+TA_MAIN_H, R.ft)}

  ${box(SVG_MAIN_X, R.ft, SVG_MAIN_W, FT_MAIN_H, "#ecfdf5", "#059669")}
  ${t(mainCx, R.ft+28, "middle", 12, "700", "#064e3b", "Full-text articles assessed")}
  ${t(mainCx, R.ft+44, "middle", 10, "400", "#64748b", "(eligibility)")}
  ${bigN(mainCx, R.ft+70, ftScreened, "#059669", 22)}
  ${ftAwaiting > 0 ? t(mainCx, R.ft+88, "middle", 9.5, "400", "#64748b", `awaiting review: n = ${ftAwaiting.toLocaleString()}`) : ""}

  ${rightarrow(SVG_MAIN_X+SVG_MAIN_W, SVG_SIDE_X, R.ft+svgSideH(ftReasons)/2)}
  ${box(SVG_SIDE_X, R.ft, SVG_SIDE_W, svgSideH(ftReasons), "#fff1f2", "#e11d48")}
  ${t(sideCx, R.ft+22, "middle", 12, "700", "#9f1239", "Articles excluded (FT)")}
  ${bigN(sideCx, R.ft+42, ftExcluded, "#e11d48", 14)}
  ${reasonRows(ftReasons, R.ft)}

  ${downarrow(mainCx, R.ft+FT_MAIN_H, R.inc)}

  ${box(SVG_MAIN_X, R.inc, SVG_MAIN_W, IN_H, "#f0fdf4", "#16a34a")}
  ${t(mainCx, R.inc+26, "middle", 12.5, "700", "#14532d", "Studies included in review")}
  ${bigN(mainCx, R.inc+64, ftIncluded, "#16a34a", 26)}
  ${extracted > 0 ? t(mainCx, R.inc+84, "middle", 9.5, "400", "#64748b", `data extracted: n = ${extracted.toLocaleString()}`) : ""}
</svg>`;
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function PrismaPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const diagramRef = useRef<HTMLDivElement>(null);

  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [reasonOverrides, setReasonOverrides] = useState<Record<string, number>>({});

  const ov = useCallback((key: string, def: number) => overrides[key] ?? def, [overrides]);
  const setOv = useCallback((key: string) => (v: number) => setOverrides(o => ({ ...o, [key]: v })), []);

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

  const totalIdentified  = ov("total_identified",  prisma?.total_identified ?? grouped.reduce((a, s) => a + s.count, 0));
  // "After dedup" must count SCREENING UNITS (cross-source overlap clusters +
  // standalone records = allSource.record_count), the same unit ta_screened
  // uses. prisma.total_unique counts individual records, so cluster members
  // beyond the representative would show up as phantom "awaiting screening"
  // even at 100% progress. Cluster grouping is deduplication — count it here.
  const screeningUnits    = allSource?.record_count ?? prisma?.total_unique ?? 0;
  const afterDedup        = ov("after_dedup",        screeningUnits);
  const duplicatesRemoved = ov("duplicates_removed", Math.max(0, totalIdentified - screeningUnits));
  const taScreened        = ov("ta_screened",        allSource?.ta_screened ?? 0);
  const taIncluded        = allSource?.ta_included ?? 0;
  const taExcluded        = ov("ta_excluded",        allSource?.ta_excluded ?? (taScreened - taIncluded));
  const taUncertain       = ov("ta_uncertain",       allSource?.ta_uncertain ?? 0);
  const taNotScreened     = ov("ta_not_screened",    Math.max(0, afterDedup - taScreened));
  const ftScreened        = ov("ft_screened",        allSource?.ft_screened ?? 0);
  const ftIncluded        = ov("ft_included",        allSource?.ft_included ?? 0);
  const ftExcluded        = ov("ft_excluded",        ftScreened - ftIncluded);
  const ftAwaiting        = ov("ft_awaiting",        Math.max(0, taIncluded - ftScreened));
  const extracted         = ov("extracted",          allSource?.extracted_count ?? 0);

  // Per-source screening backlog — answers "where are the awaiting papers?"
  // Records can belong to several sources, so these can sum to more than the
  // unique total shown in the diagram.
  const sourceBacklog = indivSources
    .map(s => ({ id: s.id, name: s.name, remaining: Math.max(0, s.record_count - s.ta_screened) }))
    .filter(s => s.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining);

  const taReasonsBase = prisma?.ta_exclude_reasons ?? [];
  const ftReasonsBase = prisma?.ft_exclude_reasons ?? [];

  const taReasons = taReasonsBase.map((r, i) => ({
    ...r, count: reasonOverrides[`ta_${i}`] ?? r.count,
  }));
  const ftReasons = ftReasonsBase.map((r, i) => ({
    ...r, count: reasonOverrides[`ft_${i}`] ?? r.count,
  }));

  function downloadJPG() {
    const svg = buildExportSVG({
      grouped, totalIdentified, duplicatesRemoved, afterDedup,
      taScreened, taExcluded, taNotScreened, taUncertain,
      ftScreened, ftIncluded, ftExcluded, ftAwaiting, extracted,
      taReasons, ftReasons,
    });
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const canvas = document.createElement("canvas");
    const scale = 2;
    canvas.width = (SVG_SIDE_X + SVG_SIDE_W + 20) * scale;
    const img = new Image();
    img.onload = () => {
      canvas.height = img.naturalHeight * scale / img.naturalWidth * canvas.width;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => {
        if (!b) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b); a.download = "prisma-diagram.jpg"; a.click();
        URL.revokeObjectURL(a.href);
      }, "image/jpeg", 0.95);
    };
    img.src = url;
  }

  if (srcLoading || prismaLoading) {
    return <div style={{ padding: "2rem", color: "#94a3b8" }}>Loading…</div>;
  }

  // ── Shared box styles ──────────────────────────────────────────────────────
  const boxTitle = (color: string, text: string) => (
    <div style={{ textAlign: "center", fontSize: 12.5, fontWeight: 700, color, marginBottom: 2 }}>
      {text}
    </div>
  );
  const boxSub = (text: string) => (
    <div style={{ textAlign: "center", fontSize: 10.5, color: "#64748b", marginBottom: 2 }}>{text}</div>
  );

  return (
    <div style={{ padding: "2rem" }}>
      <header className="page-header">
        <div className="page-title">
          <h1>PRISMA Flow Diagram</h1>
          <span className="subtitle">
            Preferred Reporting Items for Systematic Reviews and Meta-Analyses · 2020
            &nbsp;·&nbsp;
            <span style={{ color: "#6366f1", fontWeight: 500 }}>Click any number to edit</span>
          </span>
        </div>
        <button className="btn-primary" onClick={downloadJPG}>Download JPG</button>
      </header>

      <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
      <div
        ref={diagramRef}
        style={{
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: "0.75rem",
          boxShadow: "0 2px 12px rgba(0,0,0,.07)",
          padding: "28px 28px 28px 16px",
          display: "inline-block",
          minWidth: 680,
        }}
      >
        {/* ── ROW 1 — Identification ─────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 0, alignItems: "stretch" }}>
          <PhaseBadge label="Identification" />
          <div style={{ width: 48 }} />
          <FlowBox color={C.id} minH={90}>
            {boxTitle(C.id.title, "Records identified in databases")}
            <div style={{ marginTop: 8 }}>
              {grouped.map((s) => (
                <div key={s.name} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.id.body, padding: "2px 8px" }}>
                  <span>{s.name}</span>
                  <span style={{ fontWeight: 700 }}>n = {s.count.toLocaleString()}</span>
                </div>
              ))}
              {grouped.length > 1 && (
                <>
                  <div style={{ borderTop: `1px solid ${C.id.border}44`, margin: "6px 8px 4px" }} />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 800, color: C.id.title, padding: "0 8px" }}>
                    <span>Total</span>
                    <span>n = <EN value={totalIdentified} color={C.id.title} size={12} onSave={setOv("total_identified")} /></span>
                  </div>
                </>
              )}
            </div>
          </FlowBox>
        </div>

        <VArrow />

        {/* ── ROW 2 — Deduplication ──────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 0, alignItems: "center" }}>
          <PhaseBadge label="Deduplication" />
          <div style={{ width: 48 }} />
          <FlowBox color={C.dedup}>
            {boxTitle(C.dedup.title, "Records after removing duplicates")}
            <NLine value={afterDedup} color={C.dedup.border} size={24} onSave={setOv("after_dedup")} />
          </FlowBox>
          <HArrow />
          <SideBox color={C.excl}>
            {boxTitle(C.excl.title, "Duplicates removed")}
            <NLine value={duplicatesRemoved} color={C.excl.border} size={24} onSave={setOv("duplicates_removed")} />
            {(prisma?.duplicates_removed ?? 0) > 0 && (prisma?.total_unique ?? 0) > screeningUnits && (
              <div style={{ textAlign: "center", fontSize: 9.5, color: "#9f1239", opacity: 0.75, marginTop: 2 }}>
                exact: {prisma!.duplicates_removed.toLocaleString()} · overlap-matched: {((prisma!.total_unique ?? 0) - screeningUnits).toLocaleString()}
              </div>
            )}
          </SideBox>
        </div>

        <VArrow />

        {/* ── ROW 3 — Title & Abstract Screening ────────────────────────── */}
        <div style={{ display: "flex", gap: 0, alignItems: "flex-start" }}>
          <div style={{ paddingTop: 20 }}><PhaseBadge label="Screening" /></div>
          <div style={{ width: 48 }} />
          <FlowBox color={C.screen}>
            {boxTitle(C.screen.title, "Records screened")}
            {boxSub("(title & abstract)")}
            <NLine value={taScreened} color={C.screen.border} size={24} onSave={setOv("ta_screened")} />
            {taNotScreened > 0 && (
              <div style={{ textAlign: "center", fontSize: 10, color: "#64748b", marginTop: 4 }}>
                awaiting screening: n = <EN value={taNotScreened} color="#64748b" size={10} onSave={setOv("ta_not_screened")} />
              </div>
            )}
            {taUncertain > 0 && (
              <div style={{ textAlign: "center", fontSize: 10, color: "#92400e", marginTop: 2 }}>
                uncertain: n = <EN value={taUncertain} color="#92400e" size={10} onSave={setOv("ta_uncertain")} />
              </div>
            )}
          </FlowBox>
          <HArrow yOffset={20} />
          <SideBox color={C.excl}>
            {boxTitle(C.excl.title, "Records excluded (TA)")}
            <div style={{ textAlign: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 10, color: C.excl.body, opacity: 0.6 }}>n = </span>
              <EN value={taExcluded} color={C.excl.border} size={14} onSave={setOv("ta_excluded")} />
            </div>
            {taReasons.length > 0 && (
              <>
                <div style={{ borderTop: `1px dashed #fca5a5`, margin: "6px 0 4px" }} />
                {taReasons.map((r, i) => (
                  <ReasonRow
                    key={i} code={r.reason_code} count={r.count} color={C.excl.border}
                    onSaveCount={v => setReasonOverrides(o => ({ ...o, [`ta_${i}`]: v }))}
                  />
                ))}
              </>
            )}
          </SideBox>
        </div>

        <VArrow />

        {/* ── ROW 4 — Full-text Eligibility ──────────────────────────────── */}
        <div style={{ display: "flex", gap: 0, alignItems: "flex-start" }}>
          <div style={{ paddingTop: 20 }}><PhaseBadge label="Eligibility" /></div>
          <div style={{ width: 48 }} />
          <FlowBox color={C.screen}>
            {boxTitle(C.screen.title, "Full-text articles assessed")}
            {boxSub("(eligibility)")}
            <NLine value={ftScreened} color={C.screen.border} size={24} onSave={setOv("ft_screened")} />
            {ftAwaiting > 0 && (
              <div style={{ textAlign: "center", fontSize: 10, color: "#64748b", marginTop: 4 }}>
                awaiting review: n = <EN value={ftAwaiting} color="#64748b" size={10} onSave={setOv("ft_awaiting")} />
              </div>
            )}
          </FlowBox>
          <HArrow yOffset={20} />
          <SideBox color={C.excl}>
            {boxTitle(C.excl.title, "Articles excluded (FT)")}
            <div style={{ textAlign: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 10, color: C.excl.body, opacity: 0.6 }}>n = </span>
              <EN value={ftExcluded} color={C.excl.border} size={14} onSave={setOv("ft_excluded")} />
            </div>
            {ftReasons.length > 0 && (
              <>
                <div style={{ borderTop: `1px dashed #fca5a5`, margin: "6px 0 4px" }} />
                {ftReasons.map((r, i) => (
                  <ReasonRow
                    key={i} code={r.reason_code} count={r.count} color={C.excl.border}
                    onSaveCount={v => setReasonOverrides(o => ({ ...o, [`ft_${i}`]: v }))}
                  />
                ))}
              </>
            )}
          </SideBox>
        </div>

        <VArrow />

        {/* ── ROW 5 — Included ───────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 0, alignItems: "center" }}>
          <PhaseBadge label="Included" />
          <div style={{ width: 48 }} />
          <FlowBox color={C.incl} minH={96}>
            {boxTitle(C.incl.title, "Studies included in review")}
            <NLine value={ftIncluded} color={C.incl.border} size={28} onSave={setOv("ft_included")} />
            {extracted > 0 && (
              <div style={{ textAlign: "center", fontSize: 10, color: "#64748b", marginTop: 4 }}>
                data extracted: n = <EN value={extracted} color="#64748b" size={10} onSave={setOv("extracted")} />
              </div>
            )}
          </FlowBox>
        </div>
      </div>

      {/* ── "Where are the remaining papers?" — actionable backlog panel ── */}
      {(taNotScreened > 0 || ftAwaiting > 0) && (
        <aside style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: "0.75rem", boxShadow: "var(--shadow-sm)",
          padding: "1.1rem 1.25rem", width: 300, flexShrink: 0,
          fontSize: "0.85rem",
        }}>
          <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.92rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <CheckSquare size={15} style={{ color: "var(--brand)" }} /> Where are the remaining papers?
          </h3>

          {taNotScreened > 0 && (
            <div style={{ marginBottom: ftAwaiting > 0 ? "1rem" : 0 }}>
              <p style={{ margin: "0 0 0.5rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--text)", fontSize: "1.05rem" }}>{taNotScreened.toLocaleString()}</strong>{" "}
                records are waiting in the <strong>Screening queue</strong> (title &amp; abstract stage).
              </p>
              <Link
                to={`/projects/${projectId}/screen?bucket=ta_unscreened&source=all&strategy=sequential`}
                className="btn-primary btn-sm"
                style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
              >
                Screen them now <ArrowRight size={13} />
              </Link>

              {sourceBacklog.length > 0 && (
                <div style={{ marginTop: "0.85rem" }}>
                  <div style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", marginBottom: "0.35rem" }}>
                    By source
                  </div>
                  {sourceBacklog.map(s => (
                    <Link
                      key={s.id}
                      to={`/projects/${projectId}/screen?bucket=ta_unscreened&source=${s.id}&strategy=sequential`}
                      style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "0.3rem 0.45rem", borderRadius: "0.375rem",
                        color: "var(--text-secondary)", textDecoration: "none", fontSize: "0.82rem",
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                      <span style={{ fontWeight: 700, color: "var(--warning)", flexShrink: 0, marginLeft: "0.5rem" }}>
                        {s.remaining.toLocaleString()}
                      </span>
                    </Link>
                  ))}
                  {sourceBacklog.length > 1 && (
                    <p style={{ margin: "0.4rem 0 0", fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.45 }}>
                      Records can appear in several sources, so these may sum to more than the unique total.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {ftAwaiting > 0 && (
            <div style={{ borderTop: taNotScreened > 0 ? "1px solid var(--border)" : "none", paddingTop: taNotScreened > 0 ? "0.85rem" : 0 }}>
              <p style={{ margin: "0 0 0.5rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--text)", fontSize: "1.05rem" }}>{ftAwaiting.toLocaleString()}</strong>{" "}
                TA-included records await <strong>full-text review</strong>.
              </p>
              <Link
                to={`/projects/${projectId}/screen?bucket=ft_pending&source=all&strategy=sequential`}
                className="btn-secondary btn-sm"
                style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
              >
                Review full texts <ArrowRight size={13} />
              </Link>
            </div>
          )}
        </aside>
      )}
      </div>

      <p style={{ fontSize: "0.78rem", color: "#94a3b8", marginTop: "1rem", maxWidth: 680 }}>
        Counts reflect current screening progress. Click any <strong style={{ color: "#6366f1" }}>n = </strong>
        value to override it for export. Edits are session-only and reset on refresh.
      </p>
    </div>
  );
}
