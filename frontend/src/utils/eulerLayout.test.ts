import { describe, it, expect } from "vitest";
import {
  circleRadius,
  circleIntersectionArea,
  targetDistanceForArea,
  layoutEuler,
} from "./eulerLayout";

// ── circleRadius ──────────────────────────────────────────────────────────

describe("circleRadius", () => {
  it("returns rMax when total equals maxTotal", () => {
    expect(circleRadius(100, 100, 80)).toBeCloseTo(80);
  });

  it("returns 0 for zero total", () => {
    expect(circleRadius(0, 100, 80)).toBe(0);
  });

  it("returns 0 for zero maxTotal", () => {
    expect(circleRadius(50, 0, 80)).toBe(0);
  });

  it("larger total => larger radius", () => {
    const rBig = circleRadius(800, 1000, 80);
    const rSmall = circleRadius(200, 1000, 80);
    expect(rBig).toBeGreaterThan(rSmall);
  });

  it("area scales linearly with total (area ∝ total)", () => {
    const r1 = circleRadius(100, 400, 80);
    const r2 = circleRadius(400, 400, 80);
    const area1 = Math.PI * r1 * r1;
    const area2 = Math.PI * r2 * r2;
    expect(area2 / area1).toBeCloseTo(4, 3);
  });

  it("half total => radius = rMax / sqrt(2)", () => {
    const r = circleRadius(50, 100, 80);
    expect(r).toBeCloseTo(80 / Math.sqrt(2), 4);
  });
});

// ── circleIntersectionArea ────────────────────────────────────────────────

describe("circleIntersectionArea", () => {
  it("returns 0 when circles do not touch (d == r1+r2)", () => {
    expect(circleIntersectionArea(5, 5, 10)).toBeCloseTo(0, 6);
  });

  it("returns 0 when circles are far apart (d > r1+r2)", () => {
    expect(circleIntersectionArea(5, 5, 20)).toBeCloseTo(0, 6);
  });

  it("returns smaller circle area when d=0 and one is smaller", () => {
    const innerArea = Math.PI * 4 * 4;
    expect(circleIntersectionArea(4, 10, 0)).toBeCloseTo(innerArea, 4);
  });

  it("returns smaller circle area when fully contained", () => {
    const innerArea = Math.PI * 3 * 3;
    // r1=3, r2=10, d=5: |r1-r2|=7 > d=5, so r1 fully inside r2
    expect(circleIntersectionArea(3, 10, 5)).toBeCloseTo(innerArea, 4);
  });

  it("is symmetric: area(r1,r2,d) === area(r2,r1,d)", () => {
    const a = circleIntersectionArea(5, 8, 7);
    const b = circleIntersectionArea(8, 5, 7);
    expect(a).toBeCloseTo(b, 8);
  });

  it("area is positive for partially overlapping circles", () => {
    const area = circleIntersectionArea(5, 5, 6);
    expect(area).toBeGreaterThan(0);
    expect(area).toBeLessThan(Math.PI * 5 * 5);
  });

  it("two equal circles fully overlapping (d=0) => area = π·r²", () => {
    expect(circleIntersectionArea(5, 5, 0)).toBeCloseTo(Math.PI * 25, 4);
  });
});

// ── targetDistanceForArea ─────────────────────────────────────────────────

describe("targetDistanceForArea", () => {
  it("returns r1+r2 when targetArea is 0", () => {
    expect(targetDistanceForArea(5, 7, 0)).toBeCloseTo(12, 3);
  });

  it("returns |r1-r2| when targetArea equals max possible overlap", () => {
    const r1 = 5, r2 = 8;
    const maxArea = circleIntersectionArea(r1, r2, Math.abs(r1 - r2));
    const d = targetDistanceForArea(r1, r2, maxArea);
    expect(d).toBeCloseTo(Math.abs(r1 - r2), 2);
  });

  it("is monotone: larger targetArea => smaller distance", () => {
    const r1 = 50, r2 = 50;
    const d1 = targetDistanceForArea(r1, r2, 500);
    const d2 = targetDistanceForArea(r1, r2, 2000);
    expect(d1).toBeGreaterThan(d2);
  });

  it("round-trips: circleIntersectionArea(targetDistanceForArea(A)) ≈ A", () => {
    const r1 = 40, r2 = 60;
    const target = 800;
    const d = targetDistanceForArea(r1, r2, target);
    const recovered = circleIntersectionArea(r1, r2, d);
    expect(recovered).toBeCloseTo(target, 1);
  });
});

// ── layoutEuler ───────────────────────────────────────────────────────────

describe("layoutEuler", () => {
  it("returns empty array for empty input", () => {
    expect(layoutEuler([], [])).toEqual([]);
  });

  it("returns single circle at origin for single source", () => {
    const result = layoutEuler([{ id: "a", total: 100 }], [[0]], 80);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
    expect(result[0].x).toBe(0);
    expect(result[0].y).toBe(0);
    expect(result[0].r).toBeCloseTo(80, 4);
  });

  it("assigns larger radius to source with more records", () => {
    const sources = [
      { id: "big", total: 1000 },
      { id: "small", total: 100 },
    ];
    const matrix = [[0, 5], [5, 0]];
    const result = layoutEuler(sources, matrix, 80, 100);
    const big = result.find((c) => c.id === "big")!;
    const small = result.find((c) => c.id === "small")!;
    expect(big.r).toBeGreaterThan(small.r);
  });

  it("is deterministic: same inputs produce identical positions", () => {
    const sources = [
      { id: "a", total: 1000 },
      { id: "b", total: 800 },
      { id: "c", total: 600 },
    ];
    const matrix = [[0, 50, 30], [50, 0, 20], [30, 20, 0]];
    const pos1 = layoutEuler(sources, matrix, 80, 200);
    const pos2 = layoutEuler(sources, matrix, 80, 200);
    for (let i = 0; i < pos1.length; i++) {
      expect(pos1[i].x).toBeCloseTo(pos2[i].x, 8);
      expect(pos1[i].y).toBeCloseTo(pos2[i].y, 8);
      expect(pos1[i].r).toBeCloseTo(pos2[i].r, 8);
    }
  });

  it("zero-count pair ends up further apart than overlapping pair", () => {
    const sources = [
      { id: "a", total: 500 },
      { id: "b", total: 500 },
      { id: "c", total: 500 },
    ];
    // a-b overlap heavily, a-c have zero overlap
    const matrix = [
      [0, 200, 0],
      [200, 0, 0],
      [0, 0, 0],
    ];
    const result = layoutEuler(sources, matrix, 80, 400);
    const a = result.find((c) => c.id === "a")!;
    const b = result.find((c) => c.id === "b")!;
    const c = result.find((c) => c.id === "c")!;
    const distAB = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
    const distAC = Math.sqrt((a.x - c.x) ** 2 + (a.y - c.y) ** 2);
    expect(distAC).toBeGreaterThan(distAB);
  });

  it("result array preserves source id order", () => {
    const sources = [
      { id: "x", total: 300 },
      { id: "y", total: 700 },
    ];
    const result = layoutEuler(sources, [[0, 10], [10, 0]], 80, 50);
    expect(result[0].id).toBe("x");
    expect(result[1].id).toBe("y");
  });
});
