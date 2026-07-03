import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

// ─────────────────────────────────────────────────────────────────────────────
// EvidencePlatform landing — typeset as an academic monograph.
// Paper cream, ink serif (Fraunces), mono annotations (IBM Plex Mono),
// hairline rules, numbered sections, and product mockups framed as figures.
// One accent: madder red. Motion is restrained: a staggered load reveal,
// the Fig. 1 pipeline cycle, and counters.
// ─────────────────────────────────────────────────────────────────────────────

const P = {
  paper:   "#f5f0e6",
  paperHi: "#faf6ee",
  plate:   "#fffdf7",
  ink:     "#1d1710",
  ink2:    "#514734",
  ink3:    "#8a7d63",
  line:    "#d8cdb5",
  lineSoft:"#e6ddc9",
  accent:  "#96301f",
  inkBlock:"#171310",
  cream:   "#efe7d4",
};

const SERIF = "'Fraunces', Georgia, 'Times New Roman', serif";
const MONO  = "'IBM Plex Mono', ui-monospace, 'SF Mono', monospace";

const PAGE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&family=IBM+Plex+Mono:ital,wght@0,400;0,500;1,400&display=swap');

.lp ::selection { background: ${P.accent}; color: ${P.cream}; }

@keyframes lpRise {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}
.lp-rise { animation: lpRise 0.8s cubic-bezier(0.2, 0.7, 0.2, 1) both; }

