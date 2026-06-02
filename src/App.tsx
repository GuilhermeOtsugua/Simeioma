import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { documentDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  LogicalPosition,
  LogicalSize,
  getCurrentWindow,
  primaryMonitor,
} from "@tauri-apps/api/window";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import {
  DEFAULT_NOTE_SIZE,
  DEFAULT_SETTINGS,
  DESKTOP_ICON,
  MAX_NOTES,
  MENU_HEIGHT,
  MENU_WIDTH,
  NOTE_COLORS,
  NOTE_TITLE_HEIGHT,
  STRIP_HEIGHT,
  STRIP_HIT_WIDTH,
  STRIP_HOVER_WIDTH,
  createInitialState as createModelInitialState,
  createNoteInState,
  isReminderDue,
  markNoteViewed,
  normalizePeriodicHours,
  normalizeTimeOfDay,
  periodicLabel,
  reminderNotes,
  resetNotesForDebug,
  unviewedReminderCount,
  unviewedReminderNotes,
  updateNotePosition,
  updateNoteSize,
  type AppState,
  type ExportFormat,
  type Note,
  type NoteColor,
  type NoteLine,
  type ReminderMode,
  type ReminderNotice,
  type ReminderTarget,
  type Settings,
  type SketchStrokeRecord,
} from "./simeiomaModel";
import { renderMarkdownPreview } from "./markdownPreview";
import { drawSketch, finishSketch, renderSketchRecord, startSketch, type SketchStroke } from "./sketch";
import {
  collapsedEditorEndRange,
  currentEditorRange,
  editablePlainText,
  editableSelectionOffsets,
  editorHasFocusOrSelection,
  hasActiveTextSelection,
  selectEditorRange,
  setEditorSelectionOffsets,
  syncEditableText,
} from "./textSelection";
import "./App.css";

const STORAGE_KEY = "simeioma:v1";
const CHANNEL_NAME = "simeioma-sync";
const STRIP_VISIBLE_WIDTH = 3;
const HOLD_TO_DRAG_MS = 0;
const LAUNCHER_CANVAS_WIDTH = 64;
const LAUNCHER_CANVAS_HEIGHT = 204;
const LAUNCHER_CONFIRM_CANVAS_WIDTH = 360;
const LAUNCHER_CONFIRM_CANVAS_HEIGHT = 204;
const LAUNCHER_IDLE_CANVAS_WIDTH = 30;
const LAUNCHER_IDLE_CANVAS_HEIGHT = 112;
const LAUNCHER_SCREEN_MARGIN = 12;

const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
let launcherWasPlaced = false;
let launcherIsConfiguring = false;
let launcherConfigureRun = 0;
let launcherUserDragging = false;

type LauncherAnchor = { right: number; bottom: number };

function App() {
  const params = new URLSearchParams(window.location.search);
  const role = params.get("role");
  const noteId = params.get("id");

  if (role === "note" && noteId) {
    return <NoteWindow noteId={noteId} />;
  }

  if (role === "settings") {
    return <SettingsWindow />;
  }

  if (role === "list") {
    return <NotesListWindow />;
  }

  if (role === "text-menu") {
    return <TextMenuPopupWindow />;
  }

  return <LauncherWindow />;
}

function LauncherWindow() {
  const [state, setState] = createSignal(loadState());
  const [hovered, setHovered] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [notesHidden, setNotesHidden] = createSignal(false);
  const [notice, setNotice] = createSignal<ReminderNotice | null>(null);
  const [confirmingExit, setConfirmingExit] = createSignal(false);
  const [confirmSide, setConfirmSide] = createSignal<"left" | "right">("left");
  const currentColor = createMemo(() => NOTE_COLORS[state().launcher.colorIndex % NOTE_COLORS.length]);
  let dragTimer: number | undefined;
  let dragStarted = false;
  let clickHandledAt = 0;
  let suppressNextLauncherClick = false;
  let pointerDownAt: { x: number; y: number } | null = null;
  let pointerMovedTooFar = false;
  let launcherAnchor: LauncherAnchor | null = null;
  let confirmButtonRef: HTMLButtonElement | undefined;
  let settleDragTimer: number | undefined;

  onMount(() => {
    resetDebugSessionState(setState);
    configureLauncherWindow(false);
    let movedUnlisten: (() => void) | undefined;
    let moveSaveTimer: number | undefined;

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "state") {
        setState(loadState());
      }
      if (event.data?.type === "notes-hidden") {
        setNotesHidden(true);
      }
    };
    channel?.addEventListener("message", onMessage);

    const interval = window.setInterval(() => {
      const latest = loadState();
      setState(latest);
      maybeTriggerReminder(latest, setState, setNotice);
    }, 15000);

    if (isTauri()) {
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused && menuOpen()) {
          setMenuOpen(false);
          setHovered(true);
          window.setTimeout(() => setHovered(false), 160);
        }
      });
      getCurrentWindow().onMoved(() => {
        if (launcherIsConfiguring) return;
        window.clearTimeout(moveSaveTimer);
        if (launcherUserDragging) return;
        moveSaveTimer = window.setTimeout(() => {
          void settleLauncherPosition();
        }, 80);
      }).then((unlisten) => {
        movedUnlisten = unlisten;
      });
    }

    onCleanup(() => {
      channel?.removeEventListener("message", onMessage);
      window.clearInterval(interval);
      window.clearTimeout(dragTimer);
      window.clearTimeout(moveSaveTimer);
      window.clearTimeout(settleDragTimer);
      movedUnlisten?.();
    });
  });

  createEffect(() => {
    if (launcherUserDragging) return;
    configureLauncherWindow(
      menuOpen(),
      false,
      confirmingExit(),
      launcherAnchor,
      (anchor) => (launcherAnchor = anchor),
    );
  });

  createEffect(() => {
    if (confirmingExit()) {
      void updateConfirmSide(setConfirmSide);
      window.setTimeout(() => confirmButtonRef?.focus(), 0);
    }
  });

  const createNote = async () => {
    const latest = loadState();
    const result = createNoteInState(latest, {
      id: createId(),
      lineId: createId(),
      now: new Date().toISOString(),
      origin: await noteSpawnOrigin(),
    });
    if (!result.note) return;
    saveState(result.state);
    setState(result.state);

    await openNoteWindow(result.note.id);
  };

  const exportAll = async (format = state().settings.exportFormat) => {
    const latest = loadState();
    const filename = `simeioma-notes-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${format}`;
    if (format === "png" || format === "jpeg") {
      const bytes = await renderNotesImage(latest.notes, format);
      await saveBinaryExport(latest.settings, filename, bytes, format);
      return;
    }

    const contents = format === "txt" ? notesToText(latest.notes) : notesToMarkdown(latest.notes);
    await saveTextExport(latest.settings, filename, contents);
  };

  const matchingNoticeNotes = createMemo(() =>
    notice() ? state().notes.filter((note) => notice()!.noteIds.includes(note.id)) : [],
  );

  const openNoteList = async () => {
    await openNotesListWindow();
    setMenuOpen(false);
  };

  const openSettings = async () => {
    await openSettingsWindow();
    setMenuOpen(false);
  };

  const toggleNotesVisible = async () => {
    const shouldHide = !notesHidden();
    for (const note of loadState().notes) {
      const noteWindow = await WebviewWindow.getByLabel(noteLabel(note.id));
      if (shouldHide) {
        await noteWindow?.hide();
      } else if (noteWindow) {
        await noteWindow.show();
        await noteWindow.setFocus();
      } else {
        await openNoteWindow(note.id);
      }
    }
    setNotesHidden(shouldHide);
    setMenuOpen(false);
  };

  const startLauncherDrag = () => {
    if (!isTauri()) return;
    dragStarted = true;
    launcherUserDragging = true;
    void getCurrentWindow().startDragging().then(
      () => {
        launcherUserDragging = false;
        settleLauncherDrag();
      },
      () => {
        launcherUserDragging = false;
      },
    );
  };

  const settleLauncherPosition = async () => {
    if (launcherIsConfiguring) return;
    if (await isLeftMouseDown()) {
      settleLauncherDrag();
      return;
    }
    const parking = launcherParkingSize();
    for (let pass = 0; pass < 3; pass += 1) {
      const moved = await clampCurrentLauncherToWorkArea(parking.width, parking.height, LAUNCHER_SCREEN_MARGIN);
      if (!moved) break;
      await sleep(30);
    }
    launcherAnchor = await readWindowAnchor();
    launcherUserDragging = false;
  };

  const settleLauncherDrag = () => {
    window.clearTimeout(settleDragTimer);
    settleDragTimer = window.setTimeout(() => {
      void settleLauncherPosition();
    }, 100);
  };

  const createNoteFromLauncher = () => {
    if (dragStarted || menuOpen()) return;
    clickHandledAt = performance.now();
    createNote();
  };

  const closeSimeioma = async () => {
    await closeAuxiliaryWindows();
    await closeAllNoteWindows();
    await getCurrentWindow().close();
  };

  return (
    <main
      class="launcher-shell"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ "--strip-color": currentColor().bg, "--strip-line": currentColor().line }}
    >
      <section
        class="launcher-strip"
        classList={{ "is-menu": menuOpen() }}
        role={menuOpen() ? "toolbar" : "button"}
        tabIndex={0}
        aria-label="Create note"
        title="Click to create. Hold and drag to move. Right-click for actions."
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen(true);
        }}
        onPointerDown={(event) => {
          if (event.button === 2) {
            event.preventDefault();
            suppressNextLauncherClick = true;
            setMenuOpen(true);
            return;
          }
          if (event.button !== 0) return;
          if (event.ctrlKey) {
            event.preventDefault();
            suppressNextLauncherClick = true;
            toggleNotesVisible();
            return;
          }
          dragStarted = false;
          pointerMovedTooFar = false;
          pointerDownAt = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
          if (HOLD_TO_DRAG_MS > 0) {
            dragTimer = window.setTimeout(startLauncherDrag, HOLD_TO_DRAG_MS);
          }
        }}
        onPointerMove={(event) => {
          if (!pointerDownAt || event.buttons !== 1 || dragStarted) return;
          const moved = Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y);
          if (moved > 3) {
            pointerMovedTooFar = true;
            window.clearTimeout(dragTimer);
            startLauncherDrag();
          }
        }}
        onPointerUp={() => {
          window.clearTimeout(dragTimer);
          pointerDownAt = null;
          if (dragStarted) settleLauncherDrag();
          if (suppressNextLauncherClick || pointerMovedTooFar) return;
          createNoteFromLauncher();
        }}
        onPointerCancel={() => {
          window.clearTimeout(dragTimer);
          pointerDownAt = null;
          pointerMovedTooFar = false;
          suppressNextLauncherClick = false;
          if (!dragStarted) launcherUserDragging = false;
        }}
        onLostPointerCapture={() => {
          window.clearTimeout(dragTimer);
          pointerDownAt = null;
          pointerMovedTooFar = false;
          if (!dragStarted) launcherUserDragging = false;
        }}
        onClick={(event) => {
          event.preventDefault();
          if (suppressNextLauncherClick) {
            suppressNextLauncherClick = false;
            return;
          }
          if (performance.now() - clickHandledAt > 250 && !dragStarted && !menuOpen()) {
            createNote();
          }
        }}
      >
        <Show when={menuOpen()}>
          <nav class="launcher-actions" aria-label="Launcher actions">
            <button type="button" aria-label="Open session notes" title="Open session notes" onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onClick={openNoteList}>
              {ListIcon()}
            </button>
            <button type="button" aria-label="Bulk export notes" title="Bulk export notes" onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onClick={() => exportAll()}>
              {DownloadIcon()}
            </button>
            <button type="button" aria-label="Open settings" title="Open settings" onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onClick={openSettings}>
              {SettingsIcon()}
            </button>
            <button
              type="button"
              class="close-action"
              aria-label="Close Simeioma"
              title="Close Simeioma"
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              onClick={() => setConfirmingExit(true)}
            >
              {CloseIcon()}
            </button>
          </nav>
        </Show>
      </section>
      <Show when={notice()}>
        {(item) => (
          <button
            class="reminder-toast launcher-reminder-toast"
            type="button"
            onClick={async () => {
              for (const match of matchingNoticeNotes()) await openNoteWindow(match.id);
              setNotice(null);
            }}
          >
            <span>{item().noteIds.length}</span>
          </button>
        )}
      </Show>
      <Show when={confirmingExit()}>
        <section
          class="exit-confirmation"
          classList={{ "confirm-left": confirmSide() === "left", "confirm-right": confirmSide() === "right" }}
          role="dialog"
          aria-label="Confirm exit"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              closeSimeioma();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setConfirmingExit(false);
            }
          }}
        >
          <strong>Are you sure?</strong>
          <div>
            <button
              ref={confirmButtonRef}
              type="button"
              class="confirm"
              onClick={() => closeSimeioma()}
            >
              Confirm
            </button>
            <button type="button" onClick={() => setConfirmingExit(false)}>
              Cancel
            </button>
          </div>
        </section>
      </Show>
    </main>
  );
}

