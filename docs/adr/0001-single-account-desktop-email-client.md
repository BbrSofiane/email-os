# ADR 0001: Start with a single-account desktop email client

**Status:** Accepted — first-build direction and scope; not authorization to connect a mailbox or send mail.

## Context

Email OS's long-term direction is a composable email client whose views, signals, commands, and workflows can be adapted by users and agents. The [PRD](../../PRD.md) describes that destination, not a suitably narrow first build.

The immediate goal is a limited replacement for Superhuman. The user has confirmed that **one account on desktop is a good starting point**. The first build should therefore replace a complete everyday activity, rather than demonstrate a platform or add another tool alongside the existing client.

[Experiment 1](../../EXPERIMENT-01.md) proposes a read-only, teachable reply queue. That remains a possible later customization study, but handing users back to another client to reply would not validate the immediate replacement goal.

At the time of this ADR, the repository contained planning and static reviews. The narrower Slice 01 fixture baseline and Slice 02 read-only Gmail path are now implemented; see the slice contracts for their boundaries and `docs/development.md` for validation status. This ADR's broader provider-backed composition, sending, Gmail archive/read-state actions, search, and saved-view scope remains future work; macOS Slice 02 runtime validation is still pending.

## Decision

Build a **keyboard-first, single-account desktop client for a complete inbox-processing session**, with one small configurable-view capability.

The initial promise is:

> I can open Email OS, process my inbox, and finish ordinary replies without switching to Superhuman.

The primary loop is:

```text
Open inbox → navigate → read conversation → reply or archive → next
```

Optimize this loop for speed, predictable interaction, and trustworthy state before adding intelligent prioritization or general extensibility.

### Initial boundaries

- One connected account, not a unified multi-account inbox.
- One desktop operating system for the first developer build. macOS is approved for the Slice 02 pilot; the broader platform/runtime gate remains pending.
- Gmail REST is approved for the narrow, read-only disposable-account Slice 02 pilot. This does not authorize write scopes or broader provider capabilities; do not build a second provider merely to demonstrate abstraction.
- No custom Android surface in this build. An existing provider client remains the mobile fallback; this sequencing does not remove Android from the product vision.
- Manual operation must work without AI or external inference.
- Initial validation is personal dogfooding, not a recruited multi-user pilot.

## First-build scope

### 1. Inbox and reading

- Inbox list and conversation reader with enough message history to reply confidently.
- Predictable keyboard navigation, focus, and shortcuts for next/previous, open/back, reply, archive, and read/unread.
- Safe message rendering. A plain-text presentation is acceptable initially; HTML fidelity is not a reason to weaken isolation or sanitization.
- Visible loading, freshness, incomplete-context, and synchronization-error states.
- An explicit fallback to the provider client for unsupported operations or message formats.

### 2. Composition and sending

- Reply, reply-all, and simple new-message composition.
- Clearly displayed recipients, distinguishing reply from reply-all; no hidden recipient expansion.
- Draft persistence across application restart, including recipient and body edits.
- Basic file attachment upload/download, with explicit size/type limitations and failures. Inline editing, attachment previews, and sophisticated formatting are deferred.
- Explicit user-initiated sending, with visible operation status and failure recovery.

Drafts may initially be application-local. The interface must make that limitation clear: cross-device/provider draft synchronization is not promised.

### 3. Mailbox actions and search

- Archive and read/unread changes reflected in provider state, so ordinary mailbox state remains consistent with other clients.
- Immediate local feedback backed by durable staging and reconciliation, not optimistic success messages that hide failures.
- Basic search sufficient to find an older conversation. Provider-backed search is acceptable; a complete local full-text index is not required.
- Search results must disclose whether they cover the provider mailbox or only cached data.

### UX-08 bounded star decision

UX-08 explicitly adds observed per-message STARRED facts and narrow Star/Unstar
setters over the immutable inventory observed at acceptance. This is a bounded
addition to the original archive/read action set, not arbitrary label authority:
INBOX and UNREAD remain independent, and the existing durable groups, preimages,
Undo and uncertain-outcome reconciliation are reused. Legacy/partial facts stay
unknown. Cached Starred includes archived/recovery mail but never promises
provider-complete coverage. No new OAuth scope is requested; actual writes still
require the verified modify grant, explicit user action and operator-approved
disposable-account validation. The legacy archive-only fixture profile does not
gain star controls. Native macOS/provider convergence remains a separate gate.
Saved splits/search are not prerequisites and are not reimplemented here.

### UX-09 bounded destination decision

UX-09 increment A explicitly permits read-only Gmail destination metadata and
bounded provider pages for Sent, provider Drafts, All Mail (excluding Spam/Trash),
Spam, Trash and existing user labels. Rationale: the 100-conversation inbox cache
cannot honestly serve those destinations. Separate timestamped SQLite snapshots
must not change inbox/history checkpoints or evict durable-operation recovery.
Provider Drafts remain read-only and distinct from application-local drafts.
This does not authorize Trash/Spam writes, sending, label create/delete, arbitrary
system-label mutation, or a second provider. Label/Move remain unavailable until
a separate durable logical-intent/recovery increment satisfies the UX-09 contract.
The Gmail readonly scope suffices for increment A; all existing real-account
and native validation gates remain. No new mailbox access is authorized here.

