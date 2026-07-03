// ── Publication styling ───────────────────────────────────────────────────────
// Monochrome ink on white, per the PRISMA 2020 template (BMJ 2021): boxes carry
// structure, text carries meaning, color carries nothing. Prints clean in
// grayscale and drops into a manuscript without restyling.
export const INK = {
  title: "#0f172a",
  body: "#334155",
  muted: "#64748b",
  border: "#475569",
  faint: "#e2e8f0",
  phaseBg: "#f1f5f9",
  phaseBorder: "#cbd5e1",
  arrow: "#475569",
};

export const FONT = "'Inter','Helvetica Neue',Arial,system-ui,sans-serif";


export function fmtReason(code: string | null): string {
  if (!code) return "No reason recorded";
  return code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}


// ── SVG export ────────────────────────────────────────────────────────────────
// Mirrors the on-screen figure: monochrome, PRISMA 2020 wording, rotated phase
// bars. Kept as a plain string builder so the download is a self-contained file.
const X = {
  phase: 14, phaseW: 34,
  main: 76, mainW: 340,
  side: 76 + 340 + 56, sideW: 300,
};
const SVG_W = X.side + X.sideW + 28;
const ROW_GAP = 34, MIN_H = 80, LINE_H = 16;

type Reason = { reason_code: string | null; count: number; label?: string };

