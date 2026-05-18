import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  LogicalPosition,
  LogicalSize,
  getCurrentWindow,
  primaryMonitor,
} from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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
const HOLD_TO_DRAG_MS = 120;

const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
let launcherWasPlaced = false;

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
  let launcherCenter: { x: number; y: number } | null = null;

  onMount(() => {
    resetDebugSessionNotes(setState);
    configureLauncherWindow(false);

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
    }

    onCleanup(() => {
      channel?.removeEventListener("message", onMessage);
      window.clearInterval(interval);
      window.clearTimeout(dragTimer);
    });
  });

  createEffect(() => {
    configureLauncherWindow(menuOpen(), hovered(), confirmingExit(), launcherCenter, (center) => (launcherCenter = center));
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
    getCurrentWindow().startDragging();
  };

  const createNoteFromLauncher = () => {
    if (dragStarted || menuOpen()) return;
    clickHandledAt = performance.now();
    createNote();
  };

  const closeSimeioma = async () => {
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
          if (event.ctrlKey) {
            toggleNotesVisible();
            return;
          }
          setMenuOpen(true);
        }}
        onPointerDown={(event) => {
          if (event.button === 2) {
            event.preventDefault();
            suppressNextLauncherClick = true;
            if (event.ctrlKey) {
              toggleNotesVisible();
            } else {
              setMenuOpen(true);
            }
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
          dragTimer = window.setTimeout(startLauncherDrag, HOLD_TO_DRAG_MS);
        }}
        onPointerMove={(event) => {
          if (!pointerDownAt || event.buttons !== 1 || dragStarted) return;
          const moved = Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y);
          if (moved > 8) {
            pointerMovedTooFar = true;
            window.clearTimeout(dragTimer);
          }
        }}
        onPointerUp={() => {
          window.clearTimeout(dragTimer);
          pointerDownAt = null;
          if (suppressNextLauncherClick || pointerMovedTooFar) return;
          createNoteFromLauncher();
        }}
        onPointerCancel={() => {
          window.clearTimeout(dragTimer);
          pointerDownAt = null;
          pointerMovedTooFar = false;
          suppressNextLauncherClick = false;
        }}
        onLostPointerCapture={() => {
          window.clearTimeout(dragTimer);
          pointerDownAt = null;
          pointerMovedTooFar = false;
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
        <section class="exit-confirmation" role="dialog" aria-label="Confirm exit">
          <strong>Are you sure?</strong>
          <div>
            <button
              type="button"
              class="confirm"
              autofocus
              onClick={() => closeSimeioma()}
              onKeyDown={(event) => {
                if (event.key === "Enter") closeSimeioma();
                if (event.key === "Escape") setConfirmingExit(false);
              }}
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
      <header class="utility-titlebar" onPointerDown={() => isTauri() && getCurrentWindow().startDragging()}>
        <strong>Simeioma Settings</strong>
        <button type="button" aria-label="Close settings" title="Close settings" onClick={() => closeCurrentWindow()}>
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
      <header class="utility-titlebar" onPointerDown={() => isTauri() && getCurrentWindow().startDragging()}>
        <strong>Simeioma Notes</strong>
        <button type="button" aria-label="Close notes list" title="Close notes list" onClick={() => closeCurrentWindow()}>
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
  const [animatingLines, setAnimatingLines] = createSignal<Set<string>>(new Set());
  let canvasRef: HTMLCanvasElement | undefined;
  let drawing = false;
  let lastPoint: { x: number; y: number } | null = null;
  let noteDragTimer: number | undefined;

  const note = createMemo(() => state().notes.find((item) => item.id === props.noteId));
  const noteColor = createMemo(() => getColor(note()?.colorKey));
  const otherNotes = createMemo(() => state().notes.filter((item) => item.id !== props.noteId));
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
    if (target.closest("button, input, textarea, select, .color-popover, .mention-row")) return;
    window.clearTimeout(noteDragTimer);
    noteDragTimer = window.setTimeout(() => getCurrentWindow().startDragging(), HOLD_TO_DRAG_MS);
  };

  createEffect(() => {
    note()?.sketchData;
    hydrateCanvas();
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

  const patchLine = (lineId: string, patch: Partial<NoteLine>) => {
    const current = note();
    if (!current) return;
    patchNote({
      lines: current.lines.map((line) => (line.id === lineId ? { ...line, ...patch } : line)),
    });
  };

  const updateLineText = (lineId: string, rawText: string) => {
    const parsed = parseLineInput(rawText);
    patchLine(lineId, parsed);
  };

  const insertLineAfter = (lineId: string) => {
    const current = note();
    if (!current) return;
    const index = current.lines.findIndex((line) => line.id === lineId);
    const nextLine = { id: createId(), text: "", task: false, crossed: false };
    patchNote({
      lines: [
        ...current.lines.slice(0, index + 1),
        nextLine,
        ...current.lines.slice(index + 1),
      ],
    });
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-line-id="${nextLine.id}"]`)?.focus();
    }, 0);
  };

  const removeEmptyLine = (lineId: string) => {
    const current = note();
    if (!current || current.lines.length === 1) return;
    const index = current.lines.findIndex((line) => line.id === lineId);
    const target = current.lines[index];
    if (target.text.trim()) return;
    const previous = current.lines[index - 1] ?? current.lines[index + 1];
    patchNote({ lines: current.lines.filter((line) => line.id !== lineId) });
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-line-id="${previous.id}"]`)?.focus();
    }, 0);
  };

  const toggleCrossed = (lineId: string) => {
    const currentLine = note()?.lines.find((line) => line.id === lineId);
    if (!currentLine) return;
    patchLine(lineId, { crossed: !currentLine.crossed });
    if (!currentLine.crossed) {
      setAnimatingLines((items) => new Set(items).add(lineId));
      window.setTimeout(() => {
        setAnimatingLines((items) => {
          const next = new Set(items);
          next.delete(lineId);
          return next;
        });
      }, 700);
    }
  };

  const saveSketch = () => {
    if (!canvasRef) return;
    patchNote({ sketchData: canvasRef.toDataURL("image/png") });
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
          onPointerUp={() => window.clearTimeout(noteDragTimer)}
          onPointerLeave={() => window.clearTimeout(noteDragTimer)}
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

          <section
            class="note-body"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                focusFirstLine();
              }
            }}
          >
            <For each={item().lines}>
              {(line) => (
                <div
                  class="note-line"
                  classList={{
                    "is-task": line.task,
                    "is-crossed": line.crossed,
                    "is-animating": animatingLines().has(line.id),
                    "is-heading": line.text.startsWith("# "),
                    "is-code": /^`.*`$/.test(line.text.trim()),
                  }}
                  onClick={(event) => {
                    if (event.ctrlKey) {
                      event.preventDefault();
                      toggleCrossed(line.id);
                    }
                  }}
                >
                  <Show when={line.task}>
                    <button
                      class="task-box"
                      aria-label="Toggle task"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleCrossed(line.id);
                      }}
                    >
                      <span />
                    </button>
                  </Show>
                  <textarea
                    class="line-editor"
                    aria-label="Note line"
                    data-line-id={line.id}
                    value={line.text}
                    placeholder="Write..."
                    spellcheck={false}
                    onInput={(event) => updateLineText(line.id, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        insertLineAfter(line.id);
                      }
                      if (event.key === "Backspace" && !event.currentTarget.value.length) {
                        event.preventDefault();
                        removeEmptyLine(line.id);
                      }
                    }}
                  />
                </div>
              )}
            </For>

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

          <button
            class="scribble-toggle"
            classList={{ "is-active": scribble() }}
            title="Toggle scribble mode"
            onClick={() => setScribble(!scribble())}
          >
            {PencilIcon()}
          </button>
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
                  const action = window.prompt("Type copy, save, or delete.", "copy");
                  if (action === "delete") props.onDelete(note.id);
                  if (action === "copy") copyText(noteToMarkdown(note));
                  if (action === "save") saveTextExport(loadState().settings, `${noteLabelText(note)}.md`, noteToMarkdown(note));
                }}
              >
                <span>{noteLabelText(note)}</span>
                <small>{note.important ? "Important" : note.lines.some((line) => line.task && !line.crossed) ? "Open tasks" : "Note"}</small>
              </button>
            );
          }}
        </For>
      </Show>
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
  return (
    <div class="settings-stack">
      <label class="setting-row">
        <span>Save path</span>
        <input
          value={props.settings.exportPath}
          placeholder="C:\\Users\\you\\Downloads"
          onInput={(event) => props.onChange({ exportPath: event.currentTarget.value })}
        />
      </label>

      <label class="setting-row compact">
        <span>Copy after save</span>
        <input
          type="checkbox"
          checked={props.settings.copyAfterSave}
          onChange={(event) => props.onChange({ copyAfterSave: event.currentTarget.checked })}
        />
      </label>

      <label class="setting-row">
        <span>Format</span>
        <select
          value={props.settings.exportFormat}
          onChange={(event) => props.onChange({ exportFormat: event.currentTarget.value as ExportFormat })}
        >
          <option value="txt">txt</option>
          <option value="markdown">markdown</option>
          <option value="png">png</option>
          <option value="jpeg">jpeg</option>
        </select>
      </label>

      <label class="setting-row">
        <span>Cross out</span>
        <input
          value={props.settings.strikeKeybind}
          onInput={(event) => props.onChange({ strikeKeybind: event.currentTarget.value })}
        />
      </label>

      <label class="setting-row">
        <span>Scribble</span>
        <input
          value={props.settings.scribbleKeybind}
          onInput={(event) => props.onChange({ scribbleKeybind: event.currentTarget.value })}
        />
      </label>

      <label class="setting-row compact">
        <span>Reminders</span>
        <input
          type="checkbox"
          checked={props.settings.remindersEnabled}
          onChange={(event) => props.onChange({ remindersEnabled: event.currentTarget.checked })}
        />
      </label>

      <label class="setting-row">
        <span>Timing</span>
        <select
          value={props.settings.reminderMode}
          onChange={(event) => props.onChange({ reminderMode: event.currentTarget.value as ReminderMode })}
        >
          <option value="minutes">Every X minutes</option>
          <option value="hourly">Hourly</option>
          <option value="hourMinute">Time every hour</option>
          <option value="datetime">Specific datetime</option>
        </select>
      </label>

      <label class="setting-row">
        <span>Value</span>
        <input
          value={props.settings.reminderValue}
          placeholder="30, :15, or 2026-05-16T14:00"
          onInput={(event) => props.onChange({ reminderValue: event.currentTarget.value })}
        />
      </label>

      <label class="setting-row">
        <span>Target</span>
        <select
          value={props.settings.reminderTarget}
          onChange={(event) => props.onChange({ reminderTarget: event.currentTarget.value as ReminderTarget })}
        >
          <option value="all">All notes</option>
          <option value="attention">Important or tasks</option>
          <option value="important">Important</option>
          <option value="tasks">Uncrossed tasks</option>
        </select>
      </label>
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

function saveState(state: AppState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  channel?.postMessage({ type: "state" });
}

function resetDebugSessionNotes(setState?: (state: AppState) => void) {
  const reset = resetNotesForDebug(loadState());
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
  return { text, task: false };
}

async function configureLauncherWindow(
  menuOpen: boolean,
  hovered = false,
  confirmingExit = false,
  center: { x: number; y: number } | null = null,
  setCenter?: (center: { x: number; y: number }) => void,
) {
  if (!isTauri()) return;
  const width = confirmingExit ? 208 : menuOpen ? MENU_WIDTH : hovered ? STRIP_HOVER_WIDTH : STRIP_HIT_WIDTH;
  const height = menuOpen ? MENU_HEIGHT : STRIP_HEIGHT;
  const appWindow = getCurrentWindow();
  const monitor = await primaryMonitor();
  const scale = monitor?.scaleFactor || 1;
  await appWindow.setAlwaysOnTop(true);
  await appWindow.setSkipTaskbar(true);
  await appWindow.setResizable(false);
  await appWindow.setSize(new LogicalSize(width, height));
  if (center) {
    await appWindow.setPosition(new LogicalPosition(Math.max(0, center.x - width / 2), Math.max(0, center.y - height / 2)));
  } else {
    await positionWindow(width, height);
    const placed = await appWindow.outerPosition();
    const size = await appWindow.outerSize();
    setCenter?.({
      x: placed.x / scale + size.width / scale / 2,
      y: placed.y / scale + size.height / scale / 2,
    });
    launcherWasPlaced = true;
  }
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
  return {
    x: (work.position.x + work.size.width) / scale - DEFAULT_NOTE_SIZE - 72,
    y: (work.position.y + work.size.height) / scale - DEFAULT_NOTE_SIZE - STRIP_HEIGHT - 32,
  };
}

async function positionWindow(width: number, height: number) {
  const monitor = await primaryMonitor();
  if (!monitor) return;
  const scale = monitor.scaleFactor || 1;
  const work = monitor.workArea;
  const right = (work.position.x + work.size.width) / scale;
  const bottom = (work.position.y + work.size.height) / scale;
  const centerX = right - 16 - STRIP_HIT_WIDTH / 2;
  const centerY = bottom - 16 - STRIP_HEIGHT / 2;
  const x = centerX - width / 2;
  const y = centerY - height / 2;
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
  for (const note of loadState().notes) {
    const noteWindow = await WebviewWindow.getByLabel(noteLabel(note.id));
    await noteWindow?.close();
  }
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
