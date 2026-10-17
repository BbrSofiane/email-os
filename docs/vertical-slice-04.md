# Slice 04: plain-text composer and durable local-only drafts

Status: approved implementation contract. The operator chose this slice while testing Slice 03. Branch `feat/local-drafts` is STACKED on `a6e2acf` (`feat/gmail-mailbox-actions`) for profile/credential compatibility; the tested branch and its remote commit must remain unchanged. Do not change OAuth, mutation dispatch/ordering, or sending. No accounts, actual credentials/mail, OS packages, or cloud provisioning in this VM. Parent owns commits/publication; children do not spawn agents or commit/push/publish.

## Scope

New-message and **Reply** plain-text composition, explicit editable To/Cc/subject/body, durable revision-checked autosave, draft list/reopen/discard, save failures/conflicts without silent overwrite, normal native close/quit flush. No Send button/action/IPC, outbox, provider draft synchronization, attachments, HTML/rich text, AI, new OAuth scopes, or automatic read/archive. Reply-all/Bcc and signatures/automatic quoted bodies are deferred; Reply never copies To/Cc implicitly.

Drafts are explicitly local to this profile/device. Browser preview remains synthetic, in-memory and non-durable (never call its acknowledgement durable). Only acknowledged saves survive a crash/force quit; normal close/quit must flush the latest buffer and stay open on failure/conflict. Checkpoint: start a reply, edit recipients/subject/body, normally quit/restart, recover the exact text; interrupted/stale saves cannot silently overwrite newer edits.

## Persistence/account/lifecycle policy

Use concrete separate `local-drafts/drafts.db` below the existing selected fixture/Gmail profile, with its own OS profile lock and short FULL/WAL transactions; do not couple to the 100-conversation cache or mutation worker. All account IDs/draft IDs/request keys are scoped and parameterized. Local drafts remain usable offline/auth-expired when cached account identity exists; no Gmail modify permission is needed. Native derives the active account from backend status, never trusts an account object from JS.

Disconnect RETAINS local drafts, unlike mail-cache/operation cleanup. Warn clearly: local drafts remain on this device, accessible after reconnecting the same account; confirmed remote actions are not undone. Before UI-initiated disconnect/account transition, flush/close the active editor; failure prevents the transition and preserves the buffer. Other account data must never appear in the new account. Native serializes draft operations and disconnect with a lifecycle/session gate; if a reply metadata read requires network, release the gate during the read and recheck account/session epoch before draft creation. Never hold SQLite/control locks during network. Query/save/delete for a DraftRef not matching the active account are rejected. Same-account reauth does not invalidate drafts. No silent draft deletion on cache eviction, auth failure or restart.

The core stores incomplete/invalid recipient text AS TYPED because autosave must not lose partially edited addresses. Save is not recipient validation or send readiness. No trim, Unicode normalization, silent address expansion, subject/body rewriting, or sending. Bound To/Cc to 16 KiB each, subject to 4 KiB, body to 1 MiB UTF-8; surface invalid_request rather than truncate. List returns summaries only (all small-slice drafts; no silent truncation), not bodies. Discard is revision-checked and explicitly confirmed in UI. Request tombstones/receipts contain no body; late saves after deletion do not resurrect a draft. No secure-erasure guarantee is implied by record deletion.

## Frozen wire contract (Rust-owned/generated)

Add types under `mail_core::drafts::types` and generated exports. CamelCase fields, snake_case discriminants, opaque string IDs/ISO UTC times, u32 revisions start at 1:

- `ReplyContext = { sourceMessageId: string; fromMailbox: string; replyToMailboxes: string[] | null; messageId: string; references: string[] }`. null replyTo means the header was absent, not malformed. Optional `Conversation.replyContext?`; absence means metadata unavailable. Existing reading remains unaffected.
- `DraftRef = { accountId: string; draftId: string }`.
- `DraftContent = { to: string; cc: string; subject: string; bodyText: string }` (raw editor fields, unvalidated for sending).
- `DraftSource = { kind: 'new_message' } | { kind: 'reply'; conversation: ConversationRef; sourceMessageId: string }`.
- `DraftReplyLink = { conversation: ConversationRef; sourceMessageId: string; messageId: string; references: string[] }`; immutable, captured from trusted cached/refreshed metadata on create.
- `Draft = { ref: DraftRef; revision: number; createdAt: string; updatedAt: string; content: DraftContent; source: DraftSource; replyLink: DraftReplyLink | null }`.
- `DraftSummary = { ref: DraftRef; revision: number; updatedAt: string; subject: string; to: string; source: DraftSource }`.
- `DraftReceipt = { ref: DraftRef; revision: number; savedAt: string }`; returned only after commit.
- `DraftDeleteReceipt = { ref: DraftRef; deletedAt: string }`.
- `CreateDraft = { requestId: string; source: DraftSource; initialContent: DraftContent | null }`. null means blank/prefilled defaults; initialContent permitted ONLY for new_message (e.g. explicit Save as new local draft after conflict).
- `SaveDraft = { ref: DraftRef; expectedRevision: number; requestId: string; content: DraftContent }`.
- `DeleteDraft = { ref: DraftRef; expectedRevision: number; requestId: string }`.
- `MailError` adds `draft_conflict { currentRevision: number }` and `reply_unavailable`; reuse not_found/invalid_request/auth_required/storage_unavailable/profile_in_use/request_id_conflict. Never put content/addresses/headers in routine logs or errors; DraftContent Debug is redacted.

IPC: `list_drafts` (no args -> DraftSummary[]), `get_draft` ({ ref } -> Draft), `create_draft` ({ command } -> DraftReceipt), `save_draft` ({ command } -> DraftReceipt), `delete_draft` ({ command } -> DraftDeleteReceipt). `drafts_changed` is an empty change hint; subscribe before initial list, refetch on focus/reconnect/events, never overwrite an active dirty buffer from a background query.

MailClient additions: listDrafts/getDraft/createDraft/saveDraft/deleteDraft/subscribeDrafts, exact camelCase mappings. No general execute/SQL/FS/HTTP, no provider draft/send command.

## Core API / revision and retry semantics

`DraftCore::open(profile_dir: impl AsRef<Path>) -> Result<Self,MailError>` opens the dedicated local-draft subprofile supplied by shell (the argument is already `<selected-profile>/local-drafts`). Cloneable/thread-safe, no worker/network/Tauri dependency. Methods:

- `list_drafts(account: &AccountInfo)` -> Vec<DraftSummary>
- `get_draft(account: &AccountInfo, ref: &DraftRef)` -> Draft
- `lookup_create_receipt(account: &AccountInfo, command: &CreateDraft)` -> Option<DraftReceipt> (lets shell dedup before fetching reply metadata)
- `create_draft(account: &AccountInfo, command: &CreateDraft, conversation: Option<&Conversation>)` -> DraftReceipt
- `save_draft(account: &AccountInfo, command: &SaveDraft)` -> DraftReceipt
- `delete_draft(account: &AccountInfo, command: &DeleteDraft)` -> DraftDeleteReceipt

All methods return Result<_,MailError>. AccountInfo is supplied by trusted native adapter/test, not UI. Verify ref/source account matches it. Create/save/delete atomically persist content/revision/request mapping before ACK. Request-key lookup precedes deriving reply defaults/current revision/existence checks: same account+key+identical command returns the exact original receipt even after newer saves/deletion; different payload conflicts. Hashes may fingerprint bounded JSON (sha2 already available). Request keys max128 bytes; no inferred success. Revision stale => draft_conflict(currentRevision) with no write; overflow fails closed. Save never creates missing drafts. Delete never races a stale save into resurrection. IDs opaque, random UUIDs acceptable; migration never reseeds/reset existing drafts. Storage/schema errors visible, no log-and-ignore.

## Safe reply preparation and cache metadata

