# Slice 02: disposable-account Gmail reading

Status: implementation contract. The operator validated Slice 01 on their Mac and approved this next slice, macOS-first, Gmail REST, worker implementation, and committing/pushing a test branch. This does not authorize connecting a mailbox in the Linux VM or using a primary mailbox.

## Scope and acceptance

One disposable Gmail account: system-browser OAuth/PKCE, macOS Keychain token custody, bounded resumable inbox discovery, cached plain-text conversation reading, incremental catch-up while running, external-client changes, freshness/coverage/errors, explicit disconnect. Fixture mode remains available in its existing separate profile. Gmail is read-only: no archive, mark-read, sending, composer, attachments, HTML, search, saved views, or AI. Only `https://www.googleapis.com/auth/gmail.readonly` is requested.

Checkpoint: connect on a Mac, read inbox conversations, restart offline and read cached content, reconnect and observe external changes without skipping data. A bounded cache is not the entire mailbox. Unsupported/HTML-only messages must disclose limitations, never render HTML or fetch attachment resources. Quitting stops sync. No real mail or credentials in logs, tests, source, or this VM.

## Native selection and setup

Native default remains fixture. Explicit `EMAIL_OS_MODE=gmail` selects a separate `<app_data_dir>/gmail-profile`. `EMAIL_OS_GOOGLE_CLIENT_ID` and optional `EMAIL_OS_GOOGLE_CLIENT_SECRET` configure the operator's Google Desktop OAuth client through the launch environment; never send them to the frontend. The desktop client secret is not treated as a confidential authentication credential, but do not log or commit it. Missing client ID is a visible `not_configured` state, not a silent fixture fallback. macOS Keychain is the production credential store; unsupported platforms fail visibly (in-memory secrets exist only in tests). No plaintext fallback. Browser preview remains labelled, synthetic, and non-durable.

## Wire additions

Keep Slice 01 DTOs and commands. Add generated Rust-owned DTOs:

- `MailMode`: `fixture | gmail`.
- `ConnectionState`: `not_configured | disconnected | authenticating | connected | auth_required`.
- `SyncState`: `idle | syncing | error`.
- `AccountInfo`: `{ accountId: string; emailAddress: string }`.
- `SyncInfo`: `{ state: SyncState; lastSyncedAt: string | null; error: MailError | null; cachedConversations: number; initialSyncComplete: boolean; coverageLimit: number }`.
- `AccountStatus`: `{ mode: MailMode; connection: ConnectionState; account: AccountInfo | null; sync: SyncInfo }`.
- `Conversation` gains optional `contextComplete?: boolean` and `unsupportedReason?: string` (absent for legacy fixture clients). Gmail supplies context completeness and unsupported plain-text context explicitly.

Extend typed MailError with `read_only`, `not_configured`, `auth_required`, `auth_cancelled`, `auth_failed`, `secrets_unavailable`, `network_unavailable`, `rate_limited`, `provider_unavailable`, `invalid_provider_response`, `busy`. No raw HTTP/token/provider response text crosses IPC.

Commands: `get_account_status`, `connect_account`, `disconnect_account`, `request_sync`, plus existing `list_conversations`, `get_conversation`, `set_archived`. Connect and sync enqueue work and return void acceptance, not OAuth/sync success. Changes use the existing `mailbox_changed` hint. Disconnect returns only after credential deletion and local account/cache clearing (or typed failure); cancel in-flight auth/sync first and reject stale responses. Gmail `set_archived` always returns `read_only`, enforced in Rust as well as hidden/disabled in UI.

## Internal provider boundary (frozen for component ownership)

`crates/mail-core/src/gmail/types.rs` owns the shared types. A synchronous `GmailReadProvider: Send + Sync` is called only by a core background/blocking worker, never while holding a SQLite lock:

- `is_configured() -> bool`
- `has_credentials() -> Result<bool, MailError>`
- `connect(&CancelToken) -> Result<GmailProfile, MailError>`
- `disconnect() -> Result<(), MailError>` (local secure credential deletion, no remote revocation promise)
- `profile(&CancelToken) -> Result<GmailProfile, MailError>`
- `list_inbox(page_token: Option<&str>, &CancelToken) -> Result<InboxPage, MailError>`
- `get_thread(thread_id: &str, &CancelToken) -> Result<Option<GmailThread>, MailError>` (`None` for deleted/not-found)
- `history(start_history_id: &str, page_token: Option<&str>, &CancelToken) -> Result<HistoryPage, GmailHistoryError>`

`GmailProfile { account_id, email_address, history_id }`; `InboxPage { thread_ids, next_page_token }`; `GmailThread { conversation: Conversation, inbox_message_ids: Vec<String>, history_id: String }`; `HistoryPage { changed_thread_ids, deleted_message_ids, next_page_token, history_id }`; `GmailHistoryError::Expired | Mail(MailError)`. IDs/cursors are opaque strings, not numeric JS IDs. Provider profile account ID is stable and scoped (email is acceptable for this single account).

