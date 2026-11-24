# ADR 0006: Displaying HTML mail

- Status: Accepted (implemented on `usable/html-reader`; see Implementation record)
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
  conversation** (`parse.rs:148-151`) and only counted in `unsupported_reason` as
  "N of M messages had no safe plain-text body" (`parse.rs:164-169`).
  `context_complete` becomes false.
- **Bounds.** One decoded MIME part ≤ 1 MiB (`MAX_PART_BODY_BYTES`, `parse.rs:13`),
  one text body ≤ 256 Ki chars (`MAX_MESSAGE_TEXT_CHARS`, `parse.rs:15`), payload
  depth ≤ 10 (`parse.rs:17`). One provider response ≤ 10 MiB (`auth.rs:484`). A sync
  page may retain ≤ 16 MiB of serialized conversations
  (`MAX_RETAINED_THREAD_BYTES_PER_PAGE`, `gmail/sync.rs:59`); exceeding it **fails
  the whole page** with `InvalidProviderResponse` (`sync.rs:978`, `sync.rs:2825`).
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
- Reading text is 15 px (`--type-reading`, `src/assets/style.css:27`).

### The app has one, dark, theme

Checked against the code on `140d4e0`:

- The only colour-scheme declaration in the app is `:root { color-scheme: dark }`
  (`src/assets/style.css:9`). The colour tokens are defined once in the same
  `:root` block (`style.css:34-40` onward: `--surface: #292826`,
  `--text-primary: #ffffff`, …).
- There is no `prefers-color-scheme` query, `data-theme` attribute or theme
  switch anywhere in `src/` or `tests/` (`grep -rn "prefers-color-scheme\|data-theme" src tests`
  finds nothing). The only `@media` queries in `src/assets/mobile/*.css` are
  `prefers-reduced-motion` and one width query (`mobile/shell.css:208`).
- `src/assets/mobile/tokens.css` overrides sizes and insets for the compact
  layout, not colours.
- DESIGN.md describes the product as "warm-dark" (`DESIGN.md:3`) with one colour
  set (`DESIGN.md:4-14`), and notes the reading leading is "the light-on-dark
  compensation" (`DESIGN.md:372`).

So "light and dark" in this ADR means mail that brings its own light design and
mail that brings none, both inside the dark app. There is no light app theme to
cover.

### Links today

- Files and links (`AttachmentChooser.vue`) lists literal HTTP(S) URLs found in
  plain text and asks "Leave Email OS and open this link in your system browser?"
  before calling `open_external_link` (`AttachmentChooser.vue:61-67,106-110`).
- `open_external_link` validates HTTP(S) with a host and no credentials
  (`attachments.rs:156`) and dispatches only on macOS (`/usr/bin/open --`);
  Android returns `UnsupportedPlatform` (`src-tauri/src/commands/attachments.rs:61-66`).
- On Android the Files and links control and command are hidden
  (`ReaderView.vue:973`, `App.vue:95`, `App.vue:907`).
- New drafts already accept prefilled content: `CreateDraft.initialContent:
  DraftContent | null` with `to` (`src/lib/ipc/generated.ts:458,472`), but
  `useDrafts.openNew` (`src/composables/useDrafts.ts:485`) only passes a source.

### Webview security today

