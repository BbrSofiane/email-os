---
target: inbox list
total_score: 25
p0_count: 0
p1_count: 2
timestamp: 2026-11-07T17-54-20Z
slug: src-components-inboxlist-vue
---
Method: dual-agent (A: ab33491352bdba55c · B: aee1e50f23376f1ff)

Context: after rows (2cd300e), header+typeset (a08089d), rail+contact (a86dde1) and an uncommitted polish pass.

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Bottom dock honest; g-prefix has no visible pending state; dock status always Ash |
| 2 | Match System / Real World | 2 | Engine-speak in dock/selection/reader copy ("Undo accepted for 2 of 2; 0 skipped") |
| 3 | User Control and Freedom | 3 | z / Esc / Clear all work, focus restored |
| 4 | Consistency and Standards | 2 | Archive named four ways; casing drift; Provider mail missing from navigator |
| 5 | Error Prevention | 2 | Slow "g e" falls through and archives |
| 6 | Recognition Rather Than Recall | 2 | Palette omits j/k/x/Shift+J/K; "undo" finds nothing |
| 7 | Flexibility and Efficiency | 3 | Strong accelerators; Cmd+K off in preview |
| 8 | Aesthetic and Minimalist Design | 3 | Quiet shell; dock grows to 102px at 1030px |
| 9 | Error Recovery | 3 | "Failed — restored, see Activity" styled same as success |
| 10 | Help and Documentation | 2 | Titles + partial palette shortcut column only |
| **Total** | | **25/40** | **Acceptable** |

## Anti-Patterns Verdict
LLM: mostly not slop; remaining tells are palette placeholders ("ϟ" label glyph, "↗" on every item, ActionOverlay.vue:54,59).
Detector: markup scan clean (no <style> in .vue). Supplementary style.css: 6 advisories (2px/3px radii off scale; rail tooltip shadow undocumented; drawer/popover shadows documented but not tokenized). In-page: line-length on fixture-only workspace strip (FP), reader-context-note uncapped measure (real), clipped-overflow on section.central (FP), flat-type-hierarchy (intended 11/12/16). 0px layout shift on x/e/z confirmed. 0 bordered buttons in production UI.

## Priority Issues
1. [P1] Dock status words never coloured: failure looks like Confirmed (style.css:1661, ActionNotice.vue). → /impeccable harden
2. [P1] g-chord silently falls through to destructive key after 1s (App.vue:1490,1547). → /impeccable harden
3. [P2] Dock/selection copy reads like engine output (SelectionBar.vue:48, ActionNotice.vue:99). → /impeccable clarify
4. [P2] Archive/Done vocabulary and casing drift. → /impeccable clarify
5. [P2] Command palette unstructured with placeholder glyphs; no aliases; missing bindings. → /impeccable distill, /impeccable polish

## Persona Red Flags
Alex: slow g e archives; "undo" no match; palette doesn't teach j/k/x; dock eats 66px at 1030.
Sam: g-prefix invisible; focused+selected shows only 2px Ash sliver; dual lavender signals when contact focused.
Dana (trust-critical bulk session): bulk e no preview beyond count; failed result reads as confirmed; recent mail repeats focused conversation.

## Minor Observations
Row glyphs Ash not Graphite; italic "Pending…" unique; navigator omits Provider mail; "No available commands." means no match; hidden contact-name button; leading month caption pushes first row to 183px in fixture; reader-context-note uncapped.

## Questions to Consider
- If honest statuses were coloured and copy halved, would the dock need to grow?
- Should the hamburger open a real sidebar rather than a second modal palette?
- What belongs in the rail's top circle?
