import type { Note } from "./simeiomaModel";
export function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}
export function noteLabelText(note: Note) {
  if (note.title.trim()) return note.title.trim();
  const body = note.lines.map(line => line.text).join(" ").trim();
  return body ? slug(body).slice(0, 34) || "note" : new Date(note.createdAt).toLocaleString();
}
