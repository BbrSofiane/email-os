---
target: src/App.vue search surface vs Superhuman search screenshots
total_score: 27
p0_count: 0
p1_count: 1
timestamp: 2026-11-07T20-10-31Z
slug: ue-search-surface-vs-superhuman-search-screenshots
---
# Critique: our search experience vs Superhuman search reference

Method: dual-agent (A: 0ade3703-e002-43f5-9c51-fc695ae21974 design review · B: b409d2e8-3a7d-4e3d-9523-6f0b8ce832b7 detector + browser evidence)
Target: src/App.vue search surface (mail-search form, search results, coverage/empty/error states) vs Superhuman search screenshots (search overlay + results)

## Superhuman reference breakdown (what the two screenshots show)

1. Search overlay: full-height dark panel, "Search" label + X close; left column = contact suggestions (name + email, two-column rows) above a hairline, then recent query terms as plain rows with a full-width gray keyboard-selection bar; right column = "Tips": ~17 operators each as operator (mono, light) over a plain-English gloss (gray, smaller) — from:, to:, quoted phrases, has:attachment, subject:, in:sent/in:inbox/-in:inbox/in:label, is:unread/starred/shared, before:/after: dates, older_than:/newer_than:.
2. Search results: the query becomes the list header with an X to clear; results grouped by sender with "(count)"; rows carry label chips, bold subject + gray snippet, purple read checkmarks, paperclip, right-aligned date; selected row = dark fill + purple left bar (same "you are here" language as our focused row); PDF attachment chips under rows; right-hand contact card for the searched correspondent.

Scope we intentionally do NOT copy (PRODUCT.md anti-reference, spec U-items): the extended operator grammar, read-receipt checkmarks, contact enrichment, ranking claims. Visual/interaction reference we SHOULD match: operator+gloss tips in our own grammar, query visibility, suggestions/recent queries, sender grouping, keyboard-highlight rows.

## Design Health Score — 27/40 (Acceptable, top of band)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 4 | Loading/error/empty/coverage all explicit in words (role=status/alert); stale-response fences |
| 2 | Match system / real world | 3 | "AND binds before OR" + unsupported-list is spec-speak; no glosses |
| 3 | User control and freedom | 3 | Back/Esc/restore exist; but Esc in input exits whole context at once; no visible clear; Retry is dead on syntax errors |
| 4 | Consistency and standards | 3 | Form+buttons vocabulary differs from command palette's input+rows vocabulary 1cm away |
| 5 | Error prevention | 2 | Grammar validated only at submit; no inline feedback while typing; 512-char attr vs 512-byte parser mismatch |
| 6 | Recognition rather than recall | 2 | Grammar must be recalled from a prose paragraph; no suggestions, no recent queries, no placeholder example |
| 7 | Flexibility and efficiency | 3 | `/`, header glyph, palette, sender-search, cached-only toggle, full session restore; no autocomplete |
| 8 | Aesthetic and minimalist design | 2 | Search block is the heaviest chrome in the shell: label + input + 2 buttons + checkbox + 2 paragraphs ≈ 6 lines |
| 9 | Error recovery | 3 | Error names exact cause + offers edit/Retry/cached-only; but "..-exclusions.." double period and Retry re-fails identically |
| 10 | Help and documentation | 2 | Always visible (good) but one dense 75ch paragraph, no operator+gloss structure, no examples |

## Anti-patterns verdict

LLM: not slop-tier — a Linear/Notion/Raycast-fluent user largely trusts it (warm-dark flat plane, 36px rows, one violet signal, exact counts, honest "total unknown") — but pauses at: form block not speaking palette vocabulary; double-period microcopy; prose help where comparable tools show operator+gloss rows; DESIGN.md promises a row attachment glyph the code doesn't render; unstyled native type=search clear-X; no input placeholder.
Detector (detect.mjs --json src, exit 2): 6 findings, all advisory, all in src/assets/style.css — design-system-radius ×3 (style.css:334, 822, 962), design-system-color ×3 (663, 858, 1199, all the documented rgba(0,0,0,0.35) shadow alpha = false positives). Zero findings in any .vue/.ts. Live detect.js injection on inbox + search states: flat-type-hierarchy (11/12/16px = documented scale, FP), line-length on single-line <p>s (heuristic noise); no user-visible overlay shipped. Browser evidence (fresh rodney tab, 1440×900, dev server :5199): no console errors, no overflow/contrast issues; captured exact copy of form, help, coverage variants, error banner (double period visible), empty state; XSS fixture rows render as literal text; done-more unreachable in fixture (<20 conversations); provider_candidates coverage unreachable in browser-fake (always cached_incomplete).

