import { beforeEach, expect, it, vi } from "vitest";
import { createInitialState, createNoteInState, type AppState } from "./simeiomaModel";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async (..._args: unknown[]) => {}), state: undefined as AppState | undefined }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("./diagnostics", () => ({ invokeObserved: mocks.invoke }));
vi.mock("./persistence", () => ({ updateState: async (fn: (state: AppState) => AppState) => fn(mocks.state!) }));
import { encodeCanvas, exportNote } from "./exports";
beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.state = createNoteInState(createInitialState(0), { id: "a", lineId: "l", now: "2026-09-09" }).state;
  mocks.state.settings.exportPath = "D:/isolated-export-test";
  mocks.state.settings.copyAfterSave = true;
});
it("fails explicitly when the canvas encoder cannot produce bytes", async () => {
  await expect(encodeCanvas({ toBlob: (done: BlobCallback) => done(null) } as HTMLCanvasElement, "png")).rejects.toThrow("encoding failed");
  await expect(encodeCanvas({ toBlob: (done: BlobCallback) => done(new Blob([])) } as HTMLCanvasElement, "png")).rejects.toThrow("encoding failed");
});
it("does not change clipboard when saving fails", async () => {
  mocks.invoke.mockRejectedValueOnce(new Error("save failed"));
  await expect(exportNote("a")).rejects.toThrow("save failed");
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke.mock.calls[0][0]).toBe("save_text_file");
});
it("exports a fresh snapshot then copies its complete Markdown", async () => {
  mocks.state!.notes[0].lines[0].text = "latest body";
  mocks.state!.notes[0].layout = "two-column"; mocks.state!.notes[0].rightText = "latest right";
  await exportNote("a");
  expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(["save_text_file", "write_clipboard_text"]);
  expect(mocks.invoke.mock.calls[1][1]).toEqual({ text: expect.stringContaining("latest right") });
});