function SettingsWindow() {
  const [state, setState] = createSignal(loadState());

  onMount(() => {
    configureUtilityWindow(380, 520);
    ensureDefaultExportPath(setState);

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "state") {
        setState(loadState());
      }
    };
    channel?.addEventListener("message", onMessage);
    onCleanup(() => channel?.removeEventListener("message", onMessage));
  });

  const updateSettings = (patch: Partial<Settings>) => {
    const latest = loadState();
    const next = { ...latest, settings: { ...latest.settings, ...patch } };
    saveState(next);
    setState(next);
  };

  return (
    <main class="settings-window-shell">
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

function NotesListWindow() {
  const [state, setState] = createSignal(loadState());

  onMount(() => {
    configureUtilityWindow(320, 440);

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "state") {
        setState(loadState());
      }
    };
    channel?.addEventListener("message", onMessage);
    onCleanup(() => channel?.removeEventListener("message", onMessage));
  });

  const deleteNote = async (id: string) => {
    const latest = loadState();
    const next = { ...latest, notes: latest.notes.filter((note) => note.id !== id) };
    saveState(next);
    setState(next);
    const noteWindow = await WebviewWindow.getByLabel(noteLabel(id));
    await noteWindow?.close();
  };

  return (
    <main class="settings-window-shell notes-list-window-shell">
      <header class="utility-titlebar" onPointerDown={startUtilityDrag}>
        <strong>Simeioma Notes</strong>
        <button
          type="button"
          aria-label="Close notes list"
          title="Close notes list"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            closeCurrentWindow();
          }}
        >
          {CloseIcon()}
        </button>
      </header>
      <NoteList notes={state().notes} onOpen={openNoteWindow} onDelete={deleteNote} />
    </main>
  );
}

