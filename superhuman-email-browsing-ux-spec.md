# Superhuman Email Browsing UX Specification

Desktop reference specification, excluding AI and calendar functionality.

**Status:** Evidence-backed specification with explicitly proposed interaction details. This is not a verified behavioral clone.

## Scope and interpretation

The target is the Superhuman desktop email experience shown in the supplied screenshot, cross-checked against the installed macOS application, version `1041.0.45`. The deliverable describes the experience of navigating, finding, opening, reading, and triaging existing email, rather than composing or sending it.

- **Included:** Inbox splits, conversation lists, focus and selection, conversation reading, contact context, search, folder and label browsing, native tabs and accounts, attachment viewing, manual triage, manual email reminders, and recovery.
- **Excluded:** All AI functionality, automatic classification logic, automatic summaries, generated replies, agent integrations, calendar views, availability, scheduling, meeting RSVP experiences, and event creation.
- **Boundary:** Reply, Reply All, Forward, and Compose may remain exit points from browsing. Their editor behavior, sending, templates, and signatures are not specified.
- **Manual reminders:** Included as an email snooze/triage mechanism, not as calendar functionality. Automatic reminders are excluded.
- **Existing badges:** Existing labels may be rendered as metadata. Reproducing the AI mechanism that generated an existing label is out of scope.
- **Platform:** Desktop/macOS first. Mobile gestures and responsive mobile layouts are not part of this specification.

### Evidence labels

Each requirement distinguishes recovered information from completion choices.

| Label | Meaning |
|---|---|
| `V` | Visual observation from the supplied screenshot; establishes appearance, not interaction |
| `B` | Binary-based / source-assisted observation from shipped Electron resources; static, not executed |
| `D` | Documentation-based behavior from the cited material |
| `P` | Proposed implementation contract where direct target behavior is not established |
| `U` | Unresolved fidelity question requiring a live target observation |

`D` is not equivalent to testing version 1041.0.45. Public documentation may describe a different renderer release or account capability.

### Investigation boundary

The installed Electron ASAR was inspected with the skill-pinned `rea-agents@6.5.0` runtime. Its selected source includes the native shell and production origin configuration, not a recovered authenticated mail renderer. Native tab and history code supplies limited shell evidence.

An authenticated live browsing session was not available: Comet displayed Superhuman's “Get Started Now” screen, and no Superhuman/Electron listening endpoint was found by a bounded local check. The application was not restarted, its debugging configuration was not changed, and no credentials, cookies, mail caches, or account databases were extracted.

The supplied screenshot is the only observed authenticated screen. No mail was opened, sent, archived, relabeled, or deleted during the investigation.

## Product model

The central interaction model is a sequence of actionable conversations, organized into focused inbox views, with fast transitions into individual messages. Split Inboxes are not storage folders: they represent email requiring attention, whereas folders organize stored email. (`D`; [Default Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox))

The three distinctions below are essential to a faithful implementation:

