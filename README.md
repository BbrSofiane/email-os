# Email OS

**Email that works your way.**

A programmable email client for people and agents. Compose the decisions, workflows, and views that
fit how you process email—manually or with an agent—on top of a reliable, opinionated mail foundation.

- **Brand:** Email OS
- **Project / repository name:** `email-os`
- **First build:** **a single-account, keyboard-first desktop email client**—a limited Superhuman
  replacement for complete read/reply/archive sessions, with one configurable view.
- **Later experiment:** **a reply queue you can teach**—a proposed customization study, not the
  first-build scope.

Email OS is the working name for the platform vision. “OS” describes a foundation for composable
email workflows, not a new operating system or email server. Name, domain, and trademark availability
have not been checked.

## Start here

- [Architecture: proposed implementation for the first build](ARCHITECTURE.md): proposed Tauri 2 +
  Vue 3 implementation plan for ADR 0001 — module boundaries, state ownership, IPC surface, security
  boundaries, and staged build. Proposed design, not implemented code.
- [ADR 0001: first desktop build](docs/adr/0001-single-account-desktop-email-client.md): accepted
  first-build direction, scope, safety gates, and dogfooding criteria.
- [Product requirements](PRD.md): long-term vision, composition model, safety boundaries, and open decisions.
- [Experiment 1: a reply queue you can teach](EXPERIMENT-01.md): a proposed later customization study,
  including on-phone use; superseded by ADR 0001 for first-build sequencing.
- [email security review](security/email-review.md) and [Pebble security review](security/pebble-review.md):
  static findings to address before reusing candidate implementations.

**Status:** the first-build direction (ADR 0001) is accepted, and a Tauri 2 + Vue 3 frontend is now
the selected implementation direction — see [ARCHITECTURE.md](ARCHITECTURE.md) for the proposed
implementation plan. Still open: confirming macOS-first and Gmail REST, fork-versus-greenfield
finalization, and exact dependency choices. No implementation or connection to a mailbox exists yet.
**Research date:** 2026-09-25.

## Research background

The sections below preserve earlier research. Their suggested MVP deferrals are historical options,
not the current platform requirements. Use the PRD for product direction and ADR 0001 for the
accepted first-build scope. This section is historical: Tauri with a Vue 3 frontend has since been
selected for the first build (see [ARCHITECTURE.md](ARCHITECTURE.md)), while fork-versus-greenfield,
provider/OS confirmation, and exact dependencies remain open decisions there. A custom Android client
is outside the first build, not outside the product vision.

This research summarizes a conversation about building an ideal personal email-processing
workflow. It is **not** an attempt at full Superhuman parity: the goal is a workflow that fits how the
user works. **Method caveat:** the comparison below is **source inspection only** (READMEs, licenses,
manifests, selected source files, release metadata) — **not runtime validation**. Nothing was built,
run, or exercised against a real mailbox; README feature claims remain author claims.

---

## 1. Goal and constraints

**Confirmed user goal:** support the user's ideal way to process email, with an Android mobile app
remaining important. Tauri is the framework initially proposed by the user, not a final commitment.

**Proposed direction, not confirmed requirements:** keyboard-first and local-first desktop behavior,
a Gmail-first MVP, a React/TypeScript UI, and macOS-first evaluation. Provider coverage, frontend stack,
cloud dependencies, distribution plans, and the exact mobile workflow are still open decisions.
Full Superhuman parity is not the goal; snooze/rules are candidate features, not established must-haves.
No implementation or fork target has been selected.

---

## 2. Candidate comparison

The original research shortlist was **superseded by a targeted follow-up** on Openmail and Pebble (and
exact license corrections). If AGPL is acceptable for a personal fork, **Pebble deserves evaluation
before committing to a new build**; the permissive-license candidates remain useful otherwise.

