type Status = { operationId: number; pending: number; busy: boolean; operationAgeMs: number };
type Event = "queued" | "started" | "completed" | "failed";

// Serialize the entire resize/position transaction, not just individual IPC calls.
export function createLauncherConfiguration<T>(
  apply: (state: T, operationId: number) => Promise<void>,
  observe?: (event: Event, state: T, status: Status) => void,
) {
  let tail = Promise.resolve();
  let sequence = 0;
  let pending = 0;
  let busy = false;
  let activeOperationId = 0;
  let activeStartedAt = 0;
  const notify = (event: Event, state: T, operationId: number) => {
    try { observe?.(event, state, { operationId, pending, busy, operationAgeMs: operationId === activeOperationId ? Math.max(0, performance.now() - activeStartedAt) : 0 }); }
    catch { /* An observer must never change window behavior. */ }
  };
  const request = (state: T): Promise<void> => {
    const operationId = ++sequence;
    pending += 1;
    notify("queued", state, operationId);
    const result = tail.then(async () => {
      busy = true;
      activeOperationId = operationId;
      activeStartedAt = performance.now();
      notify("started", state, operationId);
      let outcome: Event = "completed";
      try { await apply(state, operationId); }
      catch (error) { outcome = "failed"; throw error; }
      finally {
        pending -= 1;
        busy = false;
        notify(outcome, state, operationId);
      }
    });
    // A failed native operation must not prevent subsequent requests.
    tail = result.catch(() => {});
    return result;
  };
  return Object.assign(request, {
    snapshot: (): Status => ({ operationId: activeOperationId, pending, busy, operationAgeMs: busy ? Math.max(0, performance.now() - activeStartedAt) : 0 }),
    whenIdle: async () => {
      let observed: Promise<void>;
      do { observed = tail; await observed; } while (observed !== tail);
    },
  });
}
