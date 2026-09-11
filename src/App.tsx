import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { isTauri } from "@tauri-apps/api/core";
import {
  invokeObserved as invoke, diagnosticStorageKey,
  startDiagnostics, setLauncherDiagnosticReader, recordDiagnostic,
  beforeDiagnosticResize, recordActualLauncherGeometry, scheduleDiagnosticSnapshot, startObservedWindowDrag,
} from "./diagnostics";
import { emitTo, listen } from "@tauri-apps/api/event";
import { documentDir } from "@tauri-apps/api/path";
import { message as showMessage } from "@tauri-apps/plugin-dialog";
import {
  PhysicalPosition,
  LogicalSize,
  getCurrentWindow,
  primaryMonitor,
} from "@tauri-apps/api/window";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import {
  DEFAULT_NOTE_SIZE,
  MENU_HEIGHT,
  MENU_WIDTH,
  NOTE_COLORS,
  NOTE_TITLE_HEIGHT,
  clearNotesFromState,
  createNoteInState,
  isReminderDue,
  launcherPrimaryAction,
  markNoteViewed,
  removeNoteFromState,
  unviewedReminderNotes,
  updateNotePosition,
  updateNoteSize,
  type AppState,
  type Note,
  type ReminderNotice,
  type Settings,
  type SketchStrokeRecord,
} from "./simeiomaModel";
import { keyCombo, matchesCombo, pointerCombo } from "./inputCombos";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import {
  clearSketchCanvas,
  coalescedPointerEvents,
  drawSketch,
  finishSketch,
  prepareSketchCanvas,
  renderSketchRecord,
  startSketch,
  type SketchStroke,
} from "./sketch";
import { SettingsPanel } from "./settingsPanel";
import {
  clampParkingDelta,
  launcherAnchorFromWindow,
  parkingRect,
  scaledWorkArea,
  visualCenterForTopRight,
  visualCenterFromAnchor,
  windowPositionForVisualCenter,
  type LauncherAnchor,
  type WorkArea,
  type WindowRect,
} from "./windowGeometry";
import { createLauncherConfiguration } from "./launcherConfiguration";
import { planUtilityWindows, rectsOverlap, SPAWN_SCREEN_MARGIN, UTILITY_MIN_SIZE, type UtilityRole } from "./spawnPlacement";
import { readSpawnContext, readSpawnAnchor, readLauncherMonitor, windowRectInWorkArea, waitForWindowCreated, placeCreatedWindow } from "./windowSpawning";
import { loadState, updateState, transactState, stateChannel as channel } from "./persistence";
import { observeUtilityFocus } from "./utilityLifecycle";
import { createLifetime } from "./lifetime";
import { noteBody, hasOpenTasks } from "./noteContent";
import { exportSession, exportNote, copyText, reportExportFailure } from "./exports";
import { noteLabelText, slug } from "./noteLabels";
import { RecoveryWindow } from "./RecoveryWindow";
import "./App.css";

const STORAGE_KEY = diagnosticStorageKey;
const HOLD_TO_DRAG_MS = 0;
const LAUNCHER_CANVAS_WIDTH = 64;
const LAUNCHER_CANVAS_HEIGHT = 204;
const LAUNCHER_CONFIRM_CANVAS_WIDTH = 360;
const LAUNCHER_CONFIRM_CANVAS_HEIGHT = 204;
const LAUNCHER_IDLE_CANVAS_WIDTH = 30;
const LAUNCHER_IDLE_CANVAS_HEIGHT = 112;
const LAUNCHER_SCREEN_MARGIN = SPAWN_SCREEN_MARGIN;

let launcherWasPlaced = false;
let launcherIsConfiguring = false;
let launcherConfigureRun = 0;
const [launcherUserDragging, setLauncherUserDragging] = createSignal(false);
const configureLauncherWindow = createLauncherConfiguration(
  applyLauncherWindowConfiguration,
  (event, request, status) => recordDiagnostic(`configuration-${event}`, {
    ...status, menuOpen: request.menuOpen, confirmingExit: request.confirmingExit,
  }),
);
let noteCreationQueue: Promise<void> = Promise.resolve();
let utilityCreationQueue: Promise<void> = Promise.resolve();

