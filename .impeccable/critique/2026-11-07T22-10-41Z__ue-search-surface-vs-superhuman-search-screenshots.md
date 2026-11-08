---
target: src/App.vue search surface vs Superhuman search screenshots (re-run after P1-P5 fixes)
total_score: 34
p0_count: 0
p1_count: 1
timestamp: 2026-11-07T22-10-41Z
slug: ue-search-surface-vs-superhuman-search-screenshots
---
# Critique re-run: our search experience vs Superhuman reference (after P1-P5 fix batch)

Method: dual-agent (A: 753be25a-de1c-4d8e-aaf1-03bc83c48c34 design review · B: 744dff78-d60f-451f-8ef4-67a09d50c9be detector + browser evidence)
Baseline: 27/40 (2026-11-07T20-10-31Z snapshot). Fresh score on the fixed working tree: 34/40.

## Verification of the P1-P5 fixes
- P1 FIXED: validateSearch (search.ts:36-80) per-keystroke inline errors (role=alert, data-test=search-error); submit gated client-side — 20,026-input fuzz shows validateSearch and parseSearch agree exactly, invalid never reaches searchMail; banner hides Retry for invalid_request/searchQuery and says "Edit the query above — the same query fails again."; single period (test asserts no ".."). Live: `subject:` shows `"subject:" needs a value — e.g. subject:"example".` and no banner.
- P2 FIXED: #search-help is now 6 operator+gloss rows + 1 "Not supported: dates, labels, Cc/Bcc, parentheses." line. Nit: "AND OR" run-on row.
- P3 FIXED with edge-case half-fixes: combobox+listbox (aria-activedescendant, highlighted = Focus Stone + 4px lavender bar, palette vocabulary), up to 8 session-only recents + 6 cached-correspondent matches (from:"mailbox"), Enter applies, click applies, BROWSE-10 inert. Half-fixes: no max-height/scroll (up to 14 rows), aria-controls dangles when ul unmounts, Esc→ArrowDown doesn't reopen, pointer highlight doesn't scroll into view.
- P4 FIXED: `Search: <query>` header (16px) + X (data-test=search-clear, "Clear search and return to the previous context") + slim one-row form; Esc is three-step (close listbox → collapse form, focus to row, context stays → exit context), all tested and captured live (07/08/08b).
- P5b FIXED: single-from: searches group under `Name (count)` captions (role=presentation, non-tabbable); date captions replaced in grouped view; one pure groupRowsBySender shared by App.vue listRows and InboxList items so nav order == render order. Live: `Ada Fixture (15)` + `<script>…</script> (3)` (literal, XSS-safe).
- P5a FIXED: RowGlyph attachment paperclip, .row-attachment role=img aria-label "Has attachments", only when hasAttachments===true, before the date (16px glyph at x=1048 vs date x=1076). 18/18 fixture rows show it. Semantics gap: false and undefined both render nothing (unknown indistinguishable from none — inconsistent with 3-state read marker).

## Design Health Score — 34/40 (Good, 28-35 band; was 27)

| # | Heuristic | Was | Now | Key note |
|---|---|---|---|---|
| 1 | Visibility of system status | 4 | 4 | coverage role=status survives form collapse; stale fences |
| 2 | Match system / real world | 3 | 3 | plain-language errors now; "AND binds before OR" + byte-cap still spec-speak; unstyled native clear-X |
| 3 | User control and freedom | 3 | 3 | Esc steps undiscoverable; duplicate exits (header Back + search-clear X + native X); no edit path from results header |
| 4 | Consistency and standards | 3 | 3 | suggestions speak palette vocabulary but 28px rows vs palette 36px |
| 5 | Error prevention | 2 | 4 | per-keystroke validation, client gate, byte cap explained |
| 6 | Recognition rather than recall | 2 | 3 | help list + live suggestions; no placeholder; recents session-only |
| 7 | Flexibility and efficiency | 3 | 3 | `/`, glyph, palette, contact from:, restore; no operator completion |
| 8 | Aesthetic and minimalist | 2 | 3 | collapsed state slim; post-submit form stays open → ~10 lines chrome, query duplicated |
| 9 | Error recovery | 3 | 4 | inline cause while typing; dead Retry gone; banner copy can point at a collapsed form |
| 10 | Help and documentation | 2 | 4 | operator+gloss rows + unsupported line; aria-describedby wiring |

Cognitive load: 2 failures (listbox edge cases; error copy when form collapsed); 1 decision point >4 options (listbox). Detector: 6 advisory findings, all in style.css, all FP/out-of-scope for the search regions (search CSS clean, zero findings in App.vue/InboxList.vue/search.ts). Browser: zero console errors; all text passes AA 4.5 (header 14.7, secondary 7.8, unsupported 5.4, glyph 4.3 non-text pass); no overflow at 1440×900; screenshots /private/tmp/email-os-search-critique2/ 01-11.

## Remaining priority issues
- P1 — Results header is static text, no edit affordance: after Esc collapses the form, only `/` or the glyph reopens it, and the banner copy "Edit the query above" can reference a hidden form. Fix: make .search-results-query a button calling revealSearch(); adjust banner copy when !searchVisible. → /impeccable polish + clarify
- P2 — Post-submit duplication/chrome weight: form stays open after submit, query shown twice (header + input), ~10 lines above results. Fix: auto-collapse form on successful submit (keep open while draft differs or on error) so header+coverage+list is the default, like the reference. → /impeccable distill
- P2 — Suggestion listbox edge cases: no max-height/scroll, dangling aria-controls when unmounted, Esc→ArrowDown can't reopen, pointer highlight no scroll-into-view. → /impeccable harden + polish
- P3 — Attachment glyph two visible states: unknown (undefined) vs none (false) both render nothing, inconsistent with the 3-state read marker. Fix: outline paperclip "Attachment state unknown" for undefined, or document the two-state convention in DESIGN.md §5. → /impeccable clarify
- P3 — Sender captions replace date captions in from-searches (calendar orientation lost exactly where recency matters); "AND OR" help run-on. Fix: document parity or nest date captions under sender captions; copy "AND / OR". → /impeccable layout / polish

## Minor observations
- "AND OR" run-on in help row; unstyled native type=search clear-X duplicates search-clear X; no input placeholder (fresh session shows empty listbox); maxlength=512 chars vs 512-byte grammar cap (now caught inline, acceptable); coverage line sits below the 7-line help when form open (reads as form output); search-clear and context-back are near-duplicate exits.

## Questions
1. Should submitting auto-collapse the form so header+list is the default results state, with the header itself clickable as the only edit path?
2. Sender grouping drops date captions in from-searches — acceptable reference parity, or nest date captions under sender captions?
3. Remaining scope: just the P1 edit-affordance + auto-collapse (top 2), or all five remaining issues?
