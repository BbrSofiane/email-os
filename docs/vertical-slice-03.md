# Slice 03: durable Gmail mailbox actions

Status: implementation contract. The operator validated/merged Slice 02 on their Mac and approved worker implementation of archive/unarchive and explicit read/unread. macOS-first, one disposable Gmail account. No authority to connect accounts or use real credentials/mail in this VM. Work on `feat/gmail-mailbox-actions`; no child commits/pushes/publishes or agents. Parent owns acceptance and delivery.

## Scope and checkpoint

Reading remains available with `gmail.readonly`. An explicit **Enable mailbox actions** user action requests `https://www.googleapis.com/auth/gmail.modify` through existing system-browser PKCE. Explain that Google's permission is broader than this client's implemented commands. No composer, send, deletion/trash, arbitrary labels, attachments, HTML, search, saved views or AI. No automatic mark-read on opening. Preserve fixture archive behavior; fixture read/unread need not be implemented.

Checkpoint: enable actions on a disposable Mac account; archive offline -> restart -> reconnect -> Gmail converges; restore from Activity; explicitly mark read/unread; external-client changes converge without losing newer pending intent. Validate archive/recovery first, then read/unread on the same concrete staging mechanism. A cancelled or denied permission upgrade preserves prior reading/credentials/cache and must not report actions enabled.

## Frozen additions (camelCase wire fields, snake_case discriminants)

Keep existing commands and DTOs, adding optional fields for backward compatibility:

- `MutationAccess`: `read_only | upgrading | enabled`; `AccountStatus.mutationAccess?` (absence means read_only for Gmail; fixture archive remains available).
- `Conversation.isRead?` and `ConversationSummary.isRead?`: boolean when all observed message read states are known; absence means unknown, not unread. A conversation is read when none of its observed messages has UNREAD. Opening never changes this.
- `MailboxOperationKind`: `archive | read`; `OperationSummary.kind?`, `requestedRead?`, `lastError?: MailError`. Absent kind is legacy fixture archive. `requestedArchived` remains for compatibility (false and ignored for read operations).
- `OperationStatus` adds `outcome_unknown` (Gmail only). Existing queued/applying/confirmed/failed remain.
- `SetRead = { conversation: ConversationRef; read: boolean; requestId: string }`.
- `RetryOperation = { operationId: string; requestId: string }`.
- `MailError` adds `permission_required`, `provider_rejected`, `outcome_unknown` (sanitized typed errors, no raw provider text).

New commands: `enable_mailbox_actions` (no args, void durable/worker acceptance, not grant success), `set_read` ({ command }, receipt), `retry_operation` ({ command }, receipt). Existing `set_archived` supports Gmail when verified mutation access is enabled. Events remain `mailbox_changed` hints; no raw FS/HTTP/open-URL/label APIs. Rust enforces capability, account, input and request-key checks regardless of frontend. Retry is an explicit new action using the original immutable targets, not a generic executor.

## Frozen internal provider seam

Retain the historical `GmailReadProvider` name to avoid a broad rename. Add narrow default-denied methods so old read-only fakes still compile:

- `mutation_access() -> Result<bool, MailError>` (default false; secure locally verified grant, no network).
- `enable_mutations(&CancelToken) -> Result<GmailProfile, MailError>` (default permission_required).
- `apply_archive(message_ids: &[String], archived: bool, &CancelToken) -> Result<(), MailError>` (default permission_required).
- `apply_read(message_ids: &[String], read: bool, &CancelToken) -> Result<(), MailError>` (default permission_required).

`GmailThread` gains `message_ids: Option<Vec<String>>` and `unread_message_ids: Option<Vec<String>>`. Production supplies every observed message ID including unsupported bodies, and every ID carrying UNREAD; absence in legacy fakes means unknown. Read state/inventory is not derived solely from renderable bodies. Provider scope metadata lives in redacted Keychain bundles, never frontend tokens. Existing Keychain bundles deserialize with default-denied capability. Explicit upgrade verifies returned granted scope and same account BEFORE replacing prior bundle; cancel/denial/different account/missing scope keep the old bundle. Refresh preserves an existing verified grant only if the response omits scope; a present scope downgrade disables writes. No inference of write access from requested scope alone. Re-auth after prior explicit upgrade may retain that chosen access level; ordinary first connect still requests readonly only.

