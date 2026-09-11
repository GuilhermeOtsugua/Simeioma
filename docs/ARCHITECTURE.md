# Application boundaries

`App.tsx` bootstraps diagnostics/recovery and selects a window view. It owns no native window commands or state writers.

| Boundary | Responsibility |
| --- | --- |
| `windows/` | Launcher, note, Settings, list and text-menu presentation and their local interaction state |
| `stateCodec.ts` | Versioned hydration, validation and legacy defaults; never overwrite an unreadable session |
| `stateStore.ts`, `persistence.ts` | Origin-wide Web Lock, read/modify/write revision, persistence and post-commit notification |
| `noteMutations.ts`, `noteContent.ts` | Note changes and canonical Markdown/task interpretation |
| `noteWindows.ts`, `utilityWindows.ts` | Creation queues, existing-window reuse, visibility and utility reservations |
| `launcherNative.ts`, `windowSpawning.ts` | Native geometry transactions, creation completion and physical placement |
| `spawnPlacement.ts`, `windowGeometry.ts` | Pure placement and coordinate policies |
| `lifetime.ts`, `utilityLifecycle.ts` | Teardown, late subscription ownership, focus observation and guarded initialization |
| `exportModel.ts`, `exports.ts`, `clipboard.ts` | Complete-content export layout, encoding/save workflow and clipboard boundary |
| `MarkdownEditor.tsx`, `composition.ts`, `editorHistory.ts` | Editor DOM, range-scoped composition and bounded undo/redo |
| `sketch.ts`, `sketchDraft.ts` | Canvas rendering and pending ink reconciliation; stable stroke IDs prevent duplicate replay while saves settle |
| `reminders.ts` | Reminder eligibility, state mutation and window reveal |

Views may use services; services must not import views. `architecture.test.ts` enforces this direction for state/native services.

Persistent mutations must go through `updateState`/`transactState`, not raw storage writes. Their Web Lock covers the read as well as the write. Post-commit notifications are not part of the transaction. Export snapshots fence pending mutations through the same owner. Recovery exports the untouched original JSON; it does not silently reset it.

Native window tests remain distinct from browser tests. In particular, preserve hidden creation followed by rounded physical positioning, exact clones of deliberately edge-placed notes, full launcher transaction serialization and existing utility placement. These are verified platform contracts, not redundant defensive branches.

Drawing redraws combine persisted and pending strokes, and never replace an active stroke. Save acknowledgement retires only the submitted pending records. Failed saves retain visible ink for retry on the next stroke; closing the window still loses unsaved drafts. Bitmap load callbacks are invalidated when a newer render or stroke starts, so stale image loads cannot overwrite current ink.

## Export contract

Markdown and text exports contain complete source text and both visible columns. PNG/JPEG exports wrap that source without a six-line limit; Markdown delimiters remain visible rather than imitating the editor's preview. Drawings are replayed in a separately labeled region using the note canvas aspect ratio; image export is a complete-content document, not a screenshot of overlapping text/sketch layers. Legacy bitmap drawings are included. Text formats do not encode drawings.

Image exports exceeding 720 × 22,000 pixels are rejected with an error rather than silently truncated. Unsupported/undecodable drawings, missing canvas contexts, failed encoding and save failures are explicit. Clipboard-after-save runs only after the save succeeds.
