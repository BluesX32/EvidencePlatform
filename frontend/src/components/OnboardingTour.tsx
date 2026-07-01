/**
 * OnboardingTour v2 — illustrated interactive walkthrough.
 *
 * Two-column card: info + hoverable bullets on the left, live SVG illustration
 * on the right that responds to which bullet you're hovering.
 * Spotlight + pulsing ring point to the real sidebar nav link for each step.
 * Dismissed permanently via localStorage "ep_tour_done".
 */
import { useState, useEffect } from "react";
import {
  Upload, GitMerge, CheckSquare, FlaskConical, Tag, Users,
  SearchCode, X, ArrowRight, ArrowLeft, Layers, Cpu,
} from "lucide-react";

// ── Animation keyframes ────────────────────────────────────────────────────

const ANIM_CSS = `
@keyframes epTourIn {
  from { opacity: 0; transform: translate(-50%, -46%) scale(0.97); }
  to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}
@keyframes epIconPop {
  0%   { transform: scale(0.55) rotate(-12deg); opacity: 0; }
  70%  { transform: scale(1.12) rotate(2deg);   opacity: 1; }
  100% { transform: scale(1)    rotate(0deg);   opacity: 1; }
}
@keyframes epRingPulse {
  0%, 100% { opacity: 1;   transform: scale(1);    }
  50%       { opacity: 0.4; transform: scale(1.04); }
}
@keyframes epArrowPing {
  0%, 100% { opacity: 1;   transform: translateY(-50%); }
  50%       { opacity: 0.4; transform: translateY(calc(-50% - 9px)); }
}
@keyframes epIllustFade {
  from { opacity: 0; transform: scale(0.97); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes epFloat {
  0%, 100% { transform: translateY(0); }
  50%       { transform: translateY(-4px); }
}
@keyframes epBlink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
`;

// ── SVG illustration helpers ───────────────────────────────────────────────

const SANS = "system-ui,-apple-system,BlinkMacSystemFont,sans-serif";

/** Highlight rect that fades in/out based on `on` */
function HL({
  on, x, y, w, h, color, tag,
}: {
  on: boolean; x: number; y: number; w: number; h: number; color: string; tag?: string;
}) {
  const tw = tag ? tag.length * 5.6 + 16 : 0;
  return (
    <g style={{ opacity: on ? 1 : 0, transition: "opacity 0.22s ease", pointerEvents: "none" }}>
      <rect x={x - 2} y={y - 2} width={w + 4} height={h + 4} rx="5"
        fill={color + "1a"} stroke={color} strokeWidth="1.5" />
      {tag && (
        <>
          <rect x={x} y={y - 19} width={tw} height={14} rx="7" fill={color} />
          <text x={x + tw / 2} y={y - 8} fill="white" fontSize="8" textAnchor="middle" fontFamily={SANS} fontWeight="600">{tag}</text>
        </>
      )}
    </g>
  );
}

/** Mini sidebar + content shell */
function Shell({ navIdx, children }: { navIdx: number; children: React.ReactNode }) {
  const active = "#6366f1";
  const dim = "#1e3a5f";
  return (
    <svg viewBox="0 0 310 192" width="100%" style={{ display: "block" }} xmlns="http://www.w3.org/2000/svg">
      <rect width="310" height="192" rx="10" fill="#f8fafc" />
      {/* sidebar */}
      <rect width="40" height="192" fill="#0f172a" />
      <rect x="9" y="9" width="22" height="22" rx="5" fill="#4f46e5" />
      <text x="20" y="24" fill="white" fontSize="10" textAnchor="middle" fontFamily={SANS} fontWeight="bold">E</text>
      {[...Array(10)].map((_, i) => (
        <rect key={i} x="10" y={42 + i * 14} width="20" height="7" rx="3.5"
          fill={i === navIdx ? active : dim} />
      ))}
      {/* content */}
      <rect x="40" width="270" height="192" fill="white" />
      <rect x="40" height="26" width="270" fill="#f8fafc" />
      <line x1="40" y1="26" x2="310" y2="26" stroke="#e2e8f0" strokeWidth="1" />
      <g transform="translate(48, 34)">{children}</g>
    </svg>
  );
}

// content area origin: (48,34) → usable ~254×152

// ── Per-step illustrations ─────────────────────────────────────────────────

function PipelineIllust({ focus }: { focus: number }) {
  const stages: [string, string][] = [
    ["Import", "#3b82f6"], ["Overlap", "#7c3aed"], ["Screen", "#059669"],
    ["Extract", "#0891b2"], ["Themes", "#7c3aed"], ["Pilot", "#4f46e5"],
  ];
  const bw = 36, gap = 7;
  const total = stages.length * bw + (stages.length - 1) * gap;
  const sx = (254 - total) / 2;
  const sy = 58;
  return (
    <Shell navIdx={-1}>
      <text x="127" y="14" fill="#1e293b" fontSize="11" textAnchor="middle" fontFamily={SANS} fontWeight="700">
        Evidence Synthesis Pipeline
      </text>
      <text x="127" y="27" fill="#94a3b8" fontSize="8" textAnchor="middle" fontFamily={SANS}>
        Hover each bullet on the left to explore →
      </text>
      {stages.map(([label, color], i) => {
        const x = sx + i * (bw + gap);
        const hi = focus < 0 || focus === i;
        return (
          <g key={i} style={{ transition: "opacity 0.2s" }} opacity={hi ? 1 : 0.3}>
            {i > 0 && <line x1={x - gap} y1={sy + 9} x2={x} y2={sy + 9} stroke="#cbd5e1" strokeWidth="1.5" />}
            <rect x={x} y={sy} width={bw} height={18} rx="5" fill={color} />
            <text x={x + bw / 2} y={sy + 12} fill="white" fontSize="7.5" textAnchor="middle"
              fontFamily={SANS} fontWeight="600">{label}</text>
          </g>
        );
      })}
      {/* bullets map: focus 0 = import+overlap, 1 = screen+extract, 2 = all+team icons */}
      <g style={{ opacity: focus === 2 ? 1 : 0, transition: "opacity 0.22s" }}>
        {["A", "B"].map((l, i) => (
          <g key={i}>
            <circle cx={90 + i * 30} cy={118} r="12" fill="#47556912" stroke="#475569" strokeWidth="1.5" />
            <text x={90 + i * 30} y={123} fill="#475569" fontSize="9" textAnchor="middle" fontFamily={SANS} fontWeight="600">{l}</text>
          </g>
        ))}
        <text x="127" y="145" fill="#64748b" fontSize="8" textAnchor="middle" fontFamily={SANS}>Multi-reviewer collaboration</text>
      </g>
    </Shell>
  );
}

