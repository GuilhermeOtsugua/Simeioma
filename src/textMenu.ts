import { isTauri } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { primaryMonitor, getCurrentWindow } from "@tauri-apps/api/window";

export async function openTextMenuPopupWindow(noteId: string, field: "body" | "right", clientX: number, clientY: number, hasSelection: boolean, start: number, end: number) {
  if (!isTauri()) return;
  const existing = await WebviewWindow.getByLabel("text-menu-popup");
  await existing?.close();
  const { x, y, width, height } = await popupAtCurrentWindowPoint(clientX, clientY, 170, 250);
  const webview = new WebviewWindow("text-menu-popup", {
    url: `index.html?role=text-menu&noteId=${encodeURIComponent(noteId)}&field=${encodeURIComponent(field)}&hasSelection=${hasSelection ? "1" : "0"}&start=${start}&end=${end}`,
    title: "Simeioma Text Menu",
    x,
    y,
    width,
    height,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    shadow: false,
    focus: false,
    focusable: false,
    visible: true,
  });
  await webview.once("tauri://created", () => undefined);
}

async function popupAtCurrentWindowPoint(clientX: number, clientY: number, width: number, height: number) {
  const fallback = { x: clientX, y: clientY, width, height };
  if (!isTauri()) return fallback;
  const monitor = await primaryMonitor();
  if (!monitor) return fallback;
  const scale = monitor.scaleFactor || 1;
  const work = monitor.workArea;
  const position = await getCurrentWindow().outerPosition();
  const workLeft = work.position.x / scale;
  const workTop = work.position.y / scale;
  const workRight = (work.position.x + work.size.width) / scale;
  const workBottom = (work.position.y + work.size.height) / scale;
  return {
    x: clamp(position.x / scale + clientX, workLeft + 12, workRight - width - 12),
    y: clamp(position.y / scale + clientY, workTop + 12, workBottom - height - 12),
    width,
    height,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
