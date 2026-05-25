import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

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
          setVal(Math.round((cur / steps) * target));
          if (cur >= steps) clearInterval(iv);
        }, step);
      }
    }, { threshold: 0.3 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [target]);

  return <div ref={ref}>{val.toLocaleString()}{suffix}</div>;
}

// ── Pipeline stage node ───────────────────────────────────────────────────────
function PipelineNode({
  label, sub, color, icon, active,
}: { label: string; sub: string; color: string; icon: string; active: boolean }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      gap: 8, flex: "0 0 auto", width: 100,
      opacity: active ? 1 : 0.45,
      transition: "opacity 0.4s",
    }}>
      <div style={{
        width: 52, height: 52, borderRadius: 14,
        background: active ? color : "#e2e8f0",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 22,
        boxShadow: active ? `0 0 0 3px ${color}30, 0 4px 14px ${color}40` : "none",
        transition: "all 0.4s",
      }}>{icon}</div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: active ? "#0f172a" : "#94a3b8" }}>{label}</div>
        <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 1 }}>{sub}</div>
      </div>
    </div>
  );
}

// ── Feature spotlight card ────────────────────────────────────────────────────
function SpotlightCard({
  tag, title, description, visual, accent, flip,
}: {
  tag: string; title: string; description: string;
  visual: React.ReactNode; accent: string; flip?: boolean;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: flip ? "row-reverse" : "row",
      gap: "3rem", alignItems: "center",
      flexWrap: "wrap",
    }}>
      <div style={{ flex: "1 1 320px", minWidth: 0 }}>
        <span style={{
          display: "inline-block", padding: "0.25rem 0.75rem",
          borderRadius: 999, background: accent + "18", color: accent,
          fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
          textTransform: "uppercase", marginBottom: "0.9rem",
        }}>{tag}</span>
        <h3 style={{
          fontSize: "1.55rem", fontWeight: 800,
          letterSpacing: "-0.4px", color: "#0f172a",
          margin: "0 0 0.85rem", lineHeight: 1.25,
        }}>{title}</h3>
        <p style={{ color: "#475569", lineHeight: 1.7, fontSize: "1rem", margin: 0 }}>{description}</p>
      </div>
      <div style={{ flex: "1 1 380px", minWidth: 0 }}>
        {visual}
      </div>
    </div>
  );
}

// ── Mock card wrapper ─────────────────────────────────────────────────────────
function MockCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "#fff", borderRadius: 16,
      border: "1px solid #e2e8f0",
      boxShadow: "0 8px 32px rgba(0,0,0,0.08)",
      overflow: "hidden",
      ...style,
    }}>
      <div style={{
        background: "#f8fafc", borderBottom: "1px solid #e2e8f0",
        padding: "0.55rem 0.85rem",
        display: "flex", alignItems: "center", gap: 5,
      }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#fca5a5", flexShrink: 0 }} />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#fde68a", flexShrink: 0 }} />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#bbf7d0", flexShrink: 0 }} />
      </div>
      <div style={{ padding: "1.25rem" }}>{children}</div>
    </div>
  );
}

