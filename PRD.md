# Product requirements: a composable email client

**Status:** draft for product and technical validation; not an implementation authorization.
**Date:** 2026-09-25.
**Working description:** the “pi.dev of email clients.” This is a product analogy, not a commitment to pi's implementation or extension API.
**Related documents:** [client/framework research](README.md), [email security review](security/email-review.md), [Pebble security review](security/pebble-review.md).

## 1. Executive summary

Build a reliable email client whose **decisions, workflows, and views users can compose**, manually or with an agent. Ship a useful, opinionated reference experience rather than a blank toolkit.

> Describe how you want to process email; get a client that works that way—and can show you what it will do before you trust it.

The product combines:

- A trusted mail engine responsible for synchronization, safe rendering, credentials, and action execution.
- Replaceable signals, views, commands, and workflows.
- A common action interface for the UI, automation, and agents, with caller-specific permissions.
- Inspectable, testable, versioned customization.
- Desktop and Android experiences with shared workflow semantics, not necessarily identical layouts.

The goal is **not Superhuman feature parity**. It is to let people build their ideal way to process email without rebuilding the dangerous and tedious parts of an email client.

## 2. Decision status and relationship to earlier research

### Confirmed direction from the discussion

- The initial motivation is an ideal personal email-processing workflow.
- The expanded vision enables other people to compose their own clients, either manually or using agents.
- Pluggable triage is a central example: deterministic rules, classical ML, decision models such as Jev, or other implementations.
- Android matters alongside desktop.
- Opinionated defaults and extensibility should coexist.

### Proposed requirements in this document

The requirements below operationalize that vision. MVP scope, acceptance criteria, architecture, and release sequencing are proposals to validate, not claims that an implementation already exists.

### Still open

Framework, fork choice, licensing/business model, provider coverage, inference hosting, cloud dependencies, and the exact Android release scope remain undecided. Tauri is a candidate, not a requirement. Rust, React/TypeScript, SQLite, and Gmail-first delivery are promising implementation options, not product commitments.

This PRD is the current **product-direction document**. It supersedes the earlier README's suggested deferral of all plugins/workflows as the platform's product scope. The README remains historical research and a source of technical risks. In particular, its suggestion to defer Android is an option for sequencing, not a decision to exclude mobile from this vision.

## 3. Problem and audience

### Problem

Email clients embed fixed assumptions about what matters, how work should be grouped, and what “done” means. Rules can move mail, and AI assistants can summarize it, but neither necessarily changes the interaction model around the user's actual work.

Examples of incompatible needs:

- A founder wants customer commitments and investor replies ahead of everything else.
- A consultant wants project queues and explicit waiting-for-reply states.
- A privacy-conscious user wants deterministic rules and no external inference.
- Another user wants model-based prioritization but never automatic sending.
- A mobile user wants fast triage actions that preserve the same workflow state as desktop.

Today, customization often requires maintaining a fork, wiring together several tools, or accepting broad plugin privileges. The product should reduce that burden without hiding the consequences of automation.

### Initial audience

1. **Power users:** configure rules, views, shortcuts, and routines directly.
2. **Agent-assisted users:** describe an outcome and review a proposed customization.
3. **Extension authors:** provide reusable classifiers, context integrations, commands, and workflow packages.

Initial validation should focus on the first two groups. A public marketplace is not necessary to prove the product.

## 4. Product principles

1. **Useful before customization.** A user can read, reply, search, and process mail immediately.
2. **Opinionated about correctness; flexible about workflow.** Extensions do not each reinvent synchronization, credential handling, or send recovery.
3. **Manual operation is first-class.** No AI subscription or external model is required for ordinary email use.
4. **Separate judgment from authority.** Classifying a message does not grant permission to archive it or send a reply.
5. **Shared semantics, different surfaces.** A desktop shortcut and Android swipe can invoke the same command.
6. **Inspect before trusting.** Explain provenance, preview changes, and expose uncertainty and failures.
7. **User choices outrank inference.** Explicit overrides are not silently undone by reclassification.
8. **Email is untrusted input.** A message cannot authorize installing code, changing permissions, exporting data, or sending mail.
9. **No magical guarantees.** Local caches can be incomplete, background work can stop, and a remote send can have an unknown outcome.
10. **Build the client through its own extension contracts.** Built-in features should exercise the same supported interfaces where practical; private bypasses must be justified.

## 5. Core composition model

