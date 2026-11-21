# ADR 0006: Displaying HTML mail

- Status: Proposed
- Date: 2026-11-21
- Track: C ("usable Android app" programme), branch `usable/html-reader`

## Context

The reader is plain text on every platform ([current status](../current-status.md),
line 58: "HTML mail rendering are not implemented"; ADR 0003 also excluded HTML
bodies from the phone layout). Most real mail is HTML, and some messages have no
`text/plain` part at all. ADR 0001 (line 46) allowed a plain-text reader first and
added: "HTML fidelity is not a reason to weaken isolation or sanitization." This ADR
proposes how to show HTML without weakening either.

### Where bodies come from today

- **Gmail parse.** `parse_thread` (`crates/mail-core/src/gmail/parse.rs:86`) reads a
  `threads.get?format=full` response. `parse_message` (`parse.rs:258`) takes the
  first literal `text/plain` part found by `find_plain_part` (`parse.rs:611`); an
  HTML-only payload yields `None`. Such a message is **dropped from the
  conversation** (`parse.rs:148-151`) and counted in `unsupported_reason` as
  "N of M messages had no safe plain-text body" (`parse.rs:164-169`).
  `context_complete` becomes false.
- **Bounds.** One decoded MIME part ≤ 1 MiB (`MAX_PART_BODY_BYTES`, `parse.rs:13`),
  one text body ≤ 256 Ki chars (`MAX_MESSAGE_TEXT_CHARS`, `parse.rs:15`), payload
  depth ≤ 10 (`parse.rs:17`). One provider response ≤ 10 MiB (`auth.rs:484`). A sync
  page may retain ≤ 16 MiB of serialized conversations
  (`MAX_RETAINED_THREAD_BYTES_PER_PAGE`, `gmail/sync.rs:59`); exceeding it fails
  the page with `InvalidProviderResponse` (`sync.rs:978`, `sync.rs:2825`).
- **Charset.** The part is decoded strictly with its declared charset; lossy
  decoding rejects the body (`parse.rs:286-291`).
- **Inline content.** `has_omitted_inline_content` (`parse.rs:648`) discloses
  "additional inline MIME content is not displayed" when the selected text part is
  not the only inline content (for example a `multipart/related` with images).
- **Attachments.** `attachments::descriptors` (`crates/mail-core/src/attachments.rs:172`)
  records `messageId`, `attachmentId`, filename, MIME type and size for parts with a
  Gmail `attachmentId`, at most 32 (`attachments.rs:12`). It does not record
  `Content-ID`, so `cid:` references cannot be resolved today. Bytes are fetched on
  demand and bounded to 5 MiB (`attachments.rs:11`).
- **Cache.** `gmail_messages.body_text TEXT NOT NULL` is the only body column
  (`gmail/current-schema.sql:6`); schema is `gmail-migrations-9`
  (`gmail/store.rs:37`, `store_schema.rs:8`). The cache holds at most 100
  conversations (`DISCOVERY_CAP`, `gmail/store.rs:35`), evicted oldest first
  (`store/cache_rows.rs:249`). Operation and reminder snapshots store whole
  `Conversation` JSON (`gmail_operation_snapshots.snapshot_json`,
  `gmail_reminders.snapshot_json`).
- **Other users of `body_text`.** Row previews (`store/cache_rows.rs:466`), cached
  search (`search.rs:146`, `search.rs:198`), the read-only reply quote
  (`ReplyComposer.vue:149`), "Copy message text" (`ReaderView.vue:221`) and the
  Files and links list of plain-text URLs (`AttachmentChooser.vue:38-50`).
- **Synthetic provider.** The native fixture (ADR 0002) builds `GmailThread` values
  directly from seed data (`synthetic/provider.rs:185`); it does not go through
  `parse_thread`. Seed messages have one `body: &'static str`
  (`synthetic/data.rs:11-17`); 18 conversations, one synthetic `text/plain`
  attachment on each first message (`synthetic/provider.rs:224-233`). The browser
  preview has its own seed in `src/lib/ipc/browser-fake.ts:287-321`, including
  three hostile-markup conversations that must render literally.

