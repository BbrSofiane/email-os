---
target: conversation reader + reply/compose surfaces (ReaderView, ReplyComposer, ComposeCard, DraftEditorCore, AttachmentChooser)
total_score: 23
p0_count: 0
p1_count: 4
timestamp: 2026-11-08T10-19-47Z
slug: src-components-readerview-vue-and-reply-compose
---
# Critique run 1: reader + reply/compose

Method: single-agent, code-and-test verification only. Nothing was rendered (no Chrome on this VM, no screenshots), so every visual claim below is read from CSS and templates, not measured. The prior whole-app review scored this area 22/40 and ranked it next (attention 8/10). Each of its findings was re-checked against the code and tests; verdicts are marked CONFIRMED, PARTLY WRONG or REJECTED. Inbox list and search were critiqued earlier and are out of scope.

## Heuristics 23/40
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | "Saved locally / Saving locally…" exists but sits beside a 3-line disclaimer and is amber at rest |
| 2 | Match system / real world | 2 | Raw `conversationId · messageId` in the composer; "N bytes"; "Prepare reply" |
| 3 | User control and freedom | 3 | Esc flushes and closes, Discard confirms; no keyboard way to start a reply |
| 4 | Consistency and standards | 2 | Two reply glyphs; quoted block in mono while the body is proportional; reply form unlike every other reply UI |
| 5 | Error prevention | 3 | Fields disabled while a reply is unprepared; conflict and recovery paths are solid |
| 6 | Recognition rather than recall | 2 | No reply entry in the palette or key hints; the shortcut list says nothing about reply |
| 7 | Flexibility and efficiency | 2 | Reading is fully keyboard-driven (J/K/N/P/O/E/S/Z); replying is mouse-only |
| 8 | Aesthetic and minimalist design | 1 | Up to six caveat paragraphs above the thread; a 4-field form plus 3-line note plus ID line above 3 lines of typing room |
| 9 | Error recovery | 3 | Retry save, Save as new, Reload saved are explicit and honest |
| 10 | Help and documentation | 2 | A permanent disclaimer is doing the job a status line and a title should do |
| | **Total** | **23/40** | Acceptable |

Why 23 and not 22: `useDrafts.statusLabel` already yields an honest settled state ("Saved locally"), so the fix for the disclaimer is to promote that line, not invent a new one.

## Findings: verification

### 1. No reply shortcut — CONFIRMED, P1
`grep` finds no `r` binding anywhere in `App.vue`'s `onKeydown`, and `browsing-actions.ts` has no `reply` action. `prepareReply` (App.vue:1587) is reached only from `ReaderView` emitting `prepareReply`, from two controls: the header glyph `data-test="prepare-reply"` (ReaderView:710-720) and a per-message glyph on the active latest message (ReaderView:848-862). Reading is fully keyboard-driven (J/K/N/P/O/E/S/Z/C); replying is the one step that needs the pointer, which breaks "keyboard first" in the middle of the triage loop.
Safety already holds for a new key: the dispatcher returns for editable targets and IME (`isComposing`/`keyCode 229`, App.vue:1867-1869), returns early while a composer owns keys (App.vue:1866), and `actionShortcutBlocked` lets message toggles through but blocks other buttons. Reply must stay reader-only: the list holds no loaded message, so a list-level R would have to open, load and then reply, which is new scope. The source stays the displayed latest message (never the focused one), and the key must be unavailable for Cached Trash (`browsingOnly`), blocked replies (retained snapshot, incomplete, header mismatch), non-ready state and an open drawer.
Fix: add `reply` to `browsingActions` (label unchanged: "Prepare reply", shortcut R, so existing accessible names stay), `actionGroupOf`, `actionAliases` (respond, answer, write back), `actionAvailable`, `executeAction`, and the key handler; surface "R" in the header glyph title and palette; drive the reader's button titles from `actionLabel('reply')`.

