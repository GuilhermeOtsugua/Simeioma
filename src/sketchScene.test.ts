import { expect, it, vi } from "vitest";
import { createSketchScene } from "./sketchScene";
import type { SketchStrokeRecord } from "./simeiomaModel";
const stroke: SketchStrokeRecord = { type: "line", start: { x: 0, y: 0 }, end: { x: 384, y: 384 } };
it("reuses compiled vectors across geometry-only state reloads", () => {
  const compile = vi.fn(() => ({ path: {} as Path2D, brush: "default" as const }));
  const scene = createSketchScene(compile);
  expect(scene.setStrokes([stroke])).toBe(true);
  expect(scene.setStrokes([structuredClone(stroke)])).toBe(false);
  expect(compile).toHaveBeenCalledTimes(1);
  expect(scene.setStrokes([{ id: "saved", ...stroke }])).toBe(false);
  expect(compile).toHaveBeenCalledTimes(1);
  expect(scene.setStrokes([{ ...stroke, end: { x: 20, y: 20 } }])).toBe(true);
  expect(compile).toHaveBeenCalledTimes(2);
  scene.setStrokes([]); scene.setStrokes([stroke]);
  expect(compile).toHaveBeenCalledTimes(3); // Removed geometry is not retained indefinitely.
});
it("transforms cached paths at every live size without scaling the brush width", () => {
  class TestPath {
    commands: unknown[][] = [];
    moveTo(...args: number[]) { this.commands.push(["move", ...args]); }
    lineTo(...args: number[]) { this.commands.push(["line", ...args]); }
    addPath(path: TestPath, matrix: unknown) { this.commands.push(["transform", path, matrix]); }
  }
  class Matrix { constructor(readonly values: number[]) {} }
  vi.stubGlobal("Path2D", TestPath); vi.stubGlobal("DOMMatrix", Matrix);
  try {
    const scene = createSketchScene(); scene.setStrokes([stroke]);
    const canvas = { width: 400, height: 200, getBoundingClientRect: () => ({ width: 200 }) };
    const context = { canvas, setTransform: vi.fn(), stroke: vi.fn((_path: Path2D) => {}), lineWidth: 0 };
    scene.draw(context as unknown as CanvasRenderingContext2D);
    const first = context.stroke.mock.calls[0][0] as unknown as TestPath;
    expect(first.commands[0][2]).toEqual(new Matrix([400 / 384, 0, 0, 200 / 384, 0, 0]));
    expect(context.lineWidth).toBe(4);
    canvas.height = 600;
    scene.draw(context as unknown as CanvasRenderingContext2D);
    const second = context.stroke.mock.calls[1][0] as unknown as TestPath;
    expect(second.commands[0][1]).toBe(first.commands[0][1]);
    expect(second.commands[0][2]).toEqual(new Matrix([400 / 384, 0, 0, 600 / 384, 0, 0]));
    expect(context.lineWidth).toBe(4);
  } finally { vi.unstubAllGlobals(); }
});
