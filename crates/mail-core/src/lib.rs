//! `mail-core`: the headless mail core.
//!
//! Owns the frozen wire DTOs, the Gmail SQLite store and its durable
//! receipts/request-key deduplication, the cancellable sync worker, OAuth and
//! profile lifecycle, provider sync and mailbox operations. Fixture mode runs
//! this same core on the built-in synthetic provider ([`synthetic`], ADR 0002);
//! a legacy fixture database is retired once by [`fixture_transition`].

pub mod attachments;
mod cached_done;
pub mod cancel;
pub mod clock;
pub mod drafts;
pub mod dto;
pub mod error;
pub mod fixture_transition;
pub mod gmail;
pub mod groups;
mod lock;
pub mod reminders;
pub mod search;
pub mod splits;
pub mod stars;
mod storage_log;
pub mod synthetic;
#[cfg(any(test, feature = "test-support"))]
pub mod testing;

pub use cancel::CancelToken;
pub use error::MailError;

/// The single synthetic fixture account.
pub const ACCOUNT_ID: &str = "fixture-account";
/// The fixture's primary mailbox, shared by reader/reply/account metadata.
pub const FIXTURE_MAILBOX: &str = "you@fixture.emailos";