Use fixed `POST /gmail/v1/users/me/messages/batchModify`, bearer auth, existing pacing/TLS/no redirects/timeouts. Archive removes INBOX, unarchive adds INBOX; read removes UNREAD, unread adds UNREAD. Validate nonempty deduped target IDs, max 1000; reject excessive targets visibly, never truncate or broaden to `threads.modify`. A new incoming message must not be included in an older snapshot. No arbitrary label arguments cross IPC.

Setter outcomes: permission/auth failures typed; definite quota rejection is safely retryable with backoff; definite nonretryable 4xx is rejected; transport loss or 5xx after dispatch is `outcome_unknown`, conservatively requiring read reconciliation. Cancellation after possible dispatch is uncertain. Do not map all network errors into a definite rejection or blind replay. A received successful batchModify response is definite setter success, not universal exactly-once semantics. Auth refresh/network failure BEFORE setter dispatch is safely staged/retryable.

## Durable operations and sync

Use concrete SQLite tables and the existing serial worker/control gate; no repository/operation framework. Mutations and sync are coordinated, never competing cursor writers or overlapping setter claims. Network outside DB/control locks. Extend `GmailCore` with `enable_mutations`, `set_archived(&SetArchived)`, `set_read(&SetRead)`, `retry_operation(&RetryOperation)`; methods return void acceptance or OperationReceipt as specified. Report exact public APIs to integration.

Command transaction: validate account/input and current capability, snapshot all currently observed message IDs, persist immutable kind/value/targets + request-key mapping + acceptance ordering + minimal recovery context, commit BEFORE receipt. Same key/same payload returns original receipt (check existing lookup before re-deriving targets); conflicting payload returns request_id_conflict. Explicit retry clones the original operation targets/kind/value under a new deduped request key. New ordinary user actions can target a newer snapshot. Receipts are not provider confirmations.

Cached per-message facts plus accepted operations in sequence derive effective inbox/read state in Rust. Queued/applying/outcome-unknown intent remains distinguishable and newer intent wins; failed intent drops from overlay but stays in Activity. Sync refresh/history/late older confirmations must not erase newer intent. A later confirmed setter is an ordering barrier for the same target message/label: older unresolved intent must not resurface after the newer intent is confirmed and removed from the active overlay. Test outcome-unknown archive -> explicit unarchive -> confirmation -> refresh/restart. A conversation is in inbox if ANY observed message has effective INBOX; new untargeted messages remain in inbox. Separate message inventory/label facts from body decoding; persist unsupported message identities and nullable unknown legacy read facts. Account-scope all rows and lookups.

