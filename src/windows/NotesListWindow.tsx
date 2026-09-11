import { createSignal, createEffect, onMount, onCleanup, Show, For } from "solid-js";
import { loadState, stateChannel as channel, updateState } from "../persistence";
import { createLifetime } from "../lifetime";
import { recordDiagnostic } from "../diagnostics";
import { configureUtilityWindow } from "../utilityWindows";
import { observeUtilityFocus } from "../utilityLifecycle";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { removeNoteFromState, clearNotesFromState, type Note, getColor } from "../simeiomaModel";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { noteLabel, hideAllNoteWindows, closeAllNoteWindows, openNoteWindow } from "../noteWindows";
import { preventUtilityClipboard, startUtilityDrag, closeCurrentWindow } from "../windowInteractions";
import { CloseIcon } from "../icons";
import { noteLabelText } from "../noteLabels";
import { hasOpenTasks } from "../noteContent";
import { exportNote, reportExportFailure } from "../exports";

export function NotesListWindow() {
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
