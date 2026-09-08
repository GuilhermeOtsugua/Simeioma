import { afterEach, expect, it, vi } from "vitest";
import { randomSettingsAccent } from "./settingsAppearance";

afterEach(() => vi.restoreAllMocks());

it("uses only pink, light blue, orange and green for settings accents", () => {
  const random = vi.spyOn(Math, "random");
  const keys = new Set<string>();
  for (let step = 0; step < 100; step += 1) {
    random.mockReturnValue(step / 100);
    keys.add(randomSettingsAccent().key);
  }
  expect([...keys].sort()).toEqual(["pink", "aqua", "papaya", "mint"].sort());
});

it("changes accents without repeating the current color", () => {
  const random = vi.spyOn(Math, "random");
  for (const current of ["pink", "aqua", "papaya", "mint"]) {
    for (let step = 0; step < 100; step += 1) {
      random.mockReturnValue(step / 100);
      const next = randomSettingsAccent(current).key;
      expect(next).not.toBe(current);
      expect(["pink", "aqua", "papaya", "mint"]).toContain(next);
    }
  }
});
