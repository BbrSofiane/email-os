---
name: Email OS
description: A warm-dark, keyboard-first email client tuned to Superhuman-level browsing density.
colors:
  focus-accent: "#bba5ed"
  unread-marker: "#ce9ece"
  surface: "#292826"
  surface-contact: "#1f1e1c"
  surface-raised: "#33312e"
  focus-fill: "#474644"
  rail-well: "#141413"
  rail-button: "#383735"
  text-primary: "#ffffff"
  text-secondary: "#c0bcb6"
  text-tertiary: "#a09c9a"
  icon-muted: "#8e8a87"
  divider: "#474543"
  rule: "#3b3936"
  warning: "#e4c465"
  danger: "#f1a9a5"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "normal"
  title:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.35
  label:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.35
    fontFeature: "\"tnum\""
  count:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: 1
  mono:
    fontFamily: "ui-monospace, monospace"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  none: "0px"
  sm: "4px"
  md: "6px"
  lg: "10px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "12px"
  lg: "24px"
  xl: "32px"
  content-inset: "50px"
components:
  app-rail:
    backgroundColor: "{colors.surface}"
    width: "40px"
  rail-group:
    backgroundColor: "{colors.rail-well}"
    rounded: "{rounded.full}"
    width: "30px"
  rail-button:
    backgroundColor: "{colors.rail-button}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.full}"
    size: "28px"
  split-header:
    backgroundColor: "{colors.surface}"
    height: "78px"
    padding: "0 32px 0 50px"
  split-tab:
    textColor: "{colors.text-tertiary}"
    typography: "{typography.headline}"
  split-tab-active:
    textColor: "{colors.text-primary}"
    typography: "{typography.headline}"
  split-count:
    textColor: "{colors.text-secondary}"
    typography: "{typography.count}"
  list-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    height: "36px"
    padding: "0 18px 0 44px"
  list-row-focused:
    backgroundColor: "{colors.focus-fill}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.none}"
    height: "36px"
  row-sender:
    textColor: "{colors.text-primary}"
    typography: "{typography.title}"
    width: "132px"
  row-snippet:
    textColor: "{colors.text-secondary}"
    typography: "{typography.body}"
  row-date:
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
  row-action-icon:
    textColor: "{colors.icon-muted}"
    size: "32px"
  date-group:
    textColor: "{colors.text-secondary}"
    typography: "{typography.body}"
    height: "48px"
    padding: "0 0 0 50px"
  contact-pane:
    backgroundColor: "{colors.surface-contact}"
    textColor: "{colors.text-primary}"
    width: "272px"
    padding: "0 24px 24px"
  contact-name:
    textColor: "{colors.text-primary}"
    typography: "{typography.headline}"
  contact-thread:
    textColor: "{colors.text-secondary}"
    typography: "{typography.body}"
    height: "24px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
    height: "24px"
  button-utility:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "3px 8px"
    height: "24px"
  command-overlay:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    width: "576px"
  command-item-highlighted:
    backgroundColor: "{colors.focus-fill}"
    textColor: "{colors.text-primary}"
    height: "36px"
  list-dock:
    backgroundColor: "{colors.surface}"
    typography: "{typography.body}"
    height: "36px"
    padding: "0 24px 0 50px"
---

# Design System: Email OS

## 1. Overview

**Creative North Star: "The Quiet Instrument"**

A precision tool used in long, focused sessions. The surface is a single warm charcoal plane. The interface recedes until only the list, the open conversation and the next decision are on screen. Density is high but calm: 36px rows, small type, no dividers, no cards. One violet signal marks where you are. Everything else is a tonal step on the same warm gray ramp.

The system follows Superhuman's browsing look closely, and that parity is an explicit goal. It covers geometry, density, type scale, tonal layering and the focused-row treatment. Features and workflows stay our own. The one place we deliberately go our own way is state: pending, failed, partial and outcome-unknown states are always visible in their own form (*"Honest state over smooth feel"*, PRODUCT.md). A quiet surface must never hide what happened.

The system rejects Gmail-web clutter, "AI magic" sparkle chrome, generic SaaS dashboards (card grids, gradient heroes, oversized rounded panels), and optimistic UI that says "Done" before the provider confirms.

