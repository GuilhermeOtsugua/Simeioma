import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { documentDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import {
  DEFAULT_SETTINGS,
  NOTE_COLORS,
  formatTimingDraft,
  normalizeTimeOfDay,
  periodicLabel,
  reminderValueForMode,
  timingDraftAfterInput,
  type ExportFormat,
  type ReminderMode,
  type ReminderTarget,
  type NoteColor,
  type SketchBrushSize,
  type Settings,
} from "./simeiomaModel";
import { keyCombo, pointerCombo } from "./inputCombos";

type KeybindSetting = keyof Pick<Settings, "strikeKeybind" | "scribbleKeybind" | "newNoteKeybind" | "hideNotesKeybind">;

export function SettingsPanel(props: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const [editingTiming, setEditingTiming] = createSignal<ReminderMode | null>(null);
  const [periodicDraft, setPeriodicDraft] = createSignal("");
  const [timeOfDayDraft, setTimeOfDayDraft] = createSignal("");
  const [capturingKeybind, setCapturingKeybind] = createSignal<KeybindSetting | null>(null);
  const [copyAccent, setCopyAccent] = createSignal(randomNoteAccent());
  const [formatAccent, setFormatAccent] = createSignal(randomNoteAccent());
  const [brushAccent, setBrushAccent] = createSignal(randomNoteAccent());
  const [enabledAccent, setEnabledAccent] = createSignal(randomNoteAccent());
  const [reminderAccent, setReminderAccent] = createSignal(randomNoteAccent());
  const [targetAccent, setTargetAccent] = createSignal(randomNoteAccent());
  let periodicInputRef: HTMLInputElement | undefined;
  let timeOfDayInputRef: HTMLInputElement | undefined;
  let periodicOverwritePending = false;
  let timeOfDayOverwritePending = false;

  const focusTiming = (mode: ReminderMode) => {
    if (mode === "periodic") periodicOverwritePending = true;
    else timeOfDayOverwritePending = true;
    window.setTimeout(() => {
      const input = mode === "periodic" ? periodicInputRef : timeOfDayInputRef;
      input?.focus();
      const end = input?.value.length ?? 0;
      input?.setSelectionRange(end, end);
    }, 0);
  };

  const selectReminderMode = (mode: ReminderMode) => {
    const reminderValue = reminderValueForMode(
      props.settings.reminderMode,
      props.settings.reminderValue,
      mode,
    );
    setReminderAccent(randomNoteAccent(reminderAccent().key));
    setEditingTiming(null);
    props.onChange({ reminderMode: mode, reminderValue });
  };

  const editReminderTiming = (mode: ReminderMode) => {
    const reminderValue = reminderValueForMode(
      props.settings.reminderMode,
      props.settings.reminderValue,
      mode,
    );
    if (mode === "periodic") {
      setPeriodicDraft(formatTimingDraft(durationToDigits(reminderValue)));
    } else {
      setTimeOfDayDraft(formatTimingDraft(timeToDigits(reminderValue)));
    }
    props.onChange({ reminderMode: mode, reminderValue });
    setEditingTiming(mode);
    focusTiming(mode);
  };

  const commitReminderTiming = (mode: ReminderMode) => {
    const reminderValue = mode === "periodic"
      ? durationDigitsToHours(periodicDraft())
      : normalizeTimeOfDay(timeOfDayDraft());
    props.onChange({ reminderMode: mode, reminderValue });
    setEditingTiming(null);
  };

  const handleTimingKeyDown = (mode: ReminderMode, event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitReminderTiming(mode);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setEditingTiming(null);
      return;
    }
    if (/^\d$/.test(event.key) || event.key === "Backspace") {
      event.preventDefault();
      const currentValue = mode === "periodic" ? periodicDraft() : timeOfDayDraft();
      const replace = mode === "periodic" ? periodicOverwritePending : timeOfDayOverwritePending;
      const nextValue = timingDraftAfterInput(currentValue, event.key, replace);
      if (mode === "periodic") {
        periodicOverwritePending = false;
        setPeriodicDraft(nextValue);
      } else {
        timeOfDayOverwritePending = false;
        setTimeOfDayDraft(nextValue);
      }
      return;
    }
    if (event.key.length === 1 || event.key === "Delete") event.preventDefault();
  };

  const handleTimingPaste = (mode: ReminderMode, event: ClipboardEvent) => {
    event.preventDefault();
    const pasted = event.clipboardData?.getData("text").trim() ?? "";
    if (!/^\d+$/.test(pasted)) return;
    const currentValue = mode === "periodic" ? periodicDraft() : timeOfDayDraft();
    const replace = mode === "periodic" ? periodicOverwritePending : timeOfDayOverwritePending;
    const nextValue = timingDraftAfterInput(currentValue, pasted, replace);
    if (mode === "periodic") {
      periodicOverwritePending = false;
      setPeriodicDraft(nextValue);
    } else {
      timeOfDayOverwritePending = false;
      setTimeOfDayDraft(nextValue);
    }
  };

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
    if (typeof selected === "string") props.onChange({ exportPath: selected });
  };

  return (
    <div class="settings-stack">
      <section class="settings-section" aria-labelledby="settings-files-heading">
        <h2 id="settings-files-heading">Files</h2>
        <div class="settings-group">
      <div class="setting-row">
        <span>Save path</span>
        <button
          type="button"
          class="path-input"
          title={props.settings.exportPath || "Documents"}
          onClick={pickExportPath}
          onContextMenu={(event) => reset(event, { exportPath: DEFAULT_SETTINGS.exportPath })}
        >
          {props.settings.exportPath || "Documents"}
        </button>
      </div>

      <div class="setting-row compact">
        <span>Copy after save</span>
        <input
          class="setting-checkbox"
          style={accentStyle(copyAccent())}
          aria-label="Copy after save"
          type="checkbox"
          checked={props.settings.copyAfterSave}
          onChange={(event) => {
            setCopyAccent(randomNoteAccent(copyAccent().key));
            props.onChange({ copyAfterSave: event.currentTarget.checked });
          }}
          onContextMenu={(event) => reset(event, { copyAfterSave: DEFAULT_SETTINGS.copyAfterSave })}
        />
      </div>

      <label class="setting-row">
        <span>Format</span>
        <select
          class="accent-select"
          style={accentStyle(formatAccent())}
          value={props.settings.exportFormat}
          onPointerDown={() => setFormatAccent(randomNoteAccent(formatAccent().key))}
          onChange={(event) => {
            setFormatAccent(randomNoteAccent(formatAccent().key));
            props.onChange({ exportFormat: event.currentTarget.value as ExportFormat });
          }}
          onContextMenu={(event) => reset(event, { exportFormat: DEFAULT_SETTINGS.exportFormat })}
        >
          <option value="txt">TXT</option>
          <option value="markdown">Markdown</option>
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
        </select>
      </label>

        </div>
      </section>

      <section class="settings-section" aria-labelledby="settings-shortcuts-heading">
        <h2 id="settings-shortcuts-heading">Shortcuts</h2>
        <div class="settings-group">
      <SettingKeybind label="Cross out" ariaLabel="Cross out keybind" value={props.settings.strikeKeybind} onCapture={() => setCapturingKeybind("strikeKeybind")} onReset={(event) => reset(event, { strikeKeybind: DEFAULT_SETTINGS.strikeKeybind })} />
      <SettingKeybind label="Scribble" ariaLabel="Scribble keybind" value={props.settings.scribbleKeybind} onCapture={() => setCapturingKeybind("scribbleKeybind")} onReset={(event) => reset(event, { scribbleKeybind: DEFAULT_SETTINGS.scribbleKeybind })} />
      <SettingKeybind label="New note" ariaLabel="New note keybind" value={props.settings.newNoteKeybind} onCapture={() => setCapturingKeybind("newNoteKeybind")} onReset={(event) => reset(event, { newNoteKeybind: DEFAULT_SETTINGS.newNoteKeybind })} />
      <SettingKeybind label="Hide notes" ariaLabel="Hide notes keybind" value={props.settings.hideNotesKeybind} onCapture={() => setCapturingKeybind("hideNotesKeybind")} onReset={(event) => reset(event, { hideNotesKeybind: DEFAULT_SETTINGS.hideNotesKeybind })} />
        </div>
      </section>

      <section class="settings-section" aria-labelledby="settings-drawing-heading">
        <h2 id="settings-drawing-heading">Drawing</h2>
        <div class="settings-group">
      <div class="segmented brush-size-picker drawing-options" style={accentStyle(brushAccent())} role="group" aria-label="Sketch brush size" onContextMenu={(event) => reset(event, { sketchBrushSize: DEFAULT_SETTINGS.sketchBrushSize })}>
        {(["thin", "default", "thick"] as SketchBrushSize[]).map((size) => (
          <button
            type="button"
            class="option-selection-transition"
            classList={{ "is-active": props.settings.sketchBrushSize === size }}
            aria-pressed={props.settings.sketchBrushSize === size}
            onClick={() => {
              setBrushAccent(randomNoteAccent(brushAccent().key));
              props.onChange({ sketchBrushSize: size });
            }}
          >
            {size === "default" ? "Default" : size[0].toUpperCase() + size.slice(1)}
          </button>
        ))}
      </div>

        </div>
      </section>

      <section class="settings-section" aria-labelledby="settings-reminders-heading">
        <h2 id="settings-reminders-heading">Reminders</h2>
        <div class="settings-group">
      <div class="setting-row compact">
        <span>Enabled</span>
        <input
          class="setting-checkbox"
          style={accentStyle(enabledAccent())}
          aria-label="Enable reminders"
          type="checkbox"
          checked={props.settings.remindersEnabled}
          onChange={(event) => {
            setEnabledAccent(randomNoteAccent(enabledAccent().key));
            props.onChange({ remindersEnabled: event.currentTarget.checked });
          }}
          onContextMenu={(event) => reset(event, { remindersEnabled: DEFAULT_SETTINGS.remindersEnabled })}
        />
      </div>

      <div class="setting-row">
        <span>Timing</span>
        <div
          class="timing-picker"
          style={accentStyle(reminderAccent())}
        >
          <div class="timing-option option-selection-transition" classList={{ "is-active": props.settings.reminderMode === "periodic" }}>
            <button
              type="button"
              class="timing-mode-button"
              aria-pressed={props.settings.reminderMode === "periodic"}
              onClick={() => selectReminderMode("periodic")}
              onContextMenu={(event) => reset(event, { reminderMode: DEFAULT_SETTINGS.reminderMode, reminderValue: DEFAULT_SETTINGS.reminderValue })}
            >
              Periodic
            </button>
            <Show
              when={editingTiming() === "periodic"}
              fallback={
                <button type="button" class="timing-value-button" onClick={() => editReminderTiming("periodic")}>
                  {periodicLabel(reminderValueForMode(props.settings.reminderMode, props.settings.reminderValue, "periodic"))}
                </button>
              }
            >
              <input
                ref={periodicInputRef}
                aria-label="Periodic hours"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={5}
                value={periodicDraft()}
                onBeforeInput={(event) => event.preventDefault()}
                onPaste={(event) => handleTimingPaste("periodic", event)}
                onBlur={() => commitReminderTiming("periodic")}
                onKeyDown={(event) => handleTimingKeyDown("periodic", event)}
                onContextMenu={(event) => reset(event, { reminderMode: DEFAULT_SETTINGS.reminderMode, reminderValue: DEFAULT_SETTINGS.reminderValue })}
              />
            </Show>
          </div>

          <div class="timing-option option-selection-transition" classList={{ "is-active": props.settings.reminderMode === "timeOfDay" }}>
            <button
              type="button"
              class="timing-mode-button"
              aria-pressed={props.settings.reminderMode === "timeOfDay"}
              onClick={() => selectReminderMode("timeOfDay")}
              onContextMenu={(event) => reset(event, { reminderMode: DEFAULT_SETTINGS.reminderMode, reminderValue: DEFAULT_SETTINGS.reminderValue })}
            >
              Time of day
            </button>
            <Show
              when={editingTiming() === "timeOfDay"}
              fallback={
                <button type="button" class="timing-value-button" onClick={() => editReminderTiming("timeOfDay")}>
                  {normalizeTimeOfDay(reminderValueForMode(props.settings.reminderMode, props.settings.reminderValue, "timeOfDay"))}
                </button>
              }
            >
              <input
                ref={timeOfDayInputRef}
                aria-label="Time of day"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={5}
                value={timeOfDayDraft()}
                onBeforeInput={(event) => event.preventDefault()}
                onPaste={(event) => handleTimingPaste("timeOfDay", event)}
                onBlur={() => commitReminderTiming("timeOfDay")}
                onKeyDown={(event) => handleTimingKeyDown("timeOfDay", event)}
                onContextMenu={(event) => reset(event, { reminderMode: DEFAULT_SETTINGS.reminderMode, reminderValue: DEFAULT_SETTINGS.reminderValue })}
              />
            </Show>
          </div>
        </div>
      </div>

      <label class="setting-row">
        <span>Target</span>
        <select
          class="accent-select"
          style={accentStyle(targetAccent())}
          value={props.settings.reminderTarget}
          onPointerDown={() => setTargetAccent(randomNoteAccent(targetAccent().key))}
          onChange={(event) => {
            setTargetAccent(randomNoteAccent(targetAccent().key));
            props.onChange({ reminderTarget: event.currentTarget.value as ReminderTarget });
          }}
          onContextMenu={(event) => reset(event, { reminderTarget: DEFAULT_SETTINGS.reminderTarget })}
        >
          <option value="all">All notes</option>
          <option value="attention">Important or tasks</option>
          <option value="important">Important</option>
          <option value="tasks">Uncrossed tasks</option>
        </select>
      </label>

        </div>
      </section>

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
    <div class="setting-row">
      <span>{props.label}</span>
      <KeybindInput ariaLabel={props.ariaLabel} value={props.value} onCapture={props.onCapture} onReset={props.onReset} />
    </div>
  );
}

function keybindSettingLabel(key: KeybindSetting) {
  return {
    strikeKeybind: "Cross out",
    scribbleKeybind: "Scribble",
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

function randomNoteAccent(excludeKey?: string) {
  const choices = NOTE_COLORS.filter((color) => color.key !== excludeKey);
  return choices[Math.floor(Math.random() * choices.length)] ?? NOTE_COLORS[0];
}

function accentStyle(color: NoteColor) {
  return {
    "--setting-accent": color.bg,
    "--setting-accent-line": color.line,
    "--setting-accent-ink": color.ink,
  };
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