function App() {
  onMount(() => {
    onCleanup(startDiagnostics(loadState));
    const suppressNativeContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", suppressNativeContextMenu);
    onCleanup(() => document.removeEventListener("contextmenu", suppressNativeContextMenu));
  });

  try { loadState(); } catch { return <RecoveryWindow storageKey={STORAGE_KEY} />; }
  const params = new URLSearchParams(window.location.search);
  const role = params.get("role");
  const noteId = params.get("id");

  if (role === "note" && noteId) {
    return <NoteWindow noteId={noteId} autoFocus={params.get("autofocus") !== "0"} />;
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
  const [menuOpen, setMenuOpen] = createSignal(false);
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
  let togglingNoteVisibility = false;

  onMount(() => {
    const life = createLifetime(() => recordDiagnostic("native-command-failed"));
    let moveSaveTimer: number | undefined;

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "state") {
        setState(loadState());
      }
    };
    channel?.addEventListener("message", onMessage);

    const interval = window.setInterval(() => {
      const latest = loadState();
      setState(latest);
      void maybeTriggerReminder(setState, setNotice).catch(() => {});
    }, 15000);

    if (isTauri()) {
      const drainSettingsRequest = async () => {
        if (life.active && await invoke<boolean>("take_settings_request") && life.active) await openSettingsWindow();
      };
      const reportSettingsFailure = () => console.error("Settings creation failed (details redacted)");
      const settingsSubscription = listen("simeioma:settings-requested", life.guard(() => {
        void drainSettingsRequest().catch(reportSettingsFailure);
      }));
      life.own(settingsSubscription);
      life.after(settingsSubscription, () => drainSettingsRequest());
      life.own(getCurrentWindow().onFocusChanged(life.guard(({ payload: focused }) => {
        if (!focused && menuOpen()) setMenuOpen(false);
      })));
      life.own(getCurrentWindow().onMoved(life.guard(() => {
        if (launcherIsConfiguring) return;
        window.clearTimeout(moveSaveTimer);
        if (launcherUserDragging()) return;
        moveSaveTimer = window.setTimeout(() => {
          if (life.active) void settleLauncherPosition();
        }, 80);
      })));
    }

    onCleanup(() => {
      channel?.removeEventListener("message", onMessage);
      window.clearInterval(interval);
      window.clearTimeout(dragTimer);
      window.clearTimeout(moveSaveTimer);
      window.clearTimeout(settleDragTimer);
      life.dispose();
    });
  });

  setLauncherDiagnosticReader(() => ({
    menuOpen: menuOpen(), confirmingExit: confirmingExit(),
    dragging: launcherUserDragging(), configuring: launcherIsConfiguring,
    anchor: launcherAnchor, ...configureLauncherWindow.snapshot(),
    requested: {
      width: confirmingExit() ? LAUNCHER_CONFIRM_CANVAS_WIDTH : menuOpen() ? LAUNCHER_CANVAS_WIDTH : LAUNCHER_IDLE_CANVAS_WIDTH,
      height: confirmingExit() ? LAUNCHER_CONFIRM_CANVAS_HEIGHT : menuOpen() ? LAUNCHER_CANVAS_HEIGHT : LAUNCHER_IDLE_CANVAS_HEIGHT,
    },
  }));

  createEffect(() => {
    recordDiagnostic("launcher-state", {
      menuOpen: menuOpen(), confirmingExit: confirmingExit(), dragging: launcherUserDragging(),
    });
    if (launcherUserDragging()) return;
    void configureLauncherWindow({
      menuOpen: menuOpen(), confirmingExit: confirmingExit(), anchor: launcherAnchor,
      setAnchor: (anchor) => (launcherAnchor = anchor),
      setConfirmSide,
    }).catch(() => console.error("Launcher window configuration failed (details redacted)"));
  });

  createEffect(() => {
    if (confirmingExit()) {
      window.setTimeout(() => confirmButtonRef?.focus(), 0);
    }
  });

  const createNote = () => enqueueNoteCreation(async () => {
    await configureLauncherWindow.whenIdle();
    const current = loadState();
    const visibleNotes = await visibleNotesInState(current);
    const context = await readSpawnContext();
    const anchor = await readSpawnAnchor(visibleNotes.at(-1), context);
    const result = await transactState(state => createNoteInState(state, {
      id: createId(), lineId: createId(), now: new Date().toISOString(),
      origin: context?.origin ?? { x: 160, y: 160 }, spawnAfter: anchor.note, spawnBounds: anchor.bounds,
    }));
    if (!result.note) return;
    setState(loadState());
    await openNoteWindow(result.note.id, { spawnScale: anchor.scale });
  });

  const exportAll = () => exportSession().catch(reportExportFailure);

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
    if (togglingNoteVisibility) return;
    togglingNoteVisibility = true;
    try {
      const current = loadState();
      const windowStates = await noteWindowStatesInState(current);
      const visibleWindows = windowStates.filter(({ visible }) => visible);
      if (visibleWindows.length) {
        await invoke("set_note_windows_visibility", {
          labels: visibleWindows.map(({ note }) => noteLabel(note.id)),
          visible: false,
        });
      } else {
        const missingNoteIds = windowStates
          .filter(({ noteWindow }) => !noteWindow)
          .map(({ note }) => note.id);
        await prepareNoteWindowsForReveal(missingNoteIds);
        await invoke("set_note_windows_visibility", {
          labels: current.notes.map((note) => noteLabel(note.id)),
          visible: true,
        });
      }
    } finally {
      togglingNoteVisibility = false;
      setMenuOpen(false);
    }
  };

  const startLauncherDrag = () => {
    if (!isTauri()) return;
    dragStarted = true;
    setLauncherUserDragging(true);
    void startObservedWindowDrag().then(
      () => {
        settleLauncherDrag();
      },
      () => {
        setLauncherUserDragging(false);
      },
    );
  };

  const settleLauncherPosition = async () => {
    if (launcherIsConfiguring) {
      if (launcherUserDragging()) settleLauncherDrag();
      return;
    }
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
    setLauncherUserDragging(false);
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
    if (launcherPrimaryAction(loadState().notes.length) === "toggle-visibility") {
      void toggleNotesVisible();
      return;
    }
    void createNote();
  };

  const closeSimeioma = async () => {
    await closeAuxiliaryWindows();
    await closeAllNoteWindows();
    await getCurrentWindow().close();
  };

  return (
    <main
      class="launcher-shell"
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
          if (!dragStarted) setLauncherUserDragging(false);
        }}
        onLostPointerCapture={() => {
          window.clearTimeout(dragTimer);
          pointerDownAt = null;
          pointerMovedTooFar = false;
          if (!dragStarted) setLauncherUserDragging(false);
        }}
        onClick={(event) => {
          event.preventDefault();
          if (suppressNextLauncherClick) {
            suppressNextLauncherClick = false;
            return;
          }
          if (performance.now() - clickHandledAt > 250 && !dragStarted && !menuOpen()) {
            createNoteFromLauncher();
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

function NotesListWindow() {
  const [state, setState] = createSignal(loadState());
  const [confirmingDeleteAll, setConfirmingDeleteAll] = createSignal(false);

  createEffect(() => {
    if (!state().notes.length) setConfirmingDeleteAll(false);
  });

  onMount(() => {
    const life = createLifetime(() => recordDiagnostic("native-command-failed"));
    life.after(configureUtilityWindow(), () => {});
    life.own(observeUtilityFocus(() => setConfirmingDeleteAll(false)));
    if (isTauri()) life.own(listen("simeioma:state-changed", life.guard(() => setState(loadState()))));

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

  const deleteNote = async (id: string) => {
    await updateState(state => removeNoteFromState(state, id), { setState });
    const noteWindow = await WebviewWindow.getByLabel(noteLabel(id));
    await noteWindow?.close();
  };

  const deleteAllNotes = async () => {
    setConfirmingDeleteAll(false);
    await hideAllNoteWindows();
    await updateState(clearNotesFromState, { setState });
    await closeAllNoteWindows();
  };

  return (
    <main
      class="settings-window-shell notes-list-window-shell"
      onCopy={preventUtilityClipboard}
      onCut={preventUtilityClipboard}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest(".note-list-delete-confirm, .note-list-delete-all")) setConfirmingDeleteAll(false);
      }}
    >
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
      <footer class="note-list-footer">
        <button
          type="button"
          class="note-list-delete-all"
          disabled={!state().notes.length}
          onClick={() => setConfirmingDeleteAll(true)}
        >
          Delete all notes
        </button>
      </footer>
      <Show when={confirmingDeleteAll()}>
        <div class="surface-popover note-list-delete-confirm" role="alertdialog" aria-label="Delete all saved notes">
          <strong>Delete all saved notes?</strong>
          <p>This permanently removes every note and drawing.</p>
          <div>
            <button type="button" onClick={() => setConfirmingDeleteAll(false)}>Cancel</button>
            <button type="button" class="danger" onClick={deleteAllNotes}>Delete all</button>
          </div>
        </div>
      </Show>
    </main>
  );
}

function NoteWindow(props: { noteId: string; autoFocus: boolean }) {
  const life = createLifetime(() => recordDiagnostic("native-command-failed"));
  const [state, setState] = createSignal(loadState());
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [scribble, setScribble] = createSignal(false);
  const [windowFocused, setWindowFocused] = createSignal(false);
  let canvasRef: HTMLCanvasElement | undefined;
  let bodyEditor: MarkdownEditorHandle | undefined;
  let rightEditor: MarkdownEditorHandle | undefined;
  let activeStroke: SketchStroke | null = null;
  let canvasRedrawFrame: number | undefined;
  let noteDragTimer: number | undefined;
  let notePointerDownAt: { x: number; y: number } | null = null;
  let resizingNote = false;
  let resizeStart: { x: number; y: number; width: number; height: number } | null = null;
  let bodySelection: { start: number; end: number } | null = null;
  let rightSelection: { start: number; end: number } | null = null;

  const note = createMemo(() => state().notes.find((item) => item.id === props.noteId));
  const noteColor = createMemo(() => getColor(note()?.colorKey));
  const otherNotes = createMemo(() => state().notes.filter((item) => item.id !== props.noteId));
  const [bodyDraft, setBodyDraft] = createSignal<string>();
  const [rightDraft, setRightDraft] = createSignal<string>();
  const storedBodyText = createMemo(() => bodyDraft() ?? (note() ? noteBody(note()!) : ""));
  const storedRightText = createMemo(() => rightDraft() ?? note()?.rightText ?? "");
  const mentions = createMemo(() => collectMentions(note(), otherNotes()));
  const itemLayoutIsTwoColumn = createMemo(() => note()?.layout === "two-column");

  const createNoteFromShortcut = () => enqueueNoteCreation(async () => {
    const latest = loadState();
    const current = latest.notes.find((item) => item.id === props.noteId);
    const context = await readSpawnContext();
    const anchor = await readSpawnAnchor(current, context);
    const result = await transactState(state => createNoteInState(state, {
      id: createId(), lineId: createId(), now: new Date().toISOString(),
      origin: context?.origin ?? current?.position ?? { x: 160, y: 160 }, spawnAfter: anchor.note, spawnBounds: anchor.bounds,
    }));
    if (!result.note) return;
    setState(loadState());
    await openNoteWindow(result.note.id, { spawnScale: anchor.scale });
  });

  const handleNoteKeyDown = (event: KeyboardEvent) => {
    const combo = keyCombo(event);
    if (!combo) return;
    const currentSettings = loadState().settings;
    const current = note();

    if (combo === currentSettings.newNoteKeybind) {
      event.preventDefault();
      void createNoteFromShortcut();
      return;
    }

    if (combo === "Ctrl + Z" && current?.sketchStrokes?.length && document.activeElement !== bodyEditor?.element && document.activeElement !== rightEditor?.element) {
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
    const initializeNoteWindow = async () => {
      let hydrated = false;
      for (let attempt = 0; attempt <= 12 && life.active; attempt += 1) {
        const latest = loadState();
        setState(latest);
        if (latest.notes.some((item) => item.id === props.noteId)) {
          hydrated = true;
          break;
        }
        await sleep(25);
      }
      if (!life.active) return;
      if (!hydrated) {        await closeCurrentWindow();
        return;
      }
      await configureNoteWindow(props.noteId, () => life.active);
      if (!life.active) return;
      await markCurrentNoteViewed(props.noteId, life.guard(setState), () => life.active);
      if (!life.active) return;
      life.delay(hydrateCanvas, 0);
      await emitTo("main", "simeioma:note-window-ready", { noteId: props.noteId });
    };
    life.after(initializeNoteWindow(), () => {});
    if (props.autoFocus) focusFirstLine(() => life.active);
    hydrateCanvas();
    const canvasForResize = canvasRef;
    const canvasResizeObserver = typeof ResizeObserver === "undefined" || !canvasForResize
      ? undefined
      : new ResizeObserver(() => scheduleCanvasHydration());
    if (canvasResizeObserver && canvasForResize) canvasResizeObserver.observe(canvasForResize);
    let moveSaveTimer: number | undefined;
    let sizeSaveTimer: number | undefined;

    if (isTauri()) {
      life.after(getCurrentWindow().isFocused(), setWindowFocused);
      life.own(getCurrentWindow().onFocusChanged(life.guard(({ payload: focused }) => {
        setWindowFocused(focused);
        if (focused) {
          channel?.postMessage({ type: "note-focused", noteId: props.noteId });
          void invoke("raise_control", { label: "main" });
        }
        if (!focused) {
          setPaletteOpen(false);
          channel?.postMessage({ type: "dismiss-text-menu" });
        }
      })));
      life.own(getCurrentWindow().listen<{ field: string; command: string; text?: string; start?: number; end?: number }>("text-menu-command", life.guard(({ payload }) => {
        life.after(applyTextMenuCommand(payload.field, payload.command, payload.text, payload.start, payload.end), () => {});
      })));
      life.own(getCurrentWindow().onMoved(life.guard(({ payload }) => {
        window.clearTimeout(moveSaveTimer);
        moveSaveTimer = window.setTimeout(() => {
          if (life.active) life.after(getCurrentWindow().scaleFactor(), scale =>
            persistNotePosition(props.noteId, { x: payload.x / scale, y: payload.y / scale }, life.guard(setState)));
        }, 80);
      })));
      life.own(getCurrentWindow().onResized(life.guard(({ payload }) => {
        scheduleCanvasHydration();
        window.clearTimeout(sizeSaveTimer);
        sizeSaveTimer = window.setTimeout(() => {
          if (life.active) life.after(getCurrentWindow().scaleFactor(), scale =>
            persistNoteSize(props.noteId, { width: payload.width / scale, height: payload.height / scale }, life.guard(setState)));
        }, 80);
      })));
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
      if (canvasRedrawFrame !== undefined) window.cancelAnimationFrame(canvasRedrawFrame);
      canvasResizeObserver?.disconnect();
      window.clearTimeout(moveSaveTimer);
      window.clearTimeout(sizeSaveTimer);
      life.dispose();
    });
  });

  const startNoteDrag = (event: PointerEvent) => {
    if (!isTauri() || event.button !== 0 || scribble()) return;
    if (event.ctrlKey) return;
    if (shouldBlockNoteDrag(event)) return;
    window.clearTimeout(noteDragTimer);
    notePointerDownAt = { x: event.clientX, y: event.clientY };
    if (HOLD_TO_DRAG_MS > 0) {
      noteDragTimer = window.setTimeout(() => { void startObservedWindowDrag(); }, HOLD_TO_DRAG_MS);
    }
  };

  const maybeStartNoteDrag = (event: PointerEvent) => {
    if (!notePointerDownAt || event.buttons !== 1 || resizingNote) return;
    const moved = Math.hypot(event.clientX - notePointerDownAt.x, event.clientY - notePointerDownAt.y);
    if (moved > 2) {
      notePointerDownAt = null;
      void startObservedWindowDrag();
    }
  };

  const editorForField = (field: string) => field === "right" ? rightEditor : bodyEditor;

  const storeEditorSelection = (field: string) => {
    const editor = editorForField(field);
    if (!editor) return;
    if (field === "right") rightSelection = editor.selection();
    else bodySelection = editor.selection();
  };

  const applyTextMenuCommand = async (field: string, command: string, payloadText = "", start?: number, end?: number) => {
    const target = editorForField(field);
    if (!target) return;
    if (Number.isInteger(start) && Number.isInteger(end) && command !== "select-all") {
      target.setSelection({ start: start!, end: end! });
    }
    if (command === "paste") {
      const text = payloadText || await readClipboardText();
      if (!life.active) return;
      target.replaceSelection(text);
      syncAfterLineEdit();
      return;
    }
    if (command === "cut") {
      const selected = target.cutSelection();
      syncAfterLineEdit();
      if (selected) await copyText(selected);
      return;
    }
    if (command === "copy") {
      const selected = target.copySelection();
      if (selected) await copyText(selected);
      return;
    }
    if (command === "select-all") {
      target.selectAll();
      storeEditorSelection(field);
      return;
    }
    if (command === "dir-ltr" || command === "dir-rtl") {
      target.setDirection(command.replace("dir-", "") as "ltr" | "rtl");
    }
  };

  const rememberTextSelection = (field: "body" | "right") => storeEditorSelection(field);

  const openTextMenu = (event: MouseEvent, field: "body" | "right", directEditor = true) => {
    event.preventDefault();
    event.stopPropagation();
    const target = editorForField(field);
    if (!target) return;
    if (!directEditor) {
      target.focus();
      target.collapseToEnd();
    }
    storeEditorSelection(field);
    const selection = field === "right" ? rightSelection : bodySelection;
    void openTextMenuPopupWindow(props.noteId, field, event.clientX, event.clientY, Boolean(selection && selection.start !== selection.end), selection?.start ?? 0, selection?.end ?? 0);
  };

  const startNoteResize = async (event: PointerEvent) => {
    const resizeHandle = event.currentTarget;
    if (!isTauri() || event.button !== 0 || !(resizeHandle instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    resizingNote = true;
    resizeHandle.setPointerCapture(event.pointerId);
    const size = await getCurrentWindow().outerSize();
    const scale = await getCurrentWindow().scaleFactor();
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
    const scale = await getCurrentWindow().scaleFactor();
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
    void updateNote(props.noteId, (item) => ({ ...item, ...patch, updatedAt: new Date().toISOString() }), { setState }).catch(() => {});
  };

  const deleteCurrentNote = async () => {
    await updateState(state => removeNoteFromState(state, props.noteId), { setState });
    await closeCurrentWindow();
  };

  const updateBodyText = (rawText: string) => {
    const current = note();
    if (!current) return;
    setBodyDraft(rawText);
    void persistNoteBody(props.noteId, current.lines[0]?.id ?? createId(), rawText).then(() => {
      if (life.active && bodyDraft() === rawText) { setState(loadState()); setBodyDraft(undefined); }
    }).catch(() => {}); // Preserve the visible draft on failure; persistence reports it.
  };

  const updateRightText = (rawText: string) => {
    setRightDraft(rawText);
    void persistNoteRightText(props.noteId, rawText).then(() => {
      if (life.active && rightDraft() === rawText) { setState(loadState()); setRightDraft(undefined); }
    }).catch(() => {});
  };

  const saveSketchStroke = (stroke: SketchStrokeRecord) => {
    void updateNote(props.noteId, item => ({ ...item, sketchStrokes: [...(item.sketchStrokes ?? []), stroke], updatedAt: new Date().toISOString() }), { setState }).catch(() => {});
  };

  const syncAfterLineEdit = () => {
    setState(loadState());
  };

  const activateEditorForPointer = (event: PointerEvent) => {
    if (scribble() || event.button !== 0) return;
    const target = event.target as HTMLElement;
    const column = target.closest(".note-column");
    if (!column || target.closest("button, input, select, .note-context-menu, .note-resize-handle")) return;
    const editor = column.querySelector<HTMLElement>('[aria-label="Note right column"], [aria-label="Note line"]');
    editor?.focus();
  };

  const growBody = async () => {
    const visibleEditors = [bodyEditor?.element, itemLayoutIsTwoColumn() ? rightEditor?.element : undefined].filter(Boolean) as HTMLDivElement[];
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
    const scale = await getCurrentWindow().scaleFactor();
    if (desiredHeight > currentSize.height / scale + 12) {
      await getCurrentWindow().setSize(new LogicalSize(Math.max(DEFAULT_NOTE_SIZE, currentSize.width / scale), desiredHeight));
    }
  };

  return (
    <Show when={note()} fallback={<main class="note-window-pending" aria-hidden="true" />}>
      {(item) => (
        <main
          class="note-shell"
          classList={{
            "is-scribbling": scribble(),
            "is-window-focused": windowFocused(),
          }}
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
                  Hide
                </button>
                <button
                  type="button"
                  class="note-menu-action delete-action"
                  onClick={() => void deleteCurrentNote()}
                >
                  Delete note
                </button>
              </div>
            </Show>
          </header>

          <div class="note-divider" />

          <section
            class="note-body"
            classList={{ "is-two-column": item().layout === "two-column" }}
            onPointerDown={activateEditorForPointer}
          >
            <div class="note-columns" classList={{ "is-two-column": item().layout === "two-column" }}>
              <div class="note-column">
                <MarkdownEditor
                  ref={(handle) => (bodyEditor = handle)}
                  value={storedBodyText()}
                  label="Note line"
                  placeholder="Write..."
                  onValue={(text) => {
                    updateBodyText(text);
                    rememberTextSelection("body");
                    void growBody();
                  }}
                  onLayoutChange={() => void growBody()}
                  onPointerDown={(event) => {
                    if (event.button === 2) {
                      rememberTextSelection("body");
                      event.preventDefault();
                    }
                  }}
                  onContextMenu={(event) => openTextMenu(event, "body")}
                  onFocus={() => {
                    rememberTextSelection("body");
                    void growBody();
                  }}
                  onBlur={syncAfterLineEdit}
                />
              </div>

              <Show when={item().layout === "two-column"}>
                <div class="note-column-divider" aria-hidden="true" />
                <div class="note-column">
                  <MarkdownEditor
                    ref={(handle) => (rightEditor = handle)}
                    value={storedRightText()}
                    label="Note right column"
                    placeholder="Write..."
                    onValue={(text) => {
                      updateRightText(text);
                      rememberTextSelection("right");
                      void growBody();
                    }}
                    onLayoutChange={() => void growBody()}
                    onPointerDown={(event) => {
                      if (event.button === 2) {
                        rememberTextSelection("right");
                        event.preventDefault();
                      }
                    }}
                    onContextMenu={(event) => openTextMenu(event, "right")}
                    onFocus={() => {
                      rememberTextSelection("right");
                      void growBody();
                    }}
                    onBlur={syncAfterLineEdit}
                  />
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
                const settings = loadState().settings;
                activeStroke = startSketch(event, canvasRef, settings.sketchRenderingMode, settings.sketchBrushSize);
              }}
              onPointerMove={(event) => {
                if (!canvasRef || !activeStroke || (event.buttons & 1) === 0) return;
                for (const sample of coalescedPointerEvents(event)) drawSketch(sample, canvasRef, activeStroke);
              }}
              onPointerUp={(event) => {
                if (event.button !== 0) return;
                if (canvasRef && activeStroke) {
                  for (const sample of coalescedPointerEvents(event)) drawSketch(sample, canvasRef, activeStroke);
                  drawSketch(event, canvasRef, activeStroke);
                  const record = finishSketch(canvasRef, activeStroke);
                  if (record) saveSketchStroke(record);
                }
                activeStroke = null;
                scheduleCanvasHydration();
              }}
              onPointerLeave={() => {
                if (canvasRef && activeStroke) {
                  const record = finishSketch(canvasRef, activeStroke);
                  if (record) saveSketchStroke(record);
                }
                activeStroke = null;
                scheduleCanvasHydration();
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
    const context = prepareSketchCanvas(canvasRef);
    if (!context) return;
    clearSketchCanvas(context);
    const renderStrokes = () => {
      for (const stroke of current?.sketchStrokes ?? []) renderSketchRecord(context, stroke);
    };
    if (current?.sketchData) {
      const image = new Image();
      image.onload = () => {
        if (!life.active) return;
        clearSketchCanvas(context);
        context.drawImage(image, 0, 0, context.canvas.width, context.canvas.height);
        renderStrokes();
      };
      image.src = current.sketchData;
      return;
    }
    renderStrokes();
  }

  function scheduleCanvasHydration() {
    if (canvasRedrawFrame !== undefined) window.cancelAnimationFrame(canvasRedrawFrame);
    canvasRedrawFrame = window.requestAnimationFrame(() => {
      canvasRedrawFrame = undefined;
      if (!activeStroke) hydrateCanvas();
    });
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
  const [actionNote, setActionNote] = createSignal<{ note: Note; top: number } | null>(null);

  return (
    <div class="note-list" classList={{ "is-empty": !props.notes.length }}>
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
                  if (actionNote()?.note.id === note.id) {
                    setActionNote(null);
                    return;
                  }
                  const target = event.currentTarget as HTMLButtonElement;
                  setActionNote({ note, top: target.offsetTop + target.offsetHeight + 4 });
                }}
              >
                <span>{noteLabelText(note)}</span>
                <small>{note.important ? "Important" : hasOpenTasks(note) ? "Open tasks" : "Note"}</small>
              </button>
            );
          }}
        </For>
      </Show>
      <Show when={actionNote()}>
        {(action) => (
          <div
            class="surface-popover note-action-popover"
            style={{ top: `${action().top}px` }}
            role="dialog"
            aria-label="Note actions"
          >
            <strong>{noteLabelText(action().note)}</strong>
            <div>
              <button
                type="button"
                onClick={() => {
                  void exportNote(action().note.id, true).catch(reportExportFailure);
                  setActionNote(null);
                }}
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => {
                  void exportNote(action().note.id).catch(reportExportFailure);
                  setActionNote(null);
                }}
              >
                Save
              </button>
              <button
                type="button"
                class="danger"
                onClick={() => {
                  props.onDelete(action().note.id);
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

function enqueueNoteCreation(create: () => Promise<void>) {
  noteCreationQueue = noteCreationQueue.then(create, create);
  return noteCreationQueue;
}

function updateNote(
  noteId: string,
  updater: (note: Note) => Note,
  options: { broadcast?: boolean; setState?: (state: AppState) => void } = {},
) {
  return updateState(
    (state) => ({
      ...state,
      notes: state.notes.map((note) => (note.id === noteId ? updater(note) : note)),
    }),
    options,
  );
}

function persistNoteBody(noteId: string, lineId: string, text: string) {
  return updateNote(
    noteId,
    (note) => ({
      ...note,
      updatedAt: new Date().toISOString(),
      lines: [{ id: note.lines[0]?.id ?? lineId, text, task: false, crossed: false }],
    }),
    { broadcast: true },
  );
}

function persistNoteRightText(noteId: string, rightText: string) {
  return updateNote(
    noteId,
    (note) => ({
      ...note,
      rightText,
      updatedAt: new Date().toISOString(),
    }),
    { broadcast: true },
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

function markCurrentNoteViewed(noteId: string, setState?: (state: AppState) => void, active = () => true) {
  return updateState((state) => active() ? markNoteViewed(state, noteId, new Date().toISOString()) : state, { setState });
}

function persistNotePosition(noteId: string, position: { x: number; y: number }, setState?: (state: AppState) => void) {
  return updateState((state) => updateNotePosition(state, noteId, position), { setState });
}

function persistNoteSize(noteId: string, size: { width: number; height: number }, setState?: (state: AppState) => void) {
  return updateState((state) => updateNoteSize(state, noteId, size), { setState });
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

async function prepareNoteWindowsForReveal(noteIds: string[]) {
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

async function noteWindowStatesInState(state: AppState) {
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

async function visibleNotesInState(state: AppState): Promise<Note[]> {
  const windowStates = await noteWindowStatesInState(state);
  return windowStates.filter(({ visible }) => visible).map(({ note }) => note);
}

async function applyLauncherWindowConfiguration(
  { menuOpen, confirmingExit, anchor, setAnchor, setConfirmSide }: {
    menuOpen: boolean;
    confirmingExit: boolean;
    anchor: LauncherAnchor | null;
    setAnchor: (anchor: LauncherAnchor) => void;
    setConfirmSide: (side: "left" | "right") => void;
  },
  operationId: number,
) {
  if (!isTauri() || launcherUserDragging()) return;
  const run = ++launcherConfigureRun;
  launcherIsConfiguring = true;
  const expanded = menuOpen || confirmingExit;
  const width = confirmingExit ? LAUNCHER_CONFIRM_CANVAS_WIDTH : expanded ? LAUNCHER_CANVAS_WIDTH : LAUNCHER_IDLE_CANVAS_WIDTH;
  const height = confirmingExit ? LAUNCHER_CONFIRM_CANVAS_HEIGHT : expanded ? LAUNCHER_CANVAS_HEIGHT : LAUNCHER_IDLE_CANVAS_HEIGHT;
  const parking = launcherParkingSize();
  const appWindow = getCurrentWindow();
  try {
    const work = scaledWorkArea(await readLauncherMonitor());
    const nextAnchor = anchor ?? (launcherWasPlaced ? await readWindowAnchor(work) : null);
    setConfirmSide(!nextAnchor || work.right - nextAnchor.right > (work.left + work.right) / 2 ? "left" : "right");
    await appWindow.setAlwaysOnTop(true);
    await appWindow.setSkipTaskbar(true);
    await appWindow.setResizable(false);
    recordDiagnostic("resize-requested", { operationId, requested: { width, height } });
    await beforeDiagnosticResize(operationId);
    await appWindow.setSize(new LogicalSize(width, height));
    await recordActualLauncherGeometry(operationId);
    if (nextAnchor) {
      await positionLauncherFromAnchor(width, height, parking.width, parking.height, nextAnchor, work);
      if (!confirmingExit) setAnchor(await readWindowAnchor(work));
    } else {
      await positionWindow(width, height, parking.width, parking.height, work);
      setAnchor(await readWindowAnchor(work));
      launcherWasPlaced = true;
    }
  } finally {
    // Transactions are serialized; only this delayed callback can overlap the next one.
    window.setTimeout(() => {
      if (run === launcherConfigureRun) {
        launcherIsConfiguring = false;
        scheduleDiagnosticSnapshot();
      }
    }, 120);
  }
}

function launcherParkingSize() {
  return { width: MENU_WIDTH, height: MENU_HEIGHT };
}

async function readWindowAnchor(work?: WorkArea): Promise<LauncherAnchor> {
  work ??= scaledWorkArea(await readLauncherMonitor());
  const position = await getCurrentWindow().outerPosition();
  const size = await getCurrentWindow().outerSize();
  return launcherAnchorFromWindow(work, {
    x: position.x / work.scale,
    y: position.y / work.scale,
    width: size.width / work.scale,
    height: size.height / work.scale,
  });
}

async function configureNoteWindow(noteId: string, active = () => true) {
  if (!isTauri()) return;
  const appWindow = getCurrentWindow();
  const note = loadState().notes.find((item) => item.id === noteId);
  const size = note?.size ?? { width: DEFAULT_NOTE_SIZE, height: DEFAULT_NOTE_SIZE };
  await appWindow.setSkipTaskbar(true);
  if (active()) await appWindow.setSize(new LogicalSize(size.width, size.height));
}

async function configureUtilityWindow() {
  if (!isTauri()) return;
  const appWindow = getCurrentWindow();
  await appWindow.setSkipTaskbar(false);
  await appWindow.setResizable(true);
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
  return (await readSpawnContext())?.origin ?? { x: 160, y: 160 };
}

async function positionWindow(width: number, height: number, visualWidth: number, visualHeight: number, work: WorkArea) {
  const center = visualCenterForTopRight(
    work,
    { width: visualWidth, height: visualHeight },
    LAUNCHER_SCREEN_MARGIN,
  );
  const position = windowPositionForVisualCenter(center, { width, height });
  const operationId = configureLauncherWindow.snapshot().operationId;
  recordDiagnostic("position-requested", { operationId, requested: position });
  await getCurrentWindow().setPosition(new PhysicalPosition(Math.round(position.x * work.scale), Math.round(position.y * work.scale)));
  await recordActualLauncherGeometry(operationId, "position-completed");
}

async function positionLauncherFromAnchor(
  width: number,
  height: number,
  visualWidth: number,
  visualHeight: number,
  anchor: LauncherAnchor,
  work: WorkArea,
) {
  const center = visualCenterFromAnchor(
    work,
    anchor,
    { width: visualWidth, height: visualHeight },
    LAUNCHER_SCREEN_MARGIN,
  );
  const position = windowPositionForVisualCenter(center, { width, height });
  const operationId = configureLauncherWindow.snapshot().operationId;
  recordDiagnostic("position-requested", { operationId, requested: position });
  await getCurrentWindow().setPosition(new PhysicalPosition(Math.round(position.x * work.scale), Math.round(position.y * work.scale)));
  await recordActualLauncherGeometry(operationId, "position-completed");
}

async function clampCurrentLauncherToWorkArea(visualWidth: number, visualHeight: number, margin: number) {
  if (!isTauri()) return false;
  const work = scaledWorkArea(await readLauncherMonitor());
  const position = await getCurrentWindow().outerPosition();
  const size = await getCurrentWindow().outerSize();
  const windowRect = {
    x: position.x / work.scale,
    y: position.y / work.scale,
    width: size.width / work.scale,
    height: size.height / work.scale,
  };
  const { dx, dy } = clampParkingDelta(work, parkingRect(windowRect, { width: visualWidth, height: visualHeight }), margin);

  if (Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5) return false;
  const requested = { x: windowRect.x + dx, y: windowRect.y + dy };
  recordDiagnostic("position-requested", { operationId: 0, clamping: true, requested });
  await getCurrentWindow().setPosition(new PhysicalPosition(Math.round(requested.x * work.scale), Math.round(requested.y * work.scale)));
  await recordActualLauncherGeometry(0, "position-completed");
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

async function openNoteWindow(
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

async function closeAllNoteWindows() {
  if (!isTauri()) return;
  const noteWindows = (await getAllWebviewWindows()).filter((noteWindow) => noteWindow.label.startsWith("note-"));
  await Promise.all(noteWindows.map((noteWindow) => noteWindow.close()));
}

async function hideAllNoteWindows() {
  if (!isTauri()) return;
  const noteWindows = (await getAllWebviewWindows()).filter((noteWindow) => noteWindow.label.startsWith("note-"));
  await Promise.all(noteWindows.map((noteWindow) => noteWindow.hide()));
}

async function closeAuxiliaryWindows() {
  if (!isTauri()) return;
  for (const label of ["settings", "notes-list"]) {
    const utilityWindow = await WebviewWindow.getByLabel(label);
    await utilityWindow?.close();
  }
}

function preventUtilityClipboard(event: ClipboardEvent) {
  event.preventDefault();
}

function startUtilityDrag(event: PointerEvent) {
  if (!isTauri()) return;
  const target = event.target as HTMLElement;
  if (target.closest("button, input, select, textarea")) return;
  void startObservedWindowDrag();
}

async function restoreAndFocusUtilityWindow(window: WebviewWindow) {
  await invoke("restore_utility_window", { label: window.label });
}

function openSettingsWindow() { return openUtilityWindow("settings"); }
function openNotesListWindow() { return openUtilityWindow("notes-list"); }

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

function focusFirstLine(active = () => true) {
  window.setTimeout(() => {
    if (active()) document.querySelector<HTMLElement>(".markdown-editor")?.focus();
  }, 0);
}

function collectMentions(note: Note | undefined, candidates: Note[]) {
  if (!note) return [];
  const body = `${note.lines.map((line) => line.text).join(" ")} ${note.rightText ?? ""}`;
  const tokens = Array.from(body.matchAll(/@([a-z0-9-]+)/gi)).map((match) => match[1].toLowerCase());
  if (!tokens.length) return [];
  return candidates.filter((candidate) => tokens.includes(slug(noteLabelText(candidate)).toLowerCase()));
}

function shouldBlockNoteDrag(event: PointerEvent) {
  const target = event.target as HTMLElement;
  if (target.closest("button, select, .color-popover, .note-context-menu, .mention-row, .note-resize-handle")) return true;
  if (target.closest(".note-titlebar")) return Boolean(target.closest("button, .color-popover, .note-context-menu"));
  if (target.closest("textarea, input, .note-body-editor")) return true;

  return false;
}

async function maybeTriggerReminder(
  setState: (state: AppState) => void,
  setNotice: (notice: ReminderNotice | null) => void,
) {
  const result = await transactState(state => {
    const unviewed = unviewedReminderNotes(state.notes, state.settings.reminderTarget);
    if (!state.settings.remindersEnabled || !unviewed.length || !isReminderDue(state.settings)) return { state, notice: null };
    return { state: { ...state, settings: { ...state.settings, lastReminderAt: new Date().toISOString() } },
      notice: { title: "Reminder", body: `${unviewed.length} notes need attention`, noteIds: unviewed.map(note => note.id) } };
  });
  setState(loadState());
  if (result.notice) setNotice(result.notice);
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