**Key Characteristics:**
- Three fixed panes: a 40px icon rail, a fluid list or reader, and a 272px darker contact pane. Each is separated by a single 1px divider.
- One content inset (50px from the list pane's left edge). It aligns split tabs, sender names, date-group captions, notices, banners and the bottom dock.
- 36px rows on 12px type. Hierarchy comes from weight and tone, not size.
- Pane-edge alignment: the contact name sits on the split-tab line, and the contact email sits on the first-row line.
- Flat tonal layering. No shadows in the browsing shell.
- The violet accent appears once per screen: on the focused row or the active message.

**Layout geometry (approximate calibration targets).** These values come from the 2026-11-07 Superhuman reference capture (1603×2000 image px). The capture was scaled by about 1.56 image px per CSS px, calibrated from the macOS traffic-light pitch of 20pt and cross-checked against the 36px rhythm and the 40px and 270px pane widths in `superhuman-email-browsing-ux-spec.md`. Verify them on real displays.
- **Rail:** 40px wide. The top action button (28px circle) is centered on the split-tab line (42px down). The navigation icons sit in a dark pill about 30px wide that starts near the header's bottom edge, with its first glyph centered on the first list line (96px down) and a 28px pitch. The active glyph sits on a 24px Rail Pebble disc inside the pill.
- **Split header:** 78px from the content top to the first row. Tabs are vertically centered about 42px down. The hamburger is centered 23px into the pane. Tabs start at the 50px content inset with an 18px gap; the count sits 4px after its label. Compose and search icons are right-aligned on the 32px action pitch.
- **Rows:** 36px. The highlight is inset 6px from both pane edges. There is a 44px left gutter, with the 5px unread dot centered about 34px into the row. The sender column is 132px, and subject→snippet→meta gaps are 12px. The trailing date sits about 25px from the pane edge. On focus, three 16px action glyphs replace the date at a 32px pitch.
- **Date groups:** a 48px block, with the caption vertically centered on the content inset.
- **Contact pane:** 272px with a 24px inner inset. The name is centered on the tab line (42px), the email on the first list line (96px), the "Mail" label about 36px lower (~131px) and the first thread at ~156px, then a 24px pitch. Superhuman's footer toolbar sits 24px from the bottom: a ghost label plus 16px glyphs at a 28px pitch.

### Parity Gaps (current code → target)

This is the backlog for layout, typeset and polish passes. Each gap names what ships today and what this spec requires.

1. **Split header.** Done (2026-11-07 header pass). The header is one borderless 78px strip inside the list column (the rail and contact pane span its height). It has a Graphite hamburger (Destinations navigator) centered 23px in, split tabs on the 50px inset (16px, active Paper White, inactive Smoke, 11px Ash count 4px after the label, 18px apart), and right-hand glyphs on the 32px pitch: Back (when there is history), Reminders (fixture only), the Starred-only toggle, Commands and Search. There is no brand text, no visible h1 while a tab is active, and no bordered chips. Glyphs are local inline SVG (`HeaderGlyph.vue`).
   - The context h1 stays in the accessibility tree. It is shown on screen, styled like an active tab, only when no rendered tab is active (Cached Done, Starred, Search, the reader, an open drawer).
   - The status line is removed. The inbox count is on the active tab; loaded counts were dropped as duplicates of the list. Selection count stays in SelectionBar, plus a visually hidden polite announcement. The pending count is covered by row "Pending…", the action notice and Activity. The Shift+U hint is in the Commands palette. The command error is its own alert line beside the action notice in the list column's bottom dock (gap 13). The read-only hint and the Unread-only/Starred-only filter states stay visible in words in the header (the read-only hint steps aside while an account connection note is showing; gap 18).
   - The Inbox coverage sentence is the tabs' accessible description and the tab strip's hover title. The browser-preview banner is a one-line amber "Preview · in-memory" note on the right; the full disclosure is its title and accessible text. The same note slot carries the account status note (gap 18).
   - Utility drawers now start below the header, so they never cover its glyphs.
   Update: the compose glyph now ships. It sits on the right of the header, left of Search, as a Graphite glyph on the 32px pitch, and opens the local-draft compose card INLINE in the central pane ("New Message", C key / palette action "Compose new local draft") — an in-flow card that replaces the list while composing, not a modal overlay: no backdrop and no dimming, so the rail, header and contact pane stay visible. (While a reader is open, the card docks at the bottom of the reader pane, like the reply composer.) There is still no compose capability beyond local drafts, so the glyph opens the local-only inline card, never a sender. (The aggregate pending count now lives on the Activity rail badge, and the tab line is calibrated against the rail's home circle: both are centered 42px down; see gap 2.)
2. **Rail.** Done (2026-11-07 rail/contact layout pass). The rail is a fixed 40px column (px, so larger root fonts widen the list, never the rail) with a 1px Seam on its right.
   - **Home circle:** Inbox is the 28px Rail Pebble circle, centered on the split-tab line. We have no AI or compose action to put there, so the primary destination takes the slot instead of an empty or dead control.
   - **Inkwell pill:** a 30px pill (the capture measures ~30px, not 28px) holds Starred (Gmail), Cached Done, Provider mail and Cached Trash (Gmail) as 16px glyphs on 28px hit targets at a 28px pitch. Its first glyph is centered on the first list line.
   - **Utilities:** Account (Gmail), Activity, Drafts and the narrow-viewport Contact disclosure are ghost glyphs at the bottom, 16px from the edge.
   - **States:** the current destination (`aria-current`) or open drawer (`aria-expanded`) shows a Paper White glyph on a 24px Rail Pebble disc; the rest are Graphite and rise to Paper White on hover and focus.
   - **Labels:** every button keeps its text label as its accessible name (a visually hidden span, so `textContent` is unchanged), its hover `title` (the action label with its shortcut, as on the header glyphs), and a keyboard tooltip: the same label shown beside the rail on `:focus-visible`, with Popover lift.
   - **Activity badge:** a small Amber Notice count on the Activity glyph shows unresolved operations, i.e. `queued`/`applying` plus `outcome_unknown`. It is derived from the activity rows the drawer already lists, with no new read. The digit is `aria-hidden`; the words ("2 operations pending", "1 operation with outcome unknown", or "3 operations unresolved: 2 pending, 1 outcome unknown") are the button's `aria-describedby` and are appended to its title. The badge disappears at zero.
   - **Glyphs:** local inline SVG in `PaneGlyph.vue` (Starred reuses HeaderGlyph's star). The rail sits at z-index 20 (above the row popover at 6, below drawers at 30).
   Remaining: the badge counts only what the activity snapshot carries (the same rows Activity shows), not a separate mailbox-wide total. The Contact disclosure stays in the rail below 1000px; it has no Superhuman analogue.
3. **Row metrics.** Done (2026-11-07 rows pass): 12px type in two weights, a fixed 36px height, no per-row dividers, the 6px pane inset, the 44px left gutter and the 132px sender column. Leading caption: done (polish pass). When the list opens with Today, that caption is visually hidden (it stays in the accessibility tree), so the first row is centered on the 96px first-list line with the rail's first glyph and the contact email, as in the reference. Today's rows already show a time, so nothing is lost on screen. Any other leading bucket (Yesterday, Earlier this month, a month, Unknown date) stays visible, because a list that starts in the past must say where it starts; in that case the first row is still centered 144px down.
4. **Focused row.** Done (rows pass): the fill is inset 6px from both pane edges, with a 4px Dusk Lavender bar on its own left edge.
5. **Read state.** Done (rows pass): a 5px `unread-marker` dot in the gutter, a distinct hollow ring when read state is unknown, and read senders drop to weight 400.
6. **Selection checkbox.** Done (rows pass): hidden until selection mode, hover or focus, and placed in the 44px gutter.
7. **Row actions.** Done (rows pass): `icon-muted` inline SVG glyphs (`RowGlyph.vue`) replace the date on the focused or hovered row only. Accessible names, roving tab stops and the `meta-compact` disclosure stay. The disclosure now also re-measures on text-size changes inside an unchanged row box (rail/contact pass: the sender label is observed too). Remaining: Superhuman shows done/snooze/more; we show only our real actions (read/unread, done).
8. **Date-group caption.** Done (rows pass): title case, 12px `text-secondary`, a 48px block, no rule, on the content inset. A leading Today caption is visually hidden (gap 3).
9. **Contact pane.** Done (2026-11-07 rail/contact layout pass; type from the typeset pass). A fixed 272px column on Deep Umber with a `0 24px 24px` inset.
   - **No visible caption:** the "Focused conversation" / "Open conversation" h2 stays in the accessibility tree (visually hidden).
   - **Pinned lines:** the name (16px regular Headline) is centered on the tab line at 42px and wraps around that center before it moves anything. The email (12px semibold Title) is centered on the first list line at 96px.
   - **Copy controls:** each copy control is a 16px Graphite glyph in the trailing slot of its own line, revealed by opacity on line hover or focus. It stays focusable, and it no longer leaves an empty line when hidden. Without a display name, Copy email moves to the name line.
   - **Recent cached mail:** a Title label with a 16px envelope glyph (~129px), then plain Ash text rows at a 24px pitch (first at 156px). Each row has an ellipsis and the full subject as its title, rises to Paper White on hover or focus, and is still a button.
   - **Narrow disclosure:** inside the Contact disclosure below 1000px, the same content stacks compactly under the drawer header.
   - **No footer toolbar:** Account, Activity and Drafts stay in the rail, their one home. The contact column does not exist below 1000px and is `inert` while a drawer is open, so footer toggles would vanish on narrow viewports and could not close their own drawer or receive focus back.
   Remaining: the label keeps our honest copy "Recent cached mail" rather than "Mail" (vocabulary pass). The list is still the 4 most recent cached results from the sender search, not a provider-complete thread list.
10. **Palette deltas.** Done: `text-primary` #ece9e2 → #ffffff (typeset pass), `text-secondary` #a8a29a → #c0bcb6 (rows pass), `text-tertiary`, `icon-muted` and `unread-marker` added (header and rows passes), the undefined `--text-muted` on coverage notes now maps to `text-secondary`, and `rail-well` / `rail-button` are CSS tokens (rail pass). `divider` is now #474543 (polish pass): the rail and contact-pane seams, the drawer's leading edge, utility-chip and input borders, the compact row-actions popover and the command-overlay hint rule. It never separates rows (the list has no row borders). The old #3b3936 survives as the quieter `rule` token for structure inside a pane, only in the reader (toolbar and message rules) and inside drawers (Activity and draft rows, group detail, Reminders fieldset), so those surfaces keep their tone until a reader reference is captured. `focus-accent` stays at the committed #bba5ed; the capture reads about #bfa1f6, which is within capture and color-profile noise.
11. **Global button style.** Done (polish pass). The `button` defaults are zero-specificity (`:where()`), so every component class keeps its own look. The default is a ghost: transparent, Paper White, 4px radius, `4px 8px` (24px tall at 12px, the old chip's hit target), Lifted Charcoal on hover, Focus Stone on press, 0.45 opacity when disabled, and the 2px Dusk Lavender focus ring at a 1px offset. The selection bar, the action notice's Undo, Load more, the search form and the reader toolbar are ghost text buttons. Bordered `button-utility` chips (Lifted Charcoal, 1px Seam, `3px 8px`) appear only inside utility drawers, the modal attachment chooser, recovery banners (`.recovery-banner`: draft-close recovery, inbox/account load errors, the reader's navigation error, the header's saved-split error) and the synthetic workspace strip. Fields follow "Inputs / Fields": a Seam border that shifts to Dusk Lavender (plus a 1px inner outline) on keyboard focus, Smoke placeholders (4.76:1 on Lifted Charcoal) and a lavender ring on native checkboxes.
12. **Command overlay.** Done (polish pass; structure pass: groups, per-command glyphs, aliases, Keys list, "no match" copy, caption removed). The off-palette values the overlay still carried (#56534e border and rules, #c9c4bc caption, icon and hint text, #d4cfc7 disabled reasons, #66615b `kbd` fill, `.85rem` radius, the 46rem width, 24px query and 1.5rem glyph) are now tokens: a 576px Lifted Charcoal panel with a 10px radius, no border, Overlay lift over a `rgba(0,0,0,0.53)` backdrop at 15vh. The query is 16px on Deep Umber with a 1px Dusk Lavender border, items are 36px rows of 12px Body with 16px Graphite glyphs, the highlighted item is Focus Stone plus a 3px Dusk Lavender bar, disabled items are Smoke with Ash reasons, and `kbd` is Ash on Deep Umber. Geometry is whole-pixel so a highlighted item scrolled into view is never clipped. The modal attachment chooser shares the panel (46rem wide, 12px body), which closes the "chooser body inherits 16px" remainder of gap 14. (The violets this gap once listed were already gone before this pass.)
13. **In-flow bars.** Done (polish pass). Every bar is borderless Body type with its text on the 50px content inset and 6px block padding. The lines that come and go with triage keys (the Selection bar, the single-slot Action notice and the command-error alert) now live in a bottom dock of the list column (`.list-dock`) instead of above the list, so x, e and z never move a row. Measured at 1280×800 (Gmail preview): the first row stays at y=126 (real clock) or y=78 (Today clock) through x, x, Clear, e and z; before, it moved 126 → 186.9 → 162.8 → 156. The dock keeps one 36px line reserved and grows upward into the list viewport (selection: 56px). If that shrink would clip the focused row, the list scrolls just enough to keep it whole. The static context lines (Starred/Done coverage, draft-close recovery) stay above the list, because they belong to the destination rather than to an action. The reader's selection-scope note is a borderless line in the reader.
14. **Type scale and dates.** Done (2026-11-07 typeset pass). The shell type is semantic tokens on `:root`: `--type-headline` 1rem, `--type-body` 0.75rem, `--type-count` 0.6875rem, `--type-mono` 0.85rem, weights 400/600 only (`--weight-regular`, `--weight-strong`). `.app-main` sets Body as the shell default, so the rail, contact pane, notices, drawers, the reader chrome and form controls are 12px instead of an inherited 16px or ad hoc 0.8/0.85/0.9/0.95/1.1rem. Shell h2 is Headline; h3/h4 and in-panel drawer headings are Title; the reader subject is Headline at 600. Row dates follow the Label rules below and are deterministic (no default-locale dependence: the old `30 Sept 2001` vs `Sep 30, 2001` rendered-layout gate now passes under any `LANG`). Rows carry `<time datetime>` plus the full date as the title; reader message times are full dates with `datetime`. The rendered larger-text gate expected the compact action disclosure at a 25px root font (was 23px) after this pass, and at 34.5px (expanded at 30px) after the rail/contact pass, since the fixed-px rail and contact pane leave the list wider at every text size.
   Polish pass: the remaining raw timestamps (Account "Last synced", Cached Done coverage "Last synced", Activity group times, Provider mail catalog, page, recovery-snapshot and message times, Reminders due times, the reader's recovery snapshot) now go through `FullDate.vue`, which renders `fullDateLabel` in a `<time datetime>`. The command overlay and the attachment chooser are on the scale (gaps 12 and 14). Remaining: the Reminders time input still takes a typed ISO value; it is an input, not a display.
15. **Typeface.** Superhuman ships a proprietary face. We stay on local `system-ui` (no remote fonts), so glyph widths will differ slightly. Calibrate sizes by eye on device, not by matching the font.
16. **Out of scope for this capture.** The native title strip (Tauri window chrome) and the reader view are not shown. The reader's type is on the shell scale (typeset pass: Headline subject at 600, 12px message chrome, full dates, Mono body), but its layout and colours keep their current tokens until a reader reference is captured. The reader and composer pass below (gap 17) works from the code and the critique, not from a capture.
17. **Reader and composer pass.** Done (2026-11-08, code-verified; nothing was rendered, so geometry and contrast ratios are computed from the tokens, not sampled). Brand rule: the surfaces say each fact once, and only exceptions interrupt.
   - **Compact docked reply composer.** A one-line recipient row (`To  Ada Fixture`) replaces the always-open To, Cc and Subject boxes. The row is a real button; while To still equals the default sender mailbox it shows the display name and the real address beside it (`Ada Fixture <ada@example.test>`, the address in Ash, never hover-only, so a sender named "Bank Support" cannot hide `x@evil.test`; a name equal to the address is not repeated), and the raw To text in an input as soon as it differs, so the field is never misrepresented. A quiet Ash `Cc / Subject` toggle (`aria-expanded`) opens those rows on demand; they open by themselves when Cc has text, To was edited or the subject is not the default `Re:` line, so saved data is never hidden. The body is the dominant field and takes focus once the draft exists: at least six lines (7.5rem at the 12px body size), growing with its text up to half the viewport. The docked shell (`.reply-composer`, `.reader-pane > .compose-card`) is capped at 60% of the reader pane, so the thread stays above it. The read-only quoted block is Body type in the UI face, Ash, with the 2px Rule on its left edge, `pre-wrap`, clamped to three lines (the full snippet stays in the DOM); it is never part of the draft body. The new-message card keeps To and Subject as one-line label-plus-input rows with Cc on demand. The inputs are borderless-looking (a transparent 1px border that shows Rule on hover and Dusk Lavender with the inner ring on keyboard focus). The drafts drawer editor shares the same core.
   - **Status line and caveats (follow-up).** The status line stays terse (`Saved locally · not sent`). The caveats (recipients stored as typed and not validated; no Bcc, reply-all or rich text) are one extra Ash line behind a small info button next to it (`aria-expanded`, 14px Ash glyph, `About local drafts`), so keyboard users reach them; the `title` is a bonus, not the only route. The status line is no longer a live region: a separate visually hidden `role="status"` region announces only the first settled state, a problem (`Save not confirmed`, `Conflict — edits preserved`) and the recovery after one, never the `Saving…`/`Saved` autosave cycle. Error lines keep `role="alert"`. A successful discard closes the editor and says nothing of its own (the confirm dialog is the announcement).
   - **One status line, no raw IDs.** The three-line local-only disclaimer and the `Reply source is fixed: <conversationId> · <messageId>` line are gone. One Body line on the heading row carries the guarantee: `Saved locally · not sent` (Ash) once settled, `Local draft · not sent` (Ash) before the first save, and the existing words in Amber Notice while the state is not settled: `Saving locally…`, `Creating local draft…`, `Save not confirmed`, `Conflict — edits preserved`, and the two preview `(non-durable)` states with `· not sent` appended. The plain-language detail (nothing is sent, recipients are stored as typed and not validated, no Bcc, reply-all or rich text) is that line's `title` and the body's visually hidden `aria-describedby` text. Opaque provider IDs never appear in text, titles or labels; the fixed reply source survives only as `data-source-*` attributes.
   - **Footer.** One primary action, `Save and close`: Focus Stone fill, Title weight, 4px radius, 24px tall, with an Ash `Esc` `kbd` beside it. Hover adds an inset Ash ring (the fill alone disappears against Lifted Charcoal) and press steps to Rail Pebble. `Discard…` and `Cancel reply preparation` are quiet Ash ghosts. It still waits for the protected flush and stays open with the error if the flush fails. There is no Send button, shortcut or Cmd+Enter.
   - **Reader header.** The standing sentences ("Opening this conversation does not change read state…", "Read-only Gmail view…") are no longer paragraphs. One muted Ash status line in the meta row carries the read-state word (`Unread`, `Read`, `Read state unknown`) and, in a read-only view, `Read-only ·` before it; the guarantee sentence is that line's `title` and its visually hidden text, read once by assistive technology. Cached Trash keeps one Ash line (`Cached Trash — read only. Recovery is not available here; use your provider client.`) and the status span still says `Read-only` before the read state, with no standing sentence. While a conversation loads with no known row identity the bare `Loading conversation…` status is followed by a static placeholder (a subject bar and three Rule-colour rows at the collapsed message height, no shimmer, `aria-hidden`), so the pane does not jump; with a known identity the subject and sender show and only the rows follow. Only exceptions stay inline in Amber Notice, each once and in their old wording: star attention, reply blocked, retained snapshot, unsupported or incomplete, and pending (no longer italic). A normal conversation shows the subject, one meta line and the messages.
   - **Trailing quote and signature.** A body is split deterministically and losslessly (`splitMessageBody`) into prose, an optional signature and an optional trailing quote. The signature starts at an RFC 3676 `-- ` line (dash, dash, space) with at most 12 lines after it; a bare `--` is ordinary prose and dims nothing. The trailing quote is an `On … wrote:` or `-----Original Message-----` line plus a `>` run that reaches the end, or a bare run of two or more `>` lines. Interleaved quotes stay in the prose; a body that is all quote is never split. Known limitation: because interleaved `>` lines stay in the prose, a single one still gives the whole body the monospace face (`bodyNeedsMonospace`); changing that needs a rendered pass on real inline-reply threads. The prose decides monospace, so a short reply above a quote reads in the proportional face. Signature and quote use the reading face and size in Ash with `>` kept. The signature is always visible with its message. The quote sits behind a ghost `Show quoted text` / `Hide quoted text` button (`aria-expanded`, 24px, Ash) kept per message in the reader's visit state, so it survives J/K round trips. A collapsed row previews the prose, never the quote.
   - **Inline attachments and human sizes.** An expanded message with `hasAttachment === true` lists its files under the body: a plain list, no cards, one 24px line per file (16px Ash paperclip, filename in Paper White with an ellipsis and the full name as its title, then `27 B · text/plain` in Ash, then a ghost `Save`). While a file transfers the line reads `Saving…` with `Cancel`; success is an Ash `role="status"` line (`Saved to Downloads as <name>. No file was opened.`, or the modelled preview wording), failure is a Coral Fault `role="alert"` line with the chooser's wording. Files over 5 MB show `Over the 5 MB limit; cannot download.` and no button. A retained snapshot disables Save with a title. A message that claims files with no cached descriptor says `Attachment details are not cached. Sync to fetch.`; `false` or unknown claims show nothing. Descriptors load once per conversation after the snapshot renders and are kept for the reader session. Sizes are binary steps with mail-client names (`27 B`, `1.0 KB`, `4.6 MB`; `unknown size` for a non-number). Names are printed with bidirectional control characters (U+202A–202E, U+2066–2069, U+200E/F, U+061C) removed, so `invoice\u202Efdp.exe` reads in its real order; the same applies to the chooser and the saved-as line. A size that one decimal would round across the limit prints exact bytes (`5,242,881 B` next to `Over the 5 MB limit`, never `5.0 MB`). The Cmd+O chooser keeps links and the full list and uses the same transfer logic (`useAttachmentTransfer`) but its own instance: a transfer started inline is not shown in the chooser, and closing the chooser cancels only its own transfer. Its intro shrinks to `Download only. Files save inert with a .download suffix; nothing is opened.`
   - **R and contrast.** `R` prepares a reply from the open reader, from the same rule as the buttons (ready, not Cached Trash, not blocked by an incomplete conversation, a retained snapshot or mismatched headers, no drawer or composer open). The source is always the displayed latest message, never the focused one. The reply body takes focus from anything that is not a text field (`<body>`, the reply button, the reader article after a click on message text, a `Details` summary, a participant), never from a text field the user moved to. After Discard focus returns to the reader's active message. It is inert in text fields, during IME composition, with modifiers, on key repeat and from other buttons. "Prepare reply" appears in the palette with `R` only while it can run, and the reply controls' titles read `Prepare reply — R`. Closing the composer returns focus to the reader's active message. Graphite is 2.75:1 on Focus Stone and 3.79:1 on Lifted Charcoal, so it is never used for meaningful glyphs or text on a focus fill or on the composer fill; new hints and glyphs use Ash (4.99:1 and 6.86:1). The reader's `Details` summary moved from Graphite to Ash for that reason; the reply glyph on the active message stays Graphite at rest (3.79:1 clears the 3:1 glyph floor) and rises to Paper White on hover and focus.

18. **Account, connection and first-run pass.** Done (2026-11-08, code-verified against the synthetic in-memory fake; nothing was rendered, so widths, heights and contrast are computed from the tokens, not sampled). Brand rule: pending, failed and unknown stay distinct, and a surface never says something is empty or connected when it is not.
   - **The empty Inbox tells the truth (Gmail mode, plain Inbox only).** `src/lib/account-status.ts` derives one line from `AccountStatus` (connection, sync state and error, initial sync, cached count): `Not connected.` with an inline `Connect Gmail`; `Sign-in expired.` with `Sign in again`; `Finish sign-in in your browser.` with `Cancel`; `Syncing first mail… N cached.`; `Sync failed: <plain cause>` with `Retry`; `Initial sync has not finished.` with `Sync now`; and, when not configured, `Gmail is not configured on this device.` with a link-style `Account` (no Connect: there is nothing to connect with). Only a connected, fully synced, zero-row account shows the real empty text. Where mailbox actions are on (and in fixture mode) it keeps the Activity sentence; Gmail without mailbox actions says `No conversations in the cached inbox.`, because Activity offers no Mark not done there. The action is a link-style button in the line (`.inline-action`, Title weight, underlined); the line keeps `tabindex="-1"` and focus, so the state change never strands focus on a removed button. Search, filters, saved splits, Starred and Done keep their own wording.
   - **One account status note in the header.** In the same slot and pattern as the preview tag and the read-only hint (`.header-note`, one line, ellipsis, gives up width before the glyphs, optional `.header-link`): `Not connected · Connect`, `Sign-in expired · Sign in`, `Finish sign-in in your browser · Cancel`, `Gmail not configured · Account`, `Syncing…` (`Syncing first mail · N cached` during the first sync), `Sync failed · Retry`, and `Offline · Retry` only for a `network_unavailable` sync error (other causes say `Sync failed`, so unknown causes are never relabelled). The detail is the note's `title` and visually hidden text and never contains the ticking cached count, so it is announced once. Nothing shows while connected and idle or in fixture mode. Connection notes replace the read-only hint (the Account drawer covers it); sync notes keep it. The note never says actions are off: actions depend on `mutationAccess`, not on the connection, so the only standing fact it states is that cached mail stays readable.
   - **Account drawer, no card.** The bordered 6px box is gone. Four sections (Connection, Sync, Permissions, Session) with Title labels are separated by 24px, with 6px inside; no italic, no second heading (the drawer's h2 is the heading). Connection reads `operator@example.test · Connected` then `Gmail · read-only` / `Gmail · mailbox actions enabled` / `Gmail · permission request pending` (the cached-reading sentence is the mode line's title; the permanent "Disposable test account" paragraph is gone). Sync is one wrapping line (`Idle`, `Last synced <date>`, `18 conversations cached`, correct singular) with the bounded-coverage fact as one short Ash line (`Up to 100 conversations are cached; older mail may be missing.`); the error is a Coral alert with an inline `Retry` beside the sentence. Disconnect is a quiet ghost `Disconnect…` that reveals, in place, the shortened warning with `Disconnect` and `Keep account`; the warning is not in the DOM until asked, focus moves to `Keep account`, Esc (consumed, so the drawer stays) or `Keep account` returns it. Cancelling a sign-in stays one click. While a permission request is pending the section says `Finish sign-in in your browser. Cached mail stays readable.` with `Cancel permission request` as the Title-weight button. The scope disclosure stays visible next to `Enable mailbox actions`, shorter.
   - **Provider mail drawer.** Classes in the shared stylesheet instead of scoped bare element rules: one Ash intro line (`Read-only provider snapshots.`, the detail as title and hidden text), a Seam-underline search, ghost buttons (`.drawer-ghost`), compact ~28px ghost rows with no card or border, plain errors through the shared sentences (`Could not load destinations. The network is unavailable. Showing the previous snapshot.`), a static loading line where the list will appear, and an empty-state line. Rows are real buttons with a roving tab stop: ArrowDown/ArrowUp and J/K move between rows (the search field only takes ArrowDown, so typing is untouched), Enter opens, and Escape steps back reader, page list, catalog, then closes the drawer. Modifier and IME guards, the Cmd+K passthrough and the stale-response guards are unchanged.
   - **Copy and boundary.** `Determining account mode…` is `Loading account…`. The synthetic-workspace banner reads `Synthetic workspaces · memory only` and `Search stays in the active account.`, with the full sentence kept as the nav's accessible description; the inactive account's button has the title `Switch account — also in Commands` (there is no shortcut, so none is shown). The strip's spacing is on the 6/12 scale.
   - **Keys.** `Connect Gmail` (`Sign in again` after expiry) and `Sync now` are palette commands in a quiet `Account` group, present only while they can run (the same rules as the Account buttons; never in the navigator). `G` then `A` (within 1 second, Gmail mode only) goes to Account, inside the existing chord window and grace window; `G` then `E` and `G` then `H` are unchanged.
   Code-verified only: every state above is exercised through the in-memory fake in jsdom tests. Not run: real Google OAuth, real sync, offline behavior of the native shell, the macOS Keychain, rendered spacing and truncation of the header note at narrow widths (it relies on the existing `.header-note` flex rules), and screen-reader announcements. Remaining: a disabled-looking Cancel is hidden, not shown, while a connect call is still in flight (the account drawer's Cancel sign-in has the same rule), so a sign-in the browser never completes can only be cancelled after the call settles.

## 2. Colors

One warm charcoal ramp, one violet signal, and two status hues reserved for truth-telling.

### Primary
- **Dusk Lavender** (`focus-accent`): the single "you are here" signal. Used for the 4px bar on the focused row, the active message bar in the reader, focus outlines, and the highlighted command. It never fills an area and never decorates.

### Secondary
- **Orchid Dot** (`unread-marker`): only for the 5px unread dot in the row gutter. It is pinker than Dusk Lavender so that unread and focus never read as the same signal.

### Neutral
- **Warm Charcoal** (`surface`): the list, rail and header plane. Everything sits on it.
- **Deep Umber** (`surface-contact`): the contact pane and utility drawers. It is one step darker, so context reads as secondary to the list.
- **Lifted Charcoal** (`surface-raised`): utility chips, overlays and inputs.
- **Focus Stone** (`focus-fill`): the focused-row and active-message fill, and the highlighted command item.
- **Inkwell** (`rail-well`): the pill behind the rail's navigation glyphs.
- **Rail Pebble** (`rail-button`): the circular rail action button.
- **Paper White** (`text-primary`): sender, subject, active tab, contact name and email, labels.
- **Ash** (`text-secondary`): snippet, date, group caption, contact threads, counts.
- **Smoke** (`text-tertiary`): inactive split tabs.
- **Graphite** (`icon-muted`): every resting glyph (row actions, compose, search, hamburger, footer icons, attachment). Hover and focus raise glyphs to Paper White. Graphite is 2.75:1 on Focus Stone and 3.79:1 on Lifted Charcoal, so it never carries meaningful text, or a glyph that must be read, on a focus fill or the composer fill; Ash does that job there.
- **Seam** (`divider`): the 1px vertical separators between rail, list and contact pane, and the drawer's leading edge; also the 1px border of utility chips, fields and floating panels. Never between rows.
- **Rule** (`rule`): a quieter 1px structure line inside a pane, used only in the reader and inside drawers. Never in the list.

### Status
- **Amber Notice** (`warning`): pending, outcome unknown, local-only, expired-undo and partial states.
- **Coral Fault** (`danger`): confirmed failures and command errors.

### Named Rules
**The One Signal Rule.** Dusk Lavender appears at most once per screen, on the current row or message. If two violet things are visible, one of them is wrong.

**The Seams-Only Rule.** Dividers separate panes, never rows. Rows are separated by rhythm alone.

**The Status-Is-Sacred Rule.** Amber and coral are never used decoratively, and a status is never shown only as a tint: every status carries words.

## 3. Typography

**Body Font:** system-ui (with -apple-system, sans-serif)
**Label/Mono Font:** ui-monospace, for plain-text message bodies only

**Character:** One local system sans in two weights carries the whole UI. Hierarchy comes from weight (600 vs 400) and tone (Paper White vs Ash), not size. The browsing shell uses just two sizes.

### Hierarchy
- **Headline** (400, 1rem / 16px, 1.25): split tabs and the contact name. This is the only large text in the shell.
- **Title** (600, 0.75rem / 12px, 1.35): sender names, contact email, section labels ("Mail"), footer labels, notice labels.
- **Body** (400, 0.75rem / 12px, 1.35): subject (Paper White), snippet and threads (Ash), date-group captions (Ash).
- **Label** (400, 0.75rem / 12px, tabular numerals): dates ("8:00 AM", "6 NOV" with an uppercase month) and counts in status text.
- **Mono** and the other steps are CSS tokens: `--type-headline`, `--type-body`, `--type-count`, `--type-mono`, `--weight-regular`, `--weight-strong` (`src/assets/style.css`). Use the tokens, never a literal size.

### Dates
Row and reader dates are one fixed product format, not a locale format. They depend only on the instant, the current time and the viewer's time zone (`src/lib/browsing-dates.ts`). Month group captions ("October 2026") still follow the locale.
- **Row, today:** the time, 12-hour, no leading zero: "8:00 AM", "12:05 PM".
- **Row, earlier this calendar year:** day and month: "6 NOV". The DOM text is "6 Nov"; CSS uppercases it, so screen readers hear a word, not letters.
- **Row, any other year (past or future):** day, month and four-digit year: "9 JAN 2025". The day is kept for precision, and a two-digit year would read as another day.
- **Unknown or unparsable:** "Unknown" in the row, "Unknown date" in full form. Never blank.
- **Full form** (reader message times, the row date's hover title): "Thu 9 Jan 2025, 6:29 PM". The same 12-hour clock as the row.
- Every rendered date is a `<time>` with a normalized ISO `datetime` when the timestamp parses.
- **Count** (400, 0.6875rem / 11px): split-tab counts, set 4px after the tab label.
- **Mono** (400, 0.85rem, 1.45): the current plain-text message body in the reader.

Sizes are rem so the 16px and 20px root-font layouts in `tests/inbox-list.rendered-layout.test.ts` still scale. Row and header heights are min-heights in px. The 12px row size is measured from the capture: system-ui glyph metrics point to 11.5–12px.

### Named Rules
**The Two-Size Rule.** The browsing shell uses 16px and 12px only (11px for counts). A third size in the list needs a written reason.

**The No-Caps-Caption Rule.** No uppercase letter-spaced captions in the browsing shell. Date groups and pane headings are title case. Uppercase is allowed only for the month in compact dates.

## 4. Elevation

The browsing shell is flat. Depth comes from tonal layering: Warm Charcoal for the plane, Deep Umber for context, Focus Stone for the current row, Inkwell for the rail well. No shadows sit on rows, panes, the header or the rail. Shadows appear only on surfaces that truly float above the shell and cover it.

### Shadow Vocabulary
- **Drawer cast** (`box-shadow: -8px 0 24px rgba(0, 0, 0, 0.35)`): the right-edge utility drawer (Activity, Account, Drafts).
- **Popover lift** (`box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35)`): the compact row-actions disclosure panel.
- **Overlay lift** (`box-shadow: 0 16px 64px rgba(0, 0, 0, 0.53)`): the command palette and navigator, over a `rgba(0, 0, 0, 0.53)` backdrop (`--overlay-lift`, `--overlay-backdrop`).

### Named Rules
**The Flat-Shell Rule.** If something in the rail, header, list or contact pane casts a shadow, remove it. Shadows mean "this covers the shell", nothing else.

## 5. Components

### Conversation Row (signature)
The core of the product: dense, quiet and exact.
- **Shape:** square corners (0), a fixed 36px height, inset 6px from both pane edges.
- **Layout:** a 44px gutter (unread dot, or the checkbox in selection mode), then a 132px sender (Title, Paper White, ellipsis), then the subject (Body, Paper White) and snippet (Body, Ash) on one line with 12px gaps, then the trailing date (Label, Ash) about 25px from the pane edge. An attachment glyph (Graphite, 16px) sits before the date, three-state like the read marker: a solid paperclip when attachments are known present, a quieter outline paperclip when the attachment state is unknown, and nothing when known absent. Done (2026-11-07 P3 three-state glyph; the unknown state is named "Attachment state unknown" in the accessible name and title, never rendered as silence).
- **Focused:** Focus Stone fill plus a 4px Dusk Lavender bar on the fill's own left edge. The date gives way to three action glyphs (done, snooze, more) at a 32px pitch.
- **Hover:** a barely-there lift (`rgba(255,255,255,0.03)`). Action glyphs appear; focus and read state never change.
- **Pending / unknown:** an Amber Notice word ("Pending…") in the meta region, never just a tint.
- **Selected:** the visible checkbox plus a secondary inset bar, so selection never relies on color alone and never replaces the focus bar.

### Date Group Caption
- **Style:** Body, Ash, title case ("Yesterday"), on the 50px content inset, in a 48px block. No rule and no background band. Not focusable.
- **Leading Today:** visually hidden (kept for assistive technology), so a list that opens with today's mail starts on the first list line. Every other leading caption stays visible.

### Split Tabs (Navigation)
- **Style:** Headline type. The active tab is Paper White; inactive tabs are Smoke. The count (11px, Ash) follows 4px after the label and disappears at zero. Tabs are spaced 18px apart.
- **Header:** 78px tall, no bottom border. The hamburger is a Graphite glyph to the left of the inset; compose and search are Graphite glyphs on the right, at the row-action pitch.

### Rail
- **Style:** 40px wide on Warm Charcoal, with a 1px Seam on its right. The top action, Inbox, is a 28px Rail Pebble circle centered on the tab line. The other destination glyphs sit in a 30px Inkwell pill at a 28px pitch, with the first glyph on the first list line. Utilities (Account, Activity, Drafts, and Contact below 1000px) are ghost glyphs at the bottom. The active destination glyph is Paper White on a 24px Rail Pebble disc; the rest are Graphite.
- **Labels:** icon-only on screen. Every button keeps its text label as its accessible name, a `title`, and a keyboard tooltip on `:focus-visible`.
- **Activity badge:** an Amber Notice count of unresolved operations (pending plus outcome unknown), named in words by the button's description and title.

### Contact Pane
- **Style:** 272px on Deep Umber, with a 1px Seam on its left and a 24px inset. No visible caption heading (it stays for assistive tech).
- **Content:** the name in Headline on the tab line; the email in Title on the first list line; copy glyphs in each line's trailing slot, revealed on hover or focus; a section label (Title with a 16px glyph) followed by recent threads (Body, Ash, ellipsis, 24px pitch); exact known data only, never invented enrichment.
- **Footer:** none. Superhuman's footer toolbar has no counterpart with real actions here; the utilities live in the rail (Parity gap 9).

### Buttons
- **Ghost (browsing shell, the default):** transparent, Paper White text or a Graphite glyph, 4px radius, `4px 8px` (24px tall). Text ghosts in the dock bars (selection actions, Undo, Load more) carry the Title weight. Hover lifts a text ghost to Lifted Charcoal and a glyph to Paper White; press is Focus Stone; disabled is 0.45 opacity. The focus ring is a 2px Dusk Lavender outline at a 1px offset.
- **Utility (drawers, the attachment chooser, recovery banners):** a Lifted Charcoal fill with a 1px Seam border, 4px radius, `3px 8px` (24px tall); hover is Focus Stone. This is the only bordered button. Quiet drawer actions (`Disconnect…`, the Provider mail refresh and back buttons) use `.drawer-ghost`: the ghost look inside a drawer.
- **Specificity:** the defaults are `:where()` rules, so a component class (split tab, rail item, row action, contact line) always wins without `!important`.

### Command Overlay
- **Style:** a Lifted Charcoal panel, 10px radius, 576px max width, no border, Overlay lift, 15vh from the top. There is no caption: the placeholder and the dialog's accessible name say whether it is Commands or Destinations. The 38px query (16px Headline) sits on Deep Umber with a 1px Dusk Lavender border; it always owns keyboard focus, so that border is its focus indicator. Items are 36px rows of 12px Body with a 16px Graphite glyph that turns Paper White when highlighted. The highlighted item gets a Focus Stone fill plus a 3px Dusk Lavender left bar. Disabled items are Smoke, with their reason in Ash. Shortcuts are `kbd` in Ash on Deep Umber, compact ("G then E", timing in the tooltip). The hint line sits under a 1px Seam.
- **Groups (palette only):** Conversation, Selection, View, Go to, Account (Connect Gmail, Sync now, only while they can run), each a sentence-case 11px Ash label, no rule, no caps. The Destinations navigator is one group and stays unlabelled. Items are searched by label, aliases (undo → revert, archive → done, snooze → remind) and their exact bound key; the empty state says what did not match ("No command matches “…”.").
- **Glyphs:** `CommandGlyph.vue` reuses RowGlyph, HeaderGlyph and PaneGlyph where the idea already has a glyph, and draws the few palette-only ones (open, undo, selection, splits, filter, switch account) on the same 16px grid.
- **Keys:** a quiet list under the commands for bound keys that are not commands (J/K, X, Shift+J/K, Left). They are text rows, never options: no highlight, no pointer, never executed. Filtered by the same query.

### Composer (reply and new message)
- **Shell:** Lifted Charcoal with a 1px Seam border, docked at the bottom of the reader pane (6px radius, capped at 60% of the pane) or, for a new message with no reader, the in-flow card (10px radius). Never a modal.
- **Heading line:** the title on the left (Title weight, `Reply draft to Ada Fixture` or `New Message`) and the one status line on the right (Body, Ash when settled, Amber Notice otherwise) with its small info button; the caveat line opens under the heading.
- **Rows:** a 3.5rem Ash label column, then an input with a quiet Seam underline at rest (full Seam border on hover); the reply shows only `To  <name> <address>` as a button until the user asks for more. Body: at least six lines, grows, bordered like a field.
- **Footer:** primary `Save and close` (Focus Stone, Title weight) with an Ash `Esc` hint, quiet Ash `Discard…`. The only buttons besides the confirm dialogs and retry actions. No Send.

### Reader Message Disclosures
- **Status line:** one Ash line under the subject for the read state (plus `Read-only`); standing guarantees live in its title and hidden text. Exceptions stay as Amber Notice lines.
- **Quote and signature:** Ash reading-face blocks after the prose; the quote is behind a ghost toggle. **Attachments:** a plain list of 24px lines under the body, ghost `Save` per file.

### Inputs / Fields
- **Style:** a Lifted Charcoal fill, a 1px Seam border, 4px radius, inherited font.
- **Focus:** the border shifts to Dusk Lavender, doubled by a 1px inner outline so the ring reads at 12px. No glow.
- **Placeholder:** Smoke (4.76:1 on Lifted Charcoal).

### In-flow Notices (Action notice, Selection bar, coverage and recovery)
- **Style:** borderless lines in normal flow, with text on the 50px content inset, in Body type with 6px block padding. Status words use Amber Notice or Coral Fault. Undo shows its `kbd` hint in Ash. They never overlay rows and never auto-hide a failure.
- **Bottom dock (transient lines):** the Selection bar, the Action notice and the command-error alert sit in a dock at the bottom of the list column, below the list, never above it. Showing or hiding them never moves a row. The dock reserves one 36px line and grows upward into the list viewport; the focused row is kept whole when the viewport shrinks. Its lines are whole-pixel (16px line height, 24px buttons). This is the honest, in-flow form of Superhuman's bottom undo toast: no float, no shadow, nothing covered.
- **Above the list (static lines):** Starred/Done coverage notes and the draft-close recovery banner, which belong to the destination or to a pending recovery rather than to the last keystroke.

## 6. Do's and Don'ts

### Do:
- **Do** keep rows at exactly 36px with 12px type, and separate them by rhythm alone.
- **Do** align split tabs, sender names, date captions, notices and the bottom dock to the single 50px content inset.
- **Do** use Dusk Lavender (#bba5ed) only for the current row or message, and the focus ring.
- **Do** show every pending, partial, failed and outcome-unknown state in words, in Amber Notice or Coral Fault, where the user is already looking.
- **Do** align the contact pane to the list: the name on the tab line, the email on the first-row line.
- **Do** ship glyphs as local inline SVG with an accessible name. No icon fonts and no CDN.
- **Do** name each action once, in sentence case, on every surface (row glyph, selection bar, reader, Activity, action notice, palette): "Mark done" / "Mark not done" (E / Shift+E), "Mark read" / "Mark unread", "Star" / "Unstar". Counted forms keep the verb: "Mark 3 done". Destinations keep their proper names (Inbox, Done, Starred, Trash, Provider mail, Activity) after "Go to". "Archive" is the provider-side effect, never a label; it survives only as a palette search alias.
- **Do** treat Superhuman's browsing look as the visual and interaction reference. Close look parity is the goal (PRODUCT.md).

### Don't:
- **Don't** draw dividers between rows or under the header. Seams separate panes only.
- **Don't** use uppercase letter-spaced captions in the browsing shell.
- **Don't** add Gmail-web clutter: toolbars of rarely-used icons, or chrome competing with content.
- **Don't** add "AI magic" chrome: sparkle icons, or generated summaries presented as fact.
- **Don't** build a Superhuman feature-parity clone. Copy the browsing look, not Superhuman's product scope.
- **Don't** use generic SaaS dashboard aesthetics: card grids, gradient heroes, oversized rounded panels, decorative illustration.
- **Don't** show optimistic UI that lies: no "Done" toast before the provider confirms, and no silent retry of an ambiguous send.
- **Don't** put shadows on anything in the rail, header, list or contact pane.
- **Don't** use Graphite for text or meaningful glyphs on Focus Stone or on the composer's Lifted Charcoal fill. Use Ash.
- **Don't** repeat a standing guarantee as a paragraph on every open. State it once, in a status line with the detail in its title; only exceptions interrupt.
- **Don't** introduce a third type size in the list, or use off-palette hex values (the old command-overlay violets are the cautionary example).
- **Don't** load remote fonts, images or CDN assets.
