# Simeioma

Simeioma is a lightweight cross-platform desktop post-it app for short-lived
office notes, sketches, reminders, and quick capture.

The product goal is simple: a persistent colored strip on the desktop that can
create a focused note in less than a second, without turning quick thoughts into
heavy documents.

## Stack

- Tauri 2 for the native desktop shell and bundling
- Rust for filesystem, persistence, export, and window control
- Solid + TypeScript for the app interface
- Tailwind CSS for the styling system
- Bun for dependency management and scripts

## Product Direction

- Persistent note-colored launcher strip near a screen corner
- Hover expansion and instant note creation
- Floating draggable notes with title, body, color, and sketch surface
- Local-first autosave and session restore
- Bulk copy/download as text, Markdown, PNG, or JPEG
- Settings for export path, default copy behavior, and keybinds

## Performance Budget

- Cold startup to first usable note: under 1000ms
- Warm startup: under 400ms
- New note creation: under 100ms
- No network calls during startup
- Keep the frontend small and avoid heavy component libraries

## Development

Install dependencies:

```sh
bun install
```

Run the web frontend:

```sh
bun run dev
```

Run the desktop app:

```sh
bun run tauri dev
```

Build the frontend:

```sh
bun run build
```
