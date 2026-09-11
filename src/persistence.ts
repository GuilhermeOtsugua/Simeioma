import { isTauri } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
import { diagnosticStorageKey, diagnosticChannelName, diagnosticRevisionKey, diagnosticsEnabled, recordDiagnostic } from "./diagnostics";
import { createStateStore } from "./stateStore";
import { createInitialState, NOTE_COLORS, type AppState } from "./simeiomaModel";

export const stateChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(diagnosticChannelName);
let reportingFailure = false;
const store = createStateStore({
  key: diagnosticStorageKey, storage: localStorage,
  initial: () => createInitialState(Math.floor(Math.random() * NOTE_COLORS.length)),
  locks: { request: (name, action) => {
    if (!navigator.locks) return Promise.reject(new Error("Cross-window state locking unavailable"));
    return navigator.locks.request(name, action);
  } },
  changed: (state, revision, broadcast) => {
    if (diagnosticsEnabled) {
      try { localStorage.setItem(diagnosticRevisionKey, String(revision)); } catch { recordDiagnostic("storage-error"); }
      recordDiagnostic("state-saved", { revision, noteCount: state.notes.length, broadcast });
    }
    if (broadcast) {
      stateChannel?.postMessage({ type: "state" });
      if (isTauri()) void emitTo("notes-list", "simeioma:state-changed").catch(() => {});
    }
  },
  failed: () => {
    recordDiagnostic("storage-error");
    if (!reportingFailure && isTauri()) {
      reportingFailure = true;
      void message("Simeioma could not save this change. Keep the window open and copy any unsaved text before retrying. Existing stored data has not been reset.", { title: "Save failed", kind: "error" })
        .finally(() => { reportingFailure = false; }).catch(() => {});
    }
  },
});
export const loadState = store.read;
export const transactState = store.transact;
export async function updateState(updater: (state: AppState) => AppState, options: { broadcast?: boolean; setState?: (state: AppState) => void } = {}) {
  const result = await store.transact(state => ({ state: updater(state) }), options.broadcast !== false);
  options.setState?.(store.read());
  return result.state;
}
