/**
 * OnboardingTour — animated walkthrough with spotlight pointing to the relevant
 * sidebar element for each step.
 *
 * When inside a project, each step finds its [data-tour] nav link in the DOM,
 * draws a spotlight cutout over it, and shows a bouncing pointer emoji.
 * On the /projects page (no project selected) the spotlight is omitted and
 * only the "Find it" badge inside the card acts as the indicator.
 *
 * Dismissed permanently when the user clicks "Get started", ✕, or the backdrop.
 * localStorage key: "ep_tour_done".
 * Re-trigger: Profile menu → Tutorial (clears the key and reloads the page).
 */
import { useState, useEffect } from "react";
import {
  Upload, GitMerge, CheckSquare, FlaskConical, Tag, Users,
  SearchCode, X, ArrowRight, ArrowLeft, Layers,
} from "lucide-react";

// ── Animation keyframes injected as a <style> tag ─────────────────────────

const ANIM_CSS = `
@keyframes epTourSlideIn {
  from { opacity: 0; transform: translate(-50%, -44%); }
  to   { opacity: 1; transform: translate(-50%, -50%); }
}
@keyframes epIconPop {
  0%   { transform: scale(0.65) rotate(-8deg); opacity: 0; }
  65%  { transform: scale(1.10) rotate(3deg);  opacity: 1; }
  100% { transform: scale(1)    rotate(0deg);  opacity: 1; }
}
@keyframes epRingPulse {
  0%, 100% { opacity: 1;   transform: scale(1);     }
  50%       { opacity: 0.5; transform: scale(1.025); }
}
@keyframes epArrowPing {
  0%, 100% { opacity: 1;   transform: translateY(-50%) translateX(0);     }
  50%       { opacity: 0.5; transform: translateY(-50%) translateX(-10px); }
}
`;

// ── Mascot SVGs ───────────────────────────────────────────────────────────

function WelcomeSVG() {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
      <rect x="5" y="3" width="18" height="22" rx="3" fill="white" fillOpacity=".92" />
      <rect x="8.5" y="8"    width="11" height="1.8" rx=".9"  fill="#4f46e5" fillOpacity=".75" />
      <rect x="8.5" y="12"   width="9"  height="1.5" rx=".75" fill="#4f46e5" fillOpacity=".5"  />
      <rect x="8.5" y="15.5" width="10" height="1.5" rx=".75" fill="#4f46e5" fillOpacity=".5"  />
      <circle cx="21" cy="21" r="5.5" fill="#818cf8" />
      <circle cx="21" cy="21" r="3.5" fill="white" fillOpacity=".35" />
      <line x1="24" y1="24" x2="27" y2="27" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function ReadySVG() {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
      <circle cx="15" cy="15" r="12" fill="white" fillOpacity=".25" />
      <circle cx="15" cy="15" r="9"  fill="white" fillOpacity=".2"  />
      <path d="M10 15 l3.5 3.5 6.5-7" stroke="white" strokeWidth="2.8"
            strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6"  cy="6"  r="1.3" fill="white" fillOpacity=".7" />
      <circle cx="24" cy="5"  r="1.1" fill="white" fillOpacity=".6" />
      <circle cx="26" cy="16" r=".9"  fill="white" fillOpacity=".5" />
      <circle cx="4"  cy="20" r=".8"  fill="white" fillOpacity=".5" />
    </svg>
  );
}

// ── Step definitions ──────────────────────────────────────────────────────

interface Step {
  icon: React.ReactNode;
  color: string;
  title: string;
  desc: string;
  bullets: { emoji: string; text: string }[];
  /** data-tour attribute on the sidebar nav link to spotlight */
  tourTarget?: string;
  /** Human-readable nav label shown in the "Find it" badge */
  navLabel?: string;
}

