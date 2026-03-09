/**
 * eulerLayout — pure math utilities for the quantitative Euler/Venn diagram.
 *
 * All functions are side-effect-free and depend only on their arguments.
 * They can be imported in Node/Vitest without a DOM.
 */

// ── Radius scaling ──────────────────────────────────────────────────────────

/**
 * Convert a record count to a circle radius using area-proportional scaling.
 * radius = sqrt(total / maxTotal) * rMax
 * so area ∝ total.
 */
export function circleRadius(
  total: number,
  maxTotal: number,
  rMax: number
): number {
  if (maxTotal <= 0 || total <= 0) return 0;
  return Math.sqrt(total / maxTotal) * rMax;
}

// ── Circle-circle intersection area ────────────────────────────────────────

/**
 * Compute the area of intersection (lens) of two circles.
 *
 * @param r1  radius of circle 1
 * @param r2  radius of circle 2
 * @param d   distance between centres (must be >= 0)
 * @returns   intersection area (0 when circles don't overlap)
 */
export function circleIntersectionArea(
  r1: number,
  r2: number,
  d: number
): number {
  if (d <= 0) {
    // One circle fully inside the other (or identical)
    const inner = Math.min(r1, r2);
    return Math.PI * inner * inner;
  }
  if (d >= r1 + r2) {
    // Circles don't overlap
    return 0;
  }
  if (d <= Math.abs(r1 - r2)) {
    // One circle fully contained
    const inner = Math.min(r1, r2);
    return Math.PI * inner * inner;
  }
  // Standard lens-area formula
  const d1 = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const d2 = d - d1;
  const area =
    r1 * r1 * Math.acos(Math.max(-1, Math.min(1, d1 / r1))) -
    d1 * Math.sqrt(Math.max(0, r1 * r1 - d1 * d1)) +
    r2 * r2 * Math.acos(Math.max(-1, Math.min(1, d2 / r2))) -
    d2 * Math.sqrt(Math.max(0, r2 * r2 - d2 * d2));
  return Math.max(0, area);
}

// ── Distance solver ─────────────────────────────────────────────────────────

/**
 * Find the distance between two circle centres that produces a given
 * intersection area.  Uses binary search.
 *
 * @param r1          radius of circle 1
 * @param r2          radius of circle 2
 * @param targetArea  desired intersection area
 * @returns           distance d in [|r1-r2|, r1+r2]
 */
