---
target: conversation reader + reply/compose surfaces after branch impeccable/reader-compose-followup (PR #37), independent rendered critique
total_score: 30
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
timestamp: 2026-11-10T06-38-22Z
slug: src-components-readerview-vue-and-reply-compose-run5
---
Method: single independent reviewer, rendered. Assessment A (design review in a real browser) and B (detector) were run by the same agent, so this is NOT the dual-agent isolation the critique command prefers; the detector result was read after the render pass was finished.
Detector: `impeccable detect --json` on ReaderView, ReplyComposer, ComposeCard, MessageAttachments, AttachmentChooser, ContactPane, HeaderGlyph, CommandGlyph and App.vue returned `[]` (0 findings). The 6 known style.css advisories were ignored as instructed.
Renders: branch on :5199 (1280x800, 1000x700, 20px root), origin/main on :5198 and a branch copy on :5197, both in scratch worktrees patched only with a delay hook in the fixture `getConversation` (to see the loading state). The checkout's source was not edited. The preview page adds a 55px banner, so absolute y values include it. Synthetic fixture only; Send never used.

# Run 5: did the branch improve the product versus run 3 (29/40)?

Short answer: yes, every claimed defect is fixed in the render, with no P0/P1 regression. The score moves 29 to 30 because only Consistency (4) earns a point; the same renders surface a composer-overflow problem at short viewports and large type that the previous notes never measured, and the branch's extra padding makes it slightly worse at 1000x700.

## Scores (fresh, then compared)

| # | Heuristic | Run 3 | Run 5 | Delta | Key issue |
|---|-----------|-------|-------|-------|-----------|
| 1 | Visibility of system status | 3 | 3 | 0 | Save keeps focus and reads `Saving…`; skeleton now truthful. Still: the loading line is the only status and header actions drop out while a reply is open (see N4) |
| 2 | Match system / real world | 3 | 3 | 0 | Bell for Reminders, clock for Remind is clearer. "Reply" vs "Reply to latest message" is two names for one action |
| 3 | User control and freedom | 3 | 3 | 0 | Esc closes the reply and returns focus to the active message toggle; Esc in the chooser returns to the Files button. Esc in the New Message card left focus on BODY (not compared on main) |
| 4 | Consistency and standards | 2 | 3 | +1 | One composer padding, one Details value column, two glyphs. Remaining: hairlines between messages vs "no row dividers", active message date 28px vs 24px from the edge, a white focus ring on one control |
| 5 | Error prevention | 3 | 3 | 0 | Unchanged |
| 6 | Recognition rather than recall | 3 | 3 | 0 | Unchanged |
| 7 | Flexibility and efficiency | 3 | 3 | 0 | R, Esc, J/K work; Cmd+O not testable here |
| 8 | Aesthetic and minimalist design | 3 | 3 | 0 | Removing the "Composing to" line and the 345px of dead card are real gains; the docked card is now heavier at short heights |
| 9 | Error recovery | 3 | 3 | 0 | Unchanged |
| 10 | Help and documentation | 3 | 3 | 0 | Unchanged |
| **Total** | | **29** | **30/40** | **+1** | Good (lower edge) |

## Per-issue verdict (all measured on the branch; before-numbers re-measured on origin/main where marked)

| # | Claim | Verdict | Measurement |
|---|-------|---------|-------------|
| 1a | Save drops focus to body | FIXED | Reader list: focus on `attachment-save` before, during (`aria-disabled`, text `Saving…`) and after; focusout log shows no event to null. Cmd+O chooser (opened from the Files and links button): `chooser-save` the same, no focus event to BODY; Tab cycles Save to Back to message; Esc closes and focus returns to the `files-links` trigger. Only the result sentence is announced (one polite status) |
| 1b | Active toggle focus cue | FIXED | Focused active toggle: `outline: 2px solid rgb(255,255,255)`, offset 1px, `:focus-visible` true; the lavender `inset 3px` bar is unchanged; ring left edge x=87 inside the fill at x=46. Visible in the render |
| 2 | Skeleton jump | FIXED | Branch: skeleton rows [187.9, 236.9, 285.9] vs real messages [187.9, 236.9, 285.9], subject y 154.7 both (0.0px). origin/main re-measured: rows [244.3, 293.3, 342.3] vs 187.9 (+56.4px). One `role=status` ("Loading conversation…") |
| 3 | Reply card covers the answered message | FIXED | Branch 1280x800: latest message 165.8 of 166px visible with Cc/Subject closed (strip 285.9) and 166 of 166 open (strip 231); origin/main: 156.5 of 166 closed (strip 301.1, scrollTop 0). 1000x700 branch: 166 of 166 closed and open (strip 191). 20px root: 207.3 of 207.3 (strip 225.6). After a synthetic wheel event the reader stops following: scrollTop 0, message 111.3 of 166 and 86.5 after toggling Cc/Subject, as designed. Focus never moved |
| 4 | Contact pane shifts | FIXED | Branch: name y=87.4, email box y=133.4, first thread y=199.4, identical before R, after R and after opening Cc/Subject (also at 1000x700). origin/main: name 87.4 to 119.8, email 133.4 to 165.8 (+32.4px) and the pane text includes "Composing to Ada Fixture ada@example.test" |
| 5 | Ragged Details values | FIXED | Branch: From, To, Cc, Sent values all at x=144.4 (labels at 90); at a 20px root all four at x=158, no label overflow (scrollWidth 60 = clientWidth 60) |
| 6a | Composer padding | FIXED | `.composer` inner padding `12px 16px 16px` in the reply; main measured `6.4px 9.6px`. Reply card margin `6px 24px 12px 50px`, left edge x=90 |
| 6b | Undocked card size | FIXED | New Message card 284px tall, footer at y=382, no dead card below it (main figure of 612.6px taken from the run-4 note, not re-measured here) |
| 6c | Chooser list indent | FIXED | list x=288, `padding-inline-start: 0`, file text x=288 (same as the dialog text) |
| 7a | Identical clock glyphs | FIXED | Header Reminders is a bell; the reader's Remind is a clock. Seen in the render |
| 7b | Two controls named Reply | PARTLY | Names differ now (toolbar `Reply`, per-message glyph accessible name `Reply to latest message`) but both still carry the same title "Reply — R. Reply targets the latest message from Ada Fixture", and DESIGN's own rule says to name each action once on every surface (N5) |
| m1 | Quote label edge | NOT VERIFIED | No fixture message has a quote (see Not verified) |

"Composing to" removal: no needed information was lost. The reply heading reads `Reply draft to Ada Fixture` (title carries the address) and the To row shows `Ada Fixture <ada@example.test>`; both follow the real To. The contact pane in New Message mode never showed a target (it shows "Focused conversation", Ada, stale) and still does, which is unchanged.

## New findings, ranked

- P2 N1: The reply card's footer (Save and close, Esc hint, Discard…) is pushed outside the card when Cc / Subject is open at short heights or large type. 1000x700: card scrollHeight 377 vs clientHeight 312 (card y 338 to 652), footer buttons at y 676 to 700, i.e. below the card and level with the window edge; 20px root at 1280x800: scrollHeight 440 vs 363, footer bottom 812 on an 800px viewport. The card scrolls internally, so keyboard users reach it by Tab, but a pointer user sees a card with no primary action and no scroll cue. This is not new (origin/main at 1000x700 with Cc/Subject open: scrollHeight 362 vs 312, footer bottom 694 vs card bottom 652), and run 4's "the 60% cap needs nothing more" missed it. Where: `src/components/ReplyComposer.vue:156-168` (`max-height: 60%`, overflow auto, footer not sticky). Fix: pin the footer (sticky bottom) or let the card claim up to ~75% and compress the quote preview first. Suggested: /impeccable layout.
- P3 N2: Slight regression from fix 6a at 1000x700: the default (Cc/Subject closed) reply card is now 313.6px with a 5px internal scroll (scrollHeight 317 vs 312) where main was 303.5px with none, and the thread strip drops from 201 to 191px. Cause: `--composer-padding` is +11px taller than the old reply padding. Trade is acceptable for the visible message, but it is a measurable cost the run-4 note does not list.
- P3 N3: With the reply open the reader scroller is scrolled by 24.5px, which crops the h2 subject against the scroller's top edge (a half-sliced line of text directly under the header at 1280x800) and hides it entirely once Cc / Subject is open. The thread subject is the only thing naming the conversation; the Subject field repeats it, so no information is lost. Where: `ReaderView.vue:330-364` (`revealLatest`).
- P3 N4: The header actions reflow by 32px when R is pressed: the Remind clock drops out (App.vue:744 hides it while a draft is active) so "Preview · in-memory" jumps from x=536 to x=568 (the right-hand glyphs stay put). Same family of defect as issue 4 (chrome moving when a reply opens). Pre-existing, untouched by the branch; one stable slot (disabled instead of absent) would remove it.
- P3 N5: DESIGN's Do ("name each action once ... on every surface") is now contradicted by `Reply` and `Reply to latest message` (ReaderView.vue:1097) and identical hover titles. Either update the Do or give the glyph the shared name and drop the second control.
- P3 N6: Unchanged leftovers confirmed in the render: 1px `--rule` lines between collapsed messages (style.css:1528-1530) against "rows are separated by rhythm alone"; the active message's date ends at x=956 while collapsed rows end at x=984 (the reply glyph sits right of the date), a visible 28px jag in the date column; the focused active toggle is the only control with a white ring instead of lavender (deliberate and documented, but a second ring colour in one pane).
- P3 N7: After Esc in the New Message card, `document.activeElement` was BODY. Not compared against main, so it may be old. Out of this branch's stated scope but part of keyboard flow.

## Strengths worth keeping
- The follow-the-latest scroll is a good solution: instant (no smooth scroll, nothing to gate on reduced motion), stops at the first wheel or pointer, never moves focus.
- The `aria-disabled` pattern for Save and Retry keeps focus without adding a live region; verified in both surfaces.
- The skeleton hands off to the real list with zero pixel change, and nothing animates.

## Regression sweep
- Keyboard: R opens the reply with focus in the body, Esc closes it and returns focus to the message toggle; J advanced to the next conversation; Tab in the chooser wraps inside the dialog; Esc restores focus. Cmd+O could not be tested (see below).
- Live regions: during a save only the result sentence is exposed; the loading state has a single `role=status`; the reply card carries one visual status paragraph plus its 1px sr-only twin (as designed).
- Reduced motion: no animation or smooth scroll was added; the new scroll code assigns `scrollTop` directly.
- One Signal Rule: the lavender bar on the current message appears once; a lavender focus ring on a composer field is visible at the same time but DESIGN explicitly allows the focus ring.
- Token discipline: new CSS uses `--composer-padding`, `--message-row-height`, `--text-primary`; no new off-palette values seen in the diff. The detector found nothing.

## Not verified
- Cmd+O on Linux: the preview reserves it and the chooser did not open; it was opened from the Files and links button instead.
- Gmail mode (read controls) skeleton variant and any real loading path that opens a conversation with no list-row identity (the hidden `reader-skeleton-subject` branch); the fixture has no quote, so the Show quoted text label edge (m1) was not seen.
- Contrast was not sampled; screen-reader output (the `Saving…`/`Save` name change, bell glyph) was reasoned from the tree, not heard.
- Native/WKWebView, light theme and the opt-in Chrome suites were not run. Wheel behaviour was checked with a synthetic WheelEvent, not a physical scroll (the preview's scroll tool did not move the reader).
- Esc-to-BODY in New Message and the footer overflow at 20px were not compared against origin/main (the 1000x700 overflow was).
