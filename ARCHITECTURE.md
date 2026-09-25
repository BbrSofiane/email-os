# Architecture: proposed implementation for the first build

**Status:** proposed implementation plan. This document describes a **designed, not yet
implemented or tested** system. It contains no claims about working code.

- **Governing scope:** [ADR 0001: first desktop build](docs/adr/0001-single-account-desktop-email-client.md)
  (accepted). The ADR defines *what* the first build does; this document proposes *how*.
- **Long-term direction:** [PRD](PRD.md). The PRD's composable-platform vision is not first-build scope.
- **Selected by the user (this decision stands):** Tauri 2 desktop shell with a Vue 3 frontend,
  implemented greenfield-first as a modular monolith. Fork-versus-greenfield was evaluated; this
  architecture assumes greenfield reuse of *patterns*, not of reviewed fork code.
- **Proposed, to confirm before implementation:** macOS as the first desktop target, Gmail REST as
  the first provider, and all exact dependency choices and versions below.
- **Historical research background:** [README](README.md) (candidate comparison, security reviews).
  The static reviews of [JakubSzwajka/email](security/email-review.md) and
  [Pebble](security/pebble-review.md) remain inputs to safety gates, not reusable foundations.

## 1. Selected and open decisions

| Decision | Status |
|---|---|
| Single-account desktop client scope (read/reply/archive/search/one view) | **Selected** — ADR 0001 |
| Tauri 2 + Vue 3 + TypeScript frontend | **Selected** by the user |
| Greenfield build (no fork of reviewed candidates) | **Selected** direction; final call at scaffolding |
| macOS first | Proposed, confirm before implementation |
| Gmail REST as first provider | Proposed, confirm before implementation |
| Exact crate/npm dependencies and versions | Not yet approved; choose at scaffolding |
| `tauri-specta` for TS IPC generation | Evaluate at scaffolding; compatibility/version not claimed here |
| SQLite library (e.g. `rusqlite` vs alternatives) | Not prescribed here; evaluate at scaffolding |
| Android, multi-account, plugins, AI/automation | Out of scope for first build (ADR 0001) |

Everything below is a recommendation to validate in the staged build (§9), not a claim that it works.

## 2. Architectural overview

```text
┌──────────────────────────────────────────────────────────────┐
│ Vue 3 + TypeScript app (trusted frontend)                     │
│  features (inbox, conversation, composer, search, views…)     │
│  talks ONLY to:                                               │
│   • typed commands/queries (generated TS contracts)           │
│   • TanStack Query cache  • action registry                   │
└──────────────┬───────────────────────────────────────────────┘
               │ narrow typed Tauri IPC (no raw SQL/HTTP/FS/execute)
┌──────────────▼───────────────────────────────────────────────┐
│ Thin Tauri 2 shell (Rust)                                     │
│  commands.rs (thin forwarding), events.rs, lifecycle.rs       │
│  capabilities restrict what any webview may invoke            │
└──────────────┬───────────────────────────────────────────────┘
               │ in-process calls
┌──────────────▼───────────────────────────────────────────────┐
│ mail-core crate (headless Rust, zero Tauri dependency)        │
│  domain · queries · commands · sync · operations · views      │
│  storage (SQLite, Rust-only) · provider/gmail · ports         │
│  Tokio async runtime; sync coordinator; durable op staging    │
└───────┬──────────────┬───────────────────┬────────────────────┘
        │              │                   │
   SQLite DB     OS keychain        Gmail REST API
   (cached facts, (tokens/secrets)   (authoritative provider
    pending intent,                   state; accessed only
    drafts, views, op history)        by mail-core)
```

Principles:

1. **One headless core.** `mail-core` is a plain Rust crate with no Tauri dependency. All mail
   logic, provider access, persistence, and scheduling live there. The Tauri shell is a thin
   adapter, not a business-logic home. This keeps core logic testable without a webview.
2. **No unnecessary splits.** One application crate plus one core crate (a root Cargo workspace
   connecting them is proposed). No multi-crate decomposition, public SDK, or
   provider-generalization layer beyond what the first build needs.
