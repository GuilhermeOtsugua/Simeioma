import type { Point, Size, WindowRect, WorkArea } from "./windowGeometry";

export type SpawnBounds = Pick<WorkArea, "left" | "top" | "right" | "bottom">;
export const SPAWN_SCREEN_MARGIN = 12;
export const UTILITY_GAP = 32;
export const UTILITY_MIN_SIZE: Size = { width: 280, height: 300 };
export const UTILITY_SIZES = {
  settings: { width: 434, height: 548 },
  "notes-list": { width: 320, height: 440 },
} as const;
export type UtilityRole = keyof typeof UTILITY_SIZES;

export function safeSpawnBounds(work: WorkArea): SpawnBounds {
  return { left: work.left + SPAWN_SCREEN_MARGIN, top: work.top + SPAWN_SCREEN_MARGIN,
    right: work.right - SPAWN_SCREEN_MARGIN, bottom: work.bottom - SPAWN_SCREEN_MARGIN };
}

export function noteSpawnBounds(work: WorkArea, parkingHeight: number, restingStripHeight: number): SpawnBounds {
  const safe = safeSpawnBounds(work);
  // The larger expanded-menu envelope is what constrains the launcher's center.
  return { ...safe, bottom: safe.bottom - Math.max(0, parkingHeight - restingStripHeight) / 2 };
}

export function rectFits(rect: WindowRect, bounds: SpawnBounds) {
  return rect.x >= bounds.left && rect.y >= bounds.top
    && rect.x + rect.width <= bounds.right && rect.y + rect.height <= bounds.bottom;
}

export function rectsOverlap(a: WindowRect, b: WindowRect, gap = 0) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

export type UtilityPlan = Record<UtilityRole, WindowRect> & { mode: "row" | "reflow" | "compact" };
type UtilityInput = {
  work: WorkArea;
  launcher: WindowRect;
  notes: WindowRect[];
  reservedNote: WindowRect;
  existing?: Partial<Record<UtilityRole, WindowRect>>;
};

function footprint(notes: WindowRect[]): WindowRect {
  const x = Math.min(...notes.map((note) => note.x));
  const y = Math.min(...notes.map((note) => note.y));
  return { x, y, width: Math.max(...notes.map((note) => note.x + note.width)) - x,
    height: Math.max(...notes.map((note) => note.y + note.height)) - y };
}

function candidates(size: Size, preferred: Point, obstacles: WindowRect[], bounds: SpawnBounds): WindowRect[] {
  if (size.width > bounds.right - bounds.left || size.height > bounds.bottom - bounds.top) return [];
  const origin = clampSpawnOrigin(preferred, size, bounds);
  const gap = SPAWN_SCREEN_MARGIN;
  const xs = new Set([origin.x, bounds.left, bounds.right - size.width,
    ...obstacles.flatMap((rect) => [rect.x - gap - size.width, rect.x + rect.width + gap])]);
  const ys = new Set([origin.y, bounds.top, bounds.bottom - size.height,
    ...obstacles.flatMap((rect) => [rect.y - gap - size.height, rect.y + rect.height + gap])]);
  const found: WindowRect[] = [];
  for (const x of xs) for (const y of ys) {
    const rect = { x, y, ...size };
    if (rectFits(rect, bounds) && !obstacles.some((obstacle) => rectsOverlap(rect, obstacle, gap))) found.push(rect);
  }
  const distance = (rect: WindowRect) => Math.abs(rect.x - preferred.x) + Math.abs(rect.y - preferred.y);
  return found.sort((a, b) => distance(a) - distance(b));
}

export function planUtilityWindows(input: UtilityInput): UtilityPlan | null {
  const existing = input.existing;
  if (existing?.settings || existing?.["notes-list"]) {
    const reserved = solveUtilityWindows({ ...input, existing: undefined });
    const matches = (actual: WindowRect | undefined, planned: WindowRect) => !actual
      || (Math.abs(actual.x - planned.x) <= 1 && Math.abs(actual.y - planned.y) <= 1
        && Math.abs(actual.width - planned.width) <= 1 && Math.abs(actual.height - planned.height) <= 1);
    // Keep both reserved slots, including compact sizes, unless the user/context changed them.
    if (reserved && matches(existing.settings, reserved.settings) && matches(existing["notes-list"], reserved["notes-list"])) {
      return { ...reserved, settings: existing.settings ?? reserved.settings, "notes-list": existing["notes-list"] ?? reserved["notes-list"] };
    }
  }
  return solveUtilityWindows(input);
}

function solveUtilityWindows(input: UtilityInput): UtilityPlan | null {
  const bounds = safeSpawnBounds(input.work);
  const notes = input.notes.length ? input.notes : [input.reservedNote];
  const stack = footprint(notes);
  const inward = input.launcher.x + input.launcher.width / 2 > (input.work.left + input.work.right) / 2 ? -1 : 1;
  const topAligned = input.launcher.y + input.launcher.height / 2 < (input.work.top + input.work.bottom) / 2;
  const obstacles = [...notes, input.launcher];
  const existing = input.existing ?? {};
  const stages = [0, 1, 2] as const; // Full size, narrower, then minimum-size scrolling surfaces.
  for (const stage of stages) {
    const sizeFor = (role: UtilityRole): Size => ({
      width: Math.min(stage ? UTILITY_MIN_SIZE.width : UTILITY_SIZES[role].width, bounds.right - bounds.left),
      height: Math.min(stage === 2 ? UTILITY_MIN_SIZE.height : UTILITY_SIZES[role].height, bounds.bottom - bounds.top),
    });
    const listSize = existing["notes-list"] ?? sizeFor("notes-list");
    const settingsSize = existing.settings ?? sizeFor("settings");
    if ([listSize, settingsSize].some((size) => size.width < UTILITY_MIN_SIZE.width || size.height < UTILITY_MIN_SIZE.height)) continue;
    const listPreferred = {
      x: inward < 0 ? stack.x - UTILITY_GAP - listSize.width : stack.x + stack.width + UTILITY_GAP,
      y: topAligned ? stack.y : stack.y + stack.height - listSize.height,
    };
    const settingsPreferred = {
      x: inward < 0 ? listPreferred.x - UTILITY_GAP - settingsSize.width : listPreferred.x + listSize.width + UTILITY_GAP,
      y: topAligned ? stack.y : stack.y + stack.height - settingsSize.height,
    };
    const lists = existing["notes-list"] ? [existing["notes-list"]] : candidates(listSize, listPreferred,
      existing.settings ? [...obstacles, existing.settings] : obstacles, bounds);
    for (const list of lists) {
      const settings = existing.settings ?? candidates(settingsSize, settingsPreferred, [...obstacles, list], bounds)[0];
      if (!settings) continue;
      const isCompact = (role: UtilityRole, rect: WindowRect) => !existing[role]
        && (rect.width < UTILITY_SIZES[role].width || rect.height < UTILITY_SIZES[role].height);
      const compact = isCompact("notes-list", list) || isCompact("settings", settings);
      const row = list.x === listPreferred.x && list.y === listPreferred.y && settings.x === settingsPreferred.x && settings.y === settingsPreferred.y;
      return { settings, "notes-list": list, mode: compact ? "compact" : row ? "row" : "reflow" };
    }
  }
  // Keeping both windows reachable/non-overlapping can be impossible; do not silently cover one.
  return null;
}

export function clampSpawnOrigin(origin: Point, size: Size, bounds: SpawnBounds): Point {
  return { x: Math.max(bounds.left, Math.min(origin.x, bounds.right - size.width)),
    y: Math.max(bounds.top, Math.min(origin.y, bounds.bottom - size.height)) };
}