function NoteWindow(props: { noteId: string }) {
  const [state, setState] = createSignal(loadState());
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [scribble, setScribble] = createSignal(false);
  const [bodyFocused, setBodyFocused] = createSignal(true);
  const [rightFocused, setRightFocused] = createSignal(false);
  let canvasRef: HTMLCanvasElement | undefined;
  let bodyRef: HTMLDivElement | undefined;
  let rightBodyRef: HTMLDivElement | undefined;
  let activeStroke: SketchStroke | null = null;
  let noteDragTimer: number | undefined;
  let notePointerDownAt: { x: number; y: number } | null = null;
  let resizingNote = false;
  let resizeStart: { x: number; y: number; width: number; height: number } | null = null;
  let bodySelectionRange: Range | null = null;
  let rightSelectionRange: Range | null = null;

  const note = createMemo(() => state().notes.find((item) => item.id === props.noteId));
  const noteColor = createMemo(() => getColor(note()?.colorKey));
  const otherNotes = createMemo(() => state().notes.filter((item) => item.id !== props.noteId));
  const storedBodyText = createMemo(() => note()?.lines.map((line) => line.text).join("\n") ?? "");
  const storedRightText = createMemo(() => note()?.rightText ?? "");
  const [bodyDraft, setBodyDraft] = createSignal("");
  const [rightDraft, setRightDraft] = createSignal("");
  const bodyText = createMemo(() => bodyDraft());
  const rightText = createMemo(() => rightDraft());
  const mentions = createMemo(() => collectMentions(note(), otherNotes()));
  const itemLayoutIsTwoColumn = createMemo(() => note()?.layout === "two-column");

  createEffect(() => {
    if (!editorHasFocusOrSelection(bodyRef)) {
      const text = storedBodyText();
      setBodyDraft(text);
      syncEditableText(bodyRef, text);
    }
  });

  createEffect(() => {
    if (!editorHasFocusOrSelection(rightBodyRef)) {
      const text = storedRightText();
      setRightDraft(text);
      syncEditableText(rightBodyRef, text);
    }
  });

  const createNoteFromShortcut = async () => {
    const latest = loadState();
    const current = latest.notes.find((item) => item.id === props.noteId);
    const result = createNoteInState(latest, {
      id: createId(),
      lineId: createId(),
      now: new Date().toISOString(),
      origin: current?.position ?? (await noteSpawnOrigin()),
    });
    if (!result.note) return;
    saveState(result.state);
    setState(result.state);
    await openNoteWindow(result.note.id);
  };

  const handleNoteKeyDown = (event: KeyboardEvent) => {
    const combo = keyCombo(event);
    if (!combo) return;
    const currentSettings = loadState().settings;
    const current = note();

    if (combo === currentSettings.copyNoteKeybind && current) {
      if (hasActiveTextSelection(bodyRef)) return;
      event.preventDefault();
      void copyText(noteToMarkdown(current));
      return;
    }

    if (combo === currentSettings.newNoteKeybind) {
      event.preventDefault();
      void createNoteFromShortcut();
      return;
    }

    if (combo === "Ctrl + Z" && current?.sketchStrokes?.length && document.activeElement !== bodyRef && document.activeElement !== rightBodyRef) {
      event.preventDefault();
      patchNote({ sketchStrokes: current.sketchStrokes.slice(0, -1), sketchData: undefined });
      return;
    }

    if (combo === "Ctrl + Shift + Z" && (current?.sketchStrokes?.length || current?.sketchData)) {
      event.preventDefault();
      patchNote({ sketchStrokes: [], sketchData: undefined });
      return;
    }

    if (combo === currentSettings.hideNotesKeybind) {
      event.preventDefault();
      void hideAllNoteWindows();
    }
  };

  onMount(() => {
    configureNoteWindow(props.noteId);
    markCurrentNoteViewed(props.noteId, setState);
    focusFirstLine();
    hydrateCanvas();
    let movedUnlisten: (() => void) | undefined;
    let resizedUnlisten: (() => void) | undefined;
    let focusUnlisten: (() => void) | undefined;
    let textCommandUnlisten: (() => void) | undefined;
    let moveSaveTimer: number | undefined;
    let sizeSaveTimer: number | undefined;

    if (isTauri()) {
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) channel?.postMessage({ type: "note-focused", noteId: props.noteId });
        if (!focused) {
          setPaletteOpen(false);
          channel?.postMessage({ type: "dismiss-text-menu" });
        }
      }).then((unlisten) => {
        focusUnlisten = unlisten;
      });
      getCurrentWindow().listen<{ field: string; command: string; text?: string; start?: number; end?: number }>("text-menu-command", ({ payload }) => {
        void applyTextMenuCommand(payload.field, payload.command, payload.text, payload.start, payload.end);
      }).then((unlisten) => {
        textCommandUnlisten = unlisten;
      });
      getCurrentWindow().onMoved(({ payload }) => {
        window.clearTimeout(moveSaveTimer);
        moveSaveTimer = window.setTimeout(async () => {
          const scale = (await primaryMonitor())?.scaleFactor || 1;
          persistNotePosition(props.noteId, { x: payload.x / scale, y: payload.y / scale }, setState);
        }, 80);
      }).then((unlisten) => {
        movedUnlisten = unlisten;
      });
      getCurrentWindow().onResized(({ payload }) => {
        window.clearTimeout(sizeSaveTimer);
        sizeSaveTimer = window.setTimeout(async () => {
          const scale = (await primaryMonitor())?.scaleFactor || 1;
          persistNoteSize(props.noteId, { width: payload.width / scale, height: payload.height / scale }, setState);
        }, 80);
      }).then((unlisten) => {
        resizedUnlisten = unlisten;
      });
    }

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "state") {
        setState(loadState());
      }

    };
    const closePaletteOnOutsidePointer = (event: PointerEvent) => {
      if (event.button === 0) channel?.postMessage({ type: "dismiss-text-menu" });
      const target = event.target as HTMLElement;
      if (paletteOpen() && !target.closest(".note-titlebar, .note-context-menu")) setPaletteOpen(false);
    };
    channel?.addEventListener("message", onMessage);
    window.addEventListener("keydown", handleNoteKeyDown);
    window.addEventListener("pointerdown", closePaletteOnOutsidePointer, true);
    onCleanup(() => {
      channel?.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", handleNoteKeyDown);
      window.removeEventListener("pointerdown", closePaletteOnOutsidePointer, true);
      window.clearTimeout(noteDragTimer);
      window.clearTimeout(moveSaveTimer);
      window.clearTimeout(sizeSaveTimer);
      movedUnlisten?.();
      resizedUnlisten?.();
      focusUnlisten?.();
      textCommandUnlisten?.();
    });
  });

  const startNoteDrag = (event: PointerEvent) => {
    if (!isTauri() || event.button !== 0 || scribble()) return;
    if (event.ctrlKey) return;
    if (shouldBlockNoteDrag(event)) return;
    window.clearTimeout(noteDragTimer);
    notePointerDownAt = { x: event.clientX, y: event.clientY };
    if (HOLD_TO_DRAG_MS > 0) {
      noteDragTimer = window.setTimeout(() => getCurrentWindow().startDragging(), HOLD_TO_DRAG_MS);
    }
  };

  const maybeStartNoteDrag = (event: PointerEvent) => {
    if (!notePointerDownAt || event.buttons !== 1 || resizingNote) return;
    const moved = Math.hypot(event.clientX - notePointerDownAt.x, event.clientY - notePointerDownAt.y);
    if (moved > 2) {
      notePointerDownAt = null;
      getCurrentWindow().startDragging();
    }
  };

  const editorForField = (field: string) => field === "right" ? rightBodyRef : bodyRef;

  const syncEditorValue = (field: string, editor: HTMLElement) => {
    const text = editablePlainText(editor);
    if (field === "right") {
      setRightDraft(text);
      updateRightText(text);
    } else {
      setBodyDraft(text);
      updateBodyText(text);
    }
    growBody();
  };

  const storeEditorRange = (field: string, range: Range) => {
    if (field === "right") rightSelectionRange = range.cloneRange();
    else bodySelectionRange = range.cloneRange();
  };

  const storedEditorRange = (field: string) => {
    const range = field === "right" ? rightSelectionRange : bodySelectionRange;
    return range?.cloneRange() ?? null;
  };

  const applyTextMenuCommand = async (field: string, command: string, payloadText = "") => {
    const target = editorForField(field);
    if (!target) return;
    const range = storedEditorRange(field) ?? currentEditorRange(target) ?? collapsedEditorEndRange(target);
    selectEditorRange(range);
    if (command === "paste") {
      const text = payloadText || await readClipboardText();
      range.deleteContents();
      const inserted = document.createTextNode(text);
      range.insertNode(inserted);
      range.setStartAfter(inserted);
      range.collapse(true);
      storeEditorRange(field, range);
      selectEditorRange(range);
      syncEditorValue(field, target);
      return;
    }
    if (command === "cut") {
      const selected = range.toString();
      if (!selected) return;
      await copyText(selected);
      range.deleteContents();
      range.collapse(true);
      storeEditorRange(field, range);
      selectEditorRange(range);
      syncEditorValue(field, target);
      return;
    }
    if (command === "copy") {
      const selected = range.toString();
      if (selected) await copyText(selected);
      return;
    }
    if (command === "select-all") {
      const next = document.createRange();
      next.selectNodeContents(target);
      storeEditorRange(field, next);
      selectEditorRange(next);
      return;
    }
    if (command === "dir-ltr" || command === "dir-rtl") {
      target.dir = command.replace("dir-", "") as "ltr" | "rtl";
    }
  };

  const rememberTextSelection = (field: "body" | "right") => {
    const target = editorForField(field);
    const range = target ? currentEditorRange(target) : null;
    if (range) storeEditorRange(field, range);
  };

  const openTextMenu = (event: MouseEvent, field: "body" | "right", directEditor = true) => {
    event.preventDefault();
    event.stopPropagation();
    const target = editorForField(field);
    if (!target) return;
    const range = directEditor ? currentEditorRange(target) ?? collapsedEditorEndRange(target) : collapsedEditorEndRange(target);
    if (!directEditor) target.focus();
    storeEditorRange(field, range);
    selectEditorRange(range);
    void openTextMenuPopupWindow(props.noteId, field, event.clientX, event.clientY, !range.collapsed, 0, 0);
  };

  const startNoteResize = async (event: PointerEvent) => {
    if (!isTauri() || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizingNote = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const size = await getCurrentWindow().outerSize();
    const scale = (await primaryMonitor())?.scaleFactor || 1;
    resizeStart = {
      x: event.clientX,
      y: event.clientY,
      width: size.width / scale,
      height: size.height / scale,
    };
  };

  const resizeNote = async (event: PointerEvent) => {
    if (!resizeStart || !resizingNote) return;
    const width = Math.max(176, resizeStart.width + event.clientX - resizeStart.x);
    const height = Math.max(176, resizeStart.height + event.clientY - resizeStart.y);
    await getCurrentWindow().setSize(new LogicalSize(width, height));
  };

  const stopNoteResize = async () => {
    if (!resizingNote) return;
    resizingNote = false;
    resizeStart = null;
    if (!isTauri()) return;
    const size = await getCurrentWindow().outerSize();
    const scale = (await primaryMonitor())?.scaleFactor || 1;
    persistNoteSize(
      props.noteId,
      { width: size.width / scale, height: size.height / scale },
      setState,
    );
  };

  createEffect(() => {
    note()?.sketchData;
    note()?.sketchStrokes;
    hydrateCanvas();
  });

  createEffect(() => {
    if (!note() && isTauri()) {
      getCurrentWindow().close();
    }
  });

  const patchNote = (patch: Partial<Note>) => {
    const latest = loadState();
    const notes = latest.notes.map((item) =>
      item.id === props.noteId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item,
    );
    const next = { ...latest, notes };
    saveState(next);
    setState(next);
  };

  const updateBodyText = (rawText: string) => {
    const current = note();
    if (!current) return;
    persistNoteBody(props.noteId, current.lines[0]?.id ?? createId(), rawText);
  };

  const updateRightText = (rawText: string) => {
    persistNoteRightText(props.noteId, rawText);
  };

  const saveSketchStroke = (stroke: SketchStrokeRecord) => {
    const current = note();
    patchNote({ sketchStrokes: [...(current?.sketchStrokes ?? []), stroke] });
  };

  const syncAfterLineEdit = () => {
    const latest = loadState();
    saveState(latest);
    setState(latest);
  };

  const growBody = async () => {
    const visibleEditors = [bodyRef, itemLayoutIsTwoColumn() ? rightBodyRef : undefined].filter(Boolean) as HTMLDivElement[];
    if (!visibleEditors.length) return;
    let nextHeight = 0;
    for (const editor of visibleEditors) {
      editor.style.height = "auto";
      const height = Math.max(22, editor.scrollHeight);
      editor.style.height = `${height}px`;
      nextHeight = Math.max(nextHeight, height);
    }
    if (!isTauri()) return;
    const desiredHeight = Math.min(620, NOTE_TITLE_HEIGHT + 24 + nextHeight);
    const currentSize = await getCurrentWindow().outerSize();
    const scale = (await primaryMonitor())?.scaleFactor || 1;
    if (desiredHeight > currentSize.height / scale + 12) {
      await getCurrentWindow().setSize(new LogicalSize(Math.max(DEFAULT_NOTE_SIZE, currentSize.width / scale), desiredHeight));
    }
  };

  return (
    <Show when={note()} fallback={<main class="note-shell deleted-note">Note deleted</main>}>
      {(item) => (
        <main
          class="note-shell"
          classList={{ "is-scribbling": scribble() }}
          style={{
            "--note-bg": noteColor().bg,
            "--note-ink": noteColor().ink,
            "--note-line": noteColor().line,
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            if (matchesCombo(pointerCombo(event), loadState().settings.scribbleKeybind)) {
              setScribble(!scribble());
              return;
            }
            const target = event.target as HTMLElement;
            if (target.closest(".note-titlebar, button, input, select, .note-context-menu, .note-resize-handle")) return;
            if (!target.closest(".note-body-editor")) {
              const field = target.closest(".note-column")?.querySelector('[aria-label="Note right column"]') ? "right" : "body";
              openTextMenu(event, field, false);
            }
          }}
          onPointerDown={startNoteDrag}
          onPointerMove={maybeStartNoteDrag}
          onPointerUp={() => {
            notePointerDownAt = null;
            window.clearTimeout(noteDragTimer);
          }}
          onPointerLeave={() => {
            notePointerDownAt = null;
            window.clearTimeout(noteDragTimer);
          }}
        >
          <header
            class="note-titlebar"
            onContextMenu={(event) => {
              event.preventDefault();
              if (matchesCombo(pointerCombo(event), loadState().settings.scribbleKeybind)) {
                setScribble(!scribble());
                return;
              }
              setPaletteOpen(!paletteOpen());
            }}
          >
            <input
              class="note-title-input"
              value={item().title}
              placeholder="Untitled"
              onInput={(event) => patchNote({ title: event.currentTarget.value })}
            />
            <button
              class="icon-button split-title-button"
              classList={{ "is-important": item().layout === "two-column" }}
              title="Toggle two-column note"
              aria-label="Toggle two-column note"
              onClick={() => patchNote({ layout: item().layout === "two-column" ? "single" : "two-column" })}
            >
              {SplitIcon()}
            </button>
            <button
              class="icon-button star-button"
              classList={{ "is-important": item().important }}
              title="Mark important"
              onClick={() => patchNote({ important: !item().important })}
            >
              {StarIcon()}
            </button>
            <Show when={paletteOpen()}>
              <div class="color-popover note-context-menu">
                <div class="color-swatch-grid">
                  <For each={NOTE_COLORS}>
                    {(color) => (
                      <button
                        class="color-swatch"
                        title={color.name}
                        style={{ "background-color": color.bg }}
                        onClick={() => {
                          patchNote({ colorKey: color.key });
                          setPaletteOpen(false);
                        }}
                      />
                    )}
                  </For>
                </div>
                <button
                  type="button"
                  class="note-menu-action close-action"
                  onClick={() => closeCurrentWindow()}
                >
                  Close
                </button>
              </div>
            </Show>
          </header>

          <div class="note-divider" />

          <section class="note-body" classList={{ "is-two-column": item().layout === "two-column" }}>
            <div class="note-columns" classList={{ "is-two-column": item().layout === "two-column" }}>
              <div class="note-column">
                <div class="note-editor-stack" classList={{ "is-editing": bodyFocused() }}>
                  <div
                    class="note-body-preview"
                    classList={{ "is-empty": !bodyText().trim() }}
                    onClick={() => {
                      setBodyFocused(true);
                      window.setTimeout(() => bodyRef?.focus(), 0);
                    }}
                  >
                    {renderMarkdownPreview(bodyText())}
                  </div>
                  <div
                    ref={bodyRef}
                    class="note-body-editor"
                    role="textbox"
                    aria-label="Note line"
                    data-line-id={item().lines[0]?.id ?? item().id}
                    data-placeholder="Write..."
                    contenteditable="plaintext-only"
                    spellcheck={false}
                    onPointerDown={(event) => {
                      if (event.button === 2) {
                        rememberTextSelection("body");
                        event.preventDefault();
                      }
                    }}
                    onContextMenu={(event) => openTextMenu(event, "body")}
                    onKeyUp={() => rememberTextSelection("body")}
                    onPointerUp={() => rememberTextSelection("body")}
                    onClick={(event) => {
                      if (event.ctrlKey) {
                        event.preventDefault();
                        const next = toggleCurrentEditableLineStrike(event.currentTarget);
                        setBodyDraft(next);
                        updateBodyText(next);
                      }
                    }}
                    onInput={(event) => {
                      const text = editablePlainText(event.currentTarget);
                      setBodyDraft(text);
                      updateBodyText(text);
                      rememberTextSelection("body");
                      growBody();
                    }}
                    onFocus={() => {
                      setBodyFocused(true);
                      rememberTextSelection("body");
                      growBody();
                    }}
                    onBlur={() => {
                      syncAfterLineEdit();
                      window.setTimeout(() => {
                        if (!editorHasFocusOrSelection(bodyRef)) setBodyFocused(false);
                      }, 0);
                    }}
                  />
                </div>
              </div>

              <Show when={item().layout === "two-column"}>
                <div class="note-column-divider" aria-hidden="true" />
                <div class="note-column">
                  <div class="note-editor-stack" classList={{ "is-editing": rightFocused() }}>
                    <div
                      class="note-body-preview"
                      classList={{ "is-empty": !rightText().trim() }}
                      onClick={() => {
                        setRightFocused(true);
                        window.setTimeout(() => rightBodyRef?.focus(), 0);
                      }}
                    >
                      {renderMarkdownPreview(rightText())}
                    </div>
                    <div
                      ref={rightBodyRef}
                      class="note-body-editor"
                      role="textbox"
                      aria-label="Note right column"
                      data-placeholder="Write..."
                      contenteditable="plaintext-only"
                      spellcheck={false}
                      onPointerDown={(event) => {
                        if (event.button === 2) {
                          rememberTextSelection("right");
                          event.preventDefault();
                        }
                      }}
                      onContextMenu={(event) => openTextMenu(event, "right")}
                      onKeyUp={() => rememberTextSelection("right")}
                      onPointerUp={() => rememberTextSelection("right")}
                      onInput={(event) => {
                        const text = editablePlainText(event.currentTarget);
                        setRightDraft(text);
                        updateRightText(text);
                        rememberTextSelection("right");
                        growBody();
                      }}
                      onFocus={() => {
                        setRightFocused(true);
                        rememberTextSelection("right");
                        growBody();
                      }}
                      onBlur={() => {
                        syncAfterLineEdit();
                        window.setTimeout(() => {
                          if (!editorHasFocusOrSelection(rightBodyRef)) setRightFocused(false);
                        }, 0);
                      }}
                    />
                  </div>
                </div>
              </Show>
            </div>

            <Show when={mentions().length}>
              <div class="mention-row">
                <For each={mentions()}>
                  {(target) => (
                    <button onClick={() => openNoteWindow(target.id)}>@{noteLabelText(target)}</button>
                  )}
                </For>
              </div>
            </Show>

            <canvas
              ref={canvasRef}
              class="sketch-canvas"
              width="384"
              height="384"
              onPointerDown={(event) => {
                if (event.button !== 0) {
                  activeStroke = null;
                  return;
                }
                activeStroke = startSketch(event, canvasRef);
              }}
              onPointerMove={(event) => {
                if (!canvasRef || !activeStroke || (event.buttons & 1) === 0) return;
                drawSketch(event, canvasRef, activeStroke);
              }}
              onPointerUp={(event) => {
                if (event.button !== 0) return;
                if (canvasRef && activeStroke) {
                  const record = finishSketch(canvasRef, activeStroke);
                  if (record) saveSketchStroke(record);
                }
                activeStroke = null;
              }}
              onPointerLeave={() => {
                if (canvasRef && activeStroke) {
                  const record = finishSketch(canvasRef, activeStroke);
                  if (record) saveSketchStroke(record);
                }
                activeStroke = null;
              }}
            />
          </section>

          <div
            class="note-resize-handle"
            title="Resize note"
            onPointerDown={startNoteResize}
            onPointerMove={resizeNote}
            onPointerUp={stopNoteResize}
            onPointerCancel={stopNoteResize}
            onLostPointerCapture={stopNoteResize}
          />
        </main>
      )}
    </Show>
  );

  function hydrateCanvas() {
    const current = note();
    if (!canvasRef) return;
    const context = canvasRef.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvasRef.width, canvasRef.height);
    const renderStrokes = () => {
      for (const stroke of current?.sketchStrokes ?? []) renderSketchRecord(context, stroke);
    };
    if (current?.sketchData) {
      const image = new Image();
      image.onload = () => {
        context.clearRect(0, 0, canvasRef!.width, canvasRef!.height);
        context.drawImage(image, 0, 0, canvasRef!.width, canvasRef!.height);
        renderStrokes();
      };
      image.src = current.sketchData;
      return;
    }
    renderStrokes();
  }
}

