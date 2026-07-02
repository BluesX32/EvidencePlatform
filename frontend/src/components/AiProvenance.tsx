/**
 * AiProvenance — shared labels for AI-contributed content.
 *
 * Core principle: if an AI component contributes to an output, that
 * contribution is labeled and auditable. Every AI surface uses these
 * instead of inventing its own emoji/sparkle markup.
 *
 *   <AiBadge model="anthropic/claude-haiku-4-5" />
 *   <ReviewChip reviewedBy={r.reviewed_by} reviewedAt={r.reviewed_at} action={r.review_action} />
 */
import { Sparkles, Check, X, GitMerge, Clock } from "lucide-react";

/** Marks content as AI-generated, with the responsible model when known. */
export function AiBadge({ model, label = "AI" }: { model?: string | null; label?: string }) {
  const modelShort = model?.split("/").pop();
  return (
    <span
      className="ai-badge"
      title={`AI-assisted output${model ? ` (${model})` : ""} — requires human review before use`}
    >
      <Sparkles size={11} />
      {label}
      {modelShort && <span className="ai-badge-model">{modelShort}</span>}
    </span>
  );
}

const REVIEW_STATES: Record<string, { cls: string; icon: React.ReactNode; text: string }> = {
  accepted: { cls: "review-chip--accepted", icon: <Check size={11} />,    text: "Accepted" },
  rejected: { cls: "review-chip--rejected", icon: <X size={11} />,        text: "Rejected" },
  merged:   { cls: "review-chip--merged",   icon: <GitMerge size={11} />, text: "Merged" },
};

/** Shows whether a human has reviewed an AI output, and the outcome. */
export function ReviewChip({ reviewedAt, action }: {
  reviewedAt?: string | null;
  action?: string | null;
}) {
  const state = action ? REVIEW_STATES[action] : undefined;
  if (!state) {
    return (
      <span className="review-chip review-chip--pending" title="No human has reviewed this AI output yet">
        <Clock size={11} /> Awaiting review
      </span>
    );
  }
  const when = reviewedAt ? new Date(reviewedAt).toLocaleDateString() : "";
  return (
    <span className={`review-chip ${state.cls}`} title={`Reviewed by a human${when ? ` on ${when}` : ""}`}>
      {state.icon} {state.text}
    </span>
  );
}
