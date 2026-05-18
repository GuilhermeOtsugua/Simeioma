import { chromium } from "playwright";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const reportDir = path.join(root, "visual-reports", "latest");
let baseUrl = "http://127.0.0.1:1420";
const storageKey = "simeioma:v1";

const now = new Date().toISOString();
const seededState = {
  notes: [
    {
      id: "visual-note-1",
      title: "Design QA",
      colorKey: "canary",
      important: true,
      lines: [
        { id: "line-1", text: "check small note bounds", task: true, crossed: false },
        { id: "line-2", text: "export screenshots", task: true, crossed: true },
        { id: "line-3", text: "@invoice-copy link target", task: false, crossed: false },
      ],
      createdAt: now,
      updatedAt: now,
      size: { width: 192, height: 192 },
      position: { x: 0, y: 0 },
    },
    {
      id: "invoice-copy",
      title: "Invoice copy",
      colorKey: "sky",
      important: false,
      lines: [{ id: "line-4", text: "Second seeded note", task: false, crossed: false }],
      createdAt: now,
      updatedAt: now,
      size: { width: 192, height: 192 },
      position: { x: 0, y: 0 },
    },
  ],
  launcher: { colorIndex: 0, corner: "bottom-right" },
  settings: {
    exportPath: "C:\\Users\\you\\Downloads",
    copyAfterSave: true,
    exportFormat: "markdown",
    strikeKeybind: "Ctrl + left click",
    scribbleKeybind: "Ctrl + right click",
    reminderMode: "minutes",
    reminderValue: "30",
    reminderTarget: "all",
    remindersEnabled: false,
  },
};

async function main() {
  await rm(reportDir, { recursive: true, force: true });
  await mkdir(reportDir, { recursive: true });

  const server = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });

  await server.listen();
  baseUrl = server.resolvedUrls?.local[0] ?? baseUrl;

  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "msedge", headless: true });
  const manifest = [];

  try {
    await captureLauncher(browser, manifest);
    await captureNote(browser, manifest);
    await captureSettings(browser, manifest);
  } finally {
    await browser.close();
    await server.close();
  }

  await writeFile(
    path.join(reportDir, "manifest.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), screenshots: manifest }, null, 2),
  );

  console.log(`Visual QA complete: ${reportDir}`);
  for (const item of manifest) {
    console.log(`- ${item.name}: ${item.file}`);
  }
}

async function captureLauncher(browser, manifest) {
  const page = await browser.newPage({ viewport: { width: 18, height: 96 }, deviceScaleFactor: 1 });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await screenshot(page, manifest, "launcher-collapsed-18x96");

  await page.setViewportSize({ width: 80, height: 120 });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.mouse.move(40, 60);
  await page.waitForTimeout(180);
  await screenshot(page, manifest, "launcher-hover-80x120");

  await page.setViewportSize({ width: 120, height: 220 });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.mouse.click(60, 110, { button: "right" });
  await page.waitForTimeout(220);
  await screenshot(page, manifest, "launcher-menu-120x220");

  const noteCount = await clickCreatesOneNote(page);
  manifest.push({ name: "launcher-click-create-note", file: null, assertion: `noteCount=${noteCount}` });
  await page.close();
}

async function captureNote(browser, manifest) {
  const page = await browser.newPage({ viewport: { width: 192, height: 192 }, deviceScaleFactor: 1 });
  await seedState(page);
  await page.goto(`${baseUrl}/index.html?role=note&id=visual-note-1`, { waitUntil: "networkidle" });
  await screenshot(page, manifest, "note-filled-192x192");

  await page.setViewportSize({ width: 256, height: 256 });
  await page.reload({ waitUntil: "networkidle" });
  await screenshot(page, manifest, "note-filled-256x256");
  await page.close();
}

async function captureSettings(browser, manifest) {
  const page = await browser.newPage({ viewport: { width: 380, height: 520 }, deviceScaleFactor: 1 });
  await seedState(page);
  await page.goto(`${baseUrl}/index.html?role=settings`, { waitUntil: "networkidle" });
  await screenshot(page, manifest, "settings-380x520");
  await page.close();
}

async function seedState(page) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(
    ({ key, state }) => {
      localStorage.setItem(key, JSON.stringify(state));
    },
    { key: storageKey, state: seededState },
  );
}

async function clickCreatesOneNote(page) {
  await page.evaluate((key) => localStorage.removeItem(key), storageKey);
  await page.reload({ waitUntil: "networkidle" });
  const viewport = page.viewportSize() ?? { width: 80, height: 120 };
  await page.mouse.click(viewport.width / 2, viewport.height / 2);
  await page.waitForTimeout(120);
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)).notes.length, storageKey);
}

async function screenshot(page, manifest, name) {
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(reportDir, file), fullPage: true });
  manifest.push({ name, file });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