function TextMenuPopupWindow() {
  const params = new URLSearchParams(window.location.search);
  const noteId = params.get("noteId") ?? "";
  const field = params.get("field") ?? "body";
  const hasSelection = params.get("hasSelection") === "1";
  const start = Number(params.get("start") ?? "0");
  const end = Number(params.get("end") ?? "0");

  onMount(() => {
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) void closeCurrentWindow();
    });
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "dismiss-text-menu" || event.data?.type === "quit") void closeCurrentWindow();
      if (event.data?.type === "note-closed" && event.data.noteId === noteId) void closeCurrentWindow();
    };
    channel?.addEventListener("message", onMessage);
    onCleanup(() => channel?.removeEventListener("message", onMessage));
  });

  const runMenuCommand = (event: PointerEvent, command: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    void send(command);
  };

  const send = async (command: string) => {
    await emitTo(noteLabel(noteId), "text-menu-command", { field, command, start, end });
    await closeCurrentWindow();
  };
  return (
    <main
      class="popup-shell text-menu-popup-shell"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button === 0 && !(event.target as HTMLElement).closest(".text-context-menu")) void closeCurrentWindow();
      }}
    >
      <div class="color-popover note-context-menu text-context-menu">
        <button class="note-menu-action" type="button" disabled={!hasSelection} onPointerDown={(event) => runMenuCommand(event, "cut")}>Cut</button>
        <button class="note-menu-action" type="button" disabled={!hasSelection} onPointerDown={(event) => runMenuCommand(event, "copy")}>Copy</button>
        <button class="note-menu-action" type="button" onPointerDown={(event) => runMenuCommand(event, "paste")}>Paste</button>
        <button class="note-menu-action" type="button" onPointerDown={(event) => runMenuCommand(event, "select-all")}>Select all</button>
        <div class="text-menu-label">Writing direction</div>
        <div class="text-direction-row">
          <button class="note-menu-action" type="button" onPointerDown={(event) => runMenuCommand(event, "dir-ltr")}>LTR</button>
          <button class="note-menu-action" type="button" onPointerDown={(event) => runMenuCommand(event, "dir-rtl")}>RTL</button>
        </div>
      </div>
    </main>
  );
}

