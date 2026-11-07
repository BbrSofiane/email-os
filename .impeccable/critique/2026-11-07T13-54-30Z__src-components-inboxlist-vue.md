---
target: inbox list
total_score: 24
p0_count: 0
p1_count: 3
timestamp: 2026-11-07T13-54-30Z
slug: src-components-inboxlist-vue
---
Method: dual-agent (A: aa37c4661bd634c61 · B: a4375dc98f86d56ac)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Honest in-flow notice + Undo Z; post-undo copy mixes verbs |
| 2 | Match System / Real World | 2 | Internal terms (Cached Done, Destinations); raw ISO timestamps in reader |
| 3 | User Control and Freedom | 3 | z / Esc work; focus restored on reader round trip |
| 4 | Consistency and Standards | 2 | Archive / Mark Done / Mark N Done for one action; off-palette overlay violets |
| 5 | Error Prevention | 3 | Bounded selection with explicit scope wording |
| 6 | Recognition Rather Than Recall | 2 | Shortcuts only in palette/tooltips; no ? sheet; Cmd+K inert in browser |
| 7 | Flexibility and Efficiency | 3 | Full j/k/x/e/z/Enter/Esc vocabulary |
| 8 | Aesthetic and Minimalist Design | 1 | 36 visible list controls, divider per row, 3 header strips |
| 9 | Error Recovery | 3 | Explicit errors with Retry |
| 10 | Help and Documentation | 2 | Palette is the only help surface |
| **Total** | | **24/40** | **Acceptable** |

## Anti-Patterns Verdict
LLM: not AI slop; reads as an unstyled engineering prototype. One tell: uppercase letter-spaced captions (.row-group, .contact-title).
Detector: CLI clean (exit 0) but blind here — all styling is in style.css, no <style> blocks in .vue. In-page scan: line-length on preview banner (mostly false positive), flat-type-hierarchy (6 sizes 11.5–16px, real but soft), low-contrast 3.73:1 muted on #474644 in reader (true positive). Detector missed the same 3.73:1 on the focused inbox row snippet/date.

## Priority Issues
1. [P1] Row anatomy: 16px text, per-row divider, 160px sender, always-visible checkbox + bordered Archive chip, text read-state, sender 600 regardless of unread. → /impeccable layout, then /impeccable typeset
2. [P1] Shell chrome stacks 86px header (brand, h1, chip buttons, yellow banner, status line) + full-width notice above list. → /impeccable distill, then /impeccable layout
3. [P1] Layout shift: ActionNotice (outside .app-main) and SelectionBar push the whole grid 30–39px on e/x/z. → /impeccable harden
4. [P2] Roving tabindex defeated: 37 Tab stops in list; native blue focus ring on checkbox. → /impeccable harden
5. [P2] Vocabulary + component inconsistency; global bordered chip buttons; muted-on-focus contrast 3.73:1. → /impeccable clarify, /impeccable polish

## Persona Red Flags
Alex: Cmd+K inert in preview; no ? sheet; "G then E (within 1 second)" leaks timing; per-row Archive chips invite mouse.
Sam: 37 tab stops; native checkbox ring; hover-only glyphs must stay keyboard reachable.
The Author mid-triage: unread not visible in weight; "Mark Done (Archive) … Restored" ambiguous; "Cached Done" reads as storage detail; yellow banner costs a row.

## Minor Observations
Contact copy buttons opacity:0 but keep layout space; rail 94px with wrapping "Cached Done"; at 1030px snippet starves while sender keeps 160px; long date format; undefined --text-muted; missing space "2 selectedof 18 loaded".

## Questions to Consider
- Should honest state live in the header line so the browsing plane never gains/loses a strip?
- If checkboxes hide until selection mode, what teaches x?
- Is "Cached Done" a destination or a "Done" split tab with a coverage note?
