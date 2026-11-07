# Product

## Register

product

## Users

Initially a single person: the author, dogfooding a single-account desktop client (macOS first) against their own Gmail inbox in focused, keyboard-first sessions. They move through a high volume of mail quickly, want to reach "done" on each conversation, and need to trust that every action (archive, bulk processing, undo, send) did exactly what it claimed. The provider's own client remains the fallback.

Longer term: technically capable people who want to compose their own email workflow (custom views, triage signals, commands, automations), manually or with an agent, without rebuilding sync, credentials, or send safety.

The primary task on most screens is triage: scan the list, open a conversation, decide, act, move on.

## Product Purpose

A composable email client: a trusted mail engine (sync, safe rendering, credentials, action execution) with replaceable signals, views, commands, and workflows on top. It ships an opinionated reference experience, a compact Superhuman-style browsing and keyboard flow, rather than a blank toolkit.

The near-term goal is a complete, trustworthy inbox-processing session. Strategic scope is set by `docs/adr/0001-single-account-desktop-email-client.md` and `superhuman-email-browsing-ux-spec.md`; this file does not expand it.

Success looks like: the author processes their inbox faster and with more confidence than in their previous client, and every automated or bulk action is previewable, reported honestly (including partial success and "outcome unknown"), and undoable where undo is real.

## Brand Personality

**Focused, precise, trustworthy.**

- **Focused:** the interface recedes so the mail and the next decision are what's on screen. Dense, quiet, few competing elements.
- **Precise:** exact states, exact counts, exact wording. No vague "something went wrong", no rounded-off truth about what happened.
- **Trustworthy:** the client never overstates what it did. Pending, failed, partial, and ambiguous outcomes are visible and distinct. Automation shows its work before it acts.

Voice is terse and factual: short labels, plain verbs, no exclamation marks, no cheerleading.

## Anti-references

- **Gmail-web clutter:** toolbars of rarely-used icons, chrome competing with content, permanent competing panels.
- **"AI magic" email products:** AI destinations, sparkle icons, generated summaries presented as fact, fabricated contact enrichment, automation that acts without a preview.
- **Superhuman feature-parity clone:** Superhuman is the visual and interaction reference for browsing (layout, density, type, keyboard feel), and close look parity there is a goal. Features and workflows are our own; don't import Superhuman's product scope or claim verified behavioral parity.
- **Generic SaaS dashboard aesthetics:** card stacks and grids, gradient heroes, oversized rounded panels, decorative illustration or motion.
- **Optimistic UI that lies:** "Done" before the provider confirmed, silent retries of ambiguous sends, dead controls that look actionable.

## Design Principles

1. **Honest state over smooth feel.** When speed and truthfulness conflict, show the truth. Every action has a visible pending, success, partial, failed, or unknown state. Show evidence and coverage, including unknown and retained facts.
2. **Keyboard first, mouse welcome.** Every core triage path is reachable and discoverable from the keyboard; pointer interaction is supported, never required.
3. **Content is the interface.** Chrome stays quiet and compact so the list and the conversation dominate. Add UI only when it earns its space in the triage loop; reuse established commands, navigation and recovery surfaces before adding new ones.
4. **Preview before power.** Bulk actions, automations, and agent-proposed changes show what they will do before they do it, and report exactly what they did after. Focus, bulk selection and message identity stay separate concepts.
5. **Opinionated defaults, replaceable parts.** Ship one strong way of working; design surfaces so views, signals, and commands can be swapped without breaking the core experience.

Standing constraints: ordinary reading stays local and non-mutating; message content renders as safe literal plain text; drafts stay local-only.

## Accessibility & Inclusion

Not a formal priority at this stage; no WCAG conformance target or certification is implied. Keyboard operability and visible focus remain required because they are core to the keyboard-first model. Don't regress behavior that already exists (explicit action labels, editable/IME shortcut protection, reduced-motion alternatives, selection/outcome announcements). The existing desktop/contact breakpoints remain authoritative; no new mobile UI. Revisit if the audience expands beyond the author.