// ── Euler mock visual ─────────────────────────────────────────────────────────
function EulerMock() {
  return (
    <MockCard>
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
    <MockCard>
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
    <MockCard>
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
  const nodes = [
    { id: "cvd", label: "Cardiovascular Disease", x: 160, y: 40, color: "#6366f1", r: 28 },
    { id: "diet", label: "Dietary Pattern", x: 60, y: 120, color: "#10b981", r: 22 },
    { id: "om3", label: "Omega-3", x: 260, y: 120, color: "#10b981", r: 18 },
    { id: "inflam", label: "Inflammation", x: 140, y: 160, color: "#f59e0b", r: 20 },
    { id: "ldl", label: "LDL-C", x: 240, y: 170, color: "#f59e0b", r: 16 },
    { id: "pop", label: "Adults 40-70", x: 70, y: 195, color: "#ef4444", r: 16 },
  ];
  const edges = [
    { x1: 160, y1: 40, x2: 60, y2: 120 },
    { x1: 160, y1: 40, x2: 260, y2: 120 },
    { x1: 160, y1: 40, x2: 140, y2: 160 },
    { x1: 260, y1: 120, x2: 240, y2: 170 },
    { x1: 60, y1: 120, x2: 70, y2: 195 },
    { x1: 140, y1: 160, x2: 240, y2: 170 },
  ];
  return (
    <MockCard>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>Concept Ontology — 2D canvas</div>
        <div style={{ display: "flex", gap: 5 }}>
          {[{ c: "#6366f1", l: "Entity" }, { c: "#10b981", l: "Exposure" }, { c: "#f59e0b", l: "Outcome" }, { c: "#ef4444", l: "Population" }].map(n => (
            <span key={n.l} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9.5, color: "#64748b" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: n.c }} />{n.l}
            </span>
          ))}
        </div>
      </div>
      <svg viewBox="0 0 320 220" style={{ width: "100%", height: "auto", background: "#0f172a", borderRadius: 10 }}>
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>
        {edges.map((e, i) => (
          <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
            stroke="#334155" strokeWidth="1.5" strokeDasharray="4 3" />
        ))}
        {nodes.map(n => (
          <g key={n.id}>
            <circle cx={n.x} cy={n.y} r={n.r + 4} fill={n.color} opacity={0.15} />
            <circle cx={n.x} cy={n.y} r={n.r} fill={n.color} opacity={0.9} />
            <text x={n.x} y={n.y + 1} textAnchor="middle" dominantBaseline="middle"
              fontSize={n.r > 22 ? 9 : 8} fill="#fff" fontWeight="700">
              {n.label.split(" ").map((w, i) => (
                <tspan key={i} x={n.x} dy={i === 0 ? (n.label.includes(" ") ? -5 : 0) : 11}>{w}</tspan>
              ))}
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
    <MockCard>
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
    <MockCard>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 12 }}>
        PRISMA flow — auto-generated
      </div>
      <div style={{ position: "relative" }}>
        <svg viewBox="0 0 340 310" style={{ width: "100%", height: "auto" }}>
          {/* main column arrows */}
          {[0,1,2,3].map(i => (
            <line key={i} x1={120} y1={42 + i*58} x2={120} y2={52 + i*58}
              stroke="#94a3b8" strokeWidth="1.5" markerEnd="url(#arr)" />
          ))}
          <defs>
            <marker id="arr" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="#94a3b8" />
            </marker>
          </defs>
          {/* main boxes */}
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
          {/* side exclusion boxes */}
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
    <MockCard style={{ background: "#0f172a" }}>
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
    <MockCard>
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

// ── Main component ────────────────────────────────────────────────────────────
const PIPELINE_STEPS = [
  { label: "Import", sub: "RIS·MEDLINE·BibTeX", color: "#4f46e5", icon: "📥" },
  { label: "Dedup", sub: "5-tier matching", color: "#7c3aed", icon: "🔗" },
  { label: "Overlap", sub: "Euler + matrix", color: "#0891b2", icon: "⭕" },
  { label: "Screen", sub: "TA · FT · AI", color: "#059669", icon: "📋" },
  { label: "Extract", sub: "Custom templates", color: "#d97706", icon: "🔬" },
  { label: "Ontology", sub: "2D/3D graph", color: "#f59e0b", icon: "🕸️" },
  { label: "Thematic", sub: "Code · theme", color: "#ec4899", icon: "🎨" },
  { label: "PRISMA", sub: "Publication-ready", color: "#16a34a", icon: "📊" },
];

export default function LandingPage() {
  const navigate = useNavigate();
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    const iv = setInterval(() => setActiveStep(s => (s + 1) % PIPELINE_STEPS.length), 1800);
    return () => clearInterval(iv);
  }, []);

  return (
    <div style={{ fontFamily: '"Inter", system-ui, sans-serif', color: "#0f172a", background: "#fff", overflowX: "hidden" }}>

      {/* ── Nav ── */}
      <nav style={{
        position: "sticky", top: 0, zIndex: 100,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 2.5rem", height: 62,
        background: "rgba(255,255,255,0.93)", backdropFilter: "blur(16px)",
        borderBottom: "1px solid #e2e8f0",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            width: 34, height: 34, borderRadius: 9,
            background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontWeight: 900, fontSize: 15, letterSpacing: "-0.5px",
          }}>E</span>
          <div>
            <span style={{ fontWeight: 800, fontSize: 16, letterSpacing: "-0.3px", color: "#0f172a" }}>
              EvidencePlatform
            </span>
            <span style={{
              marginLeft: 8, fontSize: 10.5, fontWeight: 600, color: "#4f46e5",
              background: "#eef2ff", padding: "1px 7px", borderRadius: 99,
            }}>open source</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={() => navigate("/login")}
            style={{
              padding: "0.45rem 1.1rem", borderRadius: 7,
              border: "1px solid #e2e8f0", background: "transparent",
              fontWeight: 600, fontSize: 14, cursor: "pointer", color: "#374151",
            }}>
            Sign in
          </button>
          <button
            onClick={() => navigate("/register")}
            style={{
              padding: "0.45rem 1.25rem", borderRadius: 7,
              border: "none", background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
              fontWeight: 700, fontSize: 14, cursor: "pointer", color: "#fff",
              boxShadow: "0 2px 8px rgba(79,70,229,0.35)",
            }}>
            Get started free →
          </button>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section style={{
        minHeight: "92vh", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        padding: "5rem 1.5rem 4rem",
        background: "radial-gradient(ellipse at 30% 20%, #eef2ff 0%, transparent 55%), radial-gradient(ellipse at 80% 70%, #f0fdf4 0%, transparent 55%), #f8fafc",
        textAlign: "center", position: "relative", overflow: "hidden",
      }}>
        {/* bg grid */}
        <div style={{
          position: "absolute", inset: 0, backgroundImage:
            "linear-gradient(rgba(79,70,229,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(79,70,229,0.04) 1px, transparent 1px)",
          backgroundSize: "40px 40px", pointerEvents: "none",
        }} />

        <div style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "0.35rem 1rem", borderRadius: 999,
          background: "linear-gradient(135deg, #eef2ff, #f0fdf4)",
          border: "1px solid #c7d2fe",
          fontSize: 13, fontWeight: 600, color: "#4f46e5",
          marginBottom: "1.75rem", position: "relative",
        }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#4f46e5" }} />
          End-to-end evidence synthesis · From import to publication
        </div>

        <h1 style={{
          fontSize: "clamp(2.4rem, 5.5vw, 4.2rem)",
          fontWeight: 900, lineHeight: 1.08,
          letterSpacing: "-2px", maxWidth: 840,
          margin: "0 auto 1.4rem",
          color: "#0f172a", position: "relative",
        }}>
          The complete infrastructure<br />
          <span style={{
            background: "linear-gradient(90deg, #4f46e5 0%, #7c3aed 40%, #ec4899 100%)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          }}>
            for systematic reviews
          </span>
        </h1>

        <p style={{
          fontSize: "1.15rem", color: "#475569",
          maxWidth: 640, margin: "0 auto 2.5rem",
          lineHeight: 1.7, position: "relative",
        }}>
          Import from any database, deduplicate with 5-tier matching, screen with AI assistance,
          extract structured evidence, build concept ontologies, and auto-generate publication-ready PRISMA —
          all in one open-source, fully auditable platform.
        </p>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center", position: "relative" }}>
          <button
            onClick={() => navigate("/register")}
            style={{
              padding: "0.9rem 2.25rem", borderRadius: 10,
              border: "none",
              background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
              color: "#fff", fontWeight: 700, fontSize: 16, cursor: "pointer",
              boxShadow: "0 4px 20px rgba(79,70,229,0.45)",
            }}>
            Start your review — it's free
          </button>
          <button
            onClick={() => navigate("/login")}
            style={{
              padding: "0.9rem 2rem", borderRadius: 10,
              border: "1px solid #cbd5e1", background: "#fff",
              color: "#374151", fontWeight: 600, fontSize: 16, cursor: "pointer",
            }}>
            Sign in
          </button>
        </div>

        {/* Pipeline animator */}
        <div style={{
          marginTop: "4rem", position: "relative",
          background: "#fff", borderRadius: 18,
          border: "1px solid #e2e8f0",
          boxShadow: "0 20px 60px rgba(0,0,0,0.09)",
          padding: "2rem 2rem 1.5rem",
          maxWidth: 860, width: "100%",
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "1.5rem" }}>
            8-stage evidence pipeline
          </div>
          <div style={{ display: "flex", gap: 0, alignItems: "flex-start", justifyContent: "space-between", overflowX: "auto" }}>
            {PIPELINE_STEPS.map((step, i) => (
              <div key={step.label} style={{ display: "flex", alignItems: "flex-start" }}>
                <PipelineNode {...step} active={i <= activeStep} />
                {i < PIPELINE_STEPS.length - 1 && (
                  <div style={{
                    width: 20, height: 2, background: i < activeStep ? "#4f46e5" : "#e2e8f0",
                    marginTop: 25, flexShrink: 0, transition: "background 0.4s",
                  }} />
                )}
              </div>
            ))}
          </div>
          <div style={{ marginTop: "1.25rem", padding: "0.75rem 1rem", background: "#f8fafc", borderRadius: 10, textAlign: "left", minHeight: 48 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: PIPELINE_STEPS[activeStep].color }}>
              {PIPELINE_STEPS[activeStep].label}
            </span>
            <span style={{ fontSize: 12, color: "#64748b", marginLeft: 8 }}>
              {[
                "Parse RIS, MEDLINE, and BibTeX from any database with automatic encoding correction",
                "Three-tier Union-Find deduplication matching on DOI, PMID, title/year/author, and fuzzy similarity",
                "Quantitative area-proportional Euler diagram + NxN pairwise heatmap across all sources",
                "Sequential or mixed-mode screening with TA/FT stages, criteria panels, PDF upload, and AI assistance",
                "Custom extraction templates with structured fields, provenance tracking, and inline editing",
                "Interactive 2D (React Flow dagre) and 3D (three.js force-directed) concept ontology builder",
                "Code-and-theme tree with evidence assignment, history audit trail, and saturation detection",
                "Auto-generated PRISMA flow diagram tracking every record from identification to synthesis",
              ][activeStep]}
            </span>
          </div>
        </div>
      </section>

      {/* ── Stats bar ── */}
      <div style={{ background: "linear-gradient(135deg, #1e1b4b, #312e81)", padding: "2.5rem 1.5rem" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", justifyContent: "space-around", flexWrap: "wrap", gap: "1.5rem" }}>
          {[
            { target: 5, suffix: " tiers", label: "Dedup matching levels", color: "#a5b4fc" },
            { target: 8, suffix: " stages", label: "Full pipeline coverage", color: "#6ee7b7" },
            { target: 100, suffix: "%", label: "Traceable provenance", color: "#fde68a" },
            { target: 0, suffix: " deps", label: "Vendor lock-in", color: "#fca5a5" },
          ].map(s => (
            <div key={s.label} style={{ textAlign: "center" }}>
              <div style={{ fontSize: "2.5rem", fontWeight: 900, color: s.color, lineHeight: 1 }}>
                <AnimatedCounter target={s.target} suffix={s.suffix} />
              </div>
              <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 6 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Spotlight sections ── */}
      <section style={{ padding: "6rem 1.5rem", background: "#fff" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto", display: "flex", flexDirection: "column", gap: "6rem" }}>

          {/* 1. Dedup */}
          <SpotlightCard
            tag="Deduplication"
            accent="#4f46e5"
            title="5-tier Union-Find deduplication — no duplicates slip through"
            description="Our three-layer Union-Find engine runs five successive matching strategies in order of strictness: exact DOI/PMID → title+year+author+volume → title+year+author → title+year → fuzzy title similarity (rapidfuzz). Matches are advisory-locked in the background so imports never block. You review clusters, inspect match evidence tier-by-tier, and lock consensus decisions that survive algorithmic reruns."
            visual={<DedupMock />}
          />

          {/* 2. Overlap */}
          <SpotlightCard
            tag="Overlap Detection"
            accent="#0891b2"
            title="Quantitative Euler diagrams show exactly how your sources overlap"
            description="Not just a Venn diagram — a mathematically area-proportional Euler layout computed via spring-relaxation so circle areas and intersections represent real record counts. Pair it with the NxN pairwise heatmap to instantly see which database pairs share the most. Manually link records, lock clusters, and replay strategy runs with full history."
            visual={<EulerMock />}
            flip
          />

          {/* 3. Citation sourcing */}
          <SpotlightCard
            tag="Citation Sourcing — Novel"
            accent="#ec4899"
            title="Discover papers you didn't know to search for"
            description="Starting from your extracted papers, EvidencePlatform queries Semantic Scholar to fetch every reference each paper cites (backward) and every paper that cites it (forward). Candidates are cross-deduplicated against your existing records, surfaced for review, and imported directly into the normal pipeline — deduplication, overlap detection, and screening included. No other systematic review tool does this automatically."
            visual={<CitationMock />}
          />

          {/* 4. LLM screening */}
          <SpotlightCard
            tag="AI-Assisted Screening"
            accent="#7c3aed"
            title="LLM screening with human-in-the-loop comparison and Cohen's κ"
            description="Run screening across your corpus with Claude, GPT-4, Gemini, or any OpenRouter model. The platform computes LLM-vs-human agreement statistics (percent agreement and Cohen's κ) and surfaces disagreements in a side-by-side conflict table. Send flagged items directly to consensus adjudication with one click. Your research question, custom prompt additions, and glossary are versioned per run."
            visual={<LLMMock />}
            flip
          />

          {/* 5. Ontology */}
          <SpotlightCard
            tag="Concept Ontology"
            accent="#f59e0b"
            title="Build a living knowledge graph — 2D canvas and 3D force graph"
            description="Define entity, relation, and metadata namespaces, then map concepts extracted from your papers into a structured ontology. The 2D canvas (React Flow + dagre layout) lets you position and connect nodes precisely. The 3D view (three.js force-directed graph) reveals cluster structure at scale. Extract concept instances per paper, aggregate across the corpus, and push consensus values to the ontology in bulk."
            visual={<OntologyMock />}
          />

          {/* 6. Team + consensus */}
          <SpotlightCard
            tag="Team Collaboration"
            accent="#059669"
            title="Dual-reviewer isolation, conflict detection, and Cohen's κ"
            description="Invite co-reviewers by email with token-based activation. Each reviewer sees independent screening queues — no cross-contamination. The platform detects decision conflicts automatically, computes inter-rater reliability (Cohen's κ) per stage, and routes conflicts to the project admin for adjudication. Team screening stats update in real time."
            visual={<TeamMock />}
            flip
          />

          {/* 7. PRISMA + saturation */}
          <SpotlightCard
            tag="Synthesis & Publication"
            accent="#16a34a"
            title="Auto-generated PRISMA flow + data saturation detection"
            description="Every record count at every pipeline stage is tracked continuously. Click 'PRISMA' to render a publication-ready flow diagram with source breakdown, exclusion reasons, and final synthesis count — no manual counting. Simultaneously, the saturation badge tracks consecutive extractions with no new themes and signals when your data has reached theoretical saturation."
            visual={<div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <PrismaMock />
              <SaturationMock />
            </div>}
          />

        </div>
      </section>

      {/* ── All features grid ── */}
      <section style={{ padding: "5rem 1.5rem", background: "#f8fafc" }}>
        <div style={{ maxWidth: 960, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: "3rem" }}>
            <h2 style={{ fontSize: "2rem", fontWeight: 800, letterSpacing: "-0.5px", margin: "0 0 0.75rem" }}>
              Every tool your review needs
            </h2>
            <p style={{ color: "#475569", fontSize: "1.05rem", maxWidth: 540, margin: "0 auto" }}>
              Every module is built on the same principles: reproducible, auditable, and traceable from raw import to final synthesis.
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "1rem" }}>
            {[
              { icon: "📥", title: "Multi-format Import", desc: "RIS, MEDLINE, BibTeX — auto-encoding detection", color: "#4f46e5" },
              { icon: "🔗", title: "5-Tier Dedup", desc: "Union-Find with DOI, PMID, title, fuzzy", color: "#7c3aed" },
              { icon: "⭕", title: "Euler Overlap Map", desc: "Area-proportional, spring-relaxation layout", color: "#0891b2" },
              { icon: "📡", title: "Citation Sourcing", desc: "Backward + forward via Semantic Scholar", color: "#ec4899" },
              { icon: "📋", title: "TA / FT Screening", desc: "Sequential & mixed modes, criteria, labels", color: "#059669" },
              { icon: "🤖", title: "LLM Screening", desc: "Claude, GPT-4, Gemini, any OpenRouter model", color: "#6366f1" },
              { icon: "⚖️", title: "Consensus & κ", desc: "Inter-rater reliability, adjudication workflow", color: "#d97706" },
              { icon: "🔬", title: "Evidence Extraction", desc: "Custom templates, inline edit, provenance", color: "#f59e0b" },
              { icon: "🏷️", title: "Labels", desc: "Color-coded tags across records and clusters", color: "#ef4444" },
              { icon: "🕸️", title: "Concept Ontology", desc: "2D dagre canvas + 3D force-directed graph", color: "#f97316" },
              { icon: "🎨", title: "Thematic Analysis", desc: "Code trees, evidence assignment, audit trail", color: "#ec4899" },
              { icon: "📈", title: "Saturation Badge", desc: "Detects theoretical data saturation automatically", color: "#8b5cf6" },
              { icon: "📄", title: "PDF Pipeline", desc: "Upload, view, Unpaywall + DOI + PMC links", color: "#0369a1" },
              { icon: "📊", title: "PRISMA Flow", desc: "Publication-ready SVG, auto-calculated", color: "#16a34a" },
              { icon: "👥", title: "Team Invitations", desc: "Token-based invite, role management", color: "#059669" },
              { icon: "🔍", title: "Records Browser", desc: "Sortable, filterable, column-configurable", color: "#475569" },
            ].map(f => (
              <div key={f.title} style={{
                background: "#fff", borderRadius: 12,
                border: "1px solid #e2e8f0",
                padding: "1.25rem 1.1rem",
                transition: "transform 0.15s, box-shadow 0.15s",
                cursor: "default",
              }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLDivElement).style.transform = "translateY(-3px)";
                  (e.currentTarget as HTMLDivElement).style.boxShadow = `0 8px 24px ${f.color}20`;
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLDivElement).style.transform = "translateY(0)";
                  (e.currentTarget as HTMLDivElement).style.boxShadow = "none";
                }}
              >
                <div style={{ fontSize: 24, marginBottom: 8 }}>{f.icon}</div>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: "#0f172a", marginBottom: 4 }}>{f.title}</div>
                <div style={{ fontSize: 12.5, color: "#64748b", lineHeight: 1.5 }}>{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Designed for researchers ── */}
      <section style={{ padding: "5rem 1.5rem", background: "#fff" }}>
        <div style={{ maxWidth: 860, margin: "0 auto", textAlign: "center" }}>
          <h2 style={{ fontSize: "1.9rem", fontWeight: 800, letterSpacing: "-0.5px", marginBottom: "0.75rem" }}>
            Built on four non-negotiable principles
          </h2>
          <p style={{ color: "#475569", fontSize: "1.05rem", marginBottom: "3rem", maxWidth: 540, margin: "0 auto 3rem" }}>
            The same standards that govern good science govern this codebase.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "1.25rem" }}>
            {[
              {
                icon: "🔁", title: "Reproducibility first",
                desc: "Every extraction, synthesis, and decision is traceable. Non-deterministic LLM steps log inputs, model version, and outputs.",
                color: "#4f46e5",
              },
              {
                icon: "🔍", title: "Full transparency",
                desc: "Sources, confidence levels, and provenance are always visible. AI contributions are labeled and auditable — never hidden.",
                color: "#059669",
              },
              {
                icon: "🤝", title: "AI assists, never decides",
                desc: "LLM components support researchers. Every AI-assisted step has a human review point. Scientific judgment stays with you.",
                color: "#d97706",
              },
              {
                icon: "🧩", title: "Modular & open",
                desc: "Any component can be inspected, replaced, or disabled independently. Open-source, MIT-licensed, designed to be forked.",
                color: "#ec4899",
              },
            ].map(p => (
              <div key={p.title} style={{
                textAlign: "left", padding: "1.4rem",
                background: "#f8fafc", borderRadius: 14,
                border: "1px solid #e2e8f0",
              }}>
                <div style={{
                  width: 42, height: 42, borderRadius: 11,
                  background: p.color + "18", fontSize: 20,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  marginBottom: 12,
                }}>{p.icon}</div>
                <h4 style={{ fontWeight: 700, fontSize: 14, margin: "0 0 6px", color: "#0f172a" }}>{p.title}</h4>
                <p style={{ fontSize: 13, color: "#64748b", margin: 0, lineHeight: 1.6 }}>{p.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section style={{
        padding: "6rem 1.5rem",
        background: "radial-gradient(ellipse at 30% 40%, #312e81 0%, #1e1b4b 60%, #0f172a 100%)",
        textAlign: "center", position: "relative", overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", inset: 0,
          backgroundImage: "linear-gradient(rgba(99,102,241,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.05) 1px, transparent 1px)",
          backgroundSize: "50px 50px", pointerEvents: "none",
        }} />
        <div style={{ position: "relative" }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 7,
            padding: "0.3rem 0.9rem", borderRadius: 999,
            background: "rgba(99,102,241,0.2)", border: "1px solid rgba(99,102,241,0.4)",
            fontSize: 12.5, fontWeight: 600, color: "#a5b4fc",
            marginBottom: "1.5rem",
          }}>
            Free · Open source · Built at Johns Hopkins
          </div>
          <h2 style={{
            fontSize: "clamp(2rem, 4.5vw, 3.2rem)",
            fontWeight: 900, color: "#fff",
            margin: "0 auto 1rem", maxWidth: 660,
            letterSpacing: "-1px", lineHeight: 1.15,
          }}>
            Start your systematic review today
          </h2>
          <p style={{ color: "#94a3b8", fontSize: "1.1rem", maxWidth: 500, margin: "0 auto 2.5rem" }}>
            No credit card. No lock-in. Just open infrastructure that lets you focus on the science.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => navigate("/register")}
              style={{
                padding: "1rem 2.5rem", borderRadius: 10,
                border: "none",
                background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                color: "#fff", fontWeight: 700, fontSize: 16, cursor: "pointer",
                boxShadow: "0 4px 20px rgba(99,102,241,0.5)",
              }}>
              Create your free account
            </button>
            <button
              onClick={() => navigate("/login")}
              style={{
                padding: "1rem 2rem", borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.2)", background: "transparent",
                color: "#e2e8f0", fontWeight: 600, fontSize: 16, cursor: "pointer",
              }}>
              Sign in
            </button>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer style={{
        background: "#0f172a", color: "#475569",
        padding: "1.75rem 2.5rem",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexWrap: "wrap", gap: "0.75rem", fontSize: 13,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{
            width: 26, height: 26, borderRadius: 7,
            background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontWeight: 900, fontSize: 12,
          }}>E</span>
          <span style={{ color: "#94a3b8", fontWeight: 600, letterSpacing: "-0.2px" }}>EvidencePlatform</span>
        </div>
        <div style={{ display: "flex", gap: "1.5rem", color: "#475569" }}>
          <span>Open-source</span>
          <span>·</span>
          <span>Evidence synthesis infrastructure</span>
          <span>·</span>
          <span>Built at JHU</span>
        </div>
        <div style={{ color: "#334155", fontSize: 12 }}>
          MIT License · No warranty expressed or implied
        </div>
      </footer>

    </div>
  );
}
