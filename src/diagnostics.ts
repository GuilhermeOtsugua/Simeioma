import { invoke as nativeInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createAnomalyDetector, diagnosticStorage, isRectClipped, summarizeDiagnosticState, type DiagnosticRect } from "./diagnosticsModel";
import { createDragDiagnostics } from "./diagnosticsLifecycle";
import type { AppState } from "./simeiomaModel";

declare global {
  interface Window {
    __SIMEIOMA_DEBUG__?: Readonly<{ cleanSession: boolean; session: string }>;
    __SIMEIOMA_DIAGNOSTICS__?: Readonly<{
      snapshot: () => unknown;
      exportBundle: () => Promise<string>;
      status: () => { transportFailures: number; dropped: number; rendererId: number; instanceId?: number };
    }>;
  }
}

// Injected by the debug-only Rust plugin before page scripts, not by Vite's DEV flag.
export const diagnosticsEnabled = typeof window !== "undefined" && !!window.__SIMEIOMA_DEBUG__;
export const diagnosticStorageKey = diagnosticStorage(diagnosticsEnabled, !!window.__SIMEIOMA_DEBUG__?.cleanSession);
export const diagnosticRevisionKey = `${diagnosticStorageKey}:revision`;
export const diagnosticChannelName = diagnosticStorageKey === "simeioma:v1" ? "simeioma-sync" : "simeioma-debug-clean-sync";

if (diagnosticsEnabled && window.__SIMEIOMA_DEBUG__?.cleanSession && !new URLSearchParams(location.search).get("role")) {
  const marker = "simeioma:clean-session";
  if (sessionStorage.getItem(marker) !== window.__SIMEIOMA_DEBUG__.session) {
    localStorage.removeItem(diagnosticStorageKey);
    localStorage.removeItem(diagnosticRevisionKey);
    sessionStorage.setItem(marker, window.__SIMEIOMA_DEBUG__.session);
  }
}

const rendererId = diagnosticsEnabled ? 1 + Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER - 1)) : 0;
let identity: Promise<number> | undefined;
let instanceId: number | undefined;
function registeredInstance() {
  return identity ??= nativeInvoke<number>("debug_register", { rendererId })
    .then((id) => { instanceId = id; return id; })
    .catch((error) => { identity = undefined; throw error; });
}

let sequence = 0;
let pending = 0;
let transportFailures = 0;
let dropped = 0;
let launcherReader: (() => Record<string, unknown>) | undefined;
let stateReader: (() => AppState) | undefined;
const anomalyDetector = createAnomalyDetector();
let watchdogNeeded = false;
let lastMovedAt = -Infinity;
let expectedPosition: Record<string, unknown> | undefined;
let lastNative: Awaited<ReturnType<typeof readNativeGeometry>> | undefined;
let dragTracker = makeDragTracker();
let captureTimer: number | undefined;
let lastSaveEvent = -Infinity;
let captureEpoch = 0;
let mounted = false;

export function setLauncherDiagnosticReader(reader: () => Record<string, unknown>) {
  if (diagnosticsEnabled) launcherReader = reader;
}

export function recordDiagnostic(event: string, data: Record<string, unknown> = {}, noteLabels?: string[]) {
  if (!diagnosticsEnabled) return;
  if (event === "position-requested") expectedPosition = data.requested as Record<string, unknown>;
  if (event === "drag-start") expectedPosition = undefined;
  if (event === "state-saved") {
    if (performance.now() - lastSaveEvent < 250) return;
    lastSaveEvent = performance.now();
  }
  if (pending >= 100) { dropped += 1; return; }
  pending += 1;
  const payload = { ...data, rendererId, emittedAt: Date.now(), clientSequence: ++sequence };
  void registeredInstance().then((instanceId) => nativeInvoke("debug_record", {
    event, data: payload, noteLabels, instanceId,
  })).catch(() => { transportFailures += 1; }).finally(() => { pending -= 1; });
}

// Only command identity and outcome; never record command arguments or error text.
const errorKinds = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "DOMException"];
const errorKind = (error: unknown) => error instanceof Error ? errorKinds.indexOf(error.name) : -1;
const commandNames = ["save_text_file", "save_binary_file", "visible_note_window_labels",
  "set_note_windows_visibility", "restore_utility_window", "set_utility_focus_state", "raise_control",
  "is_left_mouse_down", "read_clipboard_text", "write_clipboard_text", "take_settings_request", "window_spawn_geometry"];
export async function invokeObserved<T>(command: string, args?: InvokeArgs): Promise<T> {
  try {
    const result = await nativeInvoke<T>(command, args);
    if (command === "set_note_windows_visibility" && args && !Array.isArray(args) && !(args instanceof ArrayBuffer)) {
      recordDiagnostic("visibility-changed", { visible: (args as Record<string, unknown>).visible === true });
    }
    return result;
  } catch (error) {
    recordDiagnostic("native-command-failed", { commandId: commandNames.indexOf(command), errorKind: errorKind(error) });
    throw error;
  }
}