```text
Provider mail + selected external context
                    |
             Signal producers
                    |
        Typed, versioned annotations
                    |
        +-----------+-------------+
        |                         |
 Saved views and ranking     Workflow policies
        |                         |
 Desktop / Android UI       Proposed commands
        |                         |
        +------------+------------+
                     |
       Permission and approval checks
                     |
       Trusted executor + operation history
                     |
            Provider / local state
```

Four public extension points form the initial platform:

| Extension point | Responsibility | Not its responsibility |
|---|---|---|
| **Signals** | Produce typed annotations from authorized snapshots/context | Mutate provider state merely by returning a judgment |
| **Views** | Select, rank, group, and present conversations and available commands | Independently implement synchronization or permission checks |
| **Commands** | Describe and request well-defined actions | Bypass centralized authorization, validation, or execution history |
| **Workflows** | Connect events, conditions, and timers to proposed commands | Treat event delivery as exactly-once or assume devices are always running |

Drafting, context retrieval, and attention policies should initially use these contracts rather than require separate, overlapping plugin systems.

## 6. Functional requirements

### FR-01 — Trusted mail foundation

The product must provide account connection, message/conversation reading, search, drafts, reply/new-message composition, attachments, send, and basic mailbox mutations for the supported provider scope.

- UI reads should use local state where available; users must see pending and failed mutations.
- Search and automation must expose their coverage: cached subset, complete local index, or remote provider query.
- Provider capabilities must be explicit. Unsupported actions must be rejected rather than silently approximated.
- Provider facts, application annotations, user overrides, and execution state must remain distinguishable.
- Credentials and unrestricted database access must not be the normal extension API.

**Acceptance:** a disposable mailbox can be processed without AI; offline actions survive restart; incomplete search coverage is visible; unsupported operations return actionable errors.

### FR-02 — Signals and typed annotations

Signal producers must support deterministic code, rules, lookup-based enrichment, ML, and decision-model adapters under a common contract.

Example annotations:

| Annotation | Example producer |
|---|---|
| Customer/account relationship | Address mapping or CRM lookup |
| Needs my reply | Rules, conversation logic, ML, or Jev |
| Project association | Explicit mapping or semantic classifier |
| Response urgency | Deadline logic plus rubric-based judgment |
| Expected response effort | Rubric-based model |
| Waiting on another person | Conversation-state logic |
| Invoice present | Rules or semantic classification |

Requirements:

- Define whether a result applies to a message, conversation, account, or another supported entity.
- Namespace extension-owned annotations to prevent collisions.
- Record producer/version, input revision or fingerprint, computation time, and freshness/invalidation behavior.
- Preserve uncertainty or abstention when the producer supports it. Do not invent comparable confidence values for unrelated implementations.
- Distinguish a probability of a proposition from a ranking score or model-confidence statistic.
- Allow explicit overrides and define whether/when automatic reevaluation may replace them.
- Reuse still-valid results across views and workflows rather than repeatedly evaluating the same question.
- Run independent judgments concurrently where appropriate, within cost/rate limits.
- Failed inference must not block ordinary inbox use; display missing/stale results and apply an explicit fallback.

**Jev example:** separate “needs a reply,” “time sensitivity,” and “response effort” judgments, then combine them in code. Jev supplies structured decisions, not generated reply text. Thresholds must be evaluated for the workload and stakes; typed output and high confidence do not establish truth or authorization. [S1–S3]

**Acceptance:** a rule-based and model-based producer can populate the same annotation contract without changing the consuming view; new replies invalidate relevant old judgments; manual overrides survive unrelated reevaluation.

### FR-03 — Saved views and ranking

A saved view must specify **selection + ordering + presentation + available actions**.

Examples:

- Replies that can be completed in five minutes.
- Customer conversations with approaching deadlines.
- Newsletters grouped by topic for a reading session.
- Waiting-for-reply conversations, oldest first.
- A project inbox combining multiple annotation sources.

Requirements:

- Compose provider fields, application annotations, explicit overrides, and time-dependent conditions.
- Support deterministic sort order and explainable ranking inputs.
- Show why an item appears and what data is missing or stale.
- Keep definitions live; an agent-created view is a reusable query, not a one-time generated list.
- Bound initial presentation to supported layouts/slots. Do not require arbitrary third-party UI code for ordinary customization.
- Render equivalent definitions with device-appropriate desktop and Android interactions.

**Acceptance:** changing ranking weights changes the queue without rerunning unchanged signals; an equivalent saved view can be interpreted on both target surfaces; new qualifying mail appears without regenerating the view definition.

