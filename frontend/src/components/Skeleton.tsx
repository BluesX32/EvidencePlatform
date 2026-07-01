/**
 * Skeleton — shimmer placeholders shown while data loads.
 *
 *   <Skeleton width={180} />                    single line
 *   <SkeletonRows rows={6} />                   list/table placeholder
 */

export function Skeleton({ width, height = 14, style }: {
  width?: number | string;
  height?: number | string;
  style?: React.CSSProperties;
}) {
  return <div className="skeleton" style={{ width, height, ...style }} />;
}

/** Rows of varying widths approximating a loading list or table. */
export function SkeletonRows({ rows = 6, style }: { rows?: number; style?: React.CSSProperties }) {
  // Deterministic width variation so rows look organic without flickering on re-render
  const widths = ["92%", "78%", "85%", "70%", "88%", "75%"];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem", padding: "1rem 0", ...style }} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width={widths[i % widths.length]} />
      ))}
    </div>
  );
}