.lp-btn {
  font-family: ${MONO}; font-size: 13px; font-weight: 500;
  letter-spacing: 0.08em; text-transform: uppercase;
  padding: 0.85rem 1.9rem; cursor: pointer; border-radius: 2px;
  transition: background 0.18s, color 0.18s, transform 0.12s;
}
.lp-btn:active { transform: translateY(1px); }
.lp-btn--ink {
  background: ${P.ink}; color: ${P.cream}; border: 1px solid ${P.ink};
}
.lp-btn--ink:hover { background: ${P.accent}; border-color: ${P.accent}; color: #fff; }
.lp-btn--ghost {
  background: transparent; color: ${P.ink}; border: 1px solid ${P.line};
}
.lp-btn--ghost:hover { border-color: ${P.ink}; }
.lp-btn--cream {
  background: ${P.cream}; color: ${P.inkBlock}; border: 1px solid ${P.cream};
}
.lp-btn--cream:hover { background: #fff; border-color: #fff; }

.lp-textlink {
  color: ${P.accent}; cursor: pointer; background: none; border: none; padding: 0;
  font-family: inherit; font-size: inherit; font-style: italic;
  text-decoration: underline; text-decoration-thickness: 1px;
  text-underline-offset: 3px; text-decoration-color: ${P.accent}55;
  transition: text-decoration-color 0.15s;
}
.lp-textlink:hover { text-decoration-color: ${P.accent}; }

.lp-index-row { border-top: 1px solid ${P.lineSoft}; transition: background 0.15s; }
.lp-index-row:hover { background: ${P.paperHi}; }

@media (max-width: 860px) {
  .lp-nav-tag { display: none !important; }
}
@media (max-width: 560px) {
  .lp-nav { padding: 0 1rem !important; }
  .lp-nav-brand { letter-spacing: 0.1em !important; font-size: 11.5px !important; }
  .lp-nav-signin { display: none !important; }
  .lp-nav-cta { padding: 0.5rem 0.85rem !important; font-size: 11.5px !important; }
}
`;

// ── Animated counter ──────────────────────────────────────────────────────────
function AnimatedCounter({ target, suffix = "" }: { target: number; suffix?: string }) {
  const [val, setVal] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !started.current) {
        started.current = true;
        const dur = 1400;
        const step = 16;
        const steps = dur / step;
        let cur = 0;
        const iv = setInterval(() => {
          cur++;
          setVal(Math.min(target, Math.round((cur / steps) * target)));
          if (cur >= steps) clearInterval(iv);
        }, step);
      }
    }, { threshold: 0.3 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [target]);

  return <div ref={ref} style={{ display: "inline" }}>{val.toLocaleString()}{suffix}</div>;
}

// ── Figure plate — every mockup is presented as a numbered figure ─────────────
function MockCard({ children, fig, style }: {
  children: React.ReactNode; fig?: string; style?: React.CSSProperties;
}) {
  return (
    <figure style={{ margin: 0 }}>
      <div style={{
        background: P.plate, borderRadius: 3,
        border: `1px solid ${P.line}`,
        boxShadow: `3px 3px 0 ${P.lineSoft}`,
        padding: "1.25rem",
        ...style,
      }}>
        {children}
      </div>
      {fig && (
        <figcaption style={{
          fontFamily: MONO, fontSize: 11, color: P.ink3,
          marginTop: 10, letterSpacing: "0.04em",
        }}>
          {fig}
        </figcaption>
      )}
    </figure>
  );
}

// ── Euler mock visual ─────────────────────────────────────────────────────────
function EulerMock() {
  return (
    <MockCard fig="Fig. 3 — Area-proportional overlap map, four sources.">
      <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 12 }}>
        Overlap Map — 4 sources
      </div>
      <svg viewBox="0 0 340 200" style={{ width: "100%", height: "auto" }}>
        <circle cx="120" cy="95" r="78" fill="rgba(99,102,241,0.13)" stroke="#6366f1" strokeWidth="1.5" />
        <circle cx="185" cy="80" r="60" fill="rgba(16,185,129,0.12)" stroke="#10b981" strokeWidth="1.5" />
        <circle cx="175" cy="135" r="52" fill="rgba(245,158,11,0.13)" stroke="#f59e0b" strokeWidth="1.5" />
        <circle cx="240" cy="105" r="44" fill="rgba(239,68,68,0.11)" stroke="#ef4444" strokeWidth="1.5" />
        <text x="80" y="75" fontSize="10" fill="#6366f1" fontWeight="600">PubMed</text>
        <text x="80" y="87" fontSize="10" fill="#6366f1">n=2,840</text>
        <text x="193" y="55" fontSize="10" fill="#10b981" fontWeight="600">Embase</text>
        <text x="193" y="67" fontSize="10" fill="#10b981">n=1,920</text>
        <text x="148" y="167" fontSize="10" fill="#f59e0b" fontWeight="600">Cochrane</text>
        <text x="148" y="179" fontSize="10" fill="#f59e0b">n=740</text>
        <text x="248" y="97" fontSize="9" fill="#ef4444" fontWeight="600">WoS</text>
        <text x="248" y="107" fontSize="9" fill="#ef4444">n=510</text>
        <text x="155" y="95" fontSize="9" fill="#475569" fontWeight="700">312</text>
        <text x="172" y="112" fontSize="8" fill="#94a3b8">shared</text>
      </svg>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
        {[
          { c: "#6366f1", l: "PubMed unique: 2,528" },
          { c: "#10b981", l: "Embase unique: 1,608" },
          { c: "#f59e0b", l: "Cochrane unique: 428" },
        ].map(s => (
          <span key={s.l} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "#64748b" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.c }} />{s.l}
          </span>
        ))}
      </div>
    </MockCard>
  );
}

// ── Citation sourcing visual ──────────────────────────────────────────────────
function CitationMock() {
  const seeds = ["Dietary patterns & CVD risk (2019)", "Mediterranean diet RCT (2021)"];
  const refs = [
    { title: "Olive oil consumption and mortality — cohort study", dir: "←", new: true },
    { title: "PREDIMED-Plus: extended follow-up results", dir: "←", new: true },
    { title: "Anti-inflammatory diet and CVD outcomes", dir: "→", new: false },
    { title: "Plant-based diets in primary prevention (meta-analysis)", dir: "→", new: true },
  ];
  return (
    <MockCard fig="Fig. 4 — Backward and forward citation discovery from seed papers.">
      <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 10 }}>
        Citation Sourcing — Semantic Scholar
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 600, marginBottom: 5 }}>SEED PAPERS</div>
        {seeds.map(s => (
          <div key={s} style={{
            fontSize: 11.5, color: "#374151", background: "#eef2ff",
            border: "1px solid #c7d2fe", borderRadius: 6,
            padding: "5px 8px", marginBottom: 4,
          }}>{s}</div>
        ))}
      </div>
      <div>
        <div style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 600, marginBottom: 5 }}>
          DISCOVERED — 4 of 31 candidates
        </div>
        {refs.map(r => (
          <div key={r.title} style={{
            fontSize: 11, color: "#374151", background: r.new ? "#f0fdf4" : "#f8fafc",
            border: `1px solid ${r.new ? "#bbf7d0" : "#e2e8f0"}`, borderRadius: 6,
            padding: "5px 8px", marginBottom: 4,
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <span style={{
              fontSize: 9.5, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
              background: r.dir === "←" ? "#e0e7ff" : "#fce7f3",
              color: r.dir === "←" ? "#4f46e5" : "#be185d", flexShrink: 0,
            }}>{r.dir === "←" ? "Ref" : "Cites"}</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
            {r.new && <span style={{ fontSize: 9, color: "#059669", fontWeight: 700, flexShrink: 0 }}>NEW</span>}
          </div>
        ))}
      </div>
    </MockCard>
  );
}

// ── LLM screening visual ──────────────────────────────────────────────────────
function LLMMock() {
  const rows = [
    { title: "Omega-3 supplementation and CVD: RCT", llm: "include", human: "include", match: true },
    { title: "Dietary fat quality and coronary risk", llm: "include", human: "exclude", match: false },
    { title: "Mediterranean diet adherence score", llm: "include", human: "include", match: true },
    { title: "Trans fatty acids and inflammation markers", llm: "exclude", human: "exclude", match: true },
  ];
  return (
    <MockCard fig="Fig. 5 — Model decisions compared against human screening, with Cohen's κ.">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>LLM vs Human comparison</div>
        <div style={{
          fontSize: 11, fontWeight: 700, color: "#4f46e5",
          background: "#eef2ff", borderRadius: 6, padding: "3px 8px",
        }}>κ = 0.84 (near-perfect)</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 60px 36px", gap: "0 8px", marginBottom: 4 }}>
        {["Paper", "LLM", "Human", ""].map(h => (
          <div key={h} style={{ fontSize: 9.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase" }}>{h}</div>
        ))}
      </div>
      {rows.map(r => (
        <div key={r.title} style={{ display: "grid", gridTemplateColumns: "1fr 60px 60px 36px", gap: "0 8px", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
          <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 4, textAlign: "center",
            background: r.llm === "include" ? "#dcfce7" : "#fee2e2",
            color: r.llm === "include" ? "#059669" : "#dc2626" }}>{r.llm}</span>
          <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 4, textAlign: "center",
            background: r.human === "include" ? "#dcfce7" : "#fee2e2",
            color: r.human === "include" ? "#059669" : "#dc2626" }}>{r.human}</span>
          <span style={{ fontSize: 14, textAlign: "center" }}>{r.match ? "✓" : "⚠"}</span>
        </div>
      ))}
      <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid #e2e8f0", display: "flex", gap: 10 }}>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#059669" }}>75%</div>
          <div style={{ fontSize: 9.5, color: "#94a3b8" }}>agreement</div>
        </div>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#4f46e5" }}>1</div>
          <div style={{ fontSize: 9.5, color: "#94a3b8" }}>conflict flagged</div>
        </div>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#f59e0b" }}>→ Consensus</div>
          <div style={{ fontSize: 9.5, color: "#94a3b8" }}>send for review</div>
        </div>
      </div>
    </MockCard>
  );
}

// ── Ontology visual ───────────────────────────────────────────────────────────
function OntologyMock() {
  const NW = 80, NH = 26, NR = 4, hw = NW / 2, hh = NH / 2;

  const nodes = [
    { id: "entity",  label: "Entity",      ns: "owl:Class",           cx: 170, cy: 26,  stroke: "#818cf8", fill: "#1e1b4b", nsCol: "#6366f1" },
    { id: "disease", label: "Disease",     ns: "owl:Class",           cx: 76,  cy: 94,  stroke: "#818cf8", fill: "#1e1b4b", nsCol: "#6366f1" },
    { id: "bio",     label: "Biomarker",   ns: "owl:Class",           cx: 172, cy: 94,  stroke: "#818cf8", fill: "#1e1b4b", nsCol: "#6366f1" },
    { id: "interv",  label: "Intervention",ns: "owl:Class",           cx: 272, cy: 94,  stroke: "#818cf8", fill: "#1e1b4b", nsCol: "#6366f1" },
    { id: "cvd",     label: "CVD",         ns: "owl:NamedIndividual", cx: 65,  cy: 164, stroke: "#c4b5fd", fill: "#13103a", nsCol: "#a78bfa" },
    { id: "crp",     label: "CRP",         ns: "owl:NamedIndividual", cx: 172, cy: 164, stroke: "#34d399", fill: "#022c22", nsCol: "#6ee7b7" },
    { id: "diet",    label: "Med. Diet",   ns: "owl:NamedIndividual", cx: 278, cy: 164, stroke: "#fb923c", fill: "#431407", nsCol: "#fdba74" },
  ];

  const edges = [
    { x1: 170, y1: 39, x2: 76,  y2: 81,  label: "rdfs:subClassOf", lx: 108, ly: 56, dashed: false, col: "#475569" },
    { x1: 170, y1: 39, x2: 172, y2: 81,  label: "rdfs:subClassOf", lx: 203, ly: 57, dashed: false, col: "#475569" },
    { x1: 170, y1: 39, x2: 272, y2: 81,  label: "rdfs:subClassOf", lx: 234, ly: 55, dashed: false, col: "#475569" },
    { x1: 76,  y1: 107, x2: 65,  y2: 151, label: "rdf:type", lx: 93,  ly: 131, dashed: false, col: "#64748b" },
    { x1: 172, y1: 107, x2: 172, y2: 151, label: "rdf:type", lx: 198, ly: 131, dashed: false, col: "#64748b" },
    { x1: 272, y1: 107, x2: 278, y2: 151, label: "rdf:type", lx: 254, ly: 131, dashed: false, col: "#64748b" },
    { x1: 103, y1: 164, x2: 133, y2: 164, label: "hasBiomarker", lx: 118, ly: 156, dashed: true, col: "#f97316" },
  ];

  return (
    <MockCard fig="Fig. 6 — Concept ontology: classes, individuals, and typed relations.">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>Knowledge Graph — Ontology</div>
        <div style={{ display: "flex", gap: 8 }}>
          {[{ c: "#818cf8", l: "owl:Class" }, { c: "#c4b5fd", l: "NamedIndividual" }].map(n => (
            <span key={n.l} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, color: "#64748b", fontFamily: "monospace" }}>
              <span style={{ width: 10, height: 9, borderRadius: 2, border: `1.5px solid ${n.c}`, display: "inline-block" }} />
              {n.l}
            </span>
          ))}
        </div>
      </div>
      <svg viewBox="0 0 340 192" style={{ width: "100%", height: "auto", background: "#0f172a", borderRadius: 6 }}>
        <defs>
          <marker id="ont-arr"  markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L0,6 L6,3 z" fill="#475569" />
          </marker>
          <marker id="ont-arrT" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L0,6 L6,3 z" fill="#64748b" />
          </marker>
          <marker id="ont-arrP" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L0,6 L6,3 z" fill="#f97316" />
          </marker>
        </defs>

        {[28, 56, 84, 112, 140, 168].map(y => (
          <line key={y} x1={0} y1={y} x2={340} y2={y} stroke="#1e293b" strokeWidth={0.5} />
        ))}
        {[60, 120, 180, 240, 300].map(x => (
          <line key={x} x1={x} y1={0} x2={x} y2={192} stroke="#1e293b" strokeWidth={0.5} />
        ))}

        {edges.map((e, i) => {
          const markerId = e.dashed ? "url(#ont-arrP)" : i < 3 ? "url(#ont-arr)" : "url(#ont-arrT)";
          return (
            <g key={i}>
              <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                stroke={e.col} strokeWidth={1.5}
                strokeDasharray={e.dashed ? "4 3" : undefined}
                markerEnd={markerId}
              />
              <text x={e.lx} y={e.ly} textAnchor="middle" fontSize={6.5}
                fill={e.col} fontFamily="monospace">
                {e.label}
              </text>
            </g>
          );
        })}

        {nodes.map(n => (
          <g key={n.id}>
            <rect x={n.cx - hw} y={n.cy - hh} width={NW} height={NH} rx={NR}
              fill={n.fill} stroke={n.stroke} strokeWidth={1.5} />
            <text x={n.cx} y={n.cy - 4} textAnchor="middle"
              fontSize={6} fill={n.nsCol} fontFamily="monospace" opacity={0.85}>
              {n.ns}
            </text>
            <text x={n.cx} y={n.cy + 7} textAnchor="middle"
              fontSize={8.5} fill="#e2e8f0" fontWeight={700}>
              {n.label}
            </text>
          </g>
        ))}
      </svg>
    </MockCard>
  );
}

// ── Team collaboration visual ─────────────────────────────────────────────────
function TeamMock() {
  return (
    <MockCard fig="Fig. 7 — Independent reviewers, automatic conflict detection.">
      <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 12 }}>
        Team screening — inter-rater reliability
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {[
          { name: "DR", decision: "include", color: "#059669", bg: "#dcfce7" },
          { name: "MB", decision: "exclude", color: "#dc2626", bg: "#fee2e2" },
        ].map(r => (
          <div key={r.name} style={{
            flex: 1, border: `1px solid ${r.color}30`,
            borderRadius: 10, padding: "10px 12px",
            background: r.bg + "88",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <div style={{
                width: 24, height: 24, borderRadius: "50%",
                background: r.color, color: "#fff",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 800,
              }}>{r.name}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>Reviewer {r.name}</div>
            </div>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "2px 7px",
              borderRadius: 4, background: r.bg, color: r.color,
            }}>{r.decision}</span>
          </div>
        ))}
      </div>
      <div style={{
        background: "#fffbeb", border: "1px solid #fde68a",
        borderRadius: 8, padding: "8px 10px", marginBottom: 10,
        display: "flex", alignItems: "center", gap: 7,
      }}>
        <span style={{ fontSize: 14 }}>⚠️</span>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#92400e" }}>Conflict detected</div>
          <div style={{ fontSize: 10.5, color: "#a16207" }}>Title/abstract stage — adjudication required</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {[{ v: "κ = 0.81", l: "Cohen's κ", c: "#4f46e5" }, { v: "94%", l: "Agreement", c: "#059669" }, { v: "12", l: "Conflicts", c: "#d97706" }].map(s => (
          <div key={s.l} style={{
            flex: 1, textAlign: "center", background: "#f8fafc",
            borderRadius: 8, padding: "8px 4px", border: "1px solid #e2e8f0",
          }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: s.c }}>{s.v}</div>
            <div style={{ fontSize: 9.5, color: "#94a3b8" }}>{s.l}</div>
          </div>
        ))}
      </div>
    </MockCard>
  );
}

// ── PRISMA mock ───────────────────────────────────────────────────────────────
function PrismaMock() {
  const boxes = [
    { label: "Records identified", count: "6,010", color: "#2563eb", y: 0 },
    { label: "After deduplication", count: "4,218", color: "#7c3aed", y: 1 },
    { label: "Title/abstract screened", count: "4,218", color: "#059669", y: 2 },
    { label: "Full-text assessed", count: "612", color: "#059669", y: 3 },
    { label: "Included in synthesis", count: "89", color: "#16a34a", y: 4 },
  ];
  const excluded = [
    { label: "Duplicates: 1,792", y: 1 },
    { label: "Excluded TA: 3,606", y: 2 },
    { label: "Excluded FT: 523", y: 3 },
  ];
  return (
    <MockCard fig="Fig. 8 — PRISMA 2020 flow, generated from live counts.">
      <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 12 }}>
        PRISMA flow — auto-generated
      </div>
      <div style={{ position: "relative" }}>
        <svg viewBox="0 0 340 310" style={{ width: "100%", height: "auto" }}>
          {[0,1,2,3].map(i => (
            <line key={i} x1={120} y1={42 + i*58} x2={120} y2={52 + i*58}
              stroke="#94a3b8" strokeWidth="1.5" markerEnd="url(#arr)" />
          ))}
          <defs>
            <marker id="arr" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="#94a3b8" />
            </marker>
          </defs>
          {boxes.map((b, i) => (
            <g key={b.label}>
              <rect x={10} y={10 + i * 58} width={220} height={36}
                rx={7} fill={b.color + "14"} stroke={b.color} strokeWidth="1.5" />
              <text x={120} y={26 + i * 58} textAnchor="middle" fontSize="10"
                fill={b.color} fontWeight="700">{b.label}</text>
              <text x={120} y={38 + i * 58} textAnchor="middle" fontSize="12"
                fill={b.color} fontWeight="800">n = {b.count}</text>
            </g>
          ))}
          {excluded.map((e) => (
            <g key={e.label}>
              <line x1={230} y1={28 + e.y * 58} x2={248} y2={28 + e.y * 58}
                stroke="#94a3b8" strokeWidth="1.2" />
              <rect x={248} y={16 + e.y * 58} width={84} height={24}
                rx={5} fill="#fff1f2" stroke="#fca5a5" strokeWidth="1.2" />
              <text x={290} y={31 + e.y * 58} textAnchor="middle" fontSize="8.5"
                fill="#dc2626" fontWeight="600">{e.label}</text>
            </g>
          ))}
        </svg>
      </div>
    </MockCard>
  );
}

// ── Saturation mock ───────────────────────────────────────────────────────────
function SaturationMock() {
  const points = [12, 28, 45, 67, 84, 91, 95, 97, 98, 99];
  const maxW = 280;
  return (
    <MockCard fig="Fig. 9 — Theoretical saturation: five consecutive extractions, no new themes." style={{ background: "#0f172a", borderColor: "#0f172a" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0", marginBottom: 10 }}>
        Data saturation tracker
      </div>
      <div style={{
        background: "#1e293b", borderRadius: 10, padding: "12px 14px",
        marginBottom: 10, border: "1px solid #334155",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: "#94a3b8" }}>New themes per paper</span>
          <span style={{
            fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 6,
            background: "#dc2626", color: "#fff",
          }}>Threshold reached</span>
        </div>
        <svg viewBox={`0 0 ${maxW} 60`} style={{ width: "100%" }}>
          <polyline
            points={points.map((v, i) => `${(i / (points.length - 1)) * maxW},${60 - v * 0.6}`).join(" ")}
            fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          />
          {points.map((v, i) => (
            <circle key={i} cx={(i / (points.length - 1)) * maxW} cy={60 - v * 0.6} r="3.5" fill="#6366f1" />
          ))}
          <line x1={(7 / 9) * maxW} y1={0} x2={(7 / 9) * maxW} y2={60}
            stroke="#dc2626" strokeWidth="1.5" strokeDasharray="4 3" />
          <text x={(7 / 9) * maxW + 4} y={12} fontSize="8" fill="#f87171">5 consecutive</text>
          <text x={(7 / 9) * maxW + 4} y={22} fontSize="8" fill="#f87171">no new themes</text>
        </svg>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {[{ v: "89", l: "Papers extracted", c: "#6366f1" }, { v: "5", l: "Consecutive plateau", c: "#dc2626" }, { v: "14", l: "Themes total", c: "#10b981" }].map(s => (
          <div key={s.l} style={{ flex: 1, textAlign: "center", background: "#1e293b", borderRadius: 6, padding: "7px 4px", border: "1px solid #334155" }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: s.c }}>{s.v}</div>
            <div style={{ fontSize: 9, color: "#475569" }}>{s.l}</div>
          </div>
        ))}
      </div>
    </MockCard>
  );
}

// ── Dedup visual ──────────────────────────────────────────────────────────────
function DedupMock() {
  const tiers = [
    { tier: "Tier 1", match: "Exact DOI / PMID", count: 834, color: "#4f46e5", pct: 82 },
    { tier: "Tier 2", match: "Title + Year + Author + Volume", count: 112, color: "#7c3aed", pct: 55 },
    { tier: "Tier 3", match: "Title + Year + Author", count: 63, color: "#059669", pct: 31 },
    { tier: "Tier 4", match: "Title + Year", count: 42, color: "#d97706", pct: 21 },
    { tier: "Tier 5", match: "Fuzzy title similarity", count: 18, color: "#dc2626", pct: 9 },
  ];
  return (
    <MockCard fig="Fig. 2 — Five matching tiers, strictest first.">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>5-tier dedup engine</div>
        <div style={{
          fontSize: 11, fontWeight: 700, color: "#4f46e5",
          background: "#eef2ff", borderRadius: 6, padding: "2px 8px",
        }}>1,069 removed</div>
      </div>
      {tiers.map(t => (
        <div key={t.tier} style={{ marginBottom: 9 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: t.color }}>{t.tier}</span>
            <span style={{ fontSize: 10.5, color: "#94a3b8" }}>{t.match}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#374151" }}>{t.count}</span>
          </div>
          <div style={{ height: 6, background: "#f1f5f9", borderRadius: 99 }}>
            <div style={{ height: "100%", width: `${t.pct}%`, background: t.color, borderRadius: 99, transition: "width 0.8s" }} />
          </div>
        </div>
      ))}
    </MockCard>
  );
}

// ── Spotlight section — numbered like paper sections ─────────────────────────
function SpotlightCard({
  num, tag, title, description, visual, flip,
}: {
  num: string; tag: string; title: string; description: string;
  visual: React.ReactNode; flip?: boolean;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: flip ? "row-reverse" : "row",
      gap: "4rem", alignItems: "center",
      flexWrap: "wrap",
    }}>
      <div style={{ flex: "1 1 340px", minWidth: 0 }}>
        <div style={{
          fontFamily: MONO, fontSize: 12, color: P.accent,
          letterSpacing: "0.14em", textTransform: "uppercase",
          display: "flex", alignItems: "baseline", gap: 12, marginBottom: "1.1rem",
        }}>
          <span style={{ fontWeight: 500 }}>§ {num}</span>
          <span style={{ flex: 1, borderBottom: `1px solid ${P.line}`, transform: "translateY(-3px)" }} />
          <span style={{ color: P.ink3 }}>{tag}</span>
        </div>
        <h3 style={{
          fontFamily: SERIF, fontSize: "1.8rem", fontWeight: 550,
          letterSpacing: "-0.01em", color: P.ink,
          margin: "0 0 1rem", lineHeight: 1.22,
        }}>{title}</h3>
        <p style={{
          fontFamily: SERIF, color: P.ink2, lineHeight: 1.75,
          fontSize: "1.02rem", margin: 0, fontWeight: 380,
        }}>{description}</p>
      </div>
      <div style={{ flex: "1 1 400px", minWidth: 0 }}>
        {visual}
      </div>
    </div>
  );
}

// ── Pipeline data ─────────────────────────────────────────────────────────────
const PIPELINE_STEPS = [
  { label: "Import",   sub: "RIS · MEDLINE · BibTeX" },
  { label: "Dedup",    sub: "5-tier matching" },
  { label: "Overlap",  sub: "Euler + matrix" },
  { label: "Screen",   sub: "TA · FT · AI" },
  { label: "Extract",  sub: "Custom templates" },
  { label: "Thematic", sub: "Code · theme" },
  { label: "Ontology", sub: "2D / 3D graph" },
  { label: "PRISMA",   sub: "Publication-ready" },
];

const PIPELINE_NOTES = [
  "Parse RIS, MEDLINE, and BibTeX from any database with automatic encoding correction.",
  "Union-Find deduplication over five successive strategies: DOI, PMID, title/year/author, and fuzzy similarity.",
  "Quantitative area-proportional Euler diagram and N×N pairwise heatmap across all sources.",
  "Sequential or mixed-mode screening with TA/FT stages, criteria panels, PDF upload, and AI assistance.",
  "Custom extraction templates with structured fields, provenance tracking, and inline editing.",
  "Code-and-theme tree with evidence assignment, history audit trail, and saturation detection.",
  "Interactive 2D (dagre) and 3D (force-directed) concept ontology built from extracted concepts.",
  "Auto-generated PRISMA flow tracking every record from identification to synthesis.",
];

// ── Capability index (typeset as a table of contents) ────────────────────────
const CAPABILITIES = [
  { title: "Multi-format import",  ref: "§ 1.1", desc: "RIS, MEDLINE, BibTeX — automatic encoding detection" },
  { title: "Five-tier dedup",      ref: "§ 1.2", desc: "Union-Find over DOI, PMID, title, fuzzy similarity" },
  { title: "Euler overlap map",    ref: "§ 1.3", desc: "Area-proportional, spring-relaxation layout" },
  { title: "Citation sourcing",    ref: "§ 1.4", desc: "Backward and forward via Semantic Scholar" },
  { title: "TA / FT screening",    ref: "§ 2.1", desc: "Sequential and mixed modes, criteria, labels" },
  { title: "LLM screening",        ref: "§ 2.2", desc: "Claude, GPT, Gemini, or any OpenRouter model" },
  { title: "Consensus & κ",        ref: "§ 2.3", desc: "Inter-rater reliability, adjudication workflow" },
  { title: "Evidence extraction",  ref: "§ 3.1", desc: "Custom templates, inline edit, provenance" },
  { title: "Labels",               ref: "§ 3.2", desc: "Colour-coded tags across records and clusters" },
  { title: "Concept ontology",     ref: "§ 3.3", desc: "2D dagre canvas and 3D force-directed graph" },
  { title: "Thematic analysis",    ref: "§ 3.4", desc: "Code trees, evidence assignment, audit trail" },
  { title: "Saturation badge",     ref: "§ 3.5", desc: "Detects theoretical data saturation automatically" },
  { title: "PDF pipeline",         ref: "§ 4.1", desc: "Upload, view, Unpaywall + DOI + PMC resolution" },
  { title: "PRISMA flow",          ref: "§ 4.2", desc: "Publication-ready SVG and PNG, auto-calculated" },
  { title: "Team invitations",     ref: "§ 4.3", desc: "Token-based invites, per-project roles" },
  { title: "Records browser",      ref: "§ 4.4", desc: "Sortable, filterable, column-configurable" },
];

const PRINCIPLES = [
  {
    numeral: "I", title: "Reproducibility first",
    desc: "Every extraction, synthesis, and decision is traceable. Non-deterministic LLM steps log inputs, model version, and outputs.",
  },
  {
    numeral: "II", title: "Full transparency",
    desc: "Sources, confidence levels, and provenance are always visible. AI contributions are labelled and auditable — never hidden.",
  },
  {
    numeral: "III", title: "AI assists, never decides",
    desc: "LLM components support the workflow. Every AI-assisted step has a human review point. Your judgment stays in control.",
  },
  {
    numeral: "IV", title: "Modular & auditable",
    desc: "Any component can be inspected, replaced, or disabled independently. Audit trails are a first-class feature.",
  },
];

// ── Main component ────────────────────────────────────────────────────────────
export default function LandingPage() {
  const navigate = useNavigate();
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    const iv = setInterval(() => setActiveStep(s => (s + 1) % PIPELINE_STEPS.length), 2200);
    return () => clearInterval(iv);
  }, []);

  const rule = { border: "none", borderTop: `1px solid ${P.line}`, margin: 0 } as const;

  return (
    <div className="lp" style={{
      fontFamily: SERIF, color: P.ink, background: P.paper,
      overflowX: "hidden", minHeight: "100vh",
    }}>
      <style>{PAGE_CSS}</style>

      {/* ── Masthead ── */}
      <nav className="lp-nav" style={{
        position: "sticky", top: 0, zIndex: 100,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 clamp(1.25rem, 4vw, 3rem)", height: 64,
        background: "rgba(245,240,230,0.92)", backdropFilter: "blur(12px)",
        borderBottom: `1px solid ${P.line}`,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{
            fontFamily: SERIF, fontStyle: "italic", fontWeight: 600,
            fontSize: 22, color: P.accent, lineHeight: 1,
          }}>E.</span>
          <span className="lp-nav-brand" style={{
            fontFamily: MONO, fontSize: 13, fontWeight: 500,
            letterSpacing: "0.22em", textTransform: "uppercase", color: P.ink,
          }}>
            Evidence Platform
          </span>
          <span style={{
            fontFamily: MONO, fontSize: 10.5, color: P.ink3,
            letterSpacing: "0.12em", textTransform: "uppercase",
            display: "inline-block",
          }} className="lp-nav-tag">
            · Open-source research infrastructure
          </span>
        </div>
        <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
          <button onClick={() => navigate("/login")} className="lp-textlink lp-nav-signin" style={{ fontSize: 15 }}>
            Sign in
          </button>
          <button onClick={() => navigate("/register")} className="lp-btn lp-btn--ink lp-nav-cta" style={{ padding: "0.6rem 1.3rem" }}>
            Begin a review
          </button>
        </div>
      </nav>

      {/* ── Title page / hero ── */}
      <header style={{
        maxWidth: 1080, margin: "0 auto",
        padding: "clamp(4rem, 9vh, 7rem) clamp(1.25rem, 4vw, 3rem) 4.5rem",
      }}>
        <div className="lp-rise" style={{
          fontFamily: MONO, fontSize: 12.5, color: P.ink3,
          letterSpacing: "0.18em", textTransform: "uppercase",
          display: "flex", alignItems: "center", gap: 16, rowGap: 8,
          flexWrap: "wrap", marginBottom: "2.5rem",
        }}>
          <span style={{ color: P.accent }}>Vol. I</span>
          <span style={{ width: 40, borderTop: `1px solid ${P.line}` }} />
          <span>Systematic evidence synthesis</span>
          <span style={{ width: 40, borderTop: `1px solid ${P.line}` }} />
          <span>From import to publication</span>
        </div>

        <h1 className="lp-rise" style={{
          fontFamily: SERIF,
          fontSize: "clamp(2.6rem, 6.2vw, 4.6rem)",
          fontWeight: 460, lineHeight: 1.06,
          letterSpacing: "-0.015em",
          margin: "0 0 2rem", maxWidth: 900,
          animationDelay: "0.08s",
        }}>
          Ten thousand records.
          <br />
          One <em style={{ fontStyle: "italic", fontWeight: 500, color: P.accent }}>defensible</em> synthesis.
        </h1>

        <p className="lp-rise" style={{
          fontSize: "1.14rem", color: P.ink2, fontWeight: 380,
          maxWidth: 620, lineHeight: 1.78, margin: "0 0 2.75rem",
          animationDelay: "0.16s",
        }}>
          EvidencePlatform carries a literature review from first database export to
          publication-ready PRISMA — import, deduplication, screening, extraction,
          and synthesis — with provenance recorded at every step, and every
          AI contribution labelled and reviewed by you.
        </p>

        <div className="lp-rise" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", animationDelay: "0.24s" }}>
          <button onClick={() => navigate("/register")} className="lp-btn lp-btn--ink">
            Begin a review — free
          </button>
          <span style={{ fontSize: 15, color: P.ink3 }}>
            or <button onClick={() => navigate("/login")} className="lp-textlink">sign in to your projects</button>
          </span>
        </div>

        {/* Fig. 1 — pipeline */}
        <figure className="lp-rise" style={{ margin: "4.5rem 0 0", animationDelay: "0.34s" }}>
          <div style={{
            border: `1px solid ${P.line}`, borderRadius: 3,
            background: P.plate, boxShadow: `4px 4px 0 ${P.lineSoft}`,
            padding: "1.75rem clamp(1rem, 3vw, 2rem) 1.5rem",
          }}>
            <div style={{ display: "flex", overflowX: "auto", paddingBottom: 4 }}>
              {PIPELINE_STEPS.map((step, i) => {
                const active = i === activeStep;
                const done = i < activeStep;
                return (
                  <div key={step.label} style={{ display: "flex", alignItems: "flex-start", flex: "1 0 auto" }}>
                    <div style={{ minWidth: 86, textAlign: "left" }}>
                      <div style={{
                        fontFamily: MONO, fontSize: 20, fontWeight: 400,
                        color: active ? P.accent : done ? P.ink : P.ink3,
                        transition: "color 0.4s",
                      }}>
                        {String(i + 1).padStart(2, "0")}
                      </div>
                      <div style={{
                        marginTop: 6, paddingTop: 8,
                        borderTop: `2px solid ${active ? P.accent : done ? P.ink : P.lineSoft}`,
                        transition: "border-color 0.4s",
                        marginRight: 18,
                      }}>
                        <div style={{
                          fontFamily: MONO, fontSize: 11.5, fontWeight: 500,
                          letterSpacing: "0.1em", textTransform: "uppercase",
                          color: active || done ? P.ink : P.ink3,
                          transition: "color 0.4s",
                        }}>{step.label}</div>
                        <div style={{ fontFamily: MONO, fontSize: 10, color: P.ink3, marginTop: 3 }}>
                          {step.sub}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{
              marginTop: "1.4rem", paddingTop: "1rem",
              borderTop: `1px solid ${P.lineSoft}`,
              fontSize: 15, color: P.ink2, fontStyle: "italic",
              lineHeight: 1.6, minHeight: 44,
            }}>
              <span style={{ fontFamily: MONO, fontStyle: "normal", fontSize: 11.5, color: P.accent, marginRight: 10 }}>
                {String(activeStep + 1).padStart(2, "0")}
              </span>
              {PIPELINE_NOTES[activeStep]}
            </div>
          </div>
          <figcaption style={{
            fontFamily: MONO, fontSize: 11, color: P.ink3,
            marginTop: 10, letterSpacing: "0.04em",
          }}>
            Fig. 1 — The eight-stage evidence pipeline.
          </figcaption>
        </figure>
      </header>

      {/* ── Colophon strip (stats) ── */}
      <div style={{ borderTop: `1px solid ${P.line}`, borderBottom: `1px solid ${P.line}`, background: P.paperHi }}>
        <div style={{
          maxWidth: 1080, margin: "0 auto",
          padding: "0 clamp(1.25rem, 4vw, 3rem)",
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(190px, 42vw), 1fr))",
        }}>
          {[
            { target: 5, suffix: "", label: "deduplication tiers" },
            { target: 8, suffix: "", label: "pipeline stages" },
            { target: 100, suffix: "%", label: "traceable provenance" },
            { target: 0, suffix: "", label: "vendor lock-in" },
          ].map((s) => (
            <div key={s.label} style={{ padding: "1.9rem 1.5rem 1.9rem 0" }}>
              <div style={{ fontFamily: SERIF, fontSize: "2.4rem", fontWeight: 420, color: P.ink, lineHeight: 1 }}>
                <AnimatedCounter target={s.target} suffix={s.suffix} />
              </div>
              <div style={{
                fontFamily: MONO, fontSize: 11, color: P.ink3, marginTop: 8,
                letterSpacing: "0.12em", textTransform: "uppercase",
              }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Numbered sections ── */}
      <section style={{ padding: "6.5rem clamp(1.25rem, 4vw, 3rem)" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", display: "flex", flexDirection: "column", gap: "6.5rem" }}>

          <SpotlightCard
            num="01" tag="Deduplication"
            title="Five matching tiers. No duplicate slips through."
            description="A Union-Find engine runs five successive matching strategies in order of strictness: exact DOI/PMID, title+year+author+volume, title+year+author, title+year, then fuzzy title similarity. Matches are advisory-locked in the background so imports never block. You review clusters, inspect match evidence tier-by-tier, and lock consensus decisions that survive algorithmic reruns."
            visual={<DedupMock />}
          />

          <SpotlightCard
            num="02" tag="Overlap detection" flip
            title="See exactly how your sources overlap — quantitatively."
            description="Not just a Venn diagram: a mathematically area-proportional Euler layout, computed by spring relaxation, so circle areas and intersections represent real record counts. Pair it with the N×N pairwise heatmap to see which database pairs share the most. Link records manually, lock clusters, and replay strategy runs with full history."
            visual={<EulerMock />}
          />

          <SpotlightCard
            num="03" tag="Citation sourcing"
            title="Discover the papers you didn't know to search for."
            description="Starting from your extracted papers, the platform queries Semantic Scholar for every reference each paper cites — and every paper that cites it. Candidates are cross-deduplicated against your existing records, surfaced for review, and imported straight into the normal pipeline: deduplication, overlap detection, and screening included."
            visual={<CitationMock />}
          />

          <SpotlightCard
            num="04" tag="AI-assisted screening" flip
            title="LLM screening, measured against you."
            description="Run screening across your corpus with Claude, GPT, Gemini, or any OpenRouter model. The platform computes model-versus-human agreement — percent agreement and Cohen's κ — and surfaces disagreements in a side-by-side conflict table. Flagged items go to consensus adjudication in one click. Every run records its model, prompts, tokens, and cost."
            visual={<LLMMock />}
          />

          <SpotlightCard
            num="05" tag="Concept ontology"
            title="A living knowledge graph of your field."
            description="Define entity, relation, and metadata namespaces, then map concepts extracted from your papers into a structured ontology. The 2D canvas lets you position and connect nodes precisely; the 3D force-directed view reveals cluster structure at scale. Extract concept instances per paper, aggregate across the corpus, and push consensus values in bulk."
            visual={<OntologyMock />}
          />

          <SpotlightCard
            num="06" tag="Team collaboration" flip
            title="Independent reviewers. Honest disagreement."
            description="Invite co-reviewers by email with token-based activation. Each reviewer screens an isolated queue — no cross-contamination. The platform detects decision conflicts automatically, computes inter-rater reliability per stage, and routes conflicts to the project admin for adjudication. Team statistics update in real time."
            visual={<TeamMock />}
          />

          <SpotlightCard
            num="07" tag="Synthesis & publication"
            title="The PRISMA figure draws itself."
            description="Every record count at every stage is tracked continuously. One click renders a publication-ready PRISMA 2020 flow diagram — source breakdown, exclusion reasons, final synthesis count — exportable as print-resolution PNG or true vector SVG. Alongside it, the saturation tracker signals when consecutive extractions stop yielding new themes."
            visual={<div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
              <PrismaMock />
              <SaturationMock />
            </div>}
          />

        </div>
      </section>

      {/* ── Index of capabilities ── */}
      <section style={{ padding: "0 clamp(1.25rem, 4vw, 3rem) 6.5rem" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto" }}>
          <hr style={rule} />
          <div style={{ padding: "3.5rem 0 2.5rem", display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <h2 style={{
              fontFamily: SERIF, fontSize: "2.1rem", fontWeight: 480,
              letterSpacing: "-0.01em", margin: 0,
            }}>
              Index of capabilities
            </h2>
            <span style={{ fontFamily: MONO, fontSize: 11.5, color: P.ink3, letterSpacing: "0.14em", textTransform: "uppercase" }}>
              Sixteen modules · one audit trail
            </span>
          </div>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(min(440px, 100%), 1fr))",
            columnGap: "4rem",
            borderBottom: `1px solid ${P.lineSoft}`,
          }}>
            {CAPABILITIES.map(f => (
              <div key={f.title} className="lp-index-row" style={{ padding: "0.85rem 0.35rem" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                  <span style={{ fontFamily: SERIF, fontSize: 16.5, fontWeight: 540, color: P.ink, whiteSpace: "nowrap" }}>
                    {f.title}
                  </span>
                  <span style={{
                    flex: 1, borderBottom: `1px dotted ${P.line}`,
                    transform: "translateY(-4px)", minWidth: 24,
                  }} />
                  <span style={{ fontFamily: MONO, fontSize: 11.5, color: P.accent, whiteSpace: "nowrap" }}>
                    {f.ref}
                  </span>
                </div>
                <div style={{ fontSize: 13.5, color: P.ink3, marginTop: 3, fontWeight: 380 }}>
                  {f.desc}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Principles ── */}
      <section style={{ background: P.paperHi, borderTop: `1px solid ${P.line}`, padding: "5.5rem clamp(1.25rem, 4vw, 3rem)" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto" }}>
          <div style={{ marginBottom: "3rem", maxWidth: 560 }}>
            <div style={{ fontFamily: MONO, fontSize: 12, color: P.accent, letterSpacing: "0.16em", textTransform: "uppercase", marginBottom: 14 }}>
              Editorial principles
            </div>
            <h2 style={{ fontFamily: SERIF, fontSize: "2.1rem", fontWeight: 480, margin: "0 0 0.9rem", letterSpacing: "-0.01em" }}>
              The standards that govern good science govern this code.
            </h2>
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
            gap: "2.5rem",
          }}>
            {PRINCIPLES.map(p => (
              <div key={p.numeral} style={{ borderTop: `2px solid ${P.ink}`, paddingTop: "1.1rem" }}>
                <div style={{
                  fontFamily: SERIF, fontStyle: "italic", fontSize: "1.7rem",
                  fontWeight: 480, color: P.accent, marginBottom: 10, lineHeight: 1,
                }}>{p.numeral}.</div>
                <h4 style={{
                  fontFamily: MONO, fontWeight: 500, fontSize: 12.5,
                  letterSpacing: "0.1em", textTransform: "uppercase",
                  margin: "0 0 0.6rem", color: P.ink,
                }}>{p.title}</h4>
                <p style={{ fontSize: 14.5, color: P.ink2, margin: 0, lineHeight: 1.7, fontWeight: 380 }}>
                  {p.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA — ink block ── */}
      <section style={{
        background: P.inkBlock, color: P.cream,
        padding: "7rem clamp(1.25rem, 4vw, 3rem)",
      }}>
        <div style={{ maxWidth: 1080, margin: "0 auto" }}>
          <div style={{
            fontFamily: MONO, fontSize: 12, color: "#9a8f78",
            letterSpacing: "0.18em", textTransform: "uppercase",
            display: "flex", alignItems: "center", gap: 16, rowGap: 8,
            flexWrap: "wrap", marginBottom: "2.25rem",
          }}>
            <span>Free</span>
            <span style={{ width: 40, borderTop: "1px solid #3a332a" }} />
            <span>No lock-in</span>
            <span style={{ width: 40, borderTop: "1px solid #3a332a" }} />
            <span>Open source</span>
          </div>
          <h2 style={{
            fontFamily: SERIF, fontStyle: "italic",
            fontSize: "clamp(2.4rem, 5.5vw, 4rem)",
            fontWeight: 440, letterSpacing: "-0.015em",
            margin: "0 0 1.5rem", lineHeight: 1.12, maxWidth: 760,
          }}>
            Begin your review where it will end: <span style={{ color: "#d98d7c" }}>defensible.</span>
          </h2>
          <p style={{ color: "#a99d84", fontSize: "1.1rem", maxWidth: 520, margin: "0 0 3rem", lineHeight: 1.7, fontWeight: 380 }}>
            One platform for every stage of the literature workflow —
            and an audit trail your reviewers will thank you for.
          </p>
          <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={() => navigate("/register")} className="lp-btn lp-btn--cream">
              Create your account
            </button>
            <button onClick={() => navigate("/login")} className="lp-textlink" style={{ color: "#d98d7c", fontSize: 15, textDecorationColor: "#d98d7c55" }}>
              Sign in
            </button>
          </div>
        </div>
      </section>

      {/* ── Footer colophon ── */}
      <footer style={{
        background: P.inkBlock, color: "#6f6553",
        borderTop: "1px solid #2a251e",
        padding: "1.6rem clamp(1.25rem, 4vw, 3rem)",
        display: "flex", alignItems: "baseline", justifyContent: "space-between",
        flexWrap: "wrap", gap: "0.75rem",
        fontFamily: MONO, fontSize: 11.5, letterSpacing: "0.06em",
      }}>
        <div>
          <span style={{ fontFamily: SERIF, fontStyle: "italic", color: "#d98d7c", marginRight: 10, fontSize: 14 }}>E.</span>
          EVIDENCE PLATFORM — OPEN-SOURCE RESEARCH INFRASTRUCTURE
        </div>
        <div>christelle.xiong.32@gmail.com</div>
        <div style={{ color: "#4f4739" }}>Set in Fraunces &amp; IBM Plex Mono · No warranty expressed or implied</div>
      </footer>

    </div>
  );
}
