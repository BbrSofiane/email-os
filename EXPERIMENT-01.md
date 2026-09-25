# Experiment 1: an email reply queue you can teach

**Status:** proposed later experiment; not authorization to build, recruit, connect mailboxes, or transmit email to models.
**Sequencing:** [ADR 0001](docs/adr/0001-single-account-desktop-email-client.md) supersedes this document as the first-build plan. Build the single-account desktop client first; retain this proposal for a later customization study.
**Date:** 2026-09-25.
**Parent vision:** [Composable email client PRD](PRD.md).
**Supporting evidence:** [research summary](README.md), [email security review](security/email-review.md), [Pebble security review](security/pebble-review.md).

## 1. Decision this experiment should inform

Should we invest in a composable email client because users get recurring value from teaching it their own workflow—or would a good fixed set of queues solve most of the problem?

**Proposed promise:**

> Know which client conversations need your attention, and process them in the order that makes sense for your work.

Test this through one useful, customizable reply queue alongside the user's existing inbox. Do not first build a replacement client, public extension SDK, or general automation platform.

This experiment deliberately covers only a slice of the PRD. It does **not** satisfy its full mail-client, Android-app, workflow, or release-readiness requirements. Framework, fork, license, and long-term hosting remain undecided.

## 2. Initial users and problem

**Recruitment hypothesis:** independent consultants and small-agency owners handling several client relationships through email, who repeatedly spend time deciding what to answer or worry about overlooking a commitment.

Recruit **5–8 participants**, including the founder for dogfooding but reporting founder results separately. Prefer one Gmail account per participant for this first test. At least three participants should regularly triage email on Android.

Screen for a recent, concrete example of a delayed client reply, missed commitment, or repeated manual sorting. Ask them to demonstrate their current routine before describing customization features. Do not recruit only people excited about AI or plugins.

Participants must be authorized to share the selected business correspondence under the agreed data policy. If this excludes suitable users, record that as a product constraint—not a reason to relax consent.

**Job to be done:** when starting an email-processing session, identify the conversations worth acting on now without repeatedly scanning everything or relying on a generic importance score.

## 3. Hypotheses and ways they could be wrong

| Hypothesis | Evidence sought | Disconfirming observation |
|---|---|---|
| People need materially different processing policies | Different selection/ordering needs emerge before suggesting presets | Almost everyone wants the same default |
| Customization improves useful work | Personalized queue beats the fixed queue on unseen mail and in repeated use | Changes are cosmetic, or add setup work without better decisions |
| An agent lowers the authoring burden | User expresses a policy, understands the preview, and approves a working configuration without developer edits | The agent repeatedly misunderstands, or a few controls are simpler |
| Inspectability makes mistakes recoverable | Users find exclusions, correct judgments, and understand what changed | Users over-trust the queue or cannot repair errors |
| Mobile preserves the workflow's value | Android users use the same queue and see corrections converge | They revert to their usual inbox because handoff or stale state makes the queue impractical |

A successful classifier alone does not validate customization. A successful customization demo alone does not validate recurring value.

## 4. The smallest experience to test

### Default queue

Ship an opinionated **“Replies needing attention”** queue, not a blank configuration screen. Use three independently inspectable inputs:

1. **Needs my reply:** yes/no/unknown for the current conversation state.
2. **Time sensitivity:** explicit deadline or inferred urgency, with the distinction visible.
3. **Client/project relationship:** participant-supplied address/domain mapping initially; no CRM integration required.

Start with a simple deterministic ordering: explicitly pinned conversations first, then known near-term deadlines, then client conversations, with a stable age/ID tie-breaker. This is a proposed default to evaluate, not a claim that these categories are always correct. Unknown classifications remain visible in a review bucket rather than silently disappearing.

Provide a rules-only producer and, subject to consent, one optional model adapter for semantic judgments. Jev is a candidate, not a dependency decision. Keep the same selected producer and cached judgments when comparing default versus personalized ranking so the comparison isolates configuration changes.

### One teach-and-preview loop

A user can ask, for example:

> “Existing clients before prospects, except that anything due today comes first. Keep newsletters out of this queue.”

The product proposes a bounded configuration change, not executable code. Before activation, show:

- Conversations added, removed, and moved, including counts and representative examples.
- Why the policy caused those changes and which inputs are missing or stale.
- Any new data access/destination and expected inference use, if applicable.
- A human-readable policy diff and an option to reject or edit it.

Approval creates a versioned saved view. New qualifying mail enters it without regenerating the configuration. A manual editor produces the same definition; users do not need an agent to operate the queue.

### Small action set

Users can inspect a safe plain-text conversation preview, open the conversation in their existing email client, correct a signal, pin/unpin a conversation, or exclude/reinclude it in this queue.

Corrections and queue changes affect **application-owned state only**. No sending, draft creation, archive, read/unread changes, provider labels, notifications, or external tasks are executed by this experiment. Reading in the existing client may of course change that provider's state through the user's ordinary actions.

