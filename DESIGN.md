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
   - The status line is removed. The inbox count is on the active tab; loaded counts were dropped as duplicates of the list. Selection count stays in SelectionBar, plus a visually hidden polite announcement. The pending count is covered by row "Pending…", the action notice and Activity. The Shift+U hint is in the Commands palette. The command error is its own alert line beside the action notice in the list column's bottom dock (gap 13). The read-only hint and the Unread-only/Starred-only filter states stay visible in words in the header.
   - The Inbox coverage sentence is the tabs' accessible description and the tab strip's hover title. The browser-preview banner is a one-line amber "Preview · in-memory" note on the right; the full disclosure is its title and accessible text.
   - Utility drawers now start below the header, so they never cover its glyphs.
   Remaining: a compose glyph was deliberately not added, because there is no compose capability beyond local drafts in the Drafts drawer; decide whether "New local draft" earns a header slot. (The aggregate pending count now lives on the Activity rail badge, and the tab line is calibrated against the rail's home circle: both are centered 42px down; see gap 2.)
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
10. **Palette deltas.** Done: `text-primary` #ece9e2 → #ffffff (typeset pass), `text-secondary` #a8a29a → #c0bcb6 (rows pass), `text-tertiary`, `icon-muted` and `unread-marker` added (header and rows passes), the undefined `--text-muted` on coverage notes now maps to `text-secondary`, and `rail-well` / `rail-button` are CSS tokens (rail pass). `divider` is now #474543 (polish pass): the rail and contact-pane seams, the drawer's leading edge, utility-chip and input borders, the compact row-actions popover and the command-overlay hint rule. It never separates rows (the list has no row borders). The old #3b3936 survives as the quieter `rule` token for structure inside a pane, only in the reader (toolbar and message rules) and inside drawers (Activity and draft rows, group detail, Account panel, Reminders fieldset), so those surfaces keep their tone until a reader reference is captured. `focus-accent` stays at the committed #bba5ed; the capture reads about #bfa1f6, which is within capture and color-profile noise.
11. **Global button style.** Done (polish pass). The `button` defaults are zero-specificity (`:where()`), so every component class keeps its own look. The default is a ghost: transparent, Paper White, 4px radius, `4px 8px` (24px tall at 12px, the old chip's hit target), Lifted Charcoal on hover, Focus Stone on press, 0.45 opacity when disabled, and the 2px Dusk Lavender focus ring at a 1px offset. The selection bar, the action notice's Undo, Load more, the search form and the reader toolbar are ghost text buttons. Bordered `button-utility` chips (Lifted Charcoal, 1px Seam, `3px 8px`) appear only inside utility drawers, the modal attachment chooser, recovery banners (`.recovery-banner`: draft-close recovery, inbox/account load errors, the reader's navigation error, the header's saved-split error) and the synthetic workspace strip. Fields follow "Inputs / Fields": a Seam border that shifts to Dusk Lavender (plus a 1px inner outline) on keyboard focus, Smoke placeholders (4.76:1 on Lifted Charcoal) and a lavender ring on native checkboxes.
12. **Command overlay.** Done (polish pass). The off-palette values the overlay still carried (#56534e border and rules, #c9c4bc caption, icon and hint text, #d4cfc7 disabled reasons, #66615b `kbd` fill, `.85rem` radius, the 46rem width, 24px query and 1.5rem glyph) are now tokens: a 576px Lifted Charcoal panel with a 10px radius, no border, Overlay lift over a `rgba(0,0,0,0.53)` backdrop at 15vh. The query is 16px on Deep Umber with a 1px Dusk Lavender border, items are 36px rows of 12px Body with 16px Graphite glyphs, the highlighted item is Focus Stone plus a 3px Dusk Lavender bar, disabled items are Smoke with Ash reasons, and `kbd` is Ash on Deep Umber. Geometry is whole-pixel so a highlighted item scrolled into view is never clipped. The modal attachment chooser shares the panel (46rem wide, 12px body), which closes the "chooser body inherits 16px" remainder of gap 14. (The violets this gap once listed were already gone before this pass.)
13. **In-flow bars.** Done (polish pass). Every bar is borderless Body type with its text on the 50px content inset and 6px block padding. The lines that come and go with triage keys (the Selection bar, the single-slot Action notice and the command-error alert) now live in a bottom dock of the list column (`.list-dock`) instead of above the list, so x, e and z never move a row. Measured at 1280×800 (Gmail preview): the first row stays at y=126 (real clock) or y=78 (Today clock) through x, x, Clear, e and z; before, it moved 126 → 186.9 → 162.8 → 156. The dock keeps one 36px line reserved and grows upward into the list viewport (selection: 56px). If that shrink would clip the focused row, the list scrolls just enough to keep it whole. The static context lines (Starred/Done coverage, draft-close recovery) stay above the list, because they belong to the destination rather than to an action. The reader's selection-scope note is a borderless line in the reader.
14. **Type scale and dates.** Done (2026-11-07 typeset pass). The shell type is semantic tokens on `:root`: `--type-headline` 1rem, `--type-body` 0.75rem, `--type-count` 0.6875rem, `--type-mono` 0.85rem, weights 400/600 only (`--weight-regular`, `--weight-strong`). `.app-main` sets Body as the shell default, so the rail, contact pane, notices, drawers, the reader chrome and form controls are 12px instead of an inherited 16px or ad hoc 0.8/0.85/0.9/0.95/1.1rem. Shell h2 is Headline; h3/h4 and in-panel drawer headings are Title; the reader subject is Headline at 600. Row dates follow the Label rules below and are deterministic (no default-locale dependence: the old `30 Sept 2001` vs `Sep 30, 2001` rendered-layout gate now passes under any `LANG`). Rows carry `<time datetime>` plus the full date as the title; reader message times are full dates with `datetime`. The rendered larger-text gate expected the compact action disclosure at a 25px root font (was 23px) after this pass, and at 34.5px (expanded at 30px) after the rail/contact pass, since the fixed-px rail and contact pane leave the list wider at every text size.
   Polish pass: the remaining raw timestamps (Account "Last synced", Cached Done coverage "Last synced", Activity group times, Provider mail catalog, page, recovery-snapshot and message times, Reminders due times, the reader's recovery snapshot) now go through `FullDate.vue`, which renders `fullDateLabel` in a `<time datetime>`. The command overlay and the attachment chooser are on the scale (gaps 12 and 14). Remaining: the Reminders time input still takes a typed ISO value; it is an input, not a display.
15. **Typeface.** Superhuman ships a proprietary face. We stay on local `system-ui` (no remote fonts), so glyph widths will differ slightly. Calibrate sizes by eye on device, not by matching the font.
16. **Out of scope for this capture.** The native title strip (Tauri window chrome) and the reader view are not shown. The reader's type is on the shell scale (typeset pass: Headline subject at 600, 12px message chrome, full dates, Mono body), but its layout and colours keep their current tokens until a reader reference is captured.

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
- **Graphite** (`icon-muted`): every resting glyph (row actions, compose, search, hamburger, footer icons, attachment). Hover and focus raise glyphs to Paper White.
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
- **Layout:** a 44px gutter (unread dot, or the checkbox in selection mode), then a 132px sender (Title, Paper White, ellipsis), then the subject (Body, Paper White) and snippet (Body, Ash) on one line with 12px gaps, then the trailing date (Label, Ash) about 25px from the pane edge. An attachment glyph (Graphite, 16px) sits before the date when present.
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
- **Utility (drawers, the attachment chooser, recovery banners):** a Lifted Charcoal fill with a 1px Seam border, 4px radius, `3px 8px` (24px tall); hover is Focus Stone. This is the only bordered button.
- **Specificity:** the defaults are `:where()` rules, so a component class (split tab, rail item, row action, contact line) always wins without `!important`.

### Command Overlay
- **Style:** a Lifted Charcoal panel, 10px radius, 576px max width, no border, Overlay lift, 15vh from the top. A 36px Title caption in Ash with a 16px Graphite glyph, then the 38px query (16px Headline) on Deep Umber with a 1px Dusk Lavender border; it always owns keyboard focus, so that border is its focus indicator. Items are 36px rows of 12px Body with a 16px Graphite glyph that turns Paper White when highlighted. The highlighted item gets a Focus Stone fill plus a 3px Dusk Lavender left bar. Disabled items are Smoke, with their reason in Ash. Shortcuts are `kbd` in Ash on Deep Umber. The hint line sits under a 1px Seam.

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
- **Don't** introduce a third type size in the list, or use off-palette hex values (the old command-overlay violets are the cautionary example).
- **Don't** load remote fonts, images or CDN assets.