- Tauri CSP (`src-tauri/tauri.conf.json`, `app.security.csp`):
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost`.
  The Android config (`tauri.android.conf.json`) only changes the identifier, so the
  same CSP applies there. The browser preview (`index.html`) has no CSP, only
  `<meta name="referrer" content="no-referrer">`.
- IPC permissions are granted to the window labelled `main` only
  (`src-tauri/capabilities/main-window.json`). The shell has no Tauri plugins.
- Locked tauri is 2.11.6 (`Cargo.lock:3647`).
- The Android manifest already has `INTERNET`
  (`src-tauri/gen/android/app/src/main/AndroidManifest.xml:3`).

## Implementation record (2026-11-21, 2026-11-22, 2026-11-24)

Implemented as decided below, with these departures, each taken during the
implementation and recorded here instead of rewriting the proposal:

1. **No probe build flag.** The coordinator allowed inspecting the debug
   build's WebView over DevTools, so the probe is a self-contained script
   (`tests/rendered/html-frame-probe.ts`, `FRAME_PROBE_SOURCE`) evaluated with
   CDP: in headless Chrome by `tests/rendered/html-frame-spike.rendered.test.ts`
   and in the Android WebView over `adb forward`. No probe code ships in the
   app. The runtime guard ships as decided.
2. **Android dispatch without `tauri-plugin-opener`.** Adding the plugin
   (2.5.5, the newest accepting tauri 2.11) re-resolved existing tauri-stack
   crates (about 730 Cargo.lock lines, several removed or moved) and pulled
   crates that need a newer rustc than the workspace's 1.89. Instead,
   `open_external_link` validates the URL and starts
   `Intent(ACTION_VIEW, Uri.parse(url))` from the app's activity on the
   webview's JNI thread, through Tauri's documented `jni_handle().exec` hook,
   with the `jni` 0.21.1 crate tauri and wry already use (one Cargo.lock edge).
   This is the "small intent" route the coordinator allowed (option 6b),
   without a Kotlin file. No plugin, permission or frontend surface was added.
3. **Browser-preview samples are opt-in in the fake.** The six samples are on
   in the browser preview's primary workspace and off in the fake's default
   test seed, which keeps its 18 conversations, so existing frontend tests did
   not change. The native fixture has all 24.
4. **Frame height** is measured by collapsing the frame for one synchronous
   layout and reading the document's scroll height, because engines disagree
   on how sizes of a zoomed root are reported (found by the phone-width
   rendered test).
5. **Sanitiser output** is post-processed and serialised inside DOMPurify's
   inert document and never parsed in the app document (review fix), and the
   CSS filter rejects `<` so filtered text cannot close the frame's `<style>`.
6. **Process.** Stages were written by sub-agents and reviewed by the track
   owner, but because of the one-heavy-command rule, the sub-agents only wrote
   code. The owner ran every cargo, gradle and vitest check and made every
   commit. Two of the review-fix stages came back incomplete; the owner
   finished them.
7. **No `html2text`** (review of `bc5d5bf`; replaces the approval in decision 2).
   It builds its whole output before any bound applies and can be made to use
   hundreds of megabytes or tens of seconds, or to fail and lose the body.
   Derived text now comes from one linear, output-bounded pass
   (`crates/mail-core/src/gmail/html_text.rs`) used for all input. It never
   fails; an image-only message has empty text and is shown through its HTML.
   The named character references come from `markup5ever` 0.40.0, which
   `html2text` already brought in.
8. **HTML has its own page budget.** Sharing the 16 MiB page bound let a sender
   fill it with HTML so that a later ordinary thread failed the page even
   without its HTML. HTML bodies and text derived from them now count toward a
   separate 8 MiB per page; past it a thread's HTML is recorded as too large
   and its derived text is cut to 2,000 characters. Everything else keeps the
   16 MiB bound it had.
9. **CSS filter on tokens** (review of `bc5d5bf`). The first filter kept reading
   a string past a raw newline, where a browser ends it, so later declarations
   passed unchecked (the frame CSP still blocked the request). The filter now
   works on tokens split as CSS Syntax does, refuses malformed input whole,
   allows listed functions only, and serialises kept tokens.
10. **Sanitised mail in memory** (a cache of 20 messages) is cleared when the
    account changes or disconnects and when its mailbox closes, and reads in
    flight at that moment are not stored.
11. **Refresh under an open message.** A mailbox refresh replaces the
    conversation object. The frame took that for a new message, removed its
    listeners and, with the message cached, set the same document again, so no
    load followed and links, keys and fitting stopped working (found on the
    emulator after returning from the browser). The frame now watches the ids
    themselves and is recreated for each document.
12. **WebKit runs no listener in the frame** (owner's macOS check, 2026-11-24,
    on `main` at `59e5dfb`: steps 1, 3, 4 passed; 2, 5, 6, 7 failed). WKWebView
    refuses to run any event listener whose target is in a frame without
    `allow-scripts`, even a function from the app's realm, and logs "Blocked
    script execution in 'about:srcdoc'". Chromium runs them, which is why
    Android passed. Links, the key forwarder and the image `load` fit never ran
    on macOS. DOM reads and writes from the app still work there. The sandbox is
    unchanged (decision 9: no `allow-scripts`, no other token). Instead
    (`src/lib/html-mail/frame-signals.ts`):
    - On each load the frame checks once whether the app's listeners run in a
      frame (a synthetic event on the frame document; the answer is kept for
      the session). If they do (Chromium, Android), nothing changes.
    - If they do not (WebKit), the app reads state that the user agent changes
      without script, through observers, whose callbacks WebKit does run:
      - **Links.** Each `a[data-eos-href]` gets
        `href="about:srcdoc#<nonce>-<i>"` (absolute, because a relative
        fragment in a srcdoc document resolves against the app's URL). A click,
        tap or Enter is a same-document fragment navigation: nothing is
        fetched. Its target is a `display: none` `eos-target` after the body,
        so nothing scrolls. `eos-target:target ~ eos-signal` gives a hidden
        fixed `eos-signal` element a width, the app's `ResizeObserver` sees it,
        reads the fragment, resets it (`location.replace` to an idle fragment,
        then `history.replaceState` back to `about:srcdoc`) and opens the same
        confirmation. The sanitiser drops custom elements, so mail cannot add
        targets or signals; mail CSS can at most stop its own links from
        signalling, and cannot fake an activation because the app reads the
        link from the fragment. The signal rules are `!important` inside a
        cascade layer with `all: initial`: layered important declarations beat
        every unlayered one whatever its specificity, and the CSS filter keeps
        no `@layer`, so mail CSS cannot fix the signal's size or show a target.
        `-webkit-user-drag: none` keeps a drag that starts on a link selecting
        text, and a zero-specificity `:where(a[data-eos-href][href])` rule
        undoes the UA link colour and underline, so links look as on Chromium.
      - **Keys.** A click focuses the frame, where the app cannot see key
        presses. When focus enters the frame (the app window blurs) or the
        pointer is pressed or released in it (`html:active` gives the signal a
        height), the app checks every 100 ms while the frame has focus and
        gives focus back to the reader (the nearest ancestor with `tabindex`)
        once the pointer is up, unless text is selected (Copy needs the frame
        focused) or an element has keyboard focus (`:focus-visible`, Tab
        through links). So `j`/`k`/Escape work after a click; after selecting
        text they work again after the next click.
      - **Fit.** The app's `ResizeObserver` also watches the frame's images
        instead of `load` listeners. A fit resizes those images (zoom, broken
        image heights), so on this path the observer fits on the next animation
        frame instead of in its callback, which otherwise logs "ResizeObserver
        loop completed with undelivered notifications".
    - Each activation adds one same-document history entry to the frame
      (WebKit only). The app does not use history and macOS has no back
      gesture in the webview.
    - **Known WebKit differences:** Space on a focused link scrolls instead of
      opening it (native links open on Enter only); with text selected or a
      link focused by keyboard, reader keys wait for the next click; the probe
      logs one "Blocked script execution" line per session.
    - Also from the check: the conv-21 logo fixture had a wrong IDAT CRC
      (hand-written base64; Chromium ignores chunk CRCs, ImageIO drew it
      transparent). It is corrected and a core test checks every fixture PNG's
      chunk CRCs. A failed image with integer `width` and `height` attributes
      now gets a pixel height from their ratio at each fit: WebKit draws it
      square under `height: auto` and ignores `aspect-ratio` on a broken image
      (Mac recheck). Loaded, withheld and mail-sized images are untouched.
    - **Probe.** Its remote-image CSP check needed the violation event, a
      listener in the frame. Where parent listeners run (Chromium) it still
      requires that event. WebKit runs none, and the Mac recheck showed it
      gives no `csp-violation` report to a `ReportingObserver` either. There the
      check is structural (`via=structural`): the frame carries the exact
      policy meta, a same-origin control image (`/src-tauri/icons/icon.png`,
      served by the dev server and allowed by the app CSP's `'self'`) loads in
      the same kind of frame without the meta and is blocked with it, and the
      remote image did not load. Without the dev server there is no control
      image, and the line is labelled MANUAL: the console's "Refused to load"
      line is the proof. The probe also checks the link signal (seen by a
      parent `ResizeObserver`, same document, no scroll) and reports whether
      parent listeners run.

### Validation (2026-11-21, 2026-11-22)

- **No-script proof (condition of decision 1).** `FRAME_PROBE_SOURCE` loads
  unsanitised payloads (script, handlers, SVG, `javascript:` URLs, nested
  frames, meta refresh, object, form, navigation, remote image) into
  `sandbox="allow-same-origin"` `srcdoc` frames. It checks that none ran, that
  the parent is untouched, and that no Tauri global is visible in any frame:
  - headless Chrome: `tests/rendered/html-frame-spike.rendered.test.ts`, which
    also injects a script into every frame over CDP to prove the guard catches
    native injection;
  - Android 15 emulator WebView (Chrome 124) on the APK CI built at `db9f07e`:
    all 34 checks pass (the file's three lines marked informational always
    pass), in
    [android-frame-probe.txt](../validation/html-reader/android-frame-probe.txt).
  The parent exposes `__TAURI_INTERNALS__` and `ipc`; no frame does.
- **Browser screenshots** at desktop and phone widths, produced by
  `tests/reader/html-reader.rendered.test.ts` (newsletter blocked and loaded,
  HTML-only, cid image, reply chain collapsed and expanded, hostile sample,
  oversized, link and mailto confirmation):
  [validation/html-reader/browser](../validation/html-reader/browser/).
- **Android emulator** (2026-11-22, the APK CI built at `db9f07e`; later commits
  change only docs and evidence): inbox, newsletter blocked and loaded, link
  confirmation, the system browser, the message after returning from it,
  HTML-only, a reopened conversation, `mailto:` confirmation, New message with
  only To filled, long-press selection inside the frame, cid image, reply chain,
  hostile, oversized; and a 30-second recording: open the newsletter, Load
  images, tap a link, confirm, the system browser opens (at its first-run
  screen), Back returns to the message, and a second link tap asks again
  ([validation/html-reader/android](../validation/html-reader/android/)).
  The recording also shows an empty box for about 0.6 s on a first open and
  about 0.3 s after Load images while the frame loads, and Android's saved
  snapshot of the dialog during the back animation. The probe ran over DevTools
  instead of a probe APK (departure 1). Font scale (1.35) was checked on
  `28e322a` only: frame text follows the system scale.
- **Found by the emulator passes and fixed:** a reopened message showed an empty
  frame; the link dialog's actions were indented when they wrapped; links
  stopped working after a refresh (departure 11). Regression tests cover the
  two frame bugs.
- **macOS WKWebView** is not verified here; it is the owner's checklist in the
  pull request (run the probe in Safari Web Inspector, check the samples and one
  confirmed link). The first check (2026-11-24) failed steps 2, 5, 6 and 7;
  departure 12 is the fix, to be rechecked on the Mac.
- **WebKit model in Chrome** (departure 12). WKWebView cannot run on this VM.
  `tests/rendered/webkit-listener-model.ts` makes Chrome drop every listener
  added to a script-less sandboxed frame, as WebKit does, and
  `html-reader.rendered.test.ts` runs the reader that way: real mouse clicks on
  a web and a `mailto:` link (twice each, frame URL and scroll unchanged), Tab to
  a link then Enter, a click in the text then `j`/`k`, a drag selection that
  keeps focus, image fitting after Load images, link styles equal with and
  without the fragment `href`, and no ResizeObserver loop error while the
  column width changes. The spike test runs the probe both ways and checks the
  signal under hostile, unfiltered mail CSS. The Mac recheck of `bb3ae28`
  (2026-11-24) confirmed that WebKit runs a parent `ResizeObserver` for frame
  nodes (link signal widths 0,1,0) and that links, keys and Copy work; it found
  the four issues fixed after it (CSP probe signal, square broken images, UA
  link style, a ResizeObserver loop message).
- **Risk seen: launch ANR.** On this emulator the app often hits an
  input-dispatch ANR at launch ("Input dispatching timed out … Waited 5001ms for
  FocusEvent(hasFocus=true)"). Seen on 2026-11-21 three times after installing,
  and on 2026-11-22 with the `db9f07e` APK on the first launch after installing
  and again on a later launch, at load averages of about 1 to 3; other launches
  were clean. This ADR adds startup work once per profile (schema migration 10
  and the synthetic seed upgrade). It was not compared with a `main` build, so
  the cause is not established. Startup belongs to track A's first-launch work.

## Decisions

### Owner decision (2026-11-21)

- "Load images" applies to that message only, until the conversation is closed.
  Nothing is remembered per sender. The per-sender option is dropped
  (decision 10).

### Coordinator decisions (2026-11-21, review of `4de4826`)

1. Same-origin frame accepted (`sandbox="allow-same-origin"`, no `allow-scripts`),
   **on condition** that stage 1 proves no script runs in the frame by any route,
   including scripts the native webview injects into frames, and that the check is
   repeated on the Android emulator. See decision 9 and stages 1 and 11.
2. `dompurify` (pinned) and `html2text` approved.
3. Fixtures `conv-19`–`conv-24` added as proposed; existing bodies untouched; the
   "18/16" updates happen in their own mechanical stage (stage 5).
4. `mailto:` offers "Copy address" and "New message to …".
5. Track C owns opening links from mail bodies on Android in this programme
   (decision 13, stage 9). Attachment saving on Android stays out of scope.
6. The dark-only claim is verified above.
7. Per-sender memory of "Load images" went to the owner, who decided against it
   (owner decision above).
8. Stages that touch files shared with tracks A, B and D are marked in the plan.

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

**1b. Frontend, at render time (DOMPurify).** Rust stores the raw, bounded HTML;
the reader sanitises before handing it to the frame.
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
  app's shortcuts, and observe image loads. Without `allow-scripts` the browser
  executes no page script in the frame, whatever the sanitiser misses. Listeners
  the parent attaches run in the parent's realm, not the mail's.
- Against: if a script ever ran in the frame, it would be same-origin with the app
  and could reach Tauri IPC. Page scripts are covered by the sandbox; scripts
  injected by the native webview (user scripts, which some engines run in every
  frame regardless of the HTML sandbox) are not, and must be ruled out by test.

**2b. `sandbox="allow-scripts"` with an opaque origin and one trusted bridge
script.** The frame cannot reach the parent's DOM or IPC; a small script of ours
(allowed by CSP hash) posts height and link clicks to the parent.
- For: even code execution stays in an opaque origin.
- Against: it turns scripts on. Any sanitiser + CSP bypass then executes mail
  code, which can rewrite the page into a phishing form, read the message, and
  beacon out. More moving parts (message protocol, hash pinning).

**2c. `sandbox=""` (no tokens at all).** No scripts, opaque origin.
- For: strongest isolation.
- Against: the parent cannot size the frame, intercept links or toggle quotes.
  Each message becomes a fixed-height inner scroll area (poor on phones), and
  links cannot be followed. Kept as the fallback if stage 1 or the emulator
  check fails.

**2d. Shadow DOM in the app document.** Rejected: shares origin, CSP and IPC with
the app with no browser-enforced barrier; one sanitiser miss is an app compromise.

### 3. Remote content

**3a. Block by default; per-message "Load images", kept until the conversation is
closed.** Chosen (owner decision).
**3b. Proxy images through Rust** (fetch bytes in the core, pass `data:` URLs).
Still reveals the user's IP and open time to the sender, adds an arbitrary-URL HTTP
client path to the core, and does not hide tracking. Not chosen.

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

### 6. Opening links on Android

**6a. `tauri-plugin-opener` 2.5.5, called from Rust only.** Its Android side
(`OpenerPlugin.kt`) starts `Intent(ACTION_VIEW, url)` with `FLAG_ACTIVITY_NEW_TASK`
from the application context. It is maintained with Tauri, registers its own
Kotlin class through the normal plugin path, and needs no manifest change
(`startActivity` without `resolveActivity` needs no `<queries>` entry). 2.5.5
(2026-08-31) is the newest release that accepts the locked tauri 2.11.6
(`tauri ^2.10`); 2.6.0 and later require `tauri ^2.12`, which would move tauri for
every track.
- Safety conditions: built with `Builder::new().open_js_links_on_click(false)`
  so it injects no script into the app document; **no `opener:*` permission is
  added to any capability**, so the frontend cannot call `plugin:opener|open_url`.
  The only route stays the existing `open_external_link` command, which validates
  with `validated_external_url` first and then calls `app.opener().open_url(url,
  None::<&str>)` on Android.
- Against: one more crate and a Kotlin class in the APK; the plugin also carries
  `open_path`/`reveal_item_in_dir` commands, unreachable without permissions.

**6b. Our own Kotlin intent.** A small in-tree Tauri mobile plugin (Kotlin class +
Rust registration) doing the same `ACTION_VIEW`.
- For: no third-party crate; minimal surface.
- Against: we write and maintain plugin glue, Kotlin build wiring under
  `src-tauri/gen/android` (shared with tracks A and B), and its tests, to
  reproduce 20 lines the opener plugin already ships.

## Decision (proposed)

### Data: keep the HTML part in mail-core

1. **Part selection** (`parse.rs`). Walk the payload once and record, outside
   attachments: the first `text/plain` part and the first `text/html` part, with
   `multipart/alternative` treated as alternatives and `multipart/related` as the
   HTML part plus its inline resources. Store both when present.
2. **Text fallback.** A message with HTML but no plain part is no longer dropped.
   Its `body_text` is derived from the HTML in Rust with `html2text` 0.17.3
   (pinned exactly; 2026-10-12; `rust-version` 1.85, within the workspace's 1.89),
   bounded by the existing 256 Ki chars. Previews, cached search, reply quote and
   "Copy message text" keep using `body_text`. The "no safe plain-text body" reason
   then only counts messages with neither part, or parts that fail decoding.
3. **Bounds.** HTML uses the same strict charset decode and 1 MiB raw-part bound,
   plus a decoded bound of 512 Ki chars per message and 2 MiB per conversation.
   HTML over a bound is not stored; the message shows its text and the reader says
   "HTML version too large to show." HTML counts toward the 16 MiB page budget;
   when a page would exceed it, HTML is dropped from the remaining threads of that
   page (text kept, reason disclosed) instead of failing the page as today.
4. **Storage.** Migration `gmail-migrations-10` adds `gmail_messages.body_html TEXT NULL`
   (NULL for every existing row: those messages keep the plain reader until the
   conversation is next refreshed). HTML is evicted with the message row.
5. **Wire shape.** HTML is **not** put in `Conversation`: operation and reminder
   snapshots serialise whole conversations, and `get_conversation` would carry
   megabytes on every open. `Message` gains `hasHtml?: boolean` (absent when
   unknown, as `hasAttachment`). A new read-only command
   `get_message_html { conversation, messageId } -> MessageHtml { html, inlineParts }`
   reads the cache. Retained snapshots have no HTML and show text, as today.
6. **Inline images (`cid:`).** `AttachmentDescriptor` gains optional `contentId`
   and `inline` (from `Content-ID` / `Content-Disposition: inline`).
   `MessageHtml.inlineParts` lists `{ contentId, attachmentId, mimeType, size }` for
   `image/png`, `image/jpeg`, `image/gif` and `image/webp` only (no SVG), each
   ≤ 2 MiB, at most 32. A new read-only command
   `get_inline_image { conversation, messageId, attachmentId } -> base64` reuses the
   attachment fetch path and validation. The frame shows them as `data:` URLs.
   Inline parts come from the message itself (Gmail, not the sender's server), so
   they load without asking. They remain listed in Files and links.
7. **Choice in the reader.** When a message has HTML, show HTML. When it also has a
   text part, the message menu offers "Show plain text" / "Show formatted"
   (per message, reader visit only).

### Safety

8. **Sanitiser: DOMPurify 3.4.17 in the frontend (option 1b)**, pinned exactly
   (`"dompurify": "3.4.17"`, released 2026-10-12; 3.4.18 of 2026-11-14 is less
   than two weeks old and is not taken now). It lives in `src/lib/html-mail/`.
   Configuration:
   - Remove: `script`, `noscript`, `iframe`, `frame`, `frameset`, `object`,
     `embed`, `applet`, `form`, `input`, `button`, `select`, `textarea`, `link`,
     `meta`, `base`, `audio`, `video`, `source`, `track`, `portal`, `template`,
     `svg` and `math` (inline SVG is rare in mail and a common bypass vector), all
     `on*` attributes, `srcset`, `ping`, `formaction`, `xlink:href`, `background`
     on non-table elements.
   - Links: every `<a href>` keeps its element and style but the `href` moves to
     `data-eos-href` (only `http:`, `https:` and `mailto:` after URL parsing;
     anything else is dropped), `target` is removed, and `role="link"` +
     `tabindex="0"` are added. With no `href` left there is nothing for the frame
     to navigate to even if a click were not intercepted. (On WebKit the app
     later sets an `about:srcdoc#…` fragment `href`, which navigates nowhere
     else; see implementation record 12.)
   - Images: `src` / `background` that are `cid:` become a placeholder resolved by
     the frame; `data:image/(png|jpeg|gif|webp)` stays; `https:` moves to
     `data-eos-src` until the user loads images; `http:` and every other scheme
     are dropped.
   - CSS: `style` attributes and `<style>` blocks are kept but filtered by our own
     tokeniser: drop `@import`, `@font-face`, `@namespace`, `expression(`,
     `behavior`, `-moz-binding`, `position: fixed|sticky`, and any `url(` that is
     not an allowed `data:` image or a `cid:` (remote `url(` is treated like a
     remote image).