Validate handoff on actual devices. If an exact conversation cannot be opened reliably, disclose the fallback rather than assuming desktop links work on Android. Measure finding/replying time including the handoff.

### A second setup without a second application

Use the same data, signals, and configuration interpreter to support a **“Project focus”** preset: filter to a selected client/project and order conversations needing a response. Offer it after observing initial behavior; distinguish spontaneous requests from prompted adoption.

This tests whether composition is real without requiring four stable public extension contracts. Do not add a new core branch or bespoke UI for each participant's policy; record any request that would require one.

## 5. Corrections, omissions, and conflicting state

The first version needs explicit semantics, not a general conflict engine:

- Always expose **all mail in the imported scope**, with the date window, thread-context coverage, and last successful refresh. This is not the complete provider inbox unless verified as such. Keep the existing full inbox one action away.
- Show counts and examples of excluded, unknown, stale, and failed classifications. Evaluate “What did this queue miss?” as a first-class task.
- A manual signal correction applies to a named conversation revision. Re-ranking or unrelated inference cannot overwrite it. A new message makes the correction require review; preserve its history and surface the conversation for reconsideration.
- Explicit queue membership overrides persist until revoked. Reinclude/exclude is a single mutually exclusive setting, not two competing rules. Explain that exclusion from the queue does not delete or archive mail.
- Within a view, apply membership overrides first, then filters, then pins and ordering. Pinning does not silently reinclude an excluded conversation; prompt for that choice.
- Use revision-checked updates for shared configuration and overrides. A stale-device write must show a conflict rather than silently overwriting a newer correction.
- Rolling back configuration does not erase subsequent user corrections or reverse provider actions.

Record false negatives against the imported scope. Missing mail outside that scope is a coverage limitation, not a classifier success.

## 6. Minimum Android slice

On a real Android phone, participants must be able to:

- Open the same saved queue with touch-appropriate controls.
- Read a plain-text preview and open the existing mail client.
- Correct, pin, exclude, and restore items.
- See the active configuration version, coverage, freshness, and sync failures.
- Observe acknowledged corrections converge between desktop and Android.

For this experiment, offline access may be read-only cached data; disable edits with an explicit explanation until connected. Define this before the pilot rather than promising a durable offline editor implicitly.

A responsive web surface is acceptable for this validation slice if disclosed. It would validate on-phone usefulness, **not** delivery of the PRD's Android app, push notifications, background sync, or native integration requirements.

Choose one authoritative store for pilot configuration/overrides and one refresh owner. Devices must not independently perform mail automation. If a desktop is the refresh owner, show its disconnected state; if a service is used, obtain explicit hosting consent. Avoid device election and generic replicated workflow execution in this test.

## 7. Safety and data gates before participant mail

Read-only mail access still exposes confidential data. A sidecar experiment is lower-authority, not automatically safe.

1. Begin with synthetic fixtures and a disposable account. Test hostile text/HTML, prompt injection, cross-account isolation, expired credentials, restart, stale state, and conflicting corrections.
2. Use the least provider scope compatible with the selected read-only integration. Do not inherit write/send permissions merely because a fork already requests them. Provider verification obligations still apply to the pilot's actual distribution and data handling.
3. Do not execute untrusted plugins or agent-generated code. The authoring agent may propose schema-validated configuration; it cannot install code, grant permissions, change endpoints, or act on instructions found in mail.
4. Render text safely without remote images or attachment previews. Do not use a prototype HTML renderer just to improve fidelity. Attachments are out of the inference scope.
5. Obtain separate consent for mailbox access, server storage, model transmission, and researcher observation. Preview does not imply permission to transmit content. Offer rules-only participation.
6. Use an explicit input window and enough conversation context to avoid misleading judgments. Report truncation and unknown context. Do not ingest an entire mailbox by default.
7. Before onboarding, document the exact services, credential storage, access controls, inference budget, retention period, deletion process, and model-provider retention terms. No mailbox bodies, subjects, addresses, or tokens in routine analytics logs.
8. Researchers see aggregate events and participant-approved examples, not unrestricted inbox access. Provide disconnect/delete controls and a verification procedure covering stored mail, annotations, logs, and evaluation samples.

Any unauthorized disclosure, provider mutation, cross-account exposure, or silent destructive state loss pauses the pilot. Diagnose and revalidate before resuming. Reused paths implicated by the prior reviews must be fixed or demonstrably unreachable—not assumed safe because sending is hidden in the UI.

## 8. Pilot protocol

**Proposed duration:** 10 working days per participant, after prototype and safety gates pass. This is a study window, not a build-time estimate.

### Stage A — Discovery and baseline, days 1–2

- Observe one ordinary email session; collect the participant's recent pain example and existing rules/workarounds.
- Measure time spent choosing the next conversation, relevant replies completed, and important items found during a final inbox sweep. Keep sensitive content out of recordings unless separately approved.
- Agree the mailbox scope and the user's definition of an important omission. Have the user label a manageable sample before showing model results.
- Record current Android behavior and handoff expectations.

