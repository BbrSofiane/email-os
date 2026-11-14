---
target: conversation reader + reply/compose surfaces (ReaderView, ReplyComposer, ComposeCard, DraftEditorCore, MessageAttachments, AttachmentChooser)
total_score: 28
p0_count: 0
p1_count: 1
timestamp: 2026-11-09T08-18-52Z
slug: src-components-readerview-vue-and-reply-compose
---
# Critique run 2: reader + reply/compose

Method: the critique input scored this area 28/40 (22 before the first pass) from source only. This run re-verified every claim by reading the code and, for each confirmed one, reproducing it in a failing test before the fix. Nothing was rendered: this VM has no browser, so layout statements come from CSS (asserted by `tests/reader/geometry.test.ts`, `tests/layout/polish-affordances.test.ts`, `tests/layout/design-typography.test.ts`) and contrast ratios are computed from the tokens, not sampled. The per-heuristic table of the input critique was not supplied, so none is reproduced here.

Out of scope and untouched: draft integrity (the P1: R then Esc leaving blank drafts, resuming drafts, a Draft marker in the reader status line, kept as the one open P1), provider handoff, the drawer panels, account/first-run, search, the selection bar and dock.

## Findings: verification

| # | Claim | Verdict | Change |
|---|---|---|---|
| 2.1 | `.reader-pane` pads 12px while header and list sit on the 50px inset | CONFIRMED | Reader scroller carries `padding-inline: 50px 24px`; message fill spans 6px to 6px like a list row, text on the inset; right edge 24px, measure still capped at 65ch/88ch |
| 2.2 | Docked compose margins (0) differ from the undocked card (50/24) | CONFIRMED | Docked card and `.reply-composer` use `6px 24px 12px 50px` |
| 2.3 | Skeleton row `1.4em` vs a 2em collapsed row | CONFIRMED (about 25px vs 49px pitch by arithmetic) | Shared `--message-row-height`; skeleton rows have the real collapsed pitch |
| 3a | Reply heading names the sender while To comes from Reply-To; Cc/Subject auto-open | CONFIRMED (8 tests failed first) | Heading follows the actual To (first address +N, full text in title); an edited To no longer force-opens Cc/Subject |
| 3b | The Message DTO has no Cc, so a Cc'd thread looks complete | CONFIRMED | Details shows `Cc: Not cached` (title explains); no wire change, nothing inferred |
| 3c | `Prepare reply` is internal wording | CONFIRMED | `Reply` (R kept) in titles, labels, palette, tests, docs. The blocked-reply notices and `Cancel reply preparation` keep "preparation" (DESIGN pins exception wording) |
| 3d | `describeError` leaks `invalid field:` | CONFIRMED | `The request was rejected.`; `request ID` jargon also removed |
| 3e | Chooser empty state is a ~230-char line with "Known files" jargon | CONFIRMED | `No cached files. Sync to fetch any that are missing.`; lists are `Files` and `Links` |
| 4a | Composer underline is 1.36:1 | CONFIRMED (computed) | Graphite (3.79:1 on Lifted Charcoal, 4.87:1 on Deep Umber) as a documented non-text exception; body textarea gets the same boundary |
| 4b | Caveat toggle is about 18x18 | CONFIRMED | 24px hit area, layout box unchanged |
| 4c | Participant spans are role-less tab stops with a colour-only focus style | CONFIRMED; removal REJECTED | Their focus drives the contact pane (the keyboard route to it, pinned by tests), so they stay; `role="group"`, one accessible name with the full address, real focus ring. They are only tabbable inside an opened Details |
| 4d | Chooser buttons all read `Save to Downloads` | CONFIRMED | `Save` with `Save {name}` accessible names, same as the inline list |
| 4e | File details failure has no retry | CONFIRMED | `Retry` that keeps focus (aria-disabled while retrying, focus moves to the list on success), no new live region |
| 4f | The `▸` is generated CSS; state not exposed | PARTLY WRONG | It is a native `<details>/<summary>`, so state is already exposed (test proves it). The real risk was the glyph leaking into the accessible name; fixed with CSS alt text and a fallback |
| 5a | Attribution pattern is English-only | CONFIRMED (44 tests failed first) | fr/de/es/it/pt/nl attributions and localized separators; wraps up to 3 lines; still lossless and still needs a trailing `>` run |
| 5b | Any `>` line forces the whole body to monospace | CONFIRMED | Quoted lines are ignored; only aligned non-quoted prose forces monospace |
| 5c | 15px reading role missing from DESIGN.md | CONFIRMED | Documented (frontmatter, Hierarchy, Two-Size Rule) with a contract test against `:root` |
| 5d | Subject 16px/600 over body 15px/400 leans on weight | NOT CHANGED | Ratio 1.067, same colour; weight, position and the sender row between them carry it. Changing size breaks the Headline role; no render to measure. Try tone before size if a render shows it blending |
| 5e | `quotedSnippet` slices UTF-16 units and previews the raw head | CONFIRMED (also `messageSnippet`) | Grapheme-safe `clipText`; reply preview is the prose part |
| 6 | `.reader-pending` should be a status role | CONFIRMED | `role="status"`, the reader body's only live region |
| 6 | Up to 20 Reply-To recipients in a single-line input | CHECKED (layout from CSS only) | Heading stays one short line (`first +19`); the input holds all 20 and scrolls |

## Remaining priority issues
- P1 — Draft integrity (deferred, see above).
- P2 — Never rendered: the Graphite textarea border next to the underlined rows may read heavy (revert only the `.field-textarea` `border-color` if so); proportional rendering of interleaved quotes; the 24px skeleton bar weight; participant ring on wrapped lines.
- P3 — Jargon leaks outside this area: `draft-errors.ts` ("request ID conflicted"), `useDrafts.ts` (`invalid ${field}`), `App.vue` `errorText` (`invalid request (field: …)`, "request ID conflict"), ActivityPanel ("Retry with a new request ID").
- P3 — On the active latest message the reply glyph sits right of the date, so that date ends about 28px, not 24px, from the edge.

## Not verified
Nothing was rendered; the opt-in Chrome suites (`reader.rendered`, `discovery.rendered`, `inbox-list.rendered-layout`, `disclosure-focus.rendered`) were skipped, including the one rendered case added for the subject/sender alignment. Screen-reader output (role/label on participants, the empty-alt glyph in WKWebView) was reasoned from markup. Native/WKWebView was not exercised.
