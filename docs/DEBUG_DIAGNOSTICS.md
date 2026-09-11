# Native debug diagnostics

## Build and launch

- `bun run tauri dev`: native debug shell + hot-reloading Vite frontend.
- `bun run build:desktop:debug`: standalone native debug executable embedding production frontend assets.
- Both normally produce `src-tauri/target/debug/simeioma.exe`; the most recent build determines whether Vite is needed.
- Exit the previous instance before launching another executable. Debug and release normally share the single-instance identity and normal saved state.
- To avoid overwriting a running executable, set `CARGO_TARGET_DIR` to an absolute alternative target directory before building.

Diagnostics are gated by Rust `cfg(debug_assertions)`, not `import.meta.env.DEV`. Release builds do not compile/register diagnostic commands, the bootstrap plugin, tray actions, panic recorder, injections, or smoke fixture. The frontend's diagnostic functions are dormant without the native bootstrap; spoofing the JavaScript flag does not create release backend commands. No new release capabilities are granted.

## Tray actions

The **Debug** submenu exists only in native debug builds:

- **Export diagnostic bundle**: requests fresh frontend snapshots from all current windows, captures native geometry, and writes `latest.json`. Prints the destination in the debug console.
- **Inspect last focused window** / **Inspect launcher**: open WebView2 DevTools. Inspecting can change focus and mask focus-related bugs; export passive evidence first. If the last focused window has closed, use Inspect launcher.
- **Toggle launcher resize delay (0 / 500 ms)**: slow subsequent launcher resizes. Current settings are printed in the console and included in exports.
- **Fail next launcher resize once**: deliberate one-shot failure before native `setSize`. The queue must still accept the next request.
- **Clear resize injections**: restore normal resize behavior. Controls reset on process restart and affect only launcher resizing.

An injected failure can deliberately leave an exit dialog clipped. Press Escape, clear injections, and reopen the menu/confirmation to recover. The maximum supported delay is 2000 ms.

## Inspect from DevTools

`window.__SIMEIOMA_DIAGNOSTICS__` is a frozen convenience interface:

```js
window.__SIMEIOMA_DIAGNOSTICS__.snapshot()     // read-only frontend/DOM summary
window.__SIMEIOMA_DIAGNOSTICS__.status()       // transport failures and dropped sends
await window.__SIMEIOMA_DIAGNOSTICS__.exportBundle() // returns the local bundle path
```

No state mutation API or remote debugging server is provided. Native inspection is in the exported bundle, not assumed to match a frontend snapshot atomically. DevTools itself can inspect arbitrary app data; the redaction policy below applies to diagnostic artifacts, not what a user deliberately inspects in DevTools.

## Evidence and storage

Windows default folder:

`%LOCALAPPDATA%/com.otsugua.simeioma/logs/diagnostics/`

Other platforms use Tauri's app log directory. No network transport, telemetry service, or upload action is present.

Retention is bounded:

- `events.jsonl` plus `events.1.jsonl` and `events.2.jsonl`: up to 1 MiB per file under the enforced payload limit.
- Latest 500 events in memory; latest frontend snapshot per live window (maximum 128 reporting windows).
- Latest 8 geometry/queue anomalies, each retaining frontend and native captures.
- A bounded background writer: up to 256 queued log records plus the in-flight write. Native event handlers use non-blocking submission; overflow is counted, not allowed to stall input.
- One export, `latest.json`, replaced on each successful export; at most one staging file, `latest.tmp.json`.
- Memory history starts fresh per process; rotating JSONL files can span sessions. Session IDs distinguish them.

Use the exported JSON directly for agent-assisted investigation. Note/window references are session-scoped pseudonyms, so persisted note membership can be matched to native windows without exporting note IDs.

### Event timeline

- Launcher state; drag start/native-return/end/failure for launcher, notes, and utility windows; queue accepted/started/completed/failed and stalled-operation warnings.
- Resize and positioning requests, operation IDs, and read-back native geometry.
- Utility spawn decisions: `utility-placement` includes the requested rectangle, `roleCode` (0 Settings, 1 Notes List), and `modeCode` (0 preferred row, 1 free-space reflow, 2 compact). `utility-placement-unavailable` records a no-room outcome without personal data.
- Native move/resize/focus/DPI/destruction; observed visibility commands and frontend visibility/focus.
- Frontend errors, rejected promises, resource errors, storage failures, observed native command failures, and native panic location line (no panic payload).
- State-save summaries, injections, snapshot/export events.

A session-global sequence reflects native recorder arrival order. Every record also has a native window `instance`, renewed when a label is reopened. Each renderer/instrumentation lifetime registers a numeric `rendererId`; client sequences and operation IDs must be interpreted within that lifetime. Registration rejects closed/replaced Windows handles; old instance/renderer reports are rejected and counted in `staleReports`. Reloads and reopened role labels can therefore be distinguished from dropped events.