### Stage B — Fixed queue, days 3–4

- Use the opinionated default with no requested customization exercise initially.
- Capture spontaneous complaints and policy requests. Record whether improvements come from a ranked queue at all, rather than its customizability.
- Verify Android use and correction convergence on real devices.

### Stage C — Teach, compare, and use, days 5–10

- Let users make one meaningful change through manual controls or the authoring agent. Counterbalance which authoring path is tried first where practical; record assistance and time separately.
- Preview on a selected sample, then evaluate on later or held-out conversations. Do not score success only on the messages used to tune the policy.
- Compare default and personalized rankings on the **same snapshots and signal results**; alternate presentation order and avoid labeling one as the improved version. Capture which better matches the user's priorities and why.
- Let users choose their working queue for live sessions. Continue the ordinary full-inbox sweep so false negatives are discoverable.
- Record voluntary return use, reversions, corrections, agent failures, setup/support time, inference cost, and cross-device friction.

End with a concrete continuation choice: keep using the personalized queue, use the default, or return to the previous routine. Ask about paid continuation at a price fixed before interviews; record hypothetical intent separately from an actual commitment. Do not collect payment without separate authorization.

## 9. Measures and predeclared decision rules

These are **proposed directional gates**, not validated benchmarks or statistical proof. Finalize definitions and thresholds before recruitment. Report participant-level counts and differences, not just averages; with 5–8 people, do not claim population-level significance.

| Dimension | Measure / proposed positive signal |
|---|---|
| Workflow diversity | At least three non-founder users independently request meaningful selection/ordering differences; requests fit one shared interpreter rather than bespoke code |
| Incremental customization value | At least two-thirds of evaluable non-founder participants prefer personalized to default on held-out comparisons and choose it for at least three later live sessions |
| Useful work | Within-user selection time and relevant replies/session improve or stay acceptable; include configuration, handoff, correction, and researcher-support time in the cost, not just queue speed |
| Authoring usability | A majority can make and correctly explain one useful change without developer configuration edits; assisted completion is reported separately |
| Inspectability | Participants can find an excluded important item, explain why it is absent, and correct it in a planned task; live false negatives are also reviewed |
| Android continuity | At least three Android users complete the shared-queue/correction task; no silently lost acknowledged changes; document whether phone access is repeatedly useful |
| Trust and relevance | No unauthorized side effects; every user-identified important omission investigated; no accepted pattern of important omissions worse than baseline |
| Sustainability | Per-user inference and support costs recorded; repeated preference and continuation commitments distinguished from novelty or interview enthusiasm |

Record withdrawals and their reasons. Do not remove frustrated participants from the results to satisfy a threshold; an incomplete trial is evidence about feasibility/onboarding, even when it cannot support a ranking comparison.

### Decision outcomes

- **Continue toward composable client:** safety gates hold, customization shows incremental and repeated value, and distinct policies fit shared machinery. Next test a reliable read/reply surface and one bounded reminder workflow; do not jump straight to a marketplace.
- **Narrow to an opinionated client:** users value the queue but converge on the same presets or rarely benefit from customization. Keep the useful experience; do not justify a platform merely because the abstractions exist.
- **Revise the interaction:** personalized queues help but authoring, preview, or Android handoff creates too much work. Simplify controls or add the minimum integrated reading/replying surface, then repeat a bounded test.
- **Pause or stop this direction:** users do not return, the queue adds more checking than it saves, access requirements prevent viable adoption, or safe operation remains unresolved. Failure of the agent authoring path alone does not disprove manual customization.

## 10. Explicitly deferred

A replacement composer/send engine; provider mutations; reminders and timers; notifications; autonomous operating agents; CRM/calendar integrations; attachment processing; public plugins/marketplace; arbitrary UI code; stable external SDK; multi-account/provider coverage; native mobile parity; device election; general offline conflict merging; billing implementation.

These are sequencing choices for the experiment, not removals from the product vision. Maintain the architectural separation of signals, views, and commands internally without promising a public contract before observing real variation.

## 11. Decisions required to start

- Confirm the initial customer group and recruitable sample, including Android users.
- Select the provider, import window/context coverage, authentication route, and pilot read-only scopes.
- Choose where mail processing and shared application state run; document who can access each.
- Select the rules baseline and optional model/authoring providers, with explicit data policy and cost caps.
- Validate existing-client handoff on the actual desktop and Android devices.
- Finalize retention/deletion terms, safety checks, evaluation definitions, and continuation price question.
- Set a prototype effort cap before building; if exceeded, reduce scope or reassess rather than silently expanding into the full PRD.

**Deliverable at the end:** a short decision memo with anonymized participant-level outcomes, before/after policy examples, baseline-versus-custom comparisons, omissions and incidents, costs/support burden, Android observations, and a clear continue/narrow/revise/stop recommendation. No pilot outcomes exist yet.