export function buildExportSVG(data: {
  grouped: { name: string; count: number }[];
  totalIdentified: number; duplicatesRemoved: number; afterDedup: number;
  dupExact?: number; dupOverlap?: number;
  taScreened: number; taExcluded: number; taNotScreened: number; taUncertain: number;
  ftScreened: number; ftIncluded: number; ftExcluded: number; ftAwaiting: number;
  extracted: number;
  taReasons: Reason[];
  ftReasons: Reason[];
}): string {
  const {
    grouped, totalIdentified, duplicatesRemoved, afterDedup, dupExact, dupOverlap,
    taScreened, taExcluded, taNotScreened, taUncertain,
    ftScreened, ftIncluded, ftExcluded, ftAwaiting, extracted,
    taReasons, ftReasons,
  } = data;

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const mainCx = X.main + X.mainW / 2;
  const sideCx = X.side + X.sideW / 2;

  // Row heights driven by content
  const idH = Math.max(MIN_H, 46 + grouped.length * LINE_H + (grouped.length > 1 ? 22 : 0));
  const dupSideH = Math.max(MIN_H, 66 + ((dupExact ?? 0) > 0 || (dupOverlap ?? 0) > 0 ? 16 : 0));
  const idRowH = Math.max(idH, dupSideH);
  const ddH = MIN_H;
  const reasonsH = (rs: Reason[]) => Math.max(MIN_H, 64 + (rs.length ? 10 + rs.length * LINE_H : 0));
  const taSideH = reasonsH(taReasons);
  const taH = Math.max(MIN_H + (taNotScreened > 0 ? 16 : 0) + (taUncertain > 0 ? 14 : 0), 0);
  const taRowH = Math.max(taH, taSideH);
  const ftSideH = reasonsH(ftReasons);
  const ftH = MIN_H + (ftAwaiting > 0 ? 16 : 0);
  const ftRowH = Math.max(ftH, ftSideH);
  const incH = 88;

  const Y: Record<string, number> = { id: 20 };
  Y.dd  = Y.id + idRowH + ROW_GAP;
  Y.ta  = Y.dd + ddH + ROW_GAP;
  Y.ft  = Y.ta + taRowH + ROW_GAP;
  Y.inc = Y.ft + ftRowH + ROW_GAP;
  const H = Y.inc + incH + 20;

  const box = (x: number, y: number, w: number, h: number, emphasis = false) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#ffffff" stroke="${emphasis ? INK.title : INK.border}" stroke-width="${emphasis ? 2 : 1.5}"/>`;

  const t = (x: number, y: number, anchor: string, sz: number, fw: number | string, fill: string, txt: string, extra = "") =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${sz}" font-weight="${fw}" fill="${fill}"${extra}>${esc(txt)}</text>`;

  const heroN = (cx: number, y: number, v: number, sz = 20) =>
    `<text x="${cx}" y="${y}" text-anchor="middle">
       <tspan font-size="${Math.round(sz * 0.62)}" fill="${INK.muted}">n = </tspan>
       <tspan font-size="${sz}" font-weight="700" fill="${INK.title}">${v.toLocaleString()}</tspan>
     </text>`;

  const note = (cx: number, y: number, txt: string) =>
    t(cx, y, "middle", 9.5, 400, INK.muted, txt, ' font-style="italic"');

  const vArr = (x: number, y1: number, y2: number) =>
    `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2 - 7}" stroke="${INK.arrow}" stroke-width="1.5"/>
     <polygon points="${x - 4.5},${y2 - 8} ${x + 4.5},${y2 - 8} ${x},${y2}" fill="${INK.arrow}"/>`;

  const hArr = (x1: number, x2: number, y: number) =>
    `<line x1="${x1}" y1="${y}" x2="${x2 - 7}" y2="${y}" stroke="${INK.arrow}" stroke-width="1.5"/>
     <polygon points="${x2 - 8},${y - 4.5} ${x2 - 8},${y + 4.5} ${x2},${y}" fill="${INK.arrow}"/>`;

  const itemRow = (xL: number, xR: number, y: number, label: string, n: number, strong = false) =>
    t(xL, y, "start", strong ? 11 : 10.5, strong ? 700 : 400, strong ? INK.title : INK.body, label) +
    t(xR, y, "end", strong ? 11 : 10.5, 700, INK.title, `n = ${n.toLocaleString()}`);

  const phaseBar = (label: string, y: number, h: number) => {
    const cx = X.phase + X.phaseW / 2, cy = y + h / 2;
    return `<rect x="${X.phase}" y="${y}" width="${X.phaseW}" height="${h}" rx="4" fill="${INK.phaseBg}" stroke="${INK.phaseBorder}" stroke-width="1"/>
      <text x="${cx}" y="${cy}" text-anchor="middle" font-size="11" font-weight="600" fill="${INK.body}"
        letter-spacing="1.5" transform="rotate(-90, ${cx}, ${cy})" dominant-baseline="central">${label.toUpperCase()}</text>`;
  };

  const reasonBlock = (rs: Reason[], headY: number) => {
    if (!rs.length) return "";
    let out = `<line x1="${X.side + 12}" y1="${headY}" x2="${X.side + X.sideW - 12}" y2="${headY}" stroke="${INK.faint}" stroke-width="1"/>`;
    rs.forEach((r, i) => {
      const ry = headY + 15 + i * LINE_H;
      out += itemRow(X.side + 14, X.side + X.sideW - 14, ry, r.label ?? fmtReason(r.reason_code), r.count);
    });
    return out;
  };

  return `<svg width="${SVG_W}" height="${H}" viewBox="0 0 ${SVG_W} ${H}"
    xmlns="http://www.w3.org/2000/svg"
    style="font-family:${FONT};background:#ffffff">
  <rect x="0" y="0" width="${SVG_W}" height="${H}" fill="#ffffff"/>

  ${phaseBar("Identification", Y.id, idRowH + ROW_GAP + ddH)}
  ${phaseBar("Screening", Y.ta, taRowH + ROW_GAP + ftRowH)}
  ${phaseBar("Included", Y.inc, incH)}

  ${box(X.main, Y.id, X.mainW, idH)}
  ${t(mainCx, Y.id + 22, "middle", 12.5, 600, INK.title, "Records identified from:")}
  ${grouped.map((s, i) =>
    itemRow(X.main + 18, X.main + X.mainW - 18, Y.id + 42 + i * LINE_H, s.name, s.count),
  ).join("")}
  ${grouped.length > 1 ? `
    <line x1="${X.main + 14}" y1="${Y.id + 42 + grouped.length * LINE_H - 8}" x2="${X.main + X.mainW - 14}" y2="${Y.id + 42 + grouped.length * LINE_H - 8}" stroke="${INK.faint}" stroke-width="1"/>
    ${itemRow(X.main + 18, X.main + X.mainW - 18, Y.id + 42 + grouped.length * LINE_H + 8, "Total", totalIdentified, true)}
  ` : ""}

  ${hArr(X.main + X.mainW, X.side, Y.id + 40)}
  ${box(X.side, Y.id, X.sideW, dupSideH)}
  ${t(sideCx, Y.id + 22, "middle", 12, 600, INK.title, "Records removed before screening:")}
  ${itemRow(X.side + 14, X.side + X.sideW - 14, Y.id + 44, "Duplicate records removed", duplicatesRemoved)}
  ${(dupExact ?? 0) > 0 || (dupOverlap ?? 0) > 0
    ? note(sideCx, Y.id + 62, `exact: ${(dupExact ?? 0).toLocaleString()} · overlap-matched: ${(dupOverlap ?? 0).toLocaleString()}`)
    : ""}

  ${vArr(mainCx, Y.id + idH, Y.dd)}

  ${box(X.main, Y.dd, X.mainW, ddH)}
  ${t(mainCx, Y.dd + 28, "middle", 12.5, 600, INK.title, "Records after duplicates removed")}
  ${heroN(mainCx, Y.dd + 58, afterDedup)}

  ${vArr(mainCx, Y.dd + ddH, Y.ta)}

  ${box(X.main, Y.ta, X.mainW, taH)}
  ${t(mainCx, Y.ta + 24, "middle", 12.5, 600, INK.title, "Records screened")}
  ${t(mainCx, Y.ta + 39, "middle", 10.5, 400, INK.muted, "(title and abstract)")}
  ${heroN(mainCx, Y.ta + 66, taScreened)}
  ${taNotScreened > 0 ? note(mainCx, Y.ta + 84, `awaiting screening: n = ${taNotScreened.toLocaleString()}`) : ""}
  ${taUncertain > 0 ? note(mainCx, Y.ta + (taNotScreened > 0 ? 98 : 84), `uncertain: n = ${taUncertain.toLocaleString()}`) : ""}

  ${hArr(X.main + X.mainW, X.side, Y.ta + 40)}
  ${box(X.side, Y.ta, X.sideW, taSideH)}
  ${t(sideCx, Y.ta + 24, "middle", 12, 600, INK.title, "Records excluded")}
  ${heroN(sideCx, Y.ta + 48, taExcluded, 14)}
  ${reasonBlock(taReasons, Y.ta + 62)}

  ${vArr(mainCx, Y.ta + taH, Y.ft)}

  ${box(X.main, Y.ft, X.mainW, ftH)}
  ${t(mainCx, Y.ft + 24, "middle", 12.5, 600, INK.title, "Reports assessed for eligibility")}
  ${t(mainCx, Y.ft + 39, "middle", 10.5, 400, INK.muted, "(full text)")}
  ${heroN(mainCx, Y.ft + 66, ftScreened)}
  ${ftAwaiting > 0 ? note(mainCx, Y.ft + 84, `awaiting review: n = ${ftAwaiting.toLocaleString()}`) : ""}

  ${hArr(X.main + X.mainW, X.side, Y.ft + 40)}
  ${box(X.side, Y.ft, X.sideW, ftSideH)}
  ${t(sideCx, Y.ft + 24, "middle", 12, 600, INK.title, "Reports excluded, by reason:")}
  ${heroN(sideCx, Y.ft + 48, ftExcluded, 14)}
  ${reasonBlock(ftReasons, Y.ft + 62)}

  ${vArr(mainCx, Y.ft + ftH, Y.inc)}

  ${box(X.main, Y.inc, X.mainW, incH, true)}
  ${t(mainCx, Y.inc + 26, "middle", 13, 600, INK.title, "Studies included in review")}
  ${heroN(mainCx, Y.inc + 60, ftIncluded, 24)}
  ${extracted > 0 ? note(mainCx, Y.inc + 78, `data extracted: n = ${extracted.toLocaleString()}`) : ""}
</svg>`;
}

