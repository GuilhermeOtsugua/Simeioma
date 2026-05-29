import { describe, expect, test } from "vitest";
import {
  DEFAULT_SETTINGS,
  MAX_NOTES,
  createInitialState,
  createNoteInState,
  isReminderDue,
  markNoteViewed,
  normalizePeriodicHours,
  nextNotePosition,
  periodicLabel,
  updateNotePosition,
  updateNoteSize,
  reminderNotes,
  resetNotesForDebug,
  unviewedReminderCount,
  unviewedReminderNotes,
  type Note,
} from "./simeiomaModel";

describe("Simeioma model", () => {
  test("defaults reminders to hourly attention checks", () => {
    expect(DEFAULT_SETTINGS.remindersEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.reminderMode).toBe("periodic");
    expect(DEFAULT_SETTINGS.reminderValue).toBe("1");
    expect(DEFAULT_SETTINGS.reminderTarget).toBe("attention");
  });

  test("formats periodic reminder values as short human labels", () => {
    expect(periodicLabel("0.5")).toBe("Every 30min");
    expect(periodicLabel("1")).toBe("Every 1h");
    expect(periodicLabel("1.5")).toBe("Every 1h 30min");
  });

  test("normalizes periodic reminder values as hour numbers", () => {
    expect(normalizePeriodicHours("0.5")).toBe("0.5");
    expect(normalizePeriodicHours("bad")).toBe("1");
    expect(normalizePeriodicHours("0")).toBe("0.25");
  });

  test("creates at most ten notes without advancing color after the cap", () => {
    let state = createInitialState(0);

    for (let index = 0; index < MAX_NOTES; index += 1) {
      const result = createNoteInState(state, {
        id: `note-${index}`,
        lineId: `line-${index}`,
        now: "2026-05-18T12:00:00.000Z",
      });
      expect(result.note).not.toBeNull();
      state = result.state;
    }

    const cappedColorIndex = state.launcher.colorIndex;
    const result = createNoteInState(state, {
      id: "note-over-cap",
      lineId: "line-over-cap",
      now: "2026-05-18T12:00:00.000Z",
    });

    expect(result.note).toBeNull();
    expect(result.state.notes).toHaveLength(MAX_NOTES);
    expect(result.state.launcher.colorIndex).toBe(cappedColorIndex);
  });

  test("resets notes for debug while preserving settings and launcher", () => {
    const state = createInitialState(3);
    const result = createNoteInState(state, {
      id: "note-1",
      lineId: "line-1",
      now: "2026-05-18T12:00:00.000Z",
    });

    const reset = resetNotesForDebug(result.state);

    expect(reset.notes).toEqual([]);
    expect(reset.settings).toBe(result.state.settings);
    expect(reset.launcher).toBe(result.state.launcher);
  });

  test("legacy indexed note positions still cascade for fallback placement", () => {
    expect(nextNotePosition(0, { x: 100, y: 200 })).toEqual({ x: 100, y: 200 });
    expect(nextNotePosition(1, { x: 100, y: 200 })).toEqual({ x: 116, y: 238 });
    expect(nextNotePosition(2, { x: 100, y: 200 })).toEqual({ x: 132, y: 276 });
  });

  test("stacks a new note from the latest note position when available", () => {
    const state = createInitialState(0);
    const first = createNoteInState(state, {
      id: "first",
      lineId: "first-line",
      now: "2026-05-18T12:00:00.000Z",
      origin: { x: 100, y: 200 },
    }).state;

    const second = createNoteInState(first, {
      id: "second",
      lineId: "second-line",
      now: "2026-05-18T12:01:00.000Z",
      origin: { x: 400, y: 500 },
    });

    expect(second.note?.position).toEqual({ x: 100, y: 241 });
  });

  test("new notes inherit the latest note size", () => {
    const first = createNoteInState(createInitialState(0), {
      id: "first",
      lineId: "first-line",
      now: "2026-05-18T12:00:00.000Z",
    }).state;
    const resized = updateNoteSize(first, "first", { width: 320, height: 240 });

    const second = createNoteInState(resized, {
      id: "second",
      lineId: "second-line",
      now: "2026-05-18T12:01:00.000Z",
    });

    expect(second.note?.size).toEqual({ width: 320, height: 240 });
  });

  test("attention reminders include important notes and open task notes", () => {
    const notes: Note[] = [
      note({ id: "important", important: true }),
      note({ id: "task", lines: [{ id: "task-line", text: "todo", task: true, crossed: false }] }),
      note({ id: "done", lines: [{ id: "done-line", text: "done", task: true, crossed: true }] }),
      note({ id: "plain" }),
    ];

    expect(reminderNotes(notes, "attention").map((item) => item.id)).toEqual(["important", "task"]);
  });

  test("unviewed reminder count decreases once notes are viewed", () => {
    const notes: Note[] = [
      note({ id: "new-important", important: true, updatedAt: "2026-05-18T13:00:00.000Z" }),
      note({
        id: "viewed-task",
        updatedAt: "2026-05-18T12:00:00.000Z",
        viewedAt: "2026-05-18T12:05:00.000Z",
        lines: [{ id: "task-line", text: "todo", task: true, crossed: false }],
      }),
    ];

    expect(unviewedReminderCount(notes, "attention")).toBe(1);
  });

  test("returns the unviewed reminder notes for badge routing", () => {
    const notes: Note[] = [
      note({
        id: "viewed-important",
        important: true,
        updatedAt: "2026-05-18T12:00:00.000Z",
        viewedAt: "2026-05-18T12:05:00.000Z",
      }),
      note({
        id: "unviewed-important",
        important: true,
        updatedAt: "2026-05-18T13:00:00.000Z",
        viewedAt: "2026-05-18T12:05:00.000Z",
      }),
    ];

    expect(unviewedReminderNotes(notes, "attention").map((item) => item.id)).toEqual(["unviewed-important"]);
  });

  test("marks a note as viewed without changing unrelated notes", () => {
    const state = {
      ...createInitialState(0),
      notes: [
        note({ id: "first", viewedAt: "2026-05-18T10:00:00.000Z" }),
        note({ id: "second", viewedAt: "2026-05-18T10:01:00.000Z" }),
      ],
    };

    const next = markNoteViewed(state, "second", "2026-05-18T11:00:00.000Z");

    expect(next.notes.find((item) => item.id === "first")?.viewedAt).toBe("2026-05-18T10:00:00.000Z");
    expect(next.notes.find((item) => item.id === "second")?.viewedAt).toBe("2026-05-18T11:00:00.000Z");
  });

  test("updates a moved note position for future stacking", () => {
    const state = {
      ...createInitialState(0),
      notes: [note({ id: "moved", position: { x: 100, y: 200 } })],
    };

    const next = updateNotePosition(state, "moved", { x: 320, y: 410 });

    expect(next.notes[0].position).toEqual({ x: 320, y: 410 });
  });

  test("periodic reminders become due after the selected hour interval", () => {
    expect(
      isReminderDue(
        { ...DEFAULT_SETTINGS, reminderMode: "periodic", reminderValue: "0.5", lastReminderAt: "2026-05-18T12:00:00.000Z" },
        new Date("2026-05-18T12:30:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isReminderDue(
        { ...DEFAULT_SETTINGS, reminderMode: "periodic", reminderValue: "0.5", lastReminderAt: "2026-05-18T12:10:00.000Z" },
        new Date("2026-05-18T12:30:00.000Z"),
      ),
    ).toBe(false);
  });

  test("time of day reminders become due once per selected day time", () => {
    expect(
      isReminderDue(
        { ...DEFAULT_SETTINGS, reminderMode: "timeOfDay", reminderValue: "09:30", lastReminderAt: "2026-05-17T09:30:00.000Z" },
        new Date(2026, 4, 18, 9, 30),
      ),
    ).toBe(true);
    expect(
      isReminderDue(
        { ...DEFAULT_SETTINGS, reminderMode: "timeOfDay", reminderValue: "09:30", lastReminderAt: "2026-05-18T09:30:00.000Z" },
        new Date(2026, 4, 18, 10, 0),
      ),
    ).toBe(false);
  });
});

function note(patch: Partial<Note>): Note {
  return {
    id: "note",
    title: "",
    colorKey: "canary",
    important: false,
    lines: [],
    createdAt: "2026-05-18T12:00:00.000Z",
    updatedAt: "2026-05-18T12:00:00.000Z",
    ...patch,
  };
}
