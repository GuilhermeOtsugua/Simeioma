import { expect, it } from "vitest";
import { createAnomalyDetector, diagnosticStorage, isRectClipped } from "./diagnosticsModel";

it("detects the two-pixel exit popup sliver in a 64px viewport", () => {
  expect(isRectClipped({ x: -134, y: 60, width: 136, height: 84 }, { x: 0, y: 0, width: 64, height: 204 })).toBe(true);
  expect(isRectClipped({ x: 14, y: 60, width: 136, height: 84 }, { x: 0, y: 0, width: 360, height: 204 })).toBe(false);
});

it("reports a stalled queue once and only reports persistent, settled size mismatches", () => {
  const detector = createAnomalyDetector();
  const idle = { busy: false, operationId: 1, operationAgeMs: 0, dragging: false, settled: true, clipped: false, mismatch: "64-vs-360" };
  expect(detector.check(idle, 0)).toEqual([]);
  expect(detector.check(idle, 1000)).toEqual(["geometry-mismatch"]);
  expect(detector.check(idle, 2000)).toEqual([]);
  expect(detector.check({ ...idle, dragging: true }, 3000)).toEqual([]);
  expect(detector.check({ ...idle, busy: true, operationAgeMs: 6000 }, 4000)).toEqual(["queue-stalled"]);
  expect(detector.check({ ...idle, busy: true, operationAgeMs: 6500 }, 4500)).toEqual([]);
  expect(detector.check({ ...idle, busy: true, operationAgeMs: 6500, operationId: 2 }, 5000)).toEqual(["queue-stalled"]);
});

it("preserves normal storage and isolates opt-in clean sessions", () => {
  expect(diagnosticStorage(false, true)).toBe("simeioma:v1");
  expect(diagnosticStorage(true, false)).toBe("simeioma:v1");
  expect(diagnosticStorage(true, true)).toBe("simeioma:debug-clean:v1");
});