const STEPS: Step[] = [
  {
    color: "#4f46e5",
    icon: <WelcomeSVG />,
    title: "Welcome to EvidencePlatform",
    desc: "A structured workspace for systematic evidence synthesis — from raw literature imports all the way to thematic codebooks and ontology building. This tour shows where each module lives.",
    bullets: [
      { emoji: "🔄", text: "Complete pipeline: Import → Overlap → Screen → Extract → Synthesise" },
      { emoji: "📋", text: "Every decision is logged, auditable, and reproducible" },
      { emoji: "🤝", text: "Multi-reviewer collaboration with Cohen's κ reliability scoring" },
    ],
  },
  {
    color: "#3b82f6",
    icon: <Upload size={26} color="white" />,
    title: "1 · Import your literature",
    desc: "Upload RIS, MEDLINE, or BibTeX files from PubMed, Embase, Cochrane, and more. Within-source deduplication runs automatically after each import.",
    tourTarget: "import",
    navLabel: "Import",
    bullets: [
      { emoji: "📂", text: "Formats: RIS · MEDLINE · BibTeX — drag & drop or file picker" },
      { emoji: "🔍", text: "Automatic within-source dedup — no manual step needed" },
      { emoji: "📜", text: "Full import history with record-level provenance" },
    ],
  },
  {
    color: "#7c3aed",
    icon: <GitMerge size={26} color="white" />,
    title: "2 · Resolve cross-source overlaps",
    desc: "Same paper in multiple databases? The platform clusters duplicates using a 5-tier strategy (DOI → PMID → Title+Author → Fuzzy). An Euler diagram shows source overlap at a glance.",
    tourTarget: "overlap",
    navLabel: "Overlap",
    bullets: [
      { emoji: "🎯", text: "5-tier matching: DOI → PMID → Title+Year+Author → Fuzzy" },
      { emoji: "📊", text: "Euler diagram + pairwise matrix for source-level insight" },
      { emoji: "🔒", text: "Manually link or lock clusters to protect reviewed groups" },
    ],
  },
  {
    color: "#059669",
    icon: <CheckSquare size={26} color="white" />,
    title: "3 · Screen articles",
    desc: "Work through title/abstract then full-text screening. Your criteria appear in a collapsible panel. Include / Exclude buttons always stick to the bottom of the screen.",
    tourTarget: "screening",
    navLabel: "Screening",
    bullets: [
      { emoji: "⚡", text: "Sequential (TA → FT → Extract) or mixed mode" },
      { emoji: "🎯", text: "Pin your most-used exclusion reasons for one-click exclusion" },
      { emoji: "📄", text: "Full-text links via Unpaywall, PMC, PubMed, and DOI" },
    ],
  },
  {
    color: "#0891b2",
    icon: <FlaskConical size={26} color="white" />,
    title: "4 · Extract structured evidence",
    desc: "For each included study, capture populations, interventions, outcomes, and key findings. The saturation badge tracks when your codebook is stabilising.",
    tourTarget: "extractions",
    navLabel: "Extractions",
    bullets: [
      { emoji: "🗂️", text: "Flexible schema — adapt extraction fields to your framework" },
      { emoji: "📈", text: "Saturation badge: gray → yellow → orange → red" },
      { emoji: "🔬", text: "Extraction Library — search & filter all extracted papers" },
    ],
  },
  {
    color: "#0284c7",
    icon: <SearchCode size={26} color="white" />,
    title: "5 · Discover more via citation sourcing",
    desc: "Citation Search finds additional relevant papers via backward sourcing (reference lists) and forward sourcing (citing papers), powered by Semantic Scholar.",
    tourTarget: "citations",
    navLabel: "Citation Search",
    bullets: [
      { emoji: "⬅️", text: "Backward sourcing — fetches reference lists of included papers" },
      { emoji: "➡️", text: "Forward sourcing — fetches papers that cite included papers" },
      { emoji: "♻️", text: "Run multiple iterations — each new cohort seeds the next" },
    ],
  },
  {
    color: "#e11d48",
    icon: <Tag size={26} color="white" />,
    title: "6 · Label articles",
    desc: "Create colour-coded labels ('RCT', 'Low quality', 'Policy-relevant') and assign them at any stage. The Labels page shows per-label counts and filtered article lists.",
    tourTarget: "labels",
    navLabel: "Labels",
    bullets: [
      { emoji: "🎨", text: "Custom names with a colour palette picker" },
      { emoji: "✏️", text: "Assign labels from the screening workspace or extraction panel" },
      { emoji: "📊", text: "Labels page: filter articles by label with stats at a glance" },
    ],
  },
  {
    color: "#7c3aed",
    icon: <Layers size={26} color="white" />,
    title: "7 · Build concepts & themes",
    desc: "Extract named entities and relationships in the Concept Taxonomy. Then build a Thematic codebook — assign codes to evidence excerpts and push key concepts to the shared Ontology.",
    tourTarget: "concepts",
    navLabel: "Concepts / Thematic",
    bullets: [
      { emoji: "🧩", text: "Concept fields: entities, relations, metadata — per-reviewer then aggregated" },
      { emoji: "🌳", text: "Thematic codebook: theme tree with full edit history" },
      { emoji: "🔗", text: "Push concepts to the Ontology for cross-project reuse" },
    ],
  },
  {
    color: "#475569",
    icon: <Users size={26} color="white" />,
    title: "8 · Collaborate with your team",
    desc: "Invite co-reviewers by token, assign roles, and screen in parallel. Each reviewer's decisions are stored independently. The Consensus page surfaces disagreements and computes Cohen's κ.",
    tourTarget: "team",
    navLabel: "Team / Consensus",
    bullets: [
      { emoji: "📧", text: "Invite by token → role-based access (owner / admin / reviewer)" },
      { emoji: "⚔️", text: "Conflict detection — auto-flags disagreeing TA or FT decisions" },
      { emoji: "📐", text: "Cohen's κ per reviewer pair, per stage, per project" },
    ],
  },
  {
    color: "#4f46e5",
    icon: <ReadySVG />,
    title: "You're all set!",
    desc: "Create your first project and follow the workflow. Every module lives in the project sidebar. Restart this tour anytime from your profile menu at the bottom-left.",
    bullets: [
      { emoji: "🚀", text: "Click \"New project\" on the Projects page to begin" },
      { emoji: "📌", text: "The sidebar gives one-click access to every module" },
      { emoji: "🔁", text: "Restart: profile menu (bottom-left) → Tutorial" },
    ],
  },
];

