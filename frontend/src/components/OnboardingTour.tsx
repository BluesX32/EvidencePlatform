/**
 * OnboardingTour — a multi-step welcome walkthrough shown once to new users.
 *
 * Shown when localStorage key "ep_tour_done" is absent.
 * Dismissed permanently when the user clicks "Get started" or the ✕ button.
 * Each step includes a "where to find it" breadcrumb to orient the user.
 */
import { useState } from "react";
import {
  Upload, GitMerge, CheckSquare, FlaskConical, Tag, Users, Layers,
  FileText, X, ArrowRight, ArrowLeft, MapPin,
} from "lucide-react";

interface Step {
  icon: React.ReactNode;
  title: string;
  description: string;
  features: { color: string; text: string }[];
  where?: { label: string; color: string }[];
}

const STEPS: Step[] = [
  {
    icon: (
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill="white" fillOpacity=".15" />
        <path d="M8 10h16M8 16h10M8 22h13" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="24" cy="22" r="5" fill="#818cf8" />
        <path d="M21.5 22l2 2 3-3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    title: "Welcome to EvidencePlatform",
    description:
      "A systematic, reproducible workspace for evidence synthesis. " +
      "Follow this tour to see how the platform guides your review from raw imports all the way to thematic synthesis.",
    features: [
      { color: "#4f46e5", text: "Structured workflow — Import → Overlap → Screen → Extract → Synthesise" },
      { color: "#059669", text: "Every decision is logged, auditable, and reproducible" },
      { color: "#d97706", text: "AI assistance at every step — humans stay in control" },
    ],
  },
  {
    icon: <Upload size={32} color="white" />,
    title: "1 · Import your literature",
    description:
      "Upload RIS, MEDLINE, or BibTeX files exported from PubMed, Embase, Cochrane, or any other database. " +
      "The platform parses, normalises, and stores every record. Within-source deduplication runs automatically after each import.",
    features: [
      { color: "#4f46e5", text: "Supported formats: RIS · MEDLINE · BibTeX" },
      { color: "#059669", text: "Deduplication runs automatically — no manual step needed" },
      { color: "#0284c7", text: "Full import history with record-level provenance" },
    ],
    where: [
      { label: "Project Overview", color: "#3b82f6" },
      { label: "Records (blue card)", color: "#3b82f6" },
    ],
  },
  {
    icon: <GitMerge size={32} color="white" />,
    title: "2 · Resolve cross-source overlaps",
    description:
      "When the same paper appears across multiple databases, the platform groups them into clusters using a " +
      "5-tier strategy (DOI → PMID → Title+Author → Fuzzy). " +
      "An Euler diagram visualises source overlap at a glance. Confirm and lock clusters you've reviewed.",
    features: [
      { color: "#4f46e5", text: "5-tier matching: DOI → PMID → Title+Year+Author → Fuzzy" },
      { color: "#059669", text: "Euler diagram + pairwise matrix for source-level insight" },
      { color: "#d97706", text: "Manual link / lock clusters to protect reviewed groups" },
    ],
    where: [
      { label: "Project Overview", color: "#7c3aed" },
      { label: "Overlap (violet card)", color: "#7c3aed" },
    ],
  },
  {
    icon: <CheckSquare size={32} color="white" />,
    title: "3 · Screen articles",
    description:
      "Work through title/abstract screening, then full-text review. " +
      "Your inclusion/exclusion criteria are shown in a collapsible panel while you screen. " +
      "The decision bar sticks to the bottom of the screen so Include / Exclude buttons are always reachable regardless of abstract length.",
    features: [
      { color: "#4f46e5", text: "Sequential mode (TA → FT → Extract) or mixed mode" },
      { color: "#059669", text: "⚡ Quick-exclude shortcuts — pin your most-used reasons (e.g. 'Not disease severity') so one click excludes instantly; click ⚙ to change which reasons are pinned" },
      { color: "#0284c7", text: "Full-text links via Unpaywall, PMC, PubMed, and DOI" },
    ],
    where: [
      { label: "Project Overview", color: "#059669" },
      { label: "Screening (green card)", color: "#059669" },
    ],
  },
  {
    icon: <FileText size={32} color="white" />,
    title: "4 · Read & annotate PDFs",
    description:
      "Upload the full-text PDF for any record. A floating viewer opens during the full-text screening stage. " +
      "Draw on the PDF with the pen tool, erase mistakes, and — in Select mode — " +
      "highlight any passage to attach a persistent annotation note. " +
      "Highlights stay visible across sessions; clicking one jumps straight to the note.",
    features: [
      { color: "#4f46e5", text: "Pen + eraser tools — drawings saved to the server" },
      { color: "#059669", text: "Select text → add note → yellow highlight persists on PDF" },
      { color: "#0284c7", text: "Notes drawer shows all annotations with page jump links" },
    ],
    where: [
      { label: "Screening Workspace", color: "#0284c7" },
      { label: "Full-text stage", color: "#0284c7" },
      { label: "📄 PDF panel (top right)", color: "#0284c7" },
    ],
  },
  {
    icon: <FlaskConical size={32} color="white" />,
    title: "5 · Extract structured evidence",
    description:
      "For each included study, capture structured data: populations, interventions, outcomes, " +
      "study design, and key findings. " +
      "The saturation badge tracks consecutive papers with no new concepts — " +
      "a progress indicator that tells you when your codebook is stabilising.",
    features: [
      { color: "#4f46e5", text: "Flexible JSONB schema — adapt levels to your framework" },
      { color: "#059669", text: "Saturation badge: gray → yellow → orange → red as coverage grows" },
      { color: "#d97706", text: "Extraction Library aggregates all extractions with search + filter" },
    ],
    where: [
      { label: "Project Overview", color: "#0891b2" },
      { label: "Extractions (cyan card)", color: "#0891b2" },
    ],
  },
  {
    icon: <Layers size={32} color="white" />,
    title: "6 · Build a thematic codebook",
    description:
      "Create themes and sub-codes, assign them to extracted evidence segments, " +
      "and review all passages coded under any given concept. " +
      "Every codebook change is timestamped and logged so your analytical trail remains intact.",
    features: [
      { color: "#4f46e5", text: "CRUD theme + code tree with full edit history" },
      { color: "#059669", text: "Assign codes to extracted evidence excerpts" },
      { color: "#0284c7", text: "Click any code to see every passage it covers" },
    ],
    where: [
      { label: "Project Overview", color: "#0d9488" },
      { label: "Thematic (teal card)", color: "#0d9488" },
    ],
  },
  {
    icon: <Tag size={32} color="white" />,
    title: "7 · Label articles",
    description:
      "Create colour-coded labels (e.g. 'RCT', 'Low quality', 'Policy-relevant') and assign them " +
      "to articles at any screening stage. The Labels page shows per-label article counts, " +
      "filtered lists, and coverage stats — useful for tracking sub-populations or study designs.",
    features: [
      { color: "#4f46e5", text: "Custom names + palette colour picker" },
      { color: "#059669", text: "Assign labels from the screening workspace or extraction panel" },
      { color: "#0284c7", text: "Labels page: filter articles by label with stats at a glance" },
    ],
    where: [
      { label: "Project Overview", color: "#e11d48" },
      { label: "Labels (rose card)", color: "#e11d48" },
    ],
  },
  {
    icon: <Users size={32} color="white" />,
    title: "8 · Collaborate with your team",
    description:
      "Invite co-reviewers by token, assign roles, and screen in parallel. " +
      "Each reviewer's decisions are stored independently. The Consensus page surfaces " +
      "disagreements for adjudication and computes Cohen's kappa so you can report inter-rater reliability.",
    features: [
      { color: "#4f46e5", text: "Invite teammates → role-based access (owner / member)" },
      { color: "#059669", text: "Conflict detection — auto-flags disagreeing TA or FT decisions" },
      { color: "#d97706", text: "Cohen's kappa per reviewer pair, per stage, per project" },
    ],
    where: [
      { label: "Project Overview", color: "#475569" },
      { label: "Team (slate) or Consensus (amber card)", color: "#b45309" },
    ],
  },
  {
    icon: (
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="8"  r="3" fill="white" />
        <circle cx="8"  cy="24" r="3" fill="white" fillOpacity=".7" />
        <circle cx="24" cy="24" r="3" fill="white" fillOpacity=".7" />
        <line x1="16" y1="11" x2="8"  y2="21" stroke="white" strokeWidth="1.5" strokeOpacity=".6" />
        <line x1="16" y1="11" x2="24" y2="21" stroke="white" strokeWidth="1.5" strokeOpacity=".6" />
        <line x1="8"  y1="24" x2="24" y2="24" stroke="white" strokeWidth="1.5" strokeDasharray="3 2" strokeOpacity=".4" />
      </svg>
    ),
    title: "You're ready to start",
    description:
      "Create your first project, import some literature, and follow the workflow. " +
      "Every module is accessible from the project overview page — look for the coloured cards.",
    features: [
      { color: "#4f46e5", text: "Click \"New project\" on the Projects page to begin" },
      { color: "#059669", text: "The module grid on each project gives you one-click access to every stage" },
      { color: "#0284c7", text: "All data is stored locally — your research stays yours" },
    ],
  },
];

const STEP_COLORS = [
  "#4f46e5", // welcome
  "#3b82f6", // import
  "#7c3aed", // overlap
  "#059669", // screening
  "#0284c7", // PDF
  "#0891b2", // extraction
  "#0d9488", // thematic
  "#e11d48", // labels
  "#475569", // team
  "#4f46e5", // ready
];

export default function OnboardingTour({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const color = STEP_COLORS[step];

  function dismiss() {
    localStorage.setItem("ep_tour_done", "1");
    onDone();
  }

  return (
    <div className="modal-overlay" onClick={dismiss}>
      <div
        className="modal-card tour-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hero */}
        <div className="tour-hero" style={{ background: `linear-gradient(135deg, ${color}18 0%, #f8fafc 100%)` }}>
          <button
            onClick={dismiss}
            style={{
              position: "absolute",
              top: "1rem", right: "1rem",
              background: "none", border: "none",
              color: "#94a3b8", cursor: "pointer",
              padding: 4, borderRadius: 6,
              display: "flex", alignItems: "center",
            }}
            title="Skip tour"
          >
            <X size={18} />
          </button>

          <div
            className="tour-hero-icon"
            style={{ background: color, boxShadow: `0 4px 14px ${color}55` }}
          >
            {current.icon}
          </div>

          <h2 style={{ margin: 0, color: "#0f172a", fontSize: "1.25rem" }}>{current.title}</h2>
        </div>

        {/* Body */}
        <div className="tour-body">
          <p style={{ margin: "0 0 0.75rem" }}>{current.description}</p>

          {/* Where to find it */}
          {current.where && (
            <div style={{
              display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.3rem",
              marginBottom: "0.85rem",
              padding: "0.45rem 0.65rem",
              background: "#f1f5f9",
              borderRadius: "0.375rem",
              border: "1px solid #e2e8f0",
            }}>
              <MapPin size={12} color="#64748b" style={{ flexShrink: 0 }} />
              <span style={{ fontSize: "0.72rem", color: "#64748b", fontWeight: 600, marginRight: "0.1rem" }}>
                Find it:
              </span>
              {current.where.map((w, i) => (
                <span key={i} style={{ display: "flex", alignItems: "center", gap: "0.2rem" }}>
                  {i > 0 && (
                    <span style={{ color: "#94a3b8", fontSize: "0.7rem" }}>›</span>
                  )}
                  <span style={{
                    fontSize: "0.72rem",
                    fontWeight: 600,
                    color: w.color,
                    background: w.color + "12",
                    padding: "0.1rem 0.45rem",
                    borderRadius: "9999px",
                    border: `1px solid ${w.color}30`,
                    whiteSpace: "nowrap",
                  }}>
                    {w.label}
                  </span>
                </span>
              ))}
            </div>
          )}

          <div className="tour-features">
            {current.features.map((f, i) => (
              <div key={i} className="tour-feature">
                <div
                  className="tour-feature-icon"
                  style={{ background: f.color + "18", color: f.color }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                    <circle cx="5" cy="5" r="5" />
                  </svg>
                </div>
                <span>{f.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="tour-footer">
          {/* Dot progress */}
          <div className="tour-dots">
            {STEPS.map((_, i) => (
              <button
                key={i}
                className={`tour-dot${i === step ? " active" : ""}`}
                style={i === step ? { background: color } : {}}
                onClick={() => setStep(i)}
                title={`Step ${i + 1}`}
              />
            ))}
          </div>

          {/* Navigation */}
          <div className="tour-nav">
            {step > 0 && (
              <button className="btn-ghost btn-sm" onClick={() => setStep((s) => s - 1)}>
                <ArrowLeft size={14} /> Back
              </button>
            )}
            {isLast ? (
              <button
                className="btn-primary btn-sm"
                style={{ background: color, borderColor: color }}
                onClick={dismiss}
              >
                Get started
              </button>
            ) : (
              <button
                className="btn-primary btn-sm"
                style={{ background: color, borderColor: color }}
                onClick={() => setStep((s) => s + 1)}
              >
                Next <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
