//! Concrete SQLite store for the Gmail profile (docs/vertical-slice-03.md): a
//! dedicated schema and database file (`gmail.db`) separate from the fixture
//! store, account-scoped conversation/message facts and mailbox operations,
//! per-message label membership, and resumable
//! discovery/history checkpoints. Cached facts and their page/cursor
//! checkpoints commit in one short serialized transaction; the network never
//! runs inside a lock. Every persistence error maps to
//! [`MailError::StorageUnavailable`] and is surfaced — nothing is
//! logged-and-ignored, and no mail content, addresses, or credentials are
//! ever logged.

use std::collections::HashMap;
use std::path::Path;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};

use crate::clock::Clock;
use crate::drafts::types::ReplyContext;
use crate::dto::{
    Address, Conversation, ConversationRef, ConversationSummary, InboxSnapshot,
    MailboxOperationKind, Message, OperationFailure, OperationReceipt, OperationStatus,
    OperationSummary, RetryOperation, SetArchived, SetRead, UndoOperation, UndoOutcome,
    UndoReceipt, UndoUnavailableReason,
};
use crate::error::MailError;
use crate::gmail::types::{AccountInfo, GmailProfile, GmailThread, HistoryPage};
use crate::groups::{GroupMemberRejection, OperationGroupReceipt, OperationGroupStatus};

/// Cache cap: at most this many conversations are retained after a completed
/// discovery/history pass. Disclosed to the wire through `SyncInfo.coverageLimit`.
pub(crate) const DISCOVERY_CAP: usize = 100;

const SCHEMA_VERSION: &str = "gmail-migrations-9";

#[path = "store/acceptance.rs"]
mod acceptance;
#[path = "store/activity.rs"]
mod activity;
#[path = "store/cache.rs"]
mod cache;
#[path = "store/destinations.rs"]
mod destinations;
#[path = "store/group_acceptance.rs"]
mod group_acceptance;
#[path = "store/group_queries.rs"]
mod group_queries;
#[path = "store/group_undo.rs"]
mod group_undo;
#[path = "store/ingestion.rs"]
mod ingestion;
#[cfg(test)]
#[path = "migration_tests.rs"]
mod migration_tests;
#[path = "store/profile.rs"]
mod profile;
#[path = "store/reminders.rs"]
mod reminders;
#[path = "store_schema.rs"]
mod schema;
use activity::*;
#[path = "store/cache_rows.rs"]
mod cache_rows;
use cache_rows::*;
#[path = "store/group_rows.rs"]
mod group_rows;
use group_rows::*;
#[path = "store/operation_rows.rs"]
mod operation_rows;
use operation_rows::*;
#[path = "store/search_support.rs"]
mod search_support;
use search_support::*;
#[path = "store/undo_support.rs"]
mod undo_support;
use undo_support::*;
#[path = "store/search.rs"]
mod search;
#[path = "store/undo.rs"]
mod undo;
#[path = "store/worker.rs"]
mod worker;

/// Outcome of a checkpointed write. [`Commit::Discarded`] means the write
/// lost a disconnect race: the account was cleared mid-pass, so the stale
/// result must not repopulate the cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Commit {
    Applied,
    Discarded,
}

/// In-process observation fence. All profile writes use the store's one SQLite
/// connection; total_changes includes deletions and even rolled-back writes.
/// Rejecting *any* intervening write is intentionally conservative (Busy/retry),
/// and avoids a tombstone growing for every historically deleted message.
pub(crate) enum SearchObservation {
    Cached {
        generation: u64,
        members: Vec<ConversationRef>,
    },
    Fetched {
        generation: u64,
        revision: u64,
        threads: Vec<GmailThread>,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct OperationRecord {
    pub account_id: String,
    pub operation_id: String,
    pub generation: u64,
    pub conversation_id: String,
    pub kind: MailboxOperationKind,
    pub value: bool,
    pub status: OperationStatus,
    pub message_ids: Vec<String>,
}

struct OperationAcceptance<'a> {
    conversation: &'a ConversationRef,
    kind: MailboxOperationKind,
    value: bool,
    request_id: &'a str,
    payload: &'a str,
    clone_targets_from: Option<&'a str>,
    /// Undo compensations target exactly the preimage group; targets are
    /// never re-derived from current facts.
    explicit_targets: Option<Vec<String>>,
    /// Set only for undo compensations; points at the undone operation.
    undo_of: Option<&'a str>,
    /// Top-level action identity (docs/ux-05-safe-bulk-processing.md §5):
    /// set only for group children (their group id). Singles and retries
    /// derive their own action id; compensations have none.
    action_id: Option<&'a str>,
    /// Set only for retry acceptance; inspection link to the retried
    /// operation (backend-only; not part of the wire DTOs).
    retry_of: Option<&'a str>,
    accepted_at: &'a str,
}

/// Resumable initial-discovery progress. `Pending` means the baseline cursor
/// is pinned but no page has committed yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DiscoveryProgress {
    Pending,
    Running { page_token: Option<String> },
    Done,
}

/// History catch-up progress. `Resuming` carries the batch's original start
/// id plus the next page token, so an interrupted batch replays safely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HistoryProgress {
    Idle {
        cursor: Option<String>,
    },
    Resuming {
        batch_start: String,
        page_token: Option<String>,
    },
}

/// One fetched thread: fresh provider facts, or [`ThreadFetch::Missing`] when
/// the provider reports the thread deleted/not found.
#[derive(Clone)]
pub(crate) enum ThreadFetch {
    Cached(Box<GmailThread>),
    Missing(String),
}

impl ThreadFetch {
    fn id(&self) -> &str {
        match self {
            ThreadFetch::Cached(thread) => &thread.conversation.conversation_ref.conversation_id,
            ThreadFetch::Missing(id) => id,
        }
    }
}

pub(crate) struct GmailStore {
    conn: Mutex<Connection>,
    clock: Arc<dyn Clock>,
    /// Test-only injection so persistence-failure behavior is deterministically
    /// observable; `cfg(test)` keeps it out of the shipped crate.
    #[cfg(test)]
    injected_persistence_failure: AtomicBool,
}

impl std::fmt::Debug for GmailStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately opaque: never debug-print connection contents
        // (which could include message data).
        f.debug_struct("GmailStore").finish_non_exhaustive()
    }
}

impl GmailStore {
    // ---------------------------------------------------------------- reads

    // --------------------------------------------------------------- writes
}

// ------------------------------------------------------------------ helpers

#[cfg(test)]
#[path = "newest_sender_tests.rs"]
mod newest_sender_tests;

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