export async function beforeDiagnosticResize(operationId: number) {
  if (!diagnosticsEnabled) return;
  // Instrumentation transport failure must not break normal application behavior.
  const injection = await nativeInvoke<{ delayMs: number; fail: boolean }>("debug_before_resize", { operationId })
    .catch(() => { transportFailures += 1; return { delayMs: 0, fail: false }; });
  if (injection.delayMs) await new Promise((resolve) => setTimeout(resolve, Math.min(2000, injection.delayMs)));
  if (injection.fail) throw new Error("Injected launcher resize failure");
}

function rect(element: Element): DiagnosticRect {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

function readSnapshot(requestId = 0) {
  const viewport = { x: 0, y: 0, width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
  const dialogElement = document.querySelector('[role="dialog"], [role="alertdialog"]');
  let dialog: Record<string, unknown> | undefined;
  if (dialogElement) {
    const bounds = rect(dialogElement);
    let clippingAncestors = 0;
    let clipped = isRectClipped(bounds, viewport);
    for (let ancestor = dialogElement.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const clipX = /hidden|clip|scroll|auto/.test(style.overflowX);
      const clipY = /hidden|clip|scroll|auto/.test(style.overflowY);
      if (clipX || clipY) {
        clippingAncestors += 1;
        const parent = rect(ancestor);
        const axisBounds = {
          x: clipX ? parent.x : bounds.x, y: clipY ? parent.y : bounds.y,
          width: clipX ? parent.width : bounds.width, height: clipY ? parent.height : bounds.height,
        };
        clipped ||= isRectClipped(bounds, axisBounds);
      }
    }
    dialog = { ...bounds, clipped, clippingAncestors };
  }
  const state = stateReader?.();
  const revision = Number(localStorage.getItem(diagnosticRevisionKey)) || 0;
  const noteId = new URLSearchParams(window.location?.search ?? "").get("id");
  const currentNote = state?.notes.find((note) => note.id === noteId);
  return {
    data: {
      capturedAt: Date.now(), requestId, viewport, dialog,
      focused: document.hasFocus(), visible: document.visibilityState === "visible",
      launcher: launcherReader?.(), drag: dragTracker.status(), motionAgeMs: Number.isFinite(lastMovedAt) ? performance.now() - lastMovedAt : 0,
      native: lastNative,
      persistence: state ? { ...summarizeDiagnosticState(state, revision), position: currentNote?.position, size: currentNote?.size } : undefined,
      transportFailures, dropped,
    },
    noteLabels: state?.notes.map((note) => `note-${note.id}`) ?? [],
  };
}

function differs(expected?: Record<string, unknown>, actual?: Record<string, unknown>) {
  return !!expected && !!actual && Object.entries(expected).some(([key, value]) =>
    typeof value === "number" && typeof actual[key] === "number" && Math.abs(value - (actual[key] as number)) > 1);
}

function checkAnomalies(snapshot: ReturnType<typeof readSnapshot>) {
  const { data } = snapshot;
  const launcher = data.launcher;
  const requested = launcher?.requested as Record<string, unknown> | undefined;
  const clipped = data.dialog?.clipped === true;
  const inconsistent = clipped || differs(requested, data.viewport) || differs(requested, data.native?.actual)
    || differs(expectedPosition, data.native?.position) || differs(data.persistence?.position, data.native?.position)
    || differs(data.persistence?.size, data.native?.actual);
  const signature = inconsistent ? JSON.stringify([clipped ? data.dialog : null, requested, expectedPosition,
    data.viewport, data.native?.actual, data.native?.position, data.persistence?.position, data.persistence?.size]) : "";
  watchdogNeeded = !!signature;
  const events = anomalyDetector.check({
    busy: launcher?.busy === true, operationId: Number(launcher?.operationId ?? 0),
    operationAgeMs: Number(launcher?.operationAgeMs ?? 0),
    dragging: data.drag.dragging || launcher?.dragging === true,
    settled: launcher?.configuring !== true && performance.now() - lastMovedAt >= 500,
    clipped, mismatch: signature,
  }, performance.now());
  for (const event of events) recordDiagnostic(event, data, snapshot.noteLabels);
}

export async function captureDiagnosticSnapshot(requestId = 0) {
  if (!diagnosticsEnabled || !mounted) return;
  const epoch = captureEpoch;
  try {
    const geometry = await readNativeGeometry();
    if (!mounted || epoch !== captureEpoch) return;
    lastNative = geometry;
    const snapshot = readSnapshot(requestId);
    recordDiagnostic("snapshot", snapshot.data, snapshot.noteLabels);
    checkAnomalies(snapshot);
  } catch {
    // A failed native read is explicitly visible; never reuse it as a fresh reply.
    if (!mounted || epoch !== captureEpoch) return;
    transportFailures += 1;
    recordDiagnostic("native-command-failed", { requestId });
  }
}

export function scheduleDiagnosticSnapshot() {
  if (!diagnosticsEnabled) return;
  window.clearTimeout(captureTimer);
  captureTimer = window.setTimeout(() => { void captureDiagnosticSnapshot(); }, 250);
}

export function startDiagnostics(readState: () => AppState): () => void {
  if (!diagnosticsEnabled) return () => {};
  stateReader = readState;
  mounted = true;
  captureEpoch += 1;
  dragTracker = makeDragTracker();
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const on = (name: string, listener: EventListener, capture = false) => {
    window.addEventListener(name, listener, capture);
    cleanups.push(() => window.removeEventListener(name, listener, capture));
  };
  on("error", (event) => {
    const error = event as ErrorEvent;
    recordDiagnostic(event.target === window ? "frontend-error" : "resource-error", { line: error.lineno, column: error.colno, errorKind: errorKind(error.error) });
  }, true);
  on("unhandledrejection", (event) => recordDiagnostic("unhandled-rejection", { errorKind: errorKind((event as PromiseRejectionEvent).reason) }));
  on("focus", () => { recordDiagnostic("frontend-focus"); scheduleDiagnosticSnapshot(); });
  on("blur", () => { recordDiagnostic("frontend-blur"); scheduleDiagnosticSnapshot(); });
  const visibility = () => recordDiagnostic("visibility-changed", { visible: document.visibilityState === "visible" });
  document.addEventListener("visibilitychange", visibility);
  cleanups.push(() => document.removeEventListener("visibilitychange", visibility));
  void listen<number>("simeioma:debug-snapshot", ({ payload }) => captureDiagnosticSnapshot(payload))
    .then((unlisten) => { if (disposed) unlisten(); else cleanups.push(unlisten); })
    .catch(() => { transportFailures += 1; });
  void getCurrentWindow().onMoved(() => {
    lastMovedAt = performance.now();
    scheduleDiagnosticSnapshot();
  }).then((unlisten) => { if (disposed) unlisten(); else cleanups.push(unlisten); })
    .catch(() => { transportFailures += 1; });
  const watchdog = window.setInterval(() => {
    if (launcherReader?.().busy || watchdogNeeded) {
      try { checkAnomalies(readSnapshot()); } catch { transportFailures += 1; }
    }
  }, 500);
  cleanups.push(() => { window.clearInterval(watchdog); dragTracker.dispose(); });
  const resize = new ResizeObserver(scheduleDiagnosticSnapshot);
  resize.observe(document.documentElement);
  cleanups.push(() => resize.disconnect());
  const launcher = document.querySelector(".launcher-shell");
  if (launcher) {
    const mutation = new MutationObserver(scheduleDiagnosticSnapshot);
    mutation.observe(launcher, { childList: true });
    cleanups.push(() => mutation.disconnect());
  }
  Object.defineProperty(window, "__SIMEIOMA_DIAGNOSTICS__", {
    configurable: true, value: Object.freeze({
      // Return detached data: inspecting/mutating a console result cannot alter live anchors.
      snapshot: () => structuredClone(readSnapshot().data),
      exportBundle: () => nativeInvoke<string>("debug_export"),
      status: () => ({ transportFailures, dropped, rendererId, instanceId }),
    }),
  });
  recordDiagnostic("frontend-ready");
  scheduleDiagnosticSnapshot();
  return () => {
    disposed = true;
    mounted = false;
    captureEpoch += 1;
    cleanups.forEach((cleanup) => cleanup());
    window.clearTimeout(captureTimer);
    delete window.__SIMEIOMA_DIAGNOSTICS__;
    stateReader = undefined;
    launcherReader = undefined;
  };
}

async function readNativeGeometry() {
  const window = getCurrentWindow();
  const [size, scale, position] = await Promise.all([window.innerSize(), window.scaleFactor(), window.outerPosition()]);
  return { capturedAt: Date.now(), scale, actual: { width: size.width / scale, height: size.height / scale },
    position: { x: position.x / scale, y: position.y / scale } };
}

function makeDragTracker() {
  return createDragDiagnostics({
    now: () => performance.now(),
    sample: async () => {
      const [geometry, mouseDown] = await Promise.all([readNativeGeometry(), nativeInvoke<boolean>("is_left_mouse_down")]);
      return { mouseDown, ...geometry.position, ...geometry.actual };
    },
    emit: recordDiagnostic,
    capture: () => captureDiagnosticSnapshot(),
  });
}

export function startObservedWindowDrag(): Promise<void> {
  const start = () => getCurrentWindow().startDragging();
  return diagnosticsEnabled ? dragTracker.observe(start) : start();
}

export async function recordActualLauncherGeometry(operationId: number, event: "resize-completed" | "position-completed" = "resize-completed") {
  if (!diagnosticsEnabled) return;
  try {
    lastNative = await readNativeGeometry();
    recordDiagnostic(event, { operationId, ...lastNative });
  } catch { recordDiagnostic("native-command-failed", { operationId }); }
}
