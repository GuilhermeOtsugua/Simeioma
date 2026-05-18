# Simeioma Design Decisions

## Product Intent

Simeioma is a lightweight cross-platform desktop post-it app for short-lived office notes, quick tasks, sketches, reminders, and temporary working memory. It is optimized for people who need a fast place to put something now: designers, agency workers, operators, developers, support staff, and other office users moving between tasks.

The app should not feel like a document system, note database, or knowledge base. It should feel like a small physical object on the desktop: always available, low-friction, disposable when needed, and reliable enough that users trust it for the current work session.

## Platform And Stack

The planned stack is Tauri 2, Rust, Solid, TypeScript, Tailwind CSS, Bun, and Tauri Bundler. Tauri provides the native desktop shell, cross-platform windowing, filesystem access, notification integration, and packaging path without bundling a full browser runtime.

Rust owns native-side responsibilities: persistence, exports, filesystem paths, future scheduling support, app/window coordination, and OS integration. Solid owns the interface layer because it keeps the component model productive while remaining small enough for the performance target.

## Performance Principles

Sub-second startup is a core product constraint, not a later optimization. The app should avoid network calls on startup, avoid large UI libraries, avoid heavy editors unless proven necessary, and defer non-critical work until after the launcher strip is usable.

Performance targets are: cold startup to first usable note under 1000ms, warm startup under 400ms, new note creation under 100ms, and no visible typing or dragging jank. Future implementation should add explicit benchmarks so performance regressions are visible.

## Visual Design Language

Every visible UI element should use softened rounded geometry. The reference is close to iOS widget design, but slightly less rounded and less glossy. The app should feel tactile and friendly without becoming pill-shaped, toy-like, or overly decorative.

The visual language should rely on simple surfaces, careful spacing, quiet contrast, and thin outline details. Controls should look intentionally minimal and should avoid heavy fills, thick borders, sharp dividers, or generic SaaS dashboard styling.

## Shape And Radius

Rounded corners are a default primitive across notes, menus, settings, buttons, and notifications. The radius system should be restrained: small controls can use moderate rounding, notes can use larger soft corners, and the launcher strip can be more rounded where exposed.

The design should avoid harsh rectangular boxes. Any required grouping should feel like a soft object or compact native utility surface rather than a card-heavy web layout.

## Icon And Symbol Style

Icons and symbols should be outline-only, minimal, and small. The intended stroke language is similar to 1px to 2px website dividers: thin enough to feel precise, thick enough to remain legible on desktop displays.

The important-note star button is the baseline example: a simple outline star inside a simple outline circle. Default icons should avoid fill. Active states may use a slightly stronger stroke, subtle tint, or restrained fill only when it improves clarity.

## Launcher Strip

The app starts as a small vertical colored strip docked near a screen corner, initially bottom-right and slightly above the Windows taskbar, macOS dock, or Linux panel where possible. It remains visible until the user closes the app.

The visible strip is 3px wide and roughly two regular desktop icons tall, using 96px as the v1 baseline. It should read as a very thin post-it color tab rather than a full panel. On hover, it expands slightly horizontally to signal that it is interactive without taking meaningful screen space.

## Launcher Color Cycle

The launcher strip starts with a random color from a curated note color palette. The v1 palette uses classic sticky-note color families anchored by Post-it-style yellows: canary, classic yellow, pink, papaya, mint, aqua, sky, and lilac. Each color must have sufficient text contrast and a physical post-it feel.

Every left click creates a new note using the strip's current color, then advances the strip to the next palette color. Each click creates exactly one note for the color visible before the cycle advances.

## Launcher Interactions

Left clicking the strip creates a new floating note beside it. The new note inherits the current strip color and focuses the body immediately so the user can start typing or sketching without an additional click.

Holding left click on the strip moves the launcher. A quick left click still creates a note, so the implementation should distinguish click from drag with a short hold or movement threshold.

Right clicking the strip opens the compact launcher menu. `Ctrl + right click` toggles all open notes hidden or visible without opening the menu.

When focus leaves the launcher menu, such as by clicking elsewhere on the desktop or another app, the launcher should close the menu automatically. It should first return to the slightly inflated hover-width strip, then swiftly animate back to the base 3px strip so the collapse feels intentional rather than abrupt.

## Note Model

Each note has a title section, body section, color state, important/starred state, task state, optional sketch layer, position, size, creation timestamp, and updated timestamp. Notes are local-first objects and should be restorable after app restart unless explicitly deleted or cleared.

The default v1 note size is small: 192px by 192px, based on a 4 by 4 regular desktop icon footprint using 48px as the icon baseline. The body is the primary surface. The title is optional. If a note has no title, the system should derive display labels from the body slug or datetime when listing notes.

## Note Interactions

New notes open focused in the body. Clicking the title section allows the user to add or edit a title. Right-clicking the title section should expose color controls or note-level options.

The user can move a note freely by holding left click and dragging it. The drag behavior should feel direct and physical, avoiding window-manager friction where possible.

Hovering a note should have one main subtle visual effect: a small 1px divider fades in between the title area and the body area. The divider should not run edge to edge; it should have open margin on both left and right so the note does not feel blocky or harshly sectioned.

The divider should appear quickly but smoothly on hover or title/body focus. It should use opacity or transform-based animation so it does not shift layout.

## Important Notes

