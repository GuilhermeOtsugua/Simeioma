import { expect, it, vi } from "vitest";
import { createLifetime } from "./lifetime";
it("disposes late subscriptions and suppresses callbacks after teardown", async () => {
  const life = createLifetime(); const cleanup = vi.fn(), callback = vi.fn();
  let finish!: (fn: () => void) => void;
  life.own(new Promise<() => void>(resolve => { finish = resolve; }));
  const guarded = life.guard(callback); guarded(); life.dispose(); finish(cleanup);
  await Promise.resolve(); guarded(); life.dispose();
  expect(cleanup).toHaveBeenCalledTimes(1); expect(callback).toHaveBeenCalledTimes(1);
});
it("cancels timers and ignores late initialization results", async () => {
  vi.useFakeTimers();
  try {
    const life = createLifetime(), callback = vi.fn();
    life.delay(callback, 10); life.after(Promise.resolve(1), callback); life.dispose();
    await Promise.resolve(); vi.runAllTimers(); expect(callback).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
