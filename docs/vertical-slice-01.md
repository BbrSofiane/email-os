# Slice 01: fixture inbox, reader, and durable archive

User-approved implementation scope: Tauri 2 + Vue 3/TypeScript, one synthetic account, 18 synthetic conversations, plain-text reader, keyboard navigation, archive/unarchive with persisted receipts and restart recovery. No composer/drafts, OAuth, Gmail/network access, search, saved-view editor, HTML rendering, attachments, or generic operation framework. ADR 0001 and ARCHITECTURE.md remain broader plans, not claims about this slice.

## Interfaces and wire contract

Rust owns DTOs and generates `src/lib/ipc/generated.ts` (ts-rs is an acceptable lightweight choice; no Tauri dependency in mail-core). JSON uses camelCase fields, snake_case discriminants, strings for IDs and ISO-8601 UTC timestamps, null for absent optional fields. Core methods return Rust Result; the Tauri adapter resolves success and rejects with the typed MailError object. Frontend transport maps errors without inventing success.

```ts
type ConversationRef = { accountId: string; conversationId: string };
type Address = { displayName: string | null; mailbox: string };
type OperationStatus = 'queued' | 'applying' | 'confirmed' | 'failed';
type OperationFailure = { kind: 'provider_unavailable' } | { kind: 'provider_rejected' };
type MailError =
  | { kind: 'not_found' }
  | { kind: 'invalid_request'; field: string }
  | { kind: 'request_id_conflict' }
  | { kind: 'storage_unavailable' }
  | { kind: 'profile_in_use' };
type OperationReceipt = { operationId: string; acceptedAt: string };
type SetArchived = { conversation: ConversationRef; archived: boolean; requestId: string };
type ConversationSummary = {
  ref: ConversationRef; subject: string; participants: Address[]; preview: string;
  lastMessageAt: string; pendingOperationId: string | null;
};
type Message = { id: string; from: Address; to: Address[]; sentAt: string; bodyText: string };
type Conversation = {
  ref: ConversationRef; subject: string; messages: Message[];
  isInInbox: boolean; pendingOperationId: string | null;
};
type OperationSummary = {
  id: string; conversation: ConversationRef; requestedArchived: boolean;
  status: OperationStatus; failure: OperationFailure | null;
};
type InboxSnapshot = { conversations: ConversationSummary[]; activity: OperationSummary[] };
interface MailClient {
  listConversations(): Promise<InboxSnapshot>;
  getConversation(ref: ConversationRef): Promise<Conversation>;
  setArchived(command: SetArchived): Promise<OperationReceipt>;
  subscribe(listener: () => void): Promise<() => void>;
}
```

IPC commands: `list_conversations` (no args), `get_conversation` ({ ref }), `set_archived` ({ command }). Event name: `mailbox_changed`, payload can be empty. Generated DTO file must have a repeatable generate/check task; UI uses the agreed shapes temporarily until core generation is integrated. No frontend SQL, raw HTTP, raw filesystem, or secrets.

## State and concurrency

- Cached provider facts are per-message INBOX membership. Apply queued/applying operations in acceptance sequence to derive effective state; a conversation is in the inbox when ANY observed message has effective INBOX membership. Vue never computes this overlay itself.
- A command validates input and snapshots currently observed message IDs in the same SQLite transaction that inserts the operation and request-key mapping. Return a receipt ONLY after commit. Repeating a request ID and identical command returns the same receipt; different payload returns request_id_conflict. Retry the original receipt lookup before deriving new targets.
- A single serial worker claims queued -> applying atomically in acceptance order, calls ArchiveProvider outside the transaction and outside any held DB mutex, then atomically updates cached provider facts + confirmed status. Older confirmations never erase newer pending intent.
- On a definite fake-provider failure mark failed and remove that intent from the overlay. Failure stays discoverable in activity even if conversation isn't in the inbox. Failed operations are not automatically replayed; a new explicit user action gets a new request ID.
- Interrupted applying archive setters return to queued on startup in original sequence. This is specific to the fixture archive setter, NOT a send recovery policy or a proof about real providers. Fake provider cancellation must let shutdown complete even when paused; leave interrupted work durable.
- Persist all operation history in this small fixture slice (no pagination required). Activity supports opening a referenced conversation and archive/unarchive so confirmed archived items remain recoverable.
- Seed 18 synthetic conversations exactly once with a migration/seed marker. Restart never resets provider facts or operations. Never log subjects, addresses or bodies. Include hostile markup as literal text fixtures.
- Store/SQLite is concrete, not a generic repository framework. Use short serialized transactions; run blocking DB operations off Tauri's async/UI threads.
- Hold an OS-backed profile lock for the full core lifetime; reject a second writer. Fail closed on schema/storage errors. Do not log-and-ignore persistence errors. Halt the worker on persistence failure and surface a queryable/error indication (ask if a DTO change is needed).