### FR-04 — Commands and execution

All mailbox mutations must pass through a common command/execution boundary, whether invoked by a user, workflow, or agent.

Initial examples: archive, read/unread, label, draft create/edit, send, and application-local follow-up state. Provider moves, task integrations, and other commands can expand later.

A command request must identify its actor, target, parameters, and relevant preconditions. The executor must own:

- Input validation and capability checks.
- Approval requirements and explicit permission scope.
- Durable staging and observable operation state.
- Safe concurrency, deduplication, and retry policy appropriate to the operation/provider.
- Stale-state checks before applying consequential actions.
- Receipts and failure reporting.
- Cancellation/compensation where supported, with honest limits.

Do not promise universal exactly-once execution. An interrupted send may have reached the provider. Such operations must enter an explicit **outcome unknown** state and be reconciled, not blindly retried.

Macros may combine commands, but must report partial success. A multi-step workflow is not automatically an atomic transaction.

**Acceptance:** keyboard, touch, and agent invocation produce the same domain semantics under their respective permissions; concurrency/restart tests do not silently replay an ambiguous send; no provider-side “undo send” is implied once delivery has occurred.

### FR-05 — Workflows, events, and timers

Workflows must support events, conditions, durable timers, proposed commands, approvals, and cancellation.

Examples:

- After sending a question, remind me after three working days if no reply arrives.
- When an invoice arrives, extract fields and propose an accounting action.
- At the end of the day, surface unresolved commitments.
- When a reply arrives, cancel the corresponding reminder.
- Before sending, check recipients and expected attachments.

Requirements:

- Persist workflow/timer state independently of an open UI view.
- Define event replay and duplicate-event handling.
- Prevent uncontrolled self-triggering and impose execution budgets.
- Recheck cancellation conditions and current conversation state at execution time.
- Record timezone/calendar assumptions for time-based rules.
- Identify the execution owner across devices so one logical automation does not independently run on both.
- State what happens while a device is offline, asleep, or the application is quit.

**Acceptance:** a reminder survives restart and is cancelled by a qualifying reply; duplicated events do not cause duplicate logical actions; overdue timers have defined behavior after reconnection.

### FR-06 — Drafting and context

Support a composable drafting path:

```text
Conversation + authorized context → template/outline/draft → checks → review → send
```

- Templates and snippets must work without AI.
- Context providers may supply project, CRM, calendar, or document information subject to explicit access permissions.
- Generative models may create drafts; decision models may perform narrow checks.
- Show which external services receive message content and attachments.
- Keep drafts distinct from authorization to send. The proposed initial default is human approval for outbound sending.
- Show available evidence/provenance for external factual claims; do not substitute a generated rationale for verified evidence.

**Acceptance:** users can replace the draft generator without replacing the send path; a drafting component cannot send merely because it can produce text; unauthorized external context or model access is denied.

### FR-07 — Attention policies

Separate notification policy from inbox ranking.

Support quiet hours, digests, device routing, and escalation conditions. High priority in a queue must not automatically imply permission to interrupt the user.

**Acceptance:** a conversation can rank first while producing no immediate notification; desktop and Android notification decisions respect the same configured policy and explicit platform limits.

### FR-08 — Customization lifecycle and agents

Support manual configuration and agent-assisted configuration as equivalent authoring paths.

**Authoring agent:** proposes a definition/package change, runs permitted tests, and presents a diff for approval.

**Operating agent:** queries mail and invokes installed commands within granted permissions. It does not acquire installation or permission-management authority from email content.

Requirements:

- Versioned manifests/configuration with declared capabilities and compatibility information.
- Reviewable changes, including new data destinations and privileges.
- Enable, disable, upgrade, and rollback behavior.
- Dependency validation and understandable failure reporting.
- No silent privilege escalation on updates.
- A supported programmatic query/command interface; MCP/CLI are possible adapters, not selected requirements.
- Authoring and operation may use different execution identities/permission sets even when offered in one interface.

**Acceptance:** an agent can propose and preview a saved queue; installation requires the configured approval; a package update requesting external mail access cannot inherit that access silently.

### FR-09 — Preview, evaluation, and history

Before activation, users must be able to preview a customization on an explicitly selected mail sample.

The preview should show proposed changes, uncertain/failed cases, and representative reasons. Dry runs must not send, mutate the provider, create live external tasks, or deliver notifications. If evaluation needs external inference, that data transfer still requires separate authorization; “dry run” does not mean “no data leaves the device.”

