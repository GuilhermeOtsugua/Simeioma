type Size = { width: number; height: number };
export function createResizeQueue(apply: (size: Size) => Promise<void>, frames = {
  request: (callback: FrameRequestCallback) => requestAnimationFrame(callback),
  cancel: (id: number) => cancelAnimationFrame(id),
}) {
  let pending: Size | undefined, running: Promise<void> | undefined, frame: number | undefined;
  let disposed = false, failure: unknown;
  const cancel = () => { if (frame !== undefined) frames.cancel(frame); frame = undefined; };
  const schedule = () => { if (!disposed && pending && !running && frame === undefined) frame = frames.request(() => { frame = undefined; start(); }); };
  const start = () => {
    if (disposed || running || !pending) return;
    const size = pending; pending = undefined;
    running = (async () => { try { await apply(size); } catch (error) { failure = error; } })().then(() => {
      running = undefined; schedule();
    });
  };
  return {
    request(size: Size) { if (!disposed) { pending = size; schedule(); } },
    async finish() {
      while (running || pending) { cancel(); if (!running) start(); if (running) await running; }
      cancel();
      if (failure) { const error = failure; failure = undefined; throw error; }
    },
    dispose() { disposed = true; pending = undefined; cancel(); },
  };
}
