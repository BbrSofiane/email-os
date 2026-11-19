# UX-14: Compact mobile shell

## Scope

At viewport widths ≤719 CSS px, use a compact single-pane frame. The 1060px desktop minimum width and regular layout remain unchanged. Android fixture and browser preview share this viewport rule. Existing capability checks continue to gate actions.

## Frame

The top bar is 56px high including safe-area placement. Destinations (Inbox, Drafts, Reminders, Search and other mail lists) show the menu button. Pushed pages (Settings, Activity, Account, Provider mail and Contact) cover the app and show Back in the menu button's 48px target. Destination titles remain available in the accessibility tree; the Inbox frame keeps its existing compose affordance. Reader retains Back. Status, read-only and browser-preview disclosures remain available without colliding with controls.

The content occupies the space between top and bottom frame, and scrolls with enough end padding to pass behind the bottom pills. The bottom region contains the existing notice dock, a 56px context slot, and a navigation or reader-action pill. Navigation offers Mail, Search, Account. ReaderView's actionsHost is the reader pill. Contact and rail are omitted; destinations remain reachable through the existing navigator overlay.

## List

Conversation rows stack sender and metadata on the first line, subject on the second, and a two-line preview below. The sender starts 20px from the pane edge; the end inset is 16px. The unread marker sits in the start gutter. A 1px rule separates rows. One tap opens the conversation. Selected rows use the `--focus-fill` background with a checked gutter box and no edge bar. The floating selection bar is a raised 24px pill: its first row has Clear, the loaded-scope count and the primary done action; its second row has read controls and Select all. Long-press a row for 500ms to select it. While selecting, taps add or remove rows; Clear exits selection.

On touch, swipe right reveals Remind over `--focus-fill`; swipe left reveals Mark done or Mark not done over an accent mix. At 35% of row width the cue arms: done becomes `--focus-accent`, Remind becomes a 45% `--text-secondary` mix over `--surface`, and the glyph scales to 1.15. A committed done swipe moves the row out over 160ms before running the existing action; Remind opens the existing picker and leaves the row in place. These gestures reuse existing row actions and selection state. Read-only lists do not swipe or enter selection. Reduced motion removes the row and drawer transitions and the action-sheet entrance animation. Multi-split management, labels, and destructive actions remain unsupported.

Inbox split tabs remain available in Inbox, Done and Starred, with the custom saved split reachable from those lists. Reminders membership tabs use the 44px context pill above navigation. Search, Drafts, Trash and other contexts leave it empty. Search is marked current in the navigation pill only while its results page is open. The compact menu opens a left navigation drawer with available destinations, the current account and a Commands entry. The drawer uses the action registry and the same action handlers as the desktop navigator.

## Other surfaces and settings

Drafts and Reminders use stacked rows with their actions below the text. Search opens beneath the top bar; its syntax list and unsupported-query note are in a closed-by-default Search syntax disclosure. Search results align the query, coverage notice, sender captions and first sender at the 20px start inset, with a 16px end inset; the query is 15px/600 with ellipsis and a 48px clear control. Account, Activity, Provider mail, Settings and Contact details use full-screen pushed pages with a 56px header and scrolling content. Commands and Destinations use a compact overlay; the command list scrolls inside it. The reminder picker and attachment chooser are bottom sheets.

Settings groups Reminders and Swipe actions under 15px/600 section headings. The second section starts after a rule with 24px top spacing; group legends and controls align to the 20px page inset. Swipe right and Swipe left each support Remind me, Mark done and None. Reminder hour and minute changes save immediately; a successful save shows Saved, while a failure restores the last confirmed values and reports the error. The longer note about existing reminders is disclosed under About changing the default. Swipe preferences default to Remind me on the right and Mark done on the left and follow the device profile.

On Reminders, the loading or empty line comes first, then the explanation and a quiet, borderless Refresh reminders control. Zero tab counts are hidden; positive counts remain visible.

## Interaction and accessibility

All compact frame controls have at least 48×48 CSS px hit areas, visible focus, accessible names and titles. Honor reduced motion. Hardware Back follows the same Escape precedence: close overlay/drawer/editor/disclosure/details/selection, leave reader, return through context history, then background the app.

## Reader and compose

The reader uses a 1.375rem subject with a 20px start and 16px end inset. Metadata wraps beneath it. Messages show sender and date on the first line; collapsed rows add a one-line preview, and expanded rows add recipients, Details and a plain-text body. Long strings wrap. The compact action pill contains Star, Remind, Mark done, Previous, Next and More when each action is available. Read state, Reply, Files and links, and Commands are in the More sheet; Android omits Files and links. The sheet reuses existing action paths and is dismissed by Escape or Back.

The context pill above the action pill offers Reply when the reply composer is closed. Expanded messages have their own More menu for replying to that message, collapsing it and copying its plain-text body. Copy reports failure when the clipboard cannot be used. Accepted actions appear as outcome toasts above the bottom pills; pending, confirmed, failed, partial and unknown outcomes remain distinct, and Undo follows the existing eligibility window.

New-message and reply editors cover the compact app in a full-screen sheet. The header X is the only exit on the phone: it saves and closes through the protected path and is disabled while closing. There is no footer “Save and close” button or Esc keycap; “Cancel reply preparation” remains when available, and “Discard…” stays at the end of the footer. Settled status text uses `Local draft · never sent` or `<state> · never sent`; active and problem states keep their existing wording.

To and Cc keep their values as typed with `type="text"`, email input mode, disabled autocapitalization, autocorrect and spellcheck, plus `enterkeyhint="next"`. Subject uses sentence capitalization and next; the plain-text body uses sentence capitalization. Enter moves through visible fields in To, Cc, Subject, Body order; IME composition and modified Enter are left alone. Failure alerts use mobile list size and warning colour; a bordered 48px Retry action sits after the alert and before the fields. The body remains plain text and fills the available height. Focused fields follow visual viewport changes for the software keyboard. Drafts are local and never sent. There is no Send path, reply-all, forward or HTML body support.

The reader’s enabled Mark done glyph uses `--focus-accent`; disabled toolbar buttons remain fully opaque in `--icon-muted`. The message menu uses the `collapse` glyph for Collapse and `copy` for Copy text. The reader More sheet uses `contact` for Contact details and `prompt` for Commands; the navigation drawer also uses `prompt` for Commands.

## Out of scope

Calendar, AI and voice buttons, send, HTML bodies, label chips, multiple splits, trash/spam/move actions, reply-all and forward. Inbox zero remains plain. Later contracts define list, drawer, reader menus, compose, and settings surfaces.
