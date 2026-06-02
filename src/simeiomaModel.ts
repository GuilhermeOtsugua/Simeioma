export type ReminderMode = "periodic" | "timeOfDay";
export type ReminderTarget = "all" | "important" | "tasks" | "attention";
export type ExportFormat = "txt" | "markdown" | "png" | "jpeg";
export type NoteLayout = "single" | "two-column";
export type SketchPointRecord = { x: number; y: number };
export type SketchStrokeRecord =
  | { type: "freehand"; points: SketchPointRecord[] }
  | { type: "line"; start: SketchPointRecord; end: SketchPointRecord }
  | { type: "circle"; center: SketchPointRecord; radius: number }
  | { type: "rect"; x: number; y: number; width: number; height: number };

export type NoteLine = {
  id: string;
  text: string;
  task: boolean;
  crossed: boolean;
};

export type Note = {
  id: string;
  title: string;
  colorKey: string;
  important: boolean;
  lines: NoteLine[];
  layout?: NoteLayout;
  rightText?: string;
  sketchData?: string;
  sketchStrokes?: SketchStrokeRecord[];
  createdAt: string;
  updatedAt: string;
  viewedAt?: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
};

export type Settings = {
  exportPath: string;
  copyAfterSave: boolean;
  exportFormat: ExportFormat;
  strikeKeybind: string;
  scribbleKeybind: string;
  copyNoteKeybind: string;
  newNoteKeybind: string;
  hideNotesKeybind: string;
  reminderMode: ReminderMode;
  reminderValue: string;
  reminderTarget: ReminderTarget;
  remindersEnabled: boolean;
  lastReminderAt?: string;
};

export type AppState = {
  notes: Note[];
  launcher: {
    colorIndex: number;
    corner: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  };
  settings: Settings;
  lastNoteSize?: { width: number; height: number };
};

export type ReminderNotice = {
  title: string;
  body: string;
  noteIds: string[];
};

export type NoteColor = {
  key: string;
  name: string;
  bg: string;
  ink: string;
  line: string;
};

export const DESKTOP_ICON = 48;
export const STRIP_HIT_WIDTH = 18;
export const STRIP_HOVER_WIDTH = 32;
export const STRIP_HEIGHT = DESKTOP_ICON * 2;
export const MENU_WIDTH = 44;
export const MENU_HEIGHT = 184;
export const DEFAULT_NOTE_SIZE = DESKTOP_ICON * 4;
export const NOTE_TITLE_HEIGHT = 38;
export const MAX_NOTES = 10;

export const NOTE_COLORS: NoteColor[] = [
  { key: "canary", name: "Canary", bg: "#FFEBA1", ink: "#33270B", line: "#E0C967" },
  { key: "classic", name: "Classic", bg: "#FFD100", ink: "#2A2100", line: "#D9B000" },
  { key: "pink", name: "Pink", bg: "#FFD3E2", ink: "#391827", line: "#E8A9C0" },
  { key: "papaya", name: "Papaya", bg: "#FFC8A2", ink: "#3A1F10", line: "#E7A77B" },
  { key: "mint", name: "Mint", bg: "#D7F0C8", ink: "#183014", line: "#B5D9A6" },
  { key: "aqua", name: "Aqua", bg: "#C7EEF4", ink: "#113037", line: "#9FD6DF" },
  { key: "sky", name: "Sky", bg: "#C9E0FF", ink: "#142844", line: "#A9C4EA" },
  { key: "lilac", name: "Lilac", bg: "#DDD1FF", ink: "#291D45", line: "#BFAFE9" },
];

export const DEFAULT_SETTINGS: Settings = {
  exportPath: "",
  copyAfterSave: true,
  exportFormat: "markdown",
  strikeKeybind: "Ctrl + left click",
  scribbleKeybind: "Ctrl + right click",
  copyNoteKeybind: "Ctrl + Shift + C",
  newNoteKeybind: "Ctrl + N",
  hideNotesKeybind: "Ctrl + Shift + H",
  reminderMode: "periodic",
  reminderValue: "1",
  reminderTarget: "attention",
  remindersEnabled: true,
};

