import { expect, it, vi } from "vitest";
import { createStateStore } from "./stateStore";
import { createInitialState, createNoteInState, updateNotePosition, updateNoteSize, removeNoteFromState, MAX_NOTES } from "./simeiomaModel";

function shared() {
  const values = new Map<string, string>();
  let tail = Promise.resolve();
  return { storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } },
    locks: { request<T>(_name: string, action: () => T | Promise<T>): Promise<T> { const result = tail.then(action); tail = result.then(() => {}, () => {}); return result; } } };
}
it("serializes independent clients and preserves unrelated updates", async () => {
  const options = { ...shared(), key: "test", initial: () => createInitialState(0) };
  const a = createStateStore(options), b = createStateStore(options);
  await a.transact(state => createNoteInState(state, { id: "a", lineId: "l", now: "2026-09-09", origin: { x: 10, y: 10 } }));
  await Promise.all([
    a.transact(state => ({ state: updateNotePosition(state, "a", { x: -40, y: 900 }) })),
    b.transact(state => ({ state: updateNoteSize(state, "a", { width: 320, height: 240 }) })),
  ]);
  expect(a.read().notes[0]).toMatchObject({ position: { x: -40, y: 900 }, size: { width: 320, height: 240 } });
  expect(JSON.parse(options.storage.getItem("test")!).revision).toBe(3);
});
it("enforces the note limit across concurrent creators and retains settings", async () => {
  const options = { ...shared(), key: "test", initial: () => createInitialState(0) };
  const a = createStateStore(options), b = createStateStore(options);
  await Promise.all([
    ...Array.from({ length: MAX_NOTES + 5 }, (_, i) => (i % 2 ? a : b).transact(state =>
      createNoteInState(state, { id: `note-${i}`, lineId: `line-${i}`, now: "2026-09-09" }))),
    b.transact(state => ({ state: { ...state, settings: { ...state.settings, copyAfterSave: false } } })),
  ]);
  expect(a.read().notes).toHaveLength(MAX_NOTES);
  expect(new Set(a.read().notes.map(note => note.id)).size).toBe(MAX_NOTES);
  expect(a.read().settings.copyAfterSave).toBe(false);
});
it("does not resurrect a deleted note through a queued geometry update", async () => {
  const options = { ...shared(), key: "test", initial: () => createInitialState(0) };
  const a = createStateStore(options), b = createStateStore(options);
  await a.transact(state => createNoteInState(state, { id: "a", lineId: "l", now: "2026-09-09" }));
  await Promise.all([
    a.transact(state => ({ state: removeNoteFromState(state, "a") })),
    b.transact(state => ({ state: updateNotePosition(state, "a", { x: 100, y: 200 }) })),
  ]);
  expect(a.read().notes).toEqual([]);
});
it("keeps successful commits when notification fails and recovers from storage failure", async () => {
  const options = { ...shared(), key: "test", initial: () => createInitialState(0), changed: vi.fn(() => { throw new Error("notification unavailable"); }) };
  const store = createStateStore(options);
  const mutate = () => store.transact(state => ({ state: { ...state, settings: { ...state.settings, copyAfterSave: false } } }));
  const write = vi.spyOn(options.storage, "setItem");
  write.mockImplementationOnce(() => { throw new Error("storage full"); });
  await expect(mutate()).rejects.toThrow("storage full");
  expect(options.changed).not.toHaveBeenCalled();
  expect(options.storage.getItem("test")).toBeNull();
  await expect(mutate()).resolves.toBeDefined();
  expect(store.read().settings.copyAfterSave).toBe(false);
});
it("does not replace corrupt data or poison later transactions after failure", async () => {
  const options = { ...shared(), key: "test", initial: () => createInitialState(0) };
  const store = createStateStore(options);
  options.storage.setItem("test", "{bad");
  await expect(store.transact(state => ({ state }))).rejects.toThrow();
  expect(options.storage.getItem("test")).toBe("{bad");
  options.storage.setItem("test", JSON.stringify(createInitialState(0)));
  await store.transact(state => ({ state: { ...state, settings: { ...state.settings, copyAfterSave: false } } }));
  expect(store.read().settings.copyAfterSave).toBe(false);
});