Important-marked notes are a first-class note filter. A note can be marked important by hovering the title section and clicking a star button revealed in that title area.

The star control should be discoverable but not visually noisy. Important state should persist and should be available to reminder filters and note-list filtering.

The star button should follow the icon language: very small, outline-only, and placed inside a thin outline circle. It should appear only when contextually useful, such as title hover, note hover, keyboard focus, or when the note is already marked important.

## Content And Formatting

The editor should support lightweight automatic formatting. Typing `-` should be able to create checkbox-style task items, and crossed-out task lines should remain distinguishable from active tasks.

GFM-inspired hooks are planned for common markdown behaviors such as lists, links, code, and emphasis. The app should prefer small parser hooks over a heavy rich-text editor until there is a clear reason to expand.

## Note Mentions

Typing `@` should eventually allow mentioning other notes and linking to them. The mention target should use the note title when available, then a body-derived slug, then datetime fallback.

Mention links should help short-lived session navigation without turning Simeioma into a full graph knowledge base. The feature should stay lightweight and local.

## Scribble Mode

Scribble mode allows drawing or sketching on a note with smoothing available. The default keybind is `Ctrl + right click`, and the mode is toggle-based by default.

Implementation should treat the sketch surface as a separate layer from text content. This keeps text export simple while allowing PNG and JPEG exports to include the visual note surface later.

## Strikethrough And Tasks

The default strikethrough interaction is `Ctrl + left click`. It should cross out the relevant line or task without forcing the user into selection/editing ceremony.

Uncrossed checkbox tasks are important to the reminder system. The app should be able to identify notes with active tasks so reminders can target only notes that still need action.

Crossing out a line should animate with a quick line-draw effect that completes in less than one second. The motion should start slowly and finish faster, using an ease-in style curve such as `ease-in` or a custom cubic-bezier with a slow beginning and faster ending.

The implementation should animate a line from left to right using transform-based scale rather than layout changes. It should respect reduced-motion preferences and leave a persistent crossed state once the animation finishes.

## Launcher Menu

Right clicking the launcher reveals four vertically distributed icon actions while preserving the strip identity. The launcher should expand from its central vertical axis, grow slightly wider and taller, and remain a slim command strip rather than becoming a card or panel.

The actions are: list current-session notes, bulk copy/download notes, open settings, and close the app. Buttons should be icon-only, circular, outline-led, and transparent by default. They need accessible labels and tooltips, but no visible descriptive text in the strip.

The close action should use a red accent with an `x` and require confirmation. The settings action opens a separate settings screen/window rather than rendering settings inside the strip.

## Session List

The session list shows all created notes in the current session. Each item should use the note color as its background color so notes remain visually identifiable.

Labels should resolve in this order: note title if available, body-derived slug if text exists, and datetime if neither title nor body is available. Right clicking a list item should expose save, copy, and delete actions.

## Bulk Export And Copy

Bulk actions can save or copy all relevant notes according to user preferences. Supported formats are text, Markdown, PNG, and JPEG.

Text and Markdown exports should prioritize clean content. PNG and JPEG exports should represent the visual note surface, including color and sketch layer when available.

## Settings

Settings include a file path input for bulk save/download location, an option to copy to clipboard by default after file creation, a format selector, and keybind inputs for strikethrough and scribble mode.

Settings also include reminder configuration: timing type, timing value, and target filter. Settings should persist locally and should not require account setup or network access.

The settings surface should look like a more minimal and simpler version of SuperWhisper's configuration dashboard. It should feel like a compact native utility panel rather than a web admin screen.

Settings layout should favor grouped preference rows, subtle dividers, compact labels, right-aligned controls, and restrained note-color accents. It should avoid oversized headings, heavy cards, marketing-style sections, and dense enterprise-dashboard patterns.

## Periodic Reminders

Periodic reminders appear as notifications above the vertical strip menu. They are local reminders intended to pull attention back to notes without becoming a separate calendar system.

Timing options are: every X minutes, hourly, specific time every hour, and specific date/time. Reminder schedules should persist across app restarts.

## Reminder Targeting

Reminder targets can be all notes, only important/starred notes, or only notes with uncrossed tasks. These filters make reminders useful without forcing users to configure a reminder per note.

Clicking a reminder should surface the relevant note or a filtered list of relevant notes. The final behavior can vary by target count, but the interaction should resolve quickly.

## Persistence

Simeioma should persist launcher position, current strip color/cycle state, note position, note size, note color, title, body, important state, task state, sketch data, reminder schedules, and settings.

Persistence should be local-first and crash-tolerant. Autosave should be debounced enough to avoid unnecessary writes but fast enough that users trust note changes are captured.

## Cross-Platform Considerations

Window positioning, always-on-top behavior, tray/menu behavior, global shortcuts, notifications, and panel/taskbar avoidance will differ across Windows, macOS, Linux, Wayland, and X11.

The product should define a high-quality Windows behavior first, then verify macOS and Linux behavior explicitly. Linux window placement and notification behavior should be treated as platform-sensitive rather than assumed.

## Deferred Decisions

The exact final visual design, final editor implementation, notification rendering strategy, persistence engine, and packaging/signing details are intentionally undecided.

These decisions should be made against the main constraints: fast startup, low memory, direct interaction, local-first behavior, and a product feel closer to physical post-its than a heavy notes application.