export function createInitialState(colorIndex: number): AppState {
  return {
    notes: [],
    launcher: { colorIndex, corner: "bottom-right" },
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function resetNotesForDebug(state: AppState): AppState {
  return { ...state, notes: [] };
}

export function nextNotePosition(index: number, origin: { x: number; y: number }) {
  const stackIndex = index % MAX_NOTES;
  return {
    x: origin.x + stackIndex * 16,
    y: origin.y + stackIndex * NOTE_TITLE_HEIGHT,
  };
}

export function nextNotePositionFromLatest(latest: Note | undefined, origin: { x: number; y: number }) {
  if (!latest?.position) return origin;
  return {
    x: latest.position.x,
    y: latest.position.y + NOTE_TITLE_HEIGHT + 3,
  };
}

export function createNoteInState(
  state: AppState,
  input: {
    id: string;
    lineId: string;
    now: string;
    origin?: { x: number; y: number };
  },
) {
  if (state.notes.length >= MAX_NOTES) {
    return { state, note: null };
  }

  const colorIndex = state.launcher.colorIndex % NOTE_COLORS.length;
  const color = NOTE_COLORS[colorIndex];
  const note: Note = {
    id: input.id,
    title: "",
    colorKey: color.key,
    important: false,
    lines: [{ id: input.lineId, text: "", task: false, crossed: false }],
    createdAt: input.now,
    updatedAt: input.now,
    viewedAt: input.now,
    position: input.origin ? nextNotePositionFromLatest(state.notes.at(-1), input.origin) : undefined,
    size: state.lastNoteSize ?? state.notes.at(-1)?.size ?? { width: DEFAULT_NOTE_SIZE, height: DEFAULT_NOTE_SIZE },
  };

  return {
    note,
    state: {
      ...state,
      notes: [...state.notes, note],
      launcher: { ...state.launcher, colorIndex: (colorIndex + 1) % NOTE_COLORS.length },
    },
  };
}

export function reminderNotes(notes: Note[], target: ReminderTarget) {
  if (target === "important") return notes.filter((note) => note.important);
  if (target === "tasks") return notes.filter(hasOpenTasks);
  if (target === "attention") return notes.filter((note) => note.important || hasOpenTasks(note));
  return notes;
}

export function unviewedReminderCount(notes: Note[], target: ReminderTarget) {
  return unviewedReminderNotes(notes, target).length;
}

export function unviewedReminderNotes(notes: Note[], target: ReminderTarget) {
  return reminderNotes(notes, target).filter((note) => {
    if (!note.viewedAt) return true;
    return new Date(note.updatedAt).getTime() > new Date(note.viewedAt).getTime();
  });
}

export function markNoteViewed(state: AppState, noteId: string, viewedAt: string): AppState {
  return {
    ...state,
    notes: state.notes.map((note) => (note.id === noteId ? { ...note, viewedAt } : note)),
  };
}

export function updateNotePosition(
  state: AppState,
  noteId: string,
  position: { x: number; y: number },
): AppState {
  return {
    ...state,
    notes: state.notes.map((note) => (note.id === noteId ? { ...note, position } : note)),
  };
}

export function updateNoteSize(
  state: AppState,
  noteId: string,
  size: { width: number; height: number },
): AppState {
  return {
    ...state,
    lastNoteSize: size,
    notes: state.notes.map((note) => (note.id === noteId ? { ...note, size } : note)),
  };
}

export function isReminderDue(settings: Settings, now = new Date()) {
  const last = settings.lastReminderAt ? new Date(settings.lastReminderAt) : null;
  if (settings.reminderMode === "timeOfDay") {
    const [hour, minute] = parseTimeOfDay(settings.reminderValue);
    if (hour === null || minute === null) return false;
    const alreadyRemindedToday =
      last?.getFullYear() === now.getFullYear() &&
      last.getMonth() === now.getMonth() &&
      last.getDate() === now.getDate();
    return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute)
      ? !alreadyRemindedToday
      : false;
  }

  const hours = Number(normalizePeriodicHours(settings.reminderValue));
  return !last || now.getTime() - last.getTime() >= hours * 60 * 60000;
}

export function normalizePeriodicHours(value: string) {
  const hours = Number(value);
  if (!Number.isFinite(hours)) return "1";
  return String(Math.max(0.25, hours));
}

export function periodicLabel(value: string) {
  const totalMinutes = Math.round(Number(normalizePeriodicHours(value)) * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}min`);
  return `Every ${parts.join(" ") || "15min"}`;
}

export function normalizeTimeOfDay(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 4).padStart(4, "0");
  const hour = Math.min(23, Number(digits.slice(0, 2)));
  const minute = Math.min(59, Number(digits.slice(2, 4)));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseTimeOfDay(value: string): [number | null, number | null] {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return [null, null];
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return [null, null];
  return [hour, minute];
}

function hasOpenTasks(note: Note) {
  return note.lines.some((line) => line.task && !line.crossed);
}
