import { expect, test } from "@playwright/test";

const storageKey = "simeioma:v1";

test("single launcher click creates exactly one note in browser mode", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Create note").click();

  await expect.poll(() => noteCount(page)).toBe(1);
});

test("session notes list route shows stored notes without reopening them", async ({ page }) => {
  await seedState(page, {
    notes: [
      testNote({ id: "a", title: "Design pass", colorKey: "canary" }),
      testNote({ id: "b", title: "", colorKey: "mint", lines: [{ id: "b-line", text: "Call client", task: true, crossed: false }] }),
    ],
  });

  await page.goto("/?role=list");

  await expect(page.getByText("Simeioma Notes")).toBeVisible();
  await expect(page.getByText("Design pass")).toBeVisible();
  await expect(page.getByText("call-client")).toBeVisible();
  await expect(page.locator(".note-shell")).toHaveCount(0);
});

test("settings fields persist to local storage", async ({ page }) => {
  await page.goto("/?role=settings");

  await page.getByLabel("Save path").fill("C:\\Users\\guilherme\\Desktop\\notes");
  await page.getByLabel("Format").selectOption("txt");
  await page.getByLabel("Reminders").uncheck();
  await page.getByRole("button", { name: "Periodic" }).click();
  await page.getByLabel("Periodic hours").fill("0030");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Time of day" }).click();
  await page.getByLabel("Time of day").fill("0930");
  await page.keyboard.press("Enter");
  await page.getByLabel("Target").selectOption("tasks");

  const settings = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").settings, storageKey);

  expect(settings.exportPath).toBe("C:\\Users\\guilherme\\Desktop\\notes");
  expect(settings.exportFormat).toBe("txt");
  expect(settings.remindersEnabled).toBe(false);
  expect(settings.reminderMode).toBe("timeOfDay");
  expect(settings.reminderValue).toBe("09:30");
  expect(settings.reminderTarget).toBe("tasks");
});

test("keybind fields capture released combinations", async ({ page }) => {
  await page.goto("/?role=settings");

  await page.getByRole("button", { name: "Cross out keybind" }).click();
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyX");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");

  const settings = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").settings, storageKey);
  expect(settings.strikeKeybind).toBe("Ctrl + Shift + X");
});

test("right clicking settings controls resets them to defaults", async ({ page }) => {
  await page.goto("/?role=settings");

  await page.getByLabel("Format").selectOption("txt");
  await page.getByLabel("Format").click({ button: "right" });
  await page.getByRole("button", { name: "Cross out keybind" }).click();
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyX");
  await page.keyboard.up("Control");
  await page.getByRole("button", { name: "Cross out keybind" }).click({ button: "right" });

  const settings = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").settings, storageKey);
  expect(settings.exportFormat).toBe("markdown");
  expect(settings.strikeKeybind).toBe("Ctrl + left click");
});

test("timing inputs use masked hour-minute entry", async ({ page }) => {
  await page.goto("/?role=settings");

  await page.getByRole("button", { name: "Periodic" }).click();
  const periodic = page.getByLabel("Periodic hours");
  await periodic.fill("0130");
  await expect(periodic).toHaveValue("01:30");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: "Time of day" }).click();
  const timeOfDay = page.getByLabel("Time of day");
  await timeOfDay.fill("1345");
  await expect(timeOfDay).toHaveValue("13:45");
  await page.keyboard.press("Enter");

  const settings = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").settings, storageKey);
  expect(settings.reminderMode).toBe("timeOfDay");
  expect(settings.reminderValue).toBe("13:45");
});

test("note body accepts continuous typing without losing focus", async ({ page }) => {
  await seedState(page, {
    notes: [testNote({ id: "typing-note", lines: [{ id: "typing-line", text: "", task: false, crossed: false }] })],
  });

  await page.goto("/?role=note&id=typing-note");
  const editor = page.getByLabel("Note line").first();
  await editor.fill("Review the client brief");

  await expect(editor).toHaveValue("Review the client brief");
  const note = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").notes[0], storageKey);
  expect(note.lines[0].text).toBe("Review the client brief");
});

test("normal body typing keeps focus after each character", async ({ page }) => {
  await seedState(page, {
    notes: [testNote({ id: "focus-note", lines: [{ id: "focus-line", text: "", task: false, crossed: false }] })],
  });

  await page.goto("/?role=note&id=focus-note");
  const editor = page.getByLabel("Note line").first();
  await editor.focus();

  for (const character of "abc") {
    await page.keyboard.type(character);
    await expect(editor).toBeFocused();
  }

  await expect(editor).toHaveValue("abc");
});

test("note body undo survives blurring to preview", async ({ page }) => {
  await seedState(page, {
    notes: [testNote({ id: "undo-note", lines: [{ id: "undo-line", text: "", task: false, crossed: false }] })],
  });

  await page.goto("/?role=note&id=undo-note");
  const editor = page.getByLabel("Note line").first();
  await editor.focus();
  await page.keyboard.type("Undo me");

  await page.locator(".note-title-input").click();
  await page.locator(".note-body-preview").click();
  for (const _ of "Undo me") {
    await page.keyboard.press("Control+Z");
  }

  await expect(editor).toHaveValue("");
});

async function noteCount(page: import("@playwright/test").Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{\"notes\":[]}").notes.length, storageKey);
}

async function seedState(page: import("@playwright/test").Page, patch: Record<string, unknown>) {
  await page.goto("/");
  await page.evaluate(
    ([key, value]) => {
      const current = JSON.parse(localStorage.getItem(key as string) ?? "{}");
      localStorage.setItem(key as string, JSON.stringify({ ...current, ...(value as object) }));
    },
    [storageKey, patch],
  );
}

function testNote(patch: Record<string, unknown>) {
  return {
    id: "note",
    title: "",
    colorKey: "canary",
    important: false,
    lines: [{ id: "line", text: "", task: false, crossed: false }],
    createdAt: "2026-05-18T12:00:00.000Z",
    updatedAt: "2026-05-18T12:00:00.000Z",
    viewedAt: "2026-05-18T12:00:00.000Z",
    ...patch,
  };
}