9. **Isolation: `<iframe sandbox="allow-same-origin" srcdoc>` (option 2a)**, as
   accepted by the coordinator on the conditions below. No `allow-scripts`,
   `allow-forms`, `allow-popups`, `allow-popups-to-escape-sandbox`,
   `allow-top-navigation*`, `allow-modals` or `allow-downloads`.
   - **Generated document**, in this order: `<meta charset="utf-8">`; the frame
     CSP
     `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'`
     (with `https:` added to `img-src` only after "Load images"); our base
     stylesheet; the sanitised body.
   - **CSP inheritance.** A srcdoc frame (`about:srcdoc`) inherits its embedder's
     policy container, so the **app CSP applies to the frame in addition to the
     frame's own meta CSP**; a resource loads only if every policy allows it. In
     Tauri the effective policy for images in the frame is therefore
     app `img-src` ∩ frame `img-src`. Consequences: (a) the app CSP alone already
     blocks remote images today, which is why "Load images" needs an app CSP
     change; (b) the frame CSP cannot loosen anything the app CSP forbids, only
     tighten it; (c) `script-src 'self'` from the app plus `script-src 'none'`
     from the frame both forbid inline and remote scripts in the frame. The
     browser preview has no app CSP, so there the frame CSP and the sandbox are
     the layers. Stage 1 asserts the inheritance in Chrome; stage 11 asserts it on
     Android WebView; the owner's macOS checklist covers WKWebView.
   - **Exact app CSP change** (`src-tauri/tauri.conf.json`), one directive only:
     `img-src 'self' data:` → `img-src 'self' data: https:`. Nothing else changes:
     no `http:`, no `blob:`, no wildcard, and `default-src`, `script-src`,
     `style-src`, `font-src`, `connect-src`, `frame-src` stay as they are. This is
     the narrowest form available: the remote hosts are unknown in advance, and
     because the frame inherits the app policy there is no way to grant `https:`
     to the frame alone. The widening applies to the app document too, which
     sets no remote image URLs; per message, the frame CSP keeps `img-src data:`
     until the user loads images.
   - **No route for scripts.** Page scripts cannot run (no `allow-scripts`, frame
     `script-src 'none'`, sanitiser removes scripts and handlers). Webview-injected
     scripts are ruled out by test, not assumed: Tauri registers its
     initialisation and IPC scripts through the native webview, and whether they
     reach subframes differs between WKWebView and Android WebView. Stage 1 adds a
     runtime guard and a probe:
     - **Runtime guard (every build).** After the frame loads and before it is
       shown, the parent checks the frame's `contentWindow` for
       `__TAURI_INTERNALS__`, `__TAURI__`, `__TAURI_IPC__`,
       `__TAURI_POST_MESSAGE__`, `__TAURI_METADATA__` and `ipc`. If any exists, the
       frame is removed and the message falls back to its text with "Formatted
       view unavailable on this device." Failing closed.
     - **Probe (validation builds only).** A probe view compiled in only when
       `VITE_EMAIL_OS_FRAME_PROBE=1` (absent from default builds; checked by a
       build test that the string is not in `dist/`). It renders **unsanitised**
       hostile documents in the same sandboxed frame, so the sandbox is tested
       without the sanitiser's help: inline `<script>`, `<img onerror>`,
       `<body onload>`, `<svg onload>`, an `<a href="javascript:…">` the parent then
       clicks, `<iframe src="javascript:…">`, `<meta http-equiv=refresh
       content="0;url=javascript:…">`, and `<object data="javascript:…">`. Each
       payload tries to set `parent.__eosPwned` and `parent.document.title`. After
       a settle period the probe asserts, from the parent: `__eosPwned` unset,
       title unchanged, the frame still at `about:srcdoc`, none of the Tauri globals
       above on the frame's window, and a remote image request blocked. It prints
       one line per check ("PASS"/"FAIL") so an emulator screenshot is the record.
     - In Chrome (stage 1) the probe runs as a rendered test, with a stand-in
       `__TAURI_INTERNALS__` defined on the parent via an init script to show the
       guard sees only the frame's own globals. On Android it runs in a probe APK
       (stage 11). If any check fails on a platform, HTML display stays off there
       and we come back to the coordinator with option 2c.
   - **No IPC from mail.** Capabilities stay bound to the `main` window; the frame
     adds no capability or permission besides the two read-only commands above.
     A frame without scripts cannot issue IPC; an `<img>` pointing at
     `http://ipc.localhost` is dropped by the sanitiser (`http:`), blocked by both
     CSPs, and lacks the headers Tauri requires for an invoke.
   - The parent never uses `v-html` or `innerHTML` in the app document; the
     UX-02 statement is amended to "plain-text bodies render by interpolation;
     HTML bodies render only inside the sandboxed frame".

