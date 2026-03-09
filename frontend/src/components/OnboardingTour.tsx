/**
 * OnboardingTour — a multi-step welcome walkthrough shown once to new users.
 *
 * Shown when localStorage key "ep_tour_done" is absent.
 * Dismissed permanently when the user clicks "Get started" or the ✕ button.
 */
import { useState } from "react";
import {
  Upload, GitMerge, CheckSquare, FlaskConical, Tag, Network, X, ArrowRight, ArrowLeft,
} from "lucide-react";

const STEPS = [
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
      "Follow this short tour to learn how the platform guides your review from import to synthesis.",
    features: [
      { color: "#4f46e5", text: "Structured workflow — Import → Overlap → Screen → Extract" },
      { color: "#059669", text: "Every decision is logged and auditable" },
      { color: "#d97706", text: "AI assistance at every step, humans stay in control" },
    ],
  },
  {
    icon: <Upload size={32} color="white" />,
    title: "1 · Import your literature",
    description:
      "Upload RIS, MEDLINE, or BibTeX files exported from PubMed, Embase, Cochrane, " +
      "or any other database. The platform parses, normalises, and stores every record.",
    features: [
      { color: "#4f46e5", text: "Supported formats: RIS · MEDLINE · BibTeX" },
      { color: "#059669", text: "Duplicate detection runs automatically after each import" },
      { color: "#0284c7", text: "Full import history with record-level provenance" },
    ],
  },
  {
    icon: <GitMerge size={32} color="white" />,
    title: "2 · Resolve overlaps",
    description:
      "When the same paper appears across multiple databases, the platform groups them " +
      "into clusters using DOI, PMID, title, and author matching. Review and lock confirmed duplicates.",
    features: [
      { color: "#4f46e5", text: "5-tier matching: DOI → PMID → Title+Author → Fuzzy" },
      { color: "#059669", text: "Euler diagram shows source overlaps at a glance" },
      { color: "#d97706", text: "Manual link / lock clusters you've reviewed" },
    ],
  },
  {
    icon: <CheckSquare size={32} color="white" />,
    title: "3 · Screen articles",
    description:
      "Work through title/abstract screening, then full-text review. " +
      "Apply inclusion/exclusion criteria, annotate with free text, and pick up where you left off.",
    features: [
      { color: "#4f46e5", text: "Sequential or mixed (TA+FT together) screening modes" },
      { color: "#059669", text: "Criteria panel visible while you screen" },
      { color: "#0284c7", text: "Full-text links via Unpaywall, PubMed, and DOI" },
    ],
  },
  {
    icon: <FlaskConical size={32} color="white" />,
    title: "4 · Extract evidence",
    description:
      "For each included study, capture structured data: populations, interventions, " +
      "outcomes, study design, and key findings. The saturation counter tracks conceptual novelty.",
    features: [
      { color: "#4f46e5", text: "Levels of analysis map your framework dimensions" },
      { color: "#059669", text: "Saturation counter shows consecutive papers with no new concepts" },
      { color: "#d97706", text: "All extractions stored with full provenance" },
    ],
  },
  {
    icon: (
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <Tag size={32} color="white" />
      </svg>
    ),
    icon2: <Tag size={32} color="white" />,
    title: "5 · Labels & Taxonomy",
    description:
      "Create colour-coded labels to tag articles (e.g. by theme or quality). " +
      "Build a hierarchical taxonomy to map your conceptual framework as you extract.",
    features: [
      { color: "#4f46e5", text: "Labels: apply, filter, and explore on the Labels page" },
      { color: "#059669", text: "Taxonomy: full CRUD tree editor with namespace colours" },
      { color: "#0284c7", text: "New extraction levels auto-sync to your taxonomy" },
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
      "This tour is always accessible from the help menu if you need a refresher.",
    features: [
      { color: "#4f46e5", text: "Click \"New project\" to begin your first review" },
      { color: "#059669", text: "Each step builds on the previous one" },
      { color: "#0284c7", text: "All data is stored locally — your research stays yours" },
    ],
  },
];

const STEP_COLORS = ["#4f46e5", "#7c3aed", "#0284c7", "#059669", "#d97706", "#dc2626", "#4f46e5"];

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
            {current.icon2 ?? current.icon}
          </div>

          <h2 style={{ margin: 0, color: "#0f172a", fontSize: "1.25rem" }}>{current.title}</h2>
        </div>

        {/* Body */}
        <div className="tour-body">
          <p>{current.description}</p>
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
