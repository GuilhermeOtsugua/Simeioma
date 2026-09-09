import { afterEach, expect, it, vi } from "vitest";
import { createDragDiagnostics } from "./diagnosticsLifecycle";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("reports native failure without swallowing it from the application", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const tracker = createDragDiagnostics({
    now: () => Date.now(), sample: vi.fn(), emit: (event) => events.push(event), capture: async () => {},
  });
  await expect(tracker.observe(() => Promise.reject(new Error("native failure")))).rejects.toThrow("native failure");
  expect(events).toEqual(["drag-start", "drag-failed"]);
  expect(tracker.status().dragging).toBe(false);
  tracker.dispose();
});

it("bounds hung native calls and cancels observation on teardown", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const sample = vi.fn();
  const tracker = createDragDiagnostics({ now: () => Date.now(), sample, emit: (event) => events.push(event), capture: async () => {} });
  tracker.observe(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(120000);
  expect(events).toEqual(["drag-start", "drag-timeout"]);
  expect(sample).not.toHaveBeenCalled();
  tracker.observe(() => Promise.resolve());
  tracker.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(sample).not.toHaveBeenCalled();
});

it("does not treat native return as drag end and captures only settled geometry", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const samples = [true, true, false, false, false];
  const capture = vi.fn().mockResolvedValue(undefined);
  const tracker = createDragDiagnostics({
    now: () => Date.now(),
    sample: async () => ({ mouseDown: samples.shift() ?? false, x: 50, y: 80, width: 192, height: 192 }),
    emit: (name) => events.push(name), capture,
  });
  const native = Promise.resolve();
  expect(tracker.observe(() => native)).toBe(native);
  await vi.advanceTimersByTimeAsync(150);
  expect(events).toEqual(["drag-start", "drag-native-return"]);
  expect(capture).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(400);
  expect(events).toEqual(["drag-start", "drag-native-return", "drag-end"]);
  expect(capture).toHaveBeenCalledOnce();
  expect(tracker.status().dragging).toBe(false);
  tracker.dispose();
  vi.useRealTimers();
});