Single serial mutation dispatch, bounded retry/backoff/rate pacing, UI independent lifecycle. On startup interrupted applying operations become outcome_unknown and reconcile the exact target facts BEFORE any redispatch (unlike the fixture setter's automatic requeue). If observed provider labels satisfy the requested setter for all existing targets, confirm atomically; otherwise retain visible outcome_unknown, no automatic replay. Deleted/missing targets must not falsely confirm or broaden the operation. The user can explicitly Retry action (explain uncertain outcome/state override) with a new receipt. No send semantics are implemented or implied.

The 100-conversation sync cache must NOT evict operation history/targets or the context needed to open/recover archived conversations. Retain operation recovery snapshots outside the bounded sync-cache eviction policy; full conversation snapshots are acceptable here. Disclose retained snapshot freshness/incomplete context when current cache is absent. Keep all small-slice activity history; no silent truncation. Confirmed archived items remain openable and can be unarchived after cache eviction/restart. Reconciliation/finalization is atomic with provider-fact updates and guarded against disconnect generations. Storage failures halt execution, stay visible, and never fabricate a receipt/confirmation. Disconnect cancels dispatch/upgrade/sync with the existing admission barrier, deletes operation/request-key/recovery state with account/cache, and prevents credential or fact resurrection. Warn that local pending actions are removed by disconnect; it does not undo confirmed remote changes or revoke Google's grant.

## UI and validation

Explicit permission-upgrade disclosure, read-only/enabled/upgrading labels, cancellation affordance and failure recovery. Preserve plain-text/keyboard safety, subscribe/refetch/focus/reconnect and stale-response guards. Gmail mutations unavailable until authoritative enabled status; pending/confirmed/failed/outcome-unknown distinct, no optimistic success toast. Archive/unarchive from list/reader/Activity; explicit read/unread reader/list controls and a documented shortcut (e.g. Shift+U) respecting IME/modifiers/text fields. Opening remains read-only. Activity labels distinguish archive/read and expose Retry only for failed/unknown operations with fresh request IDs. Unknown read state is disclosed, not falsely rendered unread. Keep selection/focus predictable after archive. Browser fake remains clearly synthetic/non-durable and accurately models upgrade and setter status/races.

Provider tests: readonly cannot write; old token bundle migration; cancel/deny upgrade retains credentials; account/scope binding; refresh downgrade; exact snapshot message IDs and INBOX/UNREAD labels only; quota vs permission vs transport/5xx ambiguity; pacing/cancel/no redirects; all-message inventory incl. unsupported bodies.

Core tests (barriers, no real network): durable receipt/key conflict; initial read-only denial; offline enqueue/restart; new incoming message between acceptance/dispatch; archive->unarchive/read->unread ordering; sync cannot erase intent; partial/late confirmation; timeout after provider apply; crash applying -> read reconciliation/no replay; unresolved unknown -> explicit retry; auth/rate backoff; failed overlay revert; cache eviction retains archived reader/unarchive; existing-profile migration without reseed; storage-failure halt; disconnect while blocked dispatch/upgrade/refresh; profile lock and no overlapping claims. Preserve Slice 02 pacing/partial progress tests.

UI tests: explicit opt-in/cancel/deny, readonly guards, unread/unknown state, opening sends no mutation, pending/error/unknown/confirmed activity, retry fresh key, reader/activity recovery, shortcut/focus, stale query/command/disconnect races, plain text safety. Run focused gates as each behavior is built, then core/contract/fmt/clippy/UI/typecheck/web build. Native check/test attempts remain prerequisite-gated; no OS packages or accounts in VM. Mac checklist covers consent upgrade/deny/cancel/offline/restart/external changes; prior Slice 02 operator validation does not validate new mutation behavior.

## Ownership board

Classification: **multi-seam**. Provider authorization/setter transport, durable operation/cache execution, and frontend interaction are independently testable against frozen contracts.

| Lane | cwd/isolation | Exclusive edits | Focused gate | Handoff |
|---|---|---|---|---|
| Parent shared bootstrap | main checkout before fanout | this contract, shared DTO/types/errors/generator and compatibility defaults | baseline core/contracts/types | tracked shared commit |
| Provider/auth | managed isolated worktree | gmail/auth.rs, provider.rs, secrets.rs, gmail_auth_contract.rs; distinct new provider tests | synthetic HTTP/grant/label tests + core lint | managed patch + APIs/evidence |
| Durable core | separate managed worktree | gmail/store.rs, sync.rs, operations.rs; gmail_cache_sync.rs; distinct mutation tests | archive/recovery first, then read/unread barrier tests + core lint | managed patch + APIs/evidence |
| UI | separate managed worktree | src/** except generated.ts, tests/** | Vitest/typecheck/build | managed patch + evidence |
| Integration | main checkout after handoffs | apply patches, src-tauri/**, docs/tasks and minimal seam corrections | integrated checks, native gate | reviewed diff + evidence |
| Review/fixes | main checkout, read-only reviews then one fix writer | distinct integrity vs UI/native/security review | focused corrections/recheck, final parent checks | findings/dispositions |

Runtime journals managed isolation paths before mutation. No child can push/publish, spawn agents, install OS packages, connect mail, inspect secrets, or broaden scope. Scratch artifacts outside source checkout. Parent publication is not delegated.
