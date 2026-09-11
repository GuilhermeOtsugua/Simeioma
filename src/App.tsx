import { diagnosticStorageKey, startDiagnostics } from "./diagnostics";
import { onMount, onCleanup } from "solid-js";
import { loadState } from "./persistence";
import { RecoveryWindow } from "./RecoveryWindow";
import { NoteWindow } from "./windows/NoteWindow";
import { SettingsWindow } from "./windows/SettingsWindow";
import { NotesListWindow } from "./windows/NotesListWindow";
import { TextMenuPopupWindow } from "./windows/TextMenuPopupWindow";
import { LauncherWindow } from "./windows/LauncherWindow";

const STORAGE_KEY = diagnosticStorageKey;

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

import "./App.css";
export default App;
