# Current feature status

This page is the current feature inventory and validation summary. Slice and UX
contracts linked below define the detailed behavior and safety limits. Historical
research and architecture proposals are not feature inventories.

## Runtime availability

| Feature | Native fixture (default) | Explicit Gmail profile | Browser preview |
|---|---|---|---|
| Mailbox and reader | Durable synthetic inbox, plain-text reader, archive/restore, operation recovery. | Separate profile; bounded Gmail cache and plain-text reader. Read-only until the user enables mailbox actions. | Synthetic fixtures and in-memory state only; no Gmail, SQLite durability, or native IPC. |
| Mailbox writes | Fixture archive/restore. Fixture reminders retain a synthetic archive/restore operation path. | Explicit archive/unarchive, read/unread, and star/unstar setters only, after opt-in `gmail.modify` upgrade. No automatic read on open. | Fake-provider simulation only; does not prove provider writes or convergence. |
| Composition | Plain-text new message and reply; durable local drafts in the selected native profile. No send path. | Same local-only drafts; they do not sync to Gmail. No send path. | Synthetic drafts in memory; saves are not durable. |
| Search | Cached search over known fixture data. | Read-only cached search or progressive provider scan, with bounded/incomplete coverage disclosures. | Synthetic fake search only. |
| Saved split | One local, account-scoped saved split. | One local split, removed on Gmail disconnect with cached account data. | Synthetic in-memory split. |
| Stars | Not available in the fixture UI. | Starred cache browsing is read-only; explicit star/unstar setters require enabled Gmail modify capability. Cache coverage is incomplete. | Fake simulated-Gmail star state; not fixture-native or provider validation. |
| Reminders | Device-local reminders; fixture scheduling uses its synthetic archive/restore path. | Device-local reminders; schedule/reschedule/cancel/return do not write Gmail or require modify permission. | Synthetic in-memory reminder state. |
| Attachments and links | Synthetic fixture-text attachment listing/downloads. | Bounded cached descriptors and authenticated read-only Gmail fetch; explicit downloads create inert `.download` files. Links need explicit browser confirmation. No automatic opening or restricted document host. | Synthetic attachment surfaces only; no native download or Gmail fetch. |
| Multiple workspaces | One native session; native tabs are not implemented or certified. | One active Gmail profile/session. This is not real multi-account activation. | Two isolated synthetic in-app workspaces are supported by the preview. |

Mode selection is deliberate: native defaults to fixture; `EMAIL_OS_MODE=gmail`
selects a separate Gmail profile. Browser preview remains synthetic. See the
[development guide](development.md) for launch and validation commands.

Sending, provider-synced drafts, reply-all, Bcc, delete/Trash mutations, arbitrary
label editing, and HTML mail rendering are not implemented. Attachment saving
does not provide inline PDF/Office preview or malware scanning. External HTTP(S)
link dispatch is macOS-only; other platforms report it unavailable. See the
linked contracts for exact bounds and pending platform security gates.

## Validation status

The following is the baseline supplied for this documentation task at
`f361f57c4051c0af578af43277bed8170905548a`, not a rerun for this change:

| Check | Supplied result |
|---|---|
| `mise run check` | Passed: 315 Rust core tests; 1,162 frontend tests; 34 skipped. |
| `mise run test:native` | Passed: 11 tests. |
| `mise run build:web` | Passed. |

This documentation pass did not run the app or tests. It did not validate a real
Gmail account, macOS native runtime, or browser-rendered runtime. Automated tests
and prior operator evidence recorded in individual contracts remain distinct
from those runtime gates. In particular, the baseline above does not certify
Gmail consent/deny/cancel flows, live provider convergence, Keychain behavior,
WKWebView behavior, or native attachment/download handling. Check the contracts
for feature-specific pending gates before treating a feature as operationally
validated.

## Feature contracts

| Area | Contract |
|---|---|
| Initial fixture inbox | [Vertical slice 01](vertical-slice-01.md) |
| Gmail reading and profile boundary | [Vertical slice 02](vertical-slice-02.md) |
| Gmail archive and read actions | [Vertical slice 03](vertical-slice-03.md) |
| Local-only drafts and composer | [Vertical slice 04](vertical-slice-04.md) |
| Browsing shell and reader | [UX-01](ux-01-compact-browsing-shell.md), [UX-02](ux-02-conversation-reader.md) |
| Command discovery and Undo | [UX-03](ux-03-command-discovery.md), [UX-04](ux-04-trustworthy-undo.md) |
| Bulk processing and saved split | [UX-05](ux-05-safe-bulk-processing.md), [UX-06](ux-06-saved-split.md) |
| Historical search | [UX-07](ux-07-historical-search.md) |
| Stars | [UX-08](ux-08-stars.md) |
| Provider destinations and triage | [UX-09](ux-09-provider-destinations.md), [UX-10](ux-10-bounded-triage.md) |
| Reminders and attachments | [UX-11](ux-11-local-reminders.md), [UX-12](ux-12-safe-attachments.md) |
| Independent synthetic workspaces | [UX-13](ux-13-independent-workspaces.md) |

For architecture, see [current architecture](current-architecture.md). For
setup, commands, and platform limitations, see the [development guide](development.md).
