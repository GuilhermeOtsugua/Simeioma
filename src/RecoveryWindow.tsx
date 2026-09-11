import { createSignal, onMount } from "solid-js";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { basename, dirname } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";

export function RecoveryWindow(props: { storageKey: string }) {
  const [status, setStatus] = createSignal("Your original stored data has not been changed. Export a recovery copy before repairing it.");
  onMount(() => { if (isTauri()) void getCurrentWindow().setSize(new LogicalSize(440, 300)); });
  const exportOriginal = async () => {
    try {
      const contents = localStorage.getItem(props.storageKey);
      if (contents === null) throw new Error("Storage unavailable");
      if (isTauri()) {
        const path = await save({ defaultPath: "simeioma-recovery.json" });
        if (!path) return;
        await invoke("save_text_file", { directory: await dirname(path), filename: await basename(path), contents });
      } else {
        const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = "simeioma-recovery.json"; link.click(); URL.revokeObjectURL(url);
      }
      setStatus("Recovery copy exported. The original remains untouched.");
    } catch { setStatus("Could not export the recovery copy. The original remains untouched; check storage and filesystem access."); }
  };
  return <main class="settings-window-shell" style={{ padding: "20px", overflow: "auto" }}>
    <h1>Stored session needs recovery</h1><p>{status()}</p>
    <button onClick={exportOriginal}>Export original data</button>
    <button onClick={() => location.reload()}>Retry loading</button>
    <button onClick={() => { if (isTauri()) void getCurrentWindow().close(); }}>Close</button>
  </main>;
}