### Remote content

10. **Blocked by default.** No request leaves the device for a message until the
    user asks. A one-line bar above the body: "Remote images blocked." with a
    "Load images" button. Loading moves `data-eos-src` back to `src` and relaxes
    the frame CSP to `img-src data: https:`. Remote fonts, stylesheets and
    `http:` images never load. The choice applies **to that message only, until
    the conversation is closed** (owner decision). It is held in the reader's
    visit state, never written to the profile, and nothing is remembered per
    sender or globally. Other messages in the same conversation keep their own
    bar. Tracking pixels are remote images, so they are blocked with the rest;
    the bar does not count or name trackers.

### Links

11. **One confirmation for all links.** The confirmation in `AttachmentChooser.vue`
    becomes a shared `LinkConfirm` component used by both Files and links and the
    HTML frame. A click, tap, Enter or Space on a `[data-eos-href]` element opens it
    with the real URL in full (never the link text). When the visible text looks
    like a URL with a different host, it adds "The link text shows a different
    address." HTTP(S): "Open in browser", "Copy link", "Keep reading".
12. **`mailto:`.** The confirmation shows the address and offers "Copy address",
    "New message to <address>" and "Keep reading". "New message" opens the existing
    compose with `To` filled through `CreateDraft.initialContent`
    (`useDrafts.openNew` gains an optional initial content). Only the address is
    used: `subject`, `body`, `cc`, `bcc` and other `mailto:` parameters are ignored,
    so mail content cannot pre-write a message. Addresses are parsed with the
    existing address rules; an invalid one offers "Copy address" only. Sending is
    track D's; this only creates a local draft as "New message" does today.
