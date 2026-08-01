import { describe, expect, test } from "vitest";
import { smoothSketchPoints } from "./sketch";

describe("smoothSketchPoints", () => {
  test("resamples a freehand stroke at stable spacing and preserves both ends", () => {
    const result = smoothSketchPoints([
      { x: 0, y: 0, time: 0 },
      { x: 1, y: 0, time: 10 },
      { x: 12, y: 0, time: 20 },
    ], { minCutoff: 1000, beta: 0, derivativeCutoff: 1, spacing: 4 });

    expect(result[0]).toMatchObject({ x: 0, y: 0 });
    expect(result.at(-1)).toMatchObject({ x: 12, y: 0 });
    expect(result).toHaveLength(4);
    expect(result.map((point) => point.x)).toEqual([0, 4, 8, 12]);
  });

  test("reduces stationary jitter without changing the stroke endpoints", () => {
    const source = [
      { x: 0, y: 0, time: 0 },
      { x: 1, y: 4, time: 100 },
      { x: 2, y: -4, time: 200 },
      { x: 3, y: 4, time: 300 },
      { x: 4, y: -4, time: 400 },
      { x: 5, y: 0, time: 500 },
    ];
    const result = smoothSketchPoints(source, { minCutoff: 1, beta: 0, derivativeCutoff: 1, spacing: 1 });

    expect(Math.max(...result.map((point) => Math.abs(point.y)))).toBeLessThan(4);
    expect(result.at(-1)).toEqual({ x: 5, y: 0 });
  });

  test("is deterministic and retains a sharp turn's final point", () => {
    const source = [
      { x: 0, y: 0, time: 0 },
      { x: 20, y: 0, time: 20 },
      { x: 20, y: 20, time: 40 },
    ];
    const options = { minCutoff: 1.35, beta: 0.012, derivativeCutoff: 1, spacing: 4.4 };

    expect(smoothSketchPoints(source, options)).toEqual(smoothSketchPoints(source, options));
    expect(smoothSketchPoints(source, options).at(-1)).toEqual({ x: 20, y: 20 });
  });
});
