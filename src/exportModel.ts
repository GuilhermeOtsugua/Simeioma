import { noteBody } from "./noteContent";
import { DEFAULT_NOTE_SIZE, NOTE_TITLE_HEIGHT, type Note } from "./simeiomaModel";

import { noteLabelText } from "./noteLabels";
export { noteLabelText } from "./noteLabels";
export function noteToMarkdown(note: Note) {
  const left = noteBody(note);
  return note.layout === "two-column" ? `# ${noteLabelText(note)}\n\n## Left\n\n${left}\n\n## Right\n\n${note.rightText ?? ""}\n`
    : `# ${noteLabelText(note)}\n\n${left}\n`;
}
export const notesToMarkdown = (notes: Note[]) => notes.map(noteToMarkdown).join("\n---\n\n");
export const notesToText = (notes: Note[]) => notes.map(note => `${noteLabelText(note)}\n${noteBody(note)}${note.layout === "two-column" ? `\n\nRight:\n${note.rightText ?? ""}` : ""}`).join("\n\n---\n\n");

function wrap(text: string, width: number, measure: (text: string) => number) {
  return text.replace(/\r\n/g, "\n").split("\n").flatMap(line => {
    const rows: string[] = []; let row = "";
    const segments = typeof Intl.Segmenter === "function" ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line), part => part.segment) : Array.from(line);
    for (const part of segments) {
      if (row && measure(row + part) > width) { rows.push(row); row = ""; }
      row += part;
    }
    rows.push(row); return rows;
  });
}
export function planImageExport(notes: Note[], measure: (text: string) => number) {
  const width = 720, x = 32, cardWidth = 656, contentWidth = 616;
  let y = 32;
  const cards = notes.map(note => {
    const columnWidth = note.layout === "two-column" ? (contentWidth - 24) / 2 : contentWidth;
    const title = wrap(noteLabelText(note), contentWidth, measure);
    const left = wrap(noteBody(note), columnWidth, measure);
    const right = note.layout === "two-column" ? wrap(note.rightText ?? "", columnWidth, measure) : undefined;
    const textY = y + 20 + title.length * 22 + 20;
    const drawingY = textY + Math.max(left.length, right?.length ?? 0) * 22 + 24;
    const size = note.size ?? { width: DEFAULT_NOTE_SIZE, height: DEFAULT_NOTE_SIZE };
    const drawing = note.sketchData || note.sketchStrokes?.length ? { x: x + 20, y: drawingY,
      width: contentWidth, height: Math.max(1, Math.round(contentWidth * Math.max(1, size.height - NOTE_TITLE_HEIGHT) / size.width)) } : undefined;
    const height = (drawing ? drawing.y + drawing.height : drawingY) - y + 20;
    const card = { note, x, y, width: cardWidth, height, columnWidth, title, left, right, textY, drawing };
    y += height + 16;
    if (y + 16 > 22000) throw new Error("Image export is too large; use Markdown or text instead.");
    return card;
  });
  return { width, height: Math.max(240, y + 16), cards };
}
