# Pebble v0.1.5 — Bounded Static Security Review

## Snapshot and method

- **Repository:** https://github.com/QingJ01/Pebble
- **Reviewed commit:** [`e43341cc59b8efda8d55f3de8584419cefa44c88`](https://github.com/QingJ01/Pebble/tree/e43341cc59b8efda8d55f3de8584419cefa44c88), supplied as the v0.1.5 release commit.
- **Checkout:** `/tmp/email-security-review.PDYa6I/pebble`
- **Identity verification:** Read `.git/HEAD`, the referenced branch file, and `.git/config`; they match the supplied commit and repository. Clean working-tree status was supplied by the task, not independently checked with Git.
- **Method:** Read-only, bounded whole-codebase review of selected Rust/Tauri and React trust boundaries, callers, configuration, and test source. This is not a diff review or an exhaustive audit.
- **No execution:** No project code, builds, tests, dependency installation, account connections, credentials, network probes, or exploits were run. No repository files were changed.

“Source-supported finding” below means the defective logic and reachable application path were identified statically. **It does not mean exploitation was successfully tested.** Browser-specific outcomes still require validation in the packaged macOS WebView.

## Executive verdict

**Overall verdict: needs attention.**

| Intended use | Recommendation |
|---|---|
| Disposable-account evaluation | **Conditional go**, in an isolated macOS user/profile without sensitive files or credentials. Begin with synthetic offline fixtures; enable account access only after renderer checks. |
| Primary inbox | **Do not approve on this review alone.** Fix and validate the rendering findings first, then evaluate packaged-app trust, secret handling, and send-failure behavior. |
| Reuse as an application foundation | Potentially useful architecture and security controls, but the email renderer needs a stronger trust boundary. AGPL-3.0 is a reuse/licensing constraint, not a vulnerability. |
| Future Android support | **Not assessed.** Desktop code and a mobile entry-point annotation do not establish Android security. |

The highest-value concerns are:

1. Embedded email CSS can escape the intended message **visual** boundary in the default privacy mode.
2. The embedded-CSS network filter can be bypassed with CSS escapes.
3. Mixed-case image URL schemes bypass Strict-mode image blocking.
4. Gmail header logging contains a conditional remotely supplied UTF-8 panic.

All four are rated **P2**, with different prerequisites detailed below. No P0 issue, arbitrary native-code execution, or complete email-to-IPC JavaScript exploit chain was established.

The presence of DOMPurify, Ammonia, CSP, PKCE, and encrypted credential storage is encouraging. **A no-finding in any other reviewed area does not establish safety.**

---

## Source-supported findings

### F1 — [P2] Embedded email CSS can cross the message’s visual boundary

**Confidence:** High that unrestricted positioning CSS reaches the renderer; medium-high for the precise overlay extent in the packaged macOS layout.

**Attacker prerequisites:** Deliver an HTML email that the user opens or expands. Default settings suffice: the frontend defaults to `relaxed`, mapped to `LoadOnce`.

**Evidence and reachable path:**

- Default mode: [`src/lib/privacyMode.ts:4–5`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src/lib/privacyMode.ts#L4-L5), [`:21–27`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src/lib/privacyMode.ts#L21-L27).
- `LoadOnce` permits embedded styles: [`crates/pebble-privacy/src/sanitizer.rs:113–121`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-privacy/src/sanitizer.rs#L113-L121).
- Embedded rule bodies are retained when they contain no recognized network/script tokens; unlike inline styles, they do not receive the property allowlist: [`sanitizer.rs:545–553`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-privacy/src/sanitizer.rs#L545-L553).
- The frontend extracts `<style>` contents before DOMPurify and reattaches them afterward: [`src/lib/sanitizeHtml.ts:160–163`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src/lib/sanitizeHtml.ts#L160-L163), [`:210–212`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src/lib/sanitizeHtml.ts#L210-L212).
- The result enters a Shadow DOM, not a sandboxed document: [`src/components/ShadowDomEmail.tsx:17–22`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src/components/ShadowDomEmail.tsx#L17-L22).

An email style rule using `position: fixed`, viewport-sized dimensions, and a high `z-index`, or a `:host` rule, survives these checks. Shadow DOM scopes selectors but is not a security or viewport-containment boundary.

**Impact:** An email can potentially cover message headers and surrounding application content with misleading app-like notices or links. This supports UI impersonation and phishing; it is **not** evidence of JavaScript execution, reading sibling DOM content, or programmatically activating native commands.

**Existing mitigations:** Strict mode removes embedded styles. Inline style attributes have a property allowlist. Script/event-handler sanitization and CSP reduce script execution opportunities, but do not prohibit these CSS rules.

**Tests inspected:** Backend tests cover safe embedded styles and prohibit positioning in *inline* styles. Frontend tests explicitly preserve “backend-approved” styles. The inspected tests do not verify visual containment of hostile embedded styles.

**Safe validation:** In an isolated, offline macOS profile, render a synthetic message containing an unmistakable “TEST OVERLAY” block with fixed positioning. Check whether it paints outside the message viewport and obscures sender identity or application controls. Do not imitate a real login or collect input.

**Smallest fix:** Stop retaining email `<style>` blocks in the privileged Shadow DOM; keep the existing inline-style allowlist. If full stylesheet fidelity is required, use a separately sandboxed rendering document with scripts disabled, a restrictive resource policy, and explicit navigation handling.

### F2 — [P2] Escaped CSS imports bypass the default-mode external-stylesheet filter

**Confidence:** High for the filter bypass; actual WebView requests were not observed.

**Attacker prerequisites:** Deliver an HTML email and have it rendered under default `LoadOnce`, sender-trusted mode, or an explicit image-loading override.

**Evidence and reachable path:**

- Literal `@import` removal: [`crates/pebble-privacy/src/sanitizer.rs:522–535`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-privacy/src/sanitizer.rs#L522-L535).
- Other remote-loading checks examine brace-delimited rule bodies, while unmatched/trailing text is preserved: [`sanitizer.rs:539–547`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-privacy/src/sanitizer.rs#L539-L547), [`:554–560`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-privacy/src/sanitizer.rs#L554-L560).
- Preserved CSS is reinserted by [`src/lib/sanitizeHtml.ts:160–163`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src/lib/sanitizeHtml.ts#L160-L163).
- CSP permits inline styles and HTTPS stylesheets: [`src-tauri/tauri.conf.json:33`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src-tauri/tauri.conf.json#L33).

For example, the CSS statement `@\69mport "HTTPS://example.invalid/probe.css";` has no literal `@import` and no braces. It therefore avoids both filtering stages while expressing a CSS-escaped import. The uppercase URL also avoids the application’s lowercase-only text URL linkifier at [`sanitizer.rs:1076–1078`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-privacy/src/sanitizer.rs#L1076-L1078).

**Impact:** External CSS can be fetched in modes intended to strip external stylesheets. A unique request can disclose message-opening time and network address. Fetched CSS is not passed through the application sanitizer and can introduce additional resource loads or visual deception. This bypasses the CSS protection, rather than merely relying on the intentional default loading of ordinary images.

**Existing mitigations:** Ordinary literal imports and recognized URL-bearing rule bodies are removed in `LoadOnce`; Strict mode removes the entire style element. The flaw is the mismatch between string scanning and CSS parsing.

**Tests inspected:** `load_once_filters_remote_loads_from_embedded_style_tags` tests an ordinary import and a complete `url(...)` rule at [`sanitizer.rs:1483–1492`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-privacy/src/sanitizer.rs#L1483-L1492). It does not cover escaped at-rules or incomplete CSS blocks.

**Safe validation:** First inspect the output of the complete backend-plus-frontend rendering pipeline with a reserved `.invalid` hostname. Under separate authorization, use a reviewer-controlled HTTPS endpoint serving inert CSS and record only whether the request occurs. Do not target tracking services or internal-network systems.

**Smallest fix:** Remove embedded styles in these modes. If retaining them, parse CSS and reconstruct only allowed rules/declarations; reject imports, external resource values, and malformed constructs. Add escaped-keyword and missing-closing-brace regressions. String matching should not be the privacy boundary.

### F3 — [P2] Mixed-case image schemes bypass Strict privacy mode

**Confidence:** High from source and standard URL semantics; no network request was tested.

**Attacker prerequisites:** Deliver an HTML email that the user views, even after choosing Strict mode. No trusted-sender entry is required.

**Evidence and reachable path:**

- Image blocking recognizes only literal lowercase prefixes: [`crates/pebble-privacy/src/sanitizer.rs:935–945`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-privacy/src/sanitizer.rs#L935-L945).
- Domain extraction has the same case-sensitive prefix handling: [`sanitizer.rs:954–963`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-privacy/src/sanitizer.rs#L954-L963).
- Ammonia is configured to permit HTTP/HTTPS URLs: [`sanitizer.rs:725–732`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-privacy/src/sanitizer.rs#L725-L732).
- Render commands pass stored email HTML through this guard: [`src-tauri/src/commands/messages/rendering.rs:40–44`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src-tauri/src/commands/messages/rendering.rs#L40-L44). The frontend retains image `src`, and CSP permits HTTP/HTTPS images.

An image such as `<img src="HTTPS://example.invalid/open-id">`, without pixel dimensions, avoids the lowercase external-image test. The domain helper treats `HTTPS:` as the apparent domain, also defeating the intended known-domain check. HTTP URL schemes are case-insensitive to URL parsers and browsers.

**Impact:** Viewing a message can trigger a tracking request despite the user’s explicit Strict setting, revealing opening time and network address. The blocked-image count and banner will not represent this load.

**Existing mitigations:** Lowercase HTTP/HTTPS images are blocked in Strict mode, and dimension-based tracking-pixel checks still run. Omitting dimensions avoids the latter. Script sanitization does not address image requests.

**Tests inspected:** Existing Strict-image tests use lowercase URLs, including [`sanitizer.rs:1269–1276`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-privacy/src/sanitizer.rs#L1269-L1276).

**Safe validation:** Add an end-to-end sanitizer fixture using mixed-case schemes, leading URL whitespace, and entity-encoded forms. Verify that Strict-mode output contains no usable external image source. Separately verify no request to a reviewer-controlled endpoint from the packaged macOS app.

**Smallest fix:** Parse and normalize URLs before policy decisions, including hostname extraction. In Strict mode, remove image sources unless they are explicitly supported local/embedded resources. Cover browser-equivalent URL forms rather than fixing only uppercase spelling.

### F4 — [P2] Gmail debug logging can panic on a remotely supplied Unicode header

**Confidence:** High for the panic condition; medium for constructing the exact header through Gmail without provider normalization.

**Attacker prerequisites:** Gmail synchronization returns a header with a multibyte character crossing byte offset 60, and the user has enabled debug logging for the Gmail module, for example through `RUST_LOG`. Default logging is INFO, so this is not an unconditional release crash.

**Evidence and reachable path:**

- Gmail header logging slices a Rust string at an arbitrary byte boundary: [`crates/pebble-mail/src/provider/gmail.rs:423–428`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-mail/src/provider/gmail.rs#L423-L428).
- Normal synchronization calls `fetch_sync_message`: [`crates/pebble-mail/src/gmail_sync.rs:753–764`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-mail/src/gmail_sync.rs#L753-L764).
- Logging honors the environment filter: [`src-tauri/src/lib.rs:309–312`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src-tauri/src/lib.rs#L309-L312).
- Release builds abort on panic: [`Cargo.toml:45–50`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/Cargo.toml#L45-L50).

A header value comprising 59 ASCII bytes followed by `é` makes `&value[..60]` split a UTF-8 character. Rust panics on that slice when the debug event is evaluated.

**Impact:** Diagnostic logging can turn a valid Unicode header into an application-aborting input during sync. Re-fetching the same message can repeat the failure while logging remains enabled. Debug output also contains email metadata and should not be shared unredacted.

**Existing mitigations:** Default INFO logging normally avoids evaluating this debug expression. No string-boundary check exists in the expression itself.

**Safe validation:** Use a synthetic `GmailMessage` fixture and an explicitly enabled debug subscriber in an isolated test process. No account or real email is needed to verify the string-boundary failure. Provider-specific delivery behavior can be checked later with disposable accounts.

**Smallest fix:** Truncate on Unicode character boundaries, or omit header values from logs and retain only field names/counts. Add a debug-enabled Unicode regression.

---

## Plausible risks and operational concerns needing validation

These are **not additional claims of demonstrated exploitation**.

### Privileged frontend compromise has a large blast radius

The main window registers commands for reading mail, sending mail, deleting mail, downloading attachments, translation configuration, and backup/export. See [`src-tauri/src/lib.rs:501–640`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src-tauri/src/lib.rs#L501-L640).

The narrow-looking plugin capability list is not a per-command authorization design for this application handler set. In particular:

- Translation configuration is deliberately returned decrypted.
- `export_backup_file` accepts a caller-provided passphrase; backup assembly can include decrypted account credentials before encrypting the export under that passphrase: [`src-tauri/src/commands/cloud_sync.rs:101–116`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src-tauri/src/commands/cloud_sync.rs#L101-L116), [`:262–268`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src-tauri/src/commands/cloud_sync.rs#L262-L268).
- Attachment download accepts a destination supplied by IPC. `validate_save_path` validates the directory and filename but does not implement its comment’s home-directory restriction.

Thus a future script-execution defect in the privileged frontend could expose accounts and local data. **This review did not establish that the CSS findings provide script execution or IPC access.** Consider native confirmation for secret export and capability-like handles for user-selected file operations.

### Navigation and local-network resource access need packaged-WebView checks

Normal HTTP/HTTPS clicks are intercepted, and the backend opener accepts only HTTP, HTTPS, and `mailto`. However, the click handler does not comprehensively deny other navigation forms such as relative or protocol-relative links. CSP also permits broad image and HTTPS stylesheet sources.

Validate default navigation, auxiliary clicks, redirects, and WebView handling of loopback/private-network resource loads. No internal-network access or remote-origin IPC inheritance was tested or established.

### Resource limits need additional review

The POP3 multiline reader accumulates input until the terminating dot, with per-read timeouts but no aggregate byte limit in that function: [`crates/pebble-mail/src/pop3.rs:339–367`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-mail/src/pop3.rs#L339-L367). Gmail fetches can retain several messages and attachments concurrently.

An attacker-controlled configured mail server, or sufficiently large accepted messages, could cause memory/disk pressure. Limits across providers, parsers, attachments, rendering, and indexing were not exhaustively traced. Validate with bounded synthetic fixtures, not resource-exhaustion attacks.

### OAuth callback timeout does not cover the entire callback exchange

The five-minute timeout surrounds `accept()`, but the subsequent socket read has no corresponding timeout: [`crates/pebble-oauth/src/redirect.rs:45–56`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-oauth/src/redirect.rs#L45-L56). A local process reaching the ephemeral listener can stall that authorization attempt.

State and PKCE still protect token exchange; this is an availability concern, not a demonstrated account takeover. Apply a deadline to the full exchange and tolerate unrelated requests until a valid callback arrives.

### Unknown send outcomes are durable, but the immediate UI uses the success path

Network-classified send errors become “outcome unknown” records, yet `send_email` can return `Ok(())`; the composer then closes and cleans its draft state. See [`src-tauri/src/commands/compose.rs:574–580`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src-tauri/src/commands/compose.rs#L574-L580) and [`src/features/compose/ComposeView.tsx:380–389`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src/features/compose/ComposeView.tsx#L380-L389).

This is a deliberate conservative design, with retained outbox state and a pending-operations alert, not a demonstrated silent message loss or automatic duplicate send. Before primary use, validate disconnect-after-submit behavior and ensure the user immediately understands “unknown; check Sent; do not resend yet.”

---

## Positive controls and important boundaries

- **Two sanitization layers and restrictive script CSP.** Backend Ammonia and frontend DOMPurify allowlist markup. CSP disallows frames and objects and restricts script sources. The findings concern gaps in CSS/resource handling, not an absence of sanitization.
- **Compose quotes receive separate restrictions.** `sanitizeComposeQuoteHtml` removes style/link elements and HTTP/protocol-relative remote sources before quotes enter the light DOM. Sender/subject attribution is escaped. Tests explicitly cover CSS and remote-resource removal in [`tests/hooks/useComposeEditor.test.ts:93–111`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/tests/hooks/useComposeEditor.test.ts#L93-L111).
- **OAuth uses random state, S256 PKCE, and loopback binding.** The application binds before browser launch, validates callback state before exchange, and fetches the mailbox identity from the provider. See [`src-tauri/src/commands/oauth.rs:818–847`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src-tauri/src/commands/oauth.rs#L818-L847). Broad mail scopes remain a product/account-permission consideration.
- **Credentials have meaningful at-rest protection.** The DEK is stored through the OS keyring; account secrets use AES-GCM with purpose/record-bound authenticated data. Invalid stored key material is rejected rather than overwritten. This protects credential blobs, not the entire mailbox profile.
- **Mailbox content is not comprehensively encrypted at rest.** SQLite message bodies and attachment files are stored without application-level content encryption in the inspected paths. Treat the profile and backups as sensitive; OS access controls and FileVault matter.
- **Attachments have traversal and overwrite defenses.** Incoming filenames are reduced to safe basenames. User downloads use `create_new` and unique names rather than replacing existing targets: [`src-tauri/src/commands/attachments.rs:147–165`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src-tauri/src/commands/attachments.rs#L147-L165). The inspected UI downloads attachments rather than automatically executing them. macOS quarantine behavior was not verified.
- **TLS defaults and STARTTLS behavior are generally conservative.** Certificate bypass is an explicit option rather than the default. SMTP requires STARTTLS when configured and refuses plaintext fallback if unsupported.
- **Send replay includes duplicate-send defenses.** Interrupted sends without a durable remote-success marker are stopped rather than automatically retried: [`crates/pebble-store/src/pending_ops.rs:375–399`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-store/src/pending_ops.rs#L375-L399). Sender identity is checked before dispatch. No exactly-once guarantee is inferred.
- **External translation is configurable and user-triggered in the inspected UI.** Selected text or message text is sent to the configured service. LLM translation uses text prompts without inspected tool-execution capabilities. Translation output is inserted as text or sanitized HTML. Enabling it remains disclosure to that provider.
- **WebDAV has useful controls.** HTTPS is required, redirects are disabled, and downloads have a streaming 16 MiB cap. Credential inclusion in exports is optional and passphrase-encrypted. This does not mean all exported metadata is encrypted.

## Update, package, and dependency trust

The update command queries GitHub release metadata and returns a release URL; it does not itself download and execute an update: [`src-tauri/src/commands/health.rs:14–54`](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src-tauri/src/commands/health.rs#L14-L54).

The macOS release workflow builds DMGs and publishes accompanying SHA-256 files. The inspected workflow does not establish Developer ID signing/notarization or independent signature verification. A checksum distributed through the same release channel detects corruption but does not independently authenticate a compromised publisher. **Actual release artifacts were not downloaded or inspected.**

Before installing a primary-use build, independently verify its signing identity, notarization, provenance, and relationship to this commit. Opening the app also runs database migrations; use a disposable/copied profile for evaluation.

Dependency manifests and selected lock entries were inspected, including DOMPurify 3.4.1, Ammonia 4.1.2, `lol_html` 1.2.1, `mail-parser` 0.9.4, and Tauri 2.10.3. **No dependency vulnerability scanner or advisory-database audit was run.** No CVE is inferred from a version number, and the dependency tree is not cleared by this review.

## Coverage and gaps

| Area | Review coverage |
|---|---|
| Email HTML/CSS/images | Highest coverage: backend preprocessing, sanitizers, linkification, default modes, message/thread rendering, and relevant test source. |
| Composer and link handling | Quote sanitization, `mailto` parsing, normal body-link dispatch, and selected send callers. Clipboard and all editor extensions were not exhaustively audited. |
| Tauri boundary | Configuration, capabilities, registration, and selected privileged commands. No WebView IPC/origin runtime testing. |
| OAuth, TLS, credentials | Core state/PKCE flow, callback listener, identity checks, selected transport paths, keyring and encryption. No provider/account interoperability testing. |
| Attachments/MIME | Parser metadata flow, storage naming, download behavior, local staging. No parser fuzzing, quarantine inspection, or filesystem race testing. |
| Sync/outbox/account isolation | Selected Gmail/Outlook sync paths and send-recovery controls. No exhaustive multi-account state-machine, database, or SQL audit. |
| AI/cloud services | Translation disclosure paths and selected backup protections. Endpoint redirects, DNS behavior, and all backup-import combinations remain untested. |
| Distribution | Source workflow/configuration only; no binary-signature or reproducibility verification. |
| Android | Outside the reviewed desktop security evidence. |

### Recommended next validation

1. Add full-pipeline regression fixtures for F1–F3, then verify rendering and network behavior in the packaged macOS app.
2. Add a debug-enabled Unicode-header regression for F4.
3. Exercise OAuth callback interference and send-outcome ambiguity using synthetic servers/disposable accounts.
4. Review privileged export/file commands under a frontend-compromise threat model.
5. Audit dependencies and authenticate release artifacts before primary-inbox use.

**Final assessment:** Suitable for carefully isolated evaluation, not cleared for a primary inbox. The strongest concerns are source-supported renderer policy failures; their exact macOS effects and all proposed fixes require independent verification.

## Human Reviewer Callouts (Non-Blocking)

- (none)