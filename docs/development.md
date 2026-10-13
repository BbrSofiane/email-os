# Slice 01 development guide

This repository currently implements **vertical slice 01 only** (see
`docs/vertical-slice-01.md`): a fixture inbox with 18 synthetic conversations,
a plain-text reader, keyboard navigation, and durable archive/unarchive with
restart recovery. There is no OAuth, Gmail, external mail, composer, drafts,
sending, attachments, or search in this slice. The SQLite store is seeded once
with synthetic conversations and hostile markup is treated as literal data.

## Layout

| Path | Owner |
|---|---|
| `crates/mail-core/` | Rust core: serde/ts-rs DTOs, SQLite store, seed fixture, serial cancellable worker, fake provider, profile lock |
| `src/`, `tests/`, `package.json`, configs | Vue 3/TS frontend: IPC seam (`src/lib/ipc/`), `useMailbox` composable, keyboard-first shell |
| `src/lib/ipc/generated.ts` | **Generated** — do not edit by hand; regenerate with `mise run gen:ts` |
| `src-tauri/` | Thin Tauri 2 shell: three commands, `mailbox_changed` event, worker lifecycle, restrictive CSP/capabilities |
| `mise.toml` | Project tasks (see below) |

## Tooling

All commands run through [mise](https://mise.jdx.dev) (pinned: node 24.4.1, pnpm 10.18.0, rust 1.89.0).
First-time setup:

```sh
mise trust           # after inspecting the repository's mise.toml
mise install         # install the project-pinned runtimes/tools
mise run install:ui   # locked frontend dependencies (pnpm install --frozen-lockfile)
```

Rust dependencies resolve via the committed `Cargo.lock` on first `cargo`/`mise` use;
no global configuration is needed.

## Validation gates

Core and frontend gates run independently of any native GTK/WebKit prerequisites:

| Task | What it does |
|---|---|
| `mise run check` | Everything below (core tests, contract check, core lint, UI tests, typecheck) |
| `mise run test:core` | `cargo test -p mail-core` — durability/ordering/concurrency tests, no network |
| `mise run check:contract` | Regenerates the TS wire contract to a temp file and **fails on drift** against `src/lib/ipc/generated.ts` |
| `mise run gen:ts` | Regenerates `src/lib/ipc/generated.ts` from the Rust DTOs (run after intentional DTO changes) |
| `mise run lint:core` | Workspace formatting + `clippy -D warnings` for mail-core |
| `mise run test:ui` | Vitest component/contract regressions, including delayed operations and query races |
| `mise run typecheck` | `vue-tsc --noEmit` |
| `mise run build:web` | Frontend production build to `dist/` |

Native shell tasks require the platform prerequisites below and fail with a
clear error when they are missing:

| Task | What it does |
|---|---|
| `mise run check:native` | Locked Cargo compile-check of the shell and its tests |
| `mise run test:native` | Native event-bridge lifecycle regression tests |
| `mise run dev:native` | `pnpm tauri dev` — serves the frontend and opens the native window |
| `mise run build:native` | `pnpm tauri build` — bundled native app |

## Running the app

**Browser preview (in-memory, not durable):** `mise run dev:web`, then open the
printed localhost URL. The page shows a disclosure banner: this mode uses a
labelled in-memory fake client — nothing is persisted, and core semantics are
only modeled for preview. It is not a claim about the native integration.

**Native shell (durable SQLite):** `mise run dev:native`. The native path uses
the real `mail-core` store bound to an app-specific profile directory
(`<app_data_dir>/fixture-profile`), never a user's mail. The fixture provider
mode is selected at launch via `EMAIL_OS_FAKE_PROVIDER=paused|reject|success`
(optional; default is immediate success). The profile lock rejects a second
app instance on the same profile (`profile_in_use`).

Closing the only window quits the app (no tray in this slice). Quitting stops
processing; queued/applying archive operations stay durable and are requeued
by startup recovery at the next launch. Worker halts (persistence failure) are
queryable via `MailCore::worker_error()` and keep commands failing closed.

## Native prerequisites

The Linux build of the Tauri shell needs the GTK/WebKitGTK development
packages and `pkg-config`, e.g. on Debian/Ubuntu:

```sh
sudo apt install pkg-config libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev
```

(Also linkable alternatives: `libsoup-3.0-dev`, `libjavascriptcoregtk-4.1-dev`
are pulled in as webkit2gtk dependencies; on macOS install Xcode command line
tools instead.) These were **not installed** in the current Linux VM —
`mise run check:native` fails at `glib-sys` with "The pkg-config command could
not be found" until they are present. macOS WKWebView/IME/keyboard behavior
also cannot be validated in a Linux VM; that remains an explicit open gate.

## Fixture nature

All data is synthetic (`fixture-account`, `conv-01`…`conv-18`), seeded exactly
once behind a seed marker. Restart never resets provider facts or operation
history. Subjects, addresses, and bodies are never logged. The fixture
provider is the only "provider"; there is no network code in the core.