function ImportIllust({ focus }: { focus: number }) {
  const c = "#3b82f6";
  return (
    <Shell navIdx={1}>
      {/* page title */}
      <text x="0" y="12" fill="#1e293b" fontSize="10" fontFamily={SANS} fontWeight="700">Import Literature</text>
      {/* dropzone */}
      <rect x="0" y="18" width="200" height="52" rx="7" fill="#f0f9ff" stroke="#93c5fd" strokeWidth="1.5" strokeDasharray="5 3" />
      <text x="100" y="44" fill="#3b82f6" fontSize="10" textAnchor="middle" fontFamily={SANS} fontWeight="600">↑ Drop files here</text>
      {/* format badges */}
      {["RIS", "MEDLINE", "BibTeX"].map((fmt, i) => (
        <g key={i}>
          <rect x={i * 58} y="58" width="46" height="12" rx="6"
            fill={focus === 0 ? c : "#dbeafe"} style={{ transition: "fill 0.2s" }} />
          <text x={i * 58 + 23} y="67" fill={focus === 0 ? "white" : c} fontSize="7.5"
            textAnchor="middle" fontFamily={SANS} fontWeight="700">{fmt}</text>
        </g>
      ))}
      <HL on={focus === 0} x={-2} y={56} w={180} h={16} color={c} tag="3 file formats" />
      {/* record rows */}
      {["PubMed", "Embase", "Cochrane"].map((src, i) => (
        <g key={i} transform={`translate(0, ${82 + i * 22})`}>
          <rect width="254" height="18" rx="5" fill="white" stroke="#e0f2fe" strokeWidth="1" />
          <rect x="5" y="5" width="38" height="9" rx="4.5"
            fill={[c + "20", "#7c3aed20", "#05966920"][i]} />
          <text x="24" y="13" fill={[c, "#7c3aed", "#059669"][i]} fontSize="7"
            textAnchor="middle" fontFamily={SANS}>{src}</text>
          <rect x="50" y="6" width={[100, 85, 110][i]} height="7" rx="3.5" fill="#e0f2fe" />
          {/* duplicate badge on row 1 */}
          {i === 1 && (
            <g style={{ opacity: focus === 1 ? 1 : 0, transition: "opacity 0.22s" }}>
              <rect x="195" y="3" width="54" height="12" rx="6" fill="#fef9c3" stroke="#fbbf24" strokeWidth="1" />
              <text x="222" y="12" fill="#92400e" fontSize="7.5" textAnchor="middle" fontFamily={SANS}>×2 duplicate</text>
            </g>
          )}
        </g>
      ))}
      <HL on={focus === 1} x={0} y={100} w={254} h={18} color="#f59e0b" tag="Auto dedup" />
      {/* history panel for focus=2 */}
      <g style={{ opacity: focus === 2 ? 1 : 0, transition: "opacity 0.22s" }}>
        <rect x="168" y="80" width="86" height="68" rx="6" fill="white" stroke="#93c5fd" strokeWidth="1.5" />
        <text x="211" y="93" fill="#1e293b" fontSize="8" textAnchor="middle" fontFamily={SANS} fontWeight="700">Import Log</text>
        {[0, 1, 2].map(i => (
          <g key={i} transform={`translate(176, ${103 + i * 14})`}>
            <rect width="70" height="6" rx="3" fill="#dbeafe" />
            <rect y="8" width={[50, 62, 42][i]} height="4" rx="2" fill="#f1f5f9" />
          </g>
        ))}
      </g>
    </Shell>
  );
}

function OverlapIllust({ focus }: { focus: number }) {
  const circles: [number, number, string, string][] = [
    [68, 70, "#3b82f6", "PubMed"],
    [138, 70, "#059669", "Embase"],
    [103, 110, "#7c3aed", "Cochrane"],
  ];
  return (
    <Shell navIdx={2}>
      <text x="0" y="12" fill="#1e293b" fontSize="10" fontFamily={SANS} fontWeight="700">Cross-source Overlap</text>
      {/* Euler circles */}
      {circles.map(([cx, cy, color, label], i) => (
        <g key={i}>
          <circle cx={cx} cy={cy} r="38" fill={color + "18"}
            stroke={color} strokeWidth="1.5"
            style={{ opacity: focus === 1 ? 1 : 0.7, transition: "opacity 0.25s" }} />
          <text x={cx} y={cy - 42} fill={color} fontSize="8" textAnchor="middle"
            fontFamily={SANS} fontWeight="700">{label}</text>
        </g>
      ))}
      {/* region counts */}
      <text x="58" y="60" fill="#3b82f6" fontSize="9" textAnchor="middle" fontFamily={SANS} fontWeight="700">312</text>
      <text x="155" y="60" fill="#059669" fontSize="9" textAnchor="middle" fontFamily={SANS} fontWeight="700">248</text>
      <text x="103" y="148" fill="#7c3aed" fontSize="9" textAnchor="middle" fontFamily={SANS} fontWeight="700">89</text>
      <text x="103" y="90" fill="#475569" fontSize="9" textAnchor="middle" fontFamily={SANS} fontWeight="700">47</text>
      {/* focus 0: matching chain */}
      <g style={{ opacity: focus === 0 ? 1 : 0, transition: "opacity 0.22s" }}>
        <rect x="190" y="25" width="58" height="90" rx="6" fill="white" stroke="#ede9fe" strokeWidth="1.5" />
        {["DOI ✓", "PMID ✓", "Title+Author", "Fuzzy"].map((t, i) => (
          <g key={i} transform={`translate(196, ${36 + i * 20})`}>
            <rect width="46" height="12" rx="5" fill={["#ede9fe", "#ede9fe", "#f1f5f9", "#f1f5f9"][i]} />
            <text x="23" y="9.5" fill={["#7c3aed", "#7c3aed", "#64748b", "#64748b"][i]}
              fontSize="7.5" textAnchor="middle" fontFamily={SANS} fontWeight={i < 2 ? "700" : "400"}>{t}</text>
          </g>
        ))}
        <text x="219" y="31" fill="#7c3aed" fontSize="7" textAnchor="middle" fontFamily={SANS} fontWeight="600">5-tier match</text>
      </g>
      {/* focus 2: lock icon */}
      <g style={{ opacity: focus === 2 ? 1 : 0, transition: "opacity 0.22s" }}>
        <rect x="86" y="82" width="34" height="16" rx="8" fill="#7c3aed" />
        <text x="103" y="93" fill="white" fontSize="9" textAnchor="middle" fontFamily={SANS}>🔒 47</text>
      </g>
    </Shell>
  );
}