### How the reader renders today

- `ReaderView.vue:1227` interpolates the body as text in a `div.message-body`;
  `splitMessageBody` (`src/lib/message-body-format.ts:107`) splits off a signature
  and a trailing quote, shown behind "Show quoted text" (`ReaderView.vue:1231-1242`).
  The UX-02 contract states "no `v-html`, no HTML/Markdown processing, no remote
  assets" (`docs/ux-02-conversation-reader.md:123-125`).
- The conversation is one scrolling column with several messages, each expanded
  or collapsed (`isExpanded`), in both desktop and compact layouts.
- The app is dark only: `:root { color-scheme: dark }` (`src/assets/style.css:9`).
  Reading text is 15 px (`--type-reading`, `style.css:27`).

### Links today

- Files and links (`AttachmentChooser.vue`) lists literal HTTP(S) URLs found in
  plain text and asks "Leave Email OS and open this link in your system browser?"
  before calling `open_external_link` (`AttachmentChooser.vue:61-67,106-110`).
- `open_external_link` validates HTTP(S) with a host and no credentials
  (`attachments.rs:156`) and dispatches only on macOS; Android returns
  `UnsupportedPlatform` (`src-tauri/src/commands/attachments.rs:61-66`).
- On Android the Files and links control and command are hidden
  (`ReaderView.vue:973`, `App.vue:95`, `App.vue:907`).

### Webview security today

