/**
 * EmptyState — a standard "nothing here yet" panel that points the user to
 * the next step in the workflow instead of leaving a blank area.
 *
 *   <EmptyState icon={<BookOpen size={36} />} title="No records yet"
 *               hint="Import citations to get started."
 *               action={<Link className="btn-primary btn-sm" to="…/import">Import records</Link>} />
 */
import type { ReactNode } from "react";

export default function EmptyState({ icon, title, hint, action }: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon">{icon}</div>}
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}
