import type { SourceSelection } from "./markdownEditorModel";
export type HistoryEntry = { value: string; selection: SourceSelection };

export function createEditorHistory({ maxEntries = 100, maxBytes = 2 * 1024 * 1024, now = () => performance.now() } = {}) {
  const past: HistoryEntry[] = [], future: HistoryEntry[] = [];
  let group: string | undefined, lastAt = -Infinity;
  const bytes = () => [...past, ...future].reduce((sum, entry) => sum + entry.value.length * 2 + 32, 0);
  const trim = () => {
    while (past.length + future.length > maxEntries || bytes() > maxBytes) {
      if (past.length) past.shift(); else future.shift();
    }
  };
  const copy = (entry: HistoryEntry) => ({ value: entry.value, selection: { ...entry.selection } });
  return {
    record(entry: HistoryEntry, key?: string) {
      const at = now();
      if (!key || key !== group || at - lastAt > 750 || future.length) past.push(copy(entry));
      future.length = 0; group = key; lastAt = at; trim();
    },
    undo(current: HistoryEntry) {
      group = undefined;
      const previous = past.pop();
      if (previous) { future.push(copy(current)); trim(); }
      return previous;
    },
    redo(current: HistoryEntry) {
      group = undefined;
      const next = future.pop();
      if (next) { past.push(copy(current)); trim(); }
      return next;
    },
    clear() { past.length = 0; future.length = 0; group = undefined; },
    breakGroup() { group = undefined; },
    stats: () => ({ entries: past.length + future.length, bytes: bytes() }),
  };
}