function ScreeningIllust({ focus }: { focus: number }) {
  return (
    <Shell navIdx={3}>
      <text x="0" y="12" fill="#1e293b" fontSize="10" fontFamily={SANS} fontWeight="700">Screening Workspace</text>
      {/* phase chips */}
      {[["TA", "#0891b2"], ["FT", "#7c3aed"], ["Extract", "#059669"]].map(([l, col], i) => (
        <g key={i} style={{ opacity: focus === 0 ? 1 : 0.5, transition: "opacity 0.22s" }}>
          <rect x={i * 68} y="18" width="56" height="14" rx="7"
            fill={focus === 0 ? col + "25" : "#f1f5f9"} stroke={focus === 0 ? col : "#e2e8f0"} strokeWidth="1" />
          <text x={i * 68 + 28} y="28" fill={focus === 0 ? col : "#94a3b8"}
            fontSize="8" textAnchor="middle" fontFamily={SANS} fontWeight="600">{l}</text>
        </g>
      ))}
      <HL on={focus === 0} x={-2} y={16} w={208} h={16} color="#0891b2" tag="TA → FT → Extract" />
      {/* paper card */}
      <rect x="0" y="38" width="200" height="78" rx="7" fill="white" stroke="#e2e8f0" strokeWidth="1.5" />
      {/* title bars */}
      <rect x="8" y="46" width="160" height="8" rx="4" fill="#e2e8f0" />
      <rect x="8" y="58" width="130" height="6" rx="3" fill="#f1f5f9" />
      <rect x="8" y="68" width="150" height="6" rx="3" fill="#f1f5f9" />
      <rect x="8" y="78" width="100" height="6" rx="3" fill="#f1f5f9" />
      {/* pinned exclusion reasons – focus 1 */}
      <g style={{ opacity: focus === 1 ? 1 : 0, transition: "opacity 0.22s" }}>
        {["Wrong pop.", "No outcome", "Review"].map((r, i) => (
          <g key={i} transform={`translate(210, ${38 + i * 20})`}>
            <rect width="44" height="14" rx="7" fill="#fee2e2" stroke="#fca5a5" strokeWidth="1" />
            <text x="22" y="10" fill="#dc2626" fontSize="7" textAnchor="middle" fontFamily={SANS}>{r}</text>
          </g>
        ))}
        <text x="232" y="103" fill="#dc2626" fontSize="7.5" textAnchor="middle" fontFamily={SANS} fontWeight="600">Pinned reasons</text>
      </g>
      {/* include/exclude buttons */}
      <g transform="translate(0, 122)">
        <rect width="96" height="22" rx="6" fill="#dcfce7" stroke="#86efac" strokeWidth="1" />
        <text x="48" y="15" fill="#15803d" fontSize="9" textAnchor="middle" fontFamily={SANS} fontWeight="700">✓ Include</text>
        <rect x="104" width="96" height="22" rx="6" fill="#fee2e2" stroke="#fca5a5" strokeWidth="1" />
        <text x="152" y="15" fill="#dc2626" fontSize="9" textAnchor="middle" fontFamily={SANS} fontWeight="700">✕ Exclude</text>
      </g>
      {/* full-text links – focus 2 */}
      <g style={{ opacity: focus === 2 ? 1 : 0, transition: "opacity 0.22s" }}>
        {["DOI", "PMC", "PubMed"].map((l, i) => (
          <g key={i} transform={`translate(${i * 52}, 148)`}>
            <rect width="44" height="12" rx="6" fill="#eff6ff" stroke="#93c5fd" strokeWidth="1" />
            <text x="22" y="9" fill="#3b82f6" fontSize="7.5" textAnchor="middle" fontFamily={SANS} fontWeight="600">{l}</text>
          </g>
        ))}
      </g>
    </Shell>
  );
}

function ExtractionIllust({ focus }: { focus: number }) {
  const c = "#0891b2";
  const cols = ["Study", "Population", "Intervention", "Outcome"];
  const colW = [52, 58, 72, 68];
  const colX = colW.reduce((acc, _w, i) => { acc.push(i === 0 ? 0 : acc[i - 1] + colW[i - 1] + 3); return acc; }, [] as number[]);
  return (
    <Shell navIdx={4}>
      {/* search bar – focus 2 */}
      <g style={{ opacity: focus === 2 ? 1 : 0, transition: "opacity 0.22s" }}>
        <rect x="0" y="0" width="180" height="14" rx="7" fill="#f0f9ff" stroke="#93c5fd" strokeWidth="1" />
        <text x="10" y="10" fill="#94a3b8" fontSize="7.5" fontFamily={SANS}>🔍 Search extractions…</text>
        {["RCT", "Policy"].map((chip, i) => (
          <g key={i} transform={`translate(${188 + i * 36}, 1)`}>
            <rect width="34" height="12" rx="6" fill={c + "20"} />
            <text x="17" y="9.5" fill={c} fontSize="7" textAnchor="middle" fontFamily={SANS}>{chip}</text>
          </g>
        ))}
      </g>
      <text x="0" y={focus === 2 ? 26 : 12} fill="#1e293b" fontSize="10" fontFamily={SANS} fontWeight="700"
        style={{ transition: "y 0.2s" }}>Extraction Library</text>
      {/* table header */}
      <g transform={`translate(0, ${focus === 2 ? 32 : 18})`} style={{ transition: "transform 0.2s" }}>
        <rect width="254" height="14" rx="3" fill="#f8fafc" />
        {cols.map((col, i) => (
          <g key={i}>
            <HL on={focus === 0} x={colX[i]} y={0} w={colW[i] - 2} h={14} color={c} />
            <text x={colX[i] + colW[i] / 2} y="10" fill={focus === 0 ? c : "#64748b"}
              fontSize="7.5" textAnchor="middle" fontFamily={SANS} fontWeight="700"
              style={{ transition: "fill 0.2s" }}>{col}</text>
          </g>
        ))}
        {/* data rows */}
        {[0, 1].map(row => (
          <g key={row} transform={`translate(0, ${18 + row * 22})`}>
            <rect width="254" height="18" rx="3" fill={row % 2 ? "#f8fafc" : "white"} stroke="#f1f5f9" strokeWidth="1" />
            {colW.map((w, i) => (
              <rect key={i} x={colX[i] + 3} y="6" width={w - 8} height="7" rx="3.5"
                fill={["#dbeafe", "#dcfce7", "#ede9fe", "#fef9c3"][i] + "aa"} />
            ))}
          </g>
        ))}
      </g>
      {/* saturation badge */}
      <g transform="translate(0, 130)">
        <rect width="254" height="18" rx="5" fill={focus === 1 ? "#fff7ed" : "#f8fafc"} stroke={focus === 1 ? "#fb923c" : "#e2e8f0"} strokeWidth="1.5"
          style={{ transition: "all 0.25s" }} />
        <text x="8" y="13" fill={focus === 1 ? "#c2410c" : "#94a3b8"} fontSize="8" fontFamily={SANS} fontWeight="600"
          style={{ transition: "fill 0.25s" }}>Saturation</text>
        <rect x="68" y="6" width="120" height="7" rx="3.5" fill="#f1f5f9" />
        <rect x="68" y="6" width={focus === 1 ? 96 : 60} height="7" rx="3.5"
          fill={focus === 1 ? "#fb923c" : "#94a3b8"} style={{ transition: "width 0.4s, fill 0.25s" }} />
        <text x="196" y="13" fill={focus === 1 ? "#c2410c" : "#94a3b8"} fontSize="8" fontFamily={SANS}>
          {focus === 1 ? "80%" : "50%"}
        </text>
        <HL on={focus === 1} x={0} y={0} w={254} h={18} color="#f97316" tag="Saturation" />
      </g>
    </Shell>
  );
}

