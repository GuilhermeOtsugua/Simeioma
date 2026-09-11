import { z } from "zod";
import { DEFAULT_SETTINGS, normalizeNoteColorKey, type AppState } from "./simeiomaModel";

const point = z.object({ x: z.number().finite(), y: z.number().finite() }).passthrough();
const sample = point.extend({ time: z.number().finite().optional() });
const brush = z.enum(["thin", "default", "thick"]);
const rendering = z.enum(["legacy", "simeioma-adaptive", "tomodachi-pixel"]);
const stroke = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1).optional(), type: z.literal("freehand"), points: z.array(sample), renderingMode: rendering.optional(), brushSize: brush.optional() }).passthrough(),
  z.object({ id: z.string().min(1).optional(), type: z.literal("line"), start: point, end: point }).passthrough(),
  z.object({ id: z.string().min(1).optional(), type: z.literal("circle"), center: point, radius: z.number().finite().nonnegative() }).passthrough(),
  z.object({ id: z.string().min(1).optional(), type: z.literal("rect"), x: z.number().finite(), y: z.number().finite(), width: z.number().finite(), height: z.number().finite() }).passthrough(),
]);
const date = z.string().refine(value => Number.isFinite(Date.parse(value)), "Invalid date");
const settings = z.object({
  exportPath: z.string(), copyAfterSave: z.boolean(), exportFormat: z.enum(["txt", "markdown", "png", "jpeg"]),
  strikeKeybind: z.string(), scribbleKeybind: z.string(), newNoteKeybind: z.string(), hideNotesKeybind: z.string(),
  sketchRenderingMode: rendering, sketchBrushSize: brush,
  reminderMode: z.enum(["periodic", "timeOfDay"]), reminderValue: z.string(),
  reminderTarget: z.enum(["all", "important", "tasks", "attention"]), remindersEnabled: z.boolean(), lastReminderAt: date.optional(),
}).passthrough();
const note = z.object({
  id: z.string().min(1), title: z.string(), colorKey: z.string().transform(normalizeNoteColorKey), important: z.boolean(),
  lines: z.array(z.object({ id: z.string().min(1), text: z.string(), task: z.boolean(), crossed: z.boolean() }).passthrough()).min(1),
  layout: z.enum(["single", "two-column"]).optional(), rightText: z.string().optional(),
  sketchData: z.string().optional(), sketchStrokes: z.array(stroke).optional(),
  createdAt: date, updatedAt: date, viewedAt: date.optional(), position: point.optional(),
  size: z.object({ width: z.number().finite().positive(), height: z.number().finite().positive() }).passthrough().optional(),
}).passthrough();
const schema = z.object({
  schemaVersion: z.literal(1).optional(), revision: z.number().int().nonnegative().optional(),
  notes: z.array(note).default([]).refine(notes => new Set(notes.map(n => n.id)).size === notes.length, "Duplicate note ids"),
  launcher: z.object({ colorIndex: z.number().int().nonnegative().default(0), corner: z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]).default("bottom-right") }).passthrough().default({ colorIndex: 0, corner: "bottom-right" }),
  settings: z.preprocess(value => value === undefined ? DEFAULT_SETTINGS : typeof value === "object" && value !== null && !Array.isArray(value) ? { ...DEFAULT_SETTINGS, ...value } : value, settings),
}).passthrough();

export function decodeState(raw: string): AppState {
  const { schemaVersion: _version, revision: _revision, ...state } = schema.parse(JSON.parse(raw));
  return state;
}
export function encodeState(state: AppState, revision = 0): string {
  return JSON.stringify(schema.parse({ ...state, schemaVersion: 1, revision }));
}
export function stateRevision(raw: string | null): number {
  return raw ? (schema.parse(JSON.parse(raw)).revision ?? 0) : 0;
}
