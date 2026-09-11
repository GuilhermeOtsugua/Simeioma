import type { SketchStrokeRecord } from "./simeiomaModel";

export function mergeSketchStrokes(saved: SketchStrokeRecord[], pending: SketchStrokeRecord[]) {
  const ids = new Set(saved.flatMap(stroke => stroke.id ? [stroke.id] : []));
  return [...saved, ...pending.filter(stroke => !stroke.id || !ids.has(stroke.id))];
}

// Stable IDs reconcile local ink with storage notifications that can precede save acknowledgement.
export function createSketchDraft() {
  const pending = new Map<string, SketchStrokeRecord>();
  return {
    add(stroke: SketchStrokeRecord, id: string) { pending.set(id, { ...stroke, id }); },
    pending: () => [...pending.values()],
    discard(id: string) { pending.delete(id); },
    clear() { pending.clear(); },
    visible(saved: SketchStrokeRecord[]) { return mergeSketchStrokes(saved, [...pending.values()]); },
    acknowledge(strokes: SketchStrokeRecord[]) { for (const stroke of strokes) if (stroke.id) pending.delete(stroke.id); },
  };
}
