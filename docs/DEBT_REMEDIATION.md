# Technical-debt remediation and QA

All twelve findings from the review at `a0af81a` have an implementation commit. Each commit followed regression checks. This pass does not authorize or perform a push; manual native QA comes first.

| Debt | Resolution | Commit |
| --- | --- | --- |
| 1 — cross-window persistence | Origin-wide Web Lock around fresh read, validated write and revision; no unlocked fallback; pending drafts retained | `6d60e89` |
| 2 — hydration/recovery | Versioned validation, legacy defaults, unknown-field preservation, original JSON recovery export and retry | `c9f7c4a` |
| 3 — task semantics | Canonical Markdown body and checkbox parsing across visible columns, reminders, list badges and exports; code fences excluded | `f53c6a3` |
| 4 — composition | Literal-source composition surface and range-scoped commit; neighboring Markdown and cancellation preserved | `147b90f` |
| 5 — native clipboard | Allocation-bounded UTF-16 decoding and scoped native resource cleanup | `68bdacc` |
| 6 — image export | Full source text, both columns and drawing regions; explicit size/encoding/save errors; fresh snapshots | `35df7b6` |
| 7 — application boundaries | 47-line router, separate window views and state/native/export services, dependency-direction tests | `a90ef2d` |
| 8 — lifecycle | Late subscription ownership, guarded callbacks/initialization and teardown; shared utility focus lifecycle | `14ecb08` |
| 9 — retired editor | Removed unused preview/selection modules and obsolete editor/animation CSS | `16a50df` |
| 10 — undo history | Combined 100-entry / 2 MiB budget, contiguous typing groups, separate composition steps and external-reset handling | `8e0bd3b` |
| 11 — redundant guards | Removed obsolete mid-transaction supersession checks; retained delayed-callback fencing | `68adb26` |
| 12 — regression gates | Windows CI, native behavior fixtures, persistence/error tests and diagnostic protocol parity | This document's implementation commit |

## Verification

- 113 frontend tests passed, plus TypeScript and production frontend build.
- 10 Rust tests passed; the local timing benchmark remains intentionally ignored.
- Debug and release Cargo checks passed.
- 26 isolated native checks passed, including two-WebView lock serialization, actual WebView2 composition-event persistence/undo/cancel, untouched corrupt-data recovery/retry, PNG export, geometry, utility reservations and diagnostics privacy.
- CI is configured, not claimed to have run remotely. Its optional native job requires a trusted interactive Windows runner with Rust/MSVC/WebView2 installed and the `simeioma-desktop` label. Fork pull requests never run that job.

Native fixture debugging corrected two invalid focus assumptions: right-click opens the launcher menu rather than toggling it, and synthetic menu clicks need the same native focus transition as a real click. No production focus checks were disabled.

## Manual QA before pushing

Use the normal standalone debug artifact at `src-tauri/target/debug/simeioma.exe`, not the isolated fixture executable. For a disposable session, explicitly choose the documented `SIMEIOMA_DEBUG_SESSION=clean` mode; normal saved notes are not automatically cleared. Back up important data before testing against a real session.

1. Edit different notes while moving/resizing them; toggle Settings, create/delete notes, reach the note limit, and restart. Verify text, geometry and settings persist together.
2. Open legacy notes with tasks/strikethrough. Toggle Markdown checkboxes in both columns; verify list task badges and task-targeted reminders. Fenced checkbox examples must not count as tasks.
3. Use a real OS IME, including candidate selection, commit/cancel and undo/redo next to formatted text. Synthetic composition events passed, but physical IME input was not exercised.
4. Export long, two-column notes with drawings to PNG/JPEG and Markdown/text. Image export is a complete-content document with visible source delimiters and a separate drawing region, not an exact screenshot. Check visual preferences against that documented contract.
5. Check cut/copy/paste, repeated window open/close, Settings/list focus and topmost behavior, native dragging and mixed-DPI transitions.
6. Preserve the existing edge-placement policy: edge-placed notes clone exactly; utilities do not cover notes or reposition an existing sibling.

Physical mixed-DPI dragging and final visual fidelity remain human checks. Current Zod dependency comments produce harmless Rollup annotation warnings; builds pass. No normal user session was mutated by the automated fixtures.