Provide:

- Execution and decision history.
- “Why is this here?” provenance.
- User corrections and reusable evaluation cases.
- Version comparison and configuration rollback.
- Privacy controls for retained test cases and logs.
- Clear distinction between replaying recorded judgments and rerunning a potentially nondeterministic model.

**Acceptance:** a preview produces an inspectable action diff with no mutation side effects; a user correction can become a regression case; rolling back configuration does not claim to reverse already-sent messages.

### FR-10 — Desktop and Android consistency

The product vision includes both surfaces. A desktop-only developer preview is possible, but must not be described as fulfilling the mobile requirement.

Shared semantics should cover view definitions, workflow definitions, annotations/overrides, operation status, and permissions where applicable. Layout, shortcuts, swipes, file picking, authentication callbacks, and notifications can be platform-specific.

Requirements:

- Distinguish provider-synchronized state from application-owned state.
- Define stable identities and conflict handling for application-owned data.
- Prevent two devices from executing the same logical automation independently.
- Show freshness, pending local changes, and disconnected execution-owner status.
- Do not treat backup/restore as concurrent synchronization.
- Do not promise background delivery merely because the framework supports Android.

**Acceptance:** an override and workflow cancellation propagate consistently in the chosen multi-device design; offline conflicts have a documented resolution; the two-device execution test cannot silently double-send or double-create an external task.

## 7. Security, privacy, and reliability boundaries

The following belong to the trusted core, not to arbitrary workflow implementations:

- Provider synchronization and reconciliation.
- Authentication, token lifecycle, and secure credential storage.
- MIME handling and isolated/sanitized rendering of hostile message content.
- Permission enforcement and externally transmitted data controls.
- Action execution, concurrency, audit history, and ambiguous-outcome handling.
- Cross-device state and execution ownership.

Extensions should receive the minimum necessary data and operations. Distinguish access to headers, bodies, attachments, external network destinations, drafts, provider mutations, and sending. Namespaces or Tauri IPC permissions alone do not constitute a complete extension sandbox.

The extension runtime/isolation strategy must be selected and tested before executing untrusted third-party code. Initial declarative customization can reduce this attack surface.

Validation must include prompt-injection attempts, malicious HTML, recipient integrity, revoked credentials, conflicting actions, crash recovery, and mobile lifecycle constraints. Consult the existing [email](security/email-review.md) and [Pebble](security/pebble-review.md) static reviews before reusing either codebase. Neither review certifies a safe product.

## 8. Proposed MVP and release gates

### MVP thesis

Prove that one reliable client can support meaningfully different email-processing styles through stable extension contracts, without forks or unrestricted plugins.

### Proposed scope

- One provider/account initially; Gmail is the leading candidate, not a finalized requirement.
- Working read/search/compose/reply/attachments/send and basic mailbox actions.
- Four public contracts: signals, views, commands, workflows.
- A deterministic signal implementation and one optional model adapter, with Jev the motivating candidate.
- Saved queues, configurable ranking, and bounded command mappings.
- One durable follow-up/reminder workflow.
- Versioned configuration, preview, permission review, and action history.
- Headless query/action boundary exercised by UI and a small agent adapter.
- An Android feasibility slice before selecting a long-term foundation; exact first-release mobile parity remains a decision gate.

### Three reference setups

1. **Rules-only:** sender/domain rules, deterministic views, manual composition; no external inference.
2. **Decision-assisted reply queue:** independently computed reply/urgency/effort signals, adjustable ranking, explicit overrides.
3. **Project inbox:** selected project context, draft suggestions, and a waiting-for-reply reminder; sending remains approved.

The agent adapter must also demonstrate creating or modifying one of these setups through a reviewed configuration change.

### Gate A — Mail foundation

Disposable-account tests cover OAuth, read/reply/attachments, interrupted synchronization, offline actions, concurrent operations, hostile rendering, and unknown-send recovery. Do not use a primary inbox as the first integration test.

### Gate B — Composition

All three setups work without UI/core forks. At least two signal producers satisfy the same consumer contract. Built-in features exercise supported interfaces rather than demonstrating only third-party examples.

### Gate C — Trust

Dry-run side effects are blocked; capability escalation is visible; operating-agent actions are auditable; malicious email cannot grant authority. Previously identified source-review defects affecting reused components are fixed and validated.

### Gate D — Android and multi-device

