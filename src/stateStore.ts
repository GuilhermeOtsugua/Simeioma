import { decodeState, encodeState, stateRevision } from "./stateCodec";
import type { AppState } from "./simeiomaModel";

type Options = {
  key: string;
  storage: Pick<Storage, "getItem" | "setItem">;
  locks: { request<T>(name: string, action: () => T | Promise<T>): Promise<T> };
  initial: () => AppState;
  changed?: (state: AppState, revision: number, broadcast: boolean) => void;
  failed?: () => void;
};
// All writers for this origin/key take the same Web Lock. No unlocked fallback exists.
export function createStateStore(options: Options) {
  const read = () => { const raw = options.storage.getItem(options.key); return raw === null ? options.initial() : decodeState(raw); };
  async function transact<T extends { state: AppState }>(update: (state: AppState) => T, broadcast = true): Promise<T> {
    try {
      return await options.locks.request(`${options.key}:mutation`, () => {
        const raw = options.storage.getItem(options.key);
        const state = raw === null ? options.initial() : decodeState(raw);
        const result = update(state);
        if (result.state !== state) {
          const revision = stateRevision(raw) + 1;
          options.storage.setItem(options.key, encodeState(result.state, revision));
          // Notification failure cannot turn a committed write into a failed transaction.
          try { options.changed?.(result.state, revision, broadcast); } catch { /* Readers can reload persisted state. */ }
        }
        return result;
      });
    } catch (error) { options.failed?.(); throw error; }
  }
  return { read, transact };
}
