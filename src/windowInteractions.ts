import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { stateChannel as channel } from "./persistence";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { startObservedWindowDrag, invokeObserved as invoke } from "./diagnostics";

export const HOLD_TO_DRAG_MS = 0;

export async function closeCurrentWindow() {
  if (!isTauri()) return;
  const current = getCurrentWindow();
  if (current.label.startsWith("note-")) {
    channel?.postMessage({ type: "note-closed", noteId: current.label.slice(5) });
  }
  await current.close();
}

export async function closeAuxiliaryWindows() {
  if (!isTauri()) return;
  for (const label of ["settings", "notes-list"]) {
    const utilityWindow = await WebviewWindow.getByLabel(label);
    await utilityWindow?.close();
  }
}

export function preventUtilityClipboard(event: ClipboardEvent) {
  event.preventDefault();
}

export function startUtilityDrag(event: PointerEvent) {
  if (!isTauri()) return;
  const target = event.target as HTMLElement;
  if (target.closest("button, input, select, textarea")) return;
  void startObservedWindowDrag();
}

export async function isLeftMouseDown() {
  if (!isTauri()) return false;
  try {
    return Boolean(await invoke("is_left_mouse_down"));
  } catch {
    return false;
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