On a real Android device, validate authentication, reading, replying, attachments, queue presentation, notifications, lifecycle recovery, and shared-state behavior. Resolve execution ownership and conflict semantics before claiming cross-device automation support.

### Explicit non-goals for the initial release

- Full Superhuman parity.
- A public marketplace, billing system, or large plugin ecosystem.
- Arbitrary replacement of every UI component.
- Universal provider compatibility.
- Fully autonomous outbound sending by default.
- Guaranteed exactly-once delivery over all providers.
- Guaranteed work while all execution hosts are stopped.
- A new general-purpose visual workflow language.
- Training a proprietary classification or generation model.

## 9. Success measures

Quantitative targets should be set after baseline measurement on representative mailboxes; none have been validated yet.

| Outcome | Measurement |
|---|---|
| Users can express their workflow | Task success and time to create/adjust each reference setup, manually and with an agent |
| Composition is real | Number of reference setups sharing the same core/contracts; changes requiring a fork or private API |
| Judgments are useful | Precision/recall or ranking usefulness per signal, abstention behavior, user correction rate; not a single aggregate “AI accuracy” |
| Automation is trustworthy | Unauthorized side effects, duplicate logical actions, ambiguous sends handled explicitly, recoverable failures |
| Client remains responsive | Queue-open, navigation, search, and command-acknowledgment latency on representative local datasets |
| Mobile preserves intent | Shared-view consistency, override convergence, cancelled-reminder convergence, device lifecycle test results |
| Optional AI stays optional | Ordinary workflow completion with inference disabled or unavailable |
| Customization remains operable | Preview coverage, rollback success, package-update regressions, support burden per customization |

Safety gates are pass/fail prerequisites, not metrics that can be traded off against engagement.

## 10. Architecture direction and build-versus-reuse

### Recommended shape, not a selected stack

A headless mail service exposes structured queries, capability-checked commands, operation receipts, and durable events. Desktop, Android, and agent adapters consume that boundary. Local caching, provider adapters, workflow scheduling, and optional shared-state services sit behind it.

A local-first model is desirable for interaction speed and offline use, but does not decide where every workflow runs. Possible execution hosts include an elected device or an optional service. The product must make availability and privacy consequences explicit.

### Findings from source inspection

| Candidate | Useful insight | Required caution/redesign |
|---|---|---|
| **JakubSzwajka/email** | MIT; headless Rust `mailcore`, `Mailbox<P>` facade, thin Tauri forwarding layer | Not an extension SDK; MCP is a future design; Gmail assumptions leak through provider queries; UI-driven sync and local-only annotations; atomic staging, send recovery, and authorization need validation/hardening |
| **Pebble** | Rules return proposed actions; capability-oriented provider traits; explicit unknown-send handling; richer workflow examples | Closed schemas/registries; workers coupled to desktop app state; backup is not concurrent state replication; AGPL requires an intentional licensing choice |

**Current recommendation:** use `email` as the cleaner architectural starting-point candidate and Pebble as a richer workflow reference. Do not commit to a fork before the mail-safety, extension-contract, and Android gates. Reusing patterns is distinct from incorporating licensed code. [S9–S14]

## 11. Prior art and differentiation

| Prior art | Lesson | Boundary |
|---|---|---|
| Nylas N1 / Mailspring | Component slots, behavior registries, package lifecycle | Nylas Mail is archived; Mailspring is desktop-oriented; registries alone do not establish safe agent customization |
| Thunderbird MailExtensions | Permissioned mail/compose APIs and event/action separation | Privileged Experiments bypass normal boundaries; desktop extensions are not established as portable to Android |
| Notmuch + Emacs + afew | Shared tags, saved queries, independent classifiers, hooks, dry runs | Delivery/sync/mobile and cross-device annotation semantics require other components |
| Pimalaya / Himalaya | Rust protocol abstractions and machine-readable mail commands | A library/CLI is not a complete extension platform or verified Android integration |
| JMAP | Structured mail operations, state tokens, delta synchronization | Not a UI/plugin runtime; Gmail/Outlook support cannot be assumed |
| email-agent-core | Fetch/parse/classify/respond pipeline separation | Inspected code is not a production client platform; maturity and license completeness need review |
| AgentMail | API-first events, drafts separate from sending | Agent-owned mailbox service, not a direct replacement for an existing user's client |

The differentiation hypothesis is **approachable, inspectable, agent-assisted composition across devices**, not the claim that programmable email is new. The research did not establish a single product satisfying the full combination; it does not prove none exists. [S4–S8, S15–S16]

