# UX-12 — bounded download-only attachments

## Contract (implementation scope)

Base inspected: `6c30b9c` (UX-05); UX-06/07 are absent and not prerequisites.
No cross-thread changes. Existing reader visits, account-scoped cache, local
drafts, close protocol, setters, bulk receipts and Undo remain unchanged.

Journey: reader → Files and links / native Cmd+O → choose a known cached file
or literal HTTP(S) body link → explicitly save / confirm external browser →
dismiss to exact reader expansion, scroll and focus. Email addresses remain
participant/draft exits, never `mailto:` links. No automatic opening.

Rust owns descriptors, authenticated readonly Gmail fetch and file validation.
Descriptors are cached transactionally in SQLite alongside sync facts; legacy
cache has no descriptors until sync. Bounded to 32 descriptors/thread, nesting
16, request/message IDs 256 bytes, opaque attachment handles 4096 bytes,
filename 160 characters, 5 MiB/file. Both ID classes must be nonempty and contain
only ASCII letters, digits, `-` or `_`; no path/query/fragment delimiters,
percent escapes, padding, controls or non-ASCII. The attachment-specific 4 KiB
ceiling accommodates production-shaped handles longer than 256 bytes (including
the reported 404-character example), with headroom while still bounding GET path
length and cached metadata (at most 32 handles/thread). This is a local defensive
limit, not a claim about Gmail's maximum handle length. Discovery and authenticated
attachment GET use the same attachment validator; request/message validation and
provider URL/authority construction are unchanged. Oversized,
unknown-size and missing attachment bodies fail closed. Fetch verifies cached
account+conversation+message+attachment identity, generation and cancellation.
Retained snapshots cannot fetch; no new scope or mutation permission.

Save is deliberately narrow: a new uniquely named file in the OS Downloads
folder, never a frontend path and never overwrite. Sender filenames are reduced
to ASCII inert names; every download ends `.download` (including Office/HTML),
with no file execution/reveal/automatic external document handler. User can
inspect/rename a saved file outside the app. Saved files are user-owned exports
and remain in Downloads after disconnect; cache cleanup does not delete them.
Acknowledgement follows sync_all;
failed/cancelled partial files are removed (a crash can leave an inert partial
file; there is no resumable-download promise). A blocked HTTP call can take its
existing 30-second timeout to return; cancellation is checked before/after calls,
while reading chunks, and before local publication. Cancellation uses the
existing typed `auth_cancelled` error, not an OAuth state transition.
No durable remote intent is needed:
this is a readonly transfer, not a mailbox operation. Lost save ACK can leave a
completed unique download; retry may create another and is not exactly-once.

Only syntactically valid MIME descriptors are admitted; PDF signatures must
match PDF declarations; text/plain must be UTF-8 without NUL, and obvious HTML
document prefixes are rejected. Unsupported MIME is saved inert, never rendered. Signature/length/base64 checks reject
observable corruption; this is not structural PDF/Office validation or a malware
scanner. No raw bytes/base64/credentials reach Vue.
External links allow only bounded HTTP(S), host required, no credentials or
controls; Rust revalidates before system browser dispatch on macOS. Other OS
external dispatch is unavailable, not a simulated success.

## PDF preview security gate: BLOCKED — spike not run

No restricted macOS platform sandbox spike evidence is available. This checkout
has no implemented restricted document host or evidence of its sandbox policy;
compiling the Tauri app on macOS does not supply that evidence. Do NOT create
a preview webview, use app DOM PDF/HTML, iframe/object/embed or third-party viewer.
PDF is download-only. BROWSE-14 preview acceptance is NOT complete.
Required spike: macOS/OS renderer compatibility, corrupt/encrypted/large PDFs,
no privileged app IPC, no navigation/remote requests (HTTP, file, scripts,
embedded launch actions), sandbox enforcement, teardown and exact return-state
checks. A separate reviewed ADR decision is required before enabling preview.

## Acceptance checklist

- [x] bounded descriptors survive SQLite reopen; legacy and retained cache safe
- [x] authenticated readonly fetch, cancellation and stale-account fencing
- [x] corrupt / oversized / missing / offline transfer failures visible
- [x] filename traversal, protocols, MIME mismatch, Office/HTML inert saves
- [x] chooser never auto-opens; email/draft exits distinct
- [x] external-resource payload never rendered or automatically fetched
- [x] exact expansion/scroll/focus on dismissal; errors permit Back/retry
- [x] generated contracts, IPC registrations/permissions and transport tests
- [x] project core/UI/type/build gates (synthetic evidence below)
- [~] native Mac checks: fixture Cmd+O/keyboard save/Esc return observed (see
  "Native Mac evidence"); system-browser handoff, VoiceOver, Downloads
  denied/cancelled paths and window Close/Cmd+Q remain pending operator
- [ ] approved disposable-provider validation — not authorized/run here

Headless evidence and native evidence must remain separate. No fake establishes
remote convergence, native sandbox security or durable browser-preview storage.