13. **Android dispatch (track C, option 6a).** `open_external_link` on Android
    stops returning `UnsupportedPlatform`: it validates with
    `validated_external_url` and then calls the opener plugin's Rust API
    (`ACTION_VIEW`). No new command, no new permission, no frontend access to the
    plugin; mail content can reach a browser only through the confirmation's
    "Open in browser". If no app can handle the URL, the command fails and the
    confirmation says "Could not open the link. You can copy it instead."
    `externalLinksAvailable` becomes true on Android. The Files and links control
    stays hidden on Android (attachment saving there is out of scope); HTML links
    and `mailto:` work through the frame's confirmation. Plain-text bodies on
    Android gain nothing in this programme (their URLs are not links today).

### Layout

14. **Fit (option 4c).** After load and on every `ResizeObserver` change of the
    column or image load inside the frame, the parent sets the frame height to the
    content height × zoom. Same code in desktop and compact layouts.
15. **Colours (option 5a).** After sanitising, if the mail declares any background
    or text colour (`bgcolor`, `background`, `color`, or colour properties in CSS),
    it renders on a white card with `color-scheme: light` and an 8 px radius;
    otherwise the frame is transparent and uses the app's `--text-primary`, link
    colour and reading face. Mail colours are never inverted.
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
    while text is being selected with the keyboard. (WebKit runs no such
    listener; see implementation record 12.) The frame has a `title`
    ("Message from <sender>") for screen readers.

