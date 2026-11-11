# ADR 0002: Fixture mode as a synthetic provider

**Status:** Proposed

## Question and provisional decision

Investigate replacing the native fixture store/worker with `GmailCore` and a built-in, credential-free `SyntheticProvider`. This is a decision spike, not authorization to change production behavior. Baseline: `58e0bc7`.

**Provisional recommendation: go for a staged unification, not a provider-only substitution.** GmailCore already accepts `Arc<dyn GmailReadProvider>` and an injected clock. The provider must own durable synthetic provider facts; the core needs a small explicit fixture policy for mode/capabilities/lifecycle and reminders. Keeping a second operation ledger is avoidable, but silently changing the fixture contract is not acceptable.

## Evidence checkpoints

- Required architecture, status, development and ADR 0001 read. Current docs explicitly promise a separate durable native fixture profile, seed-once behavior, archive-only mailbox actions, local drafts and synthetic attachment transfers.
- `gmail/sync.rs::open_with_clock` has no direct OAuth/Keychain dependency: those belong to the injected production `GmailProvider`. Startup currently interprets `has_credentials()` as a restore signal; a synthetic implementation needs an explicit local-ready policy rather than inventing real credentials.
- `gmail/sync.rs::account_status` hardcodes `MailMode::Gmail`; `mutation_access()` is a Boolean grant covering archive/read/star. Neither preserves fixture wire behavior by itself.
- Prototype and exhaustive test disposition are in progress. No production files are changed by this spike.

## Implementation stages (each must remain green and shippable)

1. Port fixture-specific guarantees to tests against GmailCore, retain both existing backends, and add a production synthetic data/provider module independent of test support. Keep the default fixture path unchanged.
2. Introduce explicit internal session policy in GmailCore: fixture identity/status, archive-only admission, unsupported errors, cached-only search, local readiness and non-destructive lifecycle. Implement persistent synthetic provider facts and seed-once discovery including the two initially archived conversations. Keep Gmail policy unchanged.
3. Resolve reminder behavior explicitly and cover it with acceptance/race/restart tests; move synthetic attachments/reply metadata behind provider/core seams. Preserve local drafts and fixture profile safety. Add opt-in synthetic-core launch path for validation.
4. Switch fixture default only after all mapped guarantees pass and profile transition disclosure is implemented. Keep the old database as backup. Remove the legacy backend after parity validation; update current docs and browser contract tests. Coordinating thread owns end-to-end validation and merge sequencing.

## Risks and decision gates

A fresh provider seeded into memory on every launch can overwrite archived provider facts at the next sync. Gmail discovery only lists Inbox, so it cannot by itself reproduce the two archived seed threads. GmailCore may expose read/star or destructive disconnect if fixture mode is represented as Gmail. Reminder scheduling currently has different mailbox effects. These are design gates for implementation, not bugs established by this spike.

The prototype will be published separately at [maintenance/p4-synthetic-provider-prototype](https://github.com/BbrSofiane/email-os/tree/maintenance/p4-synthetic-provider-prototype), marked throwaway and not for merge. This PR contains only this ADR.