## Validation evidence

The initial UX-12 implementation and testing was performed directly in this
isolated worktree without delegates. The P1 follow-up below used one implementation
worker in this same worktree. Neither phase used merges/cherry-picks, real
mailbox/Keychain access, remote mail writes, external sends, OS package installation,
system document handlers or external-link OS handoff. Locked UI dependencies were installed with `mise run install:ui`.
`Cargo.lock` and frontend dependency declarations are unchanged.

### Headless / synthetic gates

| Command | Final result |
| --- | --- |
| `mise run check` | Passed: core, generated contract, lint, UI and typecheck. |
| `mise run test:core` (rerun after final account-token fencing) | 237 passed: 143 unit + 94 integration tests. |
| `mise run check:contract` | Passed; TypeScript regenerated from Rust via `mise run gen:ts`. |
| `mise run lint:core` | Passed: formatting and clippy `-D warnings`. |
| `mise run test:ui` | 449 passed, 21 opt-in rendered tests skipped. |
| `mise run typecheck` | Passed. |
| `mise run build:web` | Passed. |
| `mise run check:native` | Passed on the macOS build host; compile evidence only. |
| `mise run test:native` | 9 passed; synthetic bridge/core and close-gate tests, no interactive WKWebView or OS handler test. |

Core cases cover bounded descriptors, SQLite reopen and legacy
migration, foreign accounts, message tombstones revoking fetch authority,
missing files, offline reads, oversized content, corrupt base64/length/signature,
coherent expected-account/token snapshots before GET, cancellation before save,
disconnect draining an active fetch, safe filenames and exclusive inert saves.
Office/HTML and PDF external-action fixtures are copied only as opaque inert
bytes. No document parser, decompressor, renderer or resource loader is involved.
Existing bulk/Undo/retained snapshot/draft/close tests remain passing.

Tests and implementation live in `crates/mail-core/src/attachments.rs`, Gmail
provider/store/sync tests, `tests/attachments.component.test.ts`,
`tests/tauri-client.test.ts`, and the native attachment-transfer tests.

### P1 review fix — long opaque attachment handles

The initial shared 256-byte validator silently omitted longer attachment handles
at discovery and rejected them at GET. Only attachment handles now use the
4096-byte bound above; the existing request/message-ID bound and alphabet remain
unchanged. No DTO, frontend, transport, permission or optional P2 changes.

Synthetic regressions in `attachments.rs` and `gmail/provider.rs` cover 257- and
404-character handles, the inclusive 4096-byte maximum and max+1 rejection;
empty/traversal/separator/percent/query/fragment/control/non-ASCII inputs; and
continued rejection of message/request IDs over 256 bytes. Descriptor discovery
and the HTTP fetch seam both exercise their respective bounds. A production-shaped
synthetic multipart full-thread response yields an exact 404-character handle,
persists through SQLite close/reopen and supplies that unchanged handle to an
authenticated readonly GET. It verifies exact thread/attachment request targets,
GET method, loopback authority, bearer authentication, empty request bodies,
foreign-account denial and an inert local save. Conversation unread/body state,
inbox/activity snapshot, generation, pending operations and credentials remain
unchanged. All traffic is synthetic localhost; no real Gmail or native sandbox
validation is implied.

P1 validation (this follow-up only):

| Command | Result |
| --- | --- |
| `mise exec -- cargo test --locked -p mail-core attachment -- --nocapture` | 12 focused tests passed, including the three new regressions. |
| `mise run test:core` | 240 passed: 146 unit + 94 integration tests. |
| `mise run check:contract` | Passed; generated TypeScript unchanged. |
| `mise run lint:core` | Passed: workspace formatting check and core clippy `-D warnings`. |
| `mise run check:native` | Passed; compile-only evidence, no native app launch. |
| `git diff --check` | Passed. |

The parent independently inspected the patch and reran `test:core`,
`check:contract`, `lint:core`, `check:native` and `git diff --check`; all passed
with the same results. Native compilation remains compile-only evidence.

Only the two affected Rust files were formatted. A before/after content-hash
comparison of tracked and non-ignored untracked files confirms changes only to
`attachments.rs`, `gmail/provider.rs` and this contract; unrelated pre-existing
working-tree changes were preserved. No installs, new dependencies, DTO changes,
real credentials/provider calls, OS handoffs, commits or publication. Existing
native/disposable-provider/PDF gates below remain pending; no UI/browser tests
were rerun for this P1-only fix.

### Browser evidence (not native macOS app evidence)

Using the existing opt-in Chrome/CDP runner, existing cached Chrome for Testing
150.0.7871.24 (Mac ARM), fresh synthetic fixture and real CDP key/pointer input:

```sh
EMAIL_OS_RENDERED_LAYOUT_CHROME='<existing Chrome executable>' \
  mise exec -- pnpm exec vitest run tests/reader.rendered.test.ts \
  -t UX-12 --maxWorkers=1 --minWorkers=1
```

