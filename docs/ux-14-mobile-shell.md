# UX-14: Compact mobile shell

## Scope

At viewport widths ≤719 CSS px, use a compact single-pane frame. The 1060px desktop minimum width and regular layout remain unchanged. Android fixture and browser preview share this viewport rule. Existing capability checks continue to gate actions.

## Frame

The top bar is 56px high including safe-area placement. Inbox shows a 40px menu and compose affordance in 48px targets, with no visible title; other browsing contexts show their title. Reader retains a Back control. Status, read-only and browser-preview disclosures remain available without colliding with controls.

The content occupies the space between top and bottom frame, and scrolls with enough end padding to pass behind the bottom pills. The bottom region contains the existing notice dock, a 56px context slot, and a navigation or reader-action pill. Navigation offers Mail, Search, Account. ReaderView's actionsHost is the reader pill. Contact and rail are omitted; destinations remain reachable through the existing navigator overlay.

## List

Conversation rows stack sender and metadata on the first line, subject on the second, and a two-line preview below. The sender starts 20px from the pane edge; the end inset is 16px. The unread marker sits in the start gutter. A 1px rule separates rows. One tap opens the conversation. On touch, swipe right runs the existing Remind action and swipe left runs Mark done (or Mark not done in Done); unsupported actions do not reveal. Long-press a row for 500ms to select it. While selecting, taps add or remove rows; Clear exits selection. These gestures reuse the existing row actions and selection state. Read-only lists do not swipe or enter selection. Multi-split management, labels, and destructive actions remain unsupported.

Inbox/saved split tabs and Reminders membership tabs use the 44px context pill above navigation. The compact menu opens a left navigation drawer with available destinations, the current account and a Commands entry. The drawer uses the action registry and the same action handlers as the desktop navigator. Other contexts leave the context pill empty.

## Interaction and accessibility

All compact frame controls have at least 48×48 CSS px hit areas, visible focus, accessible names and titles. Honor reduced motion. Hardware Back follows the same Escape precedence: close overlay/drawer/editor/disclosure/details/selection, leave reader, return through context history, then background the app.

## Out of scope

Calendar, AI and voice buttons, send, HTML bodies, label chips, multiple splits, trash/spam/move actions, reply-all and forward. Inbox zero remains plain. Later contracts define list, drawer, reader menus, compose, and settings surfaces.
