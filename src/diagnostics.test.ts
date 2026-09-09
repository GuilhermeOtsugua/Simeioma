import { afterEach, expect, it, vi } from "vitest";
import { createInitialState } from "./simeiomaModel";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("sends no diagnostic requests without the native debug bootstrap", async () => {
  vi.stubGlobal("window", {});
  const diagnostics = await import("./diagnostics");
  diagnostics.recordDiagnostic("frontend-error", { text: "private" });
  await diagnostics.beforeDiagnosticResize(1);
  expect(diagnostics.diagnosticsEnabled).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});

it("does not let a failed diagnostics transport prevent a native resize", async () => {
  vi.stubGlobal("window", { __SIMEIOMA_DEBUG__: { cleanSession: false } });
  invoke.mockRejectedValue(new Error("private native failure"));
  const diagnostics = await import("./diagnostics");
  await expect(diagnostics.beforeDiagnosticResize(1)).resolves.toBeUndefined();
});

it("applies bounded debug delay and explicit injected failure", async () => {
  vi.stubGlobal("window", { __SIMEIOMA_DEBUG__: { cleanSession: false } });
  vi.useFakeTimers();
  invoke.mockResolvedValue({ delayMs: 9999, fail: true });
  const diagnostics = await import("./diagnostics");
  const resize = diagnostics.beforeDiagnosticResize(42);
  const assertion = expect(resize).rejects.toThrow("Injected launcher resize failure");
  await vi.advanceTimersByTimeAsync(2000);
  await assertion;
  expect(invoke).toHaveBeenCalledWith("debug_before_resize", { operationId: 42 });
});

it("registers once and includes both native and renderer identity on every report", async () => {
  vi.stubGlobal("window", { __SIMEIOMA_DEBUG__: { cleanSession: false } });
  invoke.mockImplementation((command: string) => Promise.resolve(command === "debug_register" ? 7 : undefined));
  const diagnostics = await import("./diagnostics");
  diagnostics.recordDiagnostic("frontend-ready");
  diagnostics.recordDiagnostic("frontend-focus");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(invoke.mock.calls.filter(([name]) => name === "debug_register")).toHaveLength(1);
  const records = invoke.mock.calls.filter(([name]) => name === "debug_record");
  expect(records).toHaveLength(2);
  expect(records[0][1].instanceId).toBe(7);
  expect(records[0][1].data.rendererId).toBeGreaterThan(0);
  expect(records[1][1].data.rendererId).toBe(records[0][1].data.rendererId);
  expect(records[1][1].data.clientSequence).toBe(2);
});

it("logs command identity but never arguments or raw errors", async () => {
  vi.stubGlobal("window", { __SIMEIOMA_DEBUG__: { cleanSession: false } });
  invoke.mockImplementation((command: string) => command === "debug_register" ? Promise.resolve(1) : command === "debug_record" ? Promise.resolve() : Promise.reject(new Error("private error")));
  const diagnostics = await import("./diagnostics");
  await expect(diagnostics.invokeObserved("write_clipboard_text", { text: "private clipboard" })).rejects.toThrow("private error");
  const record = invoke.mock.calls.find(([name]) => name === "debug_record");
  expect(record?.[1]).toMatchObject({ event: "native-command-failed", data: { commandId: 9 } });
  expect(JSON.stringify(record)).not.toContain("private");
});

it("exposes detached read-only snapshots and removes inspection hooks on cleanup", async () => {
  vi.useFakeTimers();
  const host = {
    __SIMEIOMA_DEBUG__: { cleanSession: false },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vi.stubGlobal("window", host);
  vi.stubGlobal("document", {
    documentElement: { clientWidth: 30, clientHeight: 112 },
    querySelector: () => null, hasFocus: () => true, visibilityState: "visible",
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  vi.mocked(getCurrentWindow).mockReturnValue({ onMoved: vi.fn().mockResolvedValue(vi.fn()) } as unknown as ReturnType<typeof getCurrentWindow>);
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = vi.fn();
  vi.mocked(listen).mockResolvedValue(unlisten);
  invoke.mockResolvedValue(undefined);
  const diagnostics = await import("./diagnostics");
  const anchor = { right: 12, bottom: 12 };
  diagnostics.setLauncherDiagnosticReader(() => ({ anchor }));
  const cleanup = diagnostics.startDiagnostics(() => createInitialState(0));
  const snapshot = window.__SIMEIOMA_DIAGNOSTICS__!.snapshot() as { launcher: { anchor: typeof anchor } };
  snapshot.launcher.anchor.right = 999;
  expect(anchor.right).toBe(12);
  await Promise.resolve();
  cleanup();
  expect(window.__SIMEIOMA_DIAGNOSTICS__).toBeUndefined();
  expect(unlisten).toHaveBeenCalledOnce();
});

it("clean sessions clear only their namespace once per native session", async () => {
  const storage = new Map([["simeioma:v1", "real notes"], ["simeioma:debug-clean:v1", "old test notes"]]);
  const session = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) });
  vi.stubGlobal("window", { __SIMEIOMA_DEBUG__: { cleanSession: true, session: "one" } });
  vi.stubGlobal("location", { search: "" });
  await import("./diagnostics");
  expect(storage.get("simeioma:v1")).toBe("real notes");
  expect(storage.has("simeioma:debug-clean:v1")).toBe(false);
  storage.set("simeioma:debug-clean:v1", "current test notes");
  vi.resetModules();
  await import("./diagnostics");
  expect(storage.get("simeioma:debug-clean:v1")).toBe("current test notes");
});