function CitationIllust({ focus }: { focus: number }) {
  const leftNodes = [[60, 55], [40, 90], [65, 120]];
  const rightNodes = [[195, 50], [215, 85], [195, 120], [175, 105]];
  const centerNodes = [[100, 70], [127, 85], [155, 75], [115, 105]];
  return (
    <Shell navIdx={5}>
      <text x="0" y="12" fill="#1e293b" fontSize="10" fontFamily={SANS} fontWeight="700">Citation Sourcing</text>
      {/* center cluster */}
      {centerNodes.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={i === 1 ? 10 : 7} fill="#0284c7" fillOpacity={i === 1 ? 0.9 : 0.5} />
      ))}
      {/* backward arrows – focus 0 or default */}
      {leftNodes.map(([lx, ly], i) => (
        <g key={i} style={{ opacity: focus === 0 || focus < 0 ? 1 : 0.2, transition: "opacity 0.22s" }}>
          <line x1={lx + 10} y1={ly} x2={centerNodes[i < 2 ? i : 0][0] - 7} y2={centerNodes[i < 2 ? i : 0][1]}
            stroke="#0284c7" strokeWidth="1.5" strokeDasharray={focus === 0 ? "none" : "4 3"} />
          <circle cx={lx} cy={ly} r="7" fill="#eff6ff" stroke="#0284c7" strokeWidth="1.5" />
        </g>
      ))}
      {/* forward arrows – focus 1 */}
      {rightNodes.map(([rx, ry], i) => (
        <g key={i} style={{ opacity: focus === 1 || focus < 0 ? 1 : 0.2, transition: "opacity 0.22s" }}>
          <line x1={centerNodes[Math.min(i, centerNodes.length - 1)][0] + 7}
            y1={centerNodes[Math.min(i, centerNodes.length - 1)][1]}
            x2={rx - 10} y2={ry}
            stroke="#7c3aed" strokeWidth="1.5" strokeDasharray={focus === 1 ? "none" : "4 3"} />
          <circle cx={rx} cy={ry} r="7" fill="#faf5ff" stroke="#7c3aed" strokeWidth="1.5" />
        </g>
      ))}
      {/* labels */}
      <g style={{ opacity: focus === 0 ? 1 : 0, transition: "opacity 0.22s" }}>
        <rect x="2" y="16" width="54" height="12" rx="6" fill="#0284c7" />
        <text x="29" y="25" fill="white" fontSize="7.5" textAnchor="middle" fontFamily={SANS} fontWeight="600">← References</text>
      </g>
      <g style={{ opacity: focus === 1 ? 1 : 0, transition: "opacity 0.22s" }}>
        <rect x="196" y="16" width="50" height="12" rx="6" fill="#7c3aed" />
        <text x="221" y="25" fill="white" fontSize="7.5" textAnchor="middle" fontFamily={SANS} fontWeight="600">Citing →</text>
      </g>
      {/* iteration rings – focus 2 */}
      <g style={{ opacity: focus === 2 ? 1 : 0, transition: "opacity 0.22s" }}>
        <circle cx="127" cy="85" r="35" fill="none" stroke="#0284c750" strokeWidth="8" />
        <circle cx="127" cy="85" r="55" fill="none" stroke="#0284c730" strokeWidth="10" />
        <text x="127" y="152" fill="#0284c7" fontSize="8" textAnchor="middle" fontFamily={SANS} fontWeight="700">Round 1 → Round 2 →</text>
      </g>
    </Shell>
  );
}

function LabelsIllust({ focus }: { focus: number }) {
  const labelColors = ["#6366f1", "#f59e0b", "#10b981"];
  const labelNames = ["RCT", "Policy", "Low quality"];
  return (
    <Shell navIdx={6}>
      <text x="0" y="12" fill="#1e293b" fontSize="10" fontFamily={SANS} fontWeight="700">Labels</text>
      {/* article rows */}
      {[0, 1, 2].map(i => (
        <g key={i} transform={`translate(0, ${20 + i * 28})`}>
          <rect width="254" height="24" rx="6" fill="white" stroke="#fecdd3" strokeWidth="1" />
          <rect x="6" y="8" width={[120, 100, 110][i]} height="8" rx="4" fill="#fee2e2" />
          {/* label chip */}
          <rect x="200" y="7" width={labelNames[i].length * 6 + 10} height="12" rx="6"
            fill={labelColors[i] + "25"} stroke={labelColors[i] + "60"} strokeWidth="1" />
          <text x={200 + (labelNames[i].length * 6 + 10) / 2} y="16.5" fill={labelColors[i]}
            fontSize="7.5" textAnchor="middle" fontFamily={SANS} fontWeight="700">{labelNames[i]}</text>
        </g>
      ))}
      {/* label creator – focus 0 */}
      <g style={{ opacity: focus === 0 ? 1 : 0, transition: "opacity 0.22s" }}>
        <rect x="0" y="106" width="254" height="40" rx="7" fill="white" stroke="#fecdd3" strokeWidth="1.5" />
        <text x="10" y="120" fill="#1e293b" fontSize="8" fontFamily={SANS} fontWeight="700">Create label</text>
        <rect x="10" y="124" width="140" height="14" rx="5" fill="#f8fafc" stroke="#e2e8f0" strokeWidth="1" />
        <text x="18" y="134" fill="#94a3b8" fontSize="8" fontFamily={SANS}>Label name…</text>
        {["#6366f1", "#f59e0b", "#10b981", "#e11d48", "#3b82f6"].map((col, i) => (
          <circle key={i} cx={162 + i * 16} cy={131} r="6" fill={col} />
        ))}
      </g>
      {/* stats – focus 2 */}
      <g style={{ opacity: focus === 2 ? 1 : 0, transition: "opacity 0.22s" }}>
        <rect x="0" y="106" width="254" height="40" rx="7" fill="#fff1f2" stroke="#fecdd3" strokeWidth="1.5" />
        {labelNames.map((name, i) => (
          <g key={i} transform={`translate(10, ${116 + i * 0})`}>
            <text y={12 + i * 12} fill={labelColors[i]} fontSize="8" fontFamily={SANS} fontWeight="700">{name}</text>
            <rect x="55" y={4 + i * 12} width={[80, 60, 40][i]} height="8" rx="4" fill={labelColors[i] + "40"} />
            <rect x="55" y={4 + i * 12} width={[80, 60, 40][i]} height="8" rx="4" fill={labelColors[i]} fillOpacity="0.7" />
            <text x={60 + [80, 60, 40][i]} y={12 + i * 12} fill={labelColors[i]} fontSize="7" fontFamily={SANS}>{[24, 18, 12][i]}</text>
          </g>
        ))}
      </g>
    </Shell>
  );
}

