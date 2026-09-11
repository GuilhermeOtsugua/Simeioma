import { listen } from "@tauri-apps/api/event";
import { sleep } from "./windowInteractions";
import { type AppState, type Note, DEFAULT_NOTE_SIZE } from "./simeiomaModel";
import { getAllWebviewWindows, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invokeObserved as invoke } from "./diagnostics";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { loadState } from "./persistence";
import { readSpawnContext, waitForWindowCreated, placeCreatedWindow } from "./windowSpawning";

let noteCreationQueue: Promise<void> = Promise.resolve();

export function enqueueNoteCreation(create: () => Promise<void>) {
  noteCreationQueue = noteCreationQueue.then(create, create);
  return noteCreationQueue;
}

export function noteLabel(id: string) {
  return `note-${id}`;
}

export async function prepareNoteWindowsForReveal(noteIds: string[]) {
  if (!noteIds.length) return;
  const pending = new Set(noteIds);
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const unlisten = await listen<{ noteId: string }>("simeioma:note-window-ready", ({ payload }) => {
    pending.delete(payload.noteId);
    if (!pending.size) resolveReady?.();
  });
  try {
    await Promise.all(noteIds.map((id) => openNoteWindow(id, { visible: false, focus: false })));
    if (pending.size) await Promise.race([ready, sleep(1500)]);
  } finally {
    unlisten();
  }
}

export async function noteWindowStatesInState(state: AppState) {
  const [allWindows, visibleLabels] = await Promise.all([
    getAllWebviewWindows(),
    invoke<string[]>("visible_note_window_labels"),
  ]);
  const noteWindows = allWindows.filter((noteWindow) => noteWindow.label.startsWith("note-"));
  const windowsByLabel = new Map(noteWindows.map((noteWindow) => [noteWindow.label, noteWindow]));
  const visible = new Set(visibleLabels);
  return state.notes.map((note) => {
    const label = noteLabel(note.id);
    return { note, noteWindow: windowsByLabel.get(label), visible: visible.has(label) };
  });
}

export async function visibleNotesInState(state: AppState): Promise<Note[]> {
  const windowStates = await noteWindowStatesInState(state);
  return windowStates.filter(({ visible }) => visible).map(({ note }) => note);
}

export async function configureNoteWindow(noteId: string, active = () => true) {
  if (!isTauri()) return;
  const appWindow = getCurrentWindow();
  const note = loadState().notes.find((item) => item.id === noteId);
  const size = note?.size ?? { width: DEFAULT_NOTE_SIZE, height: DEFAULT_NOTE_SIZE };
  await appWindow.setSkipTaskbar(true);
  if (active()) await appWindow.setSize(new LogicalSize(size.width, size.height));
}

async function noteSpawnOrigin() {
  return (await readSpawnContext())?.origin ?? { x: 160, y: 160 };
}

export async function openNoteWindow(
  id: string,
  options: { visible?: boolean; focus?: boolean; spawnScale?: number } = {},
) {
  if (!isTauri()) return;
  const visible = options.visible ?? true;
  const focus = options.focus ?? visible;
  const existing = await WebviewWindow.getByLabel(noteLabel(id));
  if (existing) {
    if (visible) await existing.show();
    if (focus) await existing.setFocus();
    return;
  }

  const note = loadState().notes.find((item) => item.id === id);
  const { x, y } = note?.position ?? await noteSpawnOrigin();

  const size = note?.size ?? { width: DEFAULT_NOTE_SIZE, height: DEFAULT_NOTE_SIZE };

  const webview = new WebviewWindow(noteLabel(id), {
    url: `index.html?role=note&id=${encodeURIComponent(id)}&autofocus=${focus ? "1" : "0"}`,
    title: "Simeioma Note",
    x,
    y,
    width: size.width,
    height: size.height,
    minWidth: 176,
    minHeight: 176,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    shadow: false,
    visible: false,
    focus: false,
  });

  await waitForWindowCreated(webview);
  await placeCreatedWindow(webview, { x, y }, size, options.spawnScale);
  if (visible) await webview.show();
  if (focus) await webview.setFocus();
  if (focus) void invoke("raise_control", { label: "main" });
}

export async function closeAllNoteWindows() {
  if (!isTauri()) return;
  const noteWindows = (await getAllWebviewWindows()).filter((noteWindow) => noteWindow.label.startsWith("note-"));
  await Promise.all(noteWindows.map((noteWindow) => noteWindow.close()));
}

export async function hideAllNoteWindows() {
  if (!isTauri()) return;
  const noteWindows = (await getAllWebviewWindows()).filter((noteWindow) => noteWindow.label.startsWith("note-"));
  await Promise.all(noteWindows.map((noteWindow) => noteWindow.hide()));
}
