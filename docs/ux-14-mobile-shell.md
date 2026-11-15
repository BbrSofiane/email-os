# UX-14: Compact mobile shell

## Scope

At viewport widths ≤719 CSS px, use a compact single-pane frame. The 1060px desktop minimum width and regular layout remain unchanged. Android fixture and browser preview share this viewport rule. Existing capability checks continue to gate actions.

## Frame

The top bar is 56px high including safe-area placement. Inbox shows a 40px menu and compose affordance in 48px targets, with no visible title; other browsing contexts show their title. Reader retains a Back control. Status, read-only and browser-preview disclosures remain available without colliding with controls.

The content occupies the space between top and bottom frame, and scrolls with enough end padding to pass behind the bottom pills. The bottom region contains the existing notice dock, a 56px context slot, and a navigation or reader-action pill. Navigation offers Mail, Search, Account. ReaderView's actionsHost is the reader pill. Contact and rail are omitted; destinations remain reachable through the existing navigator overlay.

## Interaction and accessibility

All compact frame controls have at least 48×48 CSS px hit areas, visible focus, accessible names and titles. Honor reduced motion. Hardware Back follows the same Escape precedence: close overlay/drawer/editor/disclosure/details/selection, leave reader, return through context history, then background the app.

## Reader and compose

The reader uses a 1.375rem subject with a 20px start and 16px end inset. Metadata wraps beneath it. Messages show sender and date on the first line; collapsed rows add a one-line preview, and expanded rows add recipients, Details and a plain-text body. Long strings wrap. The compact action pill contains Star, Remind, Mark done, Previous, Next and More when each action is available. Read state, Reply, Files and links, and Commands are in the More sheet; Android omits Files and links. The sheet reuses existing action paths and is dismissed by Escape or Back.

The context pill above the action pill offers Reply when the reply composer is closed. Expanded messages have their own More menu for replying to that message, collapsing it and copying its plain-text body. Copy reports failure when the clipboard cannot be used. Accepted actions appear as outcome toasts above the bottom pills; pending, confirmed, failed, partial and unknown outcomes remain distinct, and Undo follows the existing eligibility window.

New-message and reply editors cover the compact app in a full-screen sheet. Their existing local-save status, fields, alerts and protected close/discard actions remain visible. The body is plain text and expands to fill the remaining height. When the visual viewport changes for the software keyboard, focused fields are scrolled into view. Drafts are local and are not sent. There is no Send path, reply-all, forward or HTML body support.

## Out of scope

Calendar, AI and voice buttons, send, HTML bodies, label chips, multiple splits, trash/spam/move actions, reply-all and forward. Inbox zero remains plain. Later contracts define list, drawer, reader menus, compose, and settings surfaces.