// ── Main component ────────────────────────────────────────────────────────

interface Rect { left: number; top: number; width: number; height: number }

export default function OnboardingTour({ onDone }: { onDone: () => void }) {
  const [step, setStep]           = useState(0);
  const [animKey, setAnimKey]     = useState(0);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);

  const current = STEPS[step];
  const isLast  = step === STEPS.length - 1;
  const color   = current.color;
  const pad     = 7; // spotlight padding in px

  // Measure the highlighted nav link whenever the step changes
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
    setAnimKey((k) => k + 1);
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

      {/* ── Transparent backdrop — click to dismiss ── */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 9980, cursor: "pointer" }}
        onClick={dismiss}
        aria-label="Close tour"
      />

      {/* ── Dark overlay with spotlight cutout (box-shadow trick).
          When sr is set, the transparent div + huge box-shadow creates a
          dark overlay everywhere EXCEPT the highlighted nav item area.
          When sr is null, a simple opaque overlay covers the whole screen. ── */}
      {sr ? (
        <div style={{
          position:     "fixed",
          left:         sr.left  - pad,
          top:          sr.top   - pad,
          width:        sr.width  + pad * 2,
          height:       sr.height + pad * 2,
          borderRadius: 10,
          background:   "transparent",
          boxShadow:    "0 0 0 9999px rgba(10,14,26,0.78)",
          zIndex:       9981,
          pointerEvents: "none",
        }} />
      ) : (
        <div style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.72)", zIndex: 9981, pointerEvents: "none" }} />
      )}

      {/* ── Pulsing ring around the spotlight ── */}
      {sr && (
        <div style={{
          position:     "fixed",
          left:         sr.left  - pad - 2,
          top:          sr.top   - pad - 2,
          width:        sr.width  + (pad + 2) * 2,
          height:       sr.height + (pad + 2) * 2,
          borderRadius: 12,
          border:       `2.5px solid ${color}`,
          boxShadow:    `0 0 14px 5px ${color}44`,
          zIndex:       9982,
          pointerEvents: "none",
          animation:    "epRingPulse 1.8s ease-in-out infinite",
        }} />
      )}

      {/* ── Bouncing 👈 pointer to the right of the spotlight ── */}
      {sr && (
        <div style={{
          position:     "fixed",
          left:         sr.left + sr.width + pad + 10,
          top:          sr.top  + sr.height / 2,
          fontSize:     "1.45rem",
          lineHeight:   1,
          zIndex:       9983,
          pointerEvents: "none",
          animation:    "epArrowPing 0.85s ease-in-out infinite",
          transform:    "translateY(-50%)",
          userSelect:   "none",
        }}>
          👈
        </div>
      )}

      {/* ── Tour card ── */}
      <div
        key={animKey}
        style={{
          position:     "fixed",
          top:          "50%",
          left:         "50%",
          transform:    "translate(-50%, -50%)",
          width:        "min(92vw, 460px)",
          background:   "#ffffff",
          borderRadius: 18,
          boxShadow:    "0 24px 64px rgba(0,0,0,0.28), 0 4px 16px rgba(0,0,0,0.1)",
          overflow:     "hidden",
          zIndex:       9990,
          animation:    "epTourSlideIn 0.32s cubic-bezier(0.22,1,0.36,1) both",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hero */}
        <div style={{
          padding:        "1.5rem 1.5rem 0.95rem",
          background:     `linear-gradient(145deg, ${color}18 0%, #f8fafc 100%)`,
          borderBottom:   `3px solid ${color}1a`,
          position:       "relative",
          display:        "flex",
          flexDirection:  "column",
          alignItems:     "center",
          gap:            "0.6rem",
          textAlign:      "center",
        }}>
          <button
            onClick={dismiss}
            style={{ position: "absolute", top: 10, right: 10, background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 4, borderRadius: 6, display: "flex", alignItems: "center" }}
            title="Skip tour"
          >
            <X size={16} />
          </button>

          {step > 0 && step < STEPS.length - 1 && (
            <div style={{ position: "absolute", top: 13, left: 14, fontSize: "0.67rem", fontWeight: 700, color: `${color}99`, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {step} / {STEPS.length - 2}
            </div>
          )}

          <div style={{
            width:        58,
            height:       58,
            borderRadius: 14,
            background:   color,
            boxShadow:    `0 6px 18px ${color}55`,
            display:      "flex",
            alignItems:   "center",
            justifyContent: "center",
            flexShrink:   0,
            animation:    "epIconPop 0.5s cubic-bezier(0.22,1,0.36,1) both",
          }}>
            {current.icon}
          </div>

          <h2 style={{ margin: 0, color: "#0f172a", fontSize: "1.08rem", fontWeight: 700, lineHeight: 1.35 }}>
            {current.title}
          </h2>
        </div>

        {/* Body */}
        <div style={{ padding: "0.85rem 1.4rem 0.4rem" }}>
          <p style={{ margin: "0 0 0.65rem", fontSize: "0.85rem", color: "#475569", lineHeight: 1.65 }}>
            {current.desc}
          </p>

          {/* "Find it" badge */}
          {current.navLabel && (
            <div style={{
              display:       "inline-flex",
              alignItems:    "center",
              gap:           "0.35rem",
              background:    `${color}12`,
              border:        `1.5px solid ${color}35`,
              borderRadius:  9999,
              padding:       "0.27rem 0.75rem 0.27rem 0.55rem",
              marginBottom:  "0.65rem",
              fontSize:      "0.74rem",
              fontWeight:    700,
              color:         color,
            }}>
              <span style={{ fontSize: "0.85rem" }}>📍</span>
              Sidebar → {current.navLabel}
            </div>
          )}

          {/* Feature bullets */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.36rem" }}>
            {current.bullets.map((b, i) => (
              <div key={i} style={{
                display:    "flex",
                alignItems: "flex-start",
                gap:        "0.52rem",
                padding:    "0.36rem 0.6rem",
                background: "#f8fafc",
                borderRadius: 8,
                border:     "1px solid #f1f5f9",
              }}>
                <span style={{ fontSize: "0.9rem", lineHeight: "1.45", flexShrink: 0 }}>{b.emoji}</span>
                <span style={{ fontSize: "0.8rem", color: "#334155", lineHeight: 1.55 }}>{b.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-between",
          padding:        "0.62rem 1.4rem 0.88rem",
        }}>
          {/* Progress dots */}
          <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => go(i)}
                title={`Step ${i + 1}`}
                style={{
                  padding:    0,
                  border:     "none",
                  cursor:     "pointer",
                  height:     7,
                  width:      i === step ? 22 : 7,
                  borderRadius: 9999,
                  background: i === step ? color : "#e2e8f0",
                  transition: "width 0.22s ease, background 0.22s ease",
                  flexShrink: 0,
                }}
              />
            ))}
          </div>

          {/* Prev / Next buttons */}
          <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
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
