import { expect, it } from "vitest";
import { noteSpawnBounds, planUtilityWindows, rectsOverlap } from "./spawnPlacement";
import { createInitialState, createNoteInState, DEFAULT_NOTE_SIZE } from "./simeiomaModel";

const bounds = { left: 12, top: 12, right: 1908, bottom: 976 };
function anchorAt(x: number, y: number, width = DEFAULT_NOTE_SIZE, height = DEFAULT_NOTE_SIZE) {
  const state = createNoteInState(createInitialState(0), { id: "a", lineId: "line-a", now: "2026-09-09", origin: { x, y } }).state;
  state.notes[0].size = { width, height };
  return state;
}

it("overlays the latest note rather than letting its next offset cross the bottom limit", () => {
  const state = anchorAt(53, 782);
  const result = createNoteInState(state, { id: "b", lineId: "line-b", now: "2026-09-09", origin: { x: 0, y: 0 }, spawnAfter: state.notes[0], spawnBounds: bounds });
  expect(result.note?.position).toEqual({ x: 53, y: 782 });
});

it.each([
  [-90, 300, 640, 240], [1800, 300, 400, 300], [50, -20, 192, 192], [50, 940, 360, 400],
])("preserves a manually edge-placed source exactly (%s, %s)", (x, y, width, height) => {
  const state = anchorAt(x, y, width, height);
  const result = createNoteInState(state, { id: "b", lineId: "b", now: "now", origin: { x: 1, y: 1 }, spawnAfter: state.notes[0], spawnBounds: bounds });
  expect(result.note?.position).toEqual({ x, y });
  expect(result.note?.size).toEqual({ width, height });
});

it("keeps the normal offset until the next note would cross the bottom, including repeated overflow", () => {
  let state = anchorAt(100, 700, 320, 200);
  for (const [id, expectedY] of [["b", 741], ["c", 741], ["d", 741]] as const) {
    const result = createNoteInState(state, { id, lineId: id, now: "now", origin: { x: 0, y: 0 }, spawnAfter: state.notes.at(-1), spawnBounds: bounds });
    expect(result.note?.position).toEqual({ x: 100, y: expectedY });
    expect(result.note?.size).toEqual({ width: 320, height: 200 });
    state = result.state;
  }
});

const work = { left: 0, top: 0, right: 1920, bottom: 1032, scale: 1 };
it("reserves distinct top-right utility slots in the screenshot order", () => {
  const note = { x: 1672, y: 60, width: 192, height: 314 };
  const plan = planUtilityWindows({ work, launcher: { x: 1864, y: 12, width: 44, height: 184 }, notes: [note], reservedNote: note });
  expect(plan?.["notes-list"]).toEqual({ x: 1320, y: 60, width: 320, height: 440 });
  expect(plan?.settings).toEqual({ x: 854, y: 60, width: 434, height: 548 });
  expect(rectsOverlap(plan!.settings, plan!["notes-list"])).toBe(false);
});

it("mirrors the slots at bottom-left and bottom-aligns different window heights", () => {
  const note = { x: 53, y: 782, width: 192, height: 192 };
  const plan = planUtilityWindows({ work, launcher: { x: 12, y: 836, width: 44, height: 184 }, notes: [note], reservedNote: note });
  expect(plan?.["notes-list"]).toEqual({ x: 277, y: 534, width: 320, height: 440 });
  expect(plan?.settings).toEqual({ x: 629, y: 426, width: 434, height: 548 });
});

it("keeps reserved positions independent of which utility opens first", () => {
  const note = { x: 1672, y: 60, width: 192, height: 192 };
  const input = { work, launcher: { x: 1864, y: 12, width: 44, height: 184 }, notes: [], reservedNote: note };
  const reserved = planUtilityWindows(input)!;
  expect(planUtilityWindows({ ...input, existing: { settings: reserved.settings } })?.["notes-list"]).toEqual(reserved["notes-list"]);
  expect(planUtilityWindows({ ...input, existing: { "notes-list": reserved["notes-list"] } })?.settings).toEqual(reserved.settings);
});

it("preserves a manually placed/resized utility while placing the other without overlap", () => {
  const note = { x: 1672, y: 60, width: 192, height: 192 };
  const settings = { x: 1310, y: 60, width: 350, height: 700 };
  const plan = planUtilityWindows({ work, launcher: { x: 1864, y: 12, width: 44, height: 184 }, notes: [note], reservedNote: note, existing: { settings } });
  expect(plan?.settings).toEqual(settings);
  expect(rectsOverlap(plan!["notes-list"], settings)).toBe(false);
});

it("supports negative-coordinate monitors", () => {
  const note = { x: -248, y: 60, width: 192, height: 192 };
  const plan = planUtilityWindows({ work: { ...work, left: -1920, right: 0, scale: 1.25 }, launcher: { x: -56, y: 12, width: 44, height: 184 }, notes: [note], reservedNote: note });
  expect(plan?.settings.x).toBe(-1066);
  expect(plan?.["notes-list"].x).toBe(-600);
});

it("uses compact non-overlapping windows when full-size slots cannot fit", () => {
  const note = { x: 12, y: 420, width: 192, height: 192 };
  const plan = planUtilityWindows({ work: { ...work, right: 800, bottom: 768 }, launcher: { x: 12, y: 620, width: 44, height: 120 }, notes: [note], reservedNote: note });
  expect(plan?.mode).toBe("compact");
  expect(rectsOverlap(plan!.settings, plan!["notes-list"])).toBe(false);
  expect(rectsOverlap(plan!.settings, note)).toBe(false);
  expect(rectsOverlap(plan!["notes-list"], note)).toBe(false);
});

it("keeps compact reservations stable instead of opportunistically widening the second window", () => {
  const note = { x: 12, y: 420, width: 192, height: 192 };
  const input = { work: { ...work, right: 840, bottom: 768 }, launcher: { x: 12, y: 620, width: 44, height: 120 }, notes: [note], reservedNote: note };
  const reserved = planUtilityWindows(input)!;
  expect(reserved.mode).toBe("compact");
  expect(planUtilityWindows({ ...input, existing: { settings: reserved.settings } })?.["notes-list"]).toEqual(reserved["notes-list"]);
  expect(planUtilityWindows({ ...input, existing: { "notes-list": reserved["notes-list"] } })?.settings).toEqual(reserved.settings);
});

it("reports insufficient space instead of overlapping windows", () => {
  const note = { x: 12, y: 12, width: 192, height: 192 };
  expect(planUtilityWindows({ work: { ...work, right: 400, bottom: 400 }, launcher: { x: 360, y: 12, width: 28, height: 120 }, notes: [note], reservedNote: note })).toBeNull();
});

it("uses the resting strip bottom limit independent of the current expanded canvas", () => {
  expect(noteSpawnBounds({ left: 0, top: 0, right: 1920, bottom: 1032, scale: 1 }, 184, 96).bottom).toBe(976);
});
