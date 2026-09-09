export type DragSample = { mouseDown: boolean; x: number; y: number; width: number; height: number };
type Port = {
  now: () => number;
  sample: () => Promise<DragSample>;
  emit: (event: string, data: Record<string, unknown>) => void;
  capture: () => Promise<void>;
};

// A sidecar: never delays, retries, or changes the native drag promise returned to the app.
export function createDragDiagnostics(port: Port) {
  let dragId = 0;
  let dragging = false;
  let disposed = false;
  let startedAt = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const emit = (event: string, extra: Record<string, unknown> = {}) => {
    try { port.emit(event, { dragId, durationMs: port.now() - startedAt, ...extra }); }
    catch { /* Diagnostic observers cannot change native input behavior. */ }
  };
  const finish = (event: string, sample?: DragSample) => {
    clearTimeout(deadline);
    dragging = false;
    emit(event, sample ? { mouseDown: sample.mouseDown, position: { x: sample.x, y: sample.y }, actual: { width: sample.width, height: sample.height } } : {});
    const finishedId = dragId;
    void Promise.resolve().then(port.capture).catch(() => emit("drag-observation-failed", { dragId: finishedId }));
  };
  const settle = async (id: number) => {
    let previous: DragSample | undefined;
    let stable = 0;
    while (!disposed && dragging && id === dragId) {
      const current = await port.sample();
      if (disposed || !dragging || id !== dragId) return;
      const unchanged = previous && !previous.mouseDown && ["x", "y", "width", "height"].every((key) => current[key as keyof DragSample] === previous![key as keyof DragSample]);
      stable = !current.mouseDown && unchanged ? stable + 1 : 0;
      if (stable >= 2) { finish("drag-end", current); return; }
      previous = current;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  return {
    observe(start: () => Promise<void>): Promise<void> {
      if (disposed) return start();
      if (dragging) { clearTimeout(deadline); emit("drag-superseded"); }
      dragId += 1;
      const id = dragId;
      dragging = true;
      startedAt = port.now();
      emit("drag-start");
      deadline = setTimeout(() => { if (id === dragId && dragging) finish("drag-timeout"); }, 120_000);
      let native: Promise<void>;
      try { native = start(); }
      catch (error) { finish("drag-failed"); throw error; }
      void native.then(async () => {
        if (disposed || id !== dragId || !dragging) return;
        emit("drag-native-return");
        await settle(id);
      }, () => {
        if (!disposed && id === dragId && dragging) finish("drag-failed");
      }).catch(() => {
        if (!disposed && id === dragId && dragging) finish("drag-observation-failed");
      });
      return native;
    },
    status: () => ({ dragId, dragging, dragAgeMs: dragging ? port.now() - startedAt : 0 }),
    dispose() { disposed = true; dragging = false; clearTimeout(deadline); },
  };
}
