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
  await page.getByLabel("Timing").selectOption("minutes");
  await page.getByLabel("Value").fill("15");
  await page.getByLabel("Target").selectOption("tasks");

  const settings = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").settings, storageKey);

  expect(settings.exportPath).toBe("C:\\Users\\guilherme\\Desktop\\notes");
  expect(settings.exportFormat).toBe("txt");
  expect(settings.remindersEnabled).toBe(false);
  expect(settings.reminderMode).toBe("minutes");
  expect(settings.reminderValue).toBe("15");
  expect(settings.reminderTarget).toBe("tasks");
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
