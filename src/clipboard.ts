import { isTauri } from "@tauri-apps/api/core";
import { invokeObserved as invoke } from "./diagnostics";

export async function copyText(value: string) {
  if (isTauri()) await invoke("write_clipboard_text", { text: value });
  else await navigator.clipboard.writeText(value);
}

export async function readClipboardText() {
  try {
    if (isTauri()) return String(await invoke("read_clipboard_text"));
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}