Reply targets the explicitly displayed latest message (`sourceMessageId` captured on click), not a silently substituted message. Real replies require complete plaintext context, a matching source ID, non-retained current cache (retainedSnapshotAt absent), valid From/Reply-To and RFC Message-ID/reference metadata. Default deny if unavailable/ambiguous. Never infer a recipient from display names. Parse raw address grammar before decoding words, reject groups/ambiguous malformed headers. Reply-To header absent -> From mailbox; present but invalid/empty -> unavailable, not fallback. Canonical single-mailbox strings only; bounded <=20 reply-to recipients, each <=254 bytes, no CR/LF/controls. Ignore display names for prefill. Dedup mailboxes case-insensitively and exclude the known primary account address; if none remain, deny. Do not infer aliases/dot/plus equivalence; recipient review remains explicit. Replies to the account's own latest sent message are unsupported in this slice. Cc starts empty. Subject gets one Re: prefix; body blank, not automatically quoted.

RFC Message-ID must be one bounded `<id@domain>` token without controls/whitespace/injection; References (or single valid In-Reply-To if References absent) bounded to 100 IDs /16 KiB total, append source Message-ID once without silently truncating. Core independently validates before persisting DraftReplyLink; it is immutable on save and survives source cache eviction. Invalid/missing headers never break ordinary reading.

Metadata owner adds optional cached reply-context JSON additively to the Gmail conversation cache and fixture reader, with absence on legacy rows. Fixture uses the real fixture primary `you@fixture.emailos`, synthetic RFC IDs and explicit absent Reply-To; native/fake fixture account email must agree.

Legacy rows need a practical readonly enrichment path: add `GmailCore::load_reply_context(ref: &ConversationRef, source_message_id: &str) -> Result<Conversation,MailError>` as a narrow cached/read helper. It may read get_thread through the existing provider when metadata is missing, outside locks; verify account/conversation/source ID/context, generation and currently cached latest-message identity before saving ONLY the reply metadata column. No body/label/cursor/operation updates, no mutation-worker scheduling change. Current cached get_conversation remains network-free. Backend checks create receipt first; no metadata RPC for a duplicate create. UI may offer Prepare reply from complete cached text with a known latest source ID even if headers need this explicit read. Offline new-message editing and existing-draft editing always work; a first reply lacking cached headers may need this read or must explain unavailability. No new scope or write permission.

## Native close/quit protocol (no silent last-keystroke loss)

Native Window CloseRequested and RunEvent ExitRequested intercept normal close/quit until current dirty/pending saves ACK. Add `AppCloseRequest = { requestId: string }`, event `app_close_requested` carrying it, and narrow commands `get_app_close_request` (-> AppCloseRequest|null), `complete_app_close` ({ requestId }, void), `cancel_app_close` ({ requestId }, void). Close requests are in-memory, coalesce while pending, and use a fresh opaque ID after cancellation. Complete/cancel must match the active request; stale completion can never close a later editing session. Completion is rejected without a native close request; it is not generic window control. Gate completion authorizes final app.exit, whose final Exit stops existing mail worker as before.

MailClient: subscribeAppClose(listener(request)), completeAppClose(requestId), cancelAppClose(requestId). Native transport listens before querying pending close to recover a missed early hint; dedup repeated request IDs. On close, freeze/flush the latest active buffer (drain one-in-flight/coalesced saves), then complete only the still-current request. On failure/conflict keep the window/buffer open, cancel that close request and show the error; no forced discard or unacknowledged 'saved' claim. No cancel/edit after final completion dispatch. Source/session changes and late callbacks cannot complete an old close. A tiny headless CloseGate helper/test is allowed in drafts module, owned by integration; no general lifecycle framework. Browser preview fake models the protocol but never claims persistence; beforeunload warns when dirty/pending, no durable reload promise. Force quit/OS crash before ACK is explicitly not guaranteed.

## Composer interaction / tests

