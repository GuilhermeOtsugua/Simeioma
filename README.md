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

Run the web frontend when you only need the Vite page:

```sh
bun run dev
```

Use the Tauri dev app as the default interactive debugging loop:

```sh
bun run tauri dev
```

This starts the Vite dev server and launches the native Tauri shell against it.
Frontend changes hot reload; Rust, Tauri config, permission, and native command
changes may trigger a slower shell rebuild/restart. This is the preferred way to
debug launcher behavior, transparent windows, custom popups, drag/focus issues,
and text selection before doing a production executable build.

Build the frontend:

```sh
bun run build
```

Build the Windows desktop executable for manual testing:

```sh
bun run build:desktop:windows
```

The production executable is written to:

```text
src-tauri/target/release/simeioma.exe
```

The Windows installer bundles are written to:

```text
src-tauri/target/release/bundle/msi/Simeioma_1.0.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Simeioma_1.0.0_x64-setup.exe
```

If the build fails with `Access is denied` while replacing `simeioma.exe`, close
Simeioma first or stop the running process before rebuilding:

```powershell
Get-Process simeioma -ErrorAction SilentlyContinue | Stop-Process -Force
bun run build:desktop:windows
```

## Debugging and Verification Strategy

Use the Tauri dev app as the default loop for interactive desktop debugging:

```sh
bun run tauri dev
```

Use deterministic checks before considering a change complete:

```sh
bun run test
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
```

These cover model behavior, frontend compilation, and Rust/Tauri compilation
without relying on browser interaction tests that do not accurately represent the
desktop app's native window, focus, drag, and selection behavior.

Build the Windows executable only when you need a fresh artifact for stable
manual desktop testing or release validation:

```sh
bun run build:desktop:windows
```

Manual testing is the source of truth for layout-sensitive desktop behavior,
especially launcher placement, transparent windows, drag behavior, custom popup
focus, and native text selection.

## License

Copyright (c) 2026 Guilherme Otsugua.

Simeioma is developed as an independent product and research project by Guilherme Otsugua.

Simeioma is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).

Commercial/proprietary licenses are available separately. If you want to use Simeioma or derivative work in a closed-source product, hosted service, bundled offering, or other proprietary context, see [COMMERCIAL.md](COMMERCIAL.md).

By contributing to this repository, you agree that your contributions are licensed under `AGPL-3.0-only` and may also be used by the project maintainer under separate commercial license terms. See [CONTRIBUTING.md](CONTRIBUTING.md).
