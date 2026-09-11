import { expect, it } from "vitest";
import { createStateStore } from "./stateStore";
import { createSketchDraft, mergeSketchStrokes } from "./sketchDraft";
import { decodeState, encodeState } from "./stateCodec";
import { createInitialState, createNoteInState, type SketchStrokeRecord } from "./simeiomaModel";
const stroke: SketchStrokeRecord = { type: "line", start: { x: 1, y: 1 }, end: { x: 20, y: 20 } };
it("keeps pending ink visible and reconciles notifications before acknowledgement", () => {
  const draft = createSketchDraft(); draft.add(stroke, "first");
  const first = draft.pending();
  expect(draft.visible([])).toHaveLength(1);
  draft.add(stroke, "second");
  const saved = mergeSketchStrokes([], first);
  expect(draft.visible(saved).map(stroke => stroke.id)).toEqual(["first", "second"]);
  draft.acknowledge(first);
  expect(draft.visible(saved).map(stroke => stroke.id)).toEqual(["first", "second"]);
  expect(draft.pending().map(stroke => stroke.id)).toEqual(["second"]);
});
it("retains failed submissions for idempotent retry, including through the storage codec", () => {
  const draft = createSketchDraft(); draft.add(stroke, "first");
  // A rejected save has no acknowledgement: both rendering and the next submission retain the ink.
  expect(draft.visible([])).toHaveLength(1);
  draft.add(stroke, "second");
  const state = createNoteInState(createInitialState(0), { id: "note", lineId: "line", now: "2026-09-09" }).state;
  state.notes[0].sketchStrokes = draft.pending();
  const saved = decodeState(encodeState(state)).notes[0].sketchStrokes!;
  expect(mergeSketchStrokes(saved, draft.pending())).toHaveLength(2);
  draft.acknowledge(draft.pending()); expect(draft.pending()).toEqual([]);
  expect(draft.visible(saved)).toEqual(saved);
});
it("survives a rejected storage write and retries without losing or duplicating ink", async () => {
  const initial = createNoteInState(createInitialState(0), { id: "note", lineId: "line", now: "2026-09-09" }).state;
  let raw = encodeState(initial), fail = true;
  const store = createStateStore({ key: "test", initial: () => initial,
    storage: { getItem: () => raw, setItem: (_key, value) => { if (fail) throw new Error("storage full"); raw = value; } },
    locks: { request: async (_name, action) => action() },
  });
  const draft = createSketchDraft(); draft.add(stroke, "first");
  const save = async () => {
    const submitted = draft.pending();
    await store.transact(state => ({ state: { ...state, notes: state.notes.map(note => ({ ...note,
      sketchStrokes: mergeSketchStrokes(note.sketchStrokes ?? [], submitted),
    })) } }));
    draft.acknowledge(submitted);
  };
  await expect(save()).rejects.toThrow("storage full");
  expect(draft.visible(store.read().notes[0].sketchStrokes ?? [])).toHaveLength(1);
  fail = false; draft.add(stroke, "second"); await save(); await save();
  expect(store.read().notes[0].sketchStrokes?.map(stroke => stroke.id)).toEqual(["first", "second"]);
  expect(draft.pending()).toEqual([]);
});
it("allows undo and clear to discard pending ink without retrying it", () => {
  const draft = createSketchDraft(); draft.add(stroke, "first"); draft.add(stroke, "second");
  draft.discard("second"); expect(draft.pending().map(stroke => stroke.id)).toEqual(["first"]);
  draft.clear(); expect(draft.visible([])).toEqual([]);
});