- **Focused versus selected:** One conversation is the current keyboard target; a separate collection can be selected for bulk actions. Superhuman documents `X`, range-extension keys, and modifier-click selection. (`D`; [Multiselect](https://new.superhuman.com/multiselect-29111))
- **Conversation versus message:** Conversation navigation uses `J`/`K`, while message navigation within a conversation uses `N`/`P`; individual messages can be expanded. (`D`; [Shortcut reference](https://nickgray.net/superhuman/), [Attachments](https://help.superhuman.com/hc/en-us/articles/46005568142989-Attachments))
- **Contact pane versus message preview:** The screenshot's right pane contains sender information, not the email body. Documentation confirms that selecting an inbox conversation shows contact context in that sidebar. (`V`, `D`; [Contact Pane](https://help.superhuman.com/hc/en-us/articles/46005778939789-Contact-Pane))

### Conceptual navigation hierarchy

This is a UX model, not a recovered internal schema.

```text
Native window
  Native tab
    Active email account
      Browsing context
        Inbox split | Folder | Label | Search results
          Focused conversation
          Bulk-selected conversation IDs
          Open conversation
            Focused message
            Expanded message IDs
            Active contact
            Attachment preview
```

Account identity, list context, and message identity must remain separate. A conversation can appear in more than one split when configured to also appear in Important or Other. (`D`; [Default Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox))

## Information architecture and layout

### Reference screen anatomy

The original image is 1028 × 1290 pixels. The geometry below uses image coordinates, not CSS pixels; device scale, capture scaling, and native window padding are unknown. All measurements are approximate. (`V`)

| Region | Reference-image geometry | Visual contract |
|---|---|---|
| Native tab/title strip | Top approximately 41 px | Thin, low-contrast strip showing view, count, and account |
| Application rail | Left approximately 40 px | Narrow persistent icon column, separated from the main surface |
| Main browsing surface | Approximately x=40–756 | Wide list area with its own top navigation |
| Contact/context pane | Approximately x=758–1027, about 270 px | Darker full-height side surface, separated by a thin vertical divider |
| Split navigation | Approximately y=76–90 | Inline split names with counts and an emphasized active split |
| First conversation | Approximately y=119–155 | Compact single-line row with focus treatment |
| Conversation rhythm | Approximately 36 px | Dense scanning rhythm; no card stack or large avatars |
| Date grouping | Between the third and fourth displayed conversations | Muted group caption with extra vertical separation |

The screenshot shows six rows in the active split, with considerable empty space below rather than stretched rows. It also shows a hamburger/menu control before the split names, compact compose/search controls after them, and utility controls at the bottom of the contact pane. (`V`)

### Main list composition

The visible column sequence is sender, optional label badges, subject, snippet, and trailing date/actions. The focused row uses a soft gray full-row background and a narrow lavender bar on the left; sender names are more visually prominent than preview text. (`V`)

```text
| focus | sender     | labels | subject      | preview text... | date/actions |
```

- **Sender column:** Fixed or constrained width; long names truncate without shifting the other rows. The screenshot contains truncated sender names. (`V`)
- **Label column:** Compact colored chips before the subject; no interpretation of the label text is required. (`V`)
- **Subject/snippet:** Occupy a single horizontal line in this reference; the preview has lower contrast and truncates at available width. (`V`)
- **Trailing area:** Unfocused rows display dates; the focused row displays several compact action icons instead. The icon identities and whether focus or pointer hover causes the replacement are not verified. (`V`, `U`)
- **Group headers:** Render chronological captions such as “Earlier this month” without turning them into selectable conversations. Exact bucket boundaries and timezone rules remain unknown. (`V`, `U`)

### Visual tokens

These are reconstruction starting values sampled from the JPEG, not recovered design-system tokens. Sampling and compression can alter apparent colors. (`V`)

| Token | Approximate reference |
|---|---|
| Main surface | `#292826` |
| Contact surface | `#1F1E1C` |
| Focus-row fill | Approximately `#474644` |
| Focus accent | Approximately `#BBA5ED` |
| Dividers | Low-contrast warm gray; about one image pixel |
| Typography | Compact sans-serif; exact family, CSS size, and weight unresolved |
| Corner treatment | Slight row rounding; avoid large rounded cards |
| Text hierarchy | Primary off-white; secondary warm gray; labels supply localized color |

Do not infer that all bold rows are unread. The screenshot does not establish the mapping between read state and text weight. (`U`)

### Reconstruction layout policy

The following fills gaps rather than asserting target behavior:

- **List mode:** Keep the rail, main list, and contact pane visible on a sufficiently wide desktop viewport. (`P`)
- **Reading mode:** Replace the main list region with the conversation reader while retaining a clear back path and contact context. Do not invent a permanent side-by-side email preview based on the screenshot. The exact target reader geometry remains unverified. (`P`, `U`)
- **Narrow desktop:** Allow subject/snippet width to contract first. Below a chosen breakpoint, collapse contact context into an explicitly opened panel rather than crushing the list; this breakpoint is a product choice, not a recovered value. (`P`)
- **Calendar removal:** Omit the screenshot's calendar rail item, calendar split, and calendar utilities from this bounded implementation. Preserve email navigation without leaving dead controls. (`P`)
- **AI removal:** Omit AI destinations, summary space, generated suggestions, and AI commands entirely. Do not reserve empty layout slots for them. (`P`)

## Inbox splits and folder navigation

### Split tabs

Split names appear across the top of the inbox; the active split is emphasized. The screenshot's active “Other” view displays a count of six. (`V`)

Split badges represent total conversations, not unread conversations. Counts disappear at zero and above 999, rather than displaying zero or an arbitrarily invented “999+” badge. (`D`; [Default Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox))

- **Change split:** `Tab` moves to the next split and `Shift+Tab` to the previous split. Pointer selection is an implementation contract consistent with the visible tabs; wraparound behavior is unresolved. (`D`, `P`, `U`; [Default Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox))
- **Empty split visibility:** Optional splits can hide when empty; Inbox, Important, and Other cannot use this setting. A hidden split remains accessible through “go to [split name].” (`D`; [Default Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox))
- **Overlapping membership:** A split can also show its conversations in Important/Other, depending on configuration. Do not force every split into a mutually exclusive folder model. (`D`; [Default Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox))
- **Disable split:** Conversations return to the appropriate Inbox/Important/Other views. Removing a view is not deleting its email. (`D`; [Default Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox))

Configuration screens themselves are secondary to browsing. If included, support naming and rule-based custom definitions, ordering, hiding when empty, and enabling/disabling; exclude Auto Label configuration. Custom definitions can use structured criteria, but direct body-keyword definitions are not supported by the documented workflow. (`D`; [Custom Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005636204941-Custom-Split-Inbox))

### Folder and label navigator

From the inbox, the left arrow reveals folders/labels, and the command palette supports “go to [folder]” or “go to [label].” (`D`; [Folders](https://help.superhuman.com/hc/en-us/articles/46005732666253-Folders), [Labels](https://help.superhuman.com/hc/en-us/articles/46005736546061-Labels))

- **Destinations:** Support Inbox, Starred, Sent, Drafts as a browsing destination only, Done, Reminders, Spam, Trash, All Mail, provider folders/labels, and Muted where supported. These destination names are documented, but their exact visual order is not recovered. (`D`, `U`; [Mac shortcut sheet](https://download.superhuman.com/Superhuman%20Keyboard%20Shortcuts.pdf))
- **Large folder collections:** Current label documentation describes nine folders followed by “Show more.” Treat this as current documentation, not a confirmed property of the installed renderer. (`D`; [Labels](https://help.superhuman.com/hc/en-us/articles/46005736546061-Labels))
- **Return contract:** Opening a destination replaces the main list context, updates its title, and clears cross-context bulk selection. Save the old context for Back. (`P`)
- **Empty destination:** Show a context-specific empty message; do not show an inbox-zero celebration for a failed search or an empty Spam folder. (`P`)

### Native tabs and accounts

Native tabs are independent browsing workspaces, not a unified inbox. Official documentation explicitly describes using one tab per account as a workaround for the absence of a unified inbox. (`D`; [Unified Inbox Workaround](https://help.superhuman.com/hc/en-us/articles/46005722297229-Unified-Inbox-Workaround))

The shipped shell statically contains tab switching with focus transfer and Back behavior that avoids handling the command when an editable element is focused. It also configures `https://mail.superhuman.com` as its production application origin. These are shell observations, not proof of mail-renderer behavior. (`B`)

- **Tab commands:** New tab is `Cmd+T`; next/previous tabs are `Cmd+Shift+]` / `Cmd+Shift+[`; numeric switching uses `Cmd+1`, `Cmd+2`, and so on. (`D`; [Unified Inbox Workaround](https://help.superhuman.com/hc/en-us/articles/46005722297229-Unified-Inbox-Workaround))
- **Tab title:** View/split name, count, and account appear in the native tab title; user-defined tab renaming is not documented as supported. (`V`, `D`; [Unified Inbox Workaround](https://help.superhuman.com/hc/en-us/articles/46005722297229-Unified-Inbox-Workaround))
- **Account switch:** Provide “Switch Account(s)” through the palette. Do not silently search all accounts or merge their conversation IDs. (`D`, `P`; [Unified Inbox Workaround](https://help.superhuman.com/hc/en-us/articles/46005722297229-Unified-Inbox-Workaround))

## List focus, opening, and selection

### State distinctions

A minimal implementation needs `focusedThreadId`, `selectedThreadIds`, `openThreadId`, `activeMessageId`, and `expandedMessageIds`. These are proposed model names, not extracted application identifiers. (`P`)

| State | Meaning | Rendering and action target |
|---|---|---|
| No focus | List has no active conversation | No stale contact or destructive action target |
| Focused conversation | Current keyboard target | Highlighted row; contact pane represents that conversation |
| Hovered conversation | Pointer target only | Optional action affordances; do not imply bulk selection |
| Bulk selection | Explicitly selected set | Selection markers and count; bulk actions target the set |
| Open conversation | Reader is active | Message-level navigation becomes available |

The screenshot establishes one visibly focused row. It does not establish whether hovering transfers keyboard focus, whether a first click focuses or opens, or whether opening automatically marks the thread read. (`V`, `U`)

### Proposed pointer and focus contracts

These contracts make an implementation deterministic until live fidelity tests can replace them:

- **Row click:** Open the conversation; keyboard focus alone remains available without opening it. (`P`)
- **Pointer hover:** Reveal row controls without changing the bulk-selected set or read state. (`P`)
- **Inline action click:** Act on that row and stop propagation so the reader does not open accidentally. (`P`)
- **Keyboard movement:** `J`/`K` move the conversation focus; scroll just enough to keep the focused row visible. Do not wrap at list boundaries by default. (`D` for the keys, `P` for scrolling/boundaries; [Shortcut reference](https://nickgray.net/superhuman/))
- **Open/return:** `Enter` opens the focused conversation; Back restores the exact context, focused ID, and approximate scroll position rather than resetting to the first row. (`D` for Enter, `P` for restoration; [Shortcut reference](https://nickgray.net/superhuman/))
- **Unread handling:** Focus and hover do not change read state. For an implementation, opening a loaded conversation may mark it read once; exact target timing, delay, and partial-thread rules remain unresolved. (`P`, `U`)
- **Conversation removed:** Prefer the next surviving row, then the previous row, then an empty state. Do not retain an invisible destructive-action target. (`P`)

### Bulk selection

Superhuman documents `X` to select a conversation, `Shift+J`/`Shift+K` to extend selection, and Cmd/Shift-click to select multiple conversations. (`D`; [Multiselect](https://new.superhuman.com/multiselect-29111))

For reconstruction, selection should use stable IDs rather than row positions; plain navigation should not silently select additional items. Escape should clear the selected set before leaving the list, and the UI should display how many conversations a bulk operation will affect. These exact restoration, anchor, and Escape rules are proposed. (`P`)

“Select all,” “select all from here,” and cross-page selection must not be conflated. The official shortcut sheet names both selection actions, but their precise unloaded-results semantics were not tested; do not claim a loaded-page selection covers every matching email. (`D`, `U`; [Mac shortcut sheet](https://download.superhuman.com/Superhuman%20Keyboard%20Shortcuts.pdf))

## Conversation reading

### Reader content and hierarchy

The reader must distinguish conversation-level metadata from message-level metadata. The presence of message selection, expansion, attachment selection, and per-message read-status surfaces is documented, but the full reader layout is not visible in the supplied screenshot. (`D`, `U`; [Attachments](https://help.superhuman.com/hc/en-us/articles/46005568142989-Attachments), [Read Statuses](https://help.superhuman.com/hc/en-us/articles/46005603745293-Read-Statuses-and-Recent-Opens-Feed))

Use the following hierarchy as a proposed implementation:

```text
Conversation header
  Back / current browsing context
  Subject and labels
  Conversation-level triage actions
Message stack
  Collapsed message header
  Expanded message
    Sender / recipients / timestamp / details affordance
    Original email body
    Attachment chips
    Optional read-status indicator
Browsing exit points
  Reply / Reply All / Forward
Contact/context pane
```

- **Message focus:** `N`/`P` move between messages. The focused message can use a purple left bar, as described in attachment documentation. (`D`; [Attachments](https://help.superhuman.com/hc/en-us/articles/46005568142989-Attachments))
- **Expansion:** `O` expands a message and `Shift+O` expands all messages according to the shortcut reference. Exact collapse toggling, initial expansion, and initial scroll position remain unverified. (`D`, `U`; [Shortcut reference](https://nickgray.net/superhuman/))
- **Default presentation:** For a reconstruction, expand the most recent relevant message and collapse older history, while preserving any expansion made by the user during that visit. This is a completion choice, not recovered behavior. (`P`)
- **Header details:** Provide a disclosure for full sender/recipient addresses and timestamps without requiring a new page. Exact field ordering and menu design remain unresolved. (`P`, `U`)
- **Long email:** Scroll the message body within the reading surface without moving the rail and losing the back affordance. Exact original scroll-container behavior is unverified. (`P`)
- **Message rendering:** Render original email content, not a generated summary. Quoted-history disclosure, remote images, sanitization policy, tracking protection defaults, and dark-mode transformations require separate validation. (`P`, `U`)
- **Next conversation:** `J`/`K` navigate conversations in the originating list, not messages within the current conversation. Preserve the search/filter/split that defined that list. (`D` for key meaning, `P` for origin preservation; [Shortcut reference](https://nickgray.net/superhuman/))

### Contact pane

The contact pane can show a name, avatar, email, location, bio, social/site links, and links to four recent emails. It appears for the selected inbox conversation and when hovering over a person's name/address in a header. (`D`; [Contact Pane](https://help.superhuman.com/hc/en-us/articles/46005778939789-Contact-Pane))

- **Sparse profile:** The screenshot shows only name, email, and a website. Missing enrichment should not produce placeholder prose or a broken profile layout. (`V`, `P`)
- **Search from contact:** Clicking the contact name searches for other email from that person. Clicking their email address starts a draft, which is an out-of-scope exit point here. (`D`; [Contact Pane](https://help.superhuman.com/hc/en-us/articles/46005778939789-Contact-Pane))
- **Copy affordances:** Hovering a name or email exposes a copy control. Keep copying distinct from navigation and drafting. (`D`; [Contact Pane](https://help.superhuman.com/hc/en-us/articles/46005778939789-Contact-Pane))
- **Contact switching:** For a reconstruction, hovering another participant temporarily changes contact context; leaving restores the active participant unless the user explicitly navigates. Exact pinning/restoration is unresolved. (`P`, `U`)
- **Visibility:** Documentation says the contact pane cannot currently be disabled. Any collapsible responsive variant in an implementation is a departure, not a recovered preference. (`D`, `P`; [Contact Pane](https://help.superhuman.com/hc/en-us/articles/46005778939789-Contact-Pane))

### Attachments and links

`Cmd+O` is the documented shortcut for opening links/attachments; PDF attachments can preview inside Superhuman. Other formats can open system/browser previews or download, with behavior varying by format, browser, and OS. (`D`; [Attachments](https://help.superhuman.com/hc/en-us/articles/46005568142989-Attachments))

- **PDF:** Support in-app preview rather than implying that every document type has the same reader. (`D`; [Attachments](https://help.superhuman.com/hc/en-us/articles/46005568142989-Attachments))
- **Unsupported preview:** Word, Excel, PowerPoint, HTML, and cloud links must not be advertised as supported in-app document viewers. Offer the documented external/download path. (`D`; [Attachments](https://help.superhuman.com/hc/en-us/articles/46005568142989-Attachments))
- **Attachment menu:** Right-clicking an attachment chip supports Copy Link/Open Link. The exact visual menu and keyboard chooser are not recovered. (`D`, `U`; [Attachments](https://help.superhuman.com/hc/en-us/articles/46005568142989-Attachments))
- **Return contract:** Dismissing a preview restores the same message, expansion state, and scroll position. Loading/error states must not make the underlying thread unreachable. (`P`)
- **External effects:** Opening a link, downloading a file, and opening an executable are separate actions. An attachment preview must never imply automatic execution. (`P`)

### Optional sent-mail context

Read statuses are a non-AI browsing feature. Documentation places detail popovers on the checkmarks at the right of an email header and under the last message, and describes a Recent Opens sidebar with links into conversations. (`D`; [Read Statuses](https://help.superhuman.com/hc/en-us/articles/46005603745293-Read-Statuses-and-Recent-Opens-Feed))

Treat these as optional and account/plan-dependent. A read receipt from a recipient is not the same state as whether the local user has read a conversation; a reconstruction must keep the two concepts separate. (`D` for capability conditions, `P` for state design; [Read Statuses](https://help.superhuman.com/hc/en-us/articles/46005603745293-Read-Statuses-and-Recent-Opens-Feed))

## Search and command discovery

### Command palette

`Cmd+K` opens Superhuman Command; actions display shortcuts on the right, and button-hover tooltips also teach shortcuts. Documentation says shortcuts are not currently customizable. (`D`; [Keyboard Shortcuts](https://help.superhuman.com/hc/en-us/articles/46005701270541-Keyboard-Shortcuts-in-Superhuman-Mail))

For reconstruction, use a focused text input, a keyboard-navigable results list, a visibly active result, and contextual commands for the focused conversation or selected set. Enter executes the active command; Escape closes the palette and restores its origin focus. Ranking, fuzzy matching, initial suggested commands, and nested-menu behavior remain unverified. (`P`, `U`)

Remove AI and calendar commands from this bounded command catalog. This is intentional scope reduction, not a claim that those commands are absent in Superhuman. (`P`)

### Search flow

`/` starts search, and the documented flow accepts a query followed by Enter. Search covers the inbox and folders, with common operators shown in the right-hand sidebar. (`D`; [Search](https://help.superhuman.com/hc/en-us/articles/46005672652301-Search), [Keyboard Shortcuts](https://help.superhuman.com/hc/en-us/articles/46005701270541-Keyboard-Shortcuts-in-Superhuman-Mail))

```text
Browsing context
  -> Search input + operator guidance
  -> Enter
  -> Results list
  -> Open conversation
  -> Back to the same results and query
  -> Back to previous browsing context
```

The transitions and preservation of result focus are proposed contracts. Autocomplete, live-result timing, result ranking, hit highlighting, and whether the list updates before Enter are unresolved. (`P`, `U`)

- **Query semantics:** Adjacent terms combine with AND; `OR` broadens the query; quoted phrases request exact matching; a leading hyphen excludes a term. (`D`; [Search](https://help.superhuman.com/hc/en-us/articles/46005672652301-Search))
- **Structured criteria:** Rule-based splits document `From:`, `To:`, `Subject:`, `Bcc:`, and `Cc:` criteria, while labels can be browsed/searched using `label:`. A complete search grammar is not recovered. (`D`, `U`; [Custom Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005636204941-Custom-Split-Inbox), [Labels](https://help.superhuman.com/hc/en-us/articles/46005736546061-Labels))
- **Result treatment:** Reuse conversation rows and keyboard navigation rather than introducing a separate card system. Retain the query while opening and closing a result. (`P`)
- **No results:** Show the query, a clear no-match message, and an immediate way to edit or clear it. Do not conflate zero results with offline incompleteness. (`P`)
- **Offline search:** Recent cached email can be searched offline; this does not establish a complete local copy of the mailbox. (`D`; [Search](https://help.superhuman.com/hc/en-us/articles/46005672652301-Search))
- **Account scope:** Default reconstruction scope is the active account. Cross-account search was not established and should not be promised. (`P`, `U`)

## Triage while browsing

These operations are part of the browse-and-process loop, but were not executed on the user's mailbox. Documented effects are listed separately from the proposed immediate UI response.

| Action | Documented meaning | Proposed UI response |
|---|---|---|
| Mark Done | Archive, not delete; remove from inbox and retain searchability; a new reply brings the thread back. (`D`; [Mark Done](https://help.superhuman.com/hc/en-us/articles/47439134613773-Mark-Done)) | Remove from inbox-context lists, update affected split counts, move focus to a surviving neighbor, offer Undo. (`P`) |
| Mark Not Done | Supported conversation action in the shortcut reference. (`D`; [Shortcut reference](https://nickgray.net/superhuman/)) | Restore inbox membership and invalidate affected view counts; preserve independent star/label/read states. (`P`) |
| Star | Supported on a conversation and in bulk. (`D`; [Multiselect](https://new.superhuman.com/multiselect-29111)) | Toggle indicator without opening the reader; remove from Starred only when the view's membership changes. (`P`) |
| Read/unread | Supported conversation action. (`D`; [Shortcut reference](https://nickgray.net/superhuman/)) | Update read styling independently of focus and archive state; remove only from filters that no longer match. (`P`) |
| Label | Apply/remove a tag without removing the conversation from the inbox. (`D`; [Labels](https://help.superhuman.com/hc/en-us/articles/46005736546061-Labels)) | Update badges and relevant label views, preserving the current browsing position. (`P`) |
| Move | Gmail label destination applies a label plus Done; Outlook Move targets folders, not category labels. (`D`; [Labels](https://help.superhuman.com/hc/en-us/articles/46005736546061-Labels)) | Show provider-appropriate destinations; never conflate a tag with a folder. (`P`) |
| Remind Me | Remove from inbox into pending Reminders; return at the scheduled time under the chosen reply condition. (`D`; [Remind Me](https://help.superhuman.com/hc/en-us/articles/46005666142733-Remind-Me)) | Show manual time input and condition, then update membership and provide undo/recovery. (`P`) |
| Mute | Gmail conversations leave the inbox and can be unmuted; Outlook muting is not documented as supported. (`D`; [Muting Conversations](https://help.superhuman.com/hc/en-us/articles/46005597483661-Muting-Conversations)) | Only offer where supported; never show an action that silently fails for the provider. (`P`) |
| Trash | Move to Trash; the app does not offer emptying Trash directly. (`D`; [Unwanted Emails](https://help.superhuman.com/hc/en-us/articles/46005635358349-Dealing-with-Unwanted-Emails)) | Distinguish from Done and from permanent deletion. Preserve a recovery path. (`P`) |
| Important / Other | Can affect one conversation, all current/future mail from an address, or a domain where supported. (`D`; [Moving Conversations](https://help.superhuman.com/hc/en-us/articles/46005707869965-Moving-Conversations-Between-Important-and-Other)) | Require an explicit scope choice; never silently promote a one-thread action into a rule. (`P`) |
| Unsubscribe / Spam / Block | Distinct options, including sender/domain scope and optional bulk archive/trash; unsubscribe may invoke an external page or send a request. (`D`; [Unwanted Emails](https://help.superhuman.com/hc/en-us/articles/46005635358349-Dealing-with-Unwanted-Emails)) | Display the exact action and affected scope before committing the broader operation. (`P`) |

### Undo and optimistic updates

Desktop Undo uses `Z` within a documented 10-second window. Do not substitute the native text-editing `Cmd+Z` shortcut for this browsing action. (`D`; [Undo](https://help.superhuman.com/hc/en-us/articles/46005666743309-Undo))

For reconstruction, apply ordinary triage optimistically, retain a reversible action record, show a concise confirmation with Undo, and roll back on provider failure. Exact toast position, stacking, animation, multi-action history, and original failure UI were not recovered. (`P`, `U`)

### Manual reminder details

The reminder condition defaults to “if no reply”; Tab exposes additional options including “regardless.” A “someday” reminder stays in Reminders rather than returning automatically. (`D`; [Remind Me](https://help.superhuman.com/hc/en-us/articles/46005666142733-Remind-Me))

The pending Reminders folder and returned Reminders split are distinct: the former contains reminders that have not fired; the latter contains returned threads. Current documentation describes special Important/Other membership rules for returned reminders, so do not implement them as a single undifferentiated snoozed list. (`D`; [Remind Me](https://help.superhuman.com/hc/en-us/articles/46005666142733-Remind-Me))

## Keyboard contract

The table preserves documented shortcut meanings but is not an execution-verified keymap for this installed build. Mac modifiers are shown; do not blindly replace every modifier for Windows without checking its dedicated keymap.

| Context | Keys | Meaning and provenance |
|---|---|---|
| Browsing | `Cmd+K` | Open Superhuman Command. (`D`; [Keyboard Shortcuts](https://help.superhuman.com/hc/en-us/articles/46005701270541-Keyboard-Shortcuts-in-Superhuman-Mail)) |
| Browsing | `/` | Search. (`D`; [Keyboard Shortcuts](https://help.superhuman.com/hc/en-us/articles/46005701270541-Keyboard-Shortcuts-in-Superhuman-Mail)) |
| Inbox | `Tab` / `Shift+Tab` | Next / previous split. (`D`; [Default Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox)) |
| List / reader | `J` / `K` | Next / previous conversation. (`D`; [Shortcut reference](https://nickgray.net/superhuman/)) |
| List | `Enter` | Open conversation. (`D`; [Shortcut reference](https://nickgray.net/superhuman/)) |
| Reader | `N` / `P` | Next / previous message within the conversation. (`D`; [Attachments](https://help.superhuman.com/hc/en-us/articles/46005568142989-Attachments)) |
| Reader | `O` / `Shift+O` | Expand message / expand all messages. (`D`; [Shortcut reference](https://nickgray.net/superhuman/)) |
| Inbox | `Left` | Reveal folders/labels. (`D`; [Folders](https://help.superhuman.com/hc/en-us/articles/46005732666253-Folders)) |
| List | `X`; `Shift+J` / `Shift+K` | Select conversation; extend selection. (`D`; [Multiselect](https://new.superhuman.com/multiselect-29111)) |
| Browsing | `E`; `Shift+E` | Done; Not Done. (`D`; [Mark Done](https://help.superhuman.com/hc/en-us/articles/47439134613773-Mark-Done), [Shortcut reference](https://nickgray.net/superhuman/)) |
| Browsing | `S`; `U` | Star; mark read/unread. (`D`; [Shortcut reference](https://nickgray.net/superhuman/)) |
| Browsing | `L`; `V` | Label; Move. (`D`; [Labels](https://help.superhuman.com/hc/en-us/articles/46005736546061-Labels)) |
| Browsing | `H` | Manual Remind Me. (`D`; [Remind Me](https://help.superhuman.com/hc/en-us/articles/46005666142733-Remind-Me)) |
| Browsing | `Z` | Undo within the documented window. (`D`; [Undo](https://help.superhuman.com/hc/en-us/articles/46005666743309-Undo)) |
| Browsing | `#`; `Shift+M`; `Cmd+U` | Trash; Mute where supported; Unsubscribe. (`D`; [Mark Done](https://help.superhuman.com/hc/en-us/articles/47439134613773-Mark-Done), [Muting](https://help.superhuman.com/hc/en-us/articles/46005597483661-Muting-Conversations), [Unwanted Emails](https://help.superhuman.com/hc/en-us/articles/46005635358349-Dealing-with-Unwanted-Emails)) |
| Reader | `Cmd+O` | Open links/attachments. (`D`; [Attachments](https://help.superhuman.com/hc/en-us/articles/46005568142989-Attachments)) |
| Browsing | `G`, then `E`; `G`, then `H` | Go to Done; go to Reminders. (`D`; [Mark Done](https://help.superhuman.com/hc/en-us/articles/47439134613773-Mark-Done), [Remind Me](https://help.superhuman.com/hc/en-us/articles/46005666142733-Remind-Me)) |
| Native app | `Cmd+T`; `Cmd+Shift+]` / `Cmd+Shift+[` | New tab; next / previous tab. (`D`; [Unified Inbox Workaround](https://help.superhuman.com/hc/en-us/articles/46005722297229-Unified-Inbox-Workaround)) |

### Context precedence

The following dispatch policy is proposed because complete target shortcut precedence was not captured:

1. Native/browser/system-reserved commands retain their expected behavior.
2. Modal or palette navigation receives keys before the underlying list.
3. Text fields and contenteditable regions receive ordinary typing and editing keys; typing `e` must not archive mail.
4. Reader-specific bindings apply to message-level actions.
5. Conversation actions target an explicit bulk-selected set, otherwise the current conversation.
6. Inbox split navigation applies only when the inbox list owns keyboard focus.

`Enter` and `Tab` are context-dependent. Enter can open a list conversation, commit a palette choice, or invoke Reply All inside a conversation; Tab can switch splits or navigate message links. Do not install unconditional global handlers. (`D` for the documented meanings, `P` for dispatch order; [Shortcut reference](https://nickgray.net/superhuman/))

For reconstruction, Escape dismisses the topmost transient surface first, then clears selection, then returns from a reader/search context. The actual priority, repeated-Escape behavior, and G-sequence timeout remain unresolved. (`P`, `U`)

## State, consistency, and resilience

### Suggested state model

This model supports the specified UX without claiming a recovered implementation or backend API.

```typescript
type BrowseContext =
  | { kind: "split"; accountId: string; splitId: string }
  | { kind: "folder"; accountId: string; folderId: string }
  | { kind: "label"; accountId: string; labelId: string }
  | { kind: "search"; accountId: string; query: string };

type TabBrowseState = {
  context: BrowseContext;
  filter: null | "unread" | "starred" | "important" | "no-reply";
  orderedThreadIds: string[];
  focusedThreadId: string | null;
  selectedThreadIds: Set<string>;
  rangeAnchorThreadId: string | null;
  openThreadId: string | null;
  activeMessageId: string | null;
  expandedMessageIds: Set<string>;
  listScrollOffset: number;
  readerScrollOffset: number;
  overlay: null | "command" | "search-input" | "label" |
    "move" | "reminder" | "attachment" | "action-scope";
};
```

The four filter names are present in the official shortcut sheet; their exact combination rules and defaults are unresolved. For a bounded implementation, use one active filter at a time until live behavior establishes otherwise. (`D`, `P`, `U`; [Mac shortcut sheet](https://download.superhuman.com/Superhuman%20Keyboard%20Shortcuts.pdf))

### Required consistency invariants

All invariants here are proposed engineering contracts:

- **Stable identity:** Focus and selection attach to conversation IDs, not indexes; incoming rows cannot redirect an action to a different thread.
- **Account isolation:** Every action carries the active account identity; one account's thread IDs or selection never leak into another.
- **Independent dimensions:** Read, star, labels, inbox membership, reminder, and mute are separate state dimensions.
- **Derived views:** Update every visible view that shares a conversation, not just the list where an action started.
- **Preserved origin:** Back from a conversation restores split/folder/label/query/filter and the best surviving anchor.
- **Async safety:** Ignore stale search responses from older queries; a slow response cannot overwrite a newer results context.
- **Failure recovery:** Roll back failed optimistic changes, announce the failure, and preserve a retry path.
- **New mail stability:** Avoid shifting the focused item under the user during triage; the exact Superhuman arrival/banner policy is unknown.

### Non-happy-path states

| State | Proposed treatment |
|---|---|
| Initial loading | Preserve shell geometry and avoid displaying cached counters as confirmed fresh data |
| Empty split | Clear focus, selection, and contact context; show a split-specific completed state |
| No search matches | Keep query editable; distinguish no match from incomplete/offline results |
| Offline cached list | Allow reading cached content; make freshness/availability boundaries clear |
| Message not cached | Keep the conversation header/back path; show unavailable body with retry |
| Conversation removed elsewhere | Return to a valid list anchor; avoid a dead reader with active triage buttons |
| Mutation failure | Restore the affected state and report failure without losing navigation |
| Partial bulk failure | Distinguish succeeded and failed IDs; do not report the whole operation as successful |
| Empty contact profile | Render only known fields, with no invented enrichment |
| Attachment error | Dismiss/retry/open externally without losing the thread |
| Account authentication required | Keep local navigation state but stop claiming remote actions succeeded |

Offline recent-email search is documented; the rest of this table is a proposed resilience specification, not observed failure behavior. (`D`, `P`; [Search](https://help.superhuman.com/hc/en-us/articles/46005672652301-Search))

### Accessibility and performance targets

These are proposed acceptance targets, not measured Superhuman properties:

- **Keyboard completeness:** Every in-scope browsing operation has a discoverable keyboard route and a pointer route.
- **Semantic structure:** Expose split navigation, conversation focus/selection, expanded message state, dialogs, and attachment controls to assistive technology.
- **Visible focus:** Retain a non-color-only focus cue and explicit multi-selection state.
- **Announcements:** Announce result counts, selection counts, triage outcomes, and failures without reading the whole inbox repeatedly.
- **Contrast:** Use the sampled screenshot palette as a reference, not permission to reproduce inaccessible contrast.
- **Local response:** Aim for visible focus/selection feedback within 100 ms; measure rather than claiming parity with Superhuman.
- **Large lists:** Virtualize without invalidating keyboard navigation or screen-reader position; pagination must not silently change selection scope.

## Acceptance scenarios

These tests validate an implementation of this specification. They are not claims that an implementation or the target has passed them.

| ID | Scenario | Expected result | Authority |
|---|---|---|---|
| BROWSE-01 | Render a six-conversation split with one focused row | Compact one-line rows, date grouping, contact context, and no email body in the contact pane | `V`; layout |
| BROWSE-02 | Mix read and unread conversations in a split | Badge reflects total conversations, not unread count | `D`; [Default Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox) |
| BROWSE-03 | Exercise counts 0, 1, 999, and 1000 | Hide badge at 0 and 1000; show 1 and 999 | `D`; [Default Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox) |
| BROWSE-04 | Switch split via Tab/Shift+Tab | Adjacent split becomes active; no bulk selection leaks to the new context | `D` for keys, `P` for selection; [Default Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox) |
| BROWSE-05 | Move list focus, open, navigate messages, return | J/K, Enter, N/P have distinct meanings; origin list position is restored | `D` for keys, `P` for restoration; [Shortcut reference](https://nickgray.net/superhuman/) |
| BROWSE-06 | Select three conversations, then star or archive | Exactly the selected IDs are changed; focus alone does not widen scope | `D` for bulk ability, `P` for precise dispatch; [Multiselect](https://new.superhuman.com/multiselect-29111) |
| BROWSE-07 | Archive and undo within the documented window | Conversation remains searchable and returns to its prior state on undo | `D`; [Mark Done](https://help.superhuman.com/hc/en-us/articles/47439134613773-Mark-Done), [Undo](https://help.superhuman.com/hc/en-us/articles/46005666743309-Undo) |
| BROWSE-08 | Archive the last row or the only row | Focus resolves to a surviving neighbor or a valid empty state | `P` |
| BROWSE-09 | Open search, submit query, inspect result, return | Search query and list context survive the round trip | `D` for search, `P` for restoration; [Search](https://help.superhuman.com/hc/en-us/articles/46005672652301-Search) |
| BROWSE-10 | Type single-letter shortcuts inside search input | Query text changes; no archive, star, or snooze side effect occurs | `P` |
| BROWSE-11 | Apply a label, then use Move | Labeling preserves inbox membership; Gmail Move archives and labels; Outlook Move lists folders | `D`; [Labels](https://help.superhuman.com/hc/en-us/articles/46005736546061-Labels) |
| BROWSE-12 | Choose Important/Other reassignment | One-thread, sender, and supported domain scopes are distinguishable before commit | `D`; [Moving Conversations](https://help.superhuman.com/hc/en-us/articles/46005707869965-Moving-Conversations-Between-Important-and-Other) |
| BROWSE-13 | Set a manual reminder, then browse Reminders | Pending reminder is separate from returned-reminder split membership | `D`; [Remind Me](https://help.superhuman.com/hc/en-us/articles/46005666142733-Remind-Me) |
| BROWSE-14 | Preview a PDF, dismiss, then open an unsupported document | PDF has a preview path; unsupported document uses external/download path; thread state survives | `D` for formats, `P` for restoration; [Attachments](https://help.superhuman.com/hc/en-us/articles/46005568142989-Attachments) |
| BROWSE-15 | Click contact name or copy an address | Name searches; copy does not open a draft or navigate | `D`; [Contact Pane](https://help.superhuman.com/hc/en-us/articles/46005778939789-Contact-Pane) |
| BROWSE-16 | Use two native tabs with different accounts | Each retains its own browsing state; no unified inbox is implied | `D` for tabs/no unified inbox, `P` for state isolation; [Unified Inbox Workaround](https://help.superhuman.com/hc/en-us/articles/46005722297229-Unified-Inbox-Workaround) |
| BROWSE-17 | Receive new mail while focus is on a middle row | Action target remains the same stable ID | `P` |
| BROWSE-18 | Fail a bulk mutation halfway through | Success and failure are reported separately; failed IDs remain actionable | `P` |
| BROWSE-19 | Search offline with only recent messages cached | No claim that an absent old message proves it does not exist | `D` for limited caching, `P` for communication; [Search](https://help.superhuman.com/hc/en-us/articles/46005672652301-Search) |
| BROWSE-20 | Enumerate visible controls and command results | No AI or calendar functionality; no empty reserved AI regions | Scope contract |

## Remaining fidelity work

The evidence supports the list composition, navigation vocabulary, many action semantics, and the native shell's role. It does not support claiming a complete recovery of the authenticated renderer.

Before calling a reconstruction behaviorally equivalent, observe the actual target on a controlled mailbox or user-approved threads:

- **List activation:** Single click versus double click, hover-to-focus behavior, initial focus, and row-action reveal trigger.
- **Read semantics:** Mark-as-read timing, partially unread threads, selection without opening, and unread-filter removal.
- **Reader geometry:** Main-panel layout, widths, message cards/headers, body rendering, quoted history, initial expansion, and scroll anchoring.
- **Navigation edges:** Split and conversation boundary wrapping, G-sequence timeout, repeated Escape, Back stack, and context restoration.
- **Selection:** X toggling, range anchors, command targeting while selected, select-all scope, and unloaded-result behavior.
- **Search:** Suggestions, ranking, all supported operators, spam/trash defaults, account scope, loading behavior, and result highlight treatment.
- **Asynchronous updates:** New-mail insertion, count updates, optimistic errors, multi-tab synchronization, and offline queues.
- **Visual details:** Exact fonts, CSS spacing, theme tokens, tooltip timing, motion, and viewport breakpoints.
- **Attachments:** Preview dismissal, chooser behavior with multiple links/files, and OS-specific download flows.

Use fresh inputs for those observations, retain before/after evidence, and compare each declared behavior rather than only matching a screenshot. No such reconstruction verification has been performed in this investigation.