### Performance

19. HTML is fetched only when a message is expanded; collapsed messages render no
    frame. Sanitised output is cached in memory per message for the session
    (bounded, last 20). Bounds in decision 3 cap the work: a 512 Ki-char input is
    the worst case for one sanitise; stage 6 measures it in Chrome and stage 11 on
    the emulator.

## Scope / out of scope

In scope: HTML display in the reader in desktop and compact layouts, in the Tauri
webview on macOS and Android and in the browser preview; Gmail and synthetic
provider data; sanitiser, isolation, remote-content blocking, `cid:` images, link
confirmation, `mailto:` to a new local draft, link dispatch on Android; fixtures
and tests.

Out of scope:
- Printing.
- Forwarding or replying with HTML (track D owns sending; replies keep the
  plain-text quote).
- HTML composition.
- Persisted image preferences, per sender or global (owner decision).
- A light app theme (none exists).
- Proxying remote images.
- Inline SVG, video, audio, web fonts, forms, AMP for email.
- HTML in search highlighting or row previews (they use `body_text`).
- Rendering HTML attachments (`.html` files stay inert downloads per UX-12).
- Attachment saving and the Files and links control on Android.

## Owner actions

- **macOS check, 15 minutes (after stage 10).** This VM is Linux and cannot run
  WKWebView. On the Mac: `pnpm tauri dev` on this branch with the native fixture
  profile. Checklist:
  1. Open `conv-19` (newsletter): it fits the column, the "Remote images blocked."
     bar shows; Load images shows the images' alt text or broken images (hosts are
     `.invalid`), with no other change.
  2. Open `conv-21`: the inline logo shows without Load images.
  3. Open `conv-22`: the quoted part is collapsed; Show quoted text opens it.
  4. Open `conv-23` (hostile): the window title stays "email-os", no dialog
     appears, the text shows; the message is not replaced by "Formatted view
     unavailable".
  5. Click a link in `conv-20`: the confirmation shows the full URL; Copy link
     works; Keep reading closes it. Click a `mailto:` link: New message opens with
     To filled.
  6. Press `j`/`k` (or the usual next/previous keys) after clicking inside a
     message: navigation still works.
  7. Web Inspector console (if enabled): only CSP reports for blocked images.
  Report results in words.
- **Optional real-mail check (after stage 10).** With an explicit Gmail profile on
  the Mac, open three or four real newsletters and one mail with an inline image.
  Results are reported in words; no real mail is committed.
- No credentials, consoles or keys are needed.

## Dependencies

- **Track B (ADR 0005).** Link dispatch on Android is now track C's (coordinator
  decision 5). B needs nothing from C. C needs from B only merge coordination:
  both tracks may touch `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`,
  `Cargo.lock` and `src-tauri/gen/android`. If B adds a Tauri plugin or moves the
  tauri version, the opener version in decision 13 is re-checked against it.
  Real Gmail HTML on Android needs nothing extra: it goes through the same core.
- **Track D (ADR 0007, sending).** D may later want `get_message_html` for HTML
  forward or reply quoting; it is a read-only command D can call. C changes
  `useDrafts.openNew` only by adding an optional initial content (stage 8); D
  should know before changing that signature.
- **Track A (ADR 0004).** A working APK and the emulator. No new Android
  permission (`INTERNET` exists; `ACTION_VIEW` needs none). C's synthetic facts
  top-up (stage 4) runs on startup in the native fixture; A should know, since it
  owns first-launch behaviour.

## Implementation plan

Each stage is one sub-agent run, committed when its check passes. **Shared** marks
files other tracks also change, so merges can be ordered: **[D]** send (reply,
compose, thread refresh after send), **[A]** startup / install / Android build,
**[B]** Android sign-in and shell.

