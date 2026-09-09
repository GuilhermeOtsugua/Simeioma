# Simeioma Testing And Behavior Plan

This document records the agreed testing strategy and the behavior intentions for the next Simeioma implementation pass.

## Testing Strategy

Simeioma should use three test layers.

Fast domain tests cover logic that does not need a browser or native Tauri process. This includes note limits, note spawn offsets, default settings, reminder eligibility, reminder counts, and development storage reset rules. These tests should run through Vitest and should stay independent from Solid components where possible.

Browser route tests are optional and non-authoritative for native focus, dragging, transparent windows, and popups. Do not run them by default; use the native app and focused smoke checks for these behaviors.

Native smoke checks cover Windows/Tauri behavior that browser tests cannot prove. This includes actual window creation, first-click activation behavior, right-click menu resizing, single-instance ownership, tray behavior, and close-to-tray behavior. These checks should stay small because native desktop automation is slower and more fragile.

Tauri WebDriver is not the first default. The immediate value comes from Vitest, Rust unit tests, and focused Windows smoke checks. `bun run test:diagnostics:native` runs an isolated opt-in WebView2 fixture covering popup geometry, diagnostic export, fault injection/recovery, and missing snapshot responses; it is not a broad visual QA suite.

## TDD Rule

Simeioma implementation should use vertical TDD slices. Each behavior starts with one failing test, followed by the smallest implementation that makes it pass. Tests should verify public behavior or public model functions, not private implementation details.

## Behavior Decisions

Dev/debug runs preserve the existing note session by default. `SIMEIOMA_DEBUG_SESSION=clean` opts into a separate storage namespace that starts fresh once per native session, without deleting normal notes or changing normal settings. Release builds ignore this debug-only mode. See [DEBUG_DIAGNOSTICS.md](DEBUG_DIAGNOSTICS.md).

Simeioma should be a single-instance desktop utility. Opening the app twice should not create two independent launcher strips. One process should own the launcher and tray surface.

The launcher strip should create a note on the first left click, including when the window was not previously focused. It should not require a double click.

The launcher strip should use `Ctrl + left click` to hide visible notes or, when no note window is visible, show all saved notes. The visibility change should feel like a fade where feasible.

The launcher list action should open a separate notes-list window, similar to the settings window. It must not reopen every stored or closed note.

A release launch begins with saved notes hidden. When no note is visible, the first newly created note uses the launcher-origin baseline size and position. Launcher creation stacks from the latest visible, non-minimized note; Ctrl+N retains the focused note as its anchor. Both paths sample live native position/size and share the same 41px downward offset and size inheritance.

The note bottom limit is the lowest resting-strip edge permitted by the launcher parking envelope: work-area bottom minus 12px minus half the difference between the 184px menu and 96px resting strip (56 logical pixels total). It is independent of whether the menu is currently expanded. If the next offset would cross that limit, overlay the source exactly. If the source is already outside any safe edge, preserve its exact position and dimensions—do not clamp, rescue, or move it. Existing notes/manual dragging are unaffected. New note and utility windows remain hidden until their final native position is applied, because Windows/Tao can otherwise substitute a default position for an off-monitor origin. Fresh spawns use rounded physical coordinates from the target monitor, avoiding ambiguous logical coordinates across mixed-DPI displays.

Settings and Notes List reserve distinct slots growing inward from the visible note footprint (or the default note slot): launcher → notes → list → Settings on the left, mirrored on the right. Align tops near the top of the launcher's current monitor, bottoms near its bottom, with 32px preferred gaps. Default sizes remain 434×548 and 320×440. Preserve already-open/manual geometry, including minimized restore bounds. On constrained displays, try other free positions, then narrower/minimum-size scrolling surfaces (280×300 minimum); if no non-overlapping arrangement fits, show a native notice without moving existing windows. Opening order must not change reserved slots, including compact layouts. Tray Settings requests use the same serialized creation path.

Native verification covers repeated bounded spawns, a partially off-screen resized source and keyboard clone, tray/menu utility creation, minimized reservation, reverse opening order, and compact size preservation. Pure tests cover both screenshot arrangements, compact fallback, and negative-coordinate/scaled work areas. Physical mixed-DPI monitor dragging and final visual preference remain manual checks.

Notes should be capped at ten total saved notes across sessions. Attempts to create more notes should do nothing visible and should not advance the launcher color cycle.

Notes should be draggable by holding left click anywhere inside the note. The exception is scribble mode, where holding left click is reserved for drawing. Text editing should remain possible, but drag initiation should be more forgiving than the current title/body-specific behavior.

The crossing-out animation should last about 0.3 seconds and should not shift layout.

JetBrains Mono should be the default font across the app, using different weights for hierarchy.

The settings close button must close the settings window reliably.

Reminders are enabled by default and use an hourly period by default. A note counts when it is important-marked or has uncrossed checkbox tasks. If matching notes remain unviewed for the selected period, an orange notification badge appears above the launcher strip. The badge should share the strip's width behavior and display a white number for the current unviewed count. Viewing relevant notes should decrease the count.

## Windows Lifecycle Terms

The desired Stremio, Steam, and Discord style behavior maps to these formal concepts:

- System tray app: an app that remains available from the Windows notification area.
- Notification area: the small icon area near the Windows clock.
- Tray icon: the app icon shown in the notification area.
- Tray menu or tray context menu: the right-click menu attached to the tray icon.
- Single-instance app: only one process owns the running app state.
- Close-to-tray: closing a visible window hides it or keeps the background app alive instead of quitting.
- Foreground window and background process: settings can be an active foreground window while the app continues running in the background.

## Technical Debt Review Focus

After behavior works, review for unnecessary complexity in launcher click handling, reminder state, duplicated window creation logic, route-specific surfaces, and CSS rules that patch visual artifacts without expressing a clear surface contract.