function ConceptsIllust({ focus }: { focus: number }) {
  const c = "#7c3aed";
  const themes = [
    { name: "Barriers", codes: ["Access", "Cost"], color: "#7c3aed" },
    { name: "Enablers", codes: ["Training", "Support", "Policy"], color: "#059669" },
  ];
  return (
    <Shell navIdx={7}>
      {/* tabs */}
      <g>
        {["Entity", "Relation", "Metadata"].map((tab, i) => (
          <g key={i}>
            <rect x={i * 78} y="0" width="72" height="16" rx="4"
              fill={focus === 0 ? (i === 0 ? c : "#f8fafc") : "#f8fafc"}
              stroke={focus === 0 && i === 0 ? c : "#e2e8f0"} strokeWidth="1"
              style={{ transition: "all 0.22s" }} />
            <text x={i * 78 + 36} y="11.5" fill={focus === 0 && i === 0 ? c : "#64748b"}
              fontSize="8" textAnchor="middle" fontFamily={SANS} fontWeight={focus === 0 && i === 0 ? "700" : "400"}>{tab}</text>
          </g>
        ))}
      </g>
      <HL on={focus === 0} x={-2} y={-2} w={240} h={20} color={c} tag="Field types" />
      {/* theme tree */}
      {themes.map((theme, ti) => {
        const ty = 26 + ti * 58;
        return (
          <g key={ti}>
            <rect x="0" y={ty} width="130" height="16" rx="5"
              fill={theme.color + "20"} stroke={theme.color + "50"} strokeWidth="1" />
            <text x="8" y={ty + 11} fill={theme.color} fontSize="9" fontFamily={SANS} fontWeight="700">{theme.name}</text>
            {theme.codes.map((code, ci) => {
              const cy = ty + 20 + ci * 16;
              return (
                <g key={ci}>
                  <line x1="10" y1={ty + 16} x2="10" y2={cy + 7} stroke="#cbd5e1" strokeWidth="1" />
                  <line x1="10" y1={cy + 7} x2="22" y2={cy + 7} stroke="#cbd5e1" strokeWidth="1" />
                  <rect x="22" y={cy} width="96" height="14" rx="4"
                    fill={focus === 1 ? theme.color + "15" : "white"} stroke="#e2e8f0" strokeWidth="1"
                    style={{ transition: "fill 0.22s" }} />
                  <text x="30" y={cy + 10} fill="#374151" fontSize="8.5" fontFamily={SANS}>{code}</text>
                </g>
              );
            })}
          </g>
        );
      })}
      {/* push to ontology – focus 2 */}
      <g style={{ opacity: focus === 2 ? 1 : 0, transition: "opacity 0.22s" }}>
        <rect x="0" y="142" width="254" height="16" rx="7" fill={c} />
        <text x="127" y="153" fill="white" fontSize="8.5" textAnchor="middle" fontFamily={SANS} fontWeight="700">
          ✓ Push concepts to Ontology
        </text>
      </g>
    </Shell>
  );
}

function AIPilotIllust({ focus }: { focus: number }) {
  const c = "#4f46e5";
  const rows: [string, string, string, string][] = [
    ["✓", "#059669", "Setup", "Draft with AI ✦"],
    ["✓", "#059669", "Import · 847 records", "—"],
    ["⚡", "#f59e0b", "Screen · 643/847", "Cancel"],
    ["○", "#94a3b8", "Extract · 0/204", "Extract All ✦"],
    ["○", "#94a3b8", "Themes", "Suggest ✦"],
  ];
  return (
    <Shell navIdx={8}>
      <text x="0" y="12" fill="#1e293b" fontSize="10" fontFamily={SANS} fontWeight="700">AI Pilot</text>
      {rows.map(([icon, iconC, label, action], i) => (
        <g key={i} transform={`translate(0, ${18 + i * 26})`}>
          <rect width="254" height="22" rx="5" fill={focus === 0 && icon === "⚡" ? "#fffbeb" : "white"}
            stroke="#f1f5f9" strokeWidth="1" style={{ transition: "fill 0.22s" }} />
          {/* status icon */}
          <text x="12" y="15" fill={iconC} fontSize="10" textAnchor="middle" fontFamily={SANS}>{icon}</text>
          {/* label */}
          <text x="24" y="14.5" fill="#374151" fontSize="8" fontFamily={SANS}>{label}</text>
          {/* action button */}
          {action !== "—" && (
            <g style={{
              opacity: focus === 1 ? 1 : 0.5,
              transition: "opacity 0.22s",
            }}>
              <rect x="175" y="5" width={action.length * 5 + 10} height="12" rx="6"
                fill={action.includes("✦") ? c : "#f1f5f9"}
                stroke={action.includes("✦") ? c : "#e2e8f0"} strokeWidth="1" />
              <text x={175 + (action.length * 5 + 10) / 2} y="14" fill={action.includes("✦") ? "white" : "#64748b"}
                fontSize="7" textAnchor="middle" fontFamily={SANS} fontWeight="600">{action}</text>
            </g>
          )}
          {/* checkmark for focus 2 */}
          {action !== "—" && (
            <g style={{ opacity: focus === 2 && icon === "○" ? 1 : 0, transition: "opacity 0.22s" }}>
              <circle cx="162" cy="11" r="7" fill="#dcfce7" stroke="#86efac" strokeWidth="1" />
              <text x="162" y="15" fill="#15803d" fontSize="9" textAnchor="middle" fontFamily={SANS}>✓</text>
            </g>
          )}
        </g>
      ))}
      <HL on={focus === 0} x={0} y={44} w={254} h={22} color="#f59e0b" tag="Live status" />
    </Shell>
  );
}

