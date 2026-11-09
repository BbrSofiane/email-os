---
target: "reader + reply/compose after PR #35"
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/exedev/.t3/worktrees/email-os/impeccable-reader-compose-critique-2/src/components/ReaderView.vue"
target_fingerprint: "sha256:f66f63b7fa5b8b123058263c23c77158f72f6b05795bb1f9a5d6e7c03a302358"
target_path: /home/exedev/.t3/worktrees/email-os/impeccable-reader-compose-critique-2/src/components/ReaderView.vue
timestamp: 2026-11-09T20-01-29Z
slug: src-components-readerview-vue
---
Method: dual-agent (A: design review on the rendered fixture preview · B: detector + in-page overlay).

# Critique run 3: reader + reply/compose, after PR #35 (first rendered look)

Score 29/40 (Good, lower edge). Heuristics: 1:3 2:3 3:3 4:2 5:3 6:3 7:3 8:3 9:3 10:3.

## Verified in the render
Subject, sender, body, Details and attachments sit at x=90 (= list sender text); message fill 46..1002 (6px inside the pane edges); date right edge 24px in; docked and undocked composers share margins 6/24/12/50; caveat toggle 24x24; Graphite field underline and textarea border 3.79:1 (Seam 1.36:1); reading body 15px/24px, max 620px; 2px lavender ring on every control except the active message toggle (deliberate).
Detector: 0 findings on the six .vue files, App.vue, layout and type scopes; style.css 6 pre-existing (3 side-tab = documented focus bar, 3 radius advisories). Overlay: reader and reply clean; new-message card flat-type-hierarchy (pre-existing, weight separates levels by design).

## Priority issues
- P1 Save on an attachment drops focus to body (MessageAttachments swaps the button; Retry has a focus handler, Save does not).
- P1 Skeleton still jumps: first skeleton row y=244.3 vs first real message y=187.9 (56px) because the Loading status line and identity line push it down (replica measured; the fixture loads instantly). Row pitch 49px is right.
- P2 Contact pane shifts 33px while a reply is open ("Composing to ..." line); pre-existing, recorded out of scope in run 1.
- P2 Details values start at x=126/109/111/124 (label column has no fixed width); "one x" claim only holds for the Details summary.
- P2 Composer geometry: reply padding 10px vs docked new-message 16px; undocked card 613px tall with ~360px dead space; chooser list indented 40px; reply composer leaves 225-241px of thread and covers the message being answered.

## DESIGN.md claims contradicted
Skeleton "does not jump" (56px offset); "one x" for Details values; contact email on first-list line while composing (143, not 96+).

## Minor
Hairlines between collapsed messages look like list dividers; Show quoted text/Save text sits 8px inside the 90px edge; Esc hint reads as a label; signature and quote share one style; Details summary and participant spans are 16px high; 1-3px overflow on message-toggle/composer-top; identical clock glyphs for Remind and Reminders; two controls named Reply.

## Not verified
Cmd+O on Linux, real Gmail wording, a real loading state, quote/mono split on real messages (no fixture has one), read-state line, screen-reader output, pixel contrast.
