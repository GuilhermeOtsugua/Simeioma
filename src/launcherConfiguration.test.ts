import { expect, it, vi } from "vitest";
import { createLauncherConfiguration } from "./launcherConfiguration";

it("keeps confirmation expanded when an older menu resize finishes late", async () => {
  let finishMenu!: () => void;
  const menuBlocked = new Promise<void>((resolve) => { finishMenu = resolve; });
  let width = 30;
  const configure = createLauncherConfiguration(async (requestedWidth: number) => {
    if (requestedWidth === 64) await menuBlocked;
    width = requestedWidth;
  });
  const menu = configure(64);
  const confirmation = configure(360);
  await Promise.resolve();
  finishMenu();
  await Promise.all([menu, confirmation]);
  expect(width).toBe(360);
});

it("reports queue lifecycle and drains after failure without logging altering behavior", async () => {
  const events: string[] = [];
  const configure = createLauncherConfiguration(async (width: number) => {
    if (width === 64) throw new Error("injected failure");
  }, (event, _state, status) => {
    events.push(`${status.operationId}:${event}:${status.pending}`);
    if (event === "started") throw new Error("broken observer");
  });
  const menu = configure(64);
  const confirmation = configure(360);
  expect(configure.snapshot().pending).toBe(2);
  await expect(menu).rejects.toThrow("injected failure");
  await confirmation;
  expect(events).toEqual(["1:queued:1", "2:queued:2", "1:started:2", "1:failed:1", "2:started:1", "2:completed:0"]);
  expect(configure.snapshot()).toMatchObject({ pending: 0, busy: false });
});

it("exposes the age of an in-flight operation for the stalled-queue watchdog", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  let finish!: () => void;
  const configure = createLauncherConfiguration(() => new Promise<void>((resolve) => { finish = resolve; }));
  try {
    const operation = configure(360);
    await Promise.resolve();
    clock.mockReturnValue(6200);
    expect(configure.snapshot()).toMatchObject({ busy: true, operationAgeMs: 6100 });
    finish();
    await operation;
    expect(configure.snapshot()).toMatchObject({ busy: false, operationAgeMs: 0 });
  } finally { clock.mockRestore(); }
});

it("lets spawn placement wait for the complete current configuration queue", async () => {
  let finish!: () => void;
  const configure = createLauncherConfiguration(() => new Promise<void>((resolve) => { finish = resolve; }));
  void configure(64);
  let settled = false;
  const idle = configure.whenIdle().then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  const finishFirst = finish;
  const second = configure(360);
  finishFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  finish();
  await Promise.all([second, idle]);
  expect(settled).toBe(true);
});

it("allows confirmation to resize after a previous native request failed", async () => {
  let width = 30;
  const configure = createLauncherConfiguration(async (requestedWidth: number) => {
    if (requestedWidth === 64) throw new Error("native resize failed");
    width = requestedWidth;
  });
  const failedMenu = configure(64);
  const confirmation = configure(360);
  await expect(failedMenu).rejects.toThrow("native resize failed");
  await confirmation;
  expect(width).toBe(360);
});
