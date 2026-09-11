import { expect, it } from "vitest";
import { createEditorHistory } from "./editorHistory";
const entry = (value: string) => ({ value, selection: { start: value.length, end: value.length } });
it("bounds total retained history and supports undo/redo", () => {
  const history = createEditorHistory({ maxEntries: 2, maxBytes: 200 });
  history.record(entry("a")); history.record(entry("b")); history.record(entry("c"));
  expect(history.undo(entry("d"))?.value).toBe("c");
  expect(history.undo(entry("c"))?.value).toBe("b");
  expect(history.undo(entry("b"))).toBeUndefined();
  expect(history.redo(entry("b"))?.value).toBe("c");
  history.record(entry("c"));
  expect(history.redo(entry("new"))).toBeUndefined();
  history.record(entry("x".repeat(1000)));
  expect(history.stats().bytes).toBeLessThanOrEqual(200);
});
it("groups consecutive typing but not composition or cursor changes", () => {
  const history = createEditorHistory();
  history.record(entry(""), "typing"); history.record(entry("a"), "typing");
  expect(history.undo(entry("ab"))?.value).toBe("");
  history.record(entry("ab")); history.record(entry("日本"));
  expect(history.undo(entry("日本語"))?.value).toBe("日本");
  history.clear(); expect(history.undo(entry("external"))).toBeUndefined();
});
