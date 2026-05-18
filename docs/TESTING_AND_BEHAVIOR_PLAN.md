# Simeioma Testing And Behavior Plan

This document records the agreed testing strategy and the behavior intentions for the next Simeioma implementation pass.

## Testing Strategy

Simeioma should use three test layers.

Fast domain tests cover logic that does not need a browser or native Tauri process. This includes note limits, note spawn offsets, default settings, reminder eligibility, reminder counts, and development storage reset rules. These tests should run through Vitest and should stay independent from Solid components where possible.

Browser route tests cover user-visible webview behavior. These tests should use Playwright against the Vite app routes and verify behavior through public UI controls: launcher clicks, settings fields, note list behavior, button behavior, and route rendering.

Native smoke checks cover Windows/Tauri behavior that browser tests cannot prove. This includes actual window creation, first-click activation behavior, right-click menu resizing, single-instance ownership, tray behavior, and close-to-tray behavior. These checks should stay small because native desktop automation is slower and more fragile.

Tauri WebDriver is not the first default. It may be useful later, but the immediate value comes from Vitest, Playwright route tests, and focused Windows smoke checks.

## TDD Rule

Simeioma implementation should use vertical TDD slices. Each behavior starts with one failing test, followed by the smallest implementation that makes it pass. Tests should verify public behavior or public model functions, not private implementation details.

## Behavior Decisions

Every new dev/debug run should start from a clean note session. This is temporary development behavior to keep visual and native debugging reliable. The reset should remove notes without destroying the shape of settings and launcher state.

Simeioma should be a single-instance desktop utility. Opening the app twice should not create two independent launcher strips. One process should own the launcher and tray surface.

The launcher strip should create a note on the first left click, including when the window was not previously focused. It should not require a double click.

The launcher strip should use `Ctrl + left click` to hide or show all open notes. The visibility change should feel like a fade where feasible.

The launcher list action should open a separate notes-list window, similar to the settings window. It must not reopen every stored or closed note.

Creating multiple notes should produce a visible stack. Each subsequent note should be offset from the previous note by a small horizontal amount and by one note title-section height vertically.

Notes should be capped at ten total notes in the current session. Attempts to create more notes should do nothing visible and should not advance the launcher color cycle.

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
