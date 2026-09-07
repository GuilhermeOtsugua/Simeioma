import { expect, it } from "vitest";
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
