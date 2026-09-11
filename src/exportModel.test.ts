import { expect, it } from "vitest";
import { planImageExport } from "./exportModel";
import { createInitialState, createNoteInState } from "./simeiomaModel";
it("includes every text row, both columns and a drawing region", () => {
  const note = createNoteInState(createInitialState(0), { id: "a", lineId: "l", now: "2026-09-09" }).note!;
  note.lines[0].text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  note.layout = "two-column"; note.rightText = "right\nlast right";
  note.sketchStrokes = [{ type: "line", start: { x: 0, y: 0 }, end: { x: 384, y: 384 } }];
  const plan = planImageExport([note], text => text.length * 8);
  expect(plan.cards[0].left).toHaveLength(30);
  expect(plan.cards[0].right).toEqual(["right", "last right"]);
  expect(plan.cards[0].drawing).toBeDefined();
  expect(plan.height).toBeGreaterThan(700);
});
it("wraps long content and rejects oversized images rather than truncating", () => {
  const note = createNoteInState(createInitialState(0), { id: "a", lineId: "l", now: "2026-09-09" }).note!;
  note.lines[0].text = "a".repeat(300);
  const lines = planImageExport([note], text => text.length * 8).cards[0].left;
  expect(lines.join("")).toBe(note.lines[0].text);
  note.lines[0].text = "line\n".repeat(50000);
  expect(() => planImageExport([note], text => text.length * 8)).toThrow(/too large/i);
});