function NoteList(props: {
  notes: Note[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [actionNote, setActionNote] = createSignal<Note | null>(null);

  return (
    <div class="note-list">
      <Show when={props.notes.length} fallback={<p class="empty-state">No notes yet.</p>}>
        <For each={props.notes}>
          {(note) => {
            const color = getColor(note.colorKey);
            return (
              <button
                class="note-list-item"
                style={{ "background-color": color.bg, color: color.ink }}
                onClick={() => props.onOpen(note.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setActionNote(note);
                }}
              >
                <span>{noteLabelText(note)}</span>
                <small>{note.important ? "Important" : note.lines.some((line) => line.task && !line.crossed) ? "Open tasks" : "Note"}</small>
              </button>
            );
          }}
        </For>
      </Show>
      <Show when={actionNote()}>
        {(note) => (
          <div class="surface-popover note-action-popover" role="dialog" aria-label="Note actions">
            <strong>{noteLabelText(note())}</strong>
            <div>
              <button
                type="button"
                onClick={() => {
                  copyText(noteToMarkdown(note()));
                  setActionNote(null);
                }}
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => {
                  saveTextExport(loadState().settings, `${noteLabelText(note())}.md`, noteToMarkdown(note()));
                  setActionNote(null);
                }}
              >
                Save
              </button>
              <button
                type="button"
                class="danger"
                onClick={() => {
                  props.onDelete(note().id);
                  setActionNote(null);
                }}
              >
                Delete
              </button>
            </div>
            <button type="button" class="ghost-close" onClick={() => setActionNote(null)}>
              Cancel
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}

function NoteLineEditor(props: {
  line: NoteLine;
  animating: boolean;
  onText: (lineId: string, value: string) => void;
  onSync: () => void;
  onInsertAfter: (lineId: string) => void;
  onRemoveEmpty: (lineId: string) => void;
  onToggleCrossed: (lineId: string) => void;
}) {
  const [text, setText] = createSignal(props.line.text);

  createEffect(() => {
    if (document.activeElement?.getAttribute("data-line-id") !== props.line.id) {
      setText(props.line.text);
    }
  });

  const parsed = createMemo(() => ({
    isHeading: text().startsWith("# "),
    isCode: /^`.*`$/.test(text().trim()),
  }));

  return (
    <div
      class="note-line"
      classList={{
        "is-task": props.line.task,
        "is-crossed": props.line.crossed,
        "is-animating": props.animating,
        "is-heading": parsed().isHeading,
        "is-code": parsed().isCode,
      }}
      onClick={(event) => {
        if (event.ctrlKey) {
          event.preventDefault();
          props.onToggleCrossed(props.line.id);
        }
      }}
    >
      <Show when={props.line.task}>
        <button
          class="task-box"
          aria-label="Toggle task"
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleCrossed(props.line.id);
          }}
        >
          <span />
        </button>
      </Show>
      <textarea
        class="line-editor"
        aria-label="Note line"
        data-line-id={props.line.id}
        value={text()}
        placeholder="Write..."
        spellcheck={false}
        onInput={(event) => {
          const value = event.currentTarget.value;
          setText(value);
          props.onText(props.line.id, value);
        }}
        onBlur={props.onSync}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onInsertAfter(props.line.id);
          }
          if (event.key === "Backspace" && !event.currentTarget.value.length) {
            event.preventDefault();
            props.onRemoveEmpty(props.line.id);
          }
        }}
      />
    </div>
  );
}

function BulkExport(props: { settings: Settings; onExport: (format?: ExportFormat) => void }) {
  return (
    <div class="settings-stack">
      <p class="panel-copy">Export all current notes using the selected format.</p>
      <div class="segmented">
        <For each={["txt", "markdown", "png", "jpeg"] as ExportFormat[]}>
          {(format) => (
            <button
              class={props.settings.exportFormat === format ? "is-active" : ""}
              onClick={() => props.onExport(format)}
            >
              {format}
            </button>
          )}
        </For>
      </div>
      <button class="primary-row-button" onClick={() => props.onExport()}>
        Export current format
      </button>
    </div>
  );
}

function SettingsPanel(props: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const [editingTiming, setEditingTiming] = createSignal<ReminderMode | null>(null);
  const [periodicDraft, setPeriodicDraft] = createSignal("");
  const [timeOfDayDraft, setTimeOfDayDraft] = createSignal("");
  const [capturingKeybind, setCapturingKeybind] = createSignal<keyof Pick<Settings, "strikeKeybind" | "scribbleKeybind" | "copyNoteKeybind" | "newNoteKeybind" | "hideNotesKeybind"> | null>(null);

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
          <button type="button" onClick={pickExportPath}>
            Browse
          </button>
        </div>
      </label>

      <label class="setting-row compact">
        <span>Copy after save</span>
        <input
          type="checkbox"
          checked={props.settings.copyAfterSave}
          onChange={(event) => props.onChange({ copyAfterSave: event.currentTarget.checked })}
          onContextMenu={(event) => reset(event, { copyAfterSave: DEFAULT_SETTINGS.copyAfterSave })}
        />
      </label>

      <label class="setting-row">
        <span>Format</span>
        <select
          value={props.settings.exportFormat}
          onChange={(event) => props.onChange({ exportFormat: event.currentTarget.value as ExportFormat })}
          onContextMenu={(event) => reset(event, { exportFormat: DEFAULT_SETTINGS.exportFormat })}
        >
          <option value="txt">txt</option>
          <option value="markdown">markdown</option>
          <option value="png">png</option>
          <option value="jpeg">jpeg</option>
        </select>
      </label>

      <label class="setting-row">
        <span>Cross out</span>
        <KeybindInput
          ariaLabel="Cross out keybind"
          value={props.settings.strikeKeybind}
          onCapture={() => setCapturingKeybind("strikeKeybind")}
          onReset={(event) => reset(event, { strikeKeybind: DEFAULT_SETTINGS.strikeKeybind })}
        />
      </label>

      <label class="setting-row">
        <span>Scribble</span>
        <KeybindInput
          ariaLabel="Scribble keybind"
          value={props.settings.scribbleKeybind}
          onCapture={() => setCapturingKeybind("scribbleKeybind")}
          onReset={(event) => reset(event, { scribbleKeybind: DEFAULT_SETTINGS.scribbleKeybind })}
        />
      </label>

      <label class="setting-row">
        <span>Copy note</span>
        <KeybindInput
          ariaLabel="Copy note keybind"
          value={props.settings.copyNoteKeybind}
          onCapture={() => setCapturingKeybind("copyNoteKeybind")}
          onReset={(event) => reset(event, { copyNoteKeybind: DEFAULT_SETTINGS.copyNoteKeybind })}
        />
      </label>

      <label class="setting-row">
        <span>New note</span>
        <KeybindInput
          ariaLabel="New note keybind"
          value={props.settings.newNoteKeybind}
          onCapture={() => setCapturingKeybind("newNoteKeybind")}
          onReset={(event) => reset(event, { newNoteKeybind: DEFAULT_SETTINGS.newNoteKeybind })}
        />
      </label>

      <label class="setting-row">
        <span>Hide notes</span>
        <KeybindInput
          ariaLabel="Hide notes keybind"
          value={props.settings.hideNotesKeybind}
          onCapture={() => setCapturingKeybind("hideNotesKeybind")}
          onReset={(event) => reset(event, { hideNotesKeybind: DEFAULT_SETTINGS.hideNotesKeybind })}
        />
      </label>

      <label class="setting-row compact">
        <span>Reminders</span>
        <input
          type="checkbox"
          checked={props.settings.remindersEnabled}
          onChange={(event) => props.onChange({ remindersEnabled: event.currentTarget.checked })}
          onContextMenu={(event) => reset(event, { remindersEnabled: DEFAULT_SETTINGS.remindersEnabled })}
        />
      </label>

      <div class="setting-row">
        <span>Timing</span>
        <div class="timing-picker">
          <Show
            when={editingTiming() === "periodic"}
            fallback={
              <button
                type="button"
                class={props.settings.reminderMode === "periodic" ? "is-active" : ""}
                onClick={() => {
                  const value =
                    props.settings.reminderMode === "periodic"
                      ? durationToDigits(props.settings.reminderValue)
                      : "0100";
                  setPeriodicDraft(maskDigits(value));
                  props.onChange({ reminderMode: "periodic", reminderValue: durationDigitsToHours(value) });
                  setEditingTiming("periodic");
                }}
                onContextMenu={(event) =>
                  reset(event, {
                    reminderMode: DEFAULT_SETTINGS.reminderMode,
                    reminderValue: DEFAULT_SETTINGS.reminderValue,
                  })
                }
              >
                Periodic
                <small>{periodicLabel(props.settings.reminderValue)}</small>
              </button>
            }
          >
              <input
              aria-label="Periodic hours"
              inputMode="decimal"
              value={periodicDraft()}
              onInput={(event) => setPeriodicDraft(maskDigits(event.currentTarget.value))}
              onBlur={(event) => {
                props.onChange({ reminderMode: "periodic", reminderValue: durationDigitsToHours(event.currentTarget.value) });
                setEditingTiming(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  props.onChange({
                    reminderMode: "periodic",
                    reminderValue: durationDigitsToHours(event.currentTarget.value),
                  });
                  setEditingTiming(null);
                }
              }}
              onContextMenu={(event) =>
                reset(event, {
                  reminderMode: DEFAULT_SETTINGS.reminderMode,
                  reminderValue: DEFAULT_SETTINGS.reminderValue,
                })
              }
            />
          </Show>

          <Show
            when={editingTiming() === "timeOfDay"}
            fallback={
              <button
                type="button"
                class={props.settings.reminderMode === "timeOfDay" ? "is-active" : ""}
                onClick={() => {
                  const value =
                    props.settings.reminderMode === "timeOfDay"
                      ? timeToDigits(props.settings.reminderValue || "0000")
                      : "00:00";
                  setTimeOfDayDraft(maskDigits(value));
                  props.onChange({ reminderMode: "timeOfDay", reminderValue: normalizeTimeOfDay(value) });
                  setEditingTiming("timeOfDay");
                }}
                onContextMenu={(event) =>
                  reset(event, {
                    reminderMode: DEFAULT_SETTINGS.reminderMode,
                    reminderValue: DEFAULT_SETTINGS.reminderValue,
                  })
                }
              >
                Time of day
                <small>{normalizeTimeOfDay(props.settings.reminderValue || "0000")}</small>
              </button>
            }
          >
            <input
              aria-label="Time of day"
              inputMode="numeric"
              value={timeOfDayDraft()}
              onInput={(event) => setTimeOfDayDraft(maskDigits(event.currentTarget.value))}
              onBlur={(event) => {
                props.onChange({ reminderMode: "timeOfDay", reminderValue: normalizeTimeOfDay(event.currentTarget.value) });
                setEditingTiming(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  props.onChange({
                    reminderMode: "timeOfDay",
                    reminderValue: normalizeTimeOfDay(event.currentTarget.value),
                  });
                  setEditingTiming(null);
                }
              }}
              onContextMenu={(event) =>
                reset(event, {
                  reminderMode: DEFAULT_SETTINGS.reminderMode,
                  reminderValue: DEFAULT_SETTINGS.reminderValue,
                })
              }
            />
          </Show>
        </div>
      </div>

      <label class="setting-row">
        <span>Target</span>
        <select
          value={props.settings.reminderTarget}
          onChange={(event) => props.onChange({ reminderTarget: event.currentTarget.value as ReminderTarget })}
          onContextMenu={(event) => reset(event, { reminderTarget: DEFAULT_SETTINGS.reminderTarget })}
        >
          <option value="all">All notes</option>
          <option value="attention">Important or tasks</option>
          <option value="important">Important</option>
          <option value="tasks">Uncrossed tasks</option>
        </select>
      </label>
      <Show when={capturingKeybind()}>
        {(target) => (
          <KeybindCapturePopover
            label={keybindSettingLabel(target())}
            onCancel={() => setCapturingKeybind(null)}
            onCommit={(value) => {
              props.onChange({ [target()]: value } as Partial<Settings>);
              setCapturingKeybind(null);
            }}
          />
        )}
      </Show>
    </div>
  );
}

