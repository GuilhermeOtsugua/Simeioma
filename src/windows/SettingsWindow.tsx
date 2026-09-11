import { createSignal, onMount, onCleanup } from "solid-js";
import { loadState, stateChannel as channel, updateState } from "../persistence";
import { createLifetime } from "../lifetime";
import { recordDiagnostic } from "../diagnostics";
import { observeUtilityFocus } from "../utilityLifecycle";
import { configureUtilityWindow } from "../utilityWindows";
import { type Settings, type AppState } from "../simeiomaModel";
import { preventUtilityClipboard, startUtilityDrag, closeCurrentWindow } from "../windowInteractions";
import { CloseIcon } from "../icons";
import { SettingsPanel } from "../settingsPanel";
import { isTauri } from "@tauri-apps/api/core";
import { documentDir } from "@tauri-apps/api/path";

export function SettingsWindow() {
  const [state, setState] = createSignal(loadState());
  onMount(() => {
    const life = createLifetime(() => recordDiagnostic("native-command-failed"));
    life.own(observeUtilityFocus());
    life.after(configureUtilityWindow(), () => {});
    life.after(ensureDefaultExportPath(life.guard(setState), () => life.active), () => {});
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "state") {
        setState(loadState());
      }
    };
    channel?.addEventListener("message", onMessage);
    onCleanup(() => {
      channel?.removeEventListener("message", onMessage);
      life.dispose();
    });
  });

  const updateSettings = (patch: Partial<Settings>) => {
    void updateState(state => ({ ...state, settings: { ...state.settings, ...patch } }), { setState }).catch(() => {});
  };

  return (
    <main class="settings-window-shell" onCopy={preventUtilityClipboard} onCut={preventUtilityClipboard}>
      <header class="utility-titlebar" onPointerDown={startUtilityDrag}>
        <strong>Simeioma Settings</strong>
        <button
          type="button"
          aria-label="Close settings"
          title="Close settings"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            closeCurrentWindow();
          }}
        >
          {CloseIcon()}
        </button>
      </header>
      <SettingsPanel settings={state().settings} onChange={updateSettings} />
    </main>
  );
}

async function ensureDefaultExportPath(setState: (state: AppState) => void, active = () => true) {
  if (!isTauri()) return;
  if (loadState().settings.exportPath) return;
  const exportPath = await documentDir();
  await updateState(
    (state) => !active() || state.settings.exportPath ? state : ({
      ...state,
      settings: { ...state.settings, exportPath },
    }),
    { setState },
  );
}
