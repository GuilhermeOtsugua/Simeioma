import { onMount, onCleanup } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { closeCurrentWindow } from "../windowInteractions";
import { stateChannel as channel } from "../persistence";
import { emitTo } from "@tauri-apps/api/event";
import { noteLabel } from "../noteWindows";

export function TextMenuPopupWindow() {
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