export function targetDistanceForArea(
  r1: number,
  r2: number,
  targetArea: number,
  tol = 1e-4,
  maxIter = 60
): number {
  const lo0 = Math.abs(r1 - r2);
  const hi0 = r1 + r2;

  if (targetArea <= 0) return hi0;

  const maxPossibleArea = circleIntersectionArea(r1, r2, lo0);
  if (targetArea >= maxPossibleArea) return lo0;

  let lo = lo0;
  let hi = hi0;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const area = circleIntersectionArea(r1, r2, mid);
    if (Math.abs(area - targetArea) < tol) return mid;
    // Larger distance → smaller area
    if (area > targetArea) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

// ── Iterative-relaxation layout ─────────────────────────────────────────────

export interface SourceInput {
  id: string;
  total: number;
}

export interface CircleLayout {
  id: string;
  x: number;
  y: number;
  r: number;
}

/**
 * Compute positions + radii for an area-proportional Euler/Venn diagram.
 *
 * Algorithm:
 *  1. Radius ∝ sqrt(total) so area ∝ total records.
 *  2. For each pair, determine the target centre-to-centre distance:
 *       count = 0  →  circles clearly separated: d = r_i + r_j + separationGap
 *       count > 0  →  circles visually overlap: d = targetDistanceForArea(...)
 *                     Overlap fraction = clamp(count / minTotal, 0.12, 0.90)
 *                     so even tiny overlaps produce a visible lens region.
 *  3. Containment guard (overlapping pairs only): d >= |r_i - r_j| + containmentPad
 *     so neither circle is completely hidden inside the other.
 *  4. Spring-relaxation with a linear cooling schedule drives centres toward
 *     their target distances.  After each step the layout is re-centred on the
 *     origin (no spreading force — spreading was the primary cause of incorrect
 *     separation for overlapping pairs).
 *
 * The result is deterministic for the same input.
 *
 * @param sources        Array of {id, total} — order determines initial placement
 * @param matrix         NxN symmetric matrix of pairwise overlap counts
 * @param rMax           Maximum circle radius in layout coordinates (default 80)
 * @param iterations     Spring-relaxation steps (default 400)
 * @param separationGap  Extra gap added when count=0 so circles don't touch (default 20)
 * @param containmentPad Min gap beyond |r_i - r_j| for overlapping pairs (default 4)
 */
export function layoutEuler(
  sources: SourceInput[],
  matrix: number[][],
  rMax = 80,
  iterations = 400,
  separationGap = 20,
  containmentPad = 4
): CircleLayout[] {
  const n = sources.length;
  if (n === 0) return [];
  if (n === 1) {
    return [{ id: sources[0].id, x: 0, y: 0, r: rMax }];
  }

  const maxTotal = Math.max(...sources.map((s) => s.total), 1);
  const radii = sources.map((s) => circleRadius(s.total, maxTotal, rMax));
  const areas = radii.map((r) => Math.PI * r * r);

  // Compute target centre-to-centre distances for every pair.
  const targetDist: number[][] = Array.from({ length: n }, () =>
    new Array(n).fill(0)
  );
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const count = matrix[i]?.[j] ?? 0;
      let td: number;
      if (count === 0) {
        // No shared papers → circles must be clearly separated (no visual touch).
        td = radii[i] + radii[j] + separationGap;
      } else {
        // Shared papers → circles should visually overlap.
        // fraction: what share of the smaller circle area should be in the lens.
        // Floor at 0.12 so any non-zero overlap is clearly visible.
        const minTotal = Math.max(Math.min(sources[i].total, sources[j].total), 1);
        const minArea  = Math.min(areas[i], areas[j]);
        const fraction = Math.min(Math.max(count / minTotal, 0.12), 0.90);
        const targetArea = fraction * minArea;
        td = targetDistanceForArea(radii[i], radii[j], targetArea);
        // Prevent full containment (which is invisible): keep a small gap above
        // the containment threshold |r_i - r_j|.
        td = Math.max(td, Math.abs(radii[i] - radii[j]) + containmentPad);
      }
      targetDist[i][j] = td;
      targetDist[j][i] = td;
    }
  }

  // Initialise centres on a circle of radius 1.5 × rMax.
  const initR = rMax * 1.5;
  const pos = sources.map((_, i) => ({
    x: initR * Math.cos((2 * Math.PI * i) / n - Math.PI / 2),
    y: initR * Math.sin((2 * Math.PI * i) / n - Math.PI / 2),
  }));

  // Spring-relaxation with linear cooling (step 0.55 → 0.05).
  // Each iteration moves every centre toward its target distance from every
  // other centre, then re-centres the whole layout on the origin.
  // No outward spreading force — that was the root cause of incorrect overlap.
  const moves = Array.from({ length: n }, () => ({ dx: 0, dy: 0 }));

  for (let iter = 0; iter < iterations; iter++) {
    const step = 0.55 - 0.50 * (iter / (iterations - 1)); // 0.55 → 0.05

    for (let k = 0; k < n; k++) { moves[k].dx = 0; moves[k].dy = 0; }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx   = pos[j].x - pos[i].x;
        const dy   = pos[j].y - pos[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        const err  = (dist - targetDist[i][j]) / dist; // +ve=too far, −ve=too close
        const mx   = err * dx * step;
        const my   = err * dy * step;
        moves[i].dx += mx;  moves[i].dy += my;
        moves[j].dx -= mx;  moves[j].dy -= my;
      }
    }

    for (let k = 0; k < n; k++) {
      pos[k].x += moves[k].dx;
      pos[k].y += moves[k].dy;
    }

    // Re-centre on origin each step (prevents drift; does not distort distances).
    const centX = pos.reduce((s, p) => s + p.x, 0) / n;
    const centY = pos.reduce((s, p) => s + p.y, 0) / n;
    for (let k = 0; k < n; k++) {
      pos[k].x -= centX;
      pos[k].y -= centY;
    }
  }

  return sources.map((s, i) => ({
    id: s.id,
    x: pos[i].x,
    y: pos[i].y,
    r: radii[i],
  }));
}