One active editor, local ref/revision/acknowledged content plus latest editable buffer, one save in flight and coalesced subsequent changes. Debounce is fine; flush on explicit close/switch/account transition/native quit. On transport failure retain the original save request (same ID/payload) for retry before sending newer edits. Acknowledging an older edit snapshot must not mark newer edits saved. Conflict freezes autosave and preserves exact buffer; explicit Reload saved version warns it discards edits, or Save as new local draft persists an independent new_message copy atomically (no hidden threading). Discard has explicit confirmation and expected revision; no late autosave resurrects it. Active draft never overwritten by background list/event/refetch; stale load/save responses and deleted/account-changed drafts handled visibly. Keep editing in place on save error.

Composer disables mailbox shortcuts regardless of focus, respects IME/modifiers, supports keyboard-accessible New draft/Reply/Close/Discard controls. No active Send/submit shortcut, no Cmd/Ctrl+Enter send. All text escaped/bound as text, no v-html/markdown/remote resources. Local-only/no-send and invalid/incomplete-recipient text policy visible; native saved label only after committed receipt; browser says saved in preview memory/non-durable. List/open remains account-scoped and recovers recipient/subject/body edits after restart.

Core tests: seed-free reopen/migration, account isolation, exact Unicode/text recovery, receipt dedup/conflict across newer saves/delete, revision CAS/concurrent saves, failed commit no ACK, delete vs late save/no resurrection, max sizes/overflow, profile lock; reply-to vs From/encoded punctuation/self/duplicates/malformed/missing threading/stale source/incomplete/retained context and stored link after source eviction. Metadata tests synthetic full payload, missing/ambiguous/malformed headers, legacy metadata enrichment read-only/no cursor/labels, account/generation/source race, unchanged ordinary reading.

UI tests: create/reopen, exact recovery fields, debounce/one-in-flight/new edits during save, rejected/lost ACK retry keys, conflict/reload/copy, discard/deferred saves, stale loads/account/disconnect, background events, native close/cancel/error/old request races, no send path, keyboard/IME, safe text rendering/teardown. Native session gate and CloseGate tests where headless; native compile/smoke prerequisite-gated (no OS installs). Parent independently checks core/contract/fmt/clippy/UI/typecheck/web build. Mac normal window close and Cmd+Q with immediate last edits are explicit gates.

## Ownership board

Classification multi-seam: draft persistence/reply rules, readonly metadata capture/cache, and UI/editor races are independently testable; native integration only after handoffs. Managed worktrees journal paths before mutation. Parent bootstrap owns this frozen contract, draft DTO/types, errors/generator, optional Conversation.replyContext and required None constructor defaults.

| Lane | Exclusive edits | Isolation / gate / handoff |
|---|---|---|
| Draft core | drafts/store.rs (+ optional replies.rs), drafts/mod.rs exports, distinct drafts tests | managed worktree; temp SQLite + pure reply tests, clippy; managed patch + exact API/evidence |
| Reply metadata | gmail/provider.rs, gmail/store.rs, fixture store.rs; gmail/sync.rs ONLY new load_reply_context method and metadata byte accounting; distinct metadata tests | separate managed worktree; synthetic HTTP/cache/migration tests, no auth/setter/worker-state edits; managed patch |
| UI | src/** except generated.ts, tests/** | separate managed worktree; Vitest/typecheck/build, fake accurately labelled; managed patch |
| Integration | apply owned patches; src-tauri/**, drafts/close_gate.rs export/tests, docs/tasks, minimum seam corrections | main checkout after component owners; typed commands/session/close gates, full validation + exact diff/log artifacts |
| Review/fix | readonly source-evidenced integrity vs UI/native reviews, then one fix writer | bounded rounds, focused rechecks, final parent acceptance |

No child changes shared contracts/dependencies without supervisor approval. Scratch artifacts outside checkout. No changing the tested Slice03 branch, accounts, secrets, OAuth permissions, mail mutation logic or real mail. Publication retained by parent.
