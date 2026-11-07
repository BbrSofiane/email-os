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
    width: "28px"
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
    typography: "{typography.title}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  button-utility:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  command-overlay:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    width: "576px"
  command-item-highlighted:
    backgroundColor: "{colors.focus-fill}"
    textColor: "{colors.text-primary}"
---

# Design System: Email OS

## 1. Overview

**Creative North Star: "The Quiet Instrument"**

A precision tool used in long, focused sessions. The surface is a single warm charcoal plane. The interface recedes until only the list, the open conversation and the next decision are on screen. Density is high but calm: 36px rows, small type, no dividers, no cards. One violet signal marks where you are. Everything else is a tonal step on the same warm gray ramp.

The system follows Superhuman's browsing look closely, and that parity is an explicit goal. It covers geometry, density, type scale, tonal layering and the focused-row treatment. Features and workflows stay our own. The one place we deliberately go our own way is state: pending, failed, partial and outcome-unknown states are always visible in their own form (*"Honest state over smooth feel"*, PRODUCT.md). A quiet surface must never hide what happened.

The system rejects Gmail-web clutter, "AI magic" sparkle chrome, generic SaaS dashboards (card grids, gradient heroes, oversized rounded panels), and optimistic UI that says "Done" before the provider confirms.

**Key Characteristics:**
- Three fixed panes: a 40px icon rail, a fluid list or reader, and a 272px darker contact pane. Each is separated by a single 1px divider.
- One content inset (50px from the list pane's left edge). It aligns split tabs, sender names, date-group captions and banners.
- 36px rows on 12px type. Hierarchy comes from weight and tone, not size.
- Pane-edge alignment: the contact name sits on the split-tab line, and the contact email sits on the first-row line.
- Flat tonal layering. No shadows in the browsing shell.
- The violet accent appears once per screen: on the focused row or the active message.

**Layout geometry (approximate calibration targets).** These values come from the 2026-11-07 Superhuman reference capture (1603×2000 image px). The capture was scaled by about 1.56 image px per CSS px, calibrated from the macOS traffic-light pitch of 20pt and cross-checked against the 36px rhythm and the 40px and 270px pane widths in `superhuman-email-browsing-ux-spec.md`. Verify them on real displays.
- **Rail:** 40px wide. The top action button (28px circle) sits on the split-tab line. The navigation icons sit in a 28px-wide dark pill below it, at a 28px pitch.
- **Split header:** 78px from the content top to the first row. Tabs are vertically centered about 42px down. The hamburger is centered 23px into the pane. Tabs start at the 50px content inset with an 18px gap; the count sits 4px after its label. Compose and search icons are right-aligned on the 32px action pitch.
- **Rows:** 36px. The highlight is inset 6px from both pane edges. There is a 44px left gutter, with the 5px unread dot centered about 34px into the row. The sender column is 132px, and subject→snippet→meta gaps are 12px. The trailing date sits about 25px from the pane edge. On focus, three 16px action glyphs replace the date at a 32px pitch.
- **Date groups:** a 48px block, with the caption vertically centered on the content inset.
- **Contact pane:** 272px with a 24px inner inset. The footer toolbar sits 24px from the bottom: a ghost label plus 16px glyphs at a 28px pitch.

### Parity Gaps (current code → target)

This is the backlog for layout, typeset and polish passes. Each gap names what ships today and what this spec requires.

1. **Split header.** Today: an "Email" brand, an "Inbox"/"Cached Done" h1, "Commands" and "Destinations" text buttons, a wrapping status line, and a bottom border. Target: a hamburger, split tabs with counts (the existing Inbox and Cached Done contexts are rendered as tabs until a split model exists), compose and search glyphs, 78px tall, no border. The status-line facts (pending count, command error, selection count) must move to an equally visible home. They cannot be dropped.
2. **Rail.** Today: a 5rem column of bordered text buttons (Inbox, Cached Done, Account, Activity, Drafts, Contact). Target: a 40px icon rail with a dark well group and 28px circular buttons. Labels move to `aria-label`/`title`. The repo has no icon set, so local inline SVG glyphs are needed (no CDN).
3. **Row metrics.** Today: inherited 16px text, `0.3rem 0.6rem` padding, `min-height: 36px`, a `border-bottom` divider on every row, sender `flex: 0 1 160px`, preview at 0.8rem. Target: 12px text throughout, a fixed 36px height, no dividers, 6px pane inset, 44px left gutter, 132px sender column, 12px gaps.
4. **Focused row.** Today: a full-bleed fill with a 3px inset bar. Target: a fill inset 6px from both pane edges and a 4px bar on the highlight's own left edge.
5. **Read state.** Today: a textual read-state label in the meta region. Target: a 5px `unread-marker` dot in the left gutter. Read state stays exact; when it is unknown, use a distinct hollow-dot treatment, never silence.
6. **Selection checkbox.** Today: always visible at the row start. Target: hidden until selection mode is active or the row is hovered or focused, and placed in the 44px gutter. While visible, the selected row keeps a non-color marker.
7. **Row actions.** Today: bordered text chips ("Mark read", "Archive", "More") that are always in the meta region. Target: icon-only `icon-muted` glyphs that replace the date on the focused or hovered row. Accessible names and the `meta-compact` overflow disclosure logic stay.
8. **Date-group caption.** Today: uppercase 0.72rem with letter-spacing and a bottom rule. Target: title case, 12px `text-secondary`, a 48px block, no rule, on the content inset.
9. **Contact pane.** Today: an uppercase "Focused conversation" caption, a 0.6rem pad, a semibold name, and a `minmax(230px, 280px)` width. Target: no caption; name in the 16px regular headline on the tab line; email in 12px semibold on the first-row line; a "Mail" section listing recent threads at a 24px pitch (this needs data the pane does not receive yet); a footer toolbar (a natural new home for Account, Activity and Drafts); 272px wide.
10. **Palette deltas.** `text-primary` changes from #ece9e2 to #ffffff, `text-secondary` from #a8a29a to #c0bcb6, and `divider` from #3b3936 to #474543 (pane separators only). New tokens: `text-tertiary`, `icon-muted`, `rail-well`, `rail-button`, `unread-marker`. `focus-accent` stays at the committed #bba5ed; the capture reads about #bfa1f6, which is within capture and color-profile noise.
11. **Global button style.** Today: every `<button>` is a raised bordered chip. Target: ghost buttons and glyphs in the browsing shell. Raised `button-utility` chips appear only inside utility drawers and recovery banners.
12. **Command overlay.** Today: hard-coded off-palette violets (#24212a, #17151d, #493d60, #c7a7ff, #81718f). Target: map them to `surface-raised`, `surface-contact`, `focus-fill` and `focus-accent`.
13. **In-flow bars.** The Selection bar, Action notice, cached-coverage note and draft-recovery banner use bordered full-width strips with mixed paddings. Target: borderless, 12px, aligned to the content inset, and still in flow and always visible.
14. **Typeface.** Superhuman ships a proprietary face. We stay on local `system-ui` (no remote fonts), so glyph widths will differ slightly. Calibrate sizes by eye on device, not by matching the font.
15. **Out of scope for this capture.** The native title strip (Tauri window chrome) and the reader view are not shown. The reader keeps its current tokens until a reader reference is captured.

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
- **Seam** (`divider`): the 1px vertical separators between rail, list and contact pane. Nothing else.

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
- **Overlay lift** (`box-shadow: 0 16px 64px rgba(0, 0, 0, 0.53)`): the command palette and navigator, over a `#00000088` backdrop.

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

### Split Tabs (Navigation)
- **Style:** Headline type. The active tab is Paper White; inactive tabs are Smoke. The count (11px, Ash) follows 4px after the label and disappears at zero. Tabs are spaced 18px apart.
- **Header:** 78px tall, no bottom border. The hamburger is a Graphite glyph to the left of the inset; compose and search are Graphite glyphs on the right, at the row-action pitch.

### Rail
- **Style:** 40px wide on Warm Charcoal, with a 1px Seam on its right. The top action is a 28px Rail Pebble circle aligned to the tab line. The destination glyphs sit in a 28px Inkwell pill at a 28px pitch. The active destination glyph is Paper White and the rest are Graphite.
- **Labels:** icon-only on screen. Every button keeps its accessible name and `title`.

### Contact Pane
- **Style:** 272px on Deep Umber, with a 1px Seam on its left and a 24px inset. No caption heading.
- **Content:** the name in Headline on the tab line; the email in Title on the first-row line; a "Mail" section label (Title with a 16px glyph) followed by recent threads (Body, Ash, ellipsis, 24px pitch); exact known data only, never invented enrichment.
- **Footer:** pinned 24px from the bottom. A ghost Title label plus Graphite glyphs at a 28px pitch hold the utilities.

### Buttons
- **Ghost (browsing shell):** transparent, Paper White Title text or a Graphite glyph, 4px radius, `2px 8px`. On hover or focus, the glyph rises to Paper White; the focus ring is a 2px Dusk Lavender outline at a 1px offset.
- **Utility (drawers, recovery banners):** a Lifted Charcoal fill with a 1px Seam border, 4px radius, `2px 8px`. This is the only bordered button.

### Command Overlay
- **Style:** a Lifted Charcoal panel, 10px radius, 576px max width, Overlay lift, 15vh from the top. The input sits on Deep Umber with a 1px Dusk Lavender border. The highlighted item gets a Focus Stone fill plus a 3px Dusk Lavender left bar. Shortcuts are shown as `kbd` in Ash.

### Inputs / Fields
- **Style:** a Lifted Charcoal fill, a 1px Seam border, 4px radius, inherited font.
- **Focus:** the border shifts to Dusk Lavender. No glow.

### In-flow Notices (Action notice, Selection bar, coverage and recovery)
- **Style:** borderless strips in normal flow above the list, aligned to the 50px content inset, in Body type. Status words use Amber Notice or Coral Fault. Undo shows its `kbd` hint in Ash. They never overlay rows and never auto-hide a failure.

## 6. Do's and Don'ts

### Do:
- **Do** keep rows at exactly 36px with 12px type, and separate them by rhythm alone.
- **Do** align split tabs, sender names, date captions and notices to the single 50px content inset.
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
