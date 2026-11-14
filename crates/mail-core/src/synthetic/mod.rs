//! Built-in synthetic mail provider (ADR 0002).
//!
//! The 18-conversation mailbox of fixture mode, served through the same
//! [`GmailProvider`](crate::gmail::types::GmailProvider) seam the live Gmail
//! provider implements, so the operation ledger (acceptance, undo, groups,
//! reminders) lives once, in `GmailCore`. This is production code: it holds no
//! credentials, opens no sockets and does not depend on the `test-support`
//! feature (the dependency direction is testing → production).
//!
//! * [`data`] — the fixed conversations, shared with the legacy fixture seed.
//! * `facts` — durable provider facts (per-message INBOX/UNREAD/STARRED and a
//!   change log) in a SQLite file of their own, seeded exactly once.
//! * [`SyntheticGmailProvider`] — the trait implementation plus the fake
//!   pause/reject controls for synthetic writes.

pub(crate) mod data;
mod facts;
mod provider;

pub use provider::{SyntheticGmailProvider, SYNTHETIC_ATTACHMENT_BYTES, SYNTHETIC_DB_FILE};
