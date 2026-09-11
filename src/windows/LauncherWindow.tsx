import { createSignal, createMemo, onMount, onCleanup, createEffect, Show } from "solid-js";
import { loadState, stateChannel as channel, transactState } from "../persistence";
import { type ReminderNotice, NOTE_COLORS, createNoteInState, launcherPrimaryAction } from "../simeiomaModel";
import { type LauncherAnchor } from "../windowGeometry";
import { createLifetime } from "../lifetime";
import { recordDiagnostic, invokeObserved as invoke, setLauncherDiagnosticReader, startObservedWindowDrag } from "../diagnostics";
import { maybeTriggerReminder } from "../reminders";
import { isTauri } from "@tauri-apps/api/core";
import { openSettingsWindow, openNotesListWindow } from "../utilityWindows";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { launcherIsConfiguring, launcherUserDragging, configureLauncherWindow, LAUNCHER_CONFIRM_CANVAS_WIDTH, LAUNCHER_CANVAS_WIDTH, LAUNCHER_IDLE_CANVAS_WIDTH, LAUNCHER_CONFIRM_CANVAS_HEIGHT, LAUNCHER_CANVAS_HEIGHT, LAUNCHER_IDLE_CANVAS_HEIGHT, setLauncherUserDragging, launcherParkingSize, clampCurrentLauncherToWorkArea, LAUNCHER_SCREEN_MARGIN, readWindowAnchor } from "../launcherNative";
import { enqueueNoteCreation, visibleNotesInState, openNoteWindow, noteWindowStatesInState, noteLabel, prepareNoteWindowsForReveal, closeAllNoteWindows } from "../noteWindows";
import { readSpawnContext, readSpawnAnchor } from "../windowSpawning";
import { createId } from "../noteMutations";
import { exportSession, reportExportFailure } from "../exports";
import { isLeftMouseDown, sleep, closeAuxiliaryWindows, HOLD_TO_DRAG_MS } from "../windowInteractions";
import { ListIcon, DownloadIcon, SettingsIcon, CloseIcon } from "../icons";

export function LauncherWindow() {
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