## 12. Open decisions

| Decision | Why it matters | Resolve before |
|---|---|---|
| Personal/power-user product vs broader commercial platform | UX, onboarding, distribution, support and licensing | Public positioning |
| Exact Android jobs and first-release parity | Determines layout, background, and shared-state requirements | Foundation selection |
| Framework and fork vs greenfield | Native integration, testability, licensing, maintenance | Implementation commitment |
| Initial provider/account scope | OAuth verification, sync behavior and query capabilities | Mail-engine integration |
| Extension trust/runtime model | Declarative-only, sandboxed code, or privileged trusted packages have different risks | Third-party code execution |
| Configuration authoring format/API | Must be inspectable, versioned, and easy for users/agents to generate | Public contract stabilization |
| Application-state replication | Local annotations and overrides must follow users across devices | Cross-device beta |
| Workflow execution owner | Prevent duplicate actions and define offline/quit behavior | Automated effects on multiple devices |
| External inference/context policy | Privacy, cost, retention, provider terms | Model/integration rollout |
| Permission and approval defaults | Separates useful automation from unsafe authority | Agent operation rollout |
| License and distribution model | Copyleft/reuse obligations and package ecosystem compatibility | Code incorporation/distribution |
| Performance and evaluation targets | Makes release criteria measurable | Beta acceptance |

## 13. Evidence and references

**Method:** public documentation and static source inspection, not builds, runtime tests, provider-account tests, or an exhaustive security audit. The repository architecture inspection used the pinned snapshots below. Branch-based documentation can change. Source evidence supports the research findings, not the proposed product's future guarantees.

### TypeSafe

- **S1:** [Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents) — structured decisions, not a generative coding/chat model.
- **S2:** [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring) — independent judgments with code-owned weights.
- **S3:** [Confidence](https://docs.typesafe.ai/confidence) — probability distributions, confidence, and workload-specific thresholds.

### Prior art

- **S4:** [Mailspring component registry](https://github.com/Foundry376/Mailspring/blob/master/app/src/registries/component-registry.ts), [behavior registries](https://github.com/Foundry376/Mailspring/blob/master/app/src/registries/extension-registry.ts), [archived Nylas Mail](https://github.com/nylas/nylas-mail).
- **S5:** [Thunderbird MailExtensions](https://developer.thunderbird.net/add-ons/mailextensions), [Experiments](https://developer.thunderbird.net/add-ons/mailextensions/experiments), [messages API](https://webextension-api.thunderbird.net/en/latest/messages.html).
- **S6:** [Notmuch](https://notmuchmail.org/), [hooks](https://notmuchmail.org/doc/latest/man5/notmuch-hooks.html), [afew](https://github.com/afewmail/afew).
- **S7:** [Himalaya](https://github.com/pimalaya/himalaya), [Pimalaya email backend source](https://github.com/pimalaya/core/blob/master/email/src/backend/mod.rs). Current Himalaya protocol-crate composition and `email-lib` are distinct options; do not assume the CLI still depends on `email-lib`.
- **S8:** [JMAP core: RFC 8620](https://www.rfc-editor.org/rfc/rfc8620), [JMAP mail: RFC 8621](https://www.rfc-editor.org/rfc/rfc8621).

### Pinned implementation references

- **S9:** [email architecture](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/docs/architecture.md).
- **S10:** [email command facade](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/commands/mod.rs), [sync/outbox](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/crates/mailcore/src/sync/mod.rs).
- **S11:** [email MIT license](https://github.com/JakubSzwajka/email/blob/f0af11852b27b17f229979a3e4e7e615a1f8c3dc/LICENSE).
- **S12:** [Pebble rule engine](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-rules/src/lib.rs), [provider capability traits](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/crates/pebble-core/src/traits.rs).
- **S13:** [Pebble pending operations](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src-tauri/src/commands/pending_mail_ops.rs), [backup implementation](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/src-tauri/src/commands/cloud_sync.rs).
- **S14:** [Pebble AGPLv3 license](https://github.com/QingJ01/Pebble/blob/e43341cc59b8efda8d55f3de8584419cefa44c88/LICENSE).
- **S15:** [email-agent-core](https://github.com/pguso/email-agent-core), including its [Action implementation](https://github.com/pguso/email-agent-core/blob/main/src/agent-engine/core/Action.ts).
- **S16:** [AgentMail introduction](https://docs.agentmail.to/introduction), [drafts](https://docs.agentmail.to/drafts).
