export function createLifetime(onError: (error: unknown) => void = () => {}) {
  let active = true;
  const cleanups = new Set<() => void>();
  const guard = <A extends unknown[], R>(callback: (...args: A) => R) => (...args: A): R | undefined => active ? callback(...args) : undefined;
  const own = (cleanup: (() => void) | Promise<() => void>) => {
    if (typeof cleanup === "function") { if (active) cleanups.add(cleanup); else cleanup(); }
    else void cleanup.then(own).catch(onError);
  };
  return {
    get active() { return active; }, own, guard,
    after<T>(promise: Promise<T>, callback: (value: T) => unknown) { void promise.then(guard(callback)).catch(onError); },
    delay(callback: () => void, milliseconds: number) {
      const cancel = () => clearTimeout(timer);
      const timer = setTimeout(() => { cleanups.delete(cancel); if (active) callback(); }, milliseconds);
      own(cancel); return cancel;
    },
    dispose() { if (!active) return; active = false; for (const cleanup of cleanups) { try { cleanup(); } catch (error) { onError(error); } } cleanups.clear(); },
  };
}