### 4. One configurable view

Provide one additional saved queue defined by a bounded, declarative filter over sender, domain, or existing provider labels, with a stable default order. It must reuse the ordinary reader, composer, and mailbox commands.

- A small manual editor is sufficient; no natural-language authoring is required.
- Keep the full inbox accessible. Filtering must not silently archive, relabel, or hide mail from the provider inbox.
- Store the definition locally for the first build; do not imply it follows the user to mobile.
- If referenced data is not loaded, disclose the view's coverage.

This is a small test of the composable direction, not a general rules engine. Do not add new provider permissions or mutation capabilities merely to support view configuration.

### UX-10 bounded triage decision

[UX-10 A](../ux-10-bounded-triage.md) adds read-only **known cached Trash**
browsing and observed per-message TRASH/SPAM facts. This is an explicit narrow
extension of browsing, not a complete UX-09 folder catalog or broader mutation
authority. Current observed Trash/Spam excludes a conversation from local Done
even when it has old archive evidence. Legacy absence remains unknown.

Trash/recover writes and their Undo remain deferred: archive is not trash, and
the current archive/read preimages cannot restore a multi-dimension trash side
effect. The recovery destination decision is recorded in the UX-10 contract.
Mute requires actual future-message semantics, not INBOX removal; Spam/recover
needs validated provider effects. Important/Other requires independent local view
membership and explicit scope. Sender/domain rules, Block and Unsubscribe remain
deferred pending separate bounded execution/authority contracts. No send,
arbitrary URL opener, permanent deletion or empty-Trash is introduced.

## Architecture constraints

Preserve a few internal boundaries without committing to a public SDK:

1. **Mail integration and local state:** own credentials, synchronization, message identity, caching, and reconciliation outside UI components.
2. **Views:** select and order conversations from available data; they do not execute mailbox mutations.
3. **Commands and execution:** route UI actions through one typed boundary responsible for validation, durable operation state, concurrency, and recovery.
4. **Presentation:** consume those interfaces for the default inbox and the configurable view.

Use local data for responsive navigation where available. Opening a cached conversation must not require a fresh provider request to render its cached content.

Persist drafts and staged operations across restart. Cached reading and draft editing should remain usable without a connection; full offline mailbox coverage and offline search completeness are not required. Distinguish local, pending, and provider-confirmed state.

A send with an ambiguous remote outcome must enter an explicit **outcome unknown** state and be reconciled rather than blindly retried. Do not promise universal exactly-once sending or provider-side undo after delivery.

Synchronization is required while the application is running. Guaranteed synchronization, sending, or timer execution while the application is fully quit is out of scope. Hide-versus-quit behavior must be documented.

Framework, storage implementation, shell, and reuse strategy require separate technical decisions. This ADR does not select Tauri, Electron, Rust, React, or either reviewed fork.

## Safety and release gates

Narrow scope does not justify weaker mail integrity or privacy.

Before primary-mailbox dogfooding, use synthetic fixtures and a disposable account to validate:

- Authentication refresh/revocation and secure credential storage.
- Hostile-message rendering, blocked active content, and blocked automatic remote-resource loading.
- Recipient integrity for reply, reply-all, and new messages.
- Thread/context correctness and attachment handling.
- Interrupted synchronization, recovery after restart, and changes made in another client.
- Draft recovery and pending/failed mailbox mutations after connection loss.
- Concurrent send attempts and ambiguous-send recovery without blind replay.
- Search/view coverage and unsupported-message fallbacks.

Do not put mailbox content or credentials into routine diagnostic logs. Any reused code implicated by the [email](../../security/email-review.md) or [Pebble](../../security/pebble-review.md) reviews must be fixed and tested, or demonstrated to be outside reachable paths. Those static reviews are not runtime safety certifications.

## UX-12 attachment decision (bounded download-only)

The [UX-12 contract](../ux-12-safe-attachments.md) implements the existing basic
download scope, not preview. Authenticated readonly fetch, bounded cached
descriptors, cancellation and explicit inert Downloads saves are permitted.
Unsupported Office/HTML files are download-only; files never execute or load
remote resources in the app. External HTTP(S) links require explicit choice and
protocol validation; email/draft exits stay separate. No new Gmail scopes.

Attachment preview remains deferred: no macOS restricted-renderer sandbox and
compatibility spike evidence exists for this slice. A new webview alone is not
isolation. Preview requires documented enforcement of no privileged IPC and no
automatic remote-resource loading plus platform return-path testing and a new
reviewed decision. This preserves the download-only boundary rather than
silently relaxing it to claim BROWSE-14 complete.

