# UX-14: Compact mobile shell

## Scope

At viewport widths ≤719 CSS px, use a compact single-pane frame. The 1060px desktop minimum width and regular layout remain unchanged. Android fixture and browser preview share this viewport rule. Existing capability checks continue to gate actions.

## Frame

The top bar is 56px high including safe-area placement. Inbox shows a 40px menu and compose affordance in 48px targets, with no visible title; other browsing contexts show their title. Reader retains a Back control. Status, read-only and browser-preview disclosures remain available without colliding with controls.

The content occupies the space between top and bottom frame, and scrolls with enough end padding to pass behind the bottom pills. The bottom region contains the existing notice dock, a 56px context slot, and a navigation or reader-action pill. Navigation offers Mail, Search, Account. ReaderView's actionsHost is the reader pill. Contact and rail are omitted; destinations remain reachable through the existing navigator overlay.

## List

Conversation rows stack sender and metadata on the first line, subject on the second, and a two-line preview below. The sender starts 20px from the pane edge; the end inset is 16px. The unread marker sits in the start gutter. A 1px rule separates rows. One tap opens the conversation. On touch, swipe right runs the existing Remind action and swipe left runs Mark done (or Mark not done in Done); unsupported actions do not reveal. Long-press a row for 500ms to select it. While selecting, taps add or remove rows; Clear exits selection. These gestures reuse the existing row actions and selection state. Read-only lists do not swipe or enter selection. Multi-split management, labels, and destructive actions remain unsupported.

Inbox/saved split tabs and Reminders membership tabs use the 44px context pill above navigation. The compact menu opens a left navigation drawer with available destinations, the current account and a Commands entry. The drawer uses the action registry and the same action handlers as the desktop navigator. Other contexts leave the context pill empty.

## Other surfaces and settings

Drafts and Reminders use stacked rows with their actions below the text. Search opens beneath the top bar and keeps its suggestions and syntax help available. Account, Activity, Provider mail, Settings and Contact details use full-screen utility pages with a 56px header and scrolling content. Commands and Destinations use a compact overlay; the command list scrolls inside it. The reminder picker and attachment chooser are bottom sheets.

Settings combines the existing reminder defaults with Swipe actions. Swipe right and Swipe left each support Remind me, Mark done and None. Changes save to local storage immediately; storage failures are reported. The defaults are Remind me on the right and Mark done on the left. Swipe preferences follow the device profile.

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
