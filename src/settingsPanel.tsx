import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { documentDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import {
  DEFAULT_SETTINGS,
  normalizeTimeOfDay,
  periodicLabel,
  type ExportFormat,
  type ReminderMode,
  type ReminderTarget,
  type Settings,
} from "./simeiomaModel";
import { keyCombo, pointerCombo } from "./inputCombos";

type KeybindSetting = keyof Pick<Settings, "strikeKeybind" | "scribbleKeybind" | "copyNoteKeybind" | "newNoteKeybind" | "hideNotesKeybind">;

export function SettingsPanel(props: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const [editingTiming, setEditingTiming] = createSignal<ReminderMode | null>(null);
  const [periodicDraft, setPeriodicDraft] = createSignal("");
  const [timeOfDayDraft, setTimeOfDayDraft] = createSignal("");
  const [capturingKeybind, setCapturingKeybind] = createSignal<KeybindSetting | null>(null);

  const reset = (event: MouseEvent, patch: Partial<Settings>) => {
    event.preventDefault();
    props.onChange(patch);
    setEditingTiming(null);
  };

  const pickExportPath = async () => {
    if (!isTauri()) return;
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: props.settings.exportPath || (await documentDir()),
    });
    if (typeof selected === "string") {
      props.onChange({ exportPath: selected, copyAfterSave: true });
    }
  };

  return (
    <div class="settings-stack">
      <label class="setting-row">
        <span>Save path</span>
        <div class="path-picker">
          <input
            aria-label="Save path"
            value={props.settings.exportPath}
            placeholder="Documents"
            onInput={(event) => props.onChange({ exportPath: event.currentTarget.value })}
            onContextMenu={(event) => reset(event, { exportPath: DEFAULT_SETTINGS.exportPath })}
          />
          <button type="button" onClick={pickExportPath}>Browse</button>
        </div>
      </label>

      <label class="setting-row compact">
        <span>Copy after save</span>
        <input type="checkbox" checked={props.settings.copyAfterSave} onChange={(event) => props.onChange({ copyAfterSave: event.currentTarget.checked })} onContextMenu={(event) => reset(event, { copyAfterSave: DEFAULT_SETTINGS.copyAfterSave })} />
      </label>

      <label class="setting-row">
        <span>Format</span>
        <select value={props.settings.exportFormat} onChange={(event) => props.onChange({ exportFormat: event.currentTarget.value as ExportFormat })} onContextMenu={(event) => reset(event, { exportFormat: DEFAULT_SETTINGS.exportFormat })}>
          <option value="txt">txt</option>
          <option value="markdown">markdown</option>
          <option value="png">png</option>
          <option value="jpeg">jpeg</option>
        </select>
      </label>

      <SettingKeybind label="Cross out" ariaLabel="Cross out keybind" value={props.settings.strikeKeybind} onCapture={() => setCapturingKeybind("strikeKeybind")} onReset={(event) => reset(event, { strikeKeybind: DEFAULT_SETTINGS.strikeKeybind })} />
      <SettingKeybind label="Scribble" ariaLabel="Scribble keybind" value={props.settings.scribbleKeybind} onCapture={() => setCapturingKeybind("scribbleKeybind")} onReset={(event) => reset(event, { scribbleKeybind: DEFAULT_SETTINGS.scribbleKeybind })} />
      <SettingKeybind label="Copy note" ariaLabel="Copy note keybind" value={props.settings.copyNoteKeybind} onCapture={() => setCapturingKeybind("copyNoteKeybind")} onReset={(event) => reset(event, { copyNoteKeybind: DEFAULT_SETTINGS.copyNoteKeybind })} />
      <SettingKeybind label="New note" ariaLabel="New note keybind" value={props.settings.newNoteKeybind} onCapture={() => setCapturingKeybind("newNoteKeybind")} onReset={(event) => reset(event, { newNoteKeybind: DEFAULT_SETTINGS.newNoteKeybind })} />
      <SettingKeybind label="Hide notes" ariaLabel="Hide notes keybind" value={props.settings.hideNotesKeybind} onCapture={() => setCapturingKeybind("hideNotesKeybind")} onReset={(event) => reset(event, { hideNotesKeybind: DEFAULT_SETTINGS.hideNotesKeybind })} />

      <label class="setting-row compact">
        <span>Reminders</span>
        <input type="checkbox" checked={props.settings.remindersEnabled} onChange={(event) => props.onChange({ remindersEnabled: event.currentTarget.checked })} onContextMenu={(event) => reset(event, { remindersEnabled: DEFAULT_SETTINGS.remindersEnabled })} />
      </label>

      <div class="setting-row">
        <span>Timing</span>
        <div class="timing-picker">
          <Show
            when={editingTiming() === "periodic"}
            fallback={
              <button type="button" class={props.settings.reminderMode === "periodic" ? "is-active" : ""} onClick={() => {
                const value = props.settings.reminderMode === "periodic" ? durationToDigits(props.settings.reminderValue) : "0100";
                setPeriodicDraft(maskDigits(value));
                props.onChange({ reminderMode: "periodic", reminderValue: durationDigitsToHours(value) });
                setEditingTiming("periodic");
              }} onContextMenu={(event) => reset(event, { reminderMode: DEFAULT_SETTINGS.reminderMode, reminderValue: DEFAULT_SETTINGS.reminderValue })}>
                Periodic
                <small>{periodicLabel(props.settings.reminderValue)}</small>
              </button>
            }
          >
            <input aria-label="Periodic hours" inputMode="decimal" value={periodicDraft()} onInput={(event) => setPeriodicDraft(maskDigits(event.currentTarget.value))} onBlur={(event) => {
              props.onChange({ reminderMode: "periodic", reminderValue: durationDigitsToHours(event.currentTarget.value) });
              setEditingTiming(null);
            }} onKeyDown={(event) => {
              if (event.key === "Enter") {
                props.onChange({ reminderMode: "periodic", reminderValue: durationDigitsToHours(event.currentTarget.value) });
                setEditingTiming(null);
              }
            }} onContextMenu={(event) => reset(event, { reminderMode: DEFAULT_SETTINGS.reminderMode, reminderValue: DEFAULT_SETTINGS.reminderValue })} />
          </Show>

          <Show
            when={editingTiming() === "timeOfDay"}
            fallback={
              <button type="button" class={props.settings.reminderMode === "timeOfDay" ? "is-active" : ""} onClick={() => {
                const value = props.settings.reminderMode === "timeOfDay" ? timeToDigits(props.settings.reminderValue || "0000") : "00:00";
                setTimeOfDayDraft(maskDigits(value));
                props.onChange({ reminderMode: "timeOfDay", reminderValue: normalizeTimeOfDay(value) });
                setEditingTiming("timeOfDay");
              }} onContextMenu={(event) => reset(event, { reminderMode: DEFAULT_SETTINGS.reminderMode, reminderValue: DEFAULT_SETTINGS.reminderValue })}>
                Time of day
                <small>{normalizeTimeOfDay(props.settings.reminderValue || "0000")}</small>
              </button>
            }
          >
            <input aria-label="Time of day" inputMode="numeric" value={timeOfDayDraft()} onInput={(event) => setTimeOfDayDraft(maskDigits(event.currentTarget.value))} onBlur={(event) => {
              props.onChange({ reminderMode: "timeOfDay", reminderValue: normalizeTimeOfDay(event.currentTarget.value) });
              setEditingTiming(null);
            }} onKeyDown={(event) => {
              if (event.key === "Enter") {
                props.onChange({ reminderMode: "timeOfDay", reminderValue: normalizeTimeOfDay(event.currentTarget.value) });
                setEditingTiming(null);
              }
            }} onContextMenu={(event) => reset(event, { reminderMode: DEFAULT_SETTINGS.reminderMode, reminderValue: DEFAULT_SETTINGS.reminderValue })} />
          </Show>
        </div>
      </div>

      <label class="setting-row">
        <span>Target</span>
        <select value={props.settings.reminderTarget} onChange={(event) => props.onChange({ reminderTarget: event.currentTarget.value as ReminderTarget })} onContextMenu={(event) => reset(event, { reminderTarget: DEFAULT_SETTINGS.reminderTarget })}>
          <option value="all">All notes</option>
          <option value="attention">Important or tasks</option>
          <option value="important">Important</option>
          <option value="tasks">Uncrossed tasks</option>
        </select>
      </label>

      <Show when={capturingKeybind()}>
        {(target) => <KeybindCapturePopover label={keybindSettingLabel(target())} onCancel={() => setCapturingKeybind(null)} onCommit={(value) => {
          props.onChange({ [target()]: value } as Partial<Settings>);
          setCapturingKeybind(null);
        }} />}
      </Show>
    </div>
  );
}