Frontend `emittedAt`, client sequences, and operation IDs provide local ordering/correlation; do not assume IPC arrival order is causal order. Native move events are sampled at 100 ms, state-save events at 250 ms. No pointer-movement or key events are recorded. The frontend bounds outstanding sends at 100; the backend bounds each reporting window to 100 events/second. Counters expose transport failures, drops, and file-write failures.

Drag observation is a sidecar and never delays/retries the drag promise returned to the application. Native return is not treated as mouse release. After native return it samples button state and geometry at 100 ms intervals, reporting `drag-end` only after release and two unchanged comparisons (at least 200 ms of stability). Failure, replacement by another gesture, observation failure, and a 120-second timeout have distinct events. A timeout ends observation, not the native gesture. Post-drag and debounced native-movement snapshots include fresh native geometry and saved note geometry. Movement without a drag lifecycle is left unclassified—it may be an OS, keyboard, or programmatic move.

`commandId` values follow this order (zero-based): save text, save binary, visible note labels, set note visibility, restore utility, utility focus, raise control, mouse-button query, read clipboard, write clipboard. `errorKind` is zero-based Error, TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError, DOMException; -1 means another/unknown kind. No exception message or raw stack is exported.

### Snapshot contents

- Frontend: launcher menu/exit/drag/configuring flags, anchor, requested size, pending/running queue status and operation age; per-window drag ID and observation state.
- DOM: viewport, first dialog rectangle, clipping ancestor count, clipping result.
- Native: inner/outer size, position, visibility, focus, minimized/topmost flags, per-window current monitor and work area, available display geometry/DPI.
- Persistence: diagnostic write counter, note/important/uncrossed-task counts, pseudonymous note/window membership, and the current note's saved position/size for comparison with native geometry.
- Build: commit, dirty status, package/Tauri/WebView2 versions, OS and architecture.

DOM and frontend read-back geometry is in logical/CSS pixels. Native fields explicitly named `Physical` and native moved/resized events are physical pixels. Scale factors allow conversion. Monitor names, window titles, device identifiers, and machine/user names are omitted.

Schema-v2 exports wait approximately 750 ms for frontend replies, then at most 500 ms for a writer fence (plus IPC/scheduling/native reads and export I/O). `expectedWindows` identifies the requested native and renderer instances; only matching replies satisfy a request. Requested replies are retained separately so a routine focus/movement snapshot cannot overwrite them mid-export. Missing/stale responses are listed in `missingFrontendResponses`; cached snapshots retain capture time and identity. Native reads can return null if a window closes. Captures are **not atomic**, and the storage counter is not a transactional cross-window revision.

`writer` reports pending/submitted/written/dropped counts, I/O failures, worker liveness, and enqueue/write latency maxima. `writerFlushComplete` and `writerFlushThroughSequence` identify the export's drain boundary; check drops and I/O failures too—a successful fence does not imply every record was written successfully. New events can arrive after the fence. `recorderMaxMicros` measures producer work; `nativeHandlerMaxMicros` includes native recorder lock wait. Export disk writes occur outside the native recorder lock.

The synchronous DevTools `snapshot()` returns detached data with the most recently sampled native geometry and its timestamp. Export and settlement captures refresh native geometry; mutating console results cannot change live app anchors.

Clipping uses a 1px rounding tolerance and is suppressed during drag/configuration and recent movement. Other requested-versus-actual size/position or saved-note geometry inconsistencies must persist for 1 second after settlement before reporting. Queue operations busy for 5 seconds emit one `queue-stalled` anomaly per operation, unless a drag is active. A lightweight 500 ms watchdog checks active queues or pending mismatches; it does not continually query native geometry while idle. Known launcher clamping requests are recorded (`clamping: true`, operation ID 0), so intentional clamping is not mistaken for unexplained drift.

A new mismatch/stall preserves native + frontend evidence without opening DevTools, moving windows, or changing focus. Opening the export tray menu itself can change focus; preceding events and retained anomalies help preserve the original evidence.

## Preserve or start clean

Normal dev/debug launches no longer clear notes or force reminder/copy settings.

Opt into a clean test namespace in PowerShell:

```powershell
$env:SIMEIOMA_DEBUG_SESSION = 'clean'
.\src-tauri\target\debug\simeioma.exe
Remove-Item Env:SIMEIOMA_DEBUG_SESSION
```

The launcher clears only `simeioma:debug-clean:v1` and its diagnostic revision once per native session; HMR/reloads do not repeatedly clear it. Its BroadcastChannel is separate. Normal `simeioma:v1` data remains untouched. The application identity is still single-instance: exit the existing app first. This is storage isolation, not a separate OS sandbox; explicitly exporting files or using the clipboard still performs those requested actions.

