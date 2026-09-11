import { expect, it } from "vitest";
import { noteBody } from "./noteContent";
import { createInitialState, createNoteInState, reminderNotes } from "./simeiomaModel";

it("uses canonical Markdown tasks in either column and preserves legacy flags", () => {
  const note = createNoteInState(createInitialState(0), { id: "a", lineId: "l", now: "2026-09-09" }).note!;
  note.lines[0].text = "- [ ] pending";
  expect(reminderNotes([note], "tasks")).toHaveLength(1);
  note.lines[0].text = "- [x] done";
  expect(reminderNotes([note], "tasks")).toHaveLength(0);
  note.layout = "two-column"; note.rightText = "- [ ] right";
  expect(reminderNotes([note], "tasks")).toHaveLength(1);
  note.rightText = "```\n- [ ] code, not a task\n```";
  expect(reminderNotes([note], "tasks")).toHaveLength(0);
  note.lines[0] = { id: "l", text: "legacy", task: true, crossed: false };
  expect(noteBody(note)).toBe("- [ ] legacy");
  expect(reminderNotes([note], "tasks")).toHaveLength(1);
});
