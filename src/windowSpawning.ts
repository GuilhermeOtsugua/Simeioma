import { isTauri } from "@tauri-apps/api/core";
import { LogicalPosition, PhysicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invokeObserved as invoke } from "./diagnostics";
import { DEFAULT_NOTE_SIZE, MENU_HEIGHT, MENU_WIDTH, STRIP_HEIGHT, type Note } from "./simeiomaModel";
import { clampSpawnOrigin, noteSpawnBounds, type SpawnBounds } from "./spawnPlacement";
import { parkingRect, scaledWorkArea, type MonitorLike, type Point, type Size, type WindowRect, type WorkArea } from "./windowGeometry";

type SpawnGeometry = { position: Point; inner: Size; outer: Size; monitor: MonitorLike };
const geometryFor = (label: string) => invoke<SpawnGeometry>("window_spawn_geometry", { label });

export async function readLauncherMonitor() {
  return (await geometryFor("main")).monitor;
}

export type SpawnContext = { work: WorkArea; bounds: SpawnBounds; launcher: WindowRect; origin: Point };
export async function readSpawnContext(): Promise<SpawnContext | null> {
  if (!isTauri()) return null;
  // Always use the launcher, even when creation is requested from a note renderer.
  const window = await geometryFor("main");
  const work = scaledWorkArea(window.monitor);
  const canvas = { x: window.position.x / work.scale, y: window.position.y / work.scale,
    width: window.outer.width / work.scale, height: window.outer.height / work.scale };
  const launcher = parkingRect(canvas, { width: MENU_WIDTH, height: MENU_HEIGHT });
  const center = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
  const delta = { x: (work.left + work.right) / 2 - center.x, y: (work.top + work.bottom) / 2 - center.y };
  const distance = Math.hypot(delta.x, delta.y) || 1;
  const bounds = noteSpawnBounds(work, MENU_HEIGHT, STRIP_HEIGHT);
  const origin = clampSpawnOrigin({ x: center.x + delta.x / distance * 126 - DEFAULT_NOTE_SIZE / 2,
    y: center.y + delta.y / distance * 126 - DEFAULT_NOTE_SIZE / 2 }, { width: DEFAULT_NOTE_SIZE, height: DEFAULT_NOTE_SIZE }, bounds);
  return { work, bounds, launcher, origin };
}

// Sample the live source, not its debounced saved position. Edge/cross-monitor sources use their own monitor.
export async function readSpawnAnchor(note: Note | undefined, context: SpawnContext | null): Promise<{ note: Note | undefined; bounds: SpawnBounds | undefined; scale?: number }> {
  if (!note || !isTauri()) return { note, bounds: context?.bounds, scale: context?.work.scale };
  const existing = await WebviewWindow.getByLabel(`note-${note.id}`);
  if (!existing) return { note, bounds: context?.bounds, scale: context?.work.scale };
  const window = await geometryFor(existing.label);
  const work = scaledWorkArea(window.monitor);
  return {
    note: { ...note, position: { x: window.position.x / work.scale, y: window.position.y / work.scale },
      size: { width: window.inner.width / work.scale, height: window.inner.height / work.scale } },
    bounds: noteSpawnBounds(work, MENU_HEIGHT, STRIP_HEIGHT),
    scale: work.scale,
  };
}

export async function windowRectInWorkArea(window: WebviewWindow, work: WorkArea): Promise<WindowRect> {
  // Native geometry includes restore bounds for minimized windows, never iconic (-32000, -32000) coordinates.
  const geometry = await geometryFor(window.label);
  return { x: geometry.position.x / work.scale, y: geometry.position.y / work.scale,
    width: geometry.outer.width / work.scale, height: geometry.outer.height / work.scale };
}

export async function placeCreatedWindow(window: WebviewWindow, position: Point, size: Size, scale?: number) {
  // Tao falls back to OS-default placement when the requested origin lies outside every monitor,
  // even if most of the window is visible. Reapply before showing; physical coordinates
  // also disambiguate logical positions that map to multiple mixed-DPI monitors.
  await window.setPosition(scale === undefined ? new LogicalPosition(position.x, position.y)
    : new PhysicalPosition(Math.round(position.x * scale), Math.round(position.y * scale)));
  await window.setSize(new LogicalSize(size.width, size.height));
}

// Tauri's once() promise means "listener registered", not "window created".
export function waitForWindowCreated(window: WebviewWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    void window.once("tauri://created", () => resolve()).catch(reject);
    void window.once("tauri://error", () => reject(new Error("Native window creation failed"))).catch(reject);
  });
}