1. **Frame safety spike, runtime guard and probe.** `src/lib/html-mail/frame-guard.ts`
   (globals check), the probe view behind `VITE_EMAIL_OS_FRAME_PROBE`, and
   `tests/rendered/html-frame-spike.rendered.test.ts` in Chrome with the proposed
   app CSP: unsanitised payloads never fire (handlers, `javascript:` click,
   `javascript:` iframe/object/refresh); `__eosPwned` unset; title unchanged; the
   frame stays at `about:srcdoc`; the guard sees no Tauri globals on the frame
   while a stand-in exists on the parent; a remote image makes no request
   (CDP network log) under the inherited app CSP even when the frame CSP allows
   `https:`, and does after the app CSP gains `https:` (inheritance shown both
   ways); the parent reads `scrollHeight` and intercepts a click on
   `[data-eos-href]`; `zoom` fits a 600 px table into 360 px; a build test shows
   the probe absent from a default `dist/`. New files only.
   *Check:* the rendered test and the build test pass.
2. **Rust part selection and text fallback.** `parse.rs`: plain and HTML parts,
   `html2text` 0.17.3, bounds, `contentId`/`inline` on descriptors, updated
   reasons. *Shared [D]:* `parse.rs` holds `parse_reply_context`, which D may touch.
   *Check:* new cases in `gmail/parse/tests.rs` (HTML-only, alternative, related
   with cid, oversized HTML, bad charset, depth) and
   `CARGO_TARGET_DIR=/home/exedev/email-os/target CARGO_BUILD_JOBS=2 cargo test -p mail-core parse`.
3. **Storage and IPC.** Migration 10 (`body_html`), `hasHtml`, page-budget
   accounting with HTML drop, `get_message_html`, `get_inline_image`, Tauri
   commands, permissions, generated types, `tauri-client.ts`, `client.ts`.
   *Shared [A][B][D]:* `src-tauri/src/lib.rs` command list,
   `capabilities/main-window.json`, `generate-types.rs`, `generated.ts`,
   `client.ts`, `dto.rs`; *[D]:* `gmail/sync.rs` (thread refresh after send).
   *Check:* migration tests (fresh, from 9, interrupted), store tests,
   `mise run check:contract`.
4. **Synthetic HTML samples.** Shared files in `crates/mail-core/src/synthetic/html/`
   (see Fixture data), served by the Rust synthetic provider, with facts for the
   six new ids seeded additively under a new seed version; imported with Vite
   `?raw` by `browser-fake.ts`, plus `getMessageHtml` / `getInlineImage` in the
   fake. Existing conversations and bodies unchanged. *Shared [A]:*
   `synthetic/facts.rs` seeding runs at startup; *[D]:* `browser-fake.ts` (fake
   send). *Check:* synthetic provider tests (including an existing 18-conversation
   database gaining exactly six), `tests/browser-fake` tests for the new methods.
5. **Mechanical count update (18 → 24, 16 → 22 in the Inbox).** Only tests and
   docs that state the counts (`docs/current-status.md`, ADR 0002 text where it
   describes the current state, development docs, test assertions and fixture
   lists). No behaviour change. *Shared [A][B][D]:* `docs/current-status.md`,
   `docs/development.md`. *Check:* `pnpm vitest run` and
   `cargo test -p mail-core` green; `grep -rn "18 conversations\|16 Inbox"` shows
   only historical records.
6. **Sanitiser.** `src/lib/html-mail/sanitize.ts` and `css-filter.ts`,
   `dompurify` 3.4.17 pinned. *Shared:* `package.json`, `pnpm-lock.yaml` (any
   track adding npm dependencies). *Check:* `tests/reader/html-sanitize.test.ts`
   over the hostile corpus (jsdom), `tests/reader/html-sanitize.rendered.test.ts`
   (real Chrome parser), and a timing check on the largest sample.
7. **Frame component and reader integration.** `HtmlMessageFrame.vue`: srcdoc,
   frame CSP, guard, base styles, fit and height, paper/adaptive colours, quoted
   toggle, Load images bar, cid resolution, key forwarding; used by
   `ReaderView.vue` in both layouts; "Show plain text" in the message menu; app
   CSP `img-src` gains `https:`. *Shared [D]:* `ReaderView.vue` (reply bar, refresh
   after send), `App.vue`, `src/assets/mobile/reader.css`; *[A][B]:*
   `src-tauri/tauri.conf.json`. *Check:* component tests and
   `tests/reader/html-reader.rendered.test.ts` at 1100 px and 390 px.
8. **Links and `mailto:`.** Shared `LinkConfirm.vue`, used by
   `AttachmentChooser.vue` and the frame; `externalLinksAvailable`; host-mismatch
   hint; `mailto:` Copy address and New message with To filled.
   *Shared [D]:* `src/composables/useDrafts.ts` (`openNew` initial content),
   `App.vue` (compose opening). *Check:* component tests for http(s), `mailto:`
   (parameters ignored, invalid address), Android-flag path; existing UX-12 and
   drafts tests pass.
9. **Android link dispatch.** `tauri-plugin-opener` = "=2.5.5" in
   `src-tauri/Cargo.toml`, registered with `open_js_links_on_click(false)`, no
   `opener:*` permission; `open_external_link` Android branch calls it after
   `validated_external_url`; `externalLinksAvailable` true on Android.
   *Shared [A][B]:* `src-tauri/Cargo.toml`, `Cargo.lock`, `src-tauri/src/lib.rs`,
   `src-tauri/src/commands/attachments.rs`, `src-tauri/gen/android` (plugin
   registration). *Check:* a test that the capability files contain no `opener:`
   permission; `cargo test` for the shell; `mise run android:build` succeeds; on
   the emulator a confirmed link opens the browser and returns with Back.
10. **Docs.** `docs/current-status.md`, UX-02 safety line, UX-12 links note,
    `docs/development.md`, ADR status Accepted with decisions taken.
    *Shared [A][B][D]:* status and development docs. *Check:* doc review; links
    resolve.
11. **Validation.** Browser screenshots, emulator probe APK, emulator screenshots
    and recording (see Validation plan), then the default APK reinstalled.
    *Check:* evidence committed under `docs/validation/html-reader/`;
    `CARGO_BUILD_JOBS=2 mise run check:all` and the rendered tests green.