## Explicit non-goals

- Superhuman feature parity or a polished public launch.
- Real multiple-account activation, multiple providers, or a custom mobile client.
  UX-13A permits only the synthetic in-app workspace proof described below.
- AI classification, generated replies, or agent-authored configuration.
- Public plugins, arbitrary extension code, a marketplace, or stable external APIs.
- Follow-up automation, scheduled send, sophisticated snooze, or background execution while quit.
- UX-11 permits bounded desktop-local reminders in the fixture and Gmail
  profiles. Gmail reminders live in `gmail.db`, pin baseline IDs and a reader
  snapshot, and use account-scoped receipts and revision checks. Scheduling and
  cancellation do not stage provider mailbox operations. No-reply deadlines
  require a complete fresh thread read plus local account/generation/revision
  fences; the provider can still receive a reply after that checkpoint. This
  does not claim provider-atomic absence. No calendar, cross-device or
  fully-quit execution promise is introduced. See
  [UX-11](../ux-11-local-reminders.md) for semantics and validation gates.
- Application-owned state replication across devices.
- Complete offline mailbox search, advanced rich-text editing, attachment previews, or inline attachment composition.
- Recruitment, billing, or the customization pilot described in Experiment 1.

## UX-13 bounded decision: synthetic workspaces, native/runtime deferred

The first-build single connected account boundary remains. UX-13A explicitly
permits **two browser-only synthetic account sessions** with independent browsing
and local-only draft state. This tests account+ID isolation without activating
real accounts, extending credentials, or implying remote convergence. Existing
Inbox/cached Done capabilities are reused; absent UX-06/07 search is not silently
implemented. See [the UX-13A contract](../ux-13-independent-workspaces.md).

Choose disclosed **in-app workspaces** for this proof, not native tabs. Genuine
macOS tabs require a real Tauri feasibility/lifecycle/focus validation spike;
none is claimed from browser fixtures. Native remains one window/selected core.
Same-profile competing writers continue to be deliberately rejected by OS locks.

Do not extend native account/profile/credential ownership yet: current Gmail
credentials have an account-independent Keychain key, and the shell's close gate
assumes one editor/window. Additional profile directories alone would permit
credential leakage. A backend-owned registry, credential namespace/migration,
account-bound profile leases and app-wide close coordination need a separately
approved runtime design before real activation. No unified inbox, cross-account
search, new OAuth authority or provider writes are authorized by this exception.

## Acceptance and evaluation

After the safety gates pass, dogfood the build for **five working days**.

The target is completing ordinary desktop inbox-processing sessions in Email OS. Keep the existing client available and record every fallback, including its reason and whether it blocked completion.

Evaluate:

- **Completion:** Can ordinary read/reply/archive sessions finish here? Which missing capabilities force a switch?
- **Interaction:** Does navigation remain responsive, focus predictable, and the primary loop usable without repeated mouse intervention?
- **Trust:** Do drafts survive restart, mailbox changes converge, and failures remain visible? Any silent data loss, unintended recipient, or duplicate-send defect blocks progression.
- **Composition:** Can the additional queue be changed declaratively without a new UI/core code path?

The five-day window is an evaluation period, not a build-time estimate. A high fallback rate is evidence to revise the scope, not a reason to hide unsupported cases. Prioritize the next slice from observed blockers rather than feature count or the breadth of the PRD.

## Alternatives considered

| Alternative | Why not first |
|---|---|
| Read-only teachable queue | Tests customization but cannot replace a complete email-processing session. |
| Reply-only workspace | A credible smaller fallback if the client scope proves too large, but leaves general inbox triage elsewhere. |
| Configurable split inbox as the main feature | Useful later; puts configuration before proving the basic read/reply/archive experience. |
| Follow-up-oriented client | Adds timers, reply detection, and execution ownership before the underlying mail loop is trustworthy. |
| Full composable-platform MVP | Too many independent risks: mail correctness, extension contracts, agent authority, automation, and multi-device state. |

## Consequences

**Benefits:** Delivers direct personal utility, validates the mail foundation against real work, and retains a modest path toward composable workflows. Avoids making AI or platform infrastructure a dependency of ordinary email use.

**Costs:** Less differentiated initially, requires consequential send/sync engineering earlier than the read-only experiment, and deliberately leaves mobile and advanced workflows in other clients. Keyboard interaction quality becomes a core acceptance criterion rather than later polish.

**Sequencing change:** This client slice takes priority over Experiment 1. The experiment remains a proposed later study of whether personalization adds value once the application can complete the work itself. The PRD remains the long-term direction; this ADR governs the narrower first build.

**Revisit when:** Dogfooding reveals a missing capability that prevents meaningful replacement, single-account desktop use is insufficient, or implementation effort warrants narrowing to the reply-only alternative. Change the ADR explicitly rather than silently expanding scope.
