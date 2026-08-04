import { describe, expect, test } from "vitest";
import {
  coalescedPointerEvents,
  recordSketchStroke,
  resolveSketchBrushSize,
  resolveSketchRenderingMode,
  sketchBrushWidth,
  sketchCanvasBackingSize,
  smoothSketchPoints,
} from "./sketch";

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

  test("uses device-pixel backing dimensions that follow the visible canvas", () => {
    expect(sketchCanvasBackingSize({ width: 480, height: 320 }, 2)).toEqual({ width: 960, height: 640 });
    expect(sketchCanvasBackingSize({ width: 720.4, height: 480.4 }, 1.25)).toEqual({ width: 901, height: 601 });
  });

  test("maps the three brush sizes and safely defaults historic records", () => {
    expect(sketchBrushWidth("thin")).toBe(1);
    expect(sketchBrushWidth("default")).toBe(2);
    expect(sketchBrushWidth("thick")).toBe(4);
    expect(resolveSketchBrushSize({ type: "freehand", points: [] })).toBe("default");
  });

  test("uses coalesced pointer samples when the browser exposes them", () => {
    const coalesced = [{ id: "first" }, { id: "second" }] as unknown as PointerEvent[];
    const event = { getCoalescedEvents: () => coalesced } as unknown as PointerEvent;

    expect(coalescedPointerEvents(event)).toEqual(coalesced);
  });

  test("keeps line and circle-like gestures as freehand records", () => {
    const lineLike = {
      renderingMode: "simeioma-adaptive" as const,
      brushSize: "default" as const,
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 1 }, { x: 60, y: 1 }],
    };
    const circleLike = {
      renderingMode: "tomodachi-pixel" as const,
      brushSize: "thick" as const,
      points: [{ x: 20, y: 10 }, { x: 30, y: 20 }, { x: 20, y: 30 }, { x: 10, y: 20 }, { x: 20, y: 10 }],
    };

    expect(recordSketchStroke(lineLike)).toMatchObject({ type: "freehand", renderingMode: "simeioma-adaptive", brushSize: "default" });
    expect(recordSketchStroke(circleLike)).toMatchObject({ type: "freehand", renderingMode: "tomodachi-pixel", brushSize: "thick" });
  });

  test("preserves legacy rendering for freehand records created before modes existed", () => {
    expect(resolveSketchRenderingMode({ type: "freehand", points: [] })).toBe("legacy");
    expect(resolveSketchRenderingMode({ type: "freehand", points: [], renderingMode: "tomodachi-pixel" })).toBe("tomodachi-pixel");
  });
});