Auth component exposes `GoogleConfig::from_env()`, `GmailProvider::new(config, secrets: Arc<dyn Secrets>) -> Result<Self, MailError>`, and `KeychainSecrets::new()`; it implements the shared provider trait. `Secrets` stores a redacted credential bundle under an account-independent single-profile key so restart can authenticate before account discovery. Account switching without disconnect must fail closed.

Sync component exposes `GmailCore::open(profile_dir, Arc<dyn GmailReadProvider>) -> Result<Self, MailError>`; cloneable facade with `list_conversations`, `get_conversation`, `account_status`, `connect_account`, `disconnect_account`, `request_sync`, `subscribe`, and `stop`. Sync starts independently of Vue lifecycle. Subscription guard lifetime matches Slice 01. Public methods return MailError as appropriate; report exact signatures to integration owner.

## Persistence and synchronization

Concrete SQLite, dedicated Gmail schema/profile and OS-backed profile lock. Short serialized transactions, network outside locks, blocking DB work off Tauri/UI threads. Cache data and its cursor/progress commit atomically. Persist initial discovery progress so restart does not reset successful pages; cap discovery at 100 conversations and disclose that cap. Pin an initial history baseline before discovery; don't advance past changes while listing threads. Complete history pagination before advancing its history cursor; safely resume/replay interrupted work. Dedup repeated IDs, replace observed thread facts atomically, remove stale INBOX membership after external archives/deletions, account-scope all lookups. Cursor expiry triggers bounded rediscovery with stale inbox membership reconciliation, not silent skipping. Bound response sizes/pagination and handle pathological provider data without panics.

Cached list/reader work while offline or authentication is expired; sync errors do not make already cached mail unreadable. Synchronization is serialized; repeated requests coalesce/reject as busy, no concurrent cursor writers. Retry/backoff for network/rate limits, no tight polling; cancellation and shutdown must finish with bounded waits. Disconnect clears local data and prevents in-flight results from repopulating it. Storage failures remain typed and visible, never log-and-ignore.

## OAuth and rendering security

Random PKCE verifier/challenge and state, loopback listener bound only to 127.0.0.1 on an ephemeral port, exact callback path/state checks, short bounded timeout, cancellation, one-shot callback. Launch only a constructed Google HTTPS authorization URL externally. No generic external-open IPC. Refresh in Rust, serialize refresh, preserve existing refresh token when omitted, revoked/invalid grant becomes auth_required. Never debug-print tokens, codes, authorization URLs, subjects, addresses, or bodies. HTTP uses fixed HTTPS endpoints, TLS and timeouts, no credential-bearing redirects. Parse bounded Gmail MIME payloads; decode text/plain and charsets safely, ignore HTML/attachments/remote resources, report incomplete unsupported content. Keychain failures fail closed.

## Incremental validation and lane board

Classification: **multi-seam**. Provider/auth and cache/sync can be tested independently against the frozen trait; frontend can be tested against the generated wire contract. Workers use isolated worktrees from the shared contract commit. Only the later integration writer touches the main checkout.

| Lane | Exclusive ownership | Isolation | Focused gate | Durable handoff |
|---|---|---|---|---|
| Parent bootstrap | contract, shared types/DTO scaffolding and dependency declaration | main checkout, before worker launch | generated contract + baseline tests | shared tracked commit |
| Auth/provider | gmail/auth.rs, provider.rs, secrets.rs; provider/auth tests | managed isolated worktree | headless auth/provider tests with fake secrets and synthetic HTTP; no real OAuth | managed patch + API/test report |
| Cache/sync | gmail/store.rs, sync.rs; cache/sync tests | separate managed isolated worktree | restart/cursor/expiry/external changes/disconnect/cancellation tests with fake provider | managed patch + API/test report |
| UI | src/** excluding generated.ts, tests/** | separate managed isolated worktree | Vitest, typecheck, web build | managed patch + report |
| Integration | apply component handoffs; src-tauri/**, docs, mise tasks, lockfile, narrowly necessary seam corrections | main checkout after component owners finish | check/contract/web build; native checks if prerequisites exist | integrated commit + validation evidence |
| Review/fixes | read-only reviews first, then one bounded fix owner at a time | integrated main checkout | security/sync correctness and UI/integration review | findings and revalidation |

No child launches other agents, pushes, publishes, installs OS packages, connects accounts, or reads secrets. Parent owns acceptance, branch commit and push. Linux cannot establish WKWebView/Keychain/OAuth callback runtime behavior; Mac test instructions are part of delivery. The earlier Slice 01 Mac gate is operator-validated, not proof of Slice 02 platform behavior.