function keybindSettingLabel(key: keyof Pick<Settings, "strikeKeybind" | "scribbleKeybind" | "copyNoteKeybind" | "newNoteKeybind" | "hideNotesKeybind">) {
  return {
    strikeKeybind: "Cross out",
    scribbleKeybind: "Scribble",
    copyNoteKeybind: "Copy note",
    newNoteKeybind: "New note",
    hideNotesKeybind: "Hide notes",
  }[key];
}

function KeybindInput(props: {
  ariaLabel: string;
  value: string;
  onCapture: () => void;
  onReset: (event: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      class="keybind-input"
      aria-label={props.ariaLabel}
      onClick={props.onCapture}
      onContextMenu={(event) => {
        if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
        props.onReset(event);
      }}
    >
      {props.value}
    </button>
  );
}

function KeybindCapturePopover(props: {
  label: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
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
      if (!popoverRef?.contains(event.target as Node)) {
        props.onCancel();
      }
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
    <div
      ref={popoverRef}
      class="surface-popover keybind-popover"
      role="dialog"
      tabIndex={-1}
      aria-label={`${props.label} keybind capture`}
      onContextMenu={(event) => event.preventDefault()}
    >
      <strong>{props.label}</strong>
      <p
        class="capture-target"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          commit(pointerCombo(event));
        }}
      >
        {draft()}
      </p>
      <button
        type="button"
        class="ghost-close"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={props.onCancel}
      >
        Cancel
      </button>
    </div>
  );
}

function loadState(): AppState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return createInitialState();
  try {
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      notes: parsed.notes ?? [],
      launcher: {
        colorIndex: parsed.launcher?.colorIndex ?? randomColorIndex(),
        corner: parsed.launcher?.corner ?? "bottom-right",
      },
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      lastNoteSize: parsed.lastNoteSize,
    };
  } catch {
    return createInitialState();
  }
}

function saveState(state: AppState, options: { broadcast?: boolean } = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (options.broadcast !== false) {
    channel?.postMessage({ type: "state" });
  }
}

function persistLinePatch(noteId: string, lineId: string, patch: Partial<NoteLine>) {
  const latest = loadState();
  const next = {
    ...latest,
    notes: latest.notes.map((note) =>
      note.id === noteId
        ? {
            ...note,
            updatedAt: new Date().toISOString(),
            lines: note.lines.map((line) => (line.id === lineId ? { ...line, ...patch } : line)),
          }
        : note,
    ),
  };
  saveState(next, { broadcast: false });
}

function persistNoteBody(noteId: string, lineId: string, text: string) {
  const latest = loadState();
  const next = {
    ...latest,
    notes: latest.notes.map((note) =>
      note.id === noteId
        ? {
            ...note,
            updatedAt: new Date().toISOString(),
            lines: [{ id: note.lines[0]?.id ?? lineId, text, task: false, crossed: false }],
          }
        : note,
    ),
  };
  saveState(next, { broadcast: false });
}

function persistNoteRightText(noteId: string, rightText: string) {
  const latest = loadState();
  const next = {
    ...latest,
    notes: latest.notes.map((note) =>
      note.id === noteId
        ? {
            ...note,
            rightText,
            updatedAt: new Date().toISOString(),
          }
        : note,
    ),
  };
  saveState(next, { broadcast: false });
}

async function ensureDefaultExportPath(setState: (state: AppState) => void) {
  if (!isTauri()) return;
  const latest = loadState();
  if (latest.settings.exportPath) return;
  const next = {
    ...latest,
    settings: {
      ...latest.settings,
      exportPath: await documentDir(),
      copyAfterSave: true,
    },
  };
  saveState(next);
  setState(next);
}

function resetDebugSessionState(setState?: (state: AppState) => void) {
  const current = loadState();
  const reset = {
    ...resetNotesForDebug(current),
    lastNoteSize: undefined,
    settings: {
      ...current.settings,
      copyAfterSave: true,
      remindersEnabled: true,
    },
  };
  saveState(reset);
  setState?.(reset);
}

function markCurrentNoteViewed(noteId: string, setState?: (state: AppState) => void) {
  const next = markNoteViewed(loadState(), noteId, new Date().toISOString());
  saveState(next);
  setState?.(next);
}

function persistNotePosition(noteId: string, position: { x: number; y: number }, setState?: (state: AppState) => void) {
  const next = updateNotePosition(loadState(), noteId, position);
  saveState(next);
  setState?.(next);
}

function persistNoteSize(noteId: string, size: { width: number; height: number }, setState?: (state: AppState) => void) {
  const next = updateNoteSize(loadState(), noteId, size);
  saveState(next);
  setState?.(next);
}

function createInitialState(): AppState {
  return createModelInitialState(randomColorIndex());
}

function randomColorIndex() {
  return Math.floor(Math.random() * NOTE_COLORS.length);
}

function createId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getColor(key = NOTE_COLORS[0].key) {
  return NOTE_COLORS.find((color) => color.key === key) ?? NOTE_COLORS[0];
}

function noteLabel(id: string) {
  return `note-${id}`;
}