3. **Narrow IPC only.** The frontend can call named, typed commands. Raw SQL, arbitrary HTTP,
   filesystem access, and generic `execute` are never exposed to the frontend.
4. **SQLite is Rust-only.** The frontend never touches the database directly; there is no SQL
   plugin surface. (If FTS-style local search is added later, verify the bundled SQLite build
   actually supports it — do not assume, per the [README research](README.md).)

## 3. Proposed source tree

```text
src/                        # Vue 3 + TS frontend (Vite)
  app/                      # app shell, layout, composition root
  features/
    inbox/                  # list, keyboard navigation
    conversation/           # reader, plain-text rendering
    composer/               # reply/reply-all/new message, drafts, attachments
    search/                 # provider/cached search with coverage disclosure
    saved-views/            # the one configurable view (declarative filter)
    account/                # connect/disconnect, sync status
  commands/                 # action registry shared by buttons, shortcuts, palette
    registry.ts
    useKeyboardCommands.ts
  components/               # shared presentational components
  lib/
    ipc/                    # generated typed command/event bindings
    queries/                # TanStack Query keys, fetchers, invalidation wiring

src-tauri/                  # thin Tauri 2 shell
  src/
    lib.rs                  # composition root: wires core into command handlers
    commands.rs             # thin IPC forwarding — no business logic
    events.rs               # typed events emitted to the frontend
    lifecycle.rs            # startup, shutdown, hide-vs-quit behavior
  capabilities/             # per-window capability files
  config/                   # app config (no secrets here)

crates/mail-core/
  src/
    domain/                 # conversation, message, draft, view, operation types
    queries/                # read models served from SQLite
    commands/               # mutation entry points with validation + receipts
    sync/                   # sync coordinator, cursors, backoff
    operations/             # durable operation staging, reconciliation
    views/                  # declarative view evaluation
    storage/                # SQLite access (migrations, repositories)
    provider/
      gmail/                # Gmail REST adapter (proposed first provider)
    ports/                  # trait seams: Provider, Clock, Secrets, etc.
  migrations/
  tests/

tests/
  fixtures/                 # redacted synthetic fixtures only

Cargo.toml                  # root workspace (proposed) connecting core and shell
```

