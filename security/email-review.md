# Static Security Review — `JakubSzwajka/email`

## Snapshot and executive verdict

- **Repository:** https://github.com/JakubSzwajka/email
- **Reviewed commit:** [`f0af11852b27b17f229979a3e4e7e615a1f8c3dc`](https://github.com/JakubSzwajka/email/tree/f0af11852b27b17f229979a3e4e7e615a1f8c3dc), the supplied **v0.3.1** release snapshot.
- **Identity verification:** Read `.git/HEAD`, its `refs/heads/main` target, and `.git/config`; the commit and origin match the requested target. Checkout cleanliness was supplied by the task, not independently checked with Git.
- **License:** MIT.
- **Platform assessed:** Desktop implementation, principally macOS. **No Android security conclusion is supported by this review.**

**Overall verdict: needs attention.**

| Intended use | Recommendation |
|---|---|
| Disposable-account evaluation | Reasonable only as a controlled experiment with synthetic mail and recipients you control. Avoid trusting autocomplete until F1 is fixed; keep remote images blocked and avoid opening downloaded attachments. Treat send status as unreliable until the outbox issues are addressed. |
| Primary inbox or confidential correspondence | **Not recommended at this snapshot.** A sender-controlled contact display name can become an additional outgoing recipient. Independent send/replay defects can duplicate or lose mail, and incremental sync can silently skip changes. |
| Basis for a personal macOS client | The architecture and several defensive controls are useful foundations, but recipient handling, durable sending, and packaged-app validation need work before relying on it. |

**Highest priority:** F1 is a remotely supplied-input confidentiality issue requiring subsequent user interaction. F2 is a high-confidence concurrent-send defect. F3–F7 concern delivery integrity, inbox completeness, and credential cleanup.

No P0 issue or working HTML-to-native-code execution chain was established. **No-finding does not establish safety. No exploitation, delivery, test success, or platform protection was verified at runtime.**

## Method and limits

This was a bounded, whole-codebase, risk-led **static** review—not a diff review. I read source and relevant test implementations, traced important inputs through callers to sinks, and inspected configuration, manifests, selected lockfile entries, release workflow, and security documentation.

No repository files were changed. No dependencies were installed. No project code, tests, builds, shell commands, account connections, credentials, network attacks, or issue publication were used.

Coverage emphasized:

- Gmail message mapping, HTML sanitization and rendering, CID images, attachment previews and downloads.
- Tauri command registration, capabilities, CSP, and frontend-compromise impact.
- OAuth loopback capture, state/PKCE, token storage and cleanup.
- Recipient construction, outgoing MIME, account selection, send holds, durable outbox and incremental sync.
- External-service boundaries and release/package trust.

“Confirmed” below means **the defect and reachable application path are supported by inspected source**. It does not mean successful exploitation was demonstrated. Proposed validation steps are future work, preferably using isolated fixtures and fake providers without contacting Gmail.

## Confirmed source-supported findings

### F1 — [P1] Contact display names can introduce additional outgoing recipients

**Confidence:** High for the source-level recipient expansion; actual Gmail delivery not tested.  
**Attacker prerequisites:** Deliver a message that is ingested, controlling a display name in its From/To/Cc metadata; subsequently induce the user to select the affected autocomplete contact and send mail.

**Primary locations:** [`src/components/ComposeCard.tsx:55–59`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src/components/ComposeCard.tsx#L55-L59), [`113–122`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src/components/ComposeCard.tsx#L113-L122).

Incoming quoted display names are preserved by the Gmail mapper. Message ingestion adds From/To/Cc addresses to the contact book and overwrites existing display names. Autocomplete then interpolates a selected name into an unquoted string, which `parseAddresses` splits at **every comma or semicolon**. Consequently, selecting one contact can generate more than one recipient. For example, the valid quoted mailbox `"copy@attacker.example, Finance" <finance@partner.example>` becomes the contact `{email: finance@partner.example, name: "copy@attacker.example, Finance"}`; selecting it produces `copy@attacker.example, Finance <finance@partner.example>, `, which the composer converts into two recipient objects.

- **Reachable path:** Gmail headers → [`provider/gmail/map.rs:77–85, 229–230`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/provider/gmail/map.rs#L77-L85) → [`store/messages.rs:692–719`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/store/messages.rs#L692-L719) → contact suggestion → `pick` → `parseAddresses` → [`ComposeCard.tsx:180–192`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src/components/ComposeCard.tsx#L180-L192) → outgoing MIME/Gmail send.
- **Impact:** Subsequent mail intended for one contact can include an attacker-controlled recipient. The contact table and suggestions are global, so poisoning through one connected account can affect composition from another.
- **Existing mitigation:** The suggestion displays its email address, and the expanded text is visible in the recipient field. This is not an invisible/Bcc injection, and it requires selection and sending. React escaping prevents HTML injection but does not prevent address-list reinterpretation.
- **Safe validation:** Use a synthetic mapped-message fixture and an in-memory contact store. Select the fixture contact and inspect the resulting `Draft.to` without sending. Assert that selection preserves exactly one mailbox. Include commas, semicolons, quotes and backslashes.
- **Smallest fix:** Preserve selected contacts as structured `Address` objects. A narrow interim fix is to insert only a validated mailbox address on autocomplete selection. Quoting the name alone is insufficient while the parser still blindly splits quoted commas. Add mailbox validation at the backend send boundary.

### F2 — [P1] Concurrent outbox replay can submit the same send more than once

**Confidence:** High.  
**Attacker prerequisites:** None; overlapping normal application operations suffice.

**Primary location:** [`crates/mailcore/src/sync/mod.rs:505–515`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/sync/mod.rs#L505-L515).

`replay_outbox` reads pending rows, performs remote operations, then deletes successful rows without an exclusive replay guard or atomic claim. Two callers can read the same send row before either deletes it and both call `provider.send`. The `Mailbox::poll_all` single-flight guard only prevents two polls; it does not serialize polling against mutation-triggered replay or background send flushing.

- **Reachable path:** Refresh → `poll_once` → replay, concurrently with archive/read/star/send → `best_effort_replay`; the independent timer also flushes sends at [`src-tauri/src/lib.rs:139–145`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src-tauri/src/lib.rs#L139-L145). Compare the narrower guard at [`commands/mod.rs:579–583`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/commands/mod.rs#L579-L583).
- **Impact:** Duplicate outgoing submissions during ordinary use, without a process crash or ambiguous server response.
- **Existing mitigation:** Rows are account-scoped, and held-send removal uses a mutex. Neither protects replay of an already-persisted outbox row. The existing deduplication test checks repeated ingestion of the same sent message ID, not concurrent remote sending.
- **Safe validation:** Queue one send while a fake provider is offline. Re-enable it, block its first send on a barrier, and trigger replay through another caller. Count provider submissions; require exactly one.
- **Smallest fix:** Serialize replay per account, taking an async lock **before** reading pending rows and holding it through completion/deletion. If multiple processes may share the database, use a durable claim/lease instead of relying solely on an in-process lock.

### F3 — [P2] Unknown-outcome sends are automatically eligible for resubmission

**Confidence:** High for retry behavior; duplicate delivery under a lost-response scenario was not tested.  
**Attacker prerequisites:** None. A connection failure after server acceptance, or termination after acceptance but before local acknowledgment, is sufficient.

**Primary locations:** [`crates/mailcore/src/sync/mod.rs:510–520`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/sync/mod.rs#L510-L520), [`550–553`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/sync/mod.rs#L550-L553).

A network error leaves the send row queued even when the remote service may already have accepted the message. A later replay submits it again. There is no persisted “outcome unknown” state, and the successful `SentMessage` is discarded. Outgoing MIME deliberately omits a stable Message-ID, so local message-ID-based upsert deduplication does not provide send idempotency.

- **Reachable path:** Durable `OutboxOp::Send` → Gmail `messages/send` → lost response → queued row retained → later refresh/mutation replays it. See [`provider/gmail/provider.rs:302–318`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/provider/gmail/provider.rs#L302-L318) and [`mime/mod.rs:43–45`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/mime/mod.rs#L43-L45).
- **Impact:** A second submission can produce duplicate correspondence after a transient failure. This is distinct from F2: serializing replay does not solve unknown outcomes.
- **Existing mitigation:** Requests survive ordinary offline conditions. That durability is useful, but non-idempotent sends need different retry semantics from label mutations.
- **Safe validation:** Have a fake provider record acceptance and then return `ProviderError::Network`. Replay again and inspect submission count and visible state; no real mail is needed.
- **Smallest fix:** Persist send-attempt state and surface ambiguous outcomes instead of blindly resending. A stable RFC Message-ID and Sent-folder reconciliation can aid recovery, but must not be assumed to make Gmail’s send endpoint idempotent.

### F4 — [P2] Accepted sends remain memory-only during the hold window and are lost on exit

**Confidence:** High.  
**Attacker prerequisites:** None; normal application exit during a send hold suffices.

**Primary location:** [`crates/mailcore/src/commands/mod.rs:473–480`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/commands/mod.rs#L473-L480).

`compose_send` returns a send ID after storing the full request only in `pending: Mutex<Vec<PendingSend>>`. It is not yet in SQLite. Fresh composition closes and the UI labels it “sent,” while a new `Mailbox` starts with an empty pending vector. The inspected frontend/native sources contain no quit handler using the exposed `pending_send_ids` or `flush_all_sends` commands.

- **Reachable path:** Compose → successful `compose_send` → [`src/App.tsx:383–404`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src/App.tsx#L383-L404) → exit before flush → restart with [`commands/mod.rs:76–82`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/commands/mod.rs#L76-L82).
- **Impact:** Newly composed mail can disappear despite the success feedback; this path does not automatically save a recovery draft.
- **Existing mitigation:** A frontend timer and 30-second native timer flush holds while the process remains alive. The durable outbox protects requests only after that transition.
- **Safe validation:** With a temporary store and fake provider, compose a delayed send, destroy the `Mailbox`, then reopen it against the same store. Check whether the request can be recovered.
- **Smallest fix:** Persist held sends and their deadlines before acknowledging them; implement undo as cancellation of that durable record. A quit prompt is useful but does not address crashes.

### F5 — [P2] One flush error drops later due sends before they enter the outbox

**Confidence:** High.  
**Attacker prerequisites:** None; an authentication, store, or removed-account error affecting an earlier due send suffices.

**Primary locations:** [`crates/mailcore/src/commands/mod.rs:510–516`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/commands/mod.rs#L510-L516), [`519–522`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/commands/mod.rs#L519-L522).

`flush` removes **all** due requests from shared pending state before processing them. Its loop then uses `?` on each `engine(...).send(...)`. If an early request errors, the unprocessed remainder of the local vector is dropped, although those later requests have never been enqueued. For example, two due sends can lose the second when the first account requires reauthentication.

- **Reachable path:** Native timer or refresh → drain due vector → first enqueue/replay returns error → early return drops remaining requests.
- **Impact:** Silent loss of later mail, potentially for another otherwise healthy account. The native timer discards the flush error at [`src-tauri/src/lib.rs:143–144`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src-tauri/src/lib.rs#L143-L144).
- **Existing mitigation:** The first request may already be durable, and ordinary network-offline replay retains queued rows. Neither protects later requests still only in the drained vector.
- **Safe validation:** Queue two due requests; make the first fake provider return an authentication error. Verify that the second remains pending or durable afterward.
- **Smallest fix:** Durably enqueue requests before attempting remote replay, and do not drop any request that failed to reach durable storage. Prefer a transactional held-to-outbox transition; otherwise restore unprocessed requests on failure.

### F6 — [P2] History fetch failures are skipped while the cursor advances past them

**Confidence:** High.  
**Attacker prerequisites:** None; a non-404 failure fetching an individual changed message is enough.

**Primary location:** [`crates/mailcore/src/provider/gmail/provider.rs:278–283`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/provider/gmail/provider.rs#L278-L283).

`history_delta` logs and skips non-404 message-fetch failures, then returns the batch’s latest history cursor. The sync engine applies the incomplete batch and stores that cursor. Contrary to the adjacent comment, the next incremental poll starts **after** the skipped change rather than retrying it. A new message or security notification can therefore remain missing until another change or separate reconciliation happens.

- **Reachable path:** Successful Gmail history listing → failed changed-message fetch → [`provider.rs:290–293`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/provider/gmail/provider.rs#L290-L293) → [`sync/mod.rs:159–166`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/sync/mod.rs#L159-L166).
- **Impact:** Incomplete or stale local mail state while polling can report `Idle`.
- **Existing mitigation:** Startup reconciliation can repair portions of the last-year inbox. It is not an immediate retry queue and does not cover all cached mail. Skipping genuine 404s is separately reasonable.
- **Safe validation:** Use a fake Gmail transport returning a changed ID, then a non-404 fetch error. Verify that the stored cursor remains unchanged and the fetch is attempted again after recovery.
- **Smallest fix:** Propagate non-404 fetch failures so the cursor is not advanced. Alternatively, persist failed IDs for guaranteed retry before acknowledging progress.

### F7 — [P2] Disconnect reports success even if keychain token deletion fails

**Confidence:** High.  
**Attacker prerequisites:** A keychain deletion failure; later credential misuse would additionally require access permitted by the OS keychain. This is not a demonstrated remote token theft.

**Primary location:** [`src-tauri/src/commands.rs:570–574`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src-tauri/src/commands.rs#L570-L574).

The disconnect command deletes the account’s local state, ignores the result of keychain deletion, and returns success. The UI explicitly promises to remove “mail + tokens.” If the keychain backend rejects deletion, a refresh token can remain while the account disappears from the UI and no cleanup failure is reported.

- **Reachable path:** [`src/components/Settings.tsx:172–181`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src/components/Settings.tsx#L172-L181) → `remove_account` → ignored `SecretStore::delete`.
- **Impact:** Credential retention contrary to the disconnect confirmation, with no visible retry path.
- **Existing mitigation:** [`secrets/mod.rs:129–133`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/secrets/mod.rs#L129-L133) correctly treats an already-absent entry as success and propagates other errors. The bridge discards that distinction. Remaining secrets are still protected by the OS keychain.
- **Safe validation:** Inject a fake secret store that fails deletion and verify that disconnect reports cleanup failure and retains retryable account identity. Do not manipulate real credentials.
- **Smallest fix:** Propagate deletion errors and retain a retryable cleanup state rather than presenting complete removal. Distinguish local deletion from revoking Google’s authorization grant.

## Positive controls and trust-boundary assessment

### Hostile HTML and remote content

The primary message-read path has meaningful defense in depth:

- [`store/messages.rs:344–347`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/store/messages.rs#L344-L347) and its single-message counterpart sanitize stored HTML on read.
- [`html/mod.rs:22–36`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/html/mod.rs#L22-L36) use Ammonia and an explicit URL-scheme list. Test source covers scripts, event handlers, `javascript:` links, iframes, and preserved CID/data images.
- [`ThreadCard.tsx:38–40`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src/components/ThreadCard.tsx#L38-L40) builds a per-message `default-src 'none'` CSP and permits only `data:` images before opt-in.
- [`ThreadCard.tsx:55–60`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src/components/ThreadCard.tsx#L55-L60) uses a sandboxed iframe **without `allow-scripts`**, forms, popups, or top-navigation grants. `allow-same-origin` alone is not evidence of an escape.
- Ordinary subjects, snippets and names are React text, not raw HTML insertions.

The regex that identifies remote images is primarily a banner affordance; the CSP is the blocking mechanism. No confirmed bypass of that combination was identified.

### Tauri IPC and frontend-compromise impact

[`src-tauri/capabilities/default.json`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src-tauri/capabilities/default.json) grants the main window notification-plugin permission and does not declare remote origins. The app CSP restricts scripts to self and network connections to IPC. No general shell-execution or arbitrary-file-read command was found.

However, **notification-only plugin permission does not mean a compromised application frontend has notification-only authority**. The registered custom handlers include mail reads, attachment downloads, compose/send, flush, trash, and account removal: [`src-tauri/src/lib.rs:38–80`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src-tauri/src/lib.rs#L38-L80).

Code executing as the trusted frontend could use those operations across connected accounts. For example, it could read mail and send its contents to another recipient through the legitimate Gmail send command, without directly reading OAuth tokens or using unrestricted `fetch`. **No remote route to that execution context was established here.**

### OAuth and secrets

Positive controls include:

- Fixed Google authorization/token endpoints.
- OS-random state and PKCE verifier, with S256 challenge.
- Listener bound to `127.0.0.1` on an ephemeral port.
- State comparison before authorization-code exchange.
- Account identity obtained from Gmail’s authenticated profile.
- Per-account keychain entries and redacted `Debug` implementations for `AccountSecrets` and `OAuthAppClient`.

Evidence: [`provider/gmail/auth.rs:55–68`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/provider/gmail/auth.rs#L55-L68), [`115–126`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/provider/gmail/auth.rs#L115-L126), [`183–186`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/provider/gmail/auth.rs#L183-L186), and [`secrets/mod.rs`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/secrets/mod.rs).

The OAuth scope is broad `gmail.modify`, including the mail operations this app needs. No active logging of access/refresh tokens was found in inspected call sites. `TokenResponse` does derive unredacted `Debug`, so the stronger claim that *all* token-bearing types are logging-safe would be inaccurate.

### Attachments, SQL and account routing

- Attachment bytes are fetched through the selected account’s authenticated Gmail provider, not an arbitrary sender-supplied download URL.
- [`src-tauri/src/commands.rs:170–174`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src-tauri/src/commands.rs#L170-L174) replaces both slash forms in filenames and chooses a Downloads/app-data directory. No straightforward remote filename traversal or automatic attachment execution was identified.
- Inspected search and message-store queries bind data parameters. No SQL injection was found.
- Messages and threads use account-qualified identities. Outbox reads filter by account, and outgoing From is derived from the selected provider account rather than an arbitrary UI From string.
- The inspected account-isolation and sent-message-upsert tests support these intended controls, but were **not run**.

### External services and local data

No implemented AI/MCP service or telemetry transport was found in the inspected application runtime source. AI/MCP references describe a future integration, not an existing disclosure path. Normal backend network operations use Google endpoints; opted-in email images are a separate sender-controlled network surface.

Mail bodies, metadata, drafts and queued send payloads are stored in ordinary SQLite, not encrypted with the keychain. See [`store/mod.rs:60–67`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/store/mod.rs#L60-L67). This is a local-data exposure consideration, not a demonstrated remote exploit. FileVault, local access policy and backup handling remain important. Desktop notifications can also disclose sender/subject information through OS notification presentation.

## Plausible risks requiring validation — not confirmed exploits

### R1 — Outgoing MIME header handling

**Confidence:** High that unsafe values are interpolated; uncertain that Gmail supplies an exploitable incoming representation.

[`mime/mod.rs:47–68`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/mime/mod.rs#L47-L68) writes header values directly; ASCII subjects pass through unchanged, threading IDs are copied from incoming metadata, and address formatting escapes quotes but not all quoted-string cases. A reachable CR/LF-bearing value could alter outgoing headers, but Gmail’s normalization of malformed incoming headers was not verified. **This is separate from F1, which only needs an ordinary quoted display name.**

Validate with offline fixtures and a strict independent MIME parser; reject CR/LF and validate mailbox/message-ID syntax at the Rust boundary. Do not claim remote header injection based solely on a crafted internal `Draft`.

### R2 — WKWebView navigation, PDF preview and post-sanitization CID handling

**Confidence:** Medium about the surfaces; low about any exploitable escape.

CID resolution performs string replacement after sanitization at [`ThreadCard.tsx:88–96`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src/components/ThreadCard.tsx#L88-L96). PDFs are rendered as data-URL `<object>` elements outside the message iframe at [`ThreadCard.tsx:158–168`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src/components/ThreadCard.tsx#L158-L168). No application-level message-link handler was found.

Validate inert HTML/PDF fixtures on the actual packaged macOS WebView: HTTPS/data/mailto/tel links, frame navigation, CID substitution, PDF links, and attempts to access IPC. These observations are **not evidence that PDF JavaScript executes or email escapes the sandbox**. Prefer typed/DOM-based CID substitution and an explicit link-opening policy.

### R3 — Attachment quarantine and filesystem write safety

**Confidence:** High about the write implementation; platform consequences unverified.

The download path uses `std::fs::write` after an existence check at [`commands.rs:163–189`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/src-tauri/src/commands.rs#L163-L189). No explicit macOS quarantine/provenance marking was found. Actual quarantine behavior and subsequent Gatekeeper treatment require packaged-app testing; **no Gatekeeper bypass is claimed**.

Use a harmless downloaded fixture in a disposable macOS environment to inspect metadata, without executing it. Separately, use exclusive file creation to avoid check/write races and the collision-loop fallback overwriting the original name.

### R4 — Opted-in remote images and resource exhaustion

**Confidence:** Medium; no private-network access or denial of service demonstrated.

“Show images” changes the message image CSP to `* data: blob:`. Treat this as consent to sender-visible requests, not an anonymizing proxy. Private-address/DNS behavior, redirects, referrers and the interaction with the parent CSP should be observed only with controlled endpoints in an isolated test network.

Attachment preview also fetches complete bytes and base64 representations without application-level size/concurrency budgets. Gmail imposes upstream limits, but decoded-image/PDF resource use is platform-dependent. Bound preview size/concurrency and test modest synthetic fixtures; do not assume unbounded local processing is harmless or assert a crash without measurement.

## Additional hardening suggestions

These are not independently established remote vulnerabilities:

- Add bounded OAuth accept/read deadlines and continue waiting after invalid callbacks within that deadline. The current one-shot listener can be stalled or consumed by a local connection; state/PKCE still protect token exchange.
- Redact `TokenResponse::Debug`; parse OAuth error identifiers structurally instead of searching response text for `invalid_grant`.
- Make queued, held, sending, unknown-outcome and failed states visible. `App.refresh` currently awaits but does not interpret returned per-account status tuples.
- Validate attachment MIME types used in generated data URLs. Keep HTML sanitation guarantees explicit for direct-provider APIs such as `search_all_mail`, which bypass store-read sanitization.
- If adding AI/MCP, introduce explicit account/read/send authorization and treat mail as untrusted instructions. Reusing `Mailbox` avoids a second implementation, but does not itself create an authorization boundary.

## Release, dependency and Android limitations

### Package trust

The repository explicitly documents unsigned/un-notarized releases at [`README.md:109–113`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/README.md#L109-L113). The inspected release workflow has no Developer ID/notarization configuration in its build step: [`.github/workflows/release.yml:175–185`](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/.github/workflows/release.yml#L175-L185).

No updater plugin or updater endpoint was found in the inspected app configuration/source. This is therefore primarily a **manual distribution/provenance** concern, not an identified updater-signature bypass. Released binaries, signatures, notarization tickets and source-to-binary correspondence were not inspected. Do not treat removing quarantine as verification of an artifact.

Release actions use version tags rather than immutable action SHAs. That is supply-chain hardening work, not evidence of compromise.

### Dependency audit limitation

Selected locked Rust versions include Ammonia **4.1.3**, Tauri **2.11.5**, Wry **0.55.1**, Keyring **3.6.3**, and the application’s Reqwest **0.12.28** line. These versions alone establish neither vulnerability nor safety.

No `cargo audit`, npm audit, dependency resolution, advisory-database lookup, or build-graph verification was performed. The complete transitive dependency graph was not audited. CI contains a Cargo audit step; `.cargo/audit.toml` includes documented exclusions, and the release gate explicitly omits Cargo audit. Those descriptions were read, **not independently validated**. No CVE claim is made.

### Android

The release matrix ships macOS universal builds. Android icons and a conditional mobile entry point do not establish a working or secure Android port.

An Android candidate needs its own assessment of OAuth redirects, WebView/IPC origin rules, Keystore and backup behavior, storage/download providers, intents, notification privacy, process death/background synchronization and signing/update distribution.

## Coverage, residual risks and next decision

**Relevant test source inspected:** HTML sanitizer cases; OAuth PKCE/state cases; secret-store isolation/redaction; MIME generation; account-scoped outbox replay; sent-message ingestion deduplication; send holds; polling single-flight. None was executed. These tests do not establish coverage of the recipient-poisoning path, overlapping replay, ambiguous acceptance, failure during batch flush, or packaged WebView behavior.

**Important gaps:** OS/WebView internals and dependency source were not audited; no binary/package provenance assessment, real Gmail normalization/delivery experiment, filesystem-permission inspection, or runtime memory/network analysis occurred. Adjacent synchronization behavior—such as disconnect racing with an already-running provider operation—also merits follow-up.

**Suggested order before primary-inbox use:**

1. Fix F1 and add end-to-end fixture coverage from ingested headers through outgoing recipients.
2. Serialize outbox replay and implement durable send-state transitions, including unknown outcomes.
3. Add failure-injection coverage for F3–F7.
4. Validate renderer, link, PDF, download and OAuth behavior on the packaged macOS app with synthetic data.
5. Verify distribution provenance and run current dependency audits in a separately authorized environment.

**Residual conclusion:** The renderer and OAuth implementation contain useful protections, but they do not offset the confirmed recipient-integrity problem and delivery-state defects. This snapshot is suitable for cautious investigation, not an assurance-backed primary inbox.

## Human Reviewer Callouts (Non-Blocking)

- (none — this was a read-only snapshot review; no change was proposed or applied.)