### 2. Reply composer is a form — CONFIRMED, P1
`DraftEditorCore` renders four always-visible labelled fields (To, Cc, Subject, Body) in a 2-column grid (`.composer-fields`, style.css:1819), with a body that is `min-height: 8rem` (5rem when docked, style.css:2070). The core already pre-fills To and `Re: …` Subject for a reply (asserted in `reply-composer.component.test.ts:88-90`), so showing them as empty-looking boxes asks the user to re-read fields they never need to touch. Cc is optional and never filled for a reply. The new-message card needs To and Subject visible (they start empty) but Cc is rarely used.
Fix: reply surface gets a one-line recipient row ("To  Ada Fixture"), Cc and Subject behind a quiet "Cc / Subject" disclosure, and the body is the dominant, auto-focused field. New message keeps To and Subject visible and puts Cc on demand. The To row must never misrepresent the field: show the display name only while To is still the default sender mailbox, and the raw text once edited. Existing `data-test` hooks stay on the inputs; tests that read Cc or Subject reveal them first.
Quoted source: `.reply-quoted` is `--font-mono` at `--type-mono` (0.85rem), larger than the 12px shell and the proportional reading face above it (style.css, ReplyComposer.vue:154-165). Switch to the UI face at the body size in `--text-secondary` (4.99:1 on Focus Stone, ≥ 7:1 on `surface-raised`), keep the 2px rule and pre-wrap, keep it read-only and out of `bodyText`.

### 3. Permanent disclaimer and raw IDs — CONFIRMED, P1
`DraftEditorCore.vue:90-93` prints three lines on every open, every surface: "Local-only plain text. No Send action exists. Recipient text is stored raw… Cc is optional; Bcc, reply-all, quoted text, and rich text are not supported." It also contradicts the UI: it says quoted text is unsupported directly above a quoted block. `ReplyComposer.vue:110-112` and `DraftsPanel.vue:148` print `Reply source is fixed: <conversationId> · <messageId>`: opaque provider IDs a person cannot act on. The settled status line is `.draft-status`, which is colored `--warning` even when everything is fine, so amber at rest dilutes "local-only" as a real warning.
Fix: one line, "Saved locally · not sent" (settled, Ash) / "Saving locally…" / "Save not confirmed" (Amber Notice), with the detail ("Local plain-text draft. Nothing is sent. Recipients are stored as typed and not validated. Bcc, reply-all and rich text are not supported.") in the `title` and a visually hidden description for assistive tech. Drop the ID line from every surface; keep the IDs only as `data-source-*` attributes that tests can read (no visible text). The drawer's own `draft-local-note` in `DraftsPanel` stays (a different surface), but the editor core no longer duplicates it.
Footer: today it is `Close editor` / `Discard…` as equal ghosts with no key hint. Close already flushes (saves) first, and Esc does the same. Fix: primary "Save and close" (Esc kbd hint, Focus Stone fill, Title weight), secondary "Discard…" as an Ash ghost. Honesty is unchanged: the button still waits on the flush and the editor stays open with the error if it fails. No Send, ever.

### 4. Reader header caveats — CONFIRMED, P1
ReaderView:778-816 stacks up to six paragraphs under the subject before the first message: star line, reply-blocked, retained snapshot, one of three read-only/no-auto-read variants, unsupported-or-incomplete, pending. Two are standing statements repeated on every open: "Opening this conversation does not change read state; use an explicit read control" (Gmail with actions) and "Read-only Gmail view: messages are never marked as read. Opening this conversation does not change read state." (Gmail read-only), plus the Cached Trash text. The rest are real exceptions and should stay.
Fix: one muted status line in the existing meta row ("Unread" / "Read-only · Unread"), with the full sentence in its `title` and as visually hidden text, so the guarantee stays discoverable without repeating on screen. Keep every exception inline and amber: reply blocked, retained snapshot, unsupported/incomplete, pending, star attention. Keep the `reader-readonly` / `reader-no-auto-read` hooks on the status line. The Trash notice drops its "Opening does not change read state." sentence and keeps what Trash actually restricts.

### 5. Quoted blocks and signatures force monospace — CONFIRMED, P2
`bodyNeedsMonospace` returns true on the first line matching `^ {0,3}>`, so every reply-chain message renders entirely in mono (message-body-format.ts); two consecutive 4-space-indented lines (signatures, lists) do the same. The quoted tail is also what makes most real threads long.
Fix: split a plain-text body deterministically into prose, an optional signature (after a `-- ` delimiter, only when the tail is short) and an optional trailing quote (an "On … wrote:" attribution line, or a contiguous run of `>` lines to the end). Decide monospace from the prose part only, render signature and quote in the reading face in Ash, and put the quote behind a "Show quoted text" disclosure (per message, kept in the visit state so it survives J/K round trips). Still literal text via interpolation, the `>` characters are never rewritten, nothing is dropped, and interleaved (inline) quotes stay in place and keep the mono rule. The collapsed-row snippet uses the prose part so a message that is mostly quote does not preview as `>`.

### 6. Attachments are second-class — CONFIRMED, P2
`ReaderView` never references `Message.hasAttachment` (a known-true/false/unknown DTO field). Attachments are reachable only through the Cmd+O chooser (a modal). `AttachmentChooser.vue:91` prints `{{ file.size }} bytes` (a 4,812,333-byte file reads as a 7-digit number), and a 230-character paragraph sits above the list (lines 84-85). Its two lists share the same flat style.
Fix: inline attachment rows under the expanded body of each message that has files: name, human size ("27 B", "4.6 MB"), a Save button, and a Cancel while transferring, with the same pending/status/error semantics as the chooser (extract the save/cancel state into one shared composable, no second implementation). Where `hasAttachment === true` but no descriptor is cached, say so plainly ("Attachment not available offline: sync to fetch"); where it is unknown, show nothing (never inferred). Over-5-MiB files say "Over 5 MiB limit". The chooser keeps its role for links and the full list, loses the raw byte counts, and its intro paragraph shrinks to one line with the rest in a `title`/muted note ("Download only. Files save inert with a .download suffix.").

### 7. Loading state and type system — PARTLY WRONG
- Loading: the bare "Loading conversation…" shows only when the shell has no row identity (`loadingIdentity` null: Activity/Reminders/recent-mail entry). From the list the reader already shows the row's subject, sender and date first (ReaderView:735-742, tested). The holding state during J/K keeps the previous conversation on screen. Low value, P3. Small fix only: give the bare line `role="status"`; keep the exact text the smooth-navigation test pins.
- Collapsed sender column — REJECTED. `flex: 0 0 11em` at 12px is 132px, exactly the list's sender column. Its Ash/regular weight is deliberate: only the active message is Paper White/strong, which keeps the One Signal rule. Making it strong would erase that distinction.
- Uppercased date — REJECTED. `.message-time` uppercases the month exactly as `.row-time` does (style.css:1151 vs 1526), and DESIGN.md "Dates" specifies this ("6 Nov" in the DOM, "6 NOV" on screen). The reader already matches the list.
- Reply composer height — CONFIRMED. `.reply-composer { max-height: 45% }` with a 5rem textarea and a 4-field header, a 3-line note and an ID line leaves roughly three lines to type in, and the whole composer scrolls internally. The compact layout in findings 2 and 3 fixes this: the body gets a `min-height` of at least 6 lines and grows, the shell scrolls only when the thread and composer genuinely do not fit.

## Cross-cutting: contrast
Computed from the tokens (WCAG relative luminance): Graphite `#8e8a87` is 4.30:1 on Warm Charcoal, 3.79:1 on Lifted Charcoal `#33312e` and 2.75:1 on Focus Stone `#474644` (under the 3:1 non-text floor). Ash `#c0bcb6` is 7.79 / 6.86 / 4.99:1 on the same three. Smoke `#a09c9a` is 5.41 / 4.76 / 3.46:1. Nothing new in this area may use Graphite for a meaningful glyph or text on Focus Stone, and Graphite text on Lifted Charcoal (3.79:1) is below the 4.5:1 text floor. Current offenders in scope: the `.message-details summary` label ("Details", Graphite text on the active message's `surface-raised` fill, 3.79:1) and the `.message-reply` glyph on the same fill (passes 3:1 as a glyph, but text-sized hints do not). New composer glyphs and hints use Ash.

## Remaining priority issues (after this pass)
- P2 — The inline reply composer and the new-message card still scroll internally when the thread is very short. A true minimum thread viewport needs a rendered pass.
- P3 — The two reply glyphs (header and per-message) overlap in function; after R lands, the per-message glyph could go. Left in place: removing a visible control is a separate decision.
- P3 — Recipient autocompletion and validation do not exist by design (raw text, drafts local-only).

## Not verified
No rendered output exists for any of this. Contrast numbers are computed from the tokens, not sampled from pixels. Real-Chrome journeys (`reader.rendered.test.ts`) are opt-in on `EMAIL_OS_RENDERED_LAYOUT_CHROME` and cannot run on this VM.
