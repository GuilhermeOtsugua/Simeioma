import { type Note, type AppState, markNoteViewed, updateNotePosition, updateNoteSize } from "./simeiomaModel";
import { updateState } from "./persistence";

export function updateNote(
  noteId: string,
  updater: (note: Note) => Note,
  options: { broadcast?: boolean; setState?: (state: AppState) => void } = {},
) {
  return updateState(
    (state) => ({
      ...state,
      notes: state.notes.map((note) => (note.id === noteId ? updater(note) : note)),
    }),
    options,
  );
}

export function persistNoteBody(noteId: string, lineId: string, text: string) {
  return updateNote(
    noteId,
    (note) => ({
      ...note,
      updatedAt: new Date().toISOString(),
      lines: [{ id: note.lines[0]?.id ?? lineId, text, task: false, crossed: false }],
    }),
    { broadcast: true },
  );
}

export function persistNoteRightText(noteId: string, rightText: string) {
  return updateNote(
    noteId,
    (note) => ({
      ...note,
      rightText,
      updatedAt: new Date().toISOString(),
    }),
    { broadcast: true },
  );
}

export function markCurrentNoteViewed(noteId: string, setState?: (state: AppState) => void, active = () => true) {
  return updateState((state) => active() ? markNoteViewed(state, noteId, new Date().toISOString()) : state, { setState });
}

export function persistNotePosition(noteId: string, position: { x: number; y: number }, setState?: (state: AppState) => void) {
  return updateState((state) => updateNotePosition(state, noteId, position), { setState });
}

export function persistNoteSize(noteId: string, size: { width: number; height: number }, setState?: (state: AppState) => void) {
  return updateState((state) => updateNoteSize(state, noteId, size), { setState });
}

export function createId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