## Fixture data

One set of sample files, used by both the Rust synthetic provider and the browser
fake. All addresses use `.example`/`.test`; all remote URLs use the `.invalid`
TLD so nothing can resolve.

New conversations in the Inbox (the synthetic inbox grows from 18 to 24; existing
conversations, their bodies and their facts are unchanged; facts for new ids are
seeded additively under a new seed version):

| Id | Content |
|---|---|
| `conv-19` | Newsletter: 600 px nested tables, `<style>` with media queries, remote images, a tracking pixel, links with display text. Alternative text part present. |
| `conv-20` | HTML-only message from a person: paragraphs, a list, an `https:` link and a `mailto:` link, no colours (adaptive rendering, derived `body_text`). |
| `conv-21` | `multipart/related` with a `cid:` logo (small PNG in the repo) and one remote image. |
| `conv-22` | Reply chain in HTML with a `.gmail_quote` trailing quote and a `blockquote[type=cite]`. |
| `conv-23` | Hostile: scripts, `on*` handlers, `javascript:`/`data:text/html`/entity-encoded hrefs, `<form>`, `<meta http-equiv=refresh>`, `<base>`, `<iframe>`/`<object>`/`<embed>`, inline SVG with script, CSS `@import`/`url()`/`expression()`, a `position: fixed` overlay, `srcset`, `ping`, a link whose text shows another host, a `mailto:` with `subject`/`body` parameters, known mXSS shapes (`<noscript>`, `<style>` in SVG/MathML). |
| `conv-24` | Oversized HTML (over 512 Ki chars) to show the "too large" fallback. |

The browser fake's three existing hostile plain-text conversations stay as they are.
Rust parse tests use Gmail-shaped JSON built in the test helpers for MIME structure
cases the synthetic provider does not model (charset, depth, alternatives).

## Validation plan

- **Rust:** parse tests (decisions 1–3, 6), migration tests, store tests for
  `get_message_html` and eviction, synthetic provider tests, page-budget test
  (a page with large HTML keeps its threads and drops HTML).
- **Frame safety:** stage 1 rendered test in Chrome; runtime guard unit tests;
  build test that the probe is absent from default builds.
- **Sanitiser:** the hostile corpus in jsdom and in real Chrome. Assertions: no
  `script`/`on*`/`href`/remote `src` survive; a parent-side trap
  (`window.__eosPwned`) stays unset; no network request leaves the page with
  images blocked; no frame navigation occurs after clicking every link.
- **Rendered reader tests** (real Chrome, `EMAIL_OS_RUN_RENDERED=1`): frame height
  equals content; newsletter fits at 390 px; Load images issues requests only
  after the click; quoted toggle; keyboard shortcuts still work after clicking
  into the frame; link confirmation shows the real URL; `mailto:` opens New message
  with only To filled.
- **Browser screenshots** (`mise run screenshots:mobile` and a desktop variant) at
  1100 px and 390 px for: newsletter blocked, newsletter after Load images,
  adaptive HTML-only, cid image, quoted reply collapsed/expanded, hostile sample,
  link confirmation, `mailto:` confirmation. Light (paper card) and dark
  (adaptive) mail are both covered inside the dark app. Committed under
  `docs/validation/html-reader/`.
- **Android emulator** (`emulator-5554`, lock file per RULES):
  1. **Probe APK** (built with `VITE_EMAIL_OS_FRAME_PROBE=1`): screenshot of the
     probe view with every line PASS, which repeats the no-script and no-Tauri-
     globals checks on the Android WebView path. Then the default APK is rebuilt
     and reinstalled.
  2. Screenshots of the samples, a long-press text selection, the link
     confirmation, the `mailto:` confirmation, New message with To filled.
  3. One recording (≤ 60 s): open newsletter → Load images → tap link →
     confirmation → Open in browser → browser shows the (unresolvable) URL → Back
     to the reader.
  4. System font scale 1.3 once.
- **macOS:** owner checklist (Owner actions).
- **Gates:** `CARGO_BUILD_JOBS=2 mise run check:all` and the rendered tests above.

## Risks and open questions

Open questions for the coordinator:

1. **Probe APK on the emulator.** The Android no-script check uses a separately
   built probe APK (`VITE_EMAIL_OS_FRAME_PROBE=1`), replaced by the default APK
   afterwards. The alternative, evaluating the checks over Chrome DevTools through
   `adb forward`, is outside the `adb` uses RULES allows. Planned: the probe APK.
2. **Opener pin.** If another track adds a Tauri plugin or moves tauri, the
   `tauri-plugin-opener` 2.5.5 pin is re-checked.

Risks:

- **Webview-injected scripts in frames.** Chrome tests cannot show what Tauri
  injects on WKWebView or Android WebView. Mitigated by the runtime guard (fails
  closed to text) and the probe on the emulator; macOS relies on the owner
  checklist item 4 and the guard. If the guard trips on a platform, HTML is off
  there and option 2c comes back to the coordinator.
- **Webview differences.** CSP inheritance into `about:srcdoc`, `zoom`, and
  sandbox behaviour are checked in Chrome, on the emulator and by the owner on
  macOS.
- **Sanitiser bypass.** Mitigated by three layers (sanitiser, no-script sandbox,
  frame CSP inside the inherited app CSP). The app CSP's new `https:` in `img-src`
  is the one widening; it matters only if an HTML injection reached the app
  document itself, which the reader never does.
- **Opener plugin.** Pinned at 2.5.5 because later 2.x needs tauri 2.12. If
  another track moves tauri, the pin is revisited. The plugin's other commands
  stay unreachable because no `opener:*` permission is granted; a test enforces it.
- **Page budget change** alters sync failure behaviour (HTML dropped instead of a
  failed page). Covered by a test; disclosed in the message.
- **Touch on Android.** Touches that start inside a frame do not reach the
  parent's gesture handlers; horizontal scrolling of very wide mail may compete
  with any reader swipe. Checked on the emulator in stage 11.
- **Cached Gmail mail** keeps plain text until each conversation is refreshed;
  there is no forced rebuild.
- **Fidelity.** Removing `<style>` features (`@font-face`, fixed positioning) and
  inline SVG makes some newsletters look plainer. That is accepted.
