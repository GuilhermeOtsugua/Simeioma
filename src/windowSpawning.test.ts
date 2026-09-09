import { beforeEach, expect, it, vi } from "vitest";
import { readSpawnAnchor, readSpawnContext, waitForWindowCreated, placeCreatedWindow } from "./windowSpawning";
import { createInitialState, createNoteInState } from "./simeiomaModel";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), getByLabel: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("./diagnostics", () => ({ invokeObserved: mocks.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: mocks.getByLabel } }));

beforeEach(() => { vi.resetAllMocks(); });

it("uses the actual launcher monitor and DPI, including negative screen coordinates", async () => {
  mocks.invoke.mockResolvedValue({ position: { x: -2030, y: 488 }, outer: { width: 60, height: 224 }, inner: { width: 60, height: 224 },
    monitor: { scaleFactor: 2, workArea: { position: { x: -2560, y: 0 }, size: { width: 2560, height: 1440 } } } });
  const context = await readSpawnContext();
  expect(mocks.invoke).toHaveBeenCalledWith("window_spawn_geometry", { label: "main" });
  expect(context?.launcher).toEqual({ x: -1022, y: 208, width: 44, height: 184 });
  expect(context?.bounds).toEqual({ left: -1268, top: 12, right: -12, bottom: 664 });
  expect(context!.origin.x).toBeLessThan(0);
});

it("copies live edge geometry and inherited size instead of a stale saved source", async () => {
  const state = createNoteInState(createInitialState(0), { id: "a", lineId: "a", now: "now", origin: { x: 100, y: 100 } }).state;
  mocks.getByLabel.mockResolvedValue({ label: "note-a" });
  mocks.invoke.mockResolvedValue({ position: { x: -80, y: 1300 }, outer: { width: 640, height: 480 }, inner: { width: 640, height: 480 },
    monitor: { scaleFactor: 2, workArea: { position: { x: 0, y: 0 }, size: { width: 2560, height: 1440 } } } });
  const anchor = await readSpawnAnchor(state.notes[0], null);
  const created = createNoteInState(state, { id: "b", lineId: "b", now: "now", origin: { x: 160, y: 160 }, spawnAfter: anchor.note, spawnBounds: anchor.bounds });
  expect(created.note?.position).toEqual({ x: -40, y: 650 });
  expect(created.note?.size).toEqual({ width: 320, height: 240 });
  expect(state.notes[0].position).toEqual({ x: 100, y: 100 });
});

it("reapplies edge positions after native creation, using the source monitor's physical coordinates", async () => {
  const window = { setPosition: vi.fn().mockResolvedValue(undefined), setSize: vi.fn().mockResolvedValue(undefined) } as unknown as WebviewWindow;
  await placeCreatedWindow(window, { x: -40.1, y: 650.4 }, { width: 320, height: 240 }, 2);
  expect(window.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: -80, y: 1301, type: "Physical" }));
  expect(window.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 320, height: 240, type: "Logical" }));
});

it("waits for native creation, not just registration of a created listener", async () => {
  const listeners = new Map<string, () => void>();
  const window = { once: vi.fn(async (name: string, handler: () => void) => { listeners.set(name, handler); return () => {}; }) } as unknown as WebviewWindow;
  let done = false;
  const result = waitForWindowCreated(window).then(() => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
  listeners.get("tauri://created")!();
  await result;
  expect(done).toBe(true);
});

it("rejects native creation errors so subsequent queued work can continue", async () => {
  const listeners = new Map<string, () => void>();
  const window = { once: vi.fn(async (name: string, handler: () => void) => { listeners.set(name, handler); return () => {}; }) } as unknown as WebviewWindow;
  const result = waitForWindowCreated(window);
  listeners.get("tauri://error")!();
  await expect(result).rejects.toThrow("Native window creation failed");
});
