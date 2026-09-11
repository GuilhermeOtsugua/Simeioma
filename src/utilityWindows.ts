import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { invokeObserved as invoke, recordDiagnostic } from "./diagnostics";
import { type UtilityRole, rectsOverlap, planUtilityWindows, UTILITY_MIN_SIZE } from "./spawnPlacement";
import { configureLauncherWindow } from "./launcherNative";
import { readSpawnContext, windowRectInWorkArea, waitForWindowCreated, placeCreatedWindow } from "./windowSpawning";
import { type WindowRect } from "./windowGeometry";
import { DEFAULT_NOTE_SIZE } from "./simeiomaModel";
import { message as showMessage } from "@tauri-apps/plugin-dialog";

let utilityCreationQueue: Promise<void> = Promise.resolve();

export async function configureUtilityWindow() {
  if (!isTauri()) return;
  const appWindow = getCurrentWindow();
  await appWindow.setSkipTaskbar(false);
  await appWindow.setResizable(true);
}

async function restoreAndFocusUtilityWindow(window: WebviewWindow) {
  await invoke("restore_utility_window", { label: window.label });
}

export function openSettingsWindow() { return openUtilityWindow("settings"); }

export function openNotesListWindow() { return openUtilityWindow("notes-list"); }

function openUtilityWindow(role: UtilityRole) {
  // Serialize creation and recheck existence inside the queue, including tray requests.
  const result = utilityCreationQueue.then(() => createUtilityWindow(role));
  utilityCreationQueue = result.catch(() => undefined);
  return result;
}

async function createUtilityWindow(role: UtilityRole) {
  if (!isTauri()) return;
  const existing = await WebviewWindow.getByLabel(role);
  if (existing) {
    await restoreAndFocusUtilityWindow(existing);
    return;
  }
  await configureLauncherWindow.whenIdle();
  const context = await readSpawnContext();
  if (!context) return;
  const desktop = { x: context.work.left, y: context.work.top,
    width: context.work.right - context.work.left, height: context.work.bottom - context.work.top };
  const notes: WindowRect[] = [];
  const utilities: Partial<Record<UtilityRole, WindowRect>> = {};
  for (const window of await getAllWebviewWindows()) {
    if (window.label === "settings" || window.label === "notes-list") {
      // Keep an existing utility fixed even when minimized; opening its sibling must not reserve its space twice.
      utilities[window.label] = await windowRectInWorkArea(window, context.work);
    } else if (window.label.startsWith("note-") && await window.isVisible() && !await window.isMinimized()) {
      const rect = await windowRectInWorkArea(window, context.work);
      if (rectsOverlap(rect, desktop)) notes.push(rect);
    }
  }
  const plan = planUtilityWindows({ work: context.work, launcher: context.launcher, notes,
    reservedNote: { ...context.origin, width: DEFAULT_NOTE_SIZE, height: DEFAULT_NOTE_SIZE }, existing: utilities });
  if (!plan) {
    recordDiagnostic("utility-placement-unavailable", { roleCode: role === "settings" ? 0 : 1 });
    await showMessage("There is not enough free space for this view without covering another Simeioma window. Move or resize a window, then try again.", { title: "Simeioma", kind: "info" });
    return;
  }
  recordDiagnostic("utility-placement", { roleCode: role === "settings" ? 0 : 1,
    modeCode: plan.mode === "row" ? 0 : plan.mode === "reflow" ? 1 : 2, requested: plan[role] });
  const webview = new WebviewWindow(role, {
    url: role === "settings" ? "index.html?role=settings" : "index.html?role=list",
    title: role === "settings" ? "Simeioma Settings" : "Simeioma Notes",
    ...plan[role],
    minWidth: UTILITY_MIN_SIZE.width,
    minHeight: UTILITY_MIN_SIZE.height,
    decorations: false,
    transparent: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    shadow: false,
    visible: false,
    focus: false,
  });
  await waitForWindowCreated(webview);
  await placeCreatedWindow(webview, plan[role], plan[role], context.work.scale);
  await webview.show();
  await webview.setFocus();
}