function TeamIllust({ focus }: { focus: number }) {
  return (
    <Shell navIdx={9}>
      <text x="0" y="12" fill="#1e293b" fontSize="10" fontFamily={SANS} fontWeight="700">Team Collaboration</text>
      {/* reviewer avatars */}
      {[["A", 68, "#3b82f6", "Include", "#dcfce7", "#15803d"],
        ["B", 168, "#e11d48", "Exclude", "#fee2e2", "#dc2626"]
      ].map(([label, cx, col, dec, bg, textC], i) => (
        <g key={i}>
          <circle cx={cx as number} cy={62} r="22" fill={(col as string) + "20"} stroke={col as string} strokeWidth="2"
            style={{ animation: focus === 1 ? "epRingPulse 1.5s infinite" : "none" }} />
          <text x={cx as number} y="67" fill={col as string} fontSize="13" textAnchor="middle" fontFamily={SANS} fontWeight="700">{label as string}</text>
          <rect x={(cx as number) - 28} y="88" width="56" height="14" rx="7" fill={bg as string} stroke={(focus === 1 ? col : "#e2e8f0") as string} strokeWidth={focus === 1 ? 1.5 : 1} style={{ transition: "all 0.22s" }} />
          <text x={cx as number} y="98" fill={textC as string} fontSize="8" textAnchor="middle" fontFamily={SANS} fontWeight="700">{dec as string}</text>
        </g>
      ))}
      {/* conflict indicator */}
      <g style={{ opacity: focus === 1 ? 1 : 0, transition: "opacity 0.22s" }}>
        <line x1="92" y1="62" x2="144" y2="62" stroke="#ef4444" strokeWidth="2" strokeDasharray="4 3" />
        <rect x="107" y="55" width="22" height="14" rx="4" fill="#fee2e2" stroke="#f87171" strokeWidth="1" />
        <text x="118" y="65" fill="#dc2626" fontSize="9" textAnchor="middle" fontFamily={SANS}>⚠</text>
      </g>
      {/* invite form – focus 0 */}
      <g style={{ opacity: focus === 0 ? 1 : 0, transition: "opacity 0.22s" }}>
        <rect x="0" y="112" width="254" height="36" rx="7" fill="white" stroke="#e2e8f0" strokeWidth="1.5" />
        <text x="10" y="125" fill="#1e293b" fontSize="8" fontFamily={SANS} fontWeight="700">Invite by token</text>
        <rect x="10" y="127" width="170" height="14" rx="5" fill="#f8fafc" stroke="#e2e8f0" strokeWidth="1" />
        <text x="18" y="137" fill="#94a3b8" fontSize="8" fontFamily={SANS}>reviewer@institution.edu</text>
        <rect x="188" y="127" width="56" height="14" rx="7" fill="#4f46e5" />
        <text x="216" y="137" fill="white" fontSize="8" textAnchor="middle" fontFamily={SANS} fontWeight="600">Invite →</text>
      </g>
      {/* kappa – focus 2 */}
      <g style={{ opacity: focus === 2 ? 1 : 0, transition: "opacity 0.22s" }}>
        <rect x="55" y="112" width="144" height="36" rx="8" fill="#f8fafc" stroke="#e2e8f0" strokeWidth="1.5" />
        <text x="127" y="127" fill="#64748b" fontSize="8" textAnchor="middle" fontFamily={SANS}>Cohen's κ (TA stage)</text>
        <text x="127" y="143" fill="#059669" fontSize="16" textAnchor="middle" fontFamily={SANS} fontWeight="800">0.82</text>
      </g>
    </Shell>
  );
}

function ReadyIllust({ focus: _ }: { focus: number }) {
  const stars = [[30, 22], [272, 35], [18, 140], [265, 130], [140, 10], [85, 168], [198, 162]];
  return (
    <Shell navIdx={-1}>
      {stars.map(([sx, sy], i) => (
        <text key={i} x={sx} y={sy} fill={["#6366f1", "#f59e0b", "#10b981", "#e11d48", "#3b82f6", "#7c3aed", "#f97316"][i]}
          fontSize={[10, 9, 8, 10, 8, 9, 8][i]} textAnchor="middle" fontFamily={SANS}
          style={{ animation: `epFloat ${1.2 + i * 0.2}s ease-in-out ${i * 0.1}s infinite` }}>✦</text>
      ))}
      <circle cx="127" cy="82" r="38" fill="#ede9fe" />
      <circle cx="127" cy="82" r="30" fill="#7c3aed" />
      <text x="127" y="90" fill="white" fontSize="22" textAnchor="middle" fontFamily={SANS}>✓</text>
      <text x="127" y="136" fill="#1e293b" fontSize="11" textAnchor="middle" fontFamily={SANS} fontWeight="700">Ready to begin!</text>
      <text x="127" y="152" fill="#64748b" fontSize="8.5" textAnchor="middle" fontFamily={SANS}>
        Create your first project to get started
      </text>
    </Shell>
  );
}

// ── Step definitions ───────────────────────────────────────────────────────

interface Step {
  icon: React.ReactNode;
  color: string;
  title: string;
  desc: string;
  bullets: { emoji: string; text: string }[];
  tourTarget?: string;
  navLabel?: string;
  Illust: React.FC<{ focus: number }>;
}

