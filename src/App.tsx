import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { invoke, isTauri } from "@tauri-apps/api/core";
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
  type AppState,
  type ExportFormat,
  type Note,
  type NoteColor,
  type NoteLine,
  type ReminderMode,
  type ReminderNotice,
  type ReminderTarget,
  type Settings,
} from "./simeiomaModel";
import "./App.css";

const STORAGE_KEY = "simeioma:v1";
const CHANNEL_NAME = "simeioma-sync";
const STRIP_VISIBLE_WIDTH = 3;
const HOLD_TO_DRAG_MS = 0;
const LAUNCHER_CANVAS_WIDTH = 208;
const LAUNCHER_CANVAS_HEIGHT = 244;

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

  return <LauncherWindow />;
}

function LauncherWindow() {
  const [state, setState] = createSignal(loadState());
  const [hovered, setHovered] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [notesHidden, setNotesHidden] = createSignal(false);
  const [notice, setNotice] = createSignal<ReminderNotice | null>(null);
  const [confirmingExit, setConfirmingExit] = createSignal(false);
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
        if (launcherIsConfiguring || launcherUserDragging) return;
        window.clearTimeout(moveSaveTimer);
        moveSaveTimer = window.setTimeout(async () => {
          if (launcherIsConfiguring || launcherUserDragging) return;
          launcherAnchor = await readWindowAnchor();
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
    configureLauncherWindow(
      menuOpen(),
      hovered(),
      confirmingExit(),
      launcherAnchor,
      (anchor) => (launcherAnchor = anchor),
    );
  });

  createEffect(() => {
    if (confirmingExit()) {
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
    getCurrentWindow().startDragging();
  };

  const settleLauncherDrag = () => {
    window.clearTimeout(settleDragTimer);
    settleDragTimer = window.setTimeout(async () => {
      launcherAnchor = await readWindowAnchor();
      launcherUserDragging = false;
    }, 260);
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
      <Show when={notice()}>
        {(item) => (
          <button
            class="reminder-toast"
            type="button"
            onClick={() => {
              const matches = matchingNoticeNotes();
              if (matches.length === 1) {
                openNoteWindow(matches[0].id);
              } else {
                setMenuOpen(true);
              }
              setNotice(null);
            }}
          >
            <span>{item().noteIds.length}</span>
          </button>
        )}
      </Show>

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
          if (dragStarted) settleLauncherDrag();
        }}
        onLostPointerCapture={() => {
          window.clearTimeout(dragTimer);
          pointerDownAt = null;
          pointerMovedTooFar = false;
          if (dragStarted) settleLauncherDrag();
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
      <Show when={confirmingExit()}>
        <section
          class="exit-confirmation"
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
  let canvasRef: HTMLCanvasElement | undefined;
  let bodyRef: HTMLTextAreaElement | undefined;
  let drawing = false;
  let lastPoint: { x: number; y: number } | null = null;
  let noteDragTimer: number | undefined;
  let notePointerDownAt: { x: number; y: number } | null = null;
  let resizingNote = false;
  let resizeStart: { x: number; y: number; width: number; height: number } | null = null;

  const note = createMemo(() => state().notes.find((item) => item.id === props.noteId));
  const noteColor = createMemo(() => getColor(note()?.colorKey));
  const otherNotes = createMemo(() => state().notes.filter((item) => item.id !== props.noteId));
  const bodyText = createMemo(() => note()?.lines.map((line) => line.text).join("\n") ?? "");
  const mentions = createMemo(() => collectMentions(note(), otherNotes()));

  onMount(() => {
    configureNoteWindow();
    markCurrentNoteViewed(props.noteId, setState);
    focusFirstLine();
    hydrateCanvas();
    let movedUnlisten: (() => void) | undefined;
    let moveSaveTimer: number | undefined;

    if (isTauri()) {
      getCurrentWindow().onMoved(({ payload }) => {
        window.clearTimeout(moveSaveTimer);
        moveSaveTimer = window.setTimeout(async () => {
          const scale = (await primaryMonitor())?.scaleFactor || 1;
          persistNotePosition(props.noteId, { x: payload.x / scale, y: payload.y / scale }, setState);
        }, 80);
      }).then((unlisten) => {
        movedUnlisten = unlisten;
      });
    }

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "state") {
        setState(loadState());
      }
    };
    channel?.addEventListener("message", onMessage);
    onCleanup(() => {
      channel?.removeEventListener("message", onMessage);
      window.clearTimeout(noteDragTimer);
      window.clearTimeout(moveSaveTimer);
      movedUnlisten?.();
    });
  });

  const startNoteDrag = (event: PointerEvent) => {
    if (!isTauri() || event.button !== 0 || scribble()) return;
    if (event.ctrlKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, select, textarea, .note-body, .color-popover, .mention-row")) return;
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

  const stopNoteResize = () => {
    resizingNote = false;
    resizeStart = null;
  };

  createEffect(() => {
    note()?.sketchData;
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

  const saveSketch = () => {
    if (!canvasRef) return;
    patchNote({ sketchData: canvasRef.toDataURL("image/png") });
  };

  const syncAfterLineEdit = () => {
    const latest = loadState();
    saveState(latest);
    setState(latest);
  };

  const growBody = async () => {
    if (!bodyRef) return;
    bodyRef.style.height = "0px";
    const nextHeight = Math.max(92, bodyRef.scrollHeight);
    bodyRef.style.height = `${nextHeight}px`;
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
            if (event.ctrlKey) {
              event.preventDefault();
              setScribble(!scribble());
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
              class="icon-button scribble-title-button"
              classList={{ "is-important": scribble() }}
              title="Toggle scribble mode"
              onClick={() => setScribble(!scribble())}
            >
              {PencilIcon()}
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
              <div class="color-popover">
                <For each={NOTE_COLORS}>
                  {(color) => (
                    <button
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
            </Show>
          </header>

          <div class="note-divider" />

          <section class="note-body">
            <Show
              when={bodyFocused()}
              fallback={
                <div
                  class="note-body-preview"
                  onClick={() => {
                    setBodyFocused(true);
                    window.setTimeout(() => bodyRef?.focus(), 0);
                  }}
                >
                  {renderMarkdownPreview(bodyText())}
                </div>
              }
            >
              <textarea
                ref={bodyRef}
                class="note-body-editor"
                aria-label="Note line"
                data-line-id={item().lines[0]?.id ?? item().id}
                value={bodyText()}
                placeholder="Write..."
                spellcheck={false}
                onClick={(event) => {
                  if (event.ctrlKey) {
                    event.preventDefault();
                    toggleCurrentTextareaLineStrike(event.currentTarget);
                    updateBodyText(event.currentTarget.value);
                  }
                }}
                onInput={(event) => {
                  updateBodyText(event.currentTarget.value);
                  growBody();
                }}
                onFocus={() => {
                  setBodyFocused(true);
                  growBody();
                }}
                onBlur={() => {
                  syncAfterLineEdit();
                  setBodyFocused(false);
                }}
              />
            </Show>

            <Show when={mentions().length}>
              <div class="mention-row">
                <For each={mentions()}>
                  {(target) => (
                    <button onClick={() => openNoteWindow(target.id)}>@{noteLabelText(target)}</button>
                  )}
                </For>
              </div>
            </Show>
          </section>

          <canvas
            ref={canvasRef}
            class="sketch-canvas"
            width="384"
            height="384"
            onPointerDown={(event) => startSketch(event, canvasRef, () => (drawing = true), (point) => (lastPoint = point))}
            onPointerMove={(event) => {
              if (!drawing || !canvasRef || !lastPoint) return;
              lastPoint = drawSketch(event, canvasRef, lastPoint);
            }}
            onPointerUp={() => {
              drawing = false;
              lastPoint = null;
              saveSketch();
            }}
            onPointerLeave={() => {
              if (drawing) saveSketch();
              drawing = false;
              lastPoint = null;
            }}
          />

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
    if (!canvasRef || !current?.sketchData) return;
    const image = new Image();
    image.onload = () => {
      const context = canvasRef?.getContext("2d");
      if (!context || !canvasRef) return;
      context.clearRect(0, 0, canvasRef.width, canvasRef.height);
      context.drawImage(image, 0, 0, canvasRef.width, canvasRef.height);
    };
    image.src = current.sketchData;
  }
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
  const [capturingKeybind, setCapturingKeybind] = createSignal<"strike" | "scribble" | null>(null);

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
          onCapture={() => setCapturingKeybind("strike")}
          onReset={(event) => reset(event, { strikeKeybind: DEFAULT_SETTINGS.strikeKeybind })}
        />
      </label>

      <label class="setting-row">
        <span>Scribble</span>
        <KeybindInput
          ariaLabel="Scribble keybind"
          value={props.settings.scribbleKeybind}
          onCapture={() => setCapturingKeybind("scribble")}
          onReset={(event) => reset(event, { scribbleKeybind: DEFAULT_SETTINGS.scribbleKeybind })}
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
            label={target() === "strike" ? "Cross out" : "Scribble"}
            onCancel={() => setCapturingKeybind(null)}
            onCommit={(value) => {
              props.onChange(target() === "strike" ? { strikeKeybind: value } : { scribbleKeybind: value });
              setCapturingKeybind(null);
            }}
          />
        )}
      </Show>
    </div>
  );
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
  if (!isTauri()) return;
  const run = ++launcherConfigureRun;
  launcherIsConfiguring = true;
  void menuOpen;
  void hovered;
  void confirmingExit;
  const width = LAUNCHER_CANVAS_WIDTH;
  const height = LAUNCHER_CANVAS_HEIGHT;
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
      return;
    } else {
      const work = monitor?.workArea;
      if (!work) return;
      await positionWindow(width, height);
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
    right: Math.max(0, right - (axisX + STRIP_HIT_WIDTH / 2)),
    bottom: Math.max(0, bottom - (axisY + STRIP_HEIGHT / 2)),
  };
}

async function configureNoteWindow() {
  if (!isTauri()) return;
  const appWindow = getCurrentWindow();
  await appWindow.setAlwaysOnTop(true);
  await appWindow.setSkipTaskbar(true);
  await appWindow.setSize(new LogicalSize(DEFAULT_NOTE_SIZE, DEFAULT_NOTE_SIZE));
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
  await getCurrentWindow().close();
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
  const spacing = 120;
  const x = launcherCenter.x + direction.x * spacing - DEFAULT_NOTE_SIZE / 2;
  const y = launcherCenter.y + direction.y * spacing - DEFAULT_NOTE_SIZE / 2;
  return {
    x: clamp(x, workLeft + 16, workRight - DEFAULT_NOTE_SIZE - 16),
    y: clamp(y, workTop + 16, workBottom - DEFAULT_NOTE_SIZE - 16),
  };
}

async function positionWindow(width: number, height: number) {
  const monitor = await primaryMonitor();
  if (!monitor) return;
  const scale = monitor.scaleFactor || 1;
  const work = monitor.workArea;
  const right = (work.position.x + work.size.width) / scale;
  const bottom = (work.position.y + work.size.height) / scale;
  const x = right - 16 - STRIP_HIT_WIDTH / 2 - width / 2;
  const y = bottom - 16 - STRIP_HEIGHT / 2 - height / 2;
  await getCurrentWindow().setPosition(new LogicalPosition(Math.max(0, x), Math.max(0, y)));
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

  const webview = new WebviewWindow(noteLabel(id), {
    url: `index.html?role=note&id=${encodeURIComponent(id)}`,
    title: "Simeioma Note",
    x: Math.max(16, x),
    y: Math.max(16, y),
    width: DEFAULT_NOTE_SIZE,
    height: DEFAULT_NOTE_SIZE,
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
  const body = note.lines.map((line) => line.text).join(" ");
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
  return `# ${title}\n\n${lines.join("\n")}\n`;
}

function renderMarkdownPreview(value: string) {
  const lines = value.split("\n");
  if (!value.trim()) return <p class="placeholder-line">Write...</p>;
  return (
    <For each={lines}>
      {(line) => {
        const task = line.match(/^- \[( |x)\] (.*)$/i);
        const content = task ? task[2] : line;
        return (
          <p classList={{ "preview-task": !!task, "is-done": task?.[1]?.toLowerCase() === "x" }}>
            <Show when={task}>
              <span class="preview-checkbox" />
            </Show>
            {renderInlineMarkdown(content || " ")}
          </p>
        );
      }}
    </For>
  );
}

function renderInlineMarkdown(value: string) {
  const parts = value.split(/(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`)/g).filter(Boolean);
  return (
    <For each={parts}>
      {(part) => {
        if (part.startsWith("**") && part.endsWith("**")) return <strong>{part.slice(2, -2)}</strong>;
        if (part.startsWith("*") && part.endsWith("*")) return <em>{part.slice(1, -1)}</em>;
        if (part.startsWith("~~") && part.endsWith("~~")) return <s>{part.slice(2, -2)}</s>;
        if (part.startsWith("`") && part.endsWith("`")) return <code>{part.slice(1, -1)}</code>;
        return <span>{part}</span>;
      }}
    </For>
  );
}

function toggleCurrentTextareaLineStrike(textarea: HTMLTextAreaElement) {
  const value = textarea.value;
  const cursor = textarea.selectionStart;
  const lineStart = value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const nextBreak = value.indexOf("\n", cursor);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const line = value.slice(lineStart, lineEnd);
  const replacement = line.startsWith("~~") && line.endsWith("~~") ? line.slice(2, -2) : `~~${line}~~`;
  textarea.value = `${value.slice(0, lineStart)}${replacement}${value.slice(lineEnd)}`;
  textarea.setSelectionRange(lineStart, lineStart + replacement.length);
}

function notesToMarkdown(notes: Note[]) {
  return notes.map(noteToMarkdown).join("\n---\n\n");
}

function notesToText(notes: Note[]) {
  return notes
    .map((note) => {
      const lines = note.lines.map((line) => `${line.crossed ? "[done] " : ""}${line.text}`);
      return `${noteLabelText(note)}\n${lines.join("\n")}`;
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

function startSketch(
  event: PointerEvent,
  canvas: HTMLCanvasElement | undefined,
  setDrawing: () => void,
  setLastPoint: (point: { x: number; y: number }) => void,
) {
  if (!canvas) return;
  canvas.setPointerCapture(event.pointerId);
  const point = canvasPoint(event, canvas);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.lineWidth = 2;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(35, 31, 25, 0.76)";
  context.beginPath();
  context.moveTo(point.x, point.y);
  setDrawing();
  setLastPoint(point);
}

function drawSketch(event: PointerEvent, canvas: HTMLCanvasElement, last: { x: number; y: number }) {
  const point = canvasPoint(event, canvas);
  const mid = { x: (last.x + point.x) / 2, y: (last.y + point.y) / 2 };
  const context = canvas.getContext("2d");
  if (!context) return point;
  context.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
  context.stroke();
  return point;
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

function pointerCombo(event: PointerEvent) {
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Meta");
  parts.push(mouseButtonName(event.button));
  return parts.join(" + ");
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

function canvasPoint(event: PointerEvent, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
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

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m4 16 8.5-8.5 4 4L8 20H4v-4Z" />
      <path d="m14 6 4 4" />
    </svg>
  );
}

export default App;
