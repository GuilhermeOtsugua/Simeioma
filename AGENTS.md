## Simeioma Development Guidance

Use TDD for Simeioma changes. Prefer one behavior test, one implementation
slice, then refactor after the suite is green.

## Debugging and Verification Strategy

Use the Tauri dev app as the default loop for interactive desktop debugging:

- `bun run tauri dev`

Frontend changes hot reload through Vite. Rust, Tauri config, permission, and
native command changes may require a slower shell rebuild/restart.

Before considering a change complete, run the deterministic checks:

- `bun run test`
- `bun run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`

Do not run browser interaction tests or visual QA by default. They are currently
non-authoritative for Simeioma because they do not correlate well with native
window focus, drag behavior, transparent windows, custom popups, or text
selection.

Build the production Windows executable only when a stable manual testing
artifact or release validation is useful:

- `bun run build:desktop:windows`

## Commit Messages

Use conventional commit prefixes such as `feat`, `fix`, `docs`, `test`,
`refactor`, `build`, and `chore`. Keep the subject around 50 characters.