**1 passed / 12 filtered out**. Opens reader → expands messages → sets nonzero
reader scroll → opens Files and links → explicitly saves a synthetic HTML file →
Escape → same expanded IDs, exact scroll, same reader DOM and invoking button
focus. Asserts no iframe/object/embed/image, no implicit file save, no mailbox
mutation and no inert shell left behind. Component tests separately cover link
confirmation and protocol/email separation, corrupt/missing/offline error paths,
retained fetch denial, pending cancellation/late response, native shortcut dispatch and
leaving browser-reserved Cmd+O alone. CDP is not actual Mac Cmd+O/WKWebView proof.

### Failures found and repaired during implementation

Initial checks caught missing new methods on test clients, an undeclared test
helper dependency (replaced with dependency-free temporary-directory cleanup),
and a clippy `div_ceil` warning. The static registration test initially used a
file URL in jsdom; it now reads repository-relative source files. A native fixture
save failed the size check because a hand-written length was off by one; native
metadata now derives the byte length from the same fixture constant.

The first new Chrome case exceeded its 5-second default under concurrent build
load; this new multi-step case has a bounded 30-second budget. Subsequent Chrome
runs exposed a real dismissal defect, not just timing: disabling the focused Save
button can leave focus on body, so Escape never reached the chooser. The shell
now gives the top attachment surface Escape ownership even in that focus vacuum;
the invoking button is also passed explicitly for reliable pointer return.
The original exact-state assertions were retained and strengthened with a check
that the chooser and all covered-shell inert state are gone. Final run passed.
Temporary focus diagnostics were removed.

Final full gate logs: background terminal `bt-12` (all gates), followed by
`bt-13` (core/contract/lint/native rerun after coherent account-token fencing).
Logs are local harness artifacts, not native runtime/security certification.

## Native Mac evidence (2026-11-07, `pnpm tauri dev`, native fixture profile)

Observed on the real Tauri/WKWebView window with synthetic fixture data, driven by
real OS key events (System Events) and window screenshots. Not provider evidence.

- Enter on the focused Inbox row opened the reader; the row stayed unread (bold):
  opening and the chooser never marked it read.
- Real **Cmd+O** opened the Files and links chooser listing the single synthetic
  `example.txt` (text/plain, 27 bytes) and "No HTTP(S) links"; focus moved to
  Back to message and the reader behind was inert.
- Tab then Space on **Save to Downloads** wrote
  `~/Downloads/<uuid>-example.txt.download`: 27 bytes, mode `0600`, ASCII text
  `Synthetic attachment only.`; the UI reported "No file was opened."
  The file carries `com.apple.provenance`/`macl` attributes but no
  `com.apple.quarantine` attribute (app-written, not browser-downloaded); it is
  inert by name only, so Gatekeeper quarantine is not provided by this path.
- **Escape** returned to the reader with a byte-identical screenshot to the
  pre-Cmd+O state (same message expanded, same focus ring); a second Escape
  returned to the Inbox list with the same row selected.

Not exercised: Tab/Shift+Tab trap inspection, long-reader scroll restoration,
VoiceOver, permission-denied/cancelled Downloads, HTTP(S) handoff to the system
browser, window Close/Cmd+Q after a draft edit, any real provider fetch.

## Remaining operator gates / intentionally unsupported capabilities

- On a fresh synthetic native fixture profile, exercise real Cmd+O, Tab/Shift+Tab,
  Escape, long reader scrolling and VoiceOver. Explicitly save the synthetic file
  and check Downloads permission-denied/cancelled paths and inert naming. Do not
  delete an existing user profile to run the fixture.
- Exercise normal window Close and Cmd+Q immediately after a local draft edit;
  confirm the existing draft durability protections while the reader/chooser
  entry points remain available. Headless close-gate tests are not this check.
- Verify explicit HTTP(S) handoff to the macOS system browser and return to the
  same reader. No OS handoff was launched in automated validation. File handlers,
  custom protocols and `mailto:` are deliberately unsupported. Non-macOS external
  dispatch fails visibly; there is no shell/plugin fallback.
- Provider validation requires separate operator approval and a disposable Gmail
  account: same-account authenticated readonly attachment fetch, missing/offline
  errors, cancellation, disconnect races and no read-state/provider mutation.
  No remote convergence or real OAuth/Keychain behavior is claimed here.
- PDF preview remains blocked. A future spike must select and validate an actual
  restricted platform document host, prove no privileged app IPC or arbitrary
  filesystem access, and record blocked HTTP/file/JavaScript/embedded launch and
  remote-resource attempts across supported macOS/renderer versions. Include
  corrupt, encrypted and oversized PDF compatibility/error recovery and exact
  focus/scroll return. A new reviewed ADR decision is needed before enabling it.
  No new webview or third-party viewer is presumed safe.

BROWSE-14 is **partial / download-only**, not complete. No commit or publication
was created during this implementation; the working tree is based on `6c30b9c`.
