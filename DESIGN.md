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
  reading:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.6
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
  content-inset-end: "24px"
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
- One content inset (50px from the list pane's left edge, 24px at the right end: `--content-inset`, `--content-inset-end`). It aligns split tabs, sender names, date-group captions, notices, banners and the bottom dock, and it carries into the reader: the subject, message senders, bodies and notes start on that x, and a docked composer's left edge sits on it.
- 36px rows on 12px type. Hierarchy comes from weight and tone, not size.
- Pane-edge alignment: the contact name sits on the split-tab line, and the contact email sits on the first-row line.
- Flat tonal layering. No shadows in the browsing shell.
- The violet accent appears once per screen: on the focused row or the active message.

**Layout geometry (approximate calibration targets).** These values come from the 2026-11-07 Superhuman reference capture (1603×2000 image px). The capture was scaled by about 1.56 image px per CSS px, calibrated from the macOS traffic-light pitch of 20pt and cross-checked against the 36px rhythm and the 40px and 270px pane widths in `superhuman-email-browsing-ux-spec.md`. Verify them on real displays.
- **Rail:** 40px wide. The top action button (28px circle) is centered on the split-tab line (42px down). The navigation icons sit in a dark pill about 30px wide that starts near the header's bottom edge, with its first glyph centered on the first list line (96px down) and a 28px pitch. The active glyph sits on a 24px Rail Pebble disc inside the pill.
- **Split header:** 78px from the content top to the first row. Tabs are vertically centered about 42px down. The hamburger is centered 23px into the pane. Tabs start at the 50px content inset with an 18px gap; the count sits 4px after its label. Compose and search icons are right-aligned on the 32px action pitch.
- **Rows:** 36px. The highlight is inset 6px from both pane edges. There is a 44px left gutter, with the 5px unread dot centered about 34px into the row. The sender column is 132px, and subject→snippet→meta gaps are 12px. The trailing date sits about 25px from the pane edge. On focus, three 16px action glyphs replace the date at a 32px pitch.
- **Date groups:** a 48px block, with the caption vertically centered on the content inset.
- **Reader:** the pane has no side padding. The reader's scroller carries the content inset (`padding-inline: 50px 24px`), so the subject, meta row, notes, loading identity and skeleton start at 50px, the same x as the list's sender text. The message stack keeps the list's focus-fill idea: each `.message` fill (the active one is Lifted Charcoal plus a 3px Dusk Lavender inset bar) spans from 6px to 6px of the pane edges, while its text stays on the inset (negative inline margin on `.messages`, inline padding on `.message`). Right edge decision: the right inset is 24px, the same as the dock, notices and composer, and the line measure is capped by `max-width: 65ch` on prose and `88ch` on monospace bodies, not by the container, so a wide pane stays left-aligned on the grid. The active message's toggle has two cues that mean different things: the 3px lavender bar says "this is the active message", and a 2px Paper White ring at a 1px offset, only on `:focus-visible`, says "the keyboard is here" (every other control keeps the lavender ring; the One Signal Rule holds because lavender still appears once). Measured at 1280×800: toggle outline `solid 2px rgb(255,255,255)` offset 1px, ring left edge at x=87 inside the message fill (46). The collapsed sender, the expanded body, the signature, `Details` and the `Show quoted text` label share one x (the message toggle and the `Details` summary carry no inline padding; the quote button pulls its 8px ghost padding into the gap with a `-8px` margin, like the selection actions: on a replica with the real class the label is at x=90 like the body, the button box at 82; before, the label was at 98). The selection-scope note and the in-pane recovery banner use the same 50px/24px. A docked composer (the reply composer and the docked new-message card) uses the undocked card's margins: `6px 24px 12px 50px`. The loading skeleton rows have the real collapsed-message pitch (1px border, 1rem padding, `--message-row-height` of 2 × Body, 0.5rem margin; about 49px at a 16px root) and start where the first message will, so the pane does not jump when the conversation arrives: the sender, date and `Loading conversation…` are ONE line (`role="status"` on the status span only); where the loaded reader has a meta row (read controls, read-only, a selection scope) that line IS the meta row's slot, and otherwise it is drawn out of flow over the first placeholder row (`.is-overlay`), which therefore paints no bar of its own. Without a list-row identity the subject slot is a hidden `h2.reader-subject` with a bar inside, so its margins match the real subject by construction. Measured in a browser with a deliberately delayed `getConversation` (fixture, no read controls, 1280×800): before, the first skeleton row was at y=244.3 and the first real message at y=187.9 (+56.4px); after, rows [187.9, 236.9, 285.9] against messages [187.9, 236.9, 285.9] (0.0px), also 0.0px at 1000×700 with a 20px root font (rows 213.2/274.2/335.2) and, as a replica with the meta-row classes and a real-shaped `.reader-meta-row`, 204.1 against 204.1. The rest of these numbers come from the CSS and are asserted by `tests/reader/geometry.test.ts`.
- **Contact pane:** 272px with a 24px inner inset. The name is centered on the tab line (42px), the email on the first list line (96px), the "Mail" label about 36px lower (~131px) and the first thread at ~156px, then a 24px pitch. Superhuman's footer toolbar sits 24px from the bottom: a ghost label plus 16px glyphs at a 28px pitch.

### Parity Gaps (current code → target)

This is the backlog for layout, typeset and polish passes. Each gap names what ships today and what this spec requires.

1. **Split header.** Done (2026-11-07 header pass). The header is one borderless 78px strip inside the list column (the rail and contact pane span its height). It has a Graphite hamburger (Destinations navigator) centered 23px in, split tabs on the 50px inset (16px, active Paper White, inactive Smoke, 11px Ash count 4px after the label, 18px apart), and right-hand glyphs on the 32px pitch: Back (when there is history), Reminders (a bell, while the reader's `Remind me on this device` action and the row action keep the clock, so the view and the action never share a glyph), the Starred-only toggle, Commands and Search. There is no brand text, no visible h1 while a tab is active, and no bordered chips. Glyphs are local inline SVG (`HeaderGlyph.vue`).
   - The context h1 stays in the accessibility tree. It is shown on screen, styled like an active tab, only when no rendered tab is active (Cached Done, Starred, Cached Trash, Drafts, Search, the reader, an open drawer). Reminders is the one context that shows it beside tabs: its tabs are the list's sections (gap 21), so the heading stays in front of them.
   - The status line is removed. The inbox count is on the active tab; loaded counts were dropped as duplicates of the list. Selection count stays in SelectionBar, plus a visually hidden polite announcement. The pending count is covered by row "Pending…", the action notice and Activity. The Shift+U hint is in the Commands palette. The command error is its own alert line beside the action notice in the list column's bottom dock (gap 13). The read-only hint and the Unread-only/Starred-only filter states stay visible in words in the header.
   - The Inbox coverage sentence is the tabs' accessible description and the tab strip's hover title. The browser-preview banner is a one-line amber "Preview · in-memory" note on the right; the full disclosure is its title and accessible text.
   - Utility drawers now start below the header, so they never cover its glyphs.
   Update: the compose glyph now ships. It sits on the right of the header, left of Search, as a Graphite glyph on the 32px pitch, and opens the local-draft compose card INLINE in the central pane ("New Message", C key / palette action "Compose new local draft") — an in-flow card that replaces the list while composing, not a modal overlay: no backdrop and no dimming, so the rail, header and contact pane stay visible. (While a reader is open, the card docks at the bottom of the reader pane, like the reply composer.) There is still no compose capability beyond local drafts, so the glyph opens the local-only inline card, never a sender. (The aggregate pending count now lives on the Activity rail badge, and the tab line is calibrated against the rail's home circle: both are centered 42px down; see gap 2.)
2. **Rail.** Done (2026-11-07 rail/contact layout pass). The rail is a fixed 40px column (px, so larger root fonts widen the list, never the rail) with a 1px Seam on its right.
   - **Home circle:** Inbox is the 28px Rail Pebble circle, centered on the split-tab line. We have no AI or compose action to put there, so the primary destination takes the slot instead of an empty or dead control.
   - **Inkwell pill:** a 30px pill (the capture measures ~30px, not 28px) holds Starred (Gmail), Cached Done, Provider mail and Cached Trash (Gmail) as 16px glyphs on 28px hit targets at a 28px pitch. Its first glyph is centered on the first list line.
   - **Utilities:** Account (Gmail), Activity, Drafts and the narrow-viewport Contact disclosure are ghost glyphs at the bottom, 16px from the edge. Account and Activity open drawers; Drafts is a navigation item (a list context, gap 21) and carries `aria-current` while its list is showing.
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
   - **Nothing is inserted above the pinned lines:** the pane has no "Composing to …" line while a reply is open (it moved the name from 87 to 120 and the email from 143 to 176 in the rendered critique, 33px). The reply heading and its To row already name the recipient, so the fact is said once, and said more exactly (the pane could only name the sender, which differs from To on list mail). Measured with a reply open (1280×800, banner included): name y=97.4, email y=151.4, first thread y=211.4, identical to the closed state.
   - **Copy controls:** each copy control is a 16px Graphite glyph in the trailing slot of its own line, revealed by opacity on line hover or focus. It stays focusable, and it no longer leaves an empty line when hidden. Without a display name, Copy email moves to the name line.
   - **Recent cached mail:** a Title label with a 16px envelope glyph (~129px), then plain Ash text rows at a 24px pitch (first at 156px). Each row has an ellipsis and the full subject as its title, rises to Paper White on hover or focus, and is still a button.
   - **Narrow disclosure:** inside the Contact disclosure below 1000px, the same content stacks compactly under the drawer header.
   - **No footer toolbar:** Account, Activity and Drafts stay in the rail, their one home. The contact column does not exist below 1000px and is `inert` while a drawer is open, so footer toggles would vanish on narrow viewports and could not close their own drawer or receive focus back (Drafts is no longer a drawer; the rule holds for Account and Activity).
   Remaining: the label keeps our honest copy "Recent cached mail" rather than "Mail" (vocabulary pass). The list is still the 4 most recent cached results from the sender search, not a provider-complete thread list.
10. **Palette deltas.** Done: `text-primary` #ece9e2 → #ffffff (typeset pass), `text-secondary` #a8a29a → #c0bcb6 (rows pass), `text-tertiary`, `icon-muted` and `unread-marker` added (header and rows passes), the undefined `--text-muted` on coverage notes now maps to `text-secondary`, and `rail-well` / `rail-button` are CSS tokens (rail pass). `divider` is now #474543 (polish pass): the rail and contact-pane seams, the drawer's leading edge, utility-chip and input borders, the compact row-actions popover and the command-overlay hint rule. It never separates rows (the list has no row borders). The old #3b3936 survives as the quieter `rule` token for structure inside a pane, only in the reader (toolbar and message rules), the composer's own structure and the Account panel, so those surfaces keep their tone until a reader reference is captured. Drawer rows and the Activity group detail no longer use it (gap 20), and neither do the Reminders rows and picker (gap 21). `focus-accent` stays at the committed #bba5ed; the capture reads about #bfa1f6, which is within capture and color-profile noise.
11. **Global button style.** Done (polish pass). The `button` defaults are zero-specificity (`:where()`), so every component class keeps its own look. The default is a ghost: transparent, Paper White, 4px radius, `4px 8px` (24px tall at 12px, the old chip's hit target), Lifted Charcoal on hover, Focus Stone on press, 0.45 opacity when disabled, and the 2px Dusk Lavender focus ring at a 1px offset. The selection bar, the action notice's Undo, Load more, the search form and the reader toolbar are ghost text buttons. Bordered `button-utility` chips (Lifted Charcoal, 1px Seam, `3px 8px`) appear only inside utility drawers, the modal attachment chooser, recovery banners (`.recovery-banner`: draft-close recovery, inbox/account load errors, the reader's navigation error, the header's saved-split error) and the synthetic workspace strip. Fields follow "Inputs / Fields": a Seam border that shifts to Dusk Lavender (plus a 1px inner outline) on keyboard focus, Smoke placeholders (4.76:1 on Lifted Charcoal) and a lavender ring on native checkboxes.
12. **Command overlay.** Done (polish pass; structure pass: groups, per-command glyphs, aliases, Keys list, "no match" copy, caption removed). The off-palette values the overlay still carried (#56534e border and rules, #c9c4bc caption, icon and hint text, #d4cfc7 disabled reasons, #66615b `kbd` fill, `.85rem` radius, the 46rem width, 24px query and 1.5rem glyph) are now tokens: a 576px Lifted Charcoal panel with a 10px radius, no border, Overlay lift over a `rgba(0,0,0,0.53)` backdrop at 15vh. The query is 16px on Deep Umber with a 1px Dusk Lavender border, items are 36px rows of 12px Body with 16px Graphite glyphs, the highlighted item is Focus Stone plus a 3px Dusk Lavender bar, disabled items are Smoke with Ash reasons, and `kbd` is Ash on Deep Umber. Geometry is whole-pixel so a highlighted item scrolled into view is never clipped. The modal attachment chooser shares the panel (46rem wide, 12px body), which closes the "chooser body inherits 16px" remainder of gap 14. (The violets this gap once listed were already gone before this pass.)
13. **In-flow bars.** Done (polish pass). Every bar is borderless Body type with its text on the 50px content inset and 6px block padding. The lines that come and go with triage keys (the Selection bar, the single-slot Action notice and the command-error alert) now live in a bottom dock of the list column (`.list-dock`) instead of above the list, so x, e and z never move a row. Measured at 1280×800 (Gmail preview): the first row stays at y=126 (real clock) or y=78 (Today clock) through x, x, Clear, e and z; before, it moved 126 → 186.9 → 162.8 → 156. The dock keeps one 36px line reserved and grows upward into the list viewport (selection: 56px). If that shrink would clip the focused row, the list scrolls just enough to keep it whole. The static context lines (Starred/Done/Trash coverage, draft-close recovery) stay above the list, because they belong to the destination rather than to an action. The reader's selection-scope note is a borderless line in the reader.
14. **Type scale and dates.** Done (2026-11-07 typeset pass). The shell type is semantic tokens on `:root`: `--type-headline` 1rem, `--type-body` 0.75rem, `--type-count` 0.6875rem, `--type-mono` 0.85rem, weights 400/600 only (`--weight-regular`, `--weight-strong`). `.app-main` sets Body as the shell default, so the rail, contact pane, notices, drawers, the reader chrome and form controls are 12px instead of an inherited 16px or ad hoc 0.8/0.85/0.9/0.95/1.1rem. Shell h2 is Headline; h3/h4 and in-panel drawer headings are Title; the reader subject is Headline at 600. Row dates follow the Label rules below and are deterministic (no default-locale dependence: the old `30 Sept 2001` vs `Sep 30, 2001` rendered-layout gate now passes under any `LANG`). Rows carry `<time datetime>` plus the full date as the title; reader message times are full dates with `datetime`. The rendered larger-text gate expected the compact action disclosure at a 25px root font (was 23px) after this pass, and at 34.5px (expanded at 30px) after the rail/contact pass, since the fixed-px rail and contact pane leave the list wider at every text size.
   Polish pass: the remaining raw timestamps (Account "Last synced", Cached Done coverage "Last synced", Activity group times, Provider mail catalog, page, recovery-snapshot and message times, Reminders due times, the reader's recovery snapshot) now go through `FullDate.vue`, which renders `fullDateLabel` in a `<time datetime>`. The command overlay and the attachment chooser are on the scale (gaps 12 and 14). Remaining (closed by gap 20): the Reminders time input took a typed ISO value; the typed field now sits behind a `Custom` toggle and preset times fill the same value.
15. **Typeface.** Superhuman ships a proprietary face. We stay on local `system-ui` (no remote fonts), so glyph widths will differ slightly. Calibrate sizes by eye on device, not by matching the font.
16. **Out of scope for this capture.** The native title strip (Tauri window chrome) and the reader view are not shown. The reader's type is on the shell scale (typeset pass: Headline subject at 600, 12px message chrome, full dates, Mono body). Its layout is now on the content inset (see "Layout geometry", Reader), still not measured against a capture; its colours keep their current tokens until a reader reference is captured. The reader and composer pass below (gap 17) works from the code and the critique, not from a capture.
17. **Reader and composer pass.** Done (2026-11-08, code-verified; nothing was rendered, so geometry and contrast ratios are computed from the tokens, not sampled). Brand rule: the surfaces say each fact once, and only exceptions interrupt.
   - **Compact docked reply composer.** A one-line recipient row (`To  Ada Fixture`) replaces the always-open To, Cc and Subject boxes. The row is a real button; while To still equals the default sender mailbox it shows the display name and the real address beside it (`Ada Fixture <ada@example.test>`, the address in Ash, never hover-only, so a sender named "Bank Support" cannot hide `x@evil.test`; a name equal to the address is not repeated), and the raw To text in an input as soon as it differs, so the field is never misrepresented. A quiet Ash `Cc / Subject` toggle (`aria-expanded`) opens those rows on demand; they open by themselves when Cc has text or the subject is not the default `Re:` line, so saved data is never hidden. An edited To does not open them: the To row is already a visible input then, so nothing is hidden. The heading follows the actual To, not the latest sender: while To is empty during creation, or equals the sender mailbox (case-insensitive), it reads `Reply draft to Ada Fixture`; otherwise it names the first entry of To (split on `,` or `;`) with ` +N` for N more (`Reply draft to list@lists.example +2`), and the full To is its title; a ready draft with an empty To reads `Reply draft`. This matters when the draft's To came from Reply-To on list or newsletter mail, where the sender and the recipient differ. The heading stays one short line for any number of addresses. The body is the dominant field and takes focus once the draft exists: at least six lines (7.5rem at the 12px body size), growing with its text up to half the viewport. The docked shell (`.reply-composer`, `.reader-pane > .compose-card`) is capped at 60% of the reader pane, so the thread stays above it, and it uses the same margins as the undocked card (`6px 24px 12px 50px`: left edge on the 50px inset, 24px at the right, 12px below), so docked and undocked composers agree. The read-only quoted block is Body type in the UI face, Ash, with the 2px Rule on its left edge, `pre-wrap`, clamped to three lines (the full snippet stays in the DOM); it is never part of the draft body. The new-message card keeps To and Subject as one-line label-plus-input rows with Cc on demand. The inputs are borderless-looking (a transparent 1px border with a Graphite underline at rest, the full Graphite border on hover, and Dusk Lavender with the inner ring on keyboard focus; see "Inputs / Fields"). The inline compose card, also where a reply draft is edited when its thread cannot host it, gap 21 shares the same core.
   - **Status line and caveats (follow-up).** The status line stays terse (`Saved locally · not sent`). The caveats (recipients stored as typed and not validated; no Bcc, reply-all or rich text) are one extra Ash line behind a small info button next to it (`aria-expanded`, 14px Ash glyph, `About local drafts`), so keyboard users reach them; the `title` is a bonus, not the only route. The status line is no longer a live region: a separate visually hidden `role="status"` region announces only the first settled state, a problem (`Save not confirmed`, `Conflict — edits preserved`) and the recovery after one, never the `Saving…`/`Saved` autosave cycle. Error lines keep `role="alert"`. A successful discard closes the editor and says nothing of its own (the confirm dialog is the announcement).
   - **One status line, no raw IDs.** The three-line local-only disclaimer and the `Reply source is fixed: <conversationId> · <messageId>` line are gone. One Body line on the heading row carries the guarantee: `Saved locally · not sent` (Ash) once settled, `Local draft · not sent` (Ash) before the first save, and the existing words in Amber Notice while the state is not settled: `Saving locally…`, `Creating local draft…`, `Save not confirmed`, `Conflict — edits preserved`, and the two preview `(non-durable)` states with `· not sent` appended. The plain-language detail (nothing is sent, recipients are stored as typed and not validated, no Bcc, reply-all or rich text) is that line's `title` and the body's visually hidden `aria-describedby` text. Opaque provider IDs never appear in text, titles or labels; the fixed reply source survives only as `data-source-*` attributes.
   - **Footer.** One primary action, `Save and close`: Focus Stone fill, Title weight, 4px radius, 24px tall, with an Ash `Esc` `kbd` beside it. Hover adds an inset Ash ring (the fill alone disappears against Lifted Charcoal) and press steps to Rail Pebble. `Discard…` and `Cancel reply preparation` are quiet Ash ghosts. It still waits for the protected flush and stays open with the error if the flush fails. There is no Send button, shortcut or Cmd+Enter.
   - **Reader header.** The standing sentences ("Opening this conversation does not change read state…", "Read-only Gmail view…") are no longer paragraphs. One muted Ash status line in the meta row carries the read-state word (`Unread`, `Read`, `Read state unknown`) and, in a read-only view, `Read-only ·` before it; the guarantee sentence is that line's `title` and its visually hidden text, read once by assistive technology. Cached Trash keeps one Ash line (`Cached Trash — read only. Recovery is not available here; use your provider client.`) and the status span still says `Read-only` before the read state, with no standing sentence. While a conversation loads with no known row identity the bare `Loading conversation…` status is followed by a static placeholder (a hidden subject bar and three Rule-colour rows, each occupying the real collapsed-message pitch with the bar drawn inside, no shimmer, `aria-hidden`), so the pane does not jump; with a known identity the subject shows and the sender, date and status share one line (see Layout geometry > Reader) and only the rows follow. Only exceptions stay inline in Amber Notice, each once and in their old wording: star attention, reply blocked, retained snapshot, unsupported or incomplete, and pending (no longer italic). A normal conversation shows the subject, one meta line and the messages.
   - **Trailing quote and signature.** A body is split deterministically and losslessly (`splitMessageBody`) into prose, an optional signature and an optional trailing quote. The signature starts at an RFC 3676 `-- ` line (dash, dash, space) with at most 12 lines after it; a bare `--` is ordinary prose and dims nothing. The trailing quote is an attribution line plus a `>` run that reaches the end, or a bare run of two or more `>` lines. Attributions are English (`On … wrote:`), French (`Le … a écrit :`, with a normal, no-break or no space before the colon), German (`Am … schrieb …:`), Spanish (`El … escribió:`), Italian (`Il … ha scritto:`, also `Il giorno …`), Portuguese (`Em … escreveu:`) and Dutch (`Op … schreef …:`), plus the localized separators `-----Original Message-----`, `-----Message d'origine-----`, `-----Ursprüngliche Nachricht-----`, `-----Mensaje original-----`, `-----Messaggio originale-----`, `-----Mensagem original-----` and `-----Oorspronkelijk bericht-----`. An attribution may wrap onto up to three lines (joined with a space to test) and is at most 300 characters when joined. Matching uses the `u` flag and Unicode-aware word ends, not `\b`, which is ASCII-only. The `>` run that reaches the end of the body stays the safety net: prose that merely contains `wrote:` or `schrieb` is never split off. Interleaved quotes stay in the prose; a body that is all quote is never split. Monospace: quoted lines no longer force it. A line that starts with up to three spaces and `>` is skipped by the monospace test, and it breaks an indented run, so one interleaved `>` line or an inline-reply thread reads in the proportional face with its `>` characters kept. Monospace is forced only when the non-quoted prose looks aligned: two consecutive lines indented by 4 spaces or a tab, or two or more lines with two or more pipes. The prose part decides, so a short reply above a quote reads in the proportional face. This rule has not been judged in a render: hard-wrapped quote lines (about 72 columns) now reflow at 65ch, which should fit, but that is unverified. Signature and quote use the reading face and size in Ash with `>` kept. The signature is always visible with its message. The quote sits behind a ghost `Show quoted text` / `Hide quoted text` button (`aria-expanded`, 24px, Ash) kept per message in the reader's visit state, so it survives J/K round trips. A collapsed row previews the prose, never the quote. The row snippet (140 UTF-16 units) and the reply composer's read-only quoted snippet (the prose of the latest message, trimmed, 200 units, `…` only when cut) are both cut on grapheme-cluster boundaries (`Intl.Segmenter`, with a code-point fallback), so an emoji, a ZWJ sequence or an accented letter is never split and no lone surrogate is shown.
   - **Inline attachments and human sizes.** An expanded message with `hasAttachment === true` lists its files under the body: a plain list, no cards, one 24px line per file (16px Ash paperclip, filename in Paper White with an ellipsis and the full name as its title, then `27 B · text/plain` in Ash, then a ghost `Save` with the accessible name `Save <file name>`). While a file transfers, its `Save` button stays mounted, `aria-disabled` and reads `Saving…` (accessible name `Saving <file name>`), with a `Cancel` beside it, so keyboard focus never falls to the page (the same idea as Retry; when `Cancel` held focus and the transfer stops, `Save` takes it back; focus that moved elsewhere is left alone; no live region is added); success is an Ash `role="status"` line (`Saved to Downloads as <name>. No file was opened.`, or the modelled preview wording), failure is a Coral Fault `role="alert"` line with the chooser's wording. Files over 5 MB show `Over the 5 MB limit; cannot download.` and no button. A retained snapshot disables Save with a title. A message that claims files with no cached descriptor says `Attachment details are not cached. Sync to fetch.`; `false` or unknown claims show nothing. Descriptors load once per conversation after the snapshot renders and are kept for the reader session; a failed load (`Could not load file details.`) offers a ghost `Retry` that asks again (see Reader Message Disclosures). Sizes are binary steps with mail-client names (`27 B`, `1.0 KB`, `4.6 MB`; `unknown size` for a non-number). Names are printed with bidirectional control characters (U+202A–202E, U+2066–2069, U+200E/F, U+061C) removed, so `invoice\u202Efdp.exe` reads in its real order; the same applies to the chooser and the saved-as line. A size that one decimal would round across the limit prints exact bytes (`5,242,881 B` next to `Over the 5 MB limit`, never `5.0 MB`). The Cmd+O chooser keeps links and the full list and uses the same transfer logic (`useAttachmentTransfer`) but its own instance: a transfer started inline is not shown in the chooser, and closing the chooser cancels only its own transfer. Its file buttons read `Save` too (and also stay mounted as `aria-disabled` `Saving…` while a transfer runs, as does `Reload file list`, so its Escape and Tab trap keep hearing keys; focus leaves `Cancel transfer` for the file's `Save` when it goes away), with the accessible name `Save <file name>` (they used to read `Save to Downloads`; only the success line names Downloads). Its intro shrinks to `Download only. Files save inert with a .download suffix; nothing is opened.` Its lists are named `Files` and `Links`, and sit on the same x as the text above them (no default 40px list indent: file text at x=288 like the note and heading, was 328), and with no cached descriptors the files line reads `No cached files. Sync to fetch any that are missing.`
   - **R and contrast.** `R` prepares a reply from the open reader, from the same rule as the buttons (ready, not Cached Trash, not blocked by an incomplete conversation, a retained snapshot or mismatched headers, no drawer or composer open). The source is always the displayed latest message, never the focused one. The reply body takes focus from anything that is not a text field (`<body>`, the reply button, the reader article after a click on message text, a `Details` summary, a participant), never from a text field the user moved to. After Discard focus returns to the reader's active message. It is inert in text fields, during IME composition, with modifiers, on key repeat and from other buttons. "Reply" appears in the palette with `R` only while it can run, and the reply controls' titles read `Reply — R` (the accessible name of the toolbar button is `Reply`; the per-message glyph, which does the same thing, is `Reply to latest message` so a screen reader can tell the two apart, and both keep the `Reply — R` title). The blocked-reply notices, `Cancel reply preparation` and the `reply_unavailable` draft error keep the word "preparation". Closing the composer returns focus to the reader's active message. Graphite is 2.75:1 on Focus Stone and 3.79:1 on Lifted Charcoal, so it is never used for meaningful glyphs or text on a focus fill or on the composer fill; new hints and glyphs use Ash (4.99:1 and 6.86:1). The reader's `Details` summary moved from Graphite to Ash for that reason; the reply glyph on the active message stays Graphite at rest (3.79:1 clears the 3:1 glyph floor) and rises to Paper White on hover and focus.
18. **Reader and composer critique, second pass.** Done (2026-11-09, code-verified; still nothing rendered, so geometry is derived from CSS and contrast from tokens). Each item is described where it lives (Layout geometry > Reader, gap 17, Composer, Inputs / Fields, Typography > Reading); this entry is the index.
   - **Geometry:** the reader is on the 50px/24px content inset and docked composers share the undocked card's margins (Layout geometry > Reader).
   - **Copy:** `Reply` replaces `Prepare reply` (R hint kept); the reply heading follows the actual To; Details says `Cc: Not cached` because the cached message has no Cc; the reader error text no longer prints field names or request IDs; the chooser's empty state is `No cached files. Sync to fetch any that are missing.`
   - **Affordances:** a Graphite composer field boundary (documented exception), a 24px caveat target, a focus ring and role on participants, `Save` with per-file names in the chooser, `Retry` for file details, alt text on the Details glyph, and the pending line is the reader's one `role="status"`.
   - **Type:** localized quote attributions, monospace only for aligned prose, the 15px reading role, grapheme-safe snippets.
   - **Kept as is:** the subject (16px, 600) over the body (15px, 400) separates by weight, position and the sender row between them; changing the size would break the Headline role and the Two-Size Rule, and nothing can be measured without a render. If a render shows the subject blending in, try tone before size.
   - **Not done:** draft integrity (blank drafts after R then Esc, resuming drafts, a Draft marker in the reader) is deferred; the blocked-reply notices and `Cancel reply preparation` keep the word "preparation"; Cc is not added to the wire format.
19. **Reader and composer, rendered follow-up.** Done (2026-11-10, measured in a browser at 1280×800, 1000×700 and a 20px root; the Gmail meta-row variant and the quote toggle on replicas). Each item is described where it lives; this entry is the index. Run notes: `.impeccable/critique/` (run 4).
   - **Focus:** Save/Saving…/Cancel keep keyboard focus in the reader list and the chooser; the focused active message toggle has a Paper White ring beside the lavender bar (Reader Message Disclosures, Layout geometry > Reader).
   - **Geometry:** the loading skeleton starts where the first message will (0.0px, was 56.4px); the docked reply keeps the message being answered in view; the contact pane never moves while a reply is open; Details values share one x; one composer padding; the undocked card is content-sized; the chooser lists are flush (Composer, Contact pane, Reader).
   - **Glyphs and names:** Reminders is a bell, Remind me is the clock; the per-message reply glyph is `Reply to latest message`.
   - **Not done:** draft integrity stays deferred; the Esc hint, signature and quote styles are unchanged.

20. **Drawer panels pass.** Done (2026-11-08, code-verified and rendered at 1280×800 in the browser preview; Activity, Drafts and Reminders were each opened and checked for a single `h2`, 36px rows and no horizontal overflow; the focus ring and J/K movement were checked in Activity, and Escape in the drafts editor in Drafts. Reminders needed a throwaway harness page because the plain preview has no reminders transport; it is not part of the repo). Cached Trash, Reminders and Drafts were part of this pass but are no longer drawers: they are list contexts (gap 21). Only Activity, Account and Provider mail remain drawers. Brand rule as in gap 17: say each fact once, and only exceptions interrupt.
   - **One heading, one region.** The drawer owns the region name and the one visible `h2` (`Activity`; Account and Provider mail keep their text). Panels are plain `div`s: no `aside`, no nested `section aria-label`, no heading that repeats the title. The long name (`Operation activity`) stays as the region's accessible name. In-panel headings are `h3` Title labels for real sub-sections only (`Bulk actions`, `Actions`).
   - **24px content edge, rhythm, no borders.** Drawer content sits on the contact pane's inset (`--contact-inset`, 24px; the 50px list inset would leave a 460px drawer 360px) with 6px and 12px gaps and no off-scale rem gaps. `rule` is gone from drawer rows, the Activity group detail (no box; members indent 12px) and the Reminders fieldset.
   - **Shared drawer row** (`.drawer-row`, see Components). Activity uses it; Reminders and Drafts used it until they became list contexts (gap 21, `Context Row`).
   - **Activity.** A row is the cached subject (Body, Paper White, ellipsis) and the action label (Title: `Mark done`, `Mark not done`, `Star`…), with the conversation id only in a title. The subject comes from a session-scoped subject index (`src/lib/subject-index.ts`, filled from list rows, Cached Trash rows and the open conversation); an unseen ref reads `Unknown conversation`, and a seen empty subject reads `(No subject)`. The trailing slot is one status word in sentence case: `Queued`, `Applying…`, `Unknown` (Amber Notice), `Failed` (Coral Fault), `Confirmed`, `Cancelled` (Ash). Colour is on the word only. The failure kind, operation id and `Cancelled by Undo` are its title. The human reason, the outcome-unknown warning ("Verify current mailbox state first…"), `Undo of op-…`, the undo decisions and the retry lineage stay inline as Body lines, only when they apply. Single operations carry no acceptance time in the DTO, so they show no date; groups do (`acceptedAt`, a full date in the toggle's trailing slot). `Conversation groups` is `Bulk actions`, `Show older groups` is `Show older`, a group reads `Mark done · 3 conversations` (`1 conversation`), its request id is a title, and `Retry with a new request ID` is `Retry` with that sentence as its title. Remaining: the subject index is lost on restart, so an operation for mail not yet listed says `Unknown conversation` until the row is seen; a durable subject or an `acceptedAt` on the operation needs a Rust DTO change.
   - **Drafts.** Built here as a one-column drawer, then moved out of the drawers: it is a list context (gap 21). Its row anatomy, the `Reply` word, the `Conflict · revision N` word and the local-only line carried over unchanged.
   - **Reminders.** Moved out of the drawers: it is a list context (gap 21). Its tabs, rows, picker, presets and `put` semantics are described there; the preset rules (`src/lib/reminder-presets.ts`) are unchanged: real RFC3339 strings with a numeric offset in the viewer's zone (Later today: now plus 3 hours rounded up to a quarter hour, withheld when that is another local day; Tomorrow: 09:00 the next day; Next week: 09:00 the next Monday). Remaining: presets use `Intl` offsets and do not model a DST gap beyond moving a nonexistent time forward.
   - **Keyboard.** One composable (`useDrawerRows`) serves the Activity drawer and `ContextRowList` (gap 21: Reminders, Drafts). A row is a focusable element marked `data-drawer-row`: ArrowDown/ArrowUp or J/K (any case) move, Home and End jump, there is no wrap, and the current row is the one Tab stop (the first row when none is). Enter and Space stay native. It ignores editable targets, IME composition, modifier keys including Shift, and any target that is not a row marker, so trailing buttons keep native Tab and Enter and stay Tab-reachable. Escape is the app's. The keys are not in the Commands palette Keys list: it describes the list, and a drawer-only line would be wrong everywhere else.
21. **List contexts pass.** Done (phase 3 of 3, 2026-11-08; code-verified, the Drafts flows rendered at 1280×800 in the plain browser preview). Direction: `.impeccable/critique/2026-11-08T13-34-14Z__list-contexts-trash-reminders-drafts.md`. A view whose rows are conversations the user triages, opens and returns to belongs in the main list pane; a log or settings surface glanced at without leaving one's place stays a drawer. Phase 1 moved Cached Trash, phase 2 Reminders and phase 3 Drafts. Entries (rail item, palette action) are unchanged; a rail item for the active context carries `aria-current="page"`, never `aria-expanded`.
   - **Cached Trash.** A browse context (`'trash'`) beside Done and Starred, served by `listCachedTrash` through the same paged, replayable, per-request-fenced list read (100 rows a page, `Load more Cached Trash`). It renders the shared `InboxList` rows (sender, subject, snippet, compact date, attachment glyph, 36px) in a read-only mode: no checkbox or selection mode, no action glyphs or disclosure, no read toggles, and Cmd/Shift-click only opens. Rows still focus (J/K, arrows) and open (Enter, click). It is not a mutation surface: `E`, `Shift+E`, `Z`, `U`, `S`, `H`, `X`, bulk selection, `R` and every palette mutation stay unavailable in the list and in its reader, and the Action notice is hidden there. `C` (compose) behaves as in Done.
   - **Header and entries.** The context h1 `Cached Trash` shows styled like an active tab (no tab is active); the list's accessible name is `Cached Trash conversations (read only)`. The rail item (`rail-trash`, title `Go to cached Trash (read only) — G then T`) and the palette action `Go to cached Trash (read only)` navigate; the previous context is pushed on the history stack, so Back and Escape return to it, and a reader opened from a Trash row returns to the Trash list at the same row and scroll anchor.
   - **One coverage line.** On the 50px inset above the rows (`data-test="reminders-coverage"`, `role="note"`, Ash): `Saved on this device. Runs while Email OS is open; overdue reminders are checked at start.`, the rest (scheduling hides the conversation from the Email OS Inbox, new incoming mail stays visible, Return and Cancel show only the original inbox messages again and mark nothing read) as its title and hidden text. A quiet `Refresh reminders` ghost sits on its trailing side (it reads `Retry exact request` while a lost ACK is pending). Loading, per-tab empty text and the error banners (`Inspect saved state`, `Retry preparation / refresh conversation`) are in-flow Body lines, as in `.recovery-banner`.
   - **Reader.** Unchanged: no Reply, no row or reader mutations, no J/K between Trash rows, and the single Ash line `Cached Trash — read only. Recovery is not available here; use your provider client.`
   - **Removed.** The Trash drawer, `CachedTrashPanel`, its separate state and the special `'trash'` reader origin. The Activity subject index keeps learning subjects from Trash rows, which are now ordinary list rows. The drawer's `Refresh` button is gone: the list follows cache changes like Done's. Remaining: an empty subject renders blank in the shared row (the drawer showed `(No subject)`).
   - **Reminders (phase 2).** A list context (`'reminders'`, offered whenever the client has a reminders transport: fixture and Gmail, `remindersSupported`) beside Done and Trash, entered from the header glyph (`Reminders (G then H)`, `aria-current="page"` and Paper White while the list is showing), `G H`, the palette and the navigator, and from `H` (`Remind me`) on an Inbox row or an open reader. There is no new rail slot and no new backend call: the rows are `client.reminders.list()` plus the live change subscription, read through `useReminders` (which holds every request rule of the old drawer: per-request staleness, exact retry of a lost ACK, the validation message for `dueAt`, the newer-message preparation error). The context is pushed on the history stack, so Back and Escape return to the prior context and row, and a reader opened from a reminder returns to the same reminder row (J/K do not walk between reminders).
   - **Header tabs.** `Pending`, `Returned` and `History` take the split-tab slot (Headline, active Paper White, inactive Smoke, 11px Ash counts of the loaded rows 4px after the label, 18px apart) after the visible `Reminders` heading, with `role="tablist"`, ArrowLeft/ArrowRight, Home and End. The selected tab survives navigation. The Inbox and saved split strip is absent while the context is active.
   - **Context rows.** Reminders are not threads, so they use `ContextRowList` (see Components, Context Row): the subject (Title, Paper White, ellipsis), the condition only when it is `regardless` (`Returns regardless of reply`, Ash), the due time as a full date or `Someday` (Ash) and one phase word in plain language (`Waiting`, `In Inbox`, `Cancelled` and `Skipped after reply` in Ash; `Hiding from Inbox`, `Returning to Inbox` and `Restoring Inbox` in Amber Notice; `Needs attention` in Coral Fault). The revision is a title. `Reschedule` (pending only) and `Cancel reminder` (the long wording, `Cancel reminder and show in Inbox` or, for a failed one, `Cancel and show original inbox messages`, is its title and `aria-label`) are quiet Ash ghosts in the row, shown on the current or hovered row and always reachable by Tab. The failed-phase explanation stays as a Coral line under its row.
   - **One coverage line.** On the 50px inset above the rows (`data-test="reminders-coverage"`, `role="note"`, Ash): `Synthetic fixture only`, the rest (this device while running, overdue work reconciles on launch, no execution while quit or on other devices, new incoming mail stays in Inbox, Return and Cancel restore only the original inbox messages and mark nothing read) as its title and hidden text. A quiet `Refresh reminders` ghost sits on its trailing side (it reads `Retry exact request` while a lost ACK is pending). Loading, per-tab empty text and the error banners (`Inspect durable state`, `Retry preparation / refresh source`) are in-flow Body lines, as in `.recovery-banner`.
   - **Picker.** `Remind me` / `Reschedule reminder` uses the shared `ReminderPicker` dialog (a modal with its own focus trap, shown above the list; suggestions, natural-language or RFC3339 time, the device-timezone note, the return condition, `Schedule reminder` / `Save new time`). The list keeps a one-line heading for the request in flow (`Remind me`, `Conversation ready`). Schedule is armed only after the picker chose a time. Escape inside the picker dismisses it: for a new reminder that ends the request, goes Back to the surface it was asked from and reopens a reader that asked; for Reschedule only the picker closes and focus returns to the row. While a request is in flight or waiting for an exact retry, Escape, Back and the backdrop keep the picker open and focused; `Inspect saved state` is the explicit way out. An acknowledged schedule returns to the Inbox with a six-second `Reminder scheduled for …` status line (`Reminder rescheduled for …` from Reschedule). The `put` payload, request id, revision and retry rules are unchanged. The earlier in-flow preset picker (`Later today`, `Tomorrow`, `Next week`, `Custom`) is gone: the merged picker replaced it.
   - **Read-only guarantees.** `E`, `Shift+E`, `Z`, `U`, `S`, `H`, `X`, `R`, selection and every palette mutation are unavailable in the list; the row actions are its only mutations. In the reader opened from a reminder the existing behaviour holds.
   - **Removed.** The Reminders drawer, `RemindersPanel`, the drawer toggle ref and the special `'reminders'` reader origin (it is now the context's own value).
   - **Drafts (phase 3).** A list context (`'drafts'`, any account) beside Done, Trash and Reminders. Entries are unchanged: the rail item (`rail-drafts`, a plain navigation item with `aria-current="page"` while the list is showing and no reader or editor covers it, never `aria-expanded`) and the palette action `Go to local Drafts`. The context h1 is `Drafts`, shown styled like an active tab; the previous context is pushed on the history stack, so Back and Escape return to it. Draft rows are not threads, so they use `ContextRowList` through `DraftsList`: the recipient (Title, Paper White; Ash `(no recipient)`) is the open button, the subject follows (Body; Ash `(no subject)`), and the trailing slot holds a quiet Ash `Reply` word for reply drafts, the `Conflict · revision N` word (Amber Notice, only on the draft in conflict) and the compact updated time with its full date as the title. The revision is a row title. One Ash coverage line sits on the 50px inset (`data-test="drafts-coverage"`, `role="note"`): `Local to this device · never sent`, the sentence in its title and hidden text, with a quiet `New draft` ghost on its trailing side that does what `C` and the header compose glyph do. Empty text: `No local drafts.` Every recovery and error line (suspended editor of another account, close error, close-protection setup and retry, list error, subscription error and retry, open error) is in flow above the rows with unchanged wording and hooks; an open error never hides the rows. While an editor covers the list, the app shows the list and subscription lines in the list notices and the close-protection banner as before.
   - **Opening a draft.** The owner's rule: opening a draft goes to where its mail is. A reply draft opens its source conversation (the reader, with the Drafts list as its origin, so no J/K between threads and Back or Escape return to the same row) and then activates the draft, so the existing reply composer docks in that reader; a new-message draft opens in the inline compose card, which replaces the list. Closing an editor (Save and close, Escape) runs the protected flush; the list or the reader is back and focus returns to the draft row, or the reader's active message. A second open, Back or an account change while the source loads cancels the sequence, so a composer is never docked on the wrong conversation. Opening while another editor is active flushes it first, and a failed flush keeps that editor open with its error and navigates nowhere.
   - **Fallback: never unopenable.** If the source cannot be shown or cannot host the reply (not found or load error, retained snapshot, incomplete context, header mismatch, another account), the same draft opens in the inline card of the Drafts context, titled as the reply (`Reply draft to ada@example.test`, the name only while the thread is open) with one Amber Notice line: `Source conversation unavailable. Editing locally; nothing is sent.` The specific reason is its title. The editor is unchanged (`DraftEditorCore`), no content is dropped and nothing implies the reply is blocked from being edited. The same card takes over when the reader moves off the source of a docked reply, or when the reader closes.
   - **Editor surfaces and the invariant.** One editor, one visible surface: the docked reply composer, or the inline card (central pane, or docked under a reader). There is no drafts drawer. An active editor always has a surface: if its surface goes away (the other account returns, the reader closes), the card takes it, dismissing a drawer or the narrow Contact disclosure that would cover it. Leaving an editor surface (another context, a drawer, the reader, search, the Contact disclosure, an account change, a window close) goes through the protected flush; a failed flush keeps the editor visible with its error. A suspended editor of another account has no surface; its alert is in the Drafts list.
   - **Keys.** The list uses the Context Row model (J/K, arrows, Home, End; `G` chords and Left still work from a row). Mailbox shortcuts (`E`, `Z`, `U`, `S`, `H`, `X`, `R`, selection) are inert in the list. `C` and the header glyph open a new-message card from it.
   - **Removed.** The drafts drawer, `DraftsPanel` (its list/editor swap, `Back to drafts`, the drawer re-dock watchers), the `Open drafts` attention button (the editor surface always shows its own error, so the button had no state left to serve) and the `.drawer-sender`, `.drawer-flag`, `.drawer-toolbar` rules. `ReplyComposer` and `DraftEditorCore` are unchanged.
   - **Critique follow-up (2026-11-08, score 27/40: `.impeccable/critique/2026-11-08T17-47-19Z__src-components-contextrowlist-vue.md`; code-verified, rendered at 1280×800 in the browser preview and a throwaway harness).**
     - **Header.** Cached Trash and Drafts show the context h1 alone; the `Inbox N` split tab (with a count that meant nothing there) is hidden, as in Reminders. The way back is Back, Escape and the rail Inbox entry. Inbox, Saved, Done, Starred and Search keep the split nav. A new list context must be added to `inboxSplitsShown` in `App.vue`.
     - **Reminders: Needs attention.** The `Pending` tab count counts only phase `pending` rows. Rows in the Pending bucket in any other phase (`failed`, `removing`, `returning`, `cancelling`) list first under one Ash caption `Needs attention N` (`ContextRowList` `groupCaption`: a non-actionable `presentation` item, 12px Ash, 50px inset, 36px block, no rule), then the pending rows. Tab membership is unchanged; the caption owns the count of the rows that are not calm. The failed note is `A mailbox change failed or newer triage superseded it; which one is not recorded. Cancel does not override newer triage.` The DTO has only `phase`, so the cause is unknowable and is not guessed. There is no Retry: the exact-request retry replays a lost request held in memory, and a failed reminder has none; a re-put would be new backend behaviour. A failed reminder offers Cancel only.
     - **Drafts: triage.** Each row has a quiet Ash one-line preview of the body after the subject (`getDraft`, once per revision, whitespace collapsed, 240 characters, a text node only; `No text yet` when empty; nothing when the read fails). The Amber fallback notice states its reason as visible text, built by `replyNoticeLine` in `src/lib/reply-context.ts`, followed by `Editing locally; nothing is sent.` Three navigation states read as facts about the source: `Source conversation not open.`, `Source conversation still loading.` and `Source conversation belongs to another account.` Every other reason reads `Source conversation unavailable: <reason>.` (no latest message, retained snapshot, incomplete cached conversation, reply headers do not match the latest message, could not be loaded: <word>). The full sentence stays in the title. `Discard` is a row action (quiet Ash ghost, shown on the current, hovered or focused row, always Tab-reachable, reserved width so it sits in one column) that opens an in-flow confirmation with the editor's wording (`Discard this local draft? This cannot be undone.`, `Confirm discard`, `Keep draft`); it is disabled for a draft open in the editor; success announces `Local draft deleted` and moves focus to the next row, else the previous, else the pane; a retryable failure keeps the confirmation open and retries the same request id; a definite failure (conflict, not found) closes it and keeps the draft with a visible alert. It uses `drafts.discardListed` (the same revision-checked `DeleteDraft` call; the editor's discard works on the open buffer and could not serve a row).
     - **Keys.** `G T` (Trash, navigation only, only when its rail item exists) and `G D` (Drafts), listed in the g-hint line and the palette. In Reminders `[` and `]` switch tabs from the list (wrapping, focus to the first row of the new tab, a polite status line such as `Returned, 1 reminder`; the tablist arrows are unchanged). `H` opens Reschedule on a pending row and `Shift+H` cancels the focused reminder (immediate, as the button is; focus then moves to the next row). In Drafts `Delete` or `Backspace` opens the Discard confirmation only. Row keys fire only when the row's own button has focus, never in editable targets, during IME composition, with Ctrl, Meta or Alt, on auto-repeat, or from the picker or confirmation; rows that do not support the action ignore them. Buttons carry `aria-keyshortcuts` and a title suffix. Trash gains no mutating key.
     - **Adversarial review follow-up (2026-11-08; GPT-6.1-Sol, Opus 5.5, Mistral Large 4).**
       - **Open flow.** A draft opened and then abandoned (Back or other navigation while `getDraft` is pending) never installs the editor: `useDrafts.openDraft(ref, stillWanted)` rechecks after the read.
       - **Discard.** The confirmation is frozen to the draft, revision and request id it opened for; a refresh to a newer revision is rejected by the revision check and says it changed. The confirm and keep buttons stay focusable (`aria-disabled`) while a request runs, focus is restored after every result (confirm button after a retryable failure so Esc closes the confirmation, Discard after a definite failure), and the `Local draft deleted` status is visually hidden so rows do not shift.
       - **Rows.** A Drafts row is described to assistive technology by its subject, preview, Conflict and Reply words (`aria-describedby`, set by `DraftsList` after render because `ContextRowList` has no description slot). A preview read for an older revision can no longer replace the current one.
       - **Notice copy.** `Source conversation not open.`, `... still loading.` and `... belongs to another account.` for the navigation reasons; `Source conversation unavailable: <reason>.` stays for real failures (`replyNoticeLine`).
       - **Reminders.** The Pending tab shows `· N needs attention` only when N is above 0. The `[`/`]` status never says `no reminders` while attention rows exist (`Pending, 1 needs attention`). When Pending has both groups, a second Ash caption `Pending N` precedes the first calm row so Needs attention has a visible end. Row test ids are per conversation.
       - **Keys and Trash.** The `G T`/`G D`/`G E`/`G H` titles and palette no longer state a timing (the window is 1.5 seconds plus a 600 ms grace). Cached Trash ignores the Inbox Unread only filter: the chip and the palette command are hidden there, and return in Inbox, Saved and Done.
     - **Second adversarial review follow-up (2026-11-09; GPT-6.1-Sol, Opus 5.5, Fable 5.2).**
       - **Open flow.** Opening a drawer such as Activity cancels any pending draft open (`openDrawer` calls `cancelDraftOpen()` first), and a reply that docks closes an open drawer.
       - **Open vs Discard.** A draft cannot be opened and discarded at the same time. `useDrafts` claims a draft while it opens or while its list delete runs (`openingRefs`, `discardingRefs`). A row being opened has Discard disabled (title `This draft is being opened`, Delete ignored); a row whose delete is running keeps its open button focusable but `aria-disabled`, and `openDraft` refuses it without reading.
       - **Discard copy.** One table in `draft-errors.ts` maps every `MailError` kind to definite or retryable and its words, so a new kind cannot compile unclassified. `Retry is safe.` appears only for retryable failures; `busy` says why (open in an editor, being opened, editor switching, window closing). The button title reads `Discard this local draft — Delete or Backspace`.
       - **Reminders to assistive technology.** `ContextRowList` takes an optional `describedBy`; each Reminders row button is described by its phase word, due time (or `Someday`), `Returns regardless of reply` and the failed note. A hidden polite status line announces the result of Cancel reminder (`Reminder cancelled`, `Cancelling reminder`, `Could not cancel reminder`) and Reschedule (`Reminder rescheduled`, `Could not reschedule reminder`) only after the action resolves. A new reminder announces nothing.
       - **Before the first read.** Until the first successful list read, the Reminders tabs show only their names (no counts, no `· N needs attention`), `[` and `]` announce only the tab name, and the empty line is not shown beside `Could not load local reminders`. The list region is named `Reminders`.
       - **Compose fallback notice.** The notice has an id; the card and its To field are described by it, so it is read when focus lands in To (`DraftEditorCore` `toDescribedBy`).
       - **Local contexts.** Entering Drafts or Reminders no longer leaves a rejected Inbox read unhandled.
     - **Not done.** Esc asymmetry (a reply draft needs two Escapes, a new-message card one), focus falling to the body after closing a compose card from Inbox, the dead contact pane beside Reminders and Drafts, silent inert keys in Trash, 24px action targets. `[` and `]` need AltGr on some layouts. Tab still moves between buttons in Reminders while it switches splits in Inbox.

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
- **Graphite** (`icon-muted`): every resting glyph (row actions, compose, search, hamburger, footer icons, attachment). Hover and focus raise glyphs to Paper White. Graphite is 2.75:1 on Focus Stone and 3.79:1 on Lifted Charcoal, so it never carries meaningful text, or a glyph that must be read, on a focus fill or the composer fill; Ash does that job there. One narrow exception: the 1px boundary of a composer field (see "Inputs / Fields"). That is a non-text indicator with a 3:1 floor, not text, and Graphite clears it.
- **Seam** (`divider`): the 1px vertical separators between rail, list and contact pane, and the drawer's leading edge; also the 1px border of utility chips, fields and floating panels. Never between rows.
- **Rule** (`rule`): a quieter 1px structure line inside a pane, used only in the reader, the composer and the Account panel. Never in the list and never between drawer rows.

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

**Character:** One local system sans in two weights carries the whole UI. Hierarchy comes from weight (600 vs 400) and tone (Paper White vs Ash), not size. The browsing shell uses just two sizes. Message bodies in the reader are the one deliberate third size (Reading, below).

### Hierarchy
- **Headline** (400, 1rem / 16px, 1.25): split tabs and the contact name. This is the only large text in the shell.
- **Title** (600, 0.75rem / 12px, 1.35): sender names, contact email, section labels ("Mail"), footer labels, notice labels.
- **Body** (400, 0.75rem / 12px, 1.35): subject (Paper White), snippet and threads (Ash), date-group captions (Ash).
- **Label** (400, 0.75rem / 12px, tabular numerals): dates ("8:00 AM", "6 NOV" with an uppercase month) and counts in status text.
- **Reading** (400, 0.9375rem / 15px, 1.6): the message body, the signature and the quoted text in the reader, and nothing else. Tokens: `--type-reading` and `--leading-reading`. The measure is `65ch` for the proportional face. The 1.6 leading is the light-on-dark compensation: light text on Warm Charcoal needs more leading than the 1.35 of the 12px shell, and a measure this wide needs it too. The prose is Paper White; the signature and the quote are Ash. This is a deliberate third size outside the Two-Size Rule, which covers the browsing shell. **Mono fallback** (0.85rem, 1.45, `--type-mono`, `--leading-mono`; the Mono entry in the frontmatter): a body whose prose looks column-aligned (two consecutive lines indented by 4 spaces or a tab, or two or more lines with two or more pipes) keeps the monospace face at `88ch`, because hard-wrapped plain text is 72 to 78 columns. Quoted `>` lines do not trigger it. Neither measure has been checked against a render.
- **Mono** and the other steps are CSS tokens: `--type-headline`, `--type-body`, `--type-count`, `--type-reading`, `--type-mono`, `--leading-reading`, `--leading-mono`, `--weight-regular`, `--weight-strong` (`src/assets/style.css`). Use the tokens, never a literal size.

### Dates
Row and reader dates are one fixed product format, not a locale format. They depend only on the instant, the current time and the viewer's time zone (`src/lib/browsing-dates.ts`). Month group captions ("October 2026") still follow the locale.
- **Row, today:** the time, 12-hour, no leading zero: "8:00 AM", "12:05 PM".
- **Row, earlier this calendar year:** day and month: "6 NOV". The DOM text is "6 Nov"; CSS uppercases it, so screen readers hear a word, not letters.
- **Row, any other year (past or future):** day, month and four-digit year: "9 JAN 2025". The day is kept for precision, and a two-digit year would read as another day.
- **Unknown or unparsable:** "Unknown" in the row, "Unknown date" in full form. Never blank.
- **Full form** (reader message times, the row date's hover title): "Thu 9 Jan 2025, 6:29 PM". The same 12-hour clock as the row.
- Every rendered date is a `<time>` with a normalized ISO `datetime` when the timestamp parses.
- **Count** (400, 0.6875rem / 11px): split-tab counts, set 4px after the tab label.
- **Mono** (400, 0.85rem, 1.45): the reader's plain-text body when its prose is column-aligned (the fallback described under Reading).

Sizes are rem so the 16px and 20px root-font layouts in `tests/browsing/inbox-list.rendered-layout.test.ts` still scale. Row and header heights are min-heights in px. The 12px row size is measured from the capture: system-ui glyph metrics point to 11.5–12px.

### Named Rules
**The Two-Size Rule.** The browsing shell uses 16px and 12px only (11px for counts). A third size in the list needs a written reason. The one written exception is the reader's message text: `--type-reading` (15px) for the body, signature and quoted text, never for chrome, rows or the list.

**The No-Caps-Caption Rule.** No uppercase letter-spaced captions in the browsing shell. Date groups and pane headings are title case. Uppercase is allowed only for the month in compact dates.

## 4. Elevation

The browsing shell is flat. Depth comes from tonal layering: Warm Charcoal for the plane, Deep Umber for context, Focus Stone for the current row, Inkwell for the rail well. No shadows sit on rows, panes, the header or the rail. Shadows appear only on surfaces that truly float above the shell and cover it.

### Shadow Vocabulary
- **Drawer cast** (`box-shadow: -8px 0 24px rgba(0, 0, 0, 0.35)`): the right-edge utility drawer (Activity, Account, Provider mail).
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
- **Read-only (Cached Trash):** the same row with no checkbox, no action glyphs or disclosure and no selection mode; the row still focuses and opens, and the read marker, attachment glyph and date stay.

### Date Group Caption
- **Style:** Body, Ash, title case ("Yesterday"), on the 50px content inset, in a 48px block. No rule and no background band. Not focusable.
- **Leading Today:** visually hidden (kept for assistive technology), so a list that opens with today's mail starts on the first list line. Every other leading caption stays visible.

### Split Tabs (Navigation)
- **Style:** Headline type. The active tab is Paper White; inactive tabs are Smoke. The count (11px, Ash) follows 4px after the label and disappears at zero. Tabs are spaced 18px apart.
- **Header:** 78px tall, no bottom border. The hamburger is a Graphite glyph to the left of the inset; compose and search are Graphite glyphs on the right, at the row-action pitch.
- **Trash and Drafts:** the strip holds the context h1 alone; the Inbox tab is hidden there (gap 21).
- **Reminders:** while that context is active the strip holds the list's sections (`Pending`, `Returned`, `History`) as `role="tab"` buttons in the same style, after the visible context heading (gap 21).

### Rail
- **Style:** 40px wide on Warm Charcoal, with a 1px Seam on its right. The top action, Inbox, is a 28px Rail Pebble circle centered on the tab line. The other destination glyphs sit in a 30px Inkwell pill at a 28px pitch, with the first glyph on the first list line. Utilities (Account, Activity, Drafts, and Contact below 1000px) are ghost glyphs at the bottom. The active destination glyph is Paper White on a 24px Rail Pebble disc; the rest are Graphite.
- **Labels:** icon-only on screen. Every button keeps its text label as its accessible name, a `title`, and a keyboard tooltip on `:focus-visible`.
- **Activity badge:** an Amber Notice count of unresolved operations (pending plus outcome unknown), named in words by the button's description and title.

### Contact Pane
- **Style:** 272px on Deep Umber, with a 1px Seam on its left and a 24px inset. No visible caption heading (it stays for assistive tech).
- **Content:** the name in Headline on the tab line; the email in Title on the first list line; copy glyphs in each line's trailing slot, revealed on hover or focus; a section label (Title with a 16px glyph) followed by recent threads (Body, Ash, ellipsis, 24px pitch); exact known data only, never invented enrichment.
- **Footer:** none. Superhuman's footer toolbar has no counterpart with real actions here; the utilities live in the rail (Parity gap 9).

### Context Row
The Conversation Row for list contexts whose rows are not threads (`ContextRowList`: Reminders, Drafts). Same geometry and the same One Signal: a 36px row on 12px type, inset 6px from both pane edges, a 44px gutter, the text on the 50px inset, no borders, the current row Focus Stone with the 4px Dusk Lavender bar and `aria-current`.
- **Slots:** a gutter (`lead`), one real open button (`primary`, with a visually hidden `Open`), an Ash `secondary` line, quiet Ash ghost `actions` (24px, shown on the current, hovered or focus-within row, always Tab-reachable), a `trailing` slot about 25px from the pane edge (a full date, a status word; Amber Notice, Coral Fault or Ash on the word alone) and an optional `note` line under the row for an exception.
- **Keys:** roving tabindex with ArrowUp/ArrowDown, J/K, Home and End through `useDrawerRows`; Enter and Space are native, and editable targets, IME, modified keys and the action buttons are never taken. Clicking the row outside its controls opens it.
- **Focus:** the row's fill and bar are its focus indicator, so the open button draws no extra ring.

### Drawer Row
The one row anatomy of the utility drawers (Activity). Rows are separated by rhythm alone.
- **Shape:** a 36px row on 12px type. The text sits on the drawer's 24px content edge; the Focus Stone hover and focus fill reaches 6px past it with a 4px radius. No border and no Dusk Lavender bar: the lavender stays on the list's current row, and a focused drawer row shows the standard 2px focus ring.
- **Layout:** one real button for the primary action (subject, sender or recipient; `Open` for a conversation), then a trailing slot with quiet Ash ghost buttons, one status word or a date. Dates are `<time>`: full for Activity groups (the compact date with a full-date title lives in the Context Row for Drafts). Colour sits on a status word only (Amber Notice, Coral Fault, Ash).
- **Lines under a row:** Body, Ash, for facts that only sometimes apply; Amber Notice or Coral Fault for an exception. Opaque ids and revisions live in titles.
- **Keys:** roving tabindex with ArrowUp/ArrowDown and J/K (see gap 20).

### Buttons
- **Ghost (browsing shell, the default):** transparent, Paper White text or a Graphite glyph, 4px radius, `4px 8px` (24px tall). Text ghosts in the dock bars (selection actions, Undo, Load more) carry the Title weight. Hover lifts a text ghost to Lifted Charcoal and a glyph to Paper White; press is Focus Stone; disabled is 0.45 opacity. The focus ring is a 2px Dusk Lavender outline at a 1px offset.
- **Utility (drawers, the attachment chooser, recovery banners):** a Lifted Charcoal fill with a 1px Seam border, 4px radius, `3px 8px` (24px tall); hover is Focus Stone. This is the only bordered button.
- **Specificity:** the defaults are `:where()` rules, so a component class (split tab, rail item, row action, contact line) always wins without `!important`.

### Command Overlay
- **Style:** a Lifted Charcoal panel, 10px radius, 576px max width, no border, Overlay lift, 15vh from the top. There is no caption: the placeholder and the dialog's accessible name say whether it is Commands or Destinations. The 38px query (16px Headline) sits on Deep Umber with a 1px Dusk Lavender border; it always owns keyboard focus, so that border is its focus indicator. Items are 36px rows of 12px Body with a 16px Graphite glyph that turns Paper White when highlighted. The highlighted item gets a Focus Stone fill plus a 3px Dusk Lavender left bar. Disabled items are Smoke, with their reason in Ash. Shortcuts are `kbd` in Ash on Deep Umber, compact ("G then E"). The hint line sits under a 1px Seam.
- **Groups (palette only):** Conversation, Selection, View, Go to, each a sentence-case 11px Ash label, no rule, no caps. The Destinations navigator is one group and stays unlabelled. Items are searched by label, aliases (undo → revert, archive → done, snooze → remind) and their exact bound key; the empty state says what did not match ("No command matches “…”.").
- **Glyphs:** `CommandGlyph.vue` reuses RowGlyph, HeaderGlyph and PaneGlyph where the idea already has a glyph, and draws the few palette-only ones (open, undo, selection, splits, filter, switch account) on the same 16px grid.
- **Keys:** a quiet list under the commands for bound keys that are not commands (J/K, X, Shift+J/K, Left). They are text rows, never options: no highlight, no pointer, never executed. Filtered by the same query.

### Composer (reply and new message)
- **Thread above the card:** the card shrinks the thread scroller, so the reader scrolls the message being answered (the latest) fully into view when a reply opens and keeps it there as the card grows (Cc / Subject), by scrolling only; focus never moves. It stops following as soon as the user scrolls (wheel, touch, click) or moves through the thread with J/K or the arrows. A latest message taller than the strip is aligned by its top. Measured (fixture, latest message 166px): the thread strip was 301px with Cc / Subject closed and 241px open at 1280×800, and the latest message showed 162.5px then 102.5px of its 166px (hidden behind the card); now 166px of 166px in both states (scrollTop 9.5 and 69.5), at 1000×700 (strip 201 and 191px) too, and at a 20px root (strip 225.6px, message 207.3px fully visible). The 60% cap is kept and no extra minimum was needed: it leaves at least 40% of the pane.
- **Shell:** Lifted Charcoal with a 1px Seam border, docked at the bottom of the reader pane (6px radius, capped at 60% of the pane) or, for a new message with no reader, the in-flow card (10px radius). Both use the margins `6px 24px 12px 50px`, so the card's left edge is on the 50px content inset in either place. Never a modal. A reply draft that cannot dock in its thread uses the same card, titled `Reply draft to …`, with one Amber Notice line under the heading (gap 21). Both share one inner padding, `--composer-padding` (`12px 16px 16px`); the reply composer used `0.4rem 0.6rem` (about 6/10px) before, and now measures `12px 16px 16px` like the card. The undocked new-message card is sized to its content (`flex: 0 1 auto`, still scrolling when the editor is taller than the column): 284.2px tall at 1280×800 (331px at a 20px root) instead of the 612.6px it filled with the footer at y=382 and about 345px of empty card below it.
- **Heading line:** the title on the left (Title weight, `Reply draft to Ada Fixture`, built from the actual To as described under the compact reply composer, or `New Message`) and the one status line on the right (Body, Ash when settled, Amber Notice otherwise) with its small info button (a 24px hit area around the 14px glyph, drawn with padding and an equal negative margin so the heading row does not grow); the caveat line opens under the heading.
- **Rows:** a 3.5rem Ash label column, then an input with a Graphite underline at rest (the full Graphite border on hover; Dusk Lavender plus the inner ring on keyboard focus); the reply shows only `To  <name> <address>` as a button until the user asks for more. Body: at least six lines, grows, with the same Graphite boundary as the rows.
- **Footer:** primary `Save and close` (Focus Stone, Title weight) with an Ash `Esc` hint, quiet Ash `Discard…`. The only buttons besides the confirm dialogs and retry actions. No Send.

### Reader Message Disclosures
- **Status line:** one Ash line under the subject for the read state (plus `Read-only`); standing guarantees live in its title and hidden text. Exceptions stay as Amber Notice lines.
- **Details:** a native `<details>`/`<summary>`, so the expanded state is exposed without ARIA. The `▸`/`▾` glyph is generated content in Ash with an empty alt (`content: '▸ ' / ''`, after the plain declaration as a fallback), so assistive technology reads `Details` only. Inside, From, To, `Cc` and Sent, in two columns: a fixed 3rem Ash label column, then the values, which therefore share one x (measured at 1280×800: 144.4px for all four, with `Details` at 90px; before, the labels sized to their text and the values started at 126.1, 109, 111.4 and 123.7; at a 20px root all four are at 158px and no label overflows). From and each To recipient are `role="group"` tab stops (they drive the contact pane; closed Details content is not focusable) with one accessible name, `Name, mailbox` or the bare mailbox, and the visible `Name <mailbox>` text is `aria-hidden` so the address is read once. Their keyboard focus is a 2px Dusk Lavender outline at a 1px offset, not a colour change alone. The cached message has no Cc, so the Cc row reads `Not cached` (Ash plain text, with a title that says Cc is not stored in the local cache and reply recipients are not inferred from it); Cc is never inferred or shown as empty.
- **Quote and signature:** Ash reading-face blocks after the prose; the quote is behind a ghost toggle. **Attachments:** a plain list of 24px lines under the body, ghost `Save` per file (accessible name `Save <file name>`, the same in the Cmd+O chooser). When the file details cannot load, the note `Could not load file details.` has a ghost `Retry` (`Retry loading file details`). While it waits it stays mounted and `aria-disabled` as `Retrying…`, and on success focus moves to the attachments group, so it never falls to the page.

### Inputs / Fields
- **Style:** a Lifted Charcoal fill, a 1px Seam border, 4px radius, inherited font.
- **Focus:** the border shifts to Dusk Lavender, doubled by a 1px inner outline so the ring reads at 12px. No glow.
- **Placeholder:** Smoke (4.76:1 on Lifted Charcoal).
- **Composer field boundary (exception):** the To, Cc and Subject rows have a transparent border and a Graphite underline at rest, and the body textarea has a Graphite border, because the Seam border is only 1.36:1 on Lifted Charcoal and is otherwise the sole cue that an empty field is an input. Graphite is banned for text and meaningful glyphs on the composer fill (text needs 4.5:1; Lifted Charcoal gives 3.79:1). A 1px field boundary is a non-text indicator with a 3:1 floor, which 3.79:1 clears (4.87:1 on Deep Umber, the drafts drawer editor). It applies to composer field boundaries only; every other field keeps its Seam border. The ratios are computed from the tokens, not sampled.

### In-flow Notices (Action notice, Selection bar, coverage and recovery)
- **Style:** borderless lines in normal flow, with text on the 50px content inset, in Body type with 6px block padding. Status words use Amber Notice or Coral Fault. Undo shows its `kbd` hint in Ash. They never overlay rows and never auto-hide a failure.
- **Bottom dock (transient lines):** the Selection bar, the Action notice and the command-error alert sit in a dock at the bottom of the list column, below the list, never above it. Showing or hiding them never moves a row. The dock reserves one 36px line and grows upward into the list viewport; the focused row is kept whole when the viewport shrinks. Its lines are whole-pixel (16px line height, 24px buttons). This is the honest, in-flow form of Superhuman's bottom undo toast: no float, no shadow, nothing covered.
- **Above the list (static lines):** Starred, Done, Cached Trash and Reminders coverage notes and the draft-close recovery banner, which belong to the destination or to a pending recovery rather than to the last keystroke.

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
- **Don't** use Graphite for text or meaningful glyphs on Focus Stone or on the composer's Lifted Charcoal fill. Use Ash. The only exception is the 1px boundary of a composer field, which is not text (see "Inputs / Fields").
- **Don't** repeat a standing guarantee as a paragraph on every open. State it once, in a status line with the detail in its title; only exceptions interrupt.
- **Don't** print opaque provider IDs as row text. Use the cached subject and put the id in a title; a ref that was never seen says `Unknown conversation`.
- **Don't** introduce a third type size in the list, or use off-palette hex values (the old command-overlay violets are the cautionary example).
- **Don't** load remote fonts, images or CDN assets.