const STEPS: Step[] = [
  {
    color: "#4f46e5",
    icon: (
      <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
        <rect x="4" y="2" width="16" height="20" rx="2.5" fill="white" fillOpacity=".9" />
        <rect x="7" y="6"  width="10" height="1.6" rx=".8" fill="#4f46e5" fillOpacity=".8" />
        <rect x="7" y="10" width="8"  height="1.3" rx=".65" fill="#4f46e5" fillOpacity=".5" />
        <rect x="7" y="13.5" width="9" height="1.3" rx=".65" fill="#4f46e5" fillOpacity=".5" />
        <circle cx="19" cy="19" r="5" fill="#818cf8" />
        <line x1="21.5" y1="21.5" x2="24" y2="24" stroke="white" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
    title: "Welcome to EvidencePlatform",
    desc: "A structured workspace for systematic evidence synthesis — from raw literature to thematic codebooks and ontology building. Hover each bullet to explore.",
    bullets: [
      { emoji: "🔄", text: "Complete pipeline: Import → Overlap → Screen → Extract → Themes" },
      { emoji: "📋", text: "Screen & Extract steps are auditable and reproducible" },
      { emoji: "🤝", text: "Multi-reviewer collaboration with Cohen's κ reliability" },
    ],
    Illust: PipelineIllust,
  },
  {
    color: "#3b82f6",
    icon: <Upload size={24} color="white" />,
    title: "1 · Import your literature",
    desc: "Upload RIS, MEDLINE, or BibTeX files from PubMed, Embase, Cochrane, and more. Within-source deduplication runs automatically after each import.",
    tourTarget: "import",
    navLabel: "Import",
    bullets: [
      { emoji: "📂", text: "Formats: RIS · MEDLINE · BibTeX — drag & drop or file picker" },
      { emoji: "🔍", text: "Automatic within-source dedup — no manual step needed" },
      { emoji: "📜", text: "Full import history with record-level provenance" },
    ],
    Illust: ImportIllust,
  },
  {
    color: "#7c3aed",
    icon: <GitMerge size={24} color="white" />,
    title: "2 · Resolve cross-source overlaps",
    desc: "Same paper in multiple databases? The platform clusters duplicates using a 5-tier strategy. An Euler diagram shows source overlap at a glance.",
    tourTarget: "overlap",
    navLabel: "Overlap",
    bullets: [
      { emoji: "🎯", text: "5-tier matching: DOI → PMID → Title+Year+Author → Fuzzy" },
      { emoji: "📊", text: "Euler diagram + pairwise matrix for source-level insight" },
      { emoji: "🔒", text: "Manually link or lock clusters to protect reviewed groups" },
    ],
    Illust: OverlapIllust,
  },
  {
    color: "#059669",
    icon: <CheckSquare size={24} color="white" />,
    title: "3 · Screen articles",
    desc: "Work through title/abstract then full-text screening. Your criteria appear in a collapsible panel. Decision buttons always stick to the bottom.",
    tourTarget: "screening",
    navLabel: "Screening",
    bullets: [
      { emoji: "⚡", text: "Sequential (TA → FT → Extract) or mixed mode" },
      { emoji: "🎯", text: "Pin your most-used exclusion reasons for one-click exclusion" },
      { emoji: "📄", text: "Full-text links via Unpaywall, PMC, PubMed, and DOI" },
    ],
    Illust: ScreeningIllust,
  },
  {
    color: "#0891b2",
    icon: <FlaskConical size={24} color="white" />,
    title: "4 · Extract structured evidence",
    desc: "For each included study, capture populations, interventions, outcomes, and key findings. The saturation badge tracks when your codebook is stabilising.",
    tourTarget: "extractions",
    navLabel: "Extractions",
    bullets: [
      { emoji: "🗂️", text: "Flexible schema — adapt extraction fields to your framework" },
      { emoji: "📈", text: "Saturation badge tracks codebook stability in real time" },
      { emoji: "🔬", text: "Extraction Library — search & filter all extracted papers" },
    ],
    Illust: ExtractionIllust,
  },
  {
    color: "#0284c7",
    icon: <SearchCode size={24} color="white" />,
    title: "5 · Discover more via citation sourcing",
    desc: "Citation Search finds additional relevant papers via backward sourcing (reference lists) and forward sourcing (citing papers), powered by Semantic Scholar.",
    tourTarget: "citations",
    navLabel: "Citation Search",
    bullets: [
      { emoji: "⬅️", text: "Backward sourcing — fetches reference lists of included papers" },
      { emoji: "➡️", text: "Forward sourcing — fetches papers that cite included papers" },
      { emoji: "♻️", text: "Run multiple iterations — each cohort seeds the next" },
    ],
    Illust: CitationIllust,
  },
  {
    color: "#e11d48",
    icon: <Tag size={24} color="white" />,
    title: "6 · Label articles",
    desc: "Create colour-coded labels ('RCT', 'Low quality', 'Policy-relevant') and assign them at any stage. The Labels page shows per-label counts and filtered article lists.",
    tourTarget: "labels",
    navLabel: "Labels",
    bullets: [
      { emoji: "🎨", text: "Custom names with a colour palette picker" },
      { emoji: "✏️", text: "Assign labels from the screening workspace or extraction panel" },
      { emoji: "📊", text: "Labels page: filter articles by label with stats at a glance" },
    ],
    Illust: LabelsIllust,
  },
  {
    color: "#7c3aed",
    icon: <Layers size={24} color="white" />,
    title: "7 · Build concepts & themes",
    desc: "Extract named entities and relationships in the Concept Taxonomy. Then build a Thematic codebook — assign codes to evidence and push key concepts to the shared Ontology.",
    tourTarget: "concepts",
    navLabel: "Concepts / Thematic",
    bullets: [
      { emoji: "🧩", text: "Concept fields: entities, relations, metadata — aggregated across reviewers" },
      { emoji: "🌳", text: "Thematic codebook: theme tree with full edit history" },
      { emoji: "🔗", text: "Push concepts to the Ontology for cross-project reuse" },
    ],
    Illust: ConceptsIllust,
  },
  {
    color: "#4f46e5",
    icon: <Cpu size={24} color="white" />,
    title: "8 · AI Pilot — automate the pipeline",
    desc: "The AI Pilot dashboard is your command center. One click runs AI across each stage. Every AI action surfaces in the existing review interface for human approval.",
    tourTarget: "ai-pilot",
    navLabel: "AI Pilot",
    bullets: [
      { emoji: "✦", text: "Pipeline dashboard: live status for every stage in one view" },
      { emoji: "⚡", text: "Bulk AI extraction, concept suggestion, and conflict resolution" },
      { emoji: "👁", text: "AI proposes → you review → approve or edit, always in control" },
    ],
    Illust: AIPilotIllust,
  },
  {
    color: "#475569",
    icon: <Users size={24} color="white" />,
    title: "9 · Collaborate with your team",
    desc: "Invite co-reviewers by token, assign roles, and screen in parallel. Each reviewer's decisions are stored independently. The Consensus page surfaces disagreements and computes Cohen's κ.",
    tourTarget: "team",
    navLabel: "Team / Consensus",
    bullets: [
      { emoji: "📧", text: "Invite by token → role-based access (owner / admin / reviewer)" },
      { emoji: "⚔️", text: "Conflict detection — auto-flags disagreeing TA or FT decisions" },
      { emoji: "📐", text: "Cohen's κ per reviewer pair, per stage, per project" },
    ],
    Illust: TeamIllust,
  },
  {
    color: "#4f46e5",
    icon: (
      <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
        <circle cx="13" cy="13" r="10" fill="white" fillOpacity=".25" />
        <circle cx="13" cy="13" r="7.5" fill="white" fillOpacity=".2" />
        <path d="M9 13l3 3 5.5-6" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    title: "You're all set!",
    desc: "Create your first project and follow the pipeline. Every module lives in the project sidebar. Restart this tour anytime from your profile menu.",
    bullets: [
      { emoji: "🚀", text: "Click \"New project\" on the Projects page to begin" },
      { emoji: "📌", text: "Sidebar gives one-click access to every module" },
      { emoji: "🔁", text: "Restart tour: profile menu (bottom-left) → Tutorial" },
    ],
    Illust: ReadyIllust,
  },
];

// ── Main component ─────────────────────────────────────────────────────────

interface Rect { left: number; top: number; width: number; height: number }

export default function OnboardingTour({ onDone }: { onDone: () => void }) {
  const [step, setStep]       = useState(0);
  const [animKey, setAnimKey] = useState(0);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [hoveredBullet, setHoveredBullet] = useState(-1);

  const current = STEPS[step];
  const isLast  = step === STEPS.length - 1;
  const color   = current.color;
  const pad     = 7;
  const { Illust } = current;

  useEffect(() => {
    if (!current.tourTarget) { setTargetRect(null); return; }
    function measure() {
      const el = document.querySelector(`[data-tour="${current.tourTarget}"]`);
      if (!el) { setTargetRect(null); return; }
      const r = el.getBoundingClientRect();
      setTargetRect({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [step, current.tourTarget]);

  function go(next: number) {
    setAnimKey(k => k + 1);
    setHoveredBullet(-1);
    setStep(next);
  }

  function dismiss() {
    localStorage.setItem("ep_tour_done", "1");
    onDone();
  }

  const sr = targetRect;

  return (
    <>
      <style>{ANIM_CSS}</style>

      {/* backdrop */}
      <div style={{ position: "fixed", inset: 0, zIndex: 9980, cursor: "pointer" }} onClick={dismiss} />

      {/* spotlight overlay */}
      {sr ? (
        <div style={{
          position: "fixed", left: sr.left - pad, top: sr.top - pad,
          width: sr.width + pad * 2, height: sr.height + pad * 2,
          borderRadius: 10, background: "transparent",
          boxShadow: "0 0 0 9999px rgba(10,14,26,0.78)", zIndex: 9981, pointerEvents: "none",
        }} />
      ) : (
        <div style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.72)", zIndex: 9981, pointerEvents: "none" }} />
      )}

      {/* pulsing ring */}
      {sr && (
        <div style={{
          position: "fixed", left: sr.left - pad - 2, top: sr.top - pad - 2,
          width: sr.width + (pad + 2) * 2, height: sr.height + (pad + 2) * 2,
          borderRadius: 12, border: `2.5px solid ${color}`,
          boxShadow: `0 0 14px 5px ${color}44`, zIndex: 9982, pointerEvents: "none",
          animation: "epRingPulse 1.8s ease-in-out infinite",
        }} />
      )}

      {/* bouncing pointer */}
      {sr && (
        <div style={{
          position: "fixed", left: sr.left + sr.width + pad + 10, top: sr.top + sr.height / 2,
          fontSize: "1.4rem", zIndex: 9983, pointerEvents: "none",
          animation: "epArrowPing 0.9s ease-in-out infinite", transform: "translateY(-50%)",
        }}>👈</div>
      )}

      {/* ── Tour card ── */}
      <div
        key={animKey}
        onClick={e => e.stopPropagation()}
        style={{
          position: "fixed", top: "50%", left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(95vw, 760px)",
          background: "#ffffff",
          borderRadius: 20,
          boxShadow: "0 32px 80px rgba(0,0,0,0.30), 0 4px 20px rgba(0,0,0,0.08)",
          overflow: "hidden", zIndex: 9990,
          animation: "epTourIn 0.32s cubic-bezier(0.22,1,0.36,1) both",
        }}
      >
        {/* ── Header ── */}
        <div style={{
          padding: "1.1rem 1.4rem 0.75rem",
          background: `linear-gradient(145deg, ${color}15 0%, #f8fafc 100%)`,
          borderBottom: `2px solid ${color}18`,
          display: "flex", alignItems: "center", gap: "0.9rem",
        }}>
          <div style={{
            width: 52, height: 52, borderRadius: 13, background: color,
            boxShadow: `0 6px 18px ${color}55`, display: "flex",
            alignItems: "center", justifyContent: "center", flexShrink: 0,
            animation: "epIconPop 0.45s cubic-bezier(0.22,1,0.36,1) both",
          }}>
            {current.icon}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "0.68rem", fontWeight: 700, color: `${color}99`, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 3 }}>
              {step > 0 && step < STEPS.length - 1 ? `Step ${step} of ${STEPS.length - 2}` : step === 0 ? "Welcome" : "All done"}
            </div>
            <h2 style={{ margin: 0, color: "#0f172a", fontSize: "1.05rem", fontWeight: 700, lineHeight: 1.3 }}>
              {current.title}
            </h2>
          </div>
          <button
            onClick={dismiss}
            style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 6, borderRadius: 8, display: "flex", alignItems: "center", flexShrink: 0 }}
            title="Skip tour"
          ><X size={16} /></button>
        </div>

        {/* ── Body: two columns ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.15fr", minHeight: 240 }}>
          {/* Left: desc + bullets */}
          <div style={{ padding: "0.9rem 1.1rem 0.7rem", borderRight: "1px solid #f1f5f9", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <p style={{ margin: 0, fontSize: "0.82rem", color: "#475569", lineHeight: 1.65 }}>
              {current.desc}
            </p>

            {current.navLabel && (
              <div style={{
                display: "inline-flex", alignItems: "center", gap: "0.3rem",
                background: `${color}12`, border: `1.5px solid ${color}30`,
                borderRadius: 9999, padding: "0.22rem 0.65rem 0.22rem 0.5rem",
                fontSize: "0.72rem", fontWeight: 700, color, width: "fit-content",
              }}>
                <span style={{ fontSize: "0.8rem" }}>📍</span>
                Sidebar → {current.navLabel}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", flex: 1 }}>
              {current.bullets.map((b, i) => (
                <div
                  key={i}
                  onMouseEnter={() => setHoveredBullet(i)}
                  onMouseLeave={() => setHoveredBullet(-1)}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: "0.45rem",
                    padding: "0.38rem 0.6rem",
                    background: hoveredBullet === i ? `${color}0e` : "#f8fafc",
                    borderRadius: 8,
                    border: `1.5px solid ${hoveredBullet === i ? color + "35" : "#f1f5f9"}`,
                    cursor: "default",
                    transition: "all 0.15s ease",
                    userSelect: "none",
                  }}
                >
                  <span style={{ fontSize: "0.88rem", lineHeight: "1.4", flexShrink: 0 }}>{b.emoji}</span>
                  <span style={{ fontSize: "0.78rem", color: hoveredBullet === i ? "#1e293b" : "#334155", lineHeight: 1.5, transition: "color 0.15s" }}>{b.text}</span>
                  {hoveredBullet === i && (
                    <span style={{ marginLeft: "auto", fontSize: "0.65rem", color, flexShrink: 0, opacity: 0.8 }}>→</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Right: illustration */}
          <div style={{ padding: "0.85rem 0.85rem 0.85rem 0.75rem", background: "#fafbfc", display: "flex", alignItems: "center" }}>
            <div style={{ width: "100%", animation: "epIllustFade 0.28s ease both" }} key={`${step}-${animKey}`}>
              <Illust focus={hoveredBullet} />
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0.55rem 1.4rem 0.8rem",
          borderTop: "1px solid #f1f5f9",
        }}>
          {/* progress dots */}
          <div style={{ display: "flex", gap: "0.22rem", alignItems: "center" }}>
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => go(i)}
                style={{
                  padding: 0, border: "none", cursor: "pointer",
                  height: 6, width: i === step ? 20 : 6, borderRadius: 9999,
                  background: i === step ? color : "#e2e8f0",
                  transition: "width 0.22s ease, background 0.22s ease",
                  flexShrink: 0,
                }}
              />
            ))}
          </div>

          {/* nav buttons */}
          <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
            {step > 0 && (
              <button
                className="btn-ghost btn-sm"
                onClick={() => go(step - 1)}
                style={{ display: "flex", alignItems: "center", gap: "0.2rem" }}
              >
                <ArrowLeft size={13} /> Back
              </button>
            )}
            {isLast ? (
              <button
                className="btn-primary btn-sm"
                style={{ background: color, borderColor: color }}
                onClick={dismiss}
              >
                Get started 🚀
              </button>
            ) : (
              <button
                className="btn-primary btn-sm"
                style={{ background: color, borderColor: color, display: "flex", alignItems: "center", gap: "0.2rem" }}
                onClick={() => go(step + 1)}
              >
                Next <ArrowRight size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