function noteLabelText(note: Note) {
  const title = note.title.trim();
  if (title) return title;
  const body = note.lines.map((line) => line.text).join(" ").trim();
  if (body) return slug(body).slice(0, 34) || "note";
  return new Date(note.createdAt).toLocaleString();
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function parseLineInput(raw: string): Partial<NoteLine> {
  const text = raw.replace(/\u00a0/g, " ");
  const task = text.match(/^-\s*(?:\[( |x)\]\s*)?(.*)$/i);
  if (task) {
    return {
      task: true,
      crossed: task[1]?.toLowerCase() === "x",
      text: task[2] ?? "",
    };
  }
  return { text, task: false, crossed: false };
}

async function configureLauncherWindow(
  menuOpen: boolean,
  hovered = false,
  confirmingExit = false,
  anchor: LauncherAnchor | null = null,
  setAnchor?: (anchor: LauncherAnchor) => void,
) {
  if (!isTauri() || launcherUserDragging) return;
  const run = ++launcherConfigureRun;
  launcherIsConfiguring = true;
  void hovered;
  const expanded = menuOpen || confirmingExit;
  const width = confirmingExit ? LAUNCHER_CONFIRM_CANVAS_WIDTH : expanded ? LAUNCHER_CANVAS_WIDTH : LAUNCHER_IDLE_CANVAS_WIDTH;
  const height = confirmingExit ? LAUNCHER_CONFIRM_CANVAS_HEIGHT : expanded ? LAUNCHER_CANVAS_HEIGHT : LAUNCHER_IDLE_CANVAS_HEIGHT;
  const parking = launcherParkingSize();
  const appWindow = getCurrentWindow();
  try {
    const monitor = await primaryMonitor();
    if (run !== launcherConfigureRun) return;
    const scale = monitor?.scaleFactor || 1;
    await appWindow.setAlwaysOnTop(true);
    await appWindow.setSkipTaskbar(true);
    await appWindow.setResizable(false);
    await appWindow.setSize(new LogicalSize(width, height));
    if (run !== launcherConfigureRun) return;
    if (anchor || launcherWasPlaced) {
      const nextAnchor = anchor ?? (await readWindowAnchor());
      await positionLauncherFromAnchor(width, height, parking.width, parking.height, nextAnchor);
      if (run !== launcherConfigureRun) return;
      if (!confirmingExit) setAnchor?.(await readWindowAnchor());
      return;
    } else {
      const work = monitor?.workArea;
      if (!work) return;
      await positionWindow(width, height, parking.width, parking.height);
      if (run !== launcherConfigureRun) return;
      setAnchor?.(await readWindowAnchor());
      launcherWasPlaced = true;
    }
  } finally {
    if (run === launcherConfigureRun) {
      window.setTimeout(() => {
        if (run === launcherConfigureRun) launcherIsConfiguring = false;
      }, 120);
    }
  }
}

function launcherVisualSize(expanded: boolean, confirmingExit = false) {
  void confirmingExit;
  return expanded ? { width: MENU_WIDTH, height: MENU_HEIGHT } : { width: STRIP_HIT_WIDTH, height: STRIP_HEIGHT };
}

function launcherParkingSize() {
  return { width: MENU_WIDTH, height: MENU_HEIGHT };
}

async function updateConfirmSide(setConfirmSide: (side: "left" | "right") => void) {
  if (!isTauri()) return;
  const monitor = await primaryMonitor();
  if (!monitor) return;
  const scale = monitor.scaleFactor || 1;
  const position = await getCurrentWindow().outerPosition();
  const size = await getCurrentWindow().outerSize();
  const work = monitor.workArea;
  const windowCenterX = position.x / scale + size.width / scale / 2;
  const workCenterX = (work.position.x + work.size.width / 2) / scale;
  setConfirmSide(windowCenterX > workCenterX ? "left" : "right");
}

async function readWindowAnchor(): Promise<LauncherAnchor> {
  const monitor = await primaryMonitor();
  const scale = monitor?.scaleFactor || 1;
  const work = monitor?.workArea;
  const position = await getCurrentWindow().outerPosition();
  const size = await getCurrentWindow().outerSize();
  if (!work) return { right: 16, bottom: 16 };
  const right = (work.position.x + work.size.width) / scale;
  const bottom = (work.position.y + work.size.height) / scale;
  const axisX = position.x / scale + size.width / scale / 2;
  const axisY = position.y / scale + size.height / scale / 2;
  return {
    right: right - axisX,
    bottom: bottom - axisY,
  };
}

async function configureNoteWindow(noteId: string) {
  if (!isTauri()) return;
  const appWindow = getCurrentWindow();
  const note = loadState().notes.find((item) => item.id === noteId);
  const size = note?.size ?? { width: DEFAULT_NOTE_SIZE, height: DEFAULT_NOTE_SIZE };
  await appWindow.setAlwaysOnTop(true);
  await appWindow.setSkipTaskbar(true);
  await appWindow.setSize(new LogicalSize(size.width, size.height));
}

async function configureUtilityWindow(width: number, height: number) {
  if (!isTauri()) return;
  const appWindow = getCurrentWindow();
  await appWindow.setAlwaysOnTop(true);
  await appWindow.setSkipTaskbar(false);
  await appWindow.setResizable(true);
  await appWindow.setSize(new LogicalSize(width, height));
}

async function closeCurrentWindow() {
  if (!isTauri()) return;
  const current = getCurrentWindow();
  if (current.label.startsWith("note-")) {
    channel?.postMessage({ type: "note-closed", noteId: current.label.slice(5) });
  }
  await current.close();
}

async function noteSpawnOrigin() {
  if (!isTauri()) return { x: 160, y: 160 };
  const monitor = await primaryMonitor();
  const scale = monitor?.scaleFactor || 1;
  const work = monitor?.workArea;
  if (!work) return { x: 160, y: 160 };
  const launcherPosition = await getCurrentWindow().outerPosition();
  const launcherSize = await getCurrentWindow().outerSize();
  const launcherCenter = {
    x: launcherPosition.x / scale + launcherSize.width / scale / 2,
    y: launcherPosition.y / scale + launcherSize.height / scale / 2,
  };
  const workLeft = work.position.x / scale;
  const workTop = work.position.y / scale;
  const workRight = (work.position.x + work.size.width) / scale;
  const workBottom = (work.position.y + work.size.height) / scale;
  const workCenter = {
    x: (workLeft + workRight) / 2,
    y: (workTop + workBottom) / 2,
  };
  const delta = {
    x: workCenter.x - launcherCenter.x,
    y: workCenter.y - launcherCenter.y,
  };
  const distance = Math.hypot(delta.x, delta.y) || 1;
  const direction = { x: delta.x / distance, y: delta.y / distance };
  const spacing = 126;
  const x = launcherCenter.x + direction.x * spacing - DEFAULT_NOTE_SIZE / 2;
  const y = launcherCenter.y + direction.y * spacing - DEFAULT_NOTE_SIZE / 2;
  return {
    x: clamp(x, workLeft + 16, workRight - DEFAULT_NOTE_SIZE - 16),
    y: clamp(y, workTop + 16, workBottom - DEFAULT_NOTE_SIZE - 16),
  };
}

async function positionWindow(width: number, height: number, visualWidth = width, visualHeight = height) {
  const monitor = await primaryMonitor();
  if (!monitor) return;
  const scale = monitor.scaleFactor || 1;
  const work = monitor.workArea;
  const left = work.position.x / scale;
  const top = work.position.y / scale;
  const right = (work.position.x + work.size.width) / scale;
  const bottom = (work.position.y + work.size.height) / scale;
  const rawCenterX = right - LAUNCHER_SCREEN_MARGIN - visualWidth / 2;
  const rawCenterY = top + LAUNCHER_SCREEN_MARGIN + visualHeight / 2;
  const centerX = clamp(rawCenterX, left + LAUNCHER_SCREEN_MARGIN + visualWidth / 2, right - LAUNCHER_SCREEN_MARGIN - visualWidth / 2);
  const centerY = clamp(rawCenterY, top + LAUNCHER_SCREEN_MARGIN + visualHeight / 2, bottom - LAUNCHER_SCREEN_MARGIN - visualHeight / 2);
  await getCurrentWindow().setPosition(new LogicalPosition(centerX - width / 2, centerY - height / 2));
}

async function positionLauncherFromAnchor(
  width: number,
  height: number,
  visualWidth: number,
  visualHeight: number,
  anchor: LauncherAnchor,
) {
  const monitor = await primaryMonitor();
  if (!monitor) return;
  const scale = monitor.scaleFactor || 1;
  const work = monitor.workArea;
  const left = work.position.x / scale;
  const top = work.position.y / scale;
  const right = (work.position.x + work.size.width) / scale;
  const bottom = (work.position.y + work.size.height) / scale;
  const rawCenterX = right - anchor.right;
  const rawCenterY = bottom - anchor.bottom;
  const centerX = clamp(rawCenterX, left + LAUNCHER_SCREEN_MARGIN + visualWidth / 2, right - LAUNCHER_SCREEN_MARGIN - visualWidth / 2);
  const centerY = clamp(rawCenterY, top + LAUNCHER_SCREEN_MARGIN + visualHeight / 2, bottom - LAUNCHER_SCREEN_MARGIN - visualHeight / 2);
  await getCurrentWindow().setPosition(new LogicalPosition(centerX - width / 2, centerY - height / 2));
}

async function clampCurrentLauncherToWorkArea(visualWidth: number, visualHeight: number, margin: number) {
  if (!isTauri()) return false;
  const monitor = await primaryMonitor();
  if (!monitor) return false;
  const scale = monitor.scaleFactor || 1;
  const work = monitor.workArea;
  const position = await getCurrentWindow().outerPosition();
  const size = await getCurrentWindow().outerSize();
  const windowX = position.x / scale;
  const windowY = position.y / scale;
  const windowWidth = size.width / scale;
  const windowHeight = size.height / scale;
  const parkingLeft = windowX + (windowWidth - visualWidth) / 2;
  const parkingTop = windowY + (windowHeight - visualHeight) / 2;
  const parkingRight = parkingLeft + visualWidth;
  const parkingBottom = parkingTop + visualHeight;
  const allowedLeft = work.position.x / scale + margin;
  const allowedTop = work.position.y / scale + margin;
  const allowedRight = (work.position.x + work.size.width) / scale - margin;
  const allowedBottom = (work.position.y + work.size.height) / scale - margin;
  let dx = 0;
  let dy = 0;

  if (parkingLeft < allowedLeft) dx = allowedLeft - parkingLeft;
  else if (parkingRight > allowedRight) dx = allowedRight - parkingRight;

  if (parkingTop < allowedTop) dy = allowedTop - parkingTop;
  else if (parkingBottom > allowedBottom) dy = allowedBottom - parkingBottom;

  if (Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5) return false;
  await getCurrentWindow().setPosition(new LogicalPosition(windowX + dx, windowY + dy));
  return true;
}

async function openTextMenuPopupWindow(noteId: string, field: "body" | "right", clientX: number, clientY: number, hasSelection: boolean, start: number, end: number) {
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

async function openNoteWindow(id: string) {
  if (!isTauri()) return;
  const existing = await WebviewWindow.getByLabel(noteLabel(id));
  if (existing) {
    await existing.setFocus();
    return;
  }

  const note = loadState().notes.find((item) => item.id === id);
  const origin = await noteSpawnOrigin();
  const x = note?.position?.x ?? origin.x;
  const y = note?.position?.y ?? origin.y;

  const size = note?.size ?? { width: DEFAULT_NOTE_SIZE, height: DEFAULT_NOTE_SIZE };

  const webview = new WebviewWindow(noteLabel(id), {
    url: `index.html?role=note&id=${encodeURIComponent(id)}`,
    title: "Simeioma Note",
    x: Math.max(16, x),
    y: Math.max(16, y),
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
    visible: true,
  });

  await webview.once("tauri://created", () => undefined);
}

async function closeAllNoteWindows() {
  if (!isTauri()) return;
  for (const noteWindow of await getAllWebviewWindows()) {
    if (noteWindow.label.startsWith("note-")) {
      await noteWindow.close();
    }
  }
}

async function hideAllNoteWindows() {
  if (!isTauri()) return;
  for (const noteWindow of await getAllWebviewWindows()) {
    if (noteWindow.label.startsWith("note-")) {
      await noteWindow.hide();
    }
  }
  channel?.postMessage({ type: "notes-hidden" });
}

async function closeAuxiliaryWindows() {
  if (!isTauri()) return;
  for (const label of ["settings", "notes-list"]) {
    const utilityWindow = await WebviewWindow.getByLabel(label);
    await utilityWindow?.close();
  }
}

function startUtilityDrag(event: PointerEvent) {
  if (!isTauri()) return;
  const target = event.target as HTMLElement;
  if (target.closest("button, input, select, textarea")) return;
  getCurrentWindow().startDragging();
}

async function openSettingsWindow() {
  if (!isTauri()) return;
  const existing = await WebviewWindow.getByLabel("settings");
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }

  const monitor = await primaryMonitor();
  const scale = monitor?.scaleFactor || 1;
  const work = monitor?.workArea;
  const width = 380;
  const height = 520;
  const x = work ? (work.position.x + work.size.width) / scale - width - 88 : 180;
  const y = work ? (work.position.y + work.size.height) / scale - height - 88 : 140;

  const webview = new WebviewWindow("settings", {
    url: "index.html?role=settings",
    title: "Simeioma Settings",
    x: Math.max(16, x),
    y: Math.max(16, y),
    width,
    height,
    minWidth: 340,
    minHeight: 440,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    shadow: false,
    visible: true,
  });

  await webview.once("tauri://created", () => undefined);
}

async function openNotesListWindow() {
  if (!isTauri()) return;
  const existing = await WebviewWindow.getByLabel("notes-list");
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }

  const monitor = await primaryMonitor();
  const scale = monitor?.scaleFactor || 1;
  const work = monitor?.workArea;
  const width = 320;
  const height = 440;
  const x = work ? (work.position.x + work.size.width) / scale - width - 88 : 180;
  const y = work ? (work.position.y + work.size.height) / scale - height - 88 : 140;

  const webview = new WebviewWindow("notes-list", {
    url: "index.html?role=list",
    title: "Simeioma Notes",
    x: Math.max(16, x),
    y: Math.max(16, y),
    width,
    height,
    minWidth: 280,
    minHeight: 300,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    shadow: false,
    visible: true,
  });

  await webview.once("tauri://created", () => undefined);
}