## Overall impression

Our search is more honest than the reference (coverage disclosure, per-page vs global empty, deterministic error states) and its round-trip restore is trust-building. The gap to the reference is recognition and chrome economy: the query-entry UI is a heavy labeled form with a prose help paragraph, while Superhuman shows a scannable operator+gloss tips column, suggestions, and a query-as-header. The single biggest opportunity: make the search block speak the same vocabulary as the command palette and the reference's tips — operator+gloss rows for OUR grammar — and fix the dead Retry / double-period error path.

## What's working

1. Honest coverage reporting (Principle 1 implemented literally): four-way coverage copy, "total unknown", cached_incomplete pinning, per-page empty vs global empty, stale-async fences. Exceeds the reference, which discloses nothing.
2. Session restoration: query/rows/cursor/coverage/focus survive open→Back (BROWSE-09); slow searches can never overwrite a newer context.
3. Sender search from contact pane with honest limits: from:"addr" plus exactly-4 "Recent cached mail" rows, never invented on failure (BROWSE-15).

## Priority issues

- **P1 — Dead Retry + double-period in the error state.** `subject:` → recovery banner "Could not load Search: unsupported search syntax. …-exclusions.." (errorText App.vue:1690 already ends with "."; template adds another) and Retry re-runs the identical failing query. Violates the "dead controls that look actionable" anti-reference. Fix: validate on input and show the specific syntax error inline; suppress Retry when listError.field === 'searchQuery'; fix the period. → /impeccable harden + clarify on the search block.
- **P2 — Operator help is one dense prose paragraph, not the reference's operator+gloss list.** #search-help forces recall of 6 rules. Fix: two-column operator/gloss rows for our real grammar (from:, to:, subject:, "…" exact phrase, AND/OR combine, -term exclude) + one "Not supported: dates, labels, Cc/Bcc, parentheses" line. → /impeccable clarify / typeset on .mail-search.
- **P2 — No suggestions or recent queries under the input.** Reference shows contacts + recent queries with keyboard highlight; ours shows nothing until Enter. Fix: local per-account recent queries + cached-contact matches as arrow-navigable rows under #mail-query. → /impeccable polish (interaction pass on .mail-search).
- **P2 — Query/context chrome: heavy form block, duplicated Back, aggressive Esc.** 6 lines of chrome; Search submit + "Back to previous context" buttons compete and duplicate the header Back glyph; Esc in the input both hides the form and exits the search context in one keystroke; no visible clear-X. Fix: one-line results header with query echo + clear; single entry row; first Esc collapses form, second exits context. → /impeccable distill / polish on the search block.
- **P3 — Results lack sender grouping; promised attachment glyph missing.** Flat date-ordered rows scan worse for from: queries than the reference's sender groups with (count); DESIGN.md §5 promises an attachment glyph before the date that InboxList.vue does not render. Fix: attachment glyph from summary data; consider sender grouping when the query is a single from:. → /impeccable layout / design.

## Persona red flags

- Alex (impatient power user): retypes every query — no recent queries/autocomplete; Esc nukes the whole search context unexpectedly; Retry is a dead end on syntax errors. Core task is under 60s via `/`, so no abandonment, but the recovery path feels patronizing.
- Jordan (first-timer): "AND binds before OR" and the unsupported list are spec-speak, not plain language; empty input has no example placeholder; the error banner's double period reads as sloppiness at exactly the trust moment.
- Sam (accessibility-dependent): role=search/status/alert, aria-describedby, focus management and visible focus ring are all present and correct — the red flag is the overloaded in-input Esc and the double-period copy read aloud verbatim.

## Minor observations

- maxlength="512" counts characters; parseSearch rejects >512 bytes — multibyte queries pass the attribute and fail at submit, and the error copy doesn't mention the byte cap.
- No placeholder in the empty input — a one-line example (from:… "phrase" -exclude) would fix recognition for free.
- QA captures show a duplicated "Search" in the top strip (fixture workspace-strip artifact) and an "Archive" chip with no counterpart in current InboxList.vue markup — capture/code drift to verify.
- Live detector's flat-type-hierarchy and line-length hits on the search page are false positives against DESIGN.md's documented scale.

## Questions to consider

1. Search and Commands are both "type-and-get-results" surfaces but use two vocabularies (form+buttons vs palette input+rows) — should search live in the same overlay vocabulary as the palette, with the query still editable?
2. Our coverage honesty exceeds the reference's — should "No matches on this candidate page" auto-continue scanning so the only visible empty state is the true one?
3. For single from: queries (the contact-pane path), should results group by sender/thread with counts like the reference instead of flat date order?