Frontend style: `<script setup>` single-file components; `ref`s and composables for local UI state;
[TanStack Vue Query](https://tanstack.com/query/latest/docs/framework/vue/overview) for cached
backend state. **No giant mailbox store:** Pinia is added only if genuine shared UI state emerges,
and Vue Router only if a real routing need appears. No Nuxt, no SSR, no server component.

Frontend testing: [Vitest](https://vitest.dev/) +
[Vue Test Utils](https://test-utils.vuejs.org/), with browser integration tests that stub the IPC
layer with fakes. Packaged-Tauri integration tests come later (§9); they are a different trust level.

## 4. State ownership

Four kinds of state with distinct owners. Blur between them is the main source of the defects found
in the [security reviews](security/email-review.md) (e.g. lost queued sends, replayed operations).

| State | Owner | Durable? | Notes |
|---|---|---|---|
| Provider mail state (read, labels, message existence) | **Provider** | Yes (remote) | Rust/SQLite holds a *cached copy* of provider facts, separately labeled as cached |
| Pending local intent (staged archive/read/send, drafts, views, operation history) | **Rust/SQLite** | Yes (local) | Survives restart; reconciled against the provider |
| UI state (focus, selection, transient editor buffers, UI preferences) | **Frontend** | Mostly no | Not a source of truth for anything the user would lose |
| Query cache (TanStack Query) | **Frontend, ephemeral** | No | Rebuilt from core queries after restart or invalidation; never treated as durable |

Rules that follow:

- UI-visible events from the backend are **hints, not durable truth**. On startup and reconnect the
  frontend refetches through queries; missed events are recovered by that refetch, not by replaying
  an in-memory log.
- The query cache is never the authority for sent/pending/failed state; `list_operations` (§5) is.
- Provider refreshes must not erase pending local intent: a locally staged action stays pending
  until reconciled, even if the sync coordinator sees conflicting provider state.
- **Drafts and saved views are initially local-only.** This limitation is disclosed in the UI
  (per ADR 0001); cross-device/provider draft sync is not promised.
- Account-scoped identities are used in the data model and storage keys even though the first UI
  supports one account. This is a cheap structural constraint, not multi-account support.

## 5. Typed IPC surface

The frontend boundary is a small, closed set of typed queries and commands. Contracts are generated
TypeScript from Rust types (evaluate `tauri-specta` at scaffolding; its compatibility with the chosen
Tauri version is not claimed here). IDs crossing the boundary are opaque strings, not SQL keys.

**Queries (read):**

| Query | Purpose |
|---|---|
| `list_conversations(view, cursor)` | Paginated conversations for the inbox or a saved view |
| `get_conversation(id)` | Cached conversation with messages and thread context |
| `search_conversations(query)` | Search; response discloses provider vs cached coverage |
| `get_draft(id)` | Draft with current revision |
| `list_operations()` | Operation history/status: pending, submitted, applied, failed, outcome_unknown |

**Commands (mutate):**

| Command | Purpose |
|---|---|
| `set_archived(id, bool)` | Stage an archive/unarchive operation |
| `set_read(id, bool)` | Stage a read/unread operation |
| `save_draft(id, expected_revision, content)` | Revision-checked draft save |
| `submit_draft(id, expected_revision, request_id)` | Stage a send |
| `save_view(definition)` | Store the one declarative saved view |
| `request_sync()` | Ask the coordinator to run a catch-up now |

Cross-cutting contract rules:

- **Typed errors.** Every failure mode the UI must handle has a distinct error variant; no stringly
  typed failures across IPC.
- **Receipts.** Mutating commands return a receipt identifying the persisted operation, so the UI
  correlates its optimistic state with the durable record.
- **Optimistic updates** derive from receipts + `list_operations`, never from the query cache alone.
- **Action registry.** Buttons, keyboard shortcuts, and the command palette invoke the same registry
  entries — one place defines what an action exists, its label, and its shortcut.
- **No dangerous primitives.** No raw-SQL, arbitrary-HTTP, filesystem, or generic-execute commands
  are registered. A compromised frontend can reach only these typed operations (see §8 for why the
  capability system does not by itself make this safe).

## 6. Durable operation staging and send semantics

### Staging pattern

1. A command runs **in a database transaction**: it persists the requested action plus the local
   pending state (e.g. conversation marked pending-archive) and returns a receipt.
2. The UI is **ACKed with the persisted receipt** — its optimistic state is now backed by durable
   state that survives restart.
3. A background worker calls the provider **outside** the transaction.
4. The worker reconciles the outcome, persists the operation status, and emits an invalidation event
   so the frontend refetches affected queries.

### Sending

This is the highest-risk surface; the reviews found real defects here (concurrent replay, unknown
outcomes auto-resubmitted, memory-only accepted sends — see [email review](security/email-review.md)
F1–F5).

- Before dispatch, a **complete immutable send snapshot** (recipients, subject, body, attachment
  references) is persisted. Dispatch uses the snapshot, not live editor state.
- A **local request key** deduplicates submission and gives one operation record single ownership of
  a send. The local key is **not** provider exactly-once semantics: the provider may still receive a
  duplicate after an ambiguous crash, so dedup is a local consistency mechanism, not a guarantee.
- On timeout, crash, or any **ambiguous outcome**: the operation enters an explicit
  `outcome_unknown` state. It is **never blindly retried**. Reconciliation (e.g. checking the
  provider's sent state) or explicit manual resolution decides the final state.
- Restarts **recover staged operations** into their pending/unknown state; they do not replay sends.

### Drafts and attachments

- Draft autosaves are **revisioned**; `save_draft` and `submit_draft` carry an
  `expected_revision` and reject stale writes.
- The send path waits for the **latest acknowledged draft save** to be persisted before dispatch.
- The composer shows explicit states: saving / saved locally / failed — never silently optimistic.
- **Attachment contents the user adds are persisted in app-owned storage before send is possible**;
  no dangling temporary paths in persisted snapshots. Attachment pick/save are explicit operations
  with size/type limits and failures surfaced, per ADR 0001.

### Concurrency

Database work runs off the UI thread: serialized writes, short transactions, and **no network calls
inside a DB transaction**. The concrete SQLite library is a scaffolding decision; this document does
not prescribe an unvalidated choice.

## 7. Sync coordinator

A single-account sync coordinator runs **independently of Vue component lifecycle** while the app is
running (a Tokio task owned by the shell/core, not a `useEffect`-style subscription).

- **Initial inbox discovery** (bounded, resumable) plus **on-demand body fetch** for opened
  conversations; full mailbox coverage is not required by ADR 0001.
- **Incremental catch-up** on reconnect and timer, with a **cursor checkpointed together with the
  applied data** so a crash cannot advance the cursor past unapplied changes (compare
  [email review](security/email-review.md) F6).
- **Cursor invalidation/recovery:** if incremental state is lost or inconsistent, fall back to a
  bounded rediscovery rather than silently skipping messages.
- **Backoff and cancellation** for rate limits, auth failures, and shutdown.
- **External-client changes** are treated as provider truth; pending local intent survives refresh
  and is reconciled, not overwritten (§4).
- **Search:** provider-backed search for historical mail is acceptable per ADR 0001, and every
  search/view surface **discloses its coverage** (provider mailbox vs cached data vs thread context).

**Hide vs quit:** synchronization is guaranteed only while the process runs. Hide-to-tray keeps the
coordinator alive; quitting stops it. This is documented in the UI, not silently assumed. There is
**no guarantee of sync or send while fully quit** (ADR 0001; see the
[README research](README.md) on Tauri async-task limits).

## 8. Security boundaries

### Rendering

- **Plain-text rendering first:** message content is displayed as escaped text.
- **No raw email HTML in the privileged app DOM.** No active content (scripts, forms, iframes) and
  **no automatic remote-resource loading** in the app webview.
- Future HTML rendering is a **separate isolation/sanitization project** (dedicated restricted
  webview, sanitizer, CSP, explicit remote-image policy) — explicitly out of scope until the
  plain-text build is validated. An iframe alone is **not** the security boundary (platform limits
  differ; see the [Pebble review](security/pebble-review.md) and [README research](README.md)).

### Secrets and OAuth

- Tokens and secrets live in the **OS keychain behind a `Secrets` port interface** — never in
  frontend storage, plain config, or the database.
- **OAuth/token custody is in Rust.** Authorization-code flow with PKCE in the **system browser**,
  with random state and strict redirect/issuer validation (pattern validated in
  [email review](security/email-review.md); still a to-be-implemented design here).
- **No credentials or mail bodies in logs.** All token-bearing types get redacted `Debug`
  implementations by default, not as an afterthought.

### Tauri capabilities — an important nuance

Capabilities restrict which **native/plugin APIs** a webview may use and, with the right setup, which
**application commands** it may invoke. Per the official
[Tauri 2 capabilities documentation](https://v2.tauri.app/security/capabilities/), application
commands registered via `invoke_handler` are **available to all windows/webviews by default unless
constrained** — the shell must additionally restrict the app-command set (e.g. via
`tauri_build::AppManifest::commands`) together with per-window capability permissions. **Do not
assume default-deny for app commands without this setup.** Capabilities constrain the attack surface;
they are **not a sanitizer** and do not make hostile HTML safe.

### Other boundaries

- External links are validated and opened through an explicit external handler.
- Attachment save paths are validated; sender-controlled filenames never write outside an approved
  directory (compare [email review](security/email-review.md) R3).
- The frontend has no secrets and no way to bypass the command set; still, a compromised frontend
  could invoke the allowed commands (as the reviews note) — the command set is deliberately small
  for that reason.

## 9. Testing strategy and staged build

**Test pyramid for the core:** `mail-core` tests use a **fake provider, fake clock, and fake secrets**
(the `ports/` traits), a temporary SQLite database, and explicitly cover crash mid-operation, failure
mid-operation, and concurrent operations. Fixtures are **synthetic hostile mail and redacted
samples only** — never real mailbox data in the repository.

**Build stages** (each stage is a shippable checkpoint; stages 1–4 build toward the ADR's five-day
dogfood in stage 5):

1. **Fixture-backed foundation.** Vue/TS app, typed IPC, core crate, SQLite schema, fake provider.
   End-to-end loop: draft → restart → draft survives; archive → restart → pending operation intact.
   Browser integration tests with fake IPC.
2. **Gmail read path** (after provider confirmation). Disposable-account OAuth, read, sync of threads,
   search. Still no trusted-mailbox mutations.
3. **Real mutations with reconciliation.** Real archive/read against the disposable account; failure
   injection, external-client change tests, restart recovery.
4. **Composition and sending.** Reply, reply-all, new send, attachments; draft/recipient-integrity and
   ambiguous-outcome tests (ADR safety gates).
5. **Configurable view + packaged safety gates.** The declarative view reusing the same core; packaged
   app validation of the ADR safety gates; the **ADR five-working-day dogfood**.

**Boundary of browser tests:** browser integration tests with fake IPC verify Vue logic and contract
shape. They **do not establish WKWebView correctness** (focus, IME, keyboard handling, native dialogs,
keychain, OAuth callbacks, packaging) — those need real-macOS checks and are explicitly gated as such.

## 10. Remote sandbox handoff

The repository currently contains **documentation only**: no run/test scripts and no implementation.
A follow-up implementation session in a remote sandbox should:

1. Start by reading this repository: ADR 0001, this document, the PRD, and the security reviews.
2. Scaffold **stage 1 only** (fixture-backed frontend + core + fake provider + SQLite) before any
   network or OAuth work.
3. Keep secrets and disposable-account OAuth material in local env/keychain — **never committed**.
4. **Never put real mailbox data in the sandbox** without explicit approval.
5. Treat the Linux sandbox as able to build/test the platform-independent core and browser UI (with
   required dependencies), but **unable to validate macOS WKWebView, keychain, OAuth callbacks,
   native dialogs, packaging, or keyboard/IME behavior**. Real-platform checks are explicit gates,
   not something those tests simulate.
6. Do not invent setup commands as if they were already present; do not create cloud accounts or
   install dependencies beyond what scaffolding requires.

## 11. Unresolved decisions

| Decision | This document's position |
|---|---|
| macOS-first target | Recommended; confirm before stage 2 |
| Gmail REST provider | Recommended; confirm before stage 2 (ADR: do not build a second provider for abstraction) |
| Fork vs greenfield | Greenfield pattern-reuse recommended; final commit at scaffolding |
| Exact dependencies/versions | Chosen at scaffolding; none claimed here |
| `tauri-specta` adoption | Evaluate at scaffolding against the chosen Tauri version |
| SQLite library and FTS approach | Chosen at scaffolding; verify capabilities rather than assume |
| OAuth app registration (personal vs verified status) | Resolve before stage 2; see README OAuth notes |
| Hide vs quit default UX | Decide and document in UI during stage 1–2 |

## 12. References

- [ADR 0001](docs/adr/0001-single-account-desktop-email-client.md) — governing first-build scope and safety gates.
- [PRD](PRD.md) — long-term direction; §7 security boundaries, §10 architecture direction.
- [email security review](security/email-review.md), [Pebble security review](security/pebble-review.md) — defect patterns this design must outpace (durable staging, unknown outcomes, renderer isolation).
- [README](README.md) — historical research: candidate comparison, Tauri tradeoffs, OAuth notes.
- Official [Tauri 2 capabilities](https://v2.tauri.app/security/capabilities/) — the app-command restriction nuance in §8.
- Official [Vue](https://vuejs.org/guide/introduction.html),
  [TanStack Query](https://tanstack.com/query/latest/docs/framework/vue/overview), and
  [Vitest](https://vitest.dev/) documentation — frontend stack references.
