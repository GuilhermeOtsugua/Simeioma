import type { Note } from "./simeiomaModel";

// Compatibility adapter: old structured lines become source Markdown without modifying storage on read.
export function noteBody(note: Note): string {
  return note.lines.map(line => line.task ? `- [${line.crossed ? "x" : " "}] ${line.text}`
    : line.crossed ? `~~${line.text}~~` : line.text).join("\n");
}
export function taskLine(text: string) {
  const match = text.match(/^ {0,3}[-*+]\s+\[([ xX])\]\s+(.*)$/);
  return match ? { checked: match[1].toLowerCase() === "x", text: match[2], prefixLength: text.length - match[2].length } : null;
}
export function sourceLines(value: string) {
  let from = 0;
  let fence: string | undefined;
  return value.split("\n").map((text, index) => {
    const marker = text.match(/^ {0,3}(`{3,}|~{3,})/);
    const fenced = !!fence || !!marker;
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && text.slice(marker[0].length).trim() === "") fence = undefined;
    }
    const line = { from, to: from + text.length, text, index, fenced };
    from = line.to + 1;
    return line;
  });
}
export function openTaskCount(note: Note) {
  const sources = [noteBody(note), ...(note.layout === "two-column" ? [note.rightText ?? ""] : [])];
  return sources.reduce((count, source) => count + sourceLines(source).filter(line => !line.fenced && taskLine(line.text)?.checked === false).length, 0);
}
export function hasOpenTasks(note: Note) { return openTaskCount(note) > 0; }
