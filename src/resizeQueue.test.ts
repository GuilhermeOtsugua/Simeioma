import { expect, it, vi } from "vitest";
import { createResizeQueue } from "./resizeQueue";
it("sends the latest size per frame with only one native request in flight", async () => {
  let frame!: FrameRequestCallback; let release!: () => void;
  const apply = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const queue = createResizeQueue(apply, { request: callback => { frame = callback; return 1; }, cancel: () => {} });
  queue.request({ width: 200, height: 200 }); queue.request({ width: 300, height: 250 });
  expect(apply).not.toHaveBeenCalled(); frame(0);
  expect(apply).toHaveBeenLastCalledWith({ width: 300, height: 250 });
  queue.request({ width: 400, height: 300 }); queue.request({ width: 500, height: 350 });
  expect(apply).toHaveBeenCalledTimes(1);
  const finish = queue.finish(); release();
  await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith({ width: 500, height: 350 }));
  release(); await finish;
});
it("discards pending work on teardown and surfaces a failed native resize", async () => {
  const frames = { request: vi.fn(() => 1), cancel: vi.fn() };
  const apply = vi.fn(async () => { throw new Error("native resize failed"); });
  const queue = createResizeQueue(apply, frames);
  queue.request({ width: 200, height: 200 });
  await expect(queue.finish()).rejects.toThrow("native resize failed");
  queue.request({ width: 300, height: 300 }); queue.dispose(); await queue.finish();
  expect(apply).toHaveBeenCalledTimes(1);
  expect(frames.cancel).toHaveBeenCalled();
});