## Core seam and shell integration

Core owner should expose a small cloneable/thread-safe `MailCore` facade with list/get/set commands, start/stop worker, and change subscription. It may use synchronous Store methods under a blocking boundary. Report exact API usage in the handoff. `ArchiveProvider` needs only `apply_archive(account_id, message_ids, archived)`; a fake supports success, pause/resume and fail-next for tests. Clock is injectable where needed for deterministic tests. Fake controls aren't a generic production IPC surface. An explicit fixture-only launch environment (`EMAIL_OS_FAKE_PROVIDER=paused|reject|success`) is acceptable for manual pending/failure demos. Bind synthetic profile storage to an app-specific path, never a user's mail.

Shell is thin: acquire/open profile via core, wire three commands, start worker independently of component lifetime, forward change hints, shut down cleanly. Closing the only window quits for this slice; no tray support. Explain that quitting stops processing and pending archive operations recover at next launch. Tauri application commands must be explicitly permission-scoped (AppManifest commands + main-window capability), restrictive CSP, no broad plugins. Plain text only and no automatic remote resource loading.

Browser preview uses a clearly labelled in-memory MailClient fake, NOT a claim of durable native integration. Native path uses actual core/SQLite. UI should subscribe before initial read, refetch on receipt/event/focus/reconnect, guard stale async query results and clean up listeners. Opening is read-only. Keep errors visible; no success toast before provider confirmation. j/k or arrows navigate, Enter opens, Escape returns, e archives, explicit unarchive from reader/activity. Ignore shortcuts in text fields, with modifiers or during IME composition. Predictable selection/focus after archive, empty state, loading/error state, keyboard-accessible buttons.

## Validation

Core: seed once/restart; account-scoped lookup; durable receipt; same-key dedup/payload conflict; queued and interrupted-applying recovery; provider pause does not hold DB lock; failure retained/reverted overlay; archive->unarchive ordering including late confirmation; no overlapping worker claims; profile lock contention; literal hostile mail; storage failures visible. Prefer barrier-driven deterministic tests over sleeps.

UI: query/command fake tests for navigation/focus, pending/failed activity, unarchive, refetch after receipts/events, out-of-order responses, safe plain-text rendering and teardown. Component tests are not macOS WKWebView proof.

Integration: generated contract check, core tests, UI tests/typecheck/build via mise; actual shell compile/smoke if platform prerequisites available. Linux VM cannot validate macOS key handling/IME/WKWebView. Keep that explicit open gate, not an inferred success. Do not install OS-wide native packages without asking; list prerequisites if missing.

## Ownership board

Classification: multi-seam (core persistence/worker tests are independently testable from UI interaction tests).

| Lane | Repo / isolation | Exclusive ownership | Gate | Handoff |
|---|---|---|---|---|
| Parent contract/bootstrap | /home/exedev/email-os, before fanout | this contract, initial mise.toml, root Cargo.toml, .gitignore | contract consistent, tools discoverable | tracked shared base |
| Core | managed isolated worktree of shared base | crates/mail-core/** and root Cargo.lock | mise run test:core; type generation to temp | managed patch + API/validation report |
| UI | separate managed isolated worktree of shared base | src/** (temporary generated.ts), package.json, pnpm-lock.yaml, index.html, vite/vitest/tsconfig configs, UI tests | mise run test:ui; mise run typecheck; mise run build:web | managed patch + report |
| Integration | /home/exedev/email-os, only after both writers finish | apply reviewed component patches; src-tauri/**, mise tasks, docs/dev setup, minimal contract/wiring corrections | integrated mise check/build; native prerequisites noted | final diff + command evidence |
| Review | same integrated cwd, read-only after integration | durability/order, IPC safety, UI contract and mise workflow review | evidence-backed findings | managed review artifact |

No child may spawn other agents, push, publish, connect accounts, inspect secrets, or broaden scope. Component worktree paths are allocated/journaled by the runtime before mutation. Parent retains final acceptance and findings disposition. Keep scratch reports out of the repository.
