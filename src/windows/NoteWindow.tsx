import { createResizeQueue } from "../resizeQueue";
import { createSketchScene } from "../sketchScene";
import { createSketchDraft, mergeSketchStrokes } from "../sketchDraft";
import { createLifetime } from "../lifetime";
import { recordDiagnostic, invokeObserved as invoke, startObservedWindowDrag } from "../diagnostics";
import { createSignal, createMemo, onMount, onCleanup, createEffect, Show, For } from "solid-js";
import { loadState, transactState, stateChannel as channel, updateState } from "../persistence";
import { type MarkdownEditorHandle, MarkdownEditor } from "../MarkdownEditor";
import { type SketchStroke, startSketch, coalescedPointerEvents, drawSketch, finishSketch, prepareSketchCanvas, clearSketchCanvas } from "../sketch";
import { getColor, createNoteInState, type Note, removeNoteFromState, type SketchStrokeRecord, NOTE_TITLE_HEIGHT, DEFAULT_NOTE_SIZE, NOTE_COLORS } from "../simeiomaModel";
import { noteBody } from "../noteContent";
import { enqueueNoteCreation, openNoteWindow, hideAllNoteWindows, configureNoteWindow } from "../noteWindows";
import { readSpawnContext, readSpawnAnchor } from "../windowSpawning";
import { createId, markCurrentNoteViewed, persistNotePosition, persistNoteSize, updateNote, persistNoteBody, persistNoteRightText } from "../noteMutations";
import { keyCombo, matchesCombo, pointerCombo } from "../inputCombos";
import { sleep, closeCurrentWindow, HOLD_TO_DRAG_MS } from "../windowInteractions";
import { emitTo } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { readClipboardText, copyText } from "../clipboard";
import { openTextMenuPopupWindow } from "../textMenu";
import { SplitIcon, StarIcon } from "../icons";
import { noteLabelText, slug } from "../noteLabels";