- Tauri CSP (`src-tauri/tauri.conf.json`, `app.security.csp`):
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost`.
  The Android config (`tauri.android.conf.json`) only changes the identifier, so the
  same CSP applies there. The browser preview (`index.html`) has no CSP, only
  `<meta name="referrer" content="no-referrer">`.
- IPC permissions are granted to the window labelled `main` only
  (`src-tauri/capabilities/main-window.json`).
- The Android manifest already has `INTERNET`
  (`src-tauri/gen/android/app/src/main/AndroidManifest.xml:3`).

## Options considered

### 1. Where to sanitise

**1a. Rust, at ingest (`ammonia`).** Sanitise once when the thread is parsed; store
clean HTML.
- For: one place for all data; the frontend never sees raw markup.
- Against: the browser preview has no Rust, so it would need a second sanitiser or
  pre-sanitised fixture copies. `ammonia` does not filter CSS, so `<style>` and
  `style=""` need extra Rust code (`cssparser`). The HTML is parsed by html5ever,
  serialised, and parsed again by the webview: a parser-differential (mXSS) risk
  that ammonia mitigates but cannot remove. A sanitiser fix does not reach mail
  already cached unless the cache is rebuilt.

**1b. Frontend, at render time (DOMPurify 3.x, pinned).** Rust stores the raw,
bounded HTML; the reader sanitises before handing it to the frame.
- For: one code path for macOS, Android and the browser preview. DOMPurify uses the
  same browser parser that renders the result, has hooks for rewriting URLs and
  attributes, handles `<style>` and SVG/MathML namespace confusion, and is widely
  fuzzed. A fix applies to cached mail at once. Hostile tests run in real Chrome.
- Against: a new runtime dependency (today only `vue` and `@tauri-apps/api`). CPU
  cost on each first render (bounded below). CSS still needs our own filter
  (DOMPurify keeps `style` but does not inspect it).

**1c. Both.** Extra safety layer, double the code and the differences between them.
Not worth it given the isolation layers below.

### 2. Isolation

All options render in an `<iframe srcdoc>` with a `sandbox` attribute and a
`<meta http-equiv="Content-Security-Policy">` at the top of the generated
document. They differ in sandbox tokens.

**2a. `sandbox="allow-same-origin"` (no scripts).** No `allow-scripts`, no
`allow-forms`, no `allow-popups`, no `allow-top-navigation`. The frame shares the
app's origin, so the parent can read its DOM.
- For: the parent can measure the content height (one column holding several
  messages needs auto-height frames, not nested scroll areas), scale wide mail to
  fit, intercept link clicks, toggle quoted text, forward key presses to the
  app's shortcuts, and observe image loads. No script from the mail can run:
  without `allow-scripts` the browser does not execute any script in the frame,
  whatever the sanitiser misses. Listeners the parent attaches run in the
  parent's realm, not the mail's.
- Against: if a script ever ran in the frame (only through a webview bug in the
  sandbox), it would be same-origin with the app and could reach Tauri IPC. This
  is the reason the brief asked for "no same-origin".

**2b. `sandbox="allow-scripts"` with an opaque origin and one trusted bridge
script.** The frame cannot reach the parent's DOM or IPC; a small script of ours
(allowed by CSP hash) posts height and link clicks to the parent.
- For: even code execution stays in an opaque origin.
- Against: it turns scripts on. Any sanitiser + CSP bypass then executes mail
  code, which can rewrite the page into a phishing form, read the message, and
  beacon out (opaque origin can still fetch where CSP allows). More moving parts
  (message protocol, hash pinning, Tauri's subframe script injection to verify on
  two webviews).

**2c. `sandbox=""` (no tokens at all).** No scripts, opaque origin.
- For: strongest isolation.
- Against: the parent cannot size the frame, intercept links or toggle quotes.
  Each message becomes a fixed-height inner scroll area (poor on phones), and
  links cannot be followed (a sandboxed frame cannot navigate the parent or a
  sibling frame). Links would have to be listed separately.

**2d. Shadow DOM in the app document.** Rejected: shares origin, CSP and IPC with
the app with no browser-enforced barrier; one sanitiser miss is an app compromise.

### 3. Remote content

**3a. Block by default; per-message "Load images", kept for the reader visit.**
**3b. Same, plus a remembered per-sender allowlist** (persisted locally, cleared on
Gmail disconnect with other cached data).
**3c. Proxy images through Rust** (fetch bytes in the core, pass `data:` URLs).
Gives size/type control but still reveals the user's IP and open time to the
sender, adds an arbitrary-URL HTTP client path to the core, and does not hide
tracking. Not chosen.

### 4. Fitting wide mail on a phone

**4a. Reflow only** (force `max-width: 100%`, override table widths). Breaks many
newsletter layouts built from fixed-width nested tables.
**4b. Scale only** (CSS `zoom` to the container width). Faithful, but small text.
**4c. Light reflow, then scale with a floor.** Images get `max-width: 100%;
height: auto`, long words break; if the document is still wider than the column,
apply `zoom` = column width ÷ content width, not below 0.5; anything still wider
scrolls horizontally inside the message.

### 5. Colours in a dark-only app

**5a. Paper card**: mail that sets its own colours renders on a light card with
`color-scheme: light`; mail that sets no colours (simple HTML from people) takes
the app's text and link colours on the dark surface. **5b. Algorithmic darkening**
(invert or force-dark): not available the same way on WKWebView and Android
WebView, and damages logos and brand colours. **5c. Always paper**: simple mail
from people would look unlike the plain-text messages around it.

## Decision (proposed)

### Data: keep the HTML part in mail-core

1. **Part selection** (`parse.rs`). Walk the payload once and record, outside
   attachments: the first `text/plain` part and the first `text/html` part, with
   `multipart/alternative` treated as alternatives and `multipart/related` as the
   HTML part plus its inline resources. Store both when present.
2. **Text fallback.** A message with HTML but no plain part is no longer dropped.
   Its `body_text` is derived from the HTML in Rust with the `html2text` crate
   (pinned; brings `html5ever`), bounded by the existing 256 Ki chars. Previews,
   cached search, reply quote and "Copy message text" keep using `body_text`. The
   reader labels the derived case nowhere in the body; it is the same text a user
   would select. The "no safe plain-text body" reason then only counts messages
   with neither part, or parts that fail decoding.
3. **Bounds.** HTML uses the same strict charset decode and 1 MiB raw-part bound,
   plus a decoded bound of 512 Ki chars per message and 2 MiB per conversation.
   HTML over a bound is not stored; the message shows its text and the reader
   says "HTML version too large to show." HTML counts toward the 16 MiB page
   budget; when a page would exceed it, HTML is dropped from the remaining threads
   of that page (text kept, reason disclosed) instead of failing the page as today.
4. **Storage.** Migration `gmail-migrations-10` adds `gmail_messages.body_html TEXT NULL`
   (NULL for every existing row: those messages keep the plain reader until the
   conversation is next refreshed). HTML is evicted with the message row.
5. **Wire shape.** HTML is **not** put in `Conversation`: operation and reminder
   snapshots serialise whole conversations, and `get_conversation` would carry
   megabytes on every open. `Message` gains `hasHtml?: boolean` (absent when
   unknown, as `hasAttachment`). A new command
   `get_message_html { conversation, messageId } -> MessageHtml { html, inlineParts }`
   reads the cache. Retained snapshots have no HTML and show text, as today.
6. **Inline images (`cid:`).** `AttachmentDescriptor` gains optional `contentId`
   and `inline` (from `Content-ID` / `Content-Disposition: inline`).
   `MessageHtml.inlineParts` lists `{ contentId, attachmentId, mimeType, size }` for
   `image/png`, `image/jpeg`, `image/gif` and `image/webp` only (no SVG), each
   ≤ 2 MiB, at most 32. A new command
   `get_inline_image { conversation, messageId, attachmentId } -> base64` reuses the
   attachment fetch path and validation. The frame shows them as `data:` URLs.
   Inline parts come from the message itself (Gmail, not the sender's server), so
   they load without asking. They remain listed in Files and links.
7. **Choice in the reader.** When a message has HTML, show HTML. When it also has a
   text part, the message menu offers "Show plain text" / "Show formatted"
   (per message, reader visit only).

### Safety

8. **Sanitiser: DOMPurify in the frontend (option 1b)**, pinned exact version,
   in `src/lib/html-mail/`. Configuration:
   - Remove: `script`, `iframe`, `frame`, `object`, `embed`, `applet`, `form`,
     `input`, `button`, `select`, `textarea`, `link`, `meta`, `base`, `audio`,
     `video`, `source`, `track`, `portal`, `svg` and `math` (inline SVG is rare in
     mail and a common bypass vector), all `on*` attributes, `srcset`, `ping`,
     `formaction`, `xlink:href`, `background` on non-table elements.
   - Links: every `<a href>` keeps its element and style but the `href` moves to
     `data-eos-href` (only `http:`, `https:` and `mailto:`; anything else is
     dropped), `target` is removed, and `role="link"` + `tabindex="0"` are added.
     With no `href` left there is nothing for the frame to navigate to even if a
     click were not intercepted.
   - Images: `src` / `background` that are `cid:` become a placeholder resolved by
     the frame; `data:image/(png|jpeg|gif|webp)` stays; `https:` moves to
     `data-eos-src` until the user loads images; `http:` and every other scheme
     are dropped.
   - CSS: `style` attributes and `<style>` blocks are kept but filtered by our own
     tokeniser: drop `@import`, `@font-face`, `@namespace`, `expression(`,
     `behavior`, `-moz-binding`, `position: fixed|sticky`, and any `url(` that is
     not an allowed `data:` image or a `cid:` (remote `url(` is treated like a
     remote image).
9. **Isolation: `<iframe sandbox="allow-same-origin" srcdoc>` (option 2a).** This
   departs from the brief's "no same-origin" and is the first open question below.
   Reason: one column of several messages needs auto-height frames, link
   interception and quote toggling, and those need parent access; with 2a no mail
   script can run at all, which we judge stronger than 2b's "scripts on, origin
   opaque". If the owner rejects 2a, the fallback is 2c with a fixed-height frame
   per message and links listed in Files and links.
   - Generated document: `<meta charset>`, then the frame CSP
     `default-src 'none'; style-src 'unsafe-inline'; img-src data:` (plus `https:`
     after "Load images"); `font-src data:`; `form-action 'none'`; then our base
     stylesheet, then the sanitised body.
   - The srcdoc frame also inherits the app CSP (Chromium and WebKit both apply
     the parent policy to `about:srcdoc`), so both policies apply. For "Load
     images" to work in Tauri, the app CSP gains `https:` in `img-src` only. The
     app document renders mail only inside frames, so this widens nothing the app
     itself loads. The browser preview has no app CSP; the frame CSP and the
     sandbox still apply.
   - No access to Tauri IPC from mail: no script runs in the frame; capabilities
     stay bound to the `main` window; the frame adds no capability, command or
     permission besides the two read-only commands above.
   - The parent never uses `v-html` or `innerHTML` in the app document; the
     UX-02 statement is amended to "plain-text bodies render by interpolation;
     HTML bodies render only inside the sandboxed frame".

### Remote content

10. **Blocked by default (3a).** No request leaves the device for a message until
    the user asks. A one-line bar above the body: "Remote images blocked."
    with a "Load images" button. Loading moves `data-eos-src` back to `src` and
    relaxes the frame CSP to `img-src data: https:`. Remote fonts, stylesheets and
    `http:` images never load. The choice lasts for the reader visit (cleared when
    the conversation is closed) and is not persisted. A remembered per-sender
    choice (3b) is left as an open question, not built.
11. **Tracking pixels** need no special detection: they are remote images, so they
    are blocked with the rest. The bar does not count or name trackers (the app
    cannot know what a URL does).

### Links

12. **One confirmation for all links.** The confirmation in `AttachmentChooser.vue`
    becomes a shared `LinkConfirm` component used by both Files and links and the
    HTML frame. A click, tap, Enter or Space on a `[data-eos-href]` element opens it
    with the real URL in full (never the link text). When the visible text looks
    like a URL with a different host, it adds "The link text shows a different
    address." HTTP(S): "Open in browser" (where dispatch exists), "Copy link",
    "Keep reading". `mailto:`: "Copy address" and "Keep reading" only.
13. **Android.** Dispatch is unsupported there today (`UnsupportedPlatform`).
    HTML links on Android open the same confirmation with "Copy link" and
    "Keep reading" only, and one line: "Opening links is not available on this
    device." Whether it is available comes from one frontend fact
    (`externalLinksAvailable`), today `!androidFixture`; track B owns the Android
    gate and can flip it without changes in the reader (see Dependencies). The
    Files and links control stays hidden on Android as today unless B changes it.

### Layout

14. **Fit (option 4c).** After load and on every `ResizeObserver` change of the
    column or image load inside the frame, the parent sets the frame height to the
    content height × zoom. Same code in desktop and compact layouts.
15. **Colours (option 5a).** After sanitising, if the mail declares any
    background or text colour (`bgcolor`, `background`, `color`, or colour
    properties in CSS), it renders on a white card with `color-scheme: light`
    and an 8 px radius; otherwise the frame is transparent and uses the app's
    `--text-primary`, link colour and reading face. Mail colours are never
    inverted.
16. **Text size.** Unstyled text uses `--type-reading` (15 px) and
    `--leading-reading`. Sizes set by the mail are kept. On Android the WebView's
    system text scaling applies inside the frame as it does in the app; checked
    on the emulator, not assumed.
17. **Quoted text.** After sanitising, the frame finds a trailing quote:
    `.gmail_quote`, `blockquote[type=cite]`, Outlook's `#divRplyFwdMsg` and what
    follows it, `#appendonsend`, `.yahoo_quoted`, `.protonmail_quote`. Only a quote
    that ends the message is collapsed (same rule as plain text), behind the
    existing "Show quoted text" button below the frame.
18. **Selection and copy** work natively inside the frame. "Copy message text"
    keeps copying `body_text`. Keyboard: key presses inside the frame are
    forwarded to the reader's shortcut handler (same-origin listener), except
    when text is being selected with the keyboard. The frame has a `title`
    ("Message from <sender>") for screen readers.

### Performance

19. HTML is fetched only when a message is expanded; collapsed messages render no
    frame. Sanitised output is cached in memory per message for the session
    (bounded, last 20). Bounds in decision 3 cap the work: a 512 Ki-char input is
    the worst case for one sanitise; stage 5 measures it on the emulator.

## Scope / out of scope

In scope: HTML display in the reader in desktop and compact layouts, in the Tauri
webview on macOS and Android and in the browser preview; Gmail and synthetic
provider data; sanitiser, isolation, remote-content blocking, `cid:` images, link
confirmation; fixtures and tests.

Out of scope:
- Printing.
- Forwarding or replying with HTML (track D owns sending; replies keep the
  plain-text quote).
- HTML composition.
- Persisted image preferences (per sender or global), unless the owner asks (Q2).
- A light app theme.
- Proxying remote images.
- Inline SVG, video, audio, web fonts, forms, AMP for email.
- HTML in search highlighting or row previews (they use `body_text`).
- Rendering HTML attachments (`.html` files stay inert downloads per UX-12).

## Owner actions

- **macOS check (after stage 7).** This VM is Linux and cannot run WKWebView. On
  the Mac: `pnpm tauri dev` on this branch with the native fixture, open the HTML
  sample conversations and confirm the checklist in the Validation plan (frame
  sizes, links open the confirmation, "Load images", no console CSP errors other
  than the expected blocked images). About 15 minutes.
- **Optional real-mail check (after stage 7).** With an explicit Gmail profile on
  the Mac, open three or four real newsletters and one mail with an inline
  image. Results are reported in words; no real mail is committed.
- No credentials, consoles or keys are needed.

## Dependencies

- **Track B (ADR 0005, Android Gmail and Android gates).** Track C does not
  enable link dispatch on Android. It needs one decision from B: does
  `open_external_link` become available on Android in this programme? Track C reads
  a single frontend fact `externalLinksAvailable`; if B enables dispatch, B sets
  that fact (and the native command), and HTML links gain "Open in browser" with
  no reader change. Until then Android shows copy only. Real Gmail HTML on
  Android needs nothing extra from B: it goes through the same core.
- **Track D (ADR 0007, sending).** D may later want `get_message_html` for HTML
  forward or reply quoting; it is a read-only command D can call. Track C does not
  change drafts.
- **Track A (ADR 0004).** None beyond a working APK and emulator. No new Android
  permission is needed (`INTERNET` exists).
- **Shared files.** Track C touches `crates/mail-core/src/gmail/parse.rs`,
  `store_schema.rs`, `dto.rs`, `attachments.rs`, the synthetic provider,
  `generated.ts`, `tauri.conf.json` (CSP) and the capability file. Tracks B and D
  may also add commands and permissions; conflicts in `generated.ts`,
  `main-window.json` and `lib.rs` are expected and resolved at merge.

## Implementation plan

Each stage is one sub-agent run, committed when its check passes.

1. **Frame spike as a rendered test.** `tests/rendered/html-frame-spike.rendered.test.ts`
   loads a page with the proposed app CSP and a sandboxed srcdoc frame and asserts
   in Chrome: a `<script>` and an `onerror` in the frame do not run; a remote image
   makes no request (CDP network log) until the frame CSP allows `https:`; the
   parent can read `scrollHeight` and intercept a click on `[data-eos-href]`;
   `zoom` fits a 600 px table into 360 px. *Check:* the rendered test passes.
2. **Rust part selection and text fallback.** `parse.rs`: select plain and HTML
   parts, `html2text` fallback, bounds, `contentId`/`inline` on descriptors,
   updated reasons. *Check:* new cases in `gmail/parse/tests.rs` (HTML-only,
   alternative, related with cid, oversized HTML, bad charset, depth) and
   `CARGO_TARGET_DIR=/home/exedev/email-os/target CARGO_BUILD_JOBS=2 cargo test -p mail-core parse`.
3. **Storage and IPC.** Migration 10 (`body_html`), `hasHtml`, page-budget
   accounting with HTML drop, `get_message_html`, `get_inline_image`, Tauri
   commands, permissions, generated types, `tauri-client.ts`. *Check:* migration
   tests (fresh, from 9, interrupted), store tests, `mise run check:contract`.
4. **Synthetic HTML samples.** Shared files in `crates/mail-core/src/synthetic/html/`
   (see Fixture data), served by the Rust synthetic provider and imported with
   Vite `?raw` by `browser-fake.ts`, plus `getMessageHtml` / `getInlineImage` in the
   fake. *Check:* synthetic provider tests, `tests/browser-fake` tests, existing
   18-conversation tests updated to the new count.
5. **Sanitiser.** `src/lib/html-mail/sanitize.ts` and `css-filter.ts`, DOMPurify
   pinned. *Check:* `tests/reader/html-sanitize.test.ts` over the hostile corpus
   (jsdom) and `tests/reader/html-sanitize.rendered.test.ts` (real Chrome
   parser), plus a timing check on the largest sample.
6. **Frame component and reader integration.** `HtmlMessageFrame.vue`: srcdoc,
   CSP, base styles, fit and height, paper/adaptive colours, quoted-text toggle,
   Load images bar, cid resolution, key forwarding; used by `ReaderView.vue` in
   both layouts; "Show plain text" in the message menu; app CSP `img-src` gains
   `https:`. *Check:* component tests and `tests/reader/html-reader.rendered.test.ts`
   at 1100 px and 390 px.
7. **Links.** Shared `LinkConfirm.vue`, used by `AttachmentChooser.vue` and the
   frame; `externalLinksAvailable`; mismatch hint; `mailto:` copy only. *Check:*
   component tests for desktop and Android-flag paths; existing UX-12 tests pass.
8. **Validation and docs.** Screenshots, Android run, docs (`current-status.md`,
   `ux-02` safety line, `development.md`), ADR to Accepted. *Check:* the
   Validation plan below and `CARGO_BUILD_JOBS=2 mise run check:all`.

## Fixture data

One set of sample files, used by both the Rust synthetic provider and the browser
fake. All addresses use `.example`/`.test`; all remote URLs use the `.invalid`
TLD so nothing can resolve.

New conversations in the Inbox (the synthetic inbox grows from 18 to 24; existing
conversations and their facts are unchanged; facts for new ids are seeded
additively under a new seed version):

| Id | Content |
|---|---|
| `conv-19` | Newsletter: 600 px nested tables, `<style>` with media queries, remote images, a tracking pixel, links with display text. Alternative text part present. |
| `conv-20` | HTML-only message from a person: paragraphs, a list, a link, no colours (adaptive rendering, derived `body_text`). |
| `conv-21` | `multipart/related` with a `cid:` logo (small PNG in the repo) and one remote image. |
| `conv-22` | Reply chain in HTML with a `.gmail_quote` trailing quote and a `blockquote[type=cite]`. |
| `conv-23` | Hostile: scripts, `on*` handlers, `javascript:`/`data:text/html`/entity-encoded hrefs, `<form>`, `<meta http-equiv=refresh>`, `<base>`, `<iframe>`/`<object>`/`<embed>`, inline SVG with script, CSS `@import`/`url()`/`expression()`, a `position: fixed` overlay, `srcset`, `ping`, a link whose text shows another host, known mXSS shapes (`<noscript>`, `<style>` in SVG/MathML). |
| `conv-24` | Oversized HTML (over 512 Ki chars) to show the "too large" fallback. |

The browser fake's three existing hostile plain-text conversations stay as they are.
Rust parse tests use Gmail-shaped JSON built in the test helpers for MIME structure
cases the synthetic provider does not model (charset, depth, alternatives).

## Validation plan

- **Rust:** parse tests (decision 1–3, 6), migration tests, store tests for
  `get_message_html` and eviction, synthetic provider tests, page-budget test
  (a page with large HTML keeps its threads and drops HTML).
- **Sanitiser:** the hostile corpus in jsdom and in real Chrome. Assertions: no
  `script`/`on*`/`href`/remote `src` survive; a parent-side trap
  (`window.__eosPwned`) stays unset; no network request leaves the page with
  images blocked; no frame navigation occurs after clicking every link.
- **Rendered reader tests** (real Chrome, `EMAIL_OS_RUN_RENDERED=1`): frame height
  equals content; newsletter fits at 390 px; Load images issues requests only
  after the click; quoted toggle; keyboard shortcuts still work after clicking
  into the frame; link confirmation shows the real URL.
- **Browser screenshots** (`mise run screenshots:mobile` and a desktop variant) at
  1100 px and 390 px for: newsletter blocked, newsletter after Load images,
  adaptive HTML-only, cid image, quoted reply collapsed/expanded, hostile sample,
  link confirmation. Light (paper card) and dark (adaptive) mail are both covered
  inside the dark app; there is no light app theme. Committed under
  `docs/validation/html-reader/`.
- **Android emulator** (`emulator-5554`, lock file per RULES): screenshots of the
  same samples, a long-press text selection, the link confirmation with copy only;
  one short recording (≤ 60 s): open newsletter → Load images → tap link →
  confirmation → Copy link. Check system font scale at 1.3 once.
- **macOS:** owner checklist (see Owner actions).
- **Gates:** `CARGO_BUILD_JOBS=2 mise run check:all` and the rendered tests above.

## Risks and open questions

Open questions for the owner:

1. **Same-origin sandbox.** The brief asks for no same-origin. This ADR proposes
   `sandbox="allow-same-origin"` without `allow-scripts` (2a) because it gives
   auto-height frames, link interception and quote toggling while no mail script
   can run. Accept 2a, or require 2c (opaque, no scripts, fixed-height scrolling
   frames, links only through Files and links)?
2. **Remember "Load images"?** Proposed: per message, for the reader visit only.
   Do you want a remembered per-sender choice (3b) in this programme?
3. **Synthetic inbox from 18 to 24 conversations.** Several tests and docs state
   "18 conversations". Acceptable, or should the HTML samples replace bodies of
   existing conversations instead?
4. **New dependencies:** `dompurify` (npm, pinned) and `html2text` (Rust, pulls
   `html5ever`). Acceptable?
5. **`mailto:` links:** copy address only, or also "New message to …" using the
   existing compose?

Risks:

- **Webview differences.** CSP inheritance into `about:srcdoc`, `zoom`, and
  sandbox behaviour must be checked on WKWebView (owner) and Android WebView
  (emulator); Chrome rendered tests do not prove them.
- **Sanitiser bypass.** Mitigated by three layers (sanitiser, no-script sandbox,
  frame CSP inside the inherited app CSP). The app CSP's new `https:` in `img-src`
  is the one widening; it matters only if an HTML injection reached the app
  document itself, which the reader never does.
- **Page budget change** alters sync failure behaviour (HTML dropped instead of a
  failed page). Covered by a test; disclosed in the message.
- **Touch on Android.** Touches that start inside a frame do not reach the
  parent's gesture handlers; horizontal scrolling of very wide mail may compete
  with any reader swipe. Checked on the emulator in stage 8.
- **Cached Gmail mail** keeps plain text until each conversation is refreshed;
  there is no forced rebuild.
- **Fidelity.** Removing `<style>` features (`@font-face`, fixed positioning) and
  inline SVG makes some newsletters look plainer. That is accepted.
