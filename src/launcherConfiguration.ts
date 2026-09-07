// Serialize the entire resize/position transaction, not just individual IPC calls.
export function createLauncherConfiguration<T>(apply: (state: T) => Promise<void>) {
  let tail = Promise.resolve();
  return (state: T): Promise<void> => {
    const result = tail.then(() => apply(state));
    // A failed native operation must not prevent subsequent requests.
    tail = result.catch(() => {});
    return result;
  };
}
