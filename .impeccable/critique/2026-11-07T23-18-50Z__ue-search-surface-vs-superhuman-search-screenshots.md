---
target: src/App.vue search surface vs Superhuman search screenshots (run 3, after full backlog)
total_score: 35
p0_count: 0
p1_count: 1
timestamp: 2026-11-07T23-18-50Z
slug: ue-search-surface-vs-superhuman-search-screenshots
---
# Critique run 3: search vs Superhuman reference (after full backlog)

Method: dual-agent (A: e3452602-ca3e-48a1-ac29-75bb43a2f46d design review, relaunched once after a provider error · B: 432e801e-a523-4eeb-afd3-6388621b4a91 detector + browser evidence)
Scores: 27/40 (20-10-31Z) -> 34/40 (22-10-41Z) -> 35/40 (this run). Band: Good (28-35), one point below Excellent.

## Backlog verification — all six FIXED, no regressions
- Header-as-edit-button (App.vue:2086-2097, revealSearch, aria-label "Edit search query: {q}") + conditional banner copy (searchSyntaxEditHint, App.vue:1862-1867; both variants tested, no "..").
- Auto-collapse on submit (App.vue:793-794) + 4 reopen paths + stepped Esc (listbox -> form collapse -> context exit); restore keeps collapsed state; round trip exact.
- Listbox hardening: v-show mounted ul (aria-controls stable), max-height 168px + scroll, scrollIntoView on arrows+pointer (nextTick-deferred), ArrowDown reopens, aria-expanded/activedescendant correct. Live: 7 suggestions, clientHeight 168 < scrollHeight 196, scroll traces verified.
- Nested sender>date captions in single-from: searches (InboxList items, per-group date bucket reset, leading rule applies to first caption of either kind); j/k skips captions across group boundaries; one shared row-order definition (listRows == items).
- "AND / OR" help row + placeholder 'from:ada "weekly status" -invoice' (validateSearch(placeholder)===null, tested).
- Glyph three-state: true=solid "Has attachments", false=none, null=outline "Attachment state unknown" (RowGlyph attachment-outline, opacity .75); wire Option<bool> never inferred (search.rs:169-186), schema v4, DESIGN.md:316 documents it. 34/34 inbox-list tests pass.

## Heuristics 35/40
1 Visibility 4 | 2 Match real world 3 | 3 User control 3 | 4 Consistency 3 | 5 Error prevention 4 | 6 Recognition 3 | 7 Flexibility 3 | 8 Minimalist 4 | 9 Error recovery 4 | 10 Help 4

Cognitive load: 3/8 failures (one obvious exit — three exits exist; Esc ladder undiscoverable; listbox can hold 14 options >4). Detector: same 6 known pre-existing style.css FP advisories; ZERO new findings in search regions. Browser: zero console errors; all text AA (header 14.7, secondary 7.8, unsupported 5.4, error 7.7); no overflow at 1440x900; glyph before date; screenshots /private/tmp/email-os-search-critique3/ 00-13 + evidence.log.

## Remaining priority issues
- P1 — Triple exit + unstyled native clear-X: context-back <- and search-clear X both call contextBack(); native type=search cancel button unstyled, clears draft only. Fix: style/hide ::-webkit-search-cancel-button; one visible exit in search context (header X); <- keeps generic Back. -> distill + harden on results header.
- P2 — Suggestion pool = loaded rows only (slice(0,100)); no operator completion (typing "fr" suggests nothing); recents session-only. Fix: operator-prefix completion (from:/to:/subject:); decide+document recents persistence. -> polish on suggestions.
- P2 — Header query button has no at-rest affordance (padding-0 ghost looks like a heading until hover). Fix: subtle always-visible cue (pencil glyph or underline/hover ring). -> polish on .search-results-query.
- P3 — Grouped caption hierarchy invisible (sender and date captions share one .row-group style; 48px blocks each; caption spam for many senders). Fix: differentiate sender level; skip nested date caption when a sender group is a single date bucket. -> layout on grouped results.
- P3 — Unknown-glyph noise/contrast: outline clip on every legacy row; 2.75:1 on focused rows (lower with 0.75 opacity); "outline=unknown" only in title/aria. Fix: measure real unknown rate; adjust shape/opacity; >=3:1 non-text on focused rows. -> clarify + check on RowGlyph three-state.

## Minor
Query duplicated while form open in search context; coverage line sits below help when form open; Esc ladder has no hint; listbox rows 28px vs palette 36px; placeholder uses fixture name "ada"; maxlength=512 chars vs 512-byte cap (caught inline, acceptable).

## Questions
1. Should search context own exactly one exit control (header X), with <- reserved for generic Back?
2. Should broad from:domain queries also group by sender (with caption-spam fix), or is flat deliberate?
3. Are session-only recents a privacy stance or a gap? If persisted per-account locally, does that collide with drafts-local-only?
