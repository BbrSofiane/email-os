# Stage 7 Android Gmail smoke

The local debug APK on Android 15 x86_64 used the registered debug signer
and the existing disposable test account. The smoke started on `abbd412`
and finished on `c42e8fe` after updating the app to allow replies to
self-addressed messages.

- The account already had mailbox actions enabled. **Enable sending**
  completed in Account without another provider prompt.
- A separate draft was queued and undone within five seconds. Its To,
  subject, and body were restored. Activity showed **Not sent** and it
  was absent from Gmail Sent.
- A new message and a reply went only to the connected mailbox. The
  approved recipient was checked against the compose fields before each
  Send. Cc was empty.
- Both sends were **Sent** in Activity. The ledger showed two distinct
  provider message IDs and one common thread ID. Opening the conversation
  from Gmail Sent displayed both messages.

The captures retain status labels and mask the rest of the live interface.
[Activity](stage-7-activity-redacted.png) · [Sent](stage-7-sent-redacted.png)