function SettingKeybind(props: { label: string; ariaLabel: string; value: string; onCapture: () => void; onReset: (event: MouseEvent) => void }) {
  return (
    <label class="setting-row">
      <span>{props.label}</span>
      <KeybindInput ariaLabel={props.ariaLabel} value={props.value} onCapture={props.onCapture} onReset={props.onReset} />
    </label>
  );
}

function keybindSettingLabel(key: KeybindSetting) {
  return {
    strikeKeybind: "Cross out",
    scribbleKeybind: "Scribble",
    copyNoteKeybind: "Copy note",
    newNoteKeybind: "New note",
    hideNotesKeybind: "Hide notes",
  }[key];
}

function KeybindInput(props: { ariaLabel: string; value: string; onCapture: () => void; onReset: (event: MouseEvent) => void }) {
  return (
    <button type="button" class="keybind-input" aria-label={props.ariaLabel} onClick={props.onCapture} onContextMenu={(event) => {
      if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
      props.onReset(event);
    }}>
      {props.value}
    </button>
  );
}

function KeybindCapturePopover(props: { label: string; onCommit: (value: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = createSignal("Press keys or mouse");
  let popoverRef: HTMLDivElement | undefined;

  onMount(() => {
    window.setTimeout(() => popoverRef?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      const combo = keyCombo(event);
      if (combo) setDraft(combo);
      if (event.key === "Escape") props.onCancel();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      const combo = keyCombo(event) || draft();
      if (combo !== "Press keys or mouse") commit(combo);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!popoverRef?.contains(event.target as Node)) props.onCancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    });
  });

  const commit = (value: string) => {
    if (value) props.onCommit(value);
  };

  return (
    <div ref={popoverRef} class="surface-popover keybind-popover" role="dialog" tabIndex={-1} aria-label={`${props.label} keybind capture`} onContextMenu={(event) => event.preventDefault()}>
      <strong>{props.label}</strong>
      <p class="capture-target" onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        commit(pointerCombo(event));
      }}>
        {draft()}
      </p>
      <button type="button" class="ghost-close" onPointerDown={(event) => event.stopPropagation()} onClick={props.onCancel}>Cancel</button>
    </div>
  );
}

function maskDigits(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

function timeToDigits(value: string) {
  return normalizeTimeOfDay(value).replace(":", "");
}

function durationToDigits(value: string) {
  const totalMinutes = Math.round(Number(value || "1") * 60);
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}${String(totalMinutes % 60).padStart(2, "0")}`;
}

function durationDigitsToHours(value: string) {
  const digits = value.replace(/\D/g, "").padStart(4, "0").slice(0, 4);
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  return String(Math.max(0.25, hours + Math.min(59, minutes) / 60));
}