export function NoteWindow(props: { noteId: string; autoFocus: boolean }) {
  const life = createLifetime(() => recordDiagnostic("native-command-failed"));
  const [state, setState] = createSignal(loadState());
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [scribble, setScribble] = createSignal(false);
  const [windowFocused, setWindowFocused] = createSignal(false);
  let canvasRef: HTMLCanvasElement | undefined;
  let bodyEditor: MarkdownEditorHandle | undefined;
  let rightEditor: MarkdownEditorHandle | undefined;
  let activeStroke: SketchStroke | null = null;
  const sketchDraft = createSketchDraft();
  const sketchScene = createSketchScene();
  const resizeQueue = createResizeQueue(size => getCurrentWindow().setSize(new LogicalSize(size.width, size.height)));
  let resizeFinalizing = false;
  let sketchBitmap: string | undefined;
  let canvasRenderEpoch = 0;
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

    const visibleStrokes = sketchDraft.visible(current?.sketchStrokes ?? []);
    if (combo === "Ctrl + Z" && !activeStroke && visibleStrokes.length && document.activeElement !== bodyEditor?.element && document.activeElement !== rightEditor?.element) {
      event.preventDefault();
      const last = visibleStrokes.at(-1)!;
      if (last.id) sketchDraft.discard(last.id);
      refreshSketchScene();
      void updateNote(props.noteId, item => ({ ...item,
        sketchStrokes: last.id ? (item.sketchStrokes ?? []).filter(stroke => stroke.id !== last.id) : (item.sketchStrokes ?? []).slice(0, -1),
        sketchData: undefined, updatedAt: new Date().toISOString(),
      }), { setState: life.guard(setState) }).catch(() => {});
      scheduleCanvasHydration();
      return;
    }

    if (combo === "Ctrl + Shift + Z" && !activeStroke && (visibleStrokes.length || current?.sketchData)) {
      event.preventDefault();
      sketchDraft.clear();
      refreshSketchScene();
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
        if (resizingNote || resizeFinalizing) return;
        sizeSaveTimer = window.setTimeout(() => {
          if (life.active && !resizingNote && !resizeFinalizing) life.after(getCurrentWindow().scaleFactor(), scale =>
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
      resizeQueue.dispose();
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
    if (!isTauri() || event.button !== 0 || !(resizeHandle instanceof HTMLElement) || resizeFinalizing) return;
    event.preventDefault();
    event.stopPropagation();
    resizingNote = true;
    resizeHandle.setPointerCapture(event.pointerId);
    const size = await getCurrentWindow().outerSize();
    const scale = await getCurrentWindow().scaleFactor();
    if (!resizingNote || !life.active) return;
    resizeStart = {
      x: event.clientX,
      y: event.clientY,
      width: size.width / scale,
      height: size.height / scale,
    };
  };

  const resizeNote = (event: PointerEvent) => {
    if (!resizeStart || !resizingNote) return;
    const width = Math.max(176, resizeStart.width + event.clientX - resizeStart.x);
    const height = Math.max(176, resizeStart.height + event.clientY - resizeStart.y);
    resizeQueue.request({ width, height });
  };

  const stopNoteResize = async (event: PointerEvent) => {
    if (!resizingNote) return;
    if (event.type === "pointerup") resizeNote(event);
    resizingNote = false;
    resizeStart = null;
    if (!isTauri()) return;
    resizeFinalizing = true;
    try {
      await resizeQueue.finish();
      if (!life.active) return;
      const size = await getCurrentWindow().outerSize();
      const scale = await getCurrentWindow().scaleFactor();
      if (life.active) await persistNoteSize(props.noteId, { width: size.width / scale, height: size.height / scale }, life.guard(setState));
    } catch { recordDiagnostic("native-command-failed"); }
    finally { resizeFinalizing = false; }
  };

  createEffect(refreshSketchScene);

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
    sketchDraft.add(stroke, createId());
    refreshSketchScene();
    const submitted = sketchDraft.pending();
    void updateNote(props.noteId, item => ({ ...item,
      sketchStrokes: mergeSketchStrokes(item.sketchStrokes ?? [], submitted),
      updatedAt: new Date().toISOString(),
    }), { setState: life.guard(setState) }).then(() => {
      sketchDraft.acknowledge(submitted);
      if (life.active) refreshSketchScene();
    }).catch(() => {}); // Keep failed ink visible; the next stroke retries it with the same IDs.
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
                canvasRenderEpoch += 1; // Invalidate pending bitmap loads before capturing live ink.
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

  function refreshSketchScene() {
    const current = note();
    const changed = sketchScene.setStrokes(sketchDraft.visible(current?.sketchStrokes ?? []));
    if (changed || sketchBitmap !== current?.sketchData) {
      sketchBitmap = current?.sketchData;
      scheduleCanvasHydration();
    }
  }

  function hydrateCanvas() {
    const current = note();
    const epoch = ++canvasRenderEpoch;
    if (!canvasRef || activeStroke || !life.active) return;
    const context = prepareSketchCanvas(canvasRef);
    if (!context) return;
    const renderStrokes = () => {
      sketchScene.draw(context);
    };
    if (current?.sketchData) {
      const image = new Image();
      image.onload = () => {
        if (!life.active || activeStroke || epoch !== canvasRenderEpoch) return;
        clearSketchCanvas(context);
        context.drawImage(image, 0, 0, context.canvas.width, context.canvas.height);
        renderStrokes();
      };
      image.src = current.sketchData;
      return;
    }
    clearSketchCanvas(context);
    renderStrokes();
  }

  function scheduleCanvasHydration() {
    if (canvasRedrawFrame !== undefined || !life.active) return;
    canvasRedrawFrame = window.requestAnimationFrame(() => {
      canvasRedrawFrame = undefined;
      if (!activeStroke) hydrateCanvas();
    });
  }
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
