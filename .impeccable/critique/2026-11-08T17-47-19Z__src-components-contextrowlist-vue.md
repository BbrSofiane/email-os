---
target: "critique the implemented changes (list contexts: Trash, Reminders, Drafts)"
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
target_identity: "file:/home/exedev/.t3/worktrees/email-os/impeccable-drawer-panels/src/components/ContextRowList.vue"
target_fingerprint: "sha256:852e02b62b93cccc4e187adac8d69309c59b4f073f4b11260066bd30c5b7f7f1"
target_path: /home/exedev/.t3/worktrees/email-os/impeccable-drawer-panels/src/components/ContextRowList.vue
timestamp: 2026-11-08T17-47-19Z
slug: src-components-contextrowlist-vue
---
Method: dual-agent (A: a78f15edde6d73aa8 · B: ab8b277815f1733b9)

Target: Cached Trash, Reminders and Drafts as main-pane list contexts (branch impeccable/list-contexts, PR #32). Rendered at 1280x800 in a throwaway harness; code-verified.

## Design Health Score (27/40, Acceptable)

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 3 | "Pending 4" counts failed and removing rows; Drafts fallback reason is title-only (ComposeCard.vue:115) |
| 2 | Match system / real world | 3 | Failed-row note does not say which of removal/return failed; "No history reminders." |
| 3 | User control and freedom | 3 | Reply draft needs two Escs, new-message card one; no Discard in Drafts list |
| 4 | Consistency and standards | 3 | Tab switches splits in Inbox, not in Reminders; "Inbox N" tab beside context h1 |
| 5 | Error prevention | 3 | Trash read-only holds; Cancel reminder has no confirmation (reversible) |
| 6 | Recognition rather than recall | 2 | Reminders row actions only on current/hovered row; Drafts rows show no body |
| 7 | Flexibility and efficiency | 2 | No G chord for Trash/Drafts; no key for Reminders tabs or row actions |
| 8 | Aesthetic and minimalist design | 3 | Contact pane is dead chrome in these contexts |
| 9 | Error recovery | 3 | Failed reminder has Cancel but no Retry |
| 10 | Help and documentation | 2 | Explanations are hover titles; inert Trash keys silent |
| **Total** | | **27/40** | Acceptable (drawer pass was 20/40) |

## Design specificity
Mostly authored (honesty vocabulary, shared 36px row and Lavender focus bar, reply drafts routed to source thread). Generic seams: plain Drafts/Reminders text rows, 668px new-message card for four fields.

Deterministic scan: .vue files and src/components, 0 findings. CSS: 6 hits in src/assets/style.css (side-tab 881/1201/2487, of which 1201 is the documented focus cue = intentional; radius 351/840/1237 outside the 0/4/6/10/full scale, pre-existing). Overlay: one straggler on P.contact-unknown (contact pane), unstable.

## Priority issues
1. [P1] Reminders tabs and row actions have no keyboard path from the list; Trash and Drafts have no G chord. Fix: [ / ] for tabs, G chords, row keys. Command: shape, harden.
2. [P2] Pending bucket (useReminders.ts:51) holds failed/removing rows and counts them; no Retry. Fix: needs-attention grouping and honest count; name the cause. Command: clarify.
3. [P2] Drafts rows not triageable (no body preview, no Discard) and fallback reason hover-only. Command: layout, clarify.
4. [P2] Header reads as two sibling tabs ("Cached Trash | Inbox 14"); Inbox tab has no aria-current. Fix: hide split nav in Trash/Drafts. Command: quieter.
5. [P3] Esc asymmetry, focus falls to BODY after card close, dead contact pane, silent inert keys, 24px Reschedule/Cancel targets, Ash on focused row 4.99:1. Command: polish.

## Persona red flags
Alex: no chords for Drafts/Trash, no tab or row keys in Reminders, Tab contradicts Inbox. Sam: reason title-only, hidden actions at opacity 0, no rail item current in Reminders. Riley: 158px picker shifts rows, Cancel immediate, no Retry, dead keys silent.

## Minor observations
12em full-date column in Reminders; reader from Reminders shows no reminder state; To field focused when recipient exists; contact pane "ada@example.test ada@example.test"; rail 28px, header icons 32px.

## Questions
Why is the failed reminder in a Pending tab? Is row-level Discard safe enough for Drafts triage? One shared Needs attention treatment?

Not verified: Reminders Retry/recovery paths, draft-lifecycle alerts, picker contrast, native/WKWebView, VoiceOver, long lists.