## Tests

- `bun run test`: geometry/sliver detection, native debug gating, isolated storage lifecycle, injection bounds, transport failure isolation, command-error privacy, and serialized queue lifecycle/recovery.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: native allowlist redaction, rotating/bounded recording, unwritable-log fallback, and one-shot fault controls.
- `bun run test:diagnostics:native`: **opt-in**, focused native WebView2 smoke fixture. Builds into the dedicated `src-tauri/target/diagnostics-test` fixture directory, uses the distinct `com.otsugua.simeioma.diagnosticstest` identity and a clean namespace, briefly creates native windows, and exits its own process. It does not terminate the regular app.
- `cargo check --release --manifest-path src-tauri/Cargo.toml`: verifies the production configuration compiles without diagnostic modules/commands.

The smoke fixture opens confirmation in the real app, verifies 360px geometry, forces the original 64px native bounds, checks retained clipping evidence, exercises one-shot failure recovery and delayed resizing, verifies missing-response reporting, and checks that a sentinel secret submitted through real IPC is stripped from the export. It does not prove real mouse dragging, visual fidelity, or DevTools interaction. Its `latest.json` and `smoke-result.json` live under the test identity's log directory; runner output is bounded to `.tmp/diagnostics-smoke/{stdout,stderr}.log` (overwritten per run).

The smoke fixture also verifies a persistent non-dialog size mismatch, a deliberately stalled native resize response, reopened Settings instance identity, passive post-movement snapshots, saved-versus-native note geometry, stale-report rejection, and writer health. The 6.5-second stall is private to the guarded native fixture and cannot be armed through normal IPC/tray controls; normal user delay injection remains capped at 2 seconds. Drag state-machine tests cover held buttons, stability, failures, timeouts and teardown; actual physical dragging remains a manual validation step.

Spawn smoke checks also exercise repeated bounded notes, exact resized/off-screen source cloning through Ctrl+N, real tray/menu utility creation, minimized restore-bound reservation, reverse opening order, and compact utility size preservation. `smoke-result.json` includes the measured spawn rectangles and bottom limit. The runner deletes only the previous isolated result before launch and requires a fresh `passed: true` artifact in addition to process completion; Windows/Tauri may return zero even after `app.exit(1)`.

The fixture additionally checks literal-source composition, undo/redo and composition cancellation in WebView2; a deliberately yielding mutation lock shared by two real WebViews; corrupt-session recovery without rewriting the original payload; recovery retry; and a real complete-content PNG export through the launcher. Its synthetic export directory (`smoke-exports` under the test identity's log directory) is replaced each run. The assertion IPC accepts only bounded numeric case IDs and booleans, and is rejected outside the guarded isolated fixture. These event-driven checks do not simulate a physical OS IME candidate/composition session.

The drawing-continuity fixture holds the shared mutation lock for 1.5 seconds, completes a stroke through the real canvas handlers, and samples canvas ink across animation frames before the save can finish. It also starts a second stroke and triggers a state-channel refresh, verifying that active ink is not overwritten. Synthetic pointer capture is stubbed only for the fixture's non-OS pointer ID; rendering, persistence and state notifications remain real. This test failed before the pending-stroke fix.

The frontend/native event-name contract has a static regression test. It caught and fixed rejection of utility-placement events at the native allowlist.

The smoke environment switch is rejected unless both the exact test identity and clean-session mode are active. These smoke hooks are compiled out of release builds. Never use the isolated fixture executable as the normal manual-testing artifact.

An opt-in local producer benchmark is available with `cargo test --manifest-path src-tauri/Cargo.toml --lib measure_recorder_producer -- --ignored --nocapture`. It measures 500 submissions, draining outside timed sections to avoid queue overflow. Local measurements before/after the background writer were 254/17 microseconds median and 502/25 microseconds p95. These are local samples, not universal latency guarantees or CI performance thresholds.

## Privacy and failure behavior

The Rust boundary accepts only known event names, allowlisted numeric/boolean fields and structured subobjects. It rejects oversized payloads and strips unknown keys, note bodies/titles, clipboard contents, settings paths, raw exception text/stacks, and arbitrary strings. Raw note IDs are used only transiently to generate session-scoped pseudonyms. Exports stay local until explicitly shared.

Recorder failures do not intentionally block normal window operations: memory history survives disk-write errors; JavaScript transport failures are counted; queue observers cannot throw into the resize transaction. File I/O runs on the writer rather than native event handlers, but instrumentation still adds serialization/IPC/scheduling overhead and can affect timing. Abrupt exit can lose pending queued records; export before closing when evidence matters. It is a bounded diagnostic tool, not a crash-proof journal; abrupt process termination, early boot failures, or a failed/poisoned recorder can leave incomplete evidence. Inspect null fields, missing replies, and failure counters before drawing conclusions.