| Candidate | License (inspected) | What it is | Maturity / recency | Platform caveats |
|---|---|---|---|---|
| [JakubSzwajka/email](https://github.com/JakubSzwajka/email) | [MIT](https://raw.githubusercontent.com/JakubSzwajka/email/main/LICENSE) | Tauri 2 + React/TypeScript/Vite + Rust, local SQLite, headless `mailcore` crate; verified Gmail REST send/fetch; keyboard-driven unified Gmail inbox, BYO OAuth/keychain, documented durable outbox | Early development per README; [v0.3.1](https://github.com/JakubSzwajka/email/releases/tag/v0.3.1) 2026-07-15, universal macOS DMG; unsigned/un-notarized | Desktop/macOS releases only; limited inbox window (~1 year), app-local labels, **no closed-app sync daemon**; no IMAP/Outlook assumption |
| [QingJ01/Pebble](https://github.com/QingJ01/Pebble) | [AGPLv3](https://raw.githubusercontent.com/QingJ01/Pebble/master/LICENSE) (standard text, no custom restrictions) | Tauri 2 + Rust + React 19/TS, SQLite/rusqlite + Tantivy; verified SMTP/IMAP/Gmail providers; unified inbox, keyboard palette, snooze, rules, Kanban, tray sync, experimental Outlook | Early (0.1.x); [v0.1.5](https://github.com/QingJ01/Pebble/releases/tag/v0.1.5) 2026-09-09; README: usable for day-to-day testing, keep backups | **Windows/macOS/Linux only — no Android**; macOS builds unsigned without custom signing; claims untested |
| [Skim](https://github.com/nikserg/skim) | [MIT](https://raw.githubusercontent.com/nikserg/skim/main/LICENSE) | Tauri 2 + Rust + Svelte 5; IMAP/SMTP verified; SQLite/FTS5, offline queue, keyboard palette; Windows Credential Manager | Young despite 1.x; [v1.0.31](https://github.com/nikserg/skim/releases/tag/v1.0.31) 2026-09-23 | **Windows-focused** packaging; macOS/Linux secrets/platform work needed; omits snooze/rules; README warns Gmail OAuth testing tokens expire |
| [bberkay/openmail](https://github.com/bberkay/openmail) | [Apache-2.0](https://raw.githubusercontent.com/bberkay/openmail/main/LICENSE) — **not MIT** | Tauri + Svelte 5 desktop client **plus a separate Python/FastAPI server** that must run locally first; verified SMTP send/reply/forward and IMAP | Alpha per README; push 2025-11-17; only release is prerelease [v0.0.1-alpha0](https://github.com/bberkay/openmail/releases/tag/v0.0.1-alpha0) | Windows/macOS/Linux assets; not a Rust-native mail core; extra server packaging is a poor local-first fit |
| [Mailspring](https://github.com/Foundry376/Mailspring) | [GPLv3](https://raw.githubusercontent.com/Foundry376/Mailspring/master/LICENSE.md) | Full desktop client: **Electron + React/TS** with local **C/C++ (Mailcore2) sync engine**; unified inbox, snooze, scheduled send, plugins | **Strongest maturity here**: active since 2016; [1.25.0](https://github.com/Foundry376/Mailspring/releases/tag/1.25.0) 2026-09-19 | Electron/Node + C++ packaging; poor direct Tauri conversion; GPL obligations if distributing derivatives; desktop only |
| [Mail-0/Zero](https://github.com/Mail-0/Zero) | [MIT](https://raw.githubusercontent.com/Mail-0/Zero/staging/LICENSE) | Real web mail client (Gmail send verified); `staging`: React Router 7 + React/TS + Vite, Hono/Cloudflare; README drift still says Next.js/Node/Postgres | [v0.1](https://github.com/Mail-0/Zero/releases/tag/v0.1) 2025-07-18, no assets | Substantial **server/cloud coupling**; **no verified Android or PWA guarantees**; UI/provider reference, not a local-first fork base |
| [Inbox Zero](https://github.com/elie222/inbox-zero) | Root is **AGPL text plus additional terms** (permission required to monetize derivatives; enterprise license for ≥5 business users) plus a **separately licensed EE** subtree. **Not plain AGPL** (GitHub: `NOASSERTION`) | AI assistant/automation platform with a mail-client UI; Next.js/React, Prisma, Postgres/Redis; desktop app is an **Electron shell for the hosted web app** | [desktop-v0.1.12](https://github.com/elie222/inbox-zero/releases/tag/desktop-v0.1.12) 2026-09-24, macOS/Windows | See §5: documents Android **product** support, but forkable mobile source unverified; licensing review required before reuse |
| [Emailite](https://github.com/mudern/emailite) | [MIT](https://raw.githubusercontent.com/mudern/emailite/main/LICENSE) | Tauri 1 + Rust + React/Ant Design toy/study client; real IMAP/SMTP code, but attachment extraction unimplemented | Push 2024-09-12; [v1.0.1](https://github.com/mudern/emailite/releases/tag/v1.0.1) 2024-09-06 | Educational only; stale, Tauri 1, skeletal |

License findings are factual text inspection, not legal advice.

---

## 3. Tauri: conditional recommendation and the Electron tradeoff

**Conditional fit.** Tauri 2 supplies the desktop shell primitives (native system webviews, Rust↔frontend
IPC, capabilities, tray, notifications, shortcuts, deep links, signed updates) but **not** an email
architecture, a background daemon, a complete OAuth/token solution, or a safe mail renderer.

The core tradeoff: Tauri uses the OS webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on
Linux), avoiding a bundled Chromium but inheriting platform/version differences; Electron bundles
Chromium/Node for a consistent renderer baseline at the cost of footprint and heavier packaging. Neither
is automatically faster or safer; benchmark the actual workload.

Caveats: WebKit compatibility (focus, IME, typography, animation) needs early testing on real macOS
hardware — one isolated Intel Mac issue was reported in
[tauri#13141](https://github.com/tauri-apps/tauri/issues/13141), weak evidence of prevalence but
motivation for hardware testing. "Local-first" sync works while the process is alive, and a tray/menu-bar
mode can stay available after hiding the window, but **guaranteed sync while the app is fully quit is not
possible with Tauri async tasks alone** — that needs a separately designed helper or OS background
mechanism; decide quit-vs-hide semantics deliberately. Node-bound backend dependencies are not drop-in
(Rust backend), so a Node-heavy stack erodes Tauri's advantage. There is no official Tauri OAuth plugin;
treat community `tauri-plugin-oauth` as third-party and audit it before adoption. macOS distribution
requires code signing and, outside the App Store, notarization.

**Reconsider Electron or native if:** Chromium-consistent rendering across OS releases is a hard
requirement; product logic depends deeply on Node-only modules; guaranteed sync while quit is a core
promise; or the Rust/backend, hostile-email-security, and release-engineering work is not affordable.

---

## 4. Local-first architecture (proposed shape)

```
React/TS UI  →  narrow typed Tauri commands/events  →  Rust mail/sync core
                                                            │
                    SQLite (metadata + FTS5 search) ◄───────┤
                    OS secret store / Stronghold (tokens) ◄─┘
```

- **Trusted UI:** React/TypeScript; keyboard command system, list/detail, settings. Talks only through
  narrow typed commands and events.
- **Rust core:** OAuth callback handling, account/session state, provider integration (Gmail REST / IMAP /
  JMAP), MIME parsing, retryable sync coordinator, notifications, database and migrations.
- **Local store:** SQLite metadata + FTS5 search; prefer a Rust-owned DB API over exposing general SQL to
  the UI, and verify the chosen SQLite build actually enables FTS5 (Tauri's SQL plugin does not guarantee
  it). Async commands do not make a sync engine: cancellation, retries, incremental sync, conflict
  handling, backoff, and rate limits are application work.
- **Secrets:** tokens in the OS keychain (or Stronghold) — never in frontend storage or plain app config.

**Gmail full vs. incremental resync:** the sync design must handle both a full initial mailbox pull and
cheap incremental catch-up (history/sync APIs), including interruption/restart and duplicate-suppression.
Candidates document only partial answers (§2), so this must be designed explicitly.

**Durable queued actions and optimistic UI:** the desired UX is optimistic (read/archive/send reflected
instantly) with **durable local queues** so actions survive crashes, offline periods, and sync conflicts.
JakubSzwajka's `email` documents this pattern; it must be engineered deliberately (idempotent operations,
ordered retries, conflict resolution), not assumed.

**Untrusted mail rendering — the largest security obligation:** Tauri capabilities can confine a dedicated
message webview to zero privileged IPC, but they do **not** sanitize hostile HTML. Required: sanitized
HTML, scripts and forms stripped, remote images blocked or proxied by default, links opened externally
through an explicit handler, restrictive CSP, and never placing raw message markup into the privileged
app-origin DOM. Do not rely on an iframe as the security boundary (platform limits differ, notably
Linux/Android).

**OAuth flow:** authorization-code + PKCE in the system browser, random state, strict redirect/issuer
validation, one-shot loopback listener or deep-link return with a short timeout, refresh tokens never in
web storage.

**Personal vs. public OAuth verification:** personal use can qualify for a verification exception;
it does **not** inherently require leaving the OAuth consent screen in Testing status. External apps
in Testing generally receive seven-day refresh tokens for Gmail scopes; publishing status and scope
verification are separate considerations. Public distribution and server-side handling of restricted
Gmail data can introduce additional verification/security-assessment obligations. Validate the chosen
OAuth configuration rather than assuming weekly reauthentication is unavoidable. See Google's
[installed-app OAuth guidance](https://developers.google.com/identity/protocols/oauth2/native-app) and
[restricted-scope verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

---

## 5. Android update (post-dates the research reports)

Newer findings, more current than the reports above:

- **Tauri 2 supports Android**, but **none of the inspected Tauri clients has a documented Android
  implementation**. The upstream `JakubSzwajka/email` repository has generated Android icons only;
  those assets do **not** establish Android support.
- **Inbox Zero does document Android product support** — see the
  [mobile apps docs](https://docs.getinboxzero.com/essentials/mobile-apps) and
  [the product page](https://www.getinboxzero.com/app);
  [getinboxzero.com/android](https://www.getinboxzero.com/android) redirects to
  [the Play Store listing](https://play.google.com/store/apps/details?id=com.getinboxzero.app). Its
  public repository contains mobile **server APIs** but **no mobile app directory** under `apps/` — so
  forkable Android source / self-hosted mobile compatibility is **unverified**. Do not claim the client
  source is private or absent universally; it is simply not confirmed.
- Open option: whether Android needs **custom triage behavior** vs. mere **read/reply** capability is
  **unresolved**.

**Option A — custom desktop client + existing Android Gmail app.** Use the Gmail Android app with
provider-level labels/read/archive. Provider-level state syncs across devices, but any custom local state
— snooze queues, outbox queues, triage labels outside Gmail's model — needs **explicit cross-device
design** (e.g. Gmail labels as the sync medium, or accept desktop-only semantics). Lowest build cost;
keeps Android off the critical path.

**Option B — shared Tauri/Rust core with an Android-first spike.** Validate a shared core by prototyping
on Android first: auth (system browser/PKCE), read, send, background behavior, notifications. There is
**no automatic port** — desktop shell work and Android lifecycle/background/notification constraints are
separate engineering. Highest ceiling for a unified product; highest cost and risk.

The Tauri-vs-Electron and local-first decisions should be revisited after choosing between these options.

---

## 6. Small MVP and deferred scope

**Minimal MVP (suggested):** Gmail OAuth (PKCE, system browser) + secure token storage; sync one account
into SQLite with incremental catch-up; keyboard-first list/detail with optimized read, archive, reply;
durable outbox with optimistic send; isolated, sanitized message rendering.

**Deferred:** IMAP/Outlook providers, snooze/rules/Kanban workflows, unified multi-account inbox, Android
(pending the §5 decision), cross-device state, plugins/themes, signed/notarized distribution polish.

---

## 7. Build vs. fork: next steps

1. **Evaluate Pebble** if AGPL is acceptable and broader existing workflows are valuable
   (keyboard palette, snooze, rules, tray sync, Tantivy search). It is young; the static security review
   found renderer/privacy gaps that should be fixed and validated before primary-inbox use.
2. **Evaluate JakubSzwajka/email** for a narrower MIT-licensed Gmail/React foundation: early,
   macOS-only releases, bounded inbox window, no closed-app sync. Its static review found a
   recipient-expansion issue and send/retry integrity defects; address these before relying on it.
   Neither choice is cleared for primary-inbox use by these reviews.
3. If Windows/IMAP matters more, evaluate **Skim** first and add snooze/sync semantics deliberately.
4. Do not confuse wrapping with porting: embedding Zero/Inbox Zero in a Tauri webview preserves their
   backend dependencies; porting Mailspring means replacing Electron integration, not just repackaging.
5. Before importing real mail, validate: OAuth refresh/revocation, keychain behavior, hostile-HTML/CSP
   isolation, interrupted sync, duplicate-send prevention, MIME/attachments, offline mutations,
   large-inbox latency, and signing/update trust. Start with a disposable account.
6. Run the three recommended prototype spikes before any cross-platform commitment: (a) dense keyboard UI
   in WKWebView on real macOS hardware, (b) hostile-mail rendering spike in the isolated webview on a
   packaged build, (c) end-to-end local-first spike (OAuth → sync → FTS5 search → restart/network failure
   → hide/quit behavior).

**Unresolved questions:** Does Android need custom triage workflows, or is read/reply sufficient (§5)?
Option A vs. Option B for Android (§5)? Is AGPL (Pebble) acceptable for personal use? Is sync-while-quit
needed at all, or is tray/hide mode enough? Is platform-webview variance acceptable, or is a
Chromium-consistent Electron baseline required?

---

## 8. Security reviews (completed static pass)

Two independent subagent reviews are saved as separate, commit-pinned source-review reports:

- [`security/pebble-review.md`](security/pebble-review.md) — on QingJ01/Pebble at commit
  `e43341cc59b8efda8d55f3de8584419cefa44c88`.
- [`security/email-review.md`](security/email-review.md) — on JakubSzwajka/email at commit
  `f0af11852b27b17f229979a3e4e7e615a1f8c3dc`.

**Summary:** `email` has two P1 findings (contact-display-name recipient expansion and concurrent
outbox replay) plus five P2 integrity/cleanup findings. Pebble has four P2 findings concerning embedded
CSS visual containment, escaped CSS filtering, Strict-mode image URL handling, and a conditional
Unicode-header logging panic. The reports distinguish source-supported defects from untested runtime
consequences and additional hardening opportunities; their severity counts are not a comparative
security score.

The parent independently inspected the principal recipient, send/replay, and renderer/privacy source
paths. No project code, tests, builds, network exploit, or real mailbox was run. The findings are not
runtime demonstrations or comprehensive security certifications. Neither snapshot is recommended for
a primary inbox without fixes and targeted validation; Android requires its own review. Repository
snapshots were kept outside this workspace under `/tmp/email-security-review.PDYa6I/`; the reports
contain pinned GitHub links so their evidence does not depend on those temporary checkouts.

---

## 9. Sources

- Tauri documentation: [process model](https://v2.tauri.app/concept/process-model/), [webview versions](https://v2.tauri.app/reference/webview-versions/), [capabilities](https://v2.tauri.app/security/capabilities/), [security](https://v2.tauri.app/security/), [CSP](https://v2.tauri.app/security/csp/), [SQL plugin](https://v2.tauri.app/plugin/sql/), [SQLite FTS5](https://sqlite.org/fts5.html), [deep linking](https://v2.tauri.app/plugin/deep-linking/), [opener](https://v2.tauri.app/plugin/opener/), [Stronghold](https://v2.tauri.app/plugin/stronghold/), [community OAuth plugin](https://github.com/FabianLars/tauri-plugin-oauth), [tray](https://v2.tauri.app/learn/system-tray/), [global shortcut](https://v2.tauri.app/plugin/global-shortcut/), [notifications](https://v2.tauri.app/plugin/notification/), [updater](https://v2.tauri.app/plugin/updater/), [macOS signing](https://v2.tauri.app/distribute/sign/macos/), [Node sidecar](https://v2.tauri.app/learn/sidecar-nodejs/).
- [Apple background-process guidance](https://developer.apple.com/documentation/appkit/managing-ongoing-background-processes-in-your-mac); [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model).
- Android product-support links: [Inbox Zero mobile docs](https://docs.getinboxzero.com/essentials/mobile-apps), [getinboxzero.com/app](https://www.getinboxzero.com/app), [Play Store listing](https://play.google.com/store/apps/details?id=com.getinboxzero.app).

**Residual risks:** nothing was executed or audited at runtime; README claims and provider-policy behavior
are unverified; young Tauri projects may carry undiscovered data-loss or security defects; source URLs
and branch contents can change; Android findings are newer than the source-inspection reports and rest on
web evidence for Inbox Zero's mobile app.
