---
target: conversation reader + reply/compose surfaces (ReaderView, ReplyComposer, ComposeCard, MessageAttachments, AttachmentChooser, ContactPane)
total_score: 29
p0_count: 0
p1_count: 0
timestamp: 2026-11-10T01-03-38Z
slug: src-components-readerview-vue-and-reply-compose
---
# Critique run 4: fixes for the first rendered critique (run 3, 29/40)

Method: every item was reproduced in a real browser (fixture preview at 1280×800, 1000×700 and a 20px root font; the page adds a ~55px synthetic-workspace banner, so absolute y values include it), then fixed test-first and re-measured. The loading state was measured with a deliberately delayed `getConversation` (and a delayed `saveAttachment`) in the fixture client, a temporary local patch that is not committed. Gmail-only variants (read controls) and the quote toggle have no fixture, so they were measured on replicas built from the real classes. No re-scoring was done: the score above is run 3's, carried over until the next render.

Out of scope and untouched: draft integrity (blank drafts after R then Esc, resuming drafts, a Draft marker in the reader), the drawer panels, account/first-run, search, the selection bar and dock, the Rust DTO.

## Findings: before and after (measured)

| # | Finding (run 3) | Before | After | Change |
|---|---|---|---|---|
| 1a | P1 Save drops focus to `<body>` | `document.activeElement` = BODY during and after a transfer (reader list and Cmd+O chooser; in the chooser the modal's Escape and Tab trap then stop hearing keys) | `attachment-save` (reader) and `chooser-save` (chooser) during and after; button reads `Saving…`, `aria-disabled`, same element | Save stays mounted and aria-disabled (as Retry does); Cancel hands focus back to Save when it held it; focus that moved elsewhere is left alone; no live region added; chooser Reload file list gets the same treatment |
| 1b | Active message toggle has no focus ring of its own | outline `none` on the focused active toggle; the 3px lavender bar is the only cue | `solid 2px rgb(255,255,255)`, offset 1px, only on `:focus-visible`; bar unchanged (`inset 3px` lavender); ring left edge x=87 inside the fill (46) | Paper White ring: active (lavender bar) and focused (white ring) are different facts, and lavender still appears once |
| 2 | P1 skeleton jumps | first skeleton row y=244.3, first real message y=187.9 (+56.4px) | rows [187.9, 236.9, 285.9] vs messages [187.9, 236.9, 285.9] (0.0px); 1000×700 at a 20px root: rows [213.2, 274.2, 335.2] vs the same (0.0px); meta-row replica 204.1 vs 204.1 | Sender, date and status are one line: the meta row's slot when the loaded reader has one, otherwise out of flow over the first placeholder row; hidden subject placeholder is an `h2.reader-subject`; text and `role="status"` unchanged, one live region |
| 3 | P2 reply card covers the message it answers | Cc / Subject open: strip 241.1px, latest message 102.5 of 166px visible (closed: 301.1px, 162.5px); scrollTop 0 | latest message 166 of 166px visible in both states (scrollTop 9.5 and 69.5); 1000×700 strip 201.1 and 191px, 166 of 166; 20px root strip 225.6px, 207.3 of 207.3 | The reader scrolls the latest message into view when a reply opens and follows the card as it grows, until the user scrolls or moves through the thread; focus never moves |
| 4 | P2 contact pane shifts while a reply is open | (run 3) name 87→120, email 143→176 (33px) | name y=97.4, email y=151.4, first thread y=211.4, identical open and closed | The "Composing to …" line is removed: the reply heading and To row already name the recipient |
| 5 | P2 ragged Details values | values at x=126.1 / 109 / 111.4 / 123.7 | all four at x=144.4 (158 at a 20px root), no label overflow | Fixed 3rem label column |
| 6a | P2 reply padding 10px vs card 16px | reply `0.4rem 0.6rem` | reply and card `12px 16px 16px` (`--composer-padding`) | One token |
| 6b | P2 undocked card 613px tall, ~345px dead | 612.6px, footer y=382.4 | 284.2px (331px at a 20px root), footer unchanged | `flex: 0 1 auto` |
| 6c | P2 chooser list indented 40px | file text x=328 vs x=288 | x=288 | `padding-inline-start: 0` |
| 7a | P3 identical clock glyphs | same SVG for Remind and Reminders | Reminders is a bell; Remind keeps the clock | New `remind` name in HeaderGlyph |
| 7b | P3 two controls named Reply | both `Reply` | toolbar `Reply`; per-message glyph `Reply to latest message`; titles and R hint unchanged | The control was not removed |
| m1 | Show quoted text label 8px inside the 90px edge | label x=98 | label x=90 (button box 82), replica | `-8px` margin, like `.selection-actions` |

## Not changed, with reasons
- The `Save` ghost button's text is not at a text edge (it follows the file size in a flex line), so no alignment was needed.
- The Esc hint beside `Save and close` stays bare text, and signature and quote still share one style: both minor, and neither changes without a decision on the footer.
- No minimum thread strip was added to the reply card: the 60% cap already leaves at least 40% of the pane, and the scroll fix needed nothing more.
- The two-name decision for Reply is wording only; removing a visible control is a separate decision.

## Remaining priority issues
- P1 — Draft integrity (deferred, unchanged).
- P3 — A latest message taller than the thread strip is aligned by its top while replying; its tail is behind the card until the user scrolls (by design, not measured with a long fixture).

## Not verified
Gmail mode (read controls) in a real render: the meta-row variant of the skeleton was measured on a replica. A real quoted message (no fixture) was not rendered. Cmd+O on Linux (browser preview leaves it reserved; the chooser was opened from the reader's Files and links button). Screen-reader output (the `Saving…`/`Save` name change, bell glyph). Native/WKWebView. The opt-in Chrome suites stay skipped.
