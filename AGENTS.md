## Simeioma Development Guidance

Use TDD for Simeioma changes. Prefer one behavior test, one implementation
slice, then refactor after the suite is green.

## Test Cost Strategy

Default to the fast loop during implementation:

- `bun run test`
- `bun run test:ui`
- `bun run build`

Run native checks when the change touches Tauri, Rust, permissions, bundling, or
desktop-only window behavior:

- `cargo check --manifest-path src-tauri/Cargo.toml`
- `bun run build:desktop:windows`

Reserve visual QA and production executable smoke tests for changes involving
transparent windows, launcher placement, drag/resize behavior, focus handling,
or other native rendering details.

## Commit Messages

Use conventional commit prefixes such as `feat`, `fix`, `docs`, `test`,
`refactor`, `build`, and `chore`. Keep the subject around 50 characters.