function focusFirstLine() {
  window.setTimeout(() => {
    document.querySelector<HTMLElement>("[data-line-id]")?.focus();
  }, 0);
}

function collectMentions(note: Note | undefined, candidates: Note[]) {
  if (!note) return [];
  const body = `${note.lines.map((line) => line.text).join(" ")} ${note.rightText ?? ""}`;
  const tokens = Array.from(body.matchAll(/@([a-z0-9-]+)/gi)).map((match) => match[1].toLowerCase());
  if (!tokens.length) return [];
  return candidates.filter((candidate) => tokens.includes(slug(noteLabelText(candidate)).toLowerCase()));
}

function noteToMarkdown(note: Note) {
  const title = note.title.trim() || noteLabelText(note);
  const lines = note.lines.map((line) => {
    const box = line.task ? `- [${line.crossed ? "x" : " "}] ` : "";
    const text = line.crossed && !line.task ? `~~${line.text}~~` : line.text;
    return `${box}${text}`;
  });
  const left = lines.join("\n");
  if (note.layout === "two-column") {
    return `# ${title}\n\n## Left\n\n${left}\n\n## Right\n\n${note.rightText ?? ""}\n`;
  }
  return `# ${title}\n\n${left}\n`;
}

function shouldBlockNoteDrag(event: PointerEvent) {
  const target = event.target as HTMLElement;
  if (target.closest("button, select, .color-popover, .note-context-menu, .mention-row, .note-resize-handle")) return true;
  if (target.closest(".note-titlebar")) return Boolean(target.closest("button, .color-popover, .note-context-menu"));
  if (target.closest("textarea, input, .note-body-editor")) return true;

  const preview = target.closest(".note-body-preview");
  if (preview) return isPointerOverRenderedText(preview, event);

  return false;
}

function isPointerOverRenderedText(preview: Element, event: PointerEvent) {
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  const node = range?.startContainer;
  return Boolean(node && preview.contains(node) && node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
}

function toggleCurrentEditableLineStrike(editor: HTMLElement) {
  const value = editablePlainText(editor);
  const cursor = editableSelectionOffsets(editor)?.start ?? value.length;
  const lineStart = value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const nextBreak = value.indexOf("\n", cursor);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const line = value.slice(lineStart, lineEnd);
  const replacement = line.startsWith("~~") && line.endsWith("~~") ? line.slice(2, -2) : `~~${line}~~`;
  const next = `${value.slice(0, lineStart)}${replacement}${value.slice(lineEnd)}`;
  editor.textContent = next;
  setEditorSelectionOffsets(editor, lineStart, lineStart + replacement.length);
  return next;
}

function notesToMarkdown(notes: Note[]) {
  return notes.map(noteToMarkdown).join("\n---\n\n");
}

function notesToText(notes: Note[]) {
  return notes
    .map((note) => {
      const lines = note.lines.map((line) => `${line.crossed ? "[done] " : ""}${line.text}`);
      const left = lines.join("\n");
      if (note.layout === "two-column") {
        return `${noteLabelText(note)}\nLeft:\n${left}\n\nRight:\n${note.rightText ?? ""}`;
      }
      return `${noteLabelText(note)}\n${left}`;
    })
    .join("\n\n---\n\n");
}

async function saveTextExport(settings: Settings, filename: string, contents: string) {
  if (settings.copyAfterSave) await copyText(contents);
  if (settings.exportPath && isTauri()) {
    await invoke("save_text_file", { directory: settings.exportPath, filename, contents });
    return;
  }
  downloadBytes(filename, new TextEncoder().encode(contents), "text/plain");
}

async function saveBinaryExport(settings: Settings, filename: string, bytes: Uint8Array, format: ExportFormat) {
  if (settings.exportPath && isTauri()) {
    await invoke("save_binary_file", { directory: settings.exportPath, filename, bytes: Array.from(bytes) });
    return;
  }
  downloadBytes(filename, bytes, format === "jpeg" ? "image/jpeg" : "image/png");
}

async function copyText(value: string) {
  if (isTauri()) {
    await invoke("write_clipboard_text", { text: value });
    return;
  }
  await navigator.clipboard?.writeText(value);
}

function downloadBytes(filename: string, bytes: Uint8Array, type: string) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function renderNotesImage(notes: Note[], format: ExportFormat) {
  const width = 720;
  const noteHeight = 180;
  const padding = 32;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(240, notes.length * (noteHeight + 16) + padding * 2);
  const context = canvas.getContext("2d");
  if (!context) return new Uint8Array();

  context.fillStyle = "#f7f2df";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "18px Segoe UI, sans-serif";

  notes.forEach((note, index) => {
    const color = getColor(note.colorKey);
    const y = padding + index * (noteHeight + 16);
    roundRect(context, padding, y, width - padding * 2, noteHeight, 18, color.bg);
    context.fillStyle = color.ink;
    context.font = "600 20px Segoe UI, sans-serif";
    context.fillText(noteLabelText(note), padding + 20, y + 38);
    context.font = "15px Segoe UI, sans-serif";
    note.lines.slice(0, 6).forEach((line, lineIndex) => {
      context.fillText(`${line.task ? (line.crossed ? "[x] " : "[ ] ") : ""}${line.text}`, padding + 20, y + 72 + lineIndex * 20);
    });
  });

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, format === "jpeg" ? "image/jpeg" : "image/png", 0.92),
  );
  return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string,
) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
}

function maybeTriggerReminder(
  state: AppState,
  setState: (state: AppState) => void,
  setNotice: (notice: ReminderNotice | null) => void,
) {
  const settings = state.settings;
  if (!settings.remindersEnabled) return;
  const matches = reminderNotes(state.notes, settings.reminderTarget);
  const unviewed = unviewedReminderNotes(state.notes, settings.reminderTarget);
  const count = unviewedReminderCount(state.notes, settings.reminderTarget);
  if (!matches.length || !unviewed.length || !count) return;
  if (!isReminderDue(settings)) return;

  const next = { ...state, settings: { ...settings, lastReminderAt: new Date().toISOString() } };
  saveState(next);
  setState(next);
  setNotice({
    title: "Reminder",
    body: `${count} ${count === 1 ? "note" : "notes"} need attention`,
    noteIds: unviewed.map((note) => note.id),
  });
}

function keyCombo(event: KeyboardEvent) {
  const key = readableKey(event.key);
  if (!key) return "";
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Meta");
  parts.push(key);
  return parts.join(" + ");
}

function readableKey(key: string) {
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return "";
  if (key.length === 1) return key.toUpperCase();
  if (key.startsWith("Arrow")) return key.replace("Arrow", "");
  if (key === " ") return "Space";
  return key;
}

function pointerCombo(event: MouseEvent | PointerEvent) {
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Meta");
  parts.push(mouseButtonName(event.button));
  return parts.join(" + ");
}

function matchesCombo(actual: string, expected: string) {
  return normalizeCombo(actual) === normalizeCombo(expected);
}

function normalizeCombo(combo: string) {
  return combo
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join(" + ");
}

function mouseButtonName(button: number) {
  if (button === 2) return "Right Click";
  if (button === 1) return "Middle Click";
  return "Left Click";
}

function maskDigits(value: string) {
  const digits = value.replace(/\D/g, "").slice(-4).padStart(4, "0");
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

function timeToDigits(value: string) {
  return maskDigits(value).replace(":", "");
}

function durationToDigits(value: string) {
  const totalMinutes = Math.round(Number(normalizePeriodicHours(value)) * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}`;
}

function durationDigitsToHours(value: string) {
  const masked = maskDigits(value);
  const [hours, minutes] = masked.split(":").map(Number);
  return normalizePeriodicHours(String(hours + minutes / 60));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

async function readClipboardText() {
  try {
    if (isTauri()) return String(await invoke("read_clipboard_text"));
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

async function isLeftMouseDown() {
  if (!isTauri()) return false;
  try {
    return Boolean(await invoke("is_left_mouse_down"));
  } catch {
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 6.5 1.55 3.14 3.46.5-2.5 2.44.59 3.45L12 14.4l-3.1 1.63.59-3.45-2.5-2.44 3.46-.5L12 6.5Z" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 7h11M8 12h11M8 17h11" />
      <path d="M4.5 7h.01M4.5 12h.01M4.5 17h.01" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v10" />
      <path d="m8 10 4 4 4-4" />
      <path d="M5 20h14" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7h14M5 12h14M5 17h14" />
      <path d="M9 5v4M15 10v4M11 15v4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 7h5M14 7h5M5 12h5M14 12h5M5 17h5M14 17h5" />
    </svg>
  );
}

export default App;
