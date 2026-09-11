import { isTauri } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { invokeObserved as invoke } from "./diagnostics";
import { updateState } from "./persistence";
import { NOTE_COLORS, type Note, type Settings, type ExportFormat } from "./simeiomaModel";
import { planImageExport, noteLabelText, noteToMarkdown, notesToMarkdown, notesToText } from "./exportModel";
import { renderSketchRecord } from "./sketch";

import { copyText } from "./clipboard";
function download(filename: string, bytes: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}
async function saveText(settings: Settings, filename: string, contents: string) {
  if (settings.exportPath && isTauri()) await invoke("save_text_file", { directory: settings.exportPath, filename, contents });
  else download(filename, new TextEncoder().encode(contents), "text/plain");
  if (settings.copyAfterSave) await copyText(contents);
}
export function encodeCanvas(canvas: HTMLCanvasElement, format: "png" | "jpeg"): Promise<Uint8Array> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Image encoding failed")), `image/${format}`, 0.92);
  }).then(async blob => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length) throw new Error("Image encoding failed");
    return bytes;
  });
}
export async function renderNotesImage(notes: Note[], format: "png" | "jpeg") {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image rendering unavailable");
  context.font = "600 20px Segoe UI, sans-serif";
  const plan = planImageExport(notes, text => context.measureText(text).width);
  canvas.width = plan.width; canvas.height = plan.height;
  context.fillStyle = "#f7f2df"; context.fillRect(0, 0, canvas.width, canvas.height);
  for (const card of plan.cards) {
    const color = NOTE_COLORS.find(color => color.key === card.note.colorKey) ?? NOTE_COLORS[0];
    context.fillStyle = color.bg; context.beginPath(); context.roundRect(card.x, card.y, card.width, card.height, 18); context.fill();
    context.fillStyle = color.ink; context.font = "600 20px Segoe UI, sans-serif";
    card.title.forEach((line, i) => context.fillText(line, card.x + 20, card.y + 38 + i * 22));
    context.font = "15px Segoe UI, sans-serif";
    if (card.right) { context.fillText("Left", card.x + 20, card.textY - 4); context.fillText("Right", card.x + 44 + card.columnWidth, card.textY - 4); }
    card.left.forEach((line, i) => context.fillText(line, card.x + 20, card.textY + 18 + i * 22));
    card.right?.forEach((line, i) => context.fillText(line, card.x + 44 + card.columnWidth, card.textY + 18 + i * 22));
    if (card.drawing) {
      context.fillText("Drawing", card.drawing.x, card.drawing.y - 6);
      const drawing = document.createElement("canvas"); drawing.width = card.drawing.width; drawing.height = card.drawing.height;
      const pen = drawing.getContext("2d"); if (!pen) throw new Error("Drawing rendering unavailable");
      if (card.note.sketchData) {
        if (!/^data:image\/(png|jpeg|webp);base64,/.test(card.note.sketchData)) throw new Error("Unsupported saved drawing");
        const image = new Image(); image.src = card.note.sketchData; await image.decode();
        pen.drawImage(image, 0, 0, drawing.width, drawing.height);
      }
      for (const stroke of card.note.sketchStrokes ?? []) renderSketchRecord(pen, stroke);
      context.drawImage(drawing, card.drawing.x, card.drawing.y);
    }
  }
  return encodeCanvas(canvas, format);
}
export async function exportSession(format?: ExportFormat) {
  const state = await updateState(state => state); // Fence pending edits before taking an export snapshot.
  format ??= state.settings.exportFormat;
  const filename = `simeioma-notes-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${format}`;
  if (format === "png" || format === "jpeg") {
    const bytes = await renderNotesImage(state.notes, format);
    if (state.settings.exportPath && isTauri()) await invoke("save_binary_file", { directory: state.settings.exportPath, filename, bytes: Array.from(bytes) });
    else download(filename, bytes, `image/${format}`);
  } else await saveText(state.settings, filename, format === "txt" ? notesToText(state.notes) : notesToMarkdown(state.notes));
}
export async function exportNote(id: string, copyOnly = false) {
  const state = await updateState(state => state);
  const note = state.notes.find(note => note.id === id);
  if (!note) throw new Error("Note no longer exists");
  if (copyOnly) await copyText(noteToMarkdown(note));
  else await saveText(state.settings, `${noteLabelText(note)}.md`, noteToMarkdown(note));
}
export async function reportExportFailure() {
  await message("Export or clipboard copy failed. Check the destination and drawing data; for very large notes, use Markdown or text.", { title: "Simeioma export", kind: "error" });
}
