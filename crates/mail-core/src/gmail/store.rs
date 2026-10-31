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

const SCHEMA_VERSION: &str = "gmail-2";

/// Outcome of a checkpointed write. [`Commit::Discarded`] means the write
/// lost a disconnect race: the account was cleared mid-pass, so the stale
/// result must not repopulate the cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Commit {
    Applied,
    Discarded,
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
    pub(crate) fn open(profile_dir: &Path, clock: Arc<dyn Clock>) -> Result<GmailStore, MailError> {
        std::fs::create_dir_all(profile_dir).map_err(|_| MailError::StorageUnavailable)?;
        let db_path = profile_dir.join("gmail.db");
        let conn = Connection::open(&db_path).map_err(|_| MailError::StorageUnavailable)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| MailError::StorageUnavailable)?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(|_| MailError::StorageUnavailable)?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|_| MailError::StorageUnavailable)?;
        let store = GmailStore {
            conn: Mutex::new(conn),
            clock,
            #[cfg(test)]
            injected_persistence_failure: AtomicBool::new(false),
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), MailError> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS gmail_conversations (
                account_id         TEXT NOT NULL,
                conversation_id    TEXT NOT NULL,
                subject            TEXT NOT NULL,
                context_complete   INTEGER NOT NULL CHECK (context_complete IN (0, 1)),
                unsupported_reason TEXT,
                reply_context_json  TEXT,
                PRIMARY KEY (account_id, conversation_id)
            );
            CREATE TABLE IF NOT EXISTS gmail_messages (
                account_id      TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                message_id      TEXT NOT NULL,
                from_display    TEXT,
                from_mailbox    TEXT NOT NULL,
                to_json         TEXT NOT NULL,
                sent_at         TEXT NOT NULL,
                body_text       TEXT NOT NULL,
                in_inbox        INTEGER NOT NULL CHECK (in_inbox IN (0, 1)),
                PRIMARY KEY (account_id, conversation_id, message_id)
            );
            CREATE TABLE IF NOT EXISTS gmail_discovery_seen (
                conversation_id TEXT PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS gmail_inbox_membership (
                account_id      TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                message_id      TEXT NOT NULL,
                PRIMARY KEY (account_id, conversation_id, message_id)
            );
            CREATE TABLE IF NOT EXISTS gmail_message_facts (
                account_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                in_inbox INTEGER,
                is_unread INTEGER,
                PRIMARY KEY (account_id, conversation_id, message_id)
            );
            CREATE TABLE IF NOT EXISTS gmail_operations (
                account_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                requested_value INTEGER NOT NULL,
                status TEXT NOT NULL,
                failure TEXT,
                last_error TEXT,
                accepted_seq INTEGER NOT NULL,
                accepted_at TEXT NOT NULL,
                request_id TEXT NOT NULL,
                PRIMARY KEY (account_id, operation_id)
            );
            CREATE TABLE IF NOT EXISTS gmail_operation_targets (
                account_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                PRIMARY KEY (account_id, operation_id, message_id)
            );
            CREATE TABLE IF NOT EXISTS gmail_operation_requests (
                account_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                accepted_at TEXT,
                PRIMARY KEY (account_id, request_id)
            );
            CREATE TABLE IF NOT EXISTS gmail_operation_preimages (
                account_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                prior_value INTEGER NULL CHECK (prior_value IN (0, 1)),
                PRIMARY KEY (account_id, operation_id, message_id)
            );
            CREATE TABLE IF NOT EXISTS gmail_operation_snapshots (
                account_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                snapshot_saved_at TEXT NOT NULL,
                PRIMARY KEY (account_id, conversation_id)
            );
            CREATE TABLE IF NOT EXISTS gmail_operation_groups (
                group_id      TEXT PRIMARY KEY,
                account_id    TEXT NOT NULL,
                request_id    TEXT NOT NULL,
                kind          TEXT NOT NULL,
                requested_value INTEGER NOT NULL CHECK (requested_value IN (0, 1)),
                accepted_at   TEXT NOT NULL,
                undone_at     TEXT,
                group_seq     INTEGER NOT NULL,
                UNIQUE (account_id, request_id)
            );
            CREATE TABLE IF NOT EXISTS gmail_operation_group_members (
                account_id      TEXT NOT NULL,
                group_id        TEXT NOT NULL,
                ordinal         INTEGER NOT NULL,
                conversation_id TEXT NOT NULL,
                operation_id    TEXT,
                rejection       TEXT,
                undo_decision   TEXT,
                undo_skip_reason TEXT,
                undo_operation_ids TEXT,
                PRIMARY KEY (account_id, group_id, ordinal)
            );",
        )
        .map_err(|_| MailError::StorageUnavailable)?;

        let has_reply_context_column = {
            let mut stmt = tx
                .prepare("PRAGMA table_info(gmail_conversations)")
                .map_err(|_| MailError::StorageUnavailable)?;
            let columns = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|_| MailError::StorageUnavailable)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| MailError::StorageUnavailable)?;
            columns.iter().any(|column| column == "reply_context_json")
        };
        if !has_reply_context_column {
            tx.execute(
                "ALTER TABLE gmail_conversations ADD COLUMN reply_context_json TEXT",
                [],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        }

        let has_snapshot_sort_column = {
            let mut stmt = tx
                .prepare("PRAGMA table_info(gmail_operation_snapshots)")
                .map_err(|_| MailError::StorageUnavailable)?;
            let columns = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|_| MailError::StorageUnavailable)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| MailError::StorageUnavailable)?;
            columns.iter().any(|column| column == "last_message_at")
        };
        if !has_snapshot_sort_column {
            // One-time additive migration; page reads never parse unselected bodies.
            tx.execute_batch("ALTER TABLE gmail_operation_snapshots ADD COLUMN last_message_at TEXT NOT NULL DEFAULT '';
                UPDATE gmail_operation_snapshots SET last_message_at = COALESCE(json_extract(snapshot_json, '$.messages[#-1].sentAt'), '');")
                .map_err(|_| MailError::StorageUnavailable)?;
        }

        let has_undo_of_column = {
            let mut stmt = tx
                .prepare("PRAGMA table_info(gmail_operations)")
                .map_err(|_| MailError::StorageUnavailable)?;
            let columns = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|_| MailError::StorageUnavailable)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| MailError::StorageUnavailable)?;
            columns.iter().any(|column| column == "undo_of")
        };
        if !has_undo_of_column {
            // Undo of the latest operation (docs/ux-04-trustworthy-undo.md §3.5):
            // the id of the operation this row compensates, NULL otherwise.
            tx.execute("ALTER TABLE gmail_operations ADD COLUMN undo_of TEXT", [])
                .map_err(|_| MailError::StorageUnavailable)?;
        }
        let has_request_accepted_at_column = {
            let mut stmt = tx
                .prepare("PRAGMA table_info(gmail_operation_requests)")
                .map_err(|_| MailError::StorageUnavailable)?;
            let columns = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|_| MailError::StorageUnavailable)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| MailError::StorageUnavailable)?;
            columns.iter().any(|column| column == "accepted_at")
        };
        if !has_request_accepted_at_column {
            // Only undo requests need their own acceptance time persisted so an
            // idempotent replay reconstructs the exact committed receipt.
            tx.execute(
                "ALTER TABLE gmail_operation_requests ADD COLUMN accepted_at TEXT",
                [],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        }
        // UX-05 (docs/ux-05-safe-bulk-processing.md §4.2): group tables come
        // from the idempotent batch above; operations gain their top-level
        // action-order identity and retry linkage. Backfill: standalone
        // setters are their own action; compensations belong to none.
        // Existing operations, requests, preimages and undo links are
        // preserved untouched.
        if !has_column(&tx, "gmail_operations", "action_id")? {
            tx.execute("ALTER TABLE gmail_operations ADD COLUMN action_id TEXT", [])
                .map_err(|_| MailError::StorageUnavailable)?;
        }
        if !has_column(&tx, "gmail_operations", "retry_of")? {
            tx.execute("ALTER TABLE gmail_operations ADD COLUMN retry_of TEXT", [])
                .map_err(|_| MailError::StorageUnavailable)?;
        }
        tx.execute(
            "UPDATE gmail_operations SET action_id = operation_id
             WHERE undo_of IS NULL AND action_id IS NULL",
            [],
        )
        .map_err(|_| MailError::StorageUnavailable)?;

        let version: Option<String> = meta_get(&tx, "schema_version")?;
        match version.as_deref() {
            Some(v) if v == SCHEMA_VERSION || v == "gmail-1" => {}
            Some(_) => return Err(MailError::StorageUnavailable),
            None => {
                tx.execute(
                    "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)",
                    params![SCHEMA_VERSION],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
            }
        }
        // Existing profiles stored INBOX membership on renderable message rows.
        // Preserve those facts while allowing unsupported messages to keep
        // membership without a decoded body row.
        tx.execute(
            "INSERT OR IGNORE INTO gmail_inbox_membership
             (account_id, conversation_id, message_id)
             SELECT account_id, conversation_id, message_id FROM gmail_messages WHERE in_inbox = 1",
            [],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "INSERT OR IGNORE INTO gmail_message_facts
             (account_id, conversation_id, message_id, in_inbox, is_unread)
             SELECT account_id, conversation_id, message_id, in_inbox, NULL FROM gmail_messages",
            [],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "INSERT OR IGNORE INTO gmail_message_facts
             (account_id, conversation_id, message_id, in_inbox, is_unread)
             SELECT account_id, conversation_id, message_id, 1, NULL FROM gmail_inbox_membership",
            [],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        // A process crash after claiming a setter is uncertain, never a safe
        // reason to replay it. Reconciliation precedes any explicit retry.
        tx.execute(
            "UPDATE gmail_operations SET status = 'outcome_unknown', last_error = NULL
             WHERE status = 'applying'",
            [],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('generation', '0')",
            [],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(())
    }

    /// Fail-closed gate; under `cfg(test)` it can simulate persistence loss.
    fn persistence_gate(&self) -> Result<(), MailError> {
        #[cfg(test)]
        if self.injected_persistence_failure.load(Ordering::SeqCst) {
            return Err(MailError::StorageUnavailable);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn set_test_persistence_failure(&self, on: bool) {
        self.injected_persistence_failure
            .store(on, Ordering::SeqCst);
    }

    fn lock_conn(&self) -> Result<MutexGuard<'_, Connection>, MailError> {
        self.conn.lock().map_err(|_| MailError::StorageUnavailable)
    }

    // ---------------------------------------------------------------- reads

    pub(crate) fn account(&self) -> Result<Option<AccountInfo>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let account_id = meta_get(&conn, "account_id")?;
        let email_address = meta_get(&conn, "email_address")?;
        Ok(account_id
            .zip(email_address)
            .map(|(account_id, email_address)| AccountInfo {
                account_id,
                email_address,
            }))
    }

    pub(crate) fn has_account(&self) -> Result<bool, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        Ok(meta_get(&conn, "account_id")?.is_some())
    }

    pub(crate) fn generation(&self) -> Result<u64, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        generation_of(&conn)
    }

    /// The committed final history cursor. Advanced only after every page of
    /// a history batch has been applied.
    #[cfg(test)]
    pub(crate) fn cursor(&self) -> Result<Option<String>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        meta_get(&conn, "history_id")
    }

    pub(crate) fn discovery(&self) -> Result<DiscoveryProgress, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let state = meta_get(&conn, "discovery_state")?;
        match state.as_deref() {
            Some("done") => Ok(DiscoveryProgress::Done),
            Some("running") => Ok(DiscoveryProgress::Running {
                page_token: meta_get(&conn, "discovery_page_token")?,
            }),
            _ => Ok(DiscoveryProgress::Pending),
        }
    }

    pub(crate) fn history(&self) -> Result<HistoryProgress, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        if let Some(batch_start) = meta_get(&conn, "history_batch_start")? {
            return Ok(HistoryProgress::Resuming {
                batch_start,
                page_token: meta_get(&conn, "history_page_token")?,
            });
        }
        Ok(HistoryProgress::Idle {
            cursor: meta_get(&conn, "history_id")?,
        })
    }

    /// Conversation ids already observed by the current discovery run (used
    /// for cross-page dedup and stale-membership reconciliation).
    pub(crate) fn seen_ids(&self) -> Result<Vec<String>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare("SELECT conversation_id FROM gmail_discovery_seen")
            .map_err(|_| MailError::StorageUnavailable)?;
        let collected = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
        Ok(collected)
    }

    pub(crate) fn cached_count(&self) -> Result<usize, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        match meta_get(&conn, "account_id")? {
            Some(account_id) => {
                let count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM gmail_conversations WHERE account_id = ?1",
                        params![account_id],
                        |row| row.get(0),
                    )
                    .map_err(|_| MailError::StorageUnavailable)?;
                Ok(count as usize)
            }
            None => Ok(0),
        }
    }

    pub(crate) fn last_synced_at(&self) -> Result<Option<String>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        meta_get(&conn, "last_synced_at")
    }

    pub(crate) fn discovery_done(&self) -> Result<bool, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        Ok(meta_get(&conn, "discovery_state")?.as_deref() == Some("done"))
    }

    /// Effective inbox and durable mailbox-operation activity.
    pub(crate) fn list_snapshot(&self) -> Result<InboxSnapshot, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let account_id = match meta_get(&conn, "account_id")? {
            Some(account_id) => account_id,
            None => {
                return Ok(InboxSnapshot {
                    conversations: Vec::new(),
                    activity: Vec::new(),
                })
            }
        };
        let mut stmt = conn
            .prepare(
                "SELECT c.conversation_id FROM gmail_conversations c
                 WHERE c.account_id = ?1 AND (EXISTS (
                     SELECT 1 FROM gmail_message_facts f
                     WHERE f.account_id = c.account_id
                       AND f.conversation_id = c.conversation_id
                       AND COALESCE(f.in_inbox, 0) = 1)
                    OR EXISTS (
                     SELECT 1 FROM gmail_operations o
                     JOIN gmail_operation_targets t
                       ON t.account_id = o.account_id AND t.operation_id = o.operation_id
                     WHERE o.account_id = c.account_id
                       AND o.conversation_id = c.conversation_id
                       AND o.kind = 'archive' AND o.requested_value = 0
                       AND o.status IN ('queued', 'applying', 'outcome_unknown')
                       AND t.conversation_id = c.conversation_id))",
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        let ids = stmt
            .query_map([&account_id], |row| row.get::<_, String>(0))
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
        let mut summaries = Vec::with_capacity(ids.len());
        for conversation_id in ids {
            let Some(built) = build_conversation(&conn, &account_id, &conversation_id)? else {
                continue;
            };
            let (is_in_inbox, is_read, pending_operation_id) =
                effective_conversation_state(&conn, &account_id, &conversation_id)?;
            if !is_in_inbox {
                continue;
            }
            summaries.push(ConversationSummary {
                conversation_ref: built.conversation_ref,
                subject: built.subject,
                participants: participants_of(&built.messages),
                primary_correspondent: built.messages.last().map(|m| m.from.clone()),
                is_read,
                preview: preview_of(&built.messages),
                last_message_at: built
                    .messages
                    .last()
                    .map(|m| m.sent_at.clone())
                    .unwrap_or_default(),
                pending_operation_id,
            });
        }
        summaries.sort_by(|a, b| {
            b.last_message_at.cmp(&a.last_message_at).then_with(|| {
                a.conversation_ref
                    .conversation_id
                    .cmp(&b.conversation_ref.conversation_id)
            })
        });
        let activity = load_activity(&conn, &account_id, self.clock.as_ref())?;
        Ok(InboxSnapshot {
            conversations: summaries,
            activity,
        })
    }

    pub(crate) fn list_cached_done(
        &self,
        request: &crate::dto::CachedDoneRequest,
    ) -> Result<crate::dto::CachedDoneSnapshot, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let account = meta_get(&conn, "account_id")?.ok_or(MailError::NotFound)?;
        let position = crate::cached_done::validate(request, &account)?;
        // Only durable archive evidence qualifies, never arbitrary absence of INBOX.
        // Bodies remain bounded to the requested candidate page, including recovery data.
        let mut stmt = conn.prepare(
            "WITH candidates AS (
                SELECT o.conversation_id, COALESCE(
                    (SELECT MAX(m.sent_at) FROM gmail_messages m WHERE m.account_id = o.account_id AND m.conversation_id = o.conversation_id),
                    s.last_message_at, '') AS date
                FROM gmail_operations o LEFT JOIN gmail_operation_snapshots s
                ON s.account_id = o.account_id AND s.conversation_id = o.conversation_id
                WHERE o.account_id = ?1 AND o.kind = 'archive' AND o.requested_value = 1
                AND o.status IN ('queued', 'applying', 'confirmed', 'outcome_unknown')
                AND (s.conversation_id IS NOT NULL OR EXISTS (SELECT 1 FROM gmail_conversations c
                    WHERE c.account_id = o.account_id AND c.conversation_id = o.conversation_id))
                AND NOT EXISTS (
                    SELECT 1 FROM gmail_operations u
                    WHERE u.account_id = o.account_id AND u.undo_of = o.operation_id
                    AND u.status IN ('queued', 'applying', 'confirmed', 'outcome_unknown'))
                GROUP BY o.conversation_id)
             SELECT date, conversation_id FROM candidates
             WHERE ?2 IS NULL OR date < ?2 OR (date = ?2 AND conversation_id > ?3)
             ORDER BY date DESC, conversation_id ASC LIMIT ?4"
        ).map_err(|_| MailError::StorageUnavailable)?;
        let candidates = stmt
            .query_map(
                params![
                    account,
                    position.as_ref().map(|p| &p.0),
                    position.as_ref().map(|p| &p.1),
                    request.limit + 1
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
        let mut summaries = Vec::new();
        for (_, id) in candidates.iter().take(request.limit as usize) {
            let effective = effective_conversation_state_with_coverage(&conn, &account, id)?;
            let (inbox, is_read, pending_operation_id, known) = (
                effective.inbox,
                effective.is_read,
                effective.pending_operation_id,
                effective.coverage_known,
            );
            if inbox || !known {
                continue;
            }
            let built = if let Some(built) = build_conversation(&conn, &account, id)? {
                built
            } else {
                let json: String = conn.query_row("SELECT snapshot_json FROM gmail_operation_snapshots WHERE account_id = ?1 AND conversation_id = ?2", params![account, id], |row| row.get(0)).map_err(|_| MailError::StorageUnavailable)?;
                let snapshot: Conversation =
                    serde_json::from_str(&json).map_err(|_| MailError::StorageUnavailable)?;
                BuiltConversation {
                    conversation_ref: snapshot.conversation_ref,
                    subject: snapshot.subject,
                    messages: snapshot.messages,
                    context_complete: snapshot.context_complete,
                    unsupported_reason: snapshot.unsupported_reason,
                    reply_context: snapshot.reply_context,
                }
            };
            summaries.push(ConversationSummary {
                conversation_ref: built.conversation_ref,
                subject: built.subject,
                participants: participants_of(&built.messages),
                primary_correspondent: built.messages.last().map(|m| m.from.clone()),
                is_read,
                preview: preview_of(&built.messages),
                last_message_at: built
                    .messages
                    .last()
                    .map(|m| m.sent_at.clone())
                    .unwrap_or_default(),
                pending_operation_id,
            });
        }
        Ok(crate::cached_done::finish(
            request,
            &candidates,
            summaries,
            meta_get(&conn, "last_synced_at")?,
        ))
    }

    /// Full reader view of one conversation, scoped by the connected account.
    pub(crate) fn get_conversation(
        &self,
        r#ref: &ConversationRef,
    ) -> Result<Conversation, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let Some(account_id) = meta_get(&conn, "account_id")? else {
            return Err(MailError::NotFound);
        };
        if account_id != r#ref.account_id {
            return Err(MailError::NotFound);
        }
        let built = build_conversation(&conn, &account_id, &r#ref.conversation_id)?;
        let recovered = if let Some(built) = built {
            built
        } else {
            let recovered: Option<(String, String)> = conn
                .query_row(
                    "SELECT snapshot_json, snapshot_saved_at FROM gmail_operation_snapshots
                     WHERE account_id = ?1 AND conversation_id = ?2",
                    params![account_id, r#ref.conversation_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|_| MailError::StorageUnavailable)?;
            let (json, saved_at) = recovered.ok_or(MailError::NotFound)?;
            let mut snapshot: Conversation =
                serde_json::from_str(&json).map_err(|_| MailError::StorageUnavailable)?;
            snapshot.retained_snapshot_at = Some(saved_at);
            let (is_in_inbox, is_read, pending_operation_id) =
                effective_conversation_state(&conn, &account_id, &r#ref.conversation_id)?;
            snapshot.is_in_inbox = is_in_inbox;
            snapshot.is_read = is_read;
            snapshot.pending_operation_id = pending_operation_id;
            return Ok(snapshot);
        };
        let (is_in_inbox, is_read, pending_operation_id) =
            effective_conversation_state(&conn, &account_id, &r#ref.conversation_id)?;
        Ok(Conversation {
            conversation_ref: recovered.conversation_ref,
            subject: recovered.subject,
            messages: recovered.messages,
            is_in_inbox,
            is_read,
            context_complete: recovered.context_complete,
            unsupported_reason: recovered.unsupported_reason,
            retained_snapshot_at: None,
            reply_context: recovered.reply_context,
            pending_operation_id,
        })
    }

    /// Saves only reply metadata when the cached account, generation, and
    /// latest source message still match the read that fetched it.
    pub(crate) fn save_reply_context(
        &self,
        r#ref: &ConversationRef,
        source_message_id: &str,
        reply_context: &ReplyContext,
        expected_generation: u64,
    ) -> Result<bool, MailError> {
        self.persistence_gate()?;
        if reply_context.source_message_id != source_message_id {
            return Ok(false);
        }
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        if meta_get(&tx, "account_id")?.as_deref() != Some(r#ref.account_id.as_str())
            || !generation_matches(&tx, expected_generation)?
        {
            return Ok(false);
        }
        let cache_state: Option<(i64, String)> = tx
            .query_row(
                "SELECT c.context_complete, m.message_id FROM gmail_conversations c
                 JOIN gmail_messages m
                   ON m.account_id = c.account_id AND m.conversation_id = c.conversation_id
                 WHERE c.account_id = ?1 AND c.conversation_id = ?2
                 ORDER BY m.sent_at DESC, m.message_id DESC LIMIT 1",
                params![r#ref.account_id, r#ref.conversation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| MailError::StorageUnavailable)?;
        if !cache_state
            .is_some_and(|(complete, latest_id)| complete == 1 && latest_id == source_message_id)
        {
            return Ok(false);
        }
        let reply_context_json =
            serde_json::to_string(reply_context).map_err(|_| MailError::StorageUnavailable)?;
        let updated = tx
            .execute(
                "UPDATE gmail_conversations SET reply_context_json = ?1
                 WHERE account_id = ?2 AND conversation_id = ?3
                   AND context_complete = 1 AND reply_context_json IS NULL",
                params![reply_context_json, r#ref.account_id, r#ref.conversation_id],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        if updated != 1 {
            return Ok(false);
        }
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(true)
    }

    // --------------------------------------------------------------- writes

    pub(crate) fn accept_archived(
        &self,
        command: &SetArchived,
    ) -> Result<OperationReceipt, MailError> {
        self.accept_new_operation(
            &command.conversation,
            MailboxOperationKind::Archive,
            command.archived,
            &command.request_id,
            serde_json::json!({
                "accountId": command.conversation.account_id,
                "conversationId": command.conversation.conversation_id,
                "kind": "archive",
                "value": command.archived,
            })
            .to_string(),
        )
    }

    pub(crate) fn accept_read(&self, command: &SetRead) -> Result<OperationReceipt, MailError> {
        self.accept_new_operation(
            &command.conversation,
            MailboxOperationKind::Read,
            command.read,
            &command.request_id,
            serde_json::json!({
                "accountId": command.conversation.account_id,
                "conversationId": command.conversation.conversation_id,
                "kind": "read",
                "value": command.read,
            })
            .to_string(),
        )
    }

    fn accept_new_operation(
        &self,
        conversation: &ConversationRef,
        kind: MailboxOperationKind,
        value: bool,
        request_id: &str,
        payload: String,
    ) -> Result<OperationReceipt, MailError> {
        validate_request_id(request_id)?;
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account_id = account_id_of(&tx)?;
        if account_id != conversation.account_id {
            return Err(MailError::NotFound);
        }
        if let Some(receipt) = existing_receipt(&tx, &account_id, request_id, &payload)? {
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(receipt);
        }
        let accepted_at = self.clock.now_iso();
        let receipt = accept_operation_tx(
            &tx,
            &account_id,
            OperationAcceptance {
                conversation,
                kind,
                value,
                request_id,
                payload: &payload,
                clone_targets_from: None,
                explicit_targets: None,
                undo_of: None,
                action_id: None,
                retry_of: None,
                accepted_at: &accepted_at,
            },
        )?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(receipt)
    }

    pub(crate) fn accept_retry(
        &self,
        command: &RetryOperation,
    ) -> Result<OperationReceipt, MailError> {
        validate_request_id(&command.request_id)?;
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account_id = account_id_of(&tx)?;
        let payload = serde_json::json!({ "retryOperationId": command.operation_id }).to_string();
        if let Some(receipt) = existing_receipt(&tx, &account_id, &command.request_id, &payload)? {
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(receipt);
        }
        let original =
            load_operation(&tx, &account_id, &command.operation_id)?.ok_or(MailError::NotFound)?;
        if !matches!(
            original.status,
            OperationStatus::Failed | OperationStatus::OutcomeUnknown
        ) {
            return Err(MailError::InvalidRequest {
                field: "operationId".to_string(),
            });
        }
        let conversation = ConversationRef {
            account_id: account_id.clone(),
            conversation_id: original.conversation_id.clone(),
        };
        // A retry of a compensating operation stays a compensation: it keeps
        // the original's `undo_of`, so it is never itself undoable (no redo)
        // and keeps the `Undo of …` linkage in Activity.
        let original_undo_of: Option<String> = tx
            .query_row(
                "SELECT undo_of FROM gmail_operations
                 WHERE account_id = ?1 AND operation_id = ?2",
                params![account_id, original.operation_id],
                |row| row.get(0),
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        let accepted_at = self.clock.now_iso();
        let receipt = accept_operation_tx(
            &tx,
            &account_id,
            OperationAcceptance {
                conversation: &conversation,
                kind: original.kind,
                value: original.value,
                request_id: &command.request_id,
                payload: &payload,
                // A retry restores the same prior world as the operation it
                // retries, so it clones the original's preimage verbatim.
                clone_targets_from: Some(&original.operation_id),
                explicit_targets: None,
                undo_of: original_undo_of.as_deref(),
                action_id: None,
                // Inspection link to the retried operation (backend-only).
                retry_of: Some(original.operation_id.as_str()),
                accepted_at: &accepted_at,
            },
        )?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(receipt)
    }

    /// Undo of the single latest accepted non-compensating operation
    /// (docs/ux-04-trustworthy-undo.md §3.2/§3.3). Idempotent under `requestId`
    /// through the existing request dedup; eligibility failures are typed
    /// [`MailError::UndoUnavailable`]. Still-queued intent is cancelled in
    /// place; anything already claimed or confirmed is compensated with one
    /// queued operation per distinct prior value with explicit targets.
    pub(crate) fn undo_operation(&self, command: &UndoOperation) -> Result<UndoReceipt, MailError> {
        validate_request_id(&command.request_id)?;
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account_id = match meta_get(&tx, "account_id")? {
            Some(id) => id,
            // Rule 1: the operation must belong to the active account.
            None => return Err(MailError::NotFound),
        };
        let payload = serde_json::json!({ "undoOperationId": command.operation_id }).to_string();
        if let Some(receipt) =
            existing_undo_receipt(&tx, &account_id, &command.request_id, &payload)?
        {
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(receipt);
        }
        let target = load_undo_target(&tx, &account_id, &command.operation_id)?
            .ok_or(MailError::NotFound)?;
        check_undoable(&tx, &account_id, &target, &self.clock.now_iso())?;
        let accepted_at = self.clock.now_iso();
        let receipt = if target.status == OperationStatus::Queued {
            // Cancel in place. The zero-rows branch is defensive only: the
            // status was read in this same transaction, which runs under the
            // connection mutex the worker's claim also needs, so the worker
            // cannot claim concurrently; fall through to compensation anyway.
            let cancelled = tx
                .execute(
                    "UPDATE gmail_operations SET status = 'cancelled', last_error = NULL
                     WHERE account_id = ?1 AND operation_id = ?2 AND status = 'queued'",
                    params![account_id, target.operation_id],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
            if cancelled == 1 {
                UndoReceipt {
                    undone_operation_id: target.operation_id.clone(),
                    outcome: UndoOutcome::Cancelled,
                    operation_ids: Vec::new(),
                    accepted_at: accepted_at.clone(),
                }
            } else {
                compensate_tx(&tx, &account_id, &target, &accepted_at)?
            }
        } else {
            compensate_tx(&tx, &account_id, &target, &accepted_at)?
        };
        tx.execute(
            "INSERT INTO gmail_operation_requests
             (account_id, request_id, payload, operation_id, accepted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                account_id,
                command.request_id,
                payload,
                target.operation_id,
                accepted_at
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(receipt)
    }

    /// Accepts a bounded archive or read group atomically
    /// (docs/ux-05-safe-bulk-processing.md §4.1): canonical fingerprint
    /// idempotency, per-member savepointed child acceptance with persisted
    /// rejections, one commit.
    fn accept_group(
        &self,
        account_id_command: &str,
        kind: MailboxOperationKind,
        value: bool,
        request_id: &str,
        members: &[ConversationRef],
    ) -> Result<OperationGroupReceipt, MailError> {
        crate::groups::validate_group_request_id(request_id)?;
        crate::groups::validate_group_members(account_id_command, members)?;
        let payload = serde_json::json!({
            "kind": kind_name(kind),
            "value": value,
            "members": crate::groups::canonical_member_ids(members),
        })
        .to_string();
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let mut tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account_id = account_id_of(&tx)?;
        if account_id != account_id_command {
            return Err(MailError::NotFound);
        }
        // Same request/payload returns the original receipt — including the
        // original persisted member ordering (§4.1 step 1).
        if let Some(receipt) = existing_group_receipt(&tx, &account_id, request_id, &payload)? {
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(receipt);
        }

        let accepted_at = self.clock.now_iso();
        let group_id = uuid::Uuid::new_v4().to_string();
        let group_seq: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(group_seq), 0) + 1 FROM gmail_operation_groups
                 WHERE account_id = ?1",
                params![account_id],
                |row| row.get(0),
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        let mut member_rows = Vec::with_capacity(members.len());
        for (ordinal, member) in members.iter().enumerate() {
            let child_request_id = format!("{group_id}-{ordinal}");
            let child_payload = serde_json::json!({
                "groupOf": group_id,
                "ordinal": ordinal,
            })
            .to_string();
            // Member savepoint (§4.1 step 3): a rejected member rolls back to
            // a clean slate and keeps its typed rejection; valid siblings are
            // unaffected; storage errors still abort the whole acceptance.
            let mut savepoint = tx.savepoint().map_err(|_| MailError::StorageUnavailable)?;
            let outcome = accept_operation_tx(
                &savepoint,
                &account_id,
                OperationAcceptance {
                    conversation: member,
                    kind,
                    value,
                    request_id: &child_request_id,
                    payload: &child_payload,
                    clone_targets_from: None,
                    explicit_targets: None,
                    undo_of: None,
                    action_id: Some(&group_id),
                    retry_of: None,
                    accepted_at: &accepted_at,
                },
            );
            match outcome {
                Ok(receipt) => {
                    savepoint
                        .commit()
                        .map_err(|_| MailError::StorageUnavailable)?;
                    member_rows.push(GroupMemberInsert {
                        ordinal,
                        conversation_id: member.conversation_id.clone(),
                        operation_id: Some(receipt.operation_id),
                        rejection: None,
                    });
                }
                Err(MailError::NotFound) => {
                    // Gone or unactionable: no immutable targets exist.
                    savepoint
                        .rollback()
                        .map_err(|_| MailError::StorageUnavailable)?;
                    member_rows.push(GroupMemberInsert {
                        ordinal,
                        conversation_id: member.conversation_id.clone(),
                        operation_id: None,
                        rejection: Some(GroupMemberRejection::ConversationMissing),
                    });
                }
                Err(MailError::InvalidRequest { field }) if field == "targets" => {
                    savepoint
                        .rollback()
                        .map_err(|_| MailError::StorageUnavailable)?;
                    member_rows.push(GroupMemberInsert {
                        ordinal,
                        conversation_id: member.conversation_id.clone(),
                        operation_id: None,
                        rejection: Some(GroupMemberRejection::TargetBoundExceeded),
                    });
                }
                // Storage/integrity failure: roll back the entire acceptance.
                Err(error) => return Err(error),
            }
        }
        tx.execute(
            "INSERT INTO gmail_operation_groups
                (group_id, account_id, request_id, kind, requested_value, accepted_at,
                 undone_at, group_seq)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
            params![
                group_id,
                account_id,
                request_id,
                kind_name(kind),
                value as i64,
                accepted_at,
                group_seq,
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        for member in &member_rows {
            insert_group_member_row(&tx, &account_id, &group_id, member)?;
        }
        // The group's own idempotency request row: a replay (including a lost
        // response) resolves here instead of re-running acceptance, and no
        // other command kind can silently reuse this request id (payload
        // mismatch → request_id_conflict).
        tx.execute(
            "INSERT INTO gmail_operation_requests
             (account_id, request_id, payload, operation_id, accepted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![account_id, request_id, payload, group_id, accepted_at],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(group_receipt(
            &group_id,
            request_id,
            &account_id,
            kind,
            Some(value),
            &accepted_at,
            &member_rows,
        ))
    }

    pub(crate) fn accept_archived_group(
        &self,
        command: &crate::groups::SetArchivedGroup,
    ) -> Result<OperationGroupReceipt, MailError> {
        self.accept_group(
            &command.account_id,
            MailboxOperationKind::Archive,
            command.archived,
            &command.request_id,
            &command.members,
        )
    }

    pub(crate) fn accept_read_group(
        &self,
        command: &crate::groups::SetReadGroup,
    ) -> Result<OperationGroupReceipt, MailError> {
        self.accept_group(
            &command.account_id,
            MailboxOperationKind::Read,
            command.read,
            &command.request_id,
            &command.members,
        )
    }

    /// Active-account lookup by original acceptance request ID
    /// (docs/ux-05-safe-bulk-processing.md §4.2); `Ok(None)` while nothing
    /// has committed for that request.
    pub(crate) fn get_operation_group(
        &self,
        request: &crate::groups::GetOperationGroupRequest,
    ) -> Result<Option<OperationGroupStatus>, MailError> {
        crate::groups::validate_group_request_id(&request.request_id)?;
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let account_id = account_id_of(&conn)?;
        if account_id != request.account_id {
            return Err(MailError::NotFound);
        }
        let group_id: Option<String> = conn
            .query_row(
                "SELECT group_id FROM gmail_operation_groups
                 WHERE account_id = ?1 AND request_id = ?2",
                params![account_id, request.request_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| MailError::StorageUnavailable)?;
        let Some(group_id) = group_id else {
            return Ok(None);
        };
        load_group_status(&conn, &account_id, &group_id, self.clock.now_iso()).map(Some)
    }

    /// Bounded recent group summaries with cursor, independent of Inbox/Done
    /// rows (docs/ux-05-safe-bulk-processing.md §4.2).
    pub(crate) fn list_operation_groups(
        &self,
        request: &crate::groups::ListOperationGroupsRequest,
    ) -> Result<crate::groups::OperationGroupPage, MailError> {
        crate::groups::validate_group_page_limit(request.limit)?;
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let account_id = account_id_of(&conn)?;
        if account_id != request.account_id {
            return Err(MailError::NotFound);
        }
        let before_seq = request
            .cursor
            .as_deref()
            .map(|cursor| crate::groups::decode_group_cursor(&account_id, cursor))
            .transpose()?;
        let mut stmt = conn
            .prepare(
                "SELECT group_id, request_id, kind, requested_value, accepted_at, undone_at,
                        group_seq
                 FROM gmail_operation_groups WHERE account_id = ?1
                   AND (?2 IS NULL OR group_seq < ?2)
                 ORDER BY group_seq DESC LIMIT ?3",
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        let mut rows = stmt
            .query_map(
                params![account_id, before_seq, request.limit as i64 + 1],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
        let has_more = rows.len() > request.limit as usize;
        rows.truncate(request.limit as usize);
        let mut summaries = Vec::with_capacity(rows.len());
        let mut last_seq: Option<i64> = None;
        for (group_id, group_request_id, kind, value, accepted_at, undone_at, group_seq) in rows {
            let kind = parse_kind(&kind)?;
            let members = load_group_member_refs(&conn, &account_id, &group_id)?;
            summaries.push(crate::groups::OperationGroupSummary {
                group_id,
                request_id: group_request_id,
                kind,
                requested_archived: (kind == MailboxOperationKind::Archive).then_some(value != 0),
                requested_read: (kind == MailboxOperationKind::Read).then_some(value != 0),
                accepted_at,
                members,
                undone: undone_at.is_some(),
            });
            last_seq = Some(group_seq);
        }
        let next_cursor = has_more
            .then(|| last_seq.map(|seq| crate::groups::encode_group_cursor(&account_id, seq)))
            .flatten();
        Ok(crate::groups::OperationGroupPage {
            groups: summaries,
            next_cursor,
        })
    }

    /// One partial group Undo attempt (docs/ux-05-safe-bulk-processing.md §5):
    /// whole-group eligibility, per-member cancel/compensate/skip decisions
    /// from the original immutable targets/preimages, all persisted in one
    /// transaction under the store lock; idempotent under `requestId`.
    pub(crate) fn undo_operation_group(
        &self,
        command: &crate::groups::UndoOperationGroup,
    ) -> Result<crate::groups::GroupUndoReceipt, MailError> {
        crate::groups::validate_group_request_id(&command.request_id)?;
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account_id = account_id_of(&tx)?;
        let payload = serde_json::json!({ "undoGroupId": command.group_id }).to_string();
        if let Some(receipt) =
            existing_group_undo_receipt(&tx, &account_id, &command.request_id, &payload)?
        {
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(receipt);
        }
        let header =
            load_group_header(&tx, &account_id, &command.group_id)?.ok_or(MailError::NotFound)?;
        let members = load_group_undo_rows(&tx, &account_id, &command.group_id)?;
        let now = self.clock.now_iso();
        check_group_undoable(&tx, &account_id, &header, &now)?;

        let accepted_at = self.clock.now_iso();
        let mut results = Vec::with_capacity(members.len());
        for member in &members {
            let (decision, operation_ids) =
                decide_member_undo(&tx, &account_id, member, &accepted_at)?;
            tx.execute(
                "UPDATE gmail_operation_group_members
                 SET undo_decision = ?4, undo_skip_reason = ?5, undo_operation_ids = ?6
                 WHERE account_id = ?1 AND group_id = ?2 AND ordinal = ?3",
                params![
                    account_id,
                    command.group_id,
                    member.ordinal,
                    group_decision_name(&decision),
                    decision_skip_reason(&decision).map(crate::groups::skip_reason_name),
                    serde_json::to_string(&operation_ids)
                        .map_err(|_| MailError::StorageUnavailable)?,
                ],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
            results.push(crate::groups::GroupMemberUndoResult {
                ordinal: member.ordinal as u32,
                conversation: ConversationRef {
                    account_id: account_id.clone(),
                    conversation_id: member.conversation_id.clone(),
                },
                decision,
                operation_ids,
            });
        }
        tx.execute(
            "UPDATE gmail_operation_groups SET undone_at = ?3
             WHERE account_id = ?1 AND group_id = ?2",
            params![account_id, command.group_id, accepted_at],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "INSERT INTO gmail_operation_requests
             (account_id, request_id, payload, operation_id, accepted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                account_id,
                command.request_id,
                payload,
                command.group_id,
                accepted_at
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(crate::groups::GroupUndoReceipt {
            group_id: command.group_id.clone(),
            request_id: command.request_id.clone(),
            accepted_at,
            members: results,
        })
    }

    pub(crate) fn claim_next_operation(&self) -> Result<Option<OperationRecord>, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account_id = match meta_get(&tx, "account_id")? {
            Some(id) => id,
            None => return Ok(None),
        };
        let operation = tx
            .query_row(
                "SELECT operation_id FROM gmail_operations
                 WHERE account_id = ?1 AND (status = 'queued' OR (status = 'outcome_unknown' AND last_error IS NULL))
                 ORDER BY CASE status WHEN 'outcome_unknown' THEN 0 ELSE 1 END, accepted_seq LIMIT 1",
                params![account_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| MailError::StorageUnavailable)?;
        let Some(operation_id) = operation else {
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(None);
        };
        let record = load_operation(&tx, &account_id, &operation_id)?
            .ok_or(MailError::StorageUnavailable)?;
        if record.status == OperationStatus::Queued {
            tx.execute(
                "UPDATE gmail_operations SET status = 'applying', last_error = NULL WHERE account_id = ?1 AND operation_id = ?2 AND status = 'queued'",
                params![account_id, operation_id],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        }
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(Some(record))
    }

    /// A successful fresh sync makes exact-ID facts available for another
    /// safe reconciliation attempt; this never changes an unknown operation
    /// into a setter replay.
    pub(crate) fn schedule_unknown_reconciliation(&self) -> Result<(), MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let Some(account_id) = meta_get(&conn, "account_id")? else {
            return Ok(());
        };
        conn.execute(
            "UPDATE gmail_operations SET last_error = NULL
             WHERE account_id = ?1 AND status = 'outcome_unknown'",
            params![account_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        Ok(())
    }

    pub(crate) fn claimable_operation_count(&self) -> Result<usize, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let Some(account_id) = meta_get(&conn, "account_id")? else {
            return Ok(0);
        };
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM gmail_operations
                 WHERE account_id = ?1 AND
                       (status = 'queued' OR (status = 'outcome_unknown' AND last_error IS NULL))",
                params![account_id],
                |row| row.get(0),
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        Ok(count as usize)
    }

    pub(crate) fn confirm_operation(&self, record: &OperationRecord) -> Result<(), MailError> {
        self.finish_operation(record, OperationStatus::Confirmed, None, None, true, None)
    }

    pub(crate) fn reconcile_operation(
        &self,
        record: &OperationRecord,
        fetched: &GmailThread,
        confirmed: bool,
    ) -> Result<(), MailError> {
        self.finish_operation(
            record,
            if confirmed {
                OperationStatus::Confirmed
            } else {
                OperationStatus::OutcomeUnknown
            },
            None,
            (!confirmed).then_some(MailError::OutcomeUnknown),
            confirmed,
            Some(fetched),
        )
    }

    pub(crate) fn unknown_operation(&self, record: &OperationRecord) -> Result<(), MailError> {
        self.finish_operation(
            record,
            OperationStatus::OutcomeUnknown,
            None,
            None,
            false,
            None,
        )
    }

    pub(crate) fn reconciled_unknown_operation(
        &self,
        record: &OperationRecord,
    ) -> Result<(), MailError> {
        self.finish_operation(
            record,
            OperationStatus::OutcomeUnknown,
            None,
            Some(MailError::OutcomeUnknown),
            false,
            None,
        )
    }

    pub(crate) fn defer_unknown_operation(
        &self,
        record: &OperationRecord,
        error: &MailError,
    ) -> Result<(), MailError> {
        self.finish_operation(
            record,
            OperationStatus::OutcomeUnknown,
            None,
            Some(error.clone()),
            false,
            None,
        )
    }

    pub(crate) fn requeue_operation(
        &self,
        record: &OperationRecord,
        error: &MailError,
    ) -> Result<(), MailError> {
        self.finish_operation(
            record,
            OperationStatus::Queued,
            None,
            Some(error.clone()),
            false,
            None,
        )
    }

    pub(crate) fn fail_operation(
        &self,
        record: &OperationRecord,
        error: MailError,
    ) -> Result<(), MailError> {
        self.finish_operation(
            record,
            OperationStatus::Failed,
            Some(OperationFailure::ProviderRejected),
            Some(error),
            false,
            None,
        )
    }

    fn finish_operation(
        &self,
        record: &OperationRecord,
        status: OperationStatus,
        failure: Option<OperationFailure>,
        error: Option<MailError>,
        apply_facts: bool,
        fetched: Option<&GmailThread>,
    ) -> Result<(), MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account_id = account_id_of(&tx)?;
        if account_id != record.account_id || !generation_matches(&tx, record.generation)? {
            return Ok(());
        }
        if let Some(thread) = fetched {
            if thread.conversation.conversation_ref.conversation_id != record.conversation_id {
                return Err(MailError::InvalidProviderResponse);
            }
            upsert_thread(&tx, &account_id, thread)?;
            trim_cache(&tx, &account_id)?;
        }
        if apply_facts {
            for message_id in &record.message_ids {
                match record.kind {
                    MailboxOperationKind::Archive => {
                        let inbox = (!record.value) as i64;
                        tx.execute(
                            "INSERT INTO gmail_message_facts (account_id, conversation_id, message_id, in_inbox, is_unread)
                             VALUES (?1, ?2, ?3, ?4, NULL)
                             ON CONFLICT(account_id, conversation_id, message_id) DO UPDATE SET in_inbox = excluded.in_inbox",
                            params![account_id, record.conversation_id, message_id, inbox],
                        ).map_err(|_| MailError::StorageUnavailable)?;
                    }
                    MailboxOperationKind::Read => {
                        let unread = (!record.value) as i64;
                        tx.execute(
                            "INSERT INTO gmail_message_facts (account_id, conversation_id, message_id, in_inbox, is_unread)
                             VALUES (?1, ?2, ?3, NULL, ?4)
                             ON CONFLICT(account_id, conversation_id, message_id) DO UPDATE SET is_unread = excluded.is_unread",
                            params![account_id, record.conversation_id, message_id, unread],
                        ).map_err(|_| MailError::StorageUnavailable)?;
                    }
                }
            }
        }
        tx.execute(
            "UPDATE gmail_operations SET status = ?3, failure = ?4, last_error = ?5
             WHERE account_id = ?1 AND operation_id = ?2",
            params![
                account_id,
                record.operation_id,
                status_name(status),
                failure
                    .map(|f| format!("{f:?}"))
                    .map(|s| s.to_ascii_lowercase()),
                error.map(|e| serde_json::to_string(&e).unwrap_or_default())
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)
    }

    /// Records the account identity and pins the baseline history cursor
    /// BEFORE discovery runs. Restoring the same account after a restart
    /// keeps the persisted cursor and discovery progress so offline changes
    /// are not skipped. A different account id fails closed.
    pub(crate) fn begin_account(
        &self,
        profile: &GmailProfile,
        expected_generation: u64,
    ) -> Result<Commit, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        if !generation_matches(&tx, expected_generation)? {
            return Ok(Commit::Discarded);
        }
        if let Some(existing) = meta_get(&tx, "account_id")? {
            if existing != profile.account_id {
                return Err(MailError::InvalidRequest {
                    field: "accountId".to_string(),
                });
            }
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(Commit::Applied);
        }
        meta_set(&tx, "account_id", &profile.account_id)?;
        meta_set(&tx, "email_address", &profile.email_address)?;
        meta_set(&tx, "history_id", &profile.history_id)?;
        meta_set(&tx, "discovery_state", "pending")?;
        meta_del(&tx, "discovery_page_token")?;
        meta_del(&tx, "history_batch_start")?;
        meta_del(&tx, "history_page_token")?;
        meta_del(&tx, "last_synced_at")?;
        tx.execute("DELETE FROM gmail_discovery_seen", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(Commit::Applied)
    }

    /// Atomically applies one discovery page's thread facts and its page
    /// checkpoint (`next_token`: the page token to resume from; `None` keeps
    /// an unset token). A completed capped pass replaces the cache view with
    /// its observed set; a complete uncapped pass clears stale INBOX
    /// membership. The seen set is reset only when a genuinely fresh run
    /// starts (durable state was not `running`), so a resumed page keeps the
    /// committed progress that lets retries skip already-saved threads.
    pub(crate) fn apply_discovery_page(
        &self,
        fetched: &[ThreadFetch],
        next_token: Option<&str>,
        done: bool,
        capped: bool,
        expected_generation: u64,
    ) -> Result<Commit, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        if !generation_matches(&tx, expected_generation)? {
            return Ok(Commit::Discarded);
        }
        let account_id = account_id_of(&tx)?;
        // (Re)starting the discovery run: any earlier run's seen set is
        // stale. A `running` state with no page token can also be a resumed
        // first page after a mid-page partial commit; its seen set is the
        // current run's durable progress and must be kept so committed
        // threads are never re-fetched.
        let fresh_run = meta_get(&tx, "discovery_state")?.as_deref() != Some("running");
        if fresh_run {
            tx.execute("DELETE FROM gmail_discovery_seen", [])
                .map_err(|_| MailError::StorageUnavailable)?;
        }
        for fetch in fetched {
            match fetch {
                ThreadFetch::Cached(thread) => upsert_thread(&tx, &account_id, thread)?,
                ThreadFetch::Missing(id) => delete_conversation(&tx, &account_id, id)?,
            }
            tx.execute(
                "INSERT OR IGNORE INTO gmail_discovery_seen (conversation_id) VALUES (?1)",
                params![fetch.id()],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        }
        // Keep every durable checkpoint within the advertised cap. Current
        // discovery observations win over older cached conversations.
        trim_discovery_cache(&tx, &account_id)?;
        if done {
            if capped {
                // A capped discovery is an explicit bounded cache view: keep
                // only conversations observed within the cap. This also
                // reconciles stale inbox membership after cursor expiry, when
                // advancing the fresh baseline means old archive events cannot
                // be recovered by a later history catch-up.
                tx.execute(
                    "DELETE FROM gmail_messages
                     WHERE account_id = ?1 AND conversation_id NOT IN
                         (SELECT conversation_id FROM gmail_discovery_seen)",
                    params![account_id],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
                tx.execute(
                    "DELETE FROM gmail_inbox_membership
                     WHERE account_id = ?1 AND conversation_id NOT IN
                         (SELECT conversation_id FROM gmail_discovery_seen)",
                    params![account_id],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
                tx.execute(
                    "DELETE FROM gmail_message_facts
                     WHERE account_id = ?1 AND conversation_id NOT IN
                         (SELECT conversation_id FROM gmail_discovery_seen)
                       AND NOT EXISTS (
                         SELECT 1 FROM gmail_operation_targets t
                         WHERE t.account_id = gmail_message_facts.account_id
                           AND t.conversation_id = gmail_message_facts.conversation_id
                           AND t.message_id = gmail_message_facts.message_id)",
                    params![account_id],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
                tx.execute(
                    "DELETE FROM gmail_conversations
                     WHERE account_id = ?1 AND conversation_id NOT IN
                         (SELECT conversation_id FROM gmail_discovery_seen)",
                    params![account_id],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
            } else {
                // Complete uncapped discovery: cached in-inbox conversations
                // not observed were archived or deleted externally; drop their
                // INBOX membership while retaining locally cached reader data.
                tx.execute(
                    "UPDATE gmail_messages SET in_inbox = 0
                     WHERE account_id = ?1 AND in_inbox = 1
                       AND conversation_id NOT IN
                           (SELECT conversation_id FROM gmail_discovery_seen)",
                    params![account_id],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
                tx.execute(
                    "UPDATE gmail_message_facts SET in_inbox = 0
                     WHERE account_id = ?1 AND conversation_id NOT IN
                         (SELECT conversation_id FROM gmail_discovery_seen)",
                    params![account_id],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
                tx.execute(
                    "DELETE FROM gmail_inbox_membership
                     WHERE account_id = ?1 AND conversation_id NOT IN
                         (SELECT conversation_id FROM gmail_discovery_seen)",
                    params![account_id],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
            }
            tx.execute("DELETE FROM gmail_discovery_seen", [])
                .map_err(|_| MailError::StorageUnavailable)?;
            meta_set(&tx, "discovery_state", "done")?;
            meta_del(&tx, "discovery_page_token")?;
            meta_set(&tx, "last_synced_at", &self.clock.now_iso())?;
        } else {
            meta_set(&tx, "discovery_state", "running")?;
            match next_token {
                Some(token) => meta_set(&tx, "discovery_page_token", token)?,
                None => meta_del(&tx, "discovery_page_token")?,
            }
        }
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(Commit::Applied)
    }

    /// Atomically applies one history page's facts/deletions and its
    /// checkpoint. The final history cursor advances only when the page is
    /// the batch's last (`next_page_token == None`), so interrupted batches
    /// resume from the original start id.
    pub(crate) fn apply_history_page(
        &self,
        page: &HistoryPage,
        fetched: &[ThreadFetch],
        batch_start: &str,
        expected_generation: u64,
    ) -> Result<Commit, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        if !generation_matches(&tx, expected_generation)? {
            return Ok(Commit::Discarded);
        }
        let account_id = account_id_of(&tx)?;
        for fetch in fetched {
            match fetch {
                ThreadFetch::Cached(thread) => upsert_thread(&tx, &account_id, thread)?,
                ThreadFetch::Missing(id) => delete_conversation(&tx, &account_id, id)?,
            }
        }
        trim_cache(&tx, &account_id)?;
        for message_id in &page.deleted_message_ids {
            tx.execute(
                "DELETE FROM gmail_messages WHERE account_id = ?1 AND message_id = ?2",
                params![account_id, message_id],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
            tx.execute(
                "DELETE FROM gmail_inbox_membership WHERE account_id = ?1 AND message_id = ?2",
                params![account_id, message_id],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
            tx.execute(
                "DELETE FROM gmail_message_facts WHERE account_id = ?1 AND message_id = ?2",
                params![account_id, message_id],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        }
        // Conversations left with no messages disappear from the cache.
        tx.execute(
            "DELETE FROM gmail_conversations
             WHERE account_id = ?1 AND NOT EXISTS (
                 SELECT 1 FROM gmail_messages m
                 WHERE m.account_id = gmail_conversations.account_id
                   AND m.conversation_id = gmail_conversations.conversation_id)
               AND NOT EXISTS (
                 SELECT 1 FROM gmail_inbox_membership i
                 WHERE i.account_id = gmail_conversations.account_id
                   AND i.conversation_id = gmail_conversations.conversation_id)",
            params![account_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        if page.next_page_token.is_none() {
            meta_set(&tx, "history_id", &page.history_id)?;
            meta_del(&tx, "history_batch_start")?;
            meta_del(&tx, "history_page_token")?;
            meta_set(&tx, "last_synced_at", &self.clock.now_iso())?;
        } else {
            meta_set(&tx, "history_batch_start", batch_start)?;
            meta_set(
                &tx,
                "history_page_token",
                page.next_page_token.as_deref().unwrap_or_default(),
            )?;
        }
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(Commit::Applied)
    }

    /// Cursor-expiry recovery: pin a fresh baseline and restart bounded
    /// discovery, which reconciles its cache view before proceeding instead
    /// of silently skipping the expired window.
    pub(crate) fn begin_rediscovery(
        &self,
        baseline_history_id: &str,
        expected_generation: u64,
    ) -> Result<Commit, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        if !generation_matches(&tx, expected_generation)? {
            return Ok(Commit::Discarded);
        }
        account_id_of(&tx)?;
        meta_set(&tx, "history_id", baseline_history_id)?;
        meta_set(&tx, "discovery_state", "running")?;
        meta_del(&tx, "discovery_page_token")?;
        meta_del(&tx, "history_batch_start")?;
        meta_del(&tx, "history_page_token")?;
        tx.execute("DELETE FROM gmail_discovery_seen", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(Commit::Applied)
    }

    /// Bumps the stale-write generation without touching data: every
    /// in-flight checkpointed write from before this point is discarded.
    pub(crate) fn advance_generation(&self) -> Result<(), MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let next = generation_of(&tx)?.saturating_add(1);
        meta_set(&tx, "generation", &next.to_string())?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(())
    }

    /// Converts interrupted operations that survived unsuccessful disconnect
    /// cleanup into GET-reconciled unknown outcomes under the current account.
    pub(crate) fn recover_interrupted_operations(&self) -> Result<bool, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let Some(account_id) = meta_get(&tx, "account_id")? else {
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(false);
        };
        let changed = tx
            .execute(
                "UPDATE gmail_operations
                 SET status = 'outcome_unknown', failure = NULL, last_error = NULL
                 WHERE account_id = ?1 AND status = 'applying'",
                params![account_id],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(changed > 0)
    }

    /// Disconnect cleanup: bumps the generation (stale results can no longer
    /// repopulate) and wipes the account identity, cache and checkpoints in
    /// one transaction.
    pub(crate) fn clear_account(&self) -> Result<(), MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let next = generation_of(&tx)?.saturating_add(1);
        meta_set(&tx, "generation", &next.to_string())?;
        tx.execute("DELETE FROM gmail_conversations", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_messages", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_inbox_membership", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_message_facts", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_operations", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_operation_targets", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_operation_requests", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_operation_snapshots", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_operation_preimages", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        // Durable group headers/manifests are account-scoped recovery records
        // whose child operations, requests and preimages are deleted above;
        // keeping them would leave detail loads typed-failing and let a
        // reused request id collide with the retained header's unique
        // constraint (docs/ux-05-safe-bulk-processing.md §4.2).
        tx.execute("DELETE FROM gmail_operation_group_members", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_operation_groups", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_discovery_seen", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "DELETE FROM meta WHERE key IN
             ('account_id', 'email_address', 'history_id', 'discovery_state',
              'discovery_page_token', 'history_batch_start', 'history_page_token',
              'last_synced_at')",
            [],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(())
    }
}

// ------------------------------------------------------------------ helpers

fn validate_request_id(request_id: &str) -> Result<(), MailError> {
    if request_id.trim().is_empty() || request_id.len() > 200 {
        return Err(MailError::InvalidRequest {
            field: "requestId".to_string(),
        });
    }
    Ok(())
}

fn existing_receipt(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
    payload: &str,
) -> Result<Option<OperationReceipt>, MailError> {
    let existing = tx
        .query_row(
            "SELECT payload, operation_id FROM gmail_operation_requests
         WHERE account_id = ?1 AND request_id = ?2",
            params![account_id, request_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some((saved_payload, operation_id)) = existing else {
        return Ok(None);
    };
    if saved_payload != payload {
        return Err(MailError::RequestIdConflict);
    }
    let accepted_at = tx
        .query_row(
            "SELECT accepted_at FROM gmail_operations WHERE account_id = ?1 AND operation_id = ?2",
            params![account_id, operation_id],
            |row| row.get(0),
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    Ok(Some(OperationReceipt {
        operation_id,
        accepted_at,
    }))
}

/// Reconstructs the committed receipt for a repeated undo request. Undo rows
/// persist their own acceptance time; outcome and operation ids derive from
/// the compensating rows (docs/ux-04-trustworthy-undo.md §3.3).
fn existing_undo_receipt(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
    payload: &str,
) -> Result<Option<UndoReceipt>, MailError> {
    let existing = tx
        .query_row(
            "SELECT payload, operation_id, accepted_at FROM gmail_operation_requests
         WHERE account_id = ?1 AND request_id = ?2",
            params![account_id, request_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some((saved_payload, operation_id, accepted_at)) = existing else {
        return Ok(None);
    };
    if saved_payload != payload {
        return Err(MailError::RequestIdConflict);
    }
    let operation_ids = compensating_ids(tx, account_id, &operation_id)?;
    let outcome = if operation_ids.is_empty() {
        UndoOutcome::Cancelled
    } else {
        UndoOutcome::Compensating
    };
    Ok(Some(UndoReceipt {
        undone_operation_id: operation_id,
        outcome,
        operation_ids,
        accepted_at: accepted_at.ok_or(MailError::StorageUnavailable)?,
    }))
}

fn compensating_ids(
    conn: &Connection,
    account_id: &str,
    undone_operation_id: &str,
) -> Result<Vec<String>, MailError> {
    let mut stmt = conn
        .prepare(
            "SELECT operation_id FROM gmail_operations
         WHERE account_id = ?1 AND undo_of = ?2 ORDER BY accepted_seq",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    let ids = stmt
        .query_map(params![account_id, undone_operation_id], |row| row.get(0))
        .map_err(|_| MailError::StorageUnavailable)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|_| MailError::StorageUnavailable)?;
    Ok(ids)
}

/// The persisted facts about an operation needed to decide and execute Undo.
struct UndoTarget {
    operation_id: String,
    conversation_id: String,
    kind: MailboxOperationKind,
    status: OperationStatus,
    undo_of: Option<String>,
    accepted_at: String,
    /// Top-level action identity (docs/ux-05-safe-bulk-processing.md §5):
    /// standalone setters/retries carry their own operation id, group
    /// children carry their group id, compensations none.
    action_id: Option<String>,
}

fn load_undo_target(
    conn: &Connection,
    account_id: &str,
    operation_id: &str,
) -> Result<Option<UndoTarget>, MailError> {
    let row = conn
        .query_row(
            "SELECT conversation_id, kind, status, undo_of, accepted_at, action_id
             FROM gmail_operations
         WHERE account_id = ?1 AND operation_id = ?2",
            params![account_id, operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some((conversation_id, kind, status, undo_of, accepted_at, action_id)) = row else {
        return Ok(None);
    };
    Ok(Some(UndoTarget {
        operation_id: operation_id.to_string(),
        conversation_id,
        kind: parse_kind(&kind)?,
        status: parse_status(&status)?,
        undo_of,
        accepted_at,
        action_id,
    }))
}

/// Applies eligibility rules §3.2 in order; the first failure returns its
/// typed reason.
fn check_undoable(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    target: &UndoTarget,
    now: &str,
) -> Result<(), MailError> {
    // Rule 2: a compensating operation is never itself undoable.
    if target.undo_of.is_some() {
        return Err(undo_unavailable(UndoUnavailableReason::NotApplicable));
    }
    // UX-05 (§5): a group member is undone by the group's one attempt, never
    // individually — no last-child escape around group eligibility.
    if target.action_id.as_deref() != Some(target.operation_id.as_str()) {
        return Err(undo_unavailable(UndoUnavailableReason::NotApplicable));
    }
    // Rule 3: the 10 s window from acceptance, on the injected clock.
    if !crate::clock::within_undo_window(&target.accepted_at, now) {
        return Err(undo_unavailable(UndoUnavailableReason::Expired));
    }
    // Rule 4: newest top-level user action on the account — a single, a
    // group, or a retry; never a compensation (docs/ux-05-safe-bulk-processing.md §5).
    let newest = latest_action_id(tx, account_id)?;
    if newest.as_deref() != Some(target.operation_id.as_str()) {
        return Err(undo_unavailable(UndoUnavailableReason::Superseded));
    }
    // Rule 5: not already undone.
    let undone: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM gmail_operations
             WHERE account_id = ?1 AND undo_of = ?2)",
            params![account_id, target.operation_id],
            |row| row.get(0),
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    if undone {
        return Err(undo_unavailable(UndoUnavailableReason::AlreadyUndone));
    }
    // Rule 6: only live intent is undoable.
    match target.status {
        OperationStatus::Queued | OperationStatus::Applying | OperationStatus::Confirmed => {}
        OperationStatus::Failed => {
            return Err(undo_unavailable(UndoUnavailableReason::NotApplicable))
        }
        OperationStatus::OutcomeUnknown => {
            return Err(undo_unavailable(UndoUnavailableReason::Uncertain))
        }
        OperationStatus::Cancelled => {
            return Err(undo_unavailable(UndoUnavailableReason::AlreadyUndone))
        }
    }
    // Rule 7: every target's preimage must be known.
    if has_unknown_prior_value(tx, account_id, &target.operation_id)? {
        return Err(undo_unavailable(UndoUnavailableReason::UnknownPrior));
    }
    Ok(())
}

fn undo_unavailable(reason: UndoUnavailableReason) -> MailError {
    MailError::UndoUnavailable { reason }
}

/// True when any target lacks a known (non-NULL) preimage row.
fn has_unknown_prior_value(
    conn: &Connection,
    account_id: &str,
    operation_id: &str,
) -> Result<bool, MailError> {
    let unknown: bool = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM gmail_operation_targets t
                 WHERE t.account_id = ?1 AND t.operation_id = ?2
                   AND NOT EXISTS (
                     SELECT 1 FROM gmail_operation_preimages p
                     WHERE p.account_id = t.account_id
                       AND p.operation_id = t.operation_id
                       AND p.message_id = t.message_id
                       AND p.prior_value IS NOT NULL))",
            params![account_id, operation_id],
            |row| row.get(0),
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    Ok(unknown)
}

/// Stages one queued compensating operation per distinct known prior value
/// (docs/ux-04-trustworthy-undo.md §3.3): same kind and dimension, explicit
/// targets, `undo_of` pointing at the undone operation.
fn compensate_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    target: &UndoTarget,
    accepted_at: &str,
) -> Result<UndoReceipt, MailError> {
    let mut stmt = tx
        .prepare(
            "SELECT t.message_id, p.prior_value FROM gmail_operation_targets t
         LEFT JOIN gmail_operation_preimages p
           ON p.account_id = t.account_id AND p.operation_id = t.operation_id
          AND p.message_id = t.message_id
         WHERE t.account_id = ?1 AND t.operation_id = ?2",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    let rows = stmt
        .query_map(params![account_id, target.operation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })
        .map_err(|_| MailError::StorageUnavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| MailError::StorageUnavailable)?;
    drop(stmt);
    // Deterministic queue order: restore non-value group first, then value.
    let mut restore_group = Vec::new();
    let mut reapply_group = Vec::new();
    for (message_id, prior_value) in rows {
        match prior_value {
            Some(0) => restore_group.push(message_id),
            Some(_) => reapply_group.push(message_id),
            // Rule 7 was checked before compensation; fail closed regardless.
            None => return Err(undo_unavailable(UndoUnavailableReason::UnknownPrior)),
        }
    }
    let mut operation_ids = Vec::new();
    for (prior_value, ids) in [(false, restore_group), (true, reapply_group)] {
        if ids.is_empty() {
            continue;
        }
        let conversation = ConversationRef {
            account_id: account_id.to_string(),
            conversation_id: target.conversation_id.clone(),
        };
        let payload = serde_json::json!({
            "undoOf": target.operation_id,
            "kind": kind_name(target.kind),
            "value": prior_value,
        })
        .to_string();
        let request_id = format!("undo-{}", uuid::Uuid::new_v4());
        let receipt = accept_operation_tx(
            tx,
            account_id,
            OperationAcceptance {
                conversation: &conversation,
                kind: target.kind,
                value: prior_value,
                request_id: &request_id,
                payload: &payload,
                clone_targets_from: None,
                explicit_targets: Some(ids),
                undo_of: Some(target.operation_id.as_str()),
                action_id: None,
                retry_of: None,
                accepted_at,
            },
        )?;
        operation_ids.push(receipt.operation_id);
    }
    Ok(UndoReceipt {
        undone_operation_id: target.operation_id.clone(),
        outcome: UndoOutcome::Compensating,
        operation_ids,
        accepted_at: accepted_at.to_string(),
    })
}

fn accept_operation_tx(
    tx: &Connection,
    account_id: &str,
    acceptance: OperationAcceptance<'_>,
) -> Result<OperationReceipt, MailError> {
    let OperationAcceptance {
        conversation,
        kind,
        value,
        request_id,
        payload,
        clone_targets_from,
        explicit_targets,
        undo_of,
        action_id,
        retry_of,
        accepted_at,
    } = acceptance;
    let mut targets: Vec<String>;
    if let Some(explicit) = explicit_targets {
        targets = explicit;
    } else if let Some(original_id) = clone_targets_from {
        let mut stmt = tx
            .prepare(
                "SELECT message_id FROM gmail_operation_targets
             WHERE account_id = ?1 AND operation_id = ?2 ORDER BY message_id",
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        targets = stmt
            .query_map(params![account_id, original_id], |row| row.get(0))
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
    } else {
        let mut stmt = tx
            .prepare(
                "SELECT message_id FROM gmail_message_facts
             WHERE account_id = ?1 AND conversation_id = ?2 ORDER BY message_id",
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        targets = stmt
            .query_map(params![account_id, conversation.conversation_id], |row| {
                row.get(0)
            })
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
    }
    targets.sort();
    targets.dedup();
    if targets.is_empty() {
        return Err(MailError::NotFound);
    }
    if targets.len() > 1000 {
        return Err(MailError::InvalidRequest {
            field: "targets".to_string(),
        });
    }
    let operation_id = uuid::Uuid::new_v4().to_string();
    let existing_snapshot: Option<(String, String)> = tx
        .query_row(
            "SELECT snapshot_json, snapshot_saved_at FROM gmail_operation_snapshots
         WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation.conversation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let (snapshot_json, snapshot_saved_at) = if let Some(original_id) = clone_targets_from {
        // A retry restores the same prior world as the operation it retries,
        // so it clones the original's preimage instead of capturing a new one.
        tx.execute(
            "INSERT INTO gmail_operation_preimages
             (account_id, operation_id, message_id, prior_value)
             SELECT account_id, ?2, message_id, prior_value FROM gmail_operation_preimages
             WHERE account_id = ?1 AND operation_id = ?3",
            params![account_id, operation_id, original_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        existing_snapshot.ok_or(MailError::NotFound)?
    } else if let Some(built) = build_conversation(tx, account_id, &conversation.conversation_id)? {
        let effective = effective_conversation_state_with_coverage(
            tx,
            account_id,
            &conversation.conversation_id,
        )?;
        // Preimage capture (docs/ux-04-trustworthy-undo.md §3.1): the effective
        // per-message value of this operation's dimension at acceptance, in the
        // same transaction. Compensating operations record their own preimage.
        capture_preimages(
            tx,
            account_id,
            &operation_id,
            kind,
            &effective.facts,
            &targets,
        )?;
        let current = Conversation {
            conversation_ref: built.conversation_ref,
            subject: built.subject,
            messages: built.messages,
            is_in_inbox: effective.inbox,
            is_read: effective.is_read,
            context_complete: built.context_complete,
            unsupported_reason: built.unsupported_reason,
            retained_snapshot_at: None,
            reply_context: None,
            pending_operation_id: effective.pending_operation_id,
        };
        (
            serde_json::to_string(&current).map_err(|_| MailError::StorageUnavailable)?,
            accepted_at.to_string(),
        )
    } else {
        // No renderable conversation body: still capture preimages from the
        // per-message facts retained for this operation's recovery view.
        let effective = effective_conversation_state_with_coverage(
            tx,
            account_id,
            &conversation.conversation_id,
        )?;
        capture_preimages(
            tx,
            account_id,
            &operation_id,
            kind,
            &effective.facts,
            &targets,
        )?;
        existing_snapshot.ok_or(MailError::NotFound)?
    };
    let accepted_seq: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(accepted_seq), 0) + 1 FROM gmail_operations WHERE account_id = ?1",
            params![account_id],
            |row| row.get(0),
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    // Top-level action identity (docs/ux-05-safe-bulk-processing.md §5):
    // group children share their group's identity; standalone setters and
    // retries are their own action; compensations are never top-level.
    let effective_action_id: Option<String> = if undo_of.is_some() {
        None
    } else {
        Some(
            action_id
                .map(str::to_string)
                .unwrap_or_else(|| operation_id.clone()),
        )
    };
    tx.execute(
        "INSERT INTO gmail_operations
         (account_id, operation_id, conversation_id, kind, requested_value, status,
          accepted_seq, accepted_at, request_id, undo_of, action_id, retry_of)
         VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            account_id,
            operation_id,
            conversation.conversation_id,
            kind_name(kind),
            value as i64,
            accepted_seq,
            accepted_at,
            request_id,
            undo_of,
            effective_action_id,
            retry_of,
        ],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    for message_id in targets {
        tx.execute(
            "INSERT INTO gmail_operation_targets (account_id, operation_id, conversation_id, message_id)
             VALUES (?1, ?2, ?3, ?4)",
            params![account_id, operation_id, conversation.conversation_id, message_id],
        ).map_err(|_| MailError::StorageUnavailable)?;
    }
    tx.execute(
        "INSERT INTO gmail_operation_requests (account_id, request_id, payload, operation_id)
         VALUES (?1, ?2, ?3, ?4)",
        params![account_id, request_id, payload, operation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    tx.execute(
        "INSERT INTO gmail_operation_snapshots
         (account_id, conversation_id, snapshot_json, snapshot_saved_at, last_message_at)
         VALUES (?1, ?2, ?3, ?4, COALESCE(json_extract(?3, '$.messages[#-1].sentAt'), ''))
         ON CONFLICT(account_id, conversation_id) DO UPDATE SET
             snapshot_json = excluded.snapshot_json,
             snapshot_saved_at = excluded.snapshot_saved_at,
             last_message_at = excluded.last_message_at",
        params![
            account_id,
            conversation.conversation_id,
            snapshot_json,
            snapshot_saved_at
        ],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    Ok(OperationReceipt {
        operation_id,
        accepted_at: accepted_at.to_string(),
    })
}

/// Persists the effective prior value of `kind`'s dimension for every target
/// message (docs/ux-04-trustworthy-undo.md §3.1). `prior_value` uses the
/// operation's own requested-value domain: for archive it is the effective
/// archived state (`!in_inbox`), for read the effective read state
/// (`!is_unread`); `NULL` records an unknown fact.
fn capture_preimages(
    tx: &Connection,
    account_id: &str,
    operation_id: &str,
    kind: MailboxOperationKind,
    facts: &HashMap<String, (Option<bool>, Option<bool>)>,
    targets: &[String],
) -> Result<(), MailError> {
    for message_id in targets {
        let Some((in_inbox, unread)) = facts.get(message_id) else {
            continue;
        };
        let prior_value = match kind {
            MailboxOperationKind::Archive => in_inbox.map(|v| !v),
            MailboxOperationKind::Read => unread.map(|v| !v),
        };
        tx.execute(
            "INSERT INTO gmail_operation_preimages
             (account_id, operation_id, message_id, prior_value)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                account_id,
                operation_id,
                message_id,
                prior_value.map(|v| v as i64)
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    }
    Ok(())
}

fn kind_name(kind: MailboxOperationKind) -> &'static str {
    match kind {
        MailboxOperationKind::Archive => "archive",
        MailboxOperationKind::Read => "read",
    }
}

fn parse_kind(kind: &str) -> Result<MailboxOperationKind, MailError> {
    match kind {
        "archive" => Ok(MailboxOperationKind::Archive),
        "read" => Ok(MailboxOperationKind::Read),
        _ => Err(MailError::StorageUnavailable),
    }
}

fn status_name(status: OperationStatus) -> &'static str {
    match status {
        OperationStatus::Queued => "queued",
        OperationStatus::Applying => "applying",
        OperationStatus::Confirmed => "confirmed",
        OperationStatus::Failed => "failed",
        OperationStatus::OutcomeUnknown => "outcome_unknown",
        OperationStatus::Cancelled => "cancelled",
    }
}

fn parse_status(status: &str) -> Result<OperationStatus, MailError> {
    match status {
        "queued" => Ok(OperationStatus::Queued),
        "applying" => Ok(OperationStatus::Applying),
        "confirmed" => Ok(OperationStatus::Confirmed),
        "failed" => Ok(OperationStatus::Failed),
        "outcome_unknown" => Ok(OperationStatus::OutcomeUnknown),
        "cancelled" => Ok(OperationStatus::Cancelled),
        _ => Err(MailError::StorageUnavailable),
    }
}

fn load_operation(
    conn: &Connection,
    account_id: &str,
    operation_id: &str,
) -> Result<Option<OperationRecord>, MailError> {
    let raw = conn
        .query_row(
            "SELECT conversation_id, kind, requested_value, status FROM gmail_operations
         WHERE account_id = ?1 AND operation_id = ?2",
            params![account_id, operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some((conversation_id, kind, value, status)) = raw else {
        return Ok(None);
    };
    let mut stmt = conn
        .prepare(
            "SELECT message_id FROM gmail_operation_targets
         WHERE account_id = ?1 AND operation_id = ?2 ORDER BY message_id",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    let message_ids = stmt
        .query_map(params![account_id, operation_id], |row| row.get(0))
        .map_err(|_| MailError::StorageUnavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| MailError::StorageUnavailable)?;
    Ok(Some(OperationRecord {
        account_id: account_id.to_string(),
        operation_id: operation_id.to_string(),
        generation: generation_of(conn)?,
        conversation_id,
        kind: parse_kind(&kind)?,
        value: value != 0,
        status: parse_status(&status)?,
        message_ids,
    }))
}

fn effective_conversation_state(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<(bool, Option<bool>, Option<String>), MailError> {
    let state = effective_conversation_state_with_coverage(conn, account_id, conversation_id)?;
    Ok((state.inbox, state.is_read, state.pending_operation_id))
}

/// Effective aggregates plus the per-message fact map the overlay is built
/// from (docs/ux-04-trustworthy-undo.md §2). `facts` maps message id to
/// `(in_inbox, is_unread)`; `None` marks an unknown fact.
pub(crate) struct EffectiveState {
    pub(crate) inbox: bool,
    pub(crate) is_read: Option<bool>,
    pub(crate) pending_operation_id: Option<String>,
    pub(crate) coverage_known: bool,
    pub(crate) facts: HashMap<String, (Option<bool>, Option<bool>)>,
}

fn effective_conversation_state_with_coverage(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<EffectiveState, MailError> {
    let mut facts = HashMap::<String, (Option<bool>, Option<bool>)>::new();
    let mut stmt = conn
        .prepare(
            "SELECT message_id, in_inbox, is_unread FROM gmail_message_facts
         WHERE account_id = ?1 AND conversation_id = ?2",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    for row in stmt
        .query_map(params![account_id, conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .map_err(|_| MailError::StorageUnavailable)?
    {
        let (id, inbox, unread) = row.map_err(|_| MailError::StorageUnavailable)?;
        facts.insert(id, (inbox.map(|v| v != 0), unread.map(|v| v != 0)));
    }
    let mut operations: Vec<(i64, OperationRecord)> = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT operation_id, accepted_seq FROM gmail_operations
         WHERE account_id = ?1 AND conversation_id = ?2 ORDER BY accepted_seq",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    let ids = stmt
        .query_map(params![account_id, conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|_| MailError::StorageUnavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| MailError::StorageUnavailable)?;
    for (id, seq) in ids {
        if let Some(op) = load_operation(conn, account_id, &id)? {
            operations.push((seq, op));
        }
    }
    let mut barriers = HashMap::<(String, String), i64>::new();
    for (seq, op) in &operations {
        if op.status == OperationStatus::Confirmed {
            for id in &op.message_ids {
                barriers.insert((kind_name(op.kind).to_string(), id.clone()), *seq);
            }
        }
    }
    let mut active = None::<(i64, String)>;
    for (seq, op) in &operations {
        if !matches!(
            op.status,
            OperationStatus::Queued | OperationStatus::Applying | OperationStatus::OutcomeUnknown
        ) {
            continue;
        }
        if active.as_ref().is_none_or(|(current, _)| seq >= current) {
            active = Some((*seq, op.operation_id.clone()));
        }
        for id in &op.message_ids {
            if barriers
                .get(&(kind_name(op.kind).to_string(), id.clone()))
                .is_some_and(|barrier_seq| barrier_seq > seq)
            {
                continue;
            }
            let entry = facts.entry(id.clone()).or_insert((None, None));
            match op.kind {
                MailboxOperationKind::Archive => entry.0 = Some(!op.value),
                MailboxOperationKind::Read => entry.1 = Some(!op.value),
            }
        }
    }
    let inbox = facts.values().any(|(inbox, _)| *inbox == Some(true));
    let is_read = if facts.is_empty() || facts.values().any(|(_, unread)| unread.is_none()) {
        None
    } else {
        Some(!facts.values().any(|(_, unread)| *unread == Some(true)))
    };
    Ok(EffectiveState {
        inbox,
        is_read,
        pending_operation_id: active.map(|(_, id)| id),
        coverage_known: !facts.is_empty() && facts.values().all(|(inbox, _)| inbox.is_some()),
        facts,
    })
}

/// Activity rows plus, per row, the derived undo window (§3.2): present only
/// while all undoability rules hold at query time, on the same injected clock
/// as the `undo_operation` command path.
fn load_activity(
    conn: &Connection,
    account_id: &str,
    clock: &dyn Clock,
) -> Result<Vec<OperationSummary>, MailError> {
    let mut stmt = conn.prepare(
        "SELECT o.operation_id, o.conversation_id, o.kind, o.requested_value, o.status, o.failure, o.last_error,
                o.undo_of, o.accepted_at, o.action_id, o.retry_of,
                (SELECT m.group_id FROM gmail_operation_group_members m
                 WHERE m.account_id = o.account_id AND m.operation_id = o.operation_id)
         FROM gmail_operations o WHERE o.account_id = ?1 ORDER BY o.accepted_seq DESC",
    ).map_err(|_| MailError::StorageUnavailable)?;
    // Shared eligibility facts (§3.2 rules 4–5 plus UX-05 action ordering):
    // the newest top-level action id and the set of already-undone ids.
    let newest_action = latest_action_id(conn, account_id)?;
    let now = clock.now_iso();
    let mut activity = Vec::new();
    for row in stmt
        .query_map(params![account_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<String>>(11)?,
            ))
        })
        .map_err(|_| MailError::StorageUnavailable)?
    {
        let (
            id,
            conversation_id,
            kind,
            value,
            status,
            failure,
            last_error,
            undo_of,
            accepted_at,
            action_id,
            retry_of,
            group_id,
        ) = row.map_err(|_| MailError::StorageUnavailable)?;
        let kind = parse_kind(&kind)?;
        let status = parse_status(&status)?;
        let failure = failure.map(|f| {
            if f == "providerunavailable" {
                OperationFailure::ProviderUnavailable
            } else {
                OperationFailure::ProviderRejected
            }
        });
        let last_error = last_error
            .map(|json| serde_json::from_str(&json).map_err(|_| MailError::StorageUnavailable))
            .transpose()?;
        let undoable_until = if undo_of.is_none()
            && action_id.as_deref() == Some(id.as_str())
            && matches!(
                status,
                OperationStatus::Queued | OperationStatus::Applying | OperationStatus::Confirmed
            )
            && newest_action.as_deref() == Some(id.as_str())
            && !has_undo_rows(conn, account_id, &id)?
            && !has_unknown_prior_value(conn, account_id, &id)?
            && crate::clock::within_undo_window(&accepted_at, &now)
        {
            crate::clock::undo_deadline_iso(&accepted_at)
        } else {
            None
        };
        activity.push(OperationSummary {
            id,
            conversation: ConversationRef {
                account_id: account_id.to_string(),
                conversation_id,
            },
            requested_archived: if kind == MailboxOperationKind::Archive {
                value != 0
            } else {
                false
            },
            status,
            failure,
            kind: Some(kind),
            requested_read: (kind == MailboxOperationKind::Read).then_some(value != 0),
            last_error,
            undo_of,
            group_id,
            retry_of,
            undoable_until,
        });
    }
    Ok(activity)
}

/// Rule 5: whether any compensation already points at this operation.
fn has_undo_rows(
    conn: &Connection,
    account_id: &str,
    operation_id: &str,
) -> Result<bool, MailError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM gmail_operations
         WHERE account_id = ?1 AND undo_of = ?2)",
        params![account_id, operation_id],
        |row| row.get(0),
    )
    .map_err(|_| MailError::StorageUnavailable)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, MailError> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|_| MailError::StorageUnavailable)?;
    let found = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| MailError::StorageUnavailable)?
        .any(|name| name.map(|n| n == column).unwrap_or(false));
    Ok(found)
}

/// Newest top-level user action on the account (docs/ux-05-safe-bulk-processing.md
/// §5): singles and retries are their own action, group children share the
/// group's identity, compensations are none. Transactional acceptance order
/// (`accepted_seq`) is the action order; timestamp comparison is insufficient.
fn latest_action_id(conn: &Connection, account_id: &str) -> Result<Option<String>, MailError> {
    conn.query_row(
        "SELECT action_id FROM gmail_operations
         WHERE account_id = ?1 AND action_id IS NOT NULL
         GROUP BY action_id ORDER BY MAX(accepted_seq) DESC LIMIT 1",
        params![account_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|_| MailError::StorageUnavailable)
}

struct GroupMemberInsert {
    ordinal: usize,
    conversation_id: String,
    operation_id: Option<String>,
    rejection: Option<GroupMemberRejection>,
}

fn insert_group_member_row(
    conn: &Connection,
    account_id: &str,
    group_id: &str,
    member: &GroupMemberInsert,
) -> Result<(), MailError> {
    conn.execute(
        "INSERT INTO gmail_operation_group_members
            (account_id, group_id, ordinal, conversation_id, operation_id, rejection)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            account_id,
            group_id,
            member.ordinal as i64,
            member.conversation_id,
            member.operation_id,
            member.rejection.map(crate::groups::rejection_name),
        ],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    Ok(())
}

fn group_receipt(
    group_id: &str,
    request_id: &str,
    account_id: &str,
    kind: MailboxOperationKind,
    requested_value: Option<bool>,
    accepted_at: &str,
    members: &[GroupMemberInsert],
) -> OperationGroupReceipt {
    OperationGroupReceipt {
        group_id: group_id.to_string(),
        request_id: request_id.to_string(),
        account_id: account_id.to_string(),
        kind,
        requested_archived: (kind == MailboxOperationKind::Archive)
            .then_some(requested_value)
            .flatten(),
        requested_read: (kind == MailboxOperationKind::Read)
            .then_some(requested_value)
            .flatten(),
        accepted_at: accepted_at.to_string(),
        members: members
            .iter()
            .map(|member| crate::groups::GroupMemberReceipt {
                ordinal: member.ordinal as u32,
                conversation: ConversationRef {
                    account_id: account_id.to_string(),
                    conversation_id: member.conversation_id.clone(),
                },
                operation_id: member.operation_id.clone(),
                rejection: member.rejection,
            })
            .collect(),
    }
}

/// Idempotent group-command replay: the stored canonical payload must match;
/// any other reuse of the request id is a typed conflict.
fn existing_group_receipt(
    conn: &Connection,
    account_id: &str,
    request_id: &str,
    payload: &str,
) -> Result<Option<OperationGroupReceipt>, MailError> {
    let existing = conn
        .query_row(
            "SELECT payload, operation_id FROM gmail_operation_requests
         WHERE account_id = ?1 AND request_id = ?2",
            params![account_id, request_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some((saved_payload, group_id)) = existing else {
        return Ok(None);
    };
    if saved_payload != payload {
        return Err(MailError::RequestIdConflict);
    }
    load_group_receipt(conn, account_id, &group_id).map(Some)
}

fn existing_group_undo_receipt(
    conn: &Connection,
    account_id: &str,
    request_id: &str,
    payload: &str,
) -> Result<Option<crate::groups::GroupUndoReceipt>, MailError> {
    let existing = conn
        .query_row(
            "SELECT payload, operation_id, accepted_at FROM gmail_operation_requests
         WHERE account_id = ?1 AND request_id = ?2",
            params![account_id, request_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some((saved_payload, group_id, accepted_at)) = existing else {
        return Ok(None);
    };
    if saved_payload != payload {
        return Err(MailError::RequestIdConflict);
    }
    let accepted_at = accepted_at.ok_or(MailError::StorageUnavailable)?;
    reconstruct_group_undo_receipt(conn, account_id, &group_id, request_id, &accepted_at).map(Some)
}

struct GroupHeader {
    group_id: String,
    request_id: String,
    kind: MailboxOperationKind,
    requested_value: bool,
    accepted_at: String,
    undone_at: Option<String>,
}

fn load_group_header(
    conn: &Connection,
    account_id: &str,
    group_id: &str,
) -> Result<Option<GroupHeader>, MailError> {
    let row = conn
        .query_row(
            "SELECT request_id, kind, requested_value, accepted_at, undone_at
             FROM gmail_operation_groups WHERE account_id = ?1 AND group_id = ?2",
            params![account_id, group_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some((request_id, kind, requested_value, accepted_at, undone_at)) = row else {
        return Ok(None);
    };
    Ok(Some(GroupHeader {
        group_id: group_id.to_string(),
        request_id,
        kind: parse_kind(&kind)?,
        requested_value: requested_value != 0,
        accepted_at,
        undone_at,
    }))
}

struct GroupMemberRow {
    ordinal: i64,
    conversation_id: String,
    operation_id: Option<String>,
    rejection: Option<GroupMemberRejection>,
    undo_decision: Option<String>,
    undo_skip_reason: Option<String>,
    undo_operation_ids: Option<String>,
}

fn load_group_undo_rows(
    conn: &Connection,
    account_id: &str,
    group_id: &str,
) -> Result<Vec<GroupMemberRow>, MailError> {
    let mut stmt = conn
        .prepare(
            "SELECT ordinal, conversation_id, operation_id, rejection,
                    undo_decision, undo_skip_reason, undo_operation_ids
             FROM gmail_operation_group_members
             WHERE account_id = ?1 AND group_id = ?2 ORDER BY ordinal",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    let rows = stmt
        .query_map(params![account_id, group_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(|_| MailError::StorageUnavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| MailError::StorageUnavailable)?;
    rows.into_iter()
        .map(
            |(
                ordinal,
                conversation_id,
                operation_id,
                rejection,
                undo_decision,
                undo_skip_reason,
                undo_operation_ids,
            )| {
                let rejection = rejection
                    .map(|name| {
                        crate::groups::rejection_from_name(&name)
                            .ok_or(MailError::StorageUnavailable)
                    })
                    .transpose()?;
                Ok(GroupMemberRow {
                    ordinal,
                    conversation_id,
                    operation_id,
                    rejection,
                    undo_decision,
                    undo_skip_reason,
                    undo_operation_ids,
                })
            },
        )
        .collect()
}

fn load_group_member_refs(
    conn: &Connection,
    account_id: &str,
    group_id: &str,
) -> Result<Vec<ConversationRef>, MailError> {
    let members = load_group_undo_rows(conn, account_id, group_id)?;
    Ok(members
        .into_iter()
        .map(|member| ConversationRef {
            account_id: account_id.to_string(),
            conversation_id: member.conversation_id,
        })
        .collect())
}

fn load_group_receipt(
    conn: &Connection,
    account_id: &str,
    group_id: &str,
) -> Result<OperationGroupReceipt, MailError> {
    let header =
        load_group_header(conn, account_id, group_id)?.ok_or(MailError::StorageUnavailable)?;
    let members = load_group_undo_rows(conn, account_id, group_id)?;
    Ok(group_receipt(
        &header.group_id,
        &header.request_id,
        account_id,
        header.kind,
        Some(header.requested_value),
        &header.accepted_at,
        &members
            .iter()
            .map(|member| GroupMemberInsert {
                ordinal: member.ordinal as usize,
                conversation_id: member.conversation_id.clone(),
                operation_id: member.operation_id.clone(),
                rejection: member.rejection,
            })
            .collect::<Vec<_>>(),
    ))
}

/// Whole-group eligibility (§5): not already undone, inside the 10 s window
/// from the group's acceptance, and still the newest top-level action.
/// Per-member ineligibility never rejects the attempt; it becomes a persisted
/// skip.
fn check_group_undoable(
    conn: &Connection,
    account_id: &str,
    header: &GroupHeader,
    now: &str,
) -> Result<(), MailError> {
    if header.undone_at.is_some() {
        return Err(undo_unavailable(UndoUnavailableReason::AlreadyUndone));
    }
    if !crate::clock::within_undo_window(&header.accepted_at, now) {
        return Err(undo_unavailable(UndoUnavailableReason::Expired));
    }
    if latest_action_id(conn, account_id)?.as_deref() != Some(header.group_id.as_str()) {
        return Err(undo_unavailable(UndoUnavailableReason::Superseded));
    }
    Ok(())
}

fn member_status_of(status: OperationStatus) -> crate::groups::GroupMemberStatus {
    match status {
        OperationStatus::Queued => crate::groups::GroupMemberStatus::Queued,
        OperationStatus::Applying => crate::groups::GroupMemberStatus::Applying,
        OperationStatus::Confirmed => crate::groups::GroupMemberStatus::Confirmed,
        OperationStatus::Failed => crate::groups::GroupMemberStatus::Failed,
        OperationStatus::OutcomeUnknown => crate::groups::GroupMemberStatus::OutcomeUnknown,
        OperationStatus::Cancelled => crate::groups::GroupMemberStatus::Cancelled,
    }
}

fn load_group_status(
    conn: &Connection,
    account_id: &str,
    group_id: &str,
    now: String,
) -> Result<OperationGroupStatus, MailError> {
    let header =
        load_group_header(conn, account_id, group_id)?.ok_or(MailError::StorageUnavailable)?;
    let members = load_group_undo_rows(conn, account_id, group_id)?;
    let mut views = Vec::with_capacity(members.len());
    for member in &members {
        let (status, failure) = if member.rejection.is_some() {
            (crate::groups::GroupMemberStatus::Rejected, None)
        } else {
            let Some(operation_id) = &member.operation_id else {
                return Err(MailError::StorageUnavailable);
            };
            let row = conn
                .query_row(
                    "SELECT status, failure FROM gmail_operations
                     WHERE account_id = ?1 AND operation_id = ?2",
                    params![account_id, operation_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()
                .map_err(|_| MailError::StorageUnavailable)?
                .ok_or(MailError::StorageUnavailable)?;
            let failure = row.1.map(|f| {
                if f == "providerunavailable" {
                    OperationFailure::ProviderUnavailable
                } else {
                    OperationFailure::ProviderRejected
                }
            });
            (member_status_of(parse_status(&row.0)?), failure)
        };
        views.push(crate::groups::GroupMemberStatusView {
            ordinal: member.ordinal as u32,
            conversation: ConversationRef {
                account_id: account_id.to_string(),
                conversation_id: member.conversation_id.clone(),
            },
            operation_id: member.operation_id.clone(),
            status,
            failure,
            rejection: member.rejection,
        });
    }
    let undo = group_undo_availability(conn, account_id, &header, &members, &now)?;
    let group = load_group_receipt(conn, account_id, group_id)?;
    let undo_receipt = persisted_group_undo_record(conn, account_id, group_id, &members)?;
    Ok(OperationGroupStatus {
        group,
        members: views,
        undo,
        undo_receipt,
    })
}

/// Persisted group-Undo attempt for this group, rebuilt from the stored
/// per-member decisions plus the live compensation rows (§4.2/§5). `None`
/// until a group Undo has been accepted; a restart or lost Undo response
/// still returns the committed record. The Gmail store keeps the undo request
/// in `gmail_operation_requests` under the group-undo payload;
/// `operation_id` carries the group id.
fn persisted_group_undo_record(
    conn: &Connection,
    account_id: &str,
    group_id: &str,
    members: &[GroupMemberRow],
) -> Result<Option<crate::groups::GroupUndoRecord>, MailError> {
    let undo_request: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT request_id, accepted_at FROM gmail_operation_requests
             WHERE account_id = ?1 AND operation_id = ?2
               AND payload LIKE '{\"undoGroupId\":%'
             ORDER BY accepted_at DESC LIMIT 1",
            params![account_id, group_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some((request_id, accepted_at)) = undo_request else {
        return Ok(None);
    };
    let accepted_at = accepted_at.ok_or(MailError::StorageUnavailable)?;
    let mut views = Vec::with_capacity(members.len());
    for member in members {
        let Some(decision_json) = &member.undo_decision else {
            // Members persisted before the group's Undo attempt carry no
            // decision; the record is only built after one was accepted.
            return Ok(None);
        };
        let decision = match decision_json.as_str() {
            "cancelled" => crate::groups::GroupMemberUndoDecision::Cancelled,
            "compensating" => crate::groups::GroupMemberUndoDecision::Compensating,
            "skipped" => {
                let reason = member
                    .undo_skip_reason
                    .as_deref()
                    .and_then(crate::groups::skip_reason_from_name)
                    .ok_or(MailError::StorageUnavailable)?;
                crate::groups::GroupMemberUndoDecision::Skipped { reason }
            }
            _ => return Err(MailError::StorageUnavailable),
        };
        let compensation_ids: Vec<String> = member
            .undo_operation_ids
            .as_deref()
            .map(|json| serde_json::from_str(json).map_err(|_| MailError::StorageUnavailable))
            .transpose()?
            .unwrap_or_default();
        let mut compensations = Vec::with_capacity(compensation_ids.len());
        for compensation_id in compensation_ids {
            let row = conn
                .query_row(
                    "SELECT status, failure FROM gmail_operations
                     WHERE account_id = ?1 AND operation_id = ?2",
                    params![account_id, compensation_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()
                .map_err(|_| MailError::StorageUnavailable)?
                .ok_or(MailError::StorageUnavailable)?;
            let failure = row.1.map(|f| {
                if f == "providerunavailable" {
                    OperationFailure::ProviderUnavailable
                } else {
                    OperationFailure::ProviderRejected
                }
            });
            compensations.push(crate::groups::GroupCompensationStatus {
                operation_id: compensation_id,
                status: parse_status(&row.0)?,
                failure,
            });
        }
        views.push(crate::groups::GroupMemberUndoStatus {
            ordinal: member.ordinal as u32,
            decision,
            compensations,
        });
    }
    Ok(Some(crate::groups::GroupUndoRecord {
        request_id,
        accepted_at,
        members: views,
    }))
}

fn group_undo_availability(
    conn: &Connection,
    account_id: &str,
    header: &GroupHeader,
    members: &[GroupMemberRow],
    now: &str,
) -> Result<crate::groups::GroupUndoAvailability, MailError> {
    if header.undone_at.is_some() {
        return Ok(crate::groups::GroupUndoAvailability {
            available: false,
            reason: Some(UndoUnavailableReason::AlreadyUndone),
            undoable_until: None,
        });
    }
    if !crate::clock::within_undo_window(&header.accepted_at, now) {
        return Ok(crate::groups::GroupUndoAvailability {
            available: false,
            reason: Some(UndoUnavailableReason::Expired),
            undoable_until: None,
        });
    }
    if latest_action_id(conn, account_id)?.as_deref() != Some(header.group_id.as_str()) {
        return Ok(crate::groups::GroupUndoAvailability {
            available: false,
            reason: Some(UndoUnavailableReason::Superseded),
            undoable_until: None,
        });
    }
    // An all-ineligible group offers no enabled Undo (§5).
    let mut any_eligible = false;
    for member in members {
        if member.rejection.is_some() {
            continue;
        }
        let Some(operation_id) = &member.operation_id else {
            continue;
        };
        let Some(record) = load_operation(conn, account_id, operation_id)? else {
            continue;
        };
        let live = matches!(
            record.status,
            OperationStatus::Queued | OperationStatus::Applying | OperationStatus::Confirmed
        );
        if live
            && !has_undo_rows(conn, account_id, operation_id)?
            && !has_unknown_prior_value(conn, account_id, operation_id)?
        {
            any_eligible = true;
        }
    }
    if !any_eligible {
        return Ok(crate::groups::GroupUndoAvailability {
            available: false,
            reason: Some(UndoUnavailableReason::NotApplicable),
            undoable_until: None,
        });
    }
    Ok(crate::groups::GroupUndoAvailability {
        available: true,
        reason: None,
        undoable_until: crate::clock::undo_deadline_iso(&header.accepted_at),
    })
}

fn group_decision_name(decision: &crate::groups::GroupMemberUndoDecision) -> &'static str {
    match decision {
        crate::groups::GroupMemberUndoDecision::Cancelled => "cancelled",
        crate::groups::GroupMemberUndoDecision::Compensating => "compensating",
        crate::groups::GroupMemberUndoDecision::Skipped { .. } => "skipped",
    }
}

fn decision_skip_reason(
    decision: &crate::groups::GroupMemberUndoDecision,
) -> Option<crate::groups::GroupUndoSkipReason> {
    match decision {
        crate::groups::GroupMemberUndoDecision::Skipped { reason } => Some(*reason),
        _ => None,
    }
}

/// Per-member group Undo decision (§5): queued → atomic cancel;
/// applying/confirmed → ordered compensation from the original immutable
/// targets and preimages; everything else is an explicit persisted skip.
fn decide_member_undo(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    member: &GroupMemberRow,
    accepted_at: &str,
) -> Result<(crate::groups::GroupMemberUndoDecision, Vec<String>), MailError> {
    if member.rejection.is_some() {
        return Ok((
            crate::groups::GroupMemberUndoDecision::Skipped {
                reason: crate::groups::GroupUndoSkipReason::AcceptanceRejected,
            },
            Vec::new(),
        ));
    }
    let Some(operation_id) = &member.operation_id else {
        return Err(MailError::StorageUnavailable);
    };
    let Some(target) = load_undo_target(tx, account_id, operation_id)? else {
        return Err(MailError::StorageUnavailable);
    };
    match target.status {
        OperationStatus::Failed => Ok((
            crate::groups::GroupMemberUndoDecision::Skipped {
                reason: crate::groups::GroupUndoSkipReason::Failed,
            },
            Vec::new(),
        )),
        OperationStatus::OutcomeUnknown => Ok((
            crate::groups::GroupMemberUndoDecision::Skipped {
                reason: crate::groups::GroupUndoSkipReason::OutcomeUnknown,
            },
            Vec::new(),
        )),
        OperationStatus::Cancelled => Ok((
            crate::groups::GroupMemberUndoDecision::Skipped {
                reason: crate::groups::GroupUndoSkipReason::AlreadyUndone,
            },
            Vec::new(),
        )),
        OperationStatus::Queued => {
            let cancelled = tx
                .execute(
                    "UPDATE gmail_operations SET status = 'cancelled', last_error = NULL
                     WHERE account_id = ?1 AND operation_id = ?2 AND status = 'queued'",
                    params![account_id, target.operation_id],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
            if cancelled == 1 {
                Ok((
                    crate::groups::GroupMemberUndoDecision::Cancelled,
                    Vec::new(),
                ))
            } else {
                // Defensive: the status was read in this same transaction,
                // which runs under the connection mutex the worker's claim
                // also needs.
                member_compensation(tx, account_id, &target, accepted_at)
            }
        }
        OperationStatus::Applying | OperationStatus::Confirmed => {
            member_compensation(tx, account_id, &target, accepted_at)
        }
    }
}

fn member_compensation(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    target: &UndoTarget,
    accepted_at: &str,
) -> Result<(crate::groups::GroupMemberUndoDecision, Vec<String>), MailError> {
    match compensate_tx(tx, account_id, target, accepted_at) {
        Ok(receipt) => Ok((
            crate::groups::GroupMemberUndoDecision::Compensating,
            receipt.operation_ids,
        )),
        Err(MailError::UndoUnavailable {
            reason: UndoUnavailableReason::UnknownPrior,
        }) => Ok((
            crate::groups::GroupMemberUndoDecision::Skipped {
                reason: crate::groups::GroupUndoSkipReason::UnknownPrior,
            },
            Vec::new(),
        )),
        Err(error) => Err(error),
    }
}

fn reconstruct_group_undo_receipt(
    conn: &Connection,
    account_id: &str,
    group_id: &str,
    request_id: &str,
    accepted_at: &str,
) -> Result<crate::groups::GroupUndoReceipt, MailError> {
    let members = load_group_undo_rows(conn, account_id, group_id)?;
    let mut results = Vec::with_capacity(members.len());
    for member in members {
        let decision = match member.undo_decision.as_deref() {
            Some("cancelled") => crate::groups::GroupMemberUndoDecision::Cancelled,
            Some("compensating") => crate::groups::GroupMemberUndoDecision::Compensating,
            Some("skipped") => {
                let reason = member
                    .undo_skip_reason
                    .as_deref()
                    .and_then(crate::groups::skip_reason_from_name)
                    .ok_or(MailError::StorageUnavailable)?;
                crate::groups::GroupMemberUndoDecision::Skipped { reason }
            }
            _ => return Err(MailError::StorageUnavailable),
        };
        let operation_ids = member
            .undo_operation_ids
            .as_deref()
            .map(|json| serde_json::from_str(json).map_err(|_| MailError::StorageUnavailable))
            .transpose()?
            .unwrap_or_default();
        results.push(crate::groups::GroupMemberUndoResult {
            ordinal: member.ordinal as u32,
            conversation: ConversationRef {
                account_id: account_id.to_string(),
                conversation_id: member.conversation_id,
            },
            decision,
            operation_ids,
        });
    }
    Ok(crate::groups::GroupUndoReceipt {
        group_id: group_id.to_string(),
        request_id: request_id.to_string(),
        accepted_at: accepted_at.to_string(),
        members: results,
    })
}

fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, MailError> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|_| MailError::StorageUnavailable)
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), MailError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    Ok(())
}

fn meta_del(conn: &Connection, key: &str) -> Result<(), MailError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", params![key])
        .map_err(|_| MailError::StorageUnavailable)?;
    Ok(())
}

fn generation_of(conn: &Connection) -> Result<u64, MailError> {
    Ok(meta_get(conn, "generation")?
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0))
}

/// Guard evaluated inside every checkpointed write transaction: writes from a
/// pass that raced a disconnect are discarded, never applied.
fn generation_matches(conn: &Connection, expected: u64) -> Result<bool, MailError> {
    Ok(generation_of(conn)? == expected)
}

/// Invariant: checkpointed writes require a connected account. Violation
/// fails closed instead of writing unscoped rows.
fn account_id_of(conn: &Connection) -> Result<String, MailError> {
    meta_get(conn, "account_id")?.ok_or(MailError::StorageUnavailable)
}

/// Replaces one thread's cached facts atomically. Effective INBOX membership
/// is derived from `inbox_message_ids`, never trusted from the provider
/// conversation flags. Pathological provider data (empty ids) fails typed.
fn upsert_thread(
    conn: &Connection,
    account_id: &str,
    thread: &GmailThread,
) -> Result<(), MailError> {
    if thread.conversation.conversation_ref.account_id != account_id {
        return Err(MailError::InvalidProviderResponse);
    }
    let conversation_id = &thread.conversation.conversation_ref.conversation_id;
    if conversation_id.is_empty() {
        return Err(MailError::InvalidProviderResponse);
    }
    if thread.inbox_message_ids.is_empty() {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM gmail_conversations
                 WHERE account_id = ?1 AND conversation_id = ?2)",
                params![account_id, conversation_id],
                |row| row.get(0),
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        if !exists {
            // History can mention arbitrarily old archived threads. Keep their
            // bodies out of the bounded cache, but refresh facts needed by a
            // durable operation's recovery view and future target snapshots.
            let retained_by_operation: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM gmail_operation_targets
                     WHERE account_id = ?1 AND conversation_id = ?2)",
                    params![account_id, conversation_id],
                    |row| row.get(0),
                )
                .map_err(|_| MailError::StorageUnavailable)?;
            if retained_by_operation {
                upsert_message_facts(conn, account_id, thread)?;
            }
            return Ok(());
        }
    }
    conn.execute(
        "INSERT INTO gmail_conversations
            (account_id, conversation_id, subject, context_complete, unsupported_reason,
             reply_context_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(account_id, conversation_id) DO UPDATE SET
            subject = excluded.subject,
            context_complete = excluded.context_complete,
            unsupported_reason = excluded.unsupported_reason,
            reply_context_json = excluded.reply_context_json",
        params![
            account_id,
            conversation_id,
            thread.conversation.subject,
            thread.conversation.context_complete.unwrap_or(false) as i64,
            thread.conversation.unsupported_reason,
            thread
                .conversation
                .reply_context
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|_| MailError::StorageUnavailable)?,
        ],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    conn.execute(
        "DELETE FROM gmail_messages WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    conn.execute(
        "DELETE FROM gmail_inbox_membership WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    for message_id in &thread.inbox_message_ids {
        conn.execute(
            "INSERT INTO gmail_inbox_membership (account_id, conversation_id, message_id)
             VALUES (?1, ?2, ?3)",
            params![account_id, conversation_id, message_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    }
    upsert_message_facts(conn, account_id, thread)?;
    for message in &thread.conversation.messages {
        let in_inbox = thread.inbox_message_ids.iter().any(|id| id == &message.id);
        let to_json =
            serde_json::to_string(&message.to).map_err(|_| MailError::StorageUnavailable)?;
        conn.execute(
            "INSERT OR REPLACE INTO gmail_messages
                (account_id, conversation_id, message_id, from_display, from_mailbox,
                 to_json, sent_at, body_text, in_inbox)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                account_id,
                conversation_id,
                message.id,
                message.from.display_name,
                message.from.mailbox,
                to_json,
                message.sent_at,
                message.body_text,
                in_inbox as i64,
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    }
    Ok(())
}

/// Replaces provider facts without requiring body-cache admission. Operation-
/// retained archived conversations still need current inventory and labels for
/// recovery reads and future immutable target snapshots.
fn upsert_message_facts(
    conn: &Connection,
    account_id: &str,
    thread: &GmailThread,
) -> Result<(), MailError> {
    let conversation_id = &thread.conversation.conversation_ref.conversation_id;
    conn.execute(
        "DELETE FROM gmail_message_facts WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    let mut inventory = thread.message_ids.clone().unwrap_or_else(|| {
        let mut ids = thread.inbox_message_ids.clone();
        for message in &thread.conversation.messages {
            if !ids.contains(&message.id) {
                ids.push(message.id.clone());
            }
        }
        ids
    });
    inventory.sort();
    inventory.dedup();
    for message_id in &inventory {
        let inbox = thread.inbox_message_ids.iter().any(|id| id == message_id) as i64;
        let unread = thread
            .unread_message_ids
            .as_ref()
            .map(|ids| ids.iter().any(|id| id == message_id) as i64);
        conn.execute(
            "INSERT INTO gmail_message_facts (account_id, conversation_id, message_id, in_inbox, is_unread)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![account_id, conversation_id, message_id, inbox, unread],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    }
    Ok(())
}

fn trim_cache(conn: &Connection, account_id: &str) -> Result<(), MailError> {
    evict_over_cap(conn, account_id, false)
}

fn trim_discovery_cache(conn: &Connection, account_id: &str) -> Result<(), MailError> {
    evict_over_cap(conn, account_id, true)
}

/// Evicts excess conversations in one transaction. During rediscovery, ids
/// observed in the current pass are retained ahead of old cache entries.
fn evict_over_cap(
    conn: &Connection,
    account_id: &str,
    prefer_discovery_seen: bool,
) -> Result<(), MailError> {
    let seen_order = if prefer_discovery_seen {
        "CASE WHEN EXISTS (
             SELECT 1 FROM gmail_discovery_seen s
             WHERE s.conversation_id = c.conversation_id
         ) THEN 0 ELSE 1 END,"
    } else {
        ""
    };
    let sql = format!(
        "SELECT c.conversation_id FROM gmail_conversations c
         LEFT JOIN gmail_messages m
           ON m.account_id = c.account_id
          AND m.conversation_id = c.conversation_id
         WHERE c.account_id = ?1
         GROUP BY c.conversation_id
         ORDER BY {seen_order} MAX(m.sent_at) DESC, c.conversation_id ASC
         LIMIT -1 OFFSET ?2"
    );
    let evicted = {
        let mut statement = conn
            .prepare(&sql)
            .map_err(|_| MailError::StorageUnavailable)?;
        let rows = statement
            .query_map(params![account_id, DISCOVERY_CAP as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
        rows
    };
    for conversation_id in evicted {
        conn.execute(
            "DELETE FROM gmail_messages WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        conn.execute(
            "DELETE FROM gmail_message_facts
             WHERE account_id = ?1 AND conversation_id = ?2
               AND NOT EXISTS (
                 SELECT 1 FROM gmail_operation_targets t
                 WHERE t.account_id = gmail_message_facts.account_id
                   AND t.conversation_id = gmail_message_facts.conversation_id
                   AND t.message_id = gmail_message_facts.message_id)",
            params![account_id, conversation_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        conn.execute(
            "DELETE FROM gmail_inbox_membership WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        conn.execute(
            "DELETE FROM gmail_conversations WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    }
    Ok(())
}

fn delete_conversation(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<(), MailError> {
    conn.execute(
        "DELETE FROM gmail_messages WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    conn.execute(
        "DELETE FROM gmail_inbox_membership WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    conn.execute(
        "DELETE FROM gmail_message_facts WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    conn.execute(
        "DELETE FROM gmail_conversations WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    Ok(())
}

struct BuiltConversation {
    conversation_ref: ConversationRef,
    subject: String,
    messages: Vec<Message>,
    context_complete: Option<bool>,
    unsupported_reason: Option<String>,
    reply_context: Option<ReplyContext>,
}

fn build_conversation(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<Option<BuiltConversation>, MailError> {
    let row = conn
        .query_row(
            "SELECT subject, context_complete, unsupported_reason, reply_context_json
             FROM gmail_conversations WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some((subject, context_flag, unsupported_reason, reply_context_json)) = row else {
        return Ok(None);
    };
    let mut stmt = conn
        .prepare(
            "SELECT message_id, from_display, from_mailbox, to_json, sent_at, body_text, in_inbox
             FROM gmail_messages
             WHERE account_id = ?1 AND conversation_id = ?2
             ORDER BY sent_at ASC, message_id ASC",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    let messages: Vec<(Message, bool)> = stmt
        .query_map(params![account_id, conversation_id], |row| {
            let from_display: Option<String> = row.get(1)?;
            let to_json: String = row.get(3)?;
            Ok((
                Message {
                    id: row.get(0)?,
                    from: Address {
                        display_name: from_display,
                        mailbox: row.get(2)?,
                    },
                    to: serde_json::from_str(&to_json).map_err(|_| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            "invalid address JSON".into(),
                        )
                    })?,
                    sent_at: row.get(4)?,
                    body_text: row.get(5)?,
                },
                row.get::<_, i64>(6)? != 0,
            ))
        })
        .map_err(|_| MailError::StorageUnavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| MailError::StorageUnavailable)?;
    Ok(Some(BuiltConversation {
        conversation_ref: ConversationRef {
            account_id: account_id.to_string(),
            conversation_id: conversation_id.to_string(),
        },
        subject,
        messages: messages.into_iter().map(|(message, _)| message).collect(),
        context_complete: Some(context_flag != 0),
        unsupported_reason,
        reply_context: reply_context_json
            .map(|json| serde_json::from_str::<ReplyContext>(&json))
            .transpose()
            .map_err(|_| MailError::StorageUnavailable)?,
    }))
}

fn participants_of(messages: &[Message]) -> Vec<Address> {
    let mut seen_mailboxes: Vec<String> = Vec::new();
    let mut participants: Vec<Address> = Vec::new();
    for message in messages {
        let mut push = |address: &Address| {
            if !seen_mailboxes.contains(&address.mailbox) {
                seen_mailboxes.push(address.mailbox.clone());
                participants.push(address.clone());
            }
        };
        push(&message.from);
        for to in &message.to {
            push(to);
        }
    }
    participants
}

fn preview_of(messages: &[Message]) -> String {
    const PREVIEW_MAX_CHARS: usize = 140;
    messages
        .last()
        .map(|message| {
            let line = message
                .body_text
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or_default();
            let mut preview: String = line.chars().take(PREVIEW_MAX_CHARS).collect();
            if line.chars().count() > PREVIEW_MAX_CHARS {
                preview.push('…');
            }
            preview
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::SystemClock;
    use crate::dto::Message;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "mail-core-gmail-store-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    fn open_store(tag: &str) -> (GmailStore, std::path::PathBuf) {
        let dir = temp_dir(tag);
        let store = GmailStore::open(&dir, Arc::new(SystemClock)).expect("store opens");
        (store, dir)
    }

    fn profile(account_id: &str, email: &str, history_id: &str) -> GmailProfile {
        GmailProfile {
            account_id: account_id.to_string(),
            email_address: email.to_string(),
            history_id: history_id.to_string(),
        }
    }

    fn message(id: &str, sent_at: &str) -> Message {
        Message {
            id: id.to_string(),
            from: Address {
                display_name: Some("Sender".to_string()),
                mailbox: "sender@example.test".to_string(),
            },
            to: Vec::new(),
            sent_at: sent_at.to_string(),
            body_text: "plain text body".to_string(),
        }
    }

    fn thread(
        account_id: &str,
        id: &str,
        history_id: &str,
        msgs: Vec<Message>,
        inbox: &[&str],
    ) -> GmailThread {
        let is_in_inbox = inbox
            .iter()
            .any(|inbox_id| msgs.iter().any(|m| m.id == **inbox_id));
        GmailThread {
            conversation: Conversation {
                conversation_ref: ConversationRef {
                    account_id: account_id.to_string(),
                    conversation_id: id.to_string(),
                },
                subject: format!("subject {id}"),
                messages: msgs,
                is_in_inbox,
                is_read: None,
                context_complete: Some(true),
                unsupported_reason: None,
                retained_snapshot_at: None,
                reply_context: None,
                pending_operation_id: None,
            },
            inbox_message_ids: inbox.iter().map(|s| s.to_string()).collect(),
            message_ids: None,
            unread_message_ids: None,
            history_id: history_id.to_string(),
        }
    }

    fn cached(thread: GmailThread) -> ThreadFetch {
        ThreadFetch::Cached(Box::new(thread))
    }

    #[test]
    fn reply_context_cache_is_additive_persistent_and_metadata_only() {
        let (store, dir) = open_store("reply-context-cache");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
            .expect("account");
        let source = thread(
            "acct-alpha",
            "thr-reply",
            "hist-2",
            vec![
                message("m-old", "2026-01-01T00:00:00Z"),
                message("m-latest", "2026-01-02T00:00:00Z"),
            ],
            &["m-latest"],
        );
        store
            .apply_discovery_page(&[cached(source.clone())], None, true, false, 0)
            .expect("cache source");
        let target = ConversationRef {
            account_id: "acct-alpha".to_string(),
            conversation_id: "thr-reply".to_string(),
        };
        let before = store.get_conversation(&target).expect("cached reader");
        let cursor_before = store.cursor().expect("cursor");
        let context = ReplyContext {
            source_message_id: "m-latest".to_string(),
            from_mailbox: "sender@example.test".to_string(),
            reply_to_mailboxes: None,
            message_id: "<m-latest@example.test>".to_string(),
            references: vec![
                "<m-old@example.test>".to_string(),
                "<m-latest@example.test>".to_string(),
            ],
        };

        assert!(!store
            .save_reply_context(&target, "m-old", &context, 0)
            .expect("stale source rejected"));
        assert!(!store
            .save_reply_context(
                &ConversationRef {
                    account_id: "acct-beta".to_string(),
                    ..target.clone()
                },
                "m-latest",
                &context,
                0,
            )
            .expect("foreign account rejected"));
        assert!(store
            .save_reply_context(&target, "m-latest", &context, 0)
            .expect("metadata saved"));
        let after = store
            .get_conversation(&target)
            .expect("reader after metadata");
        assert_eq!(after.reply_context, Some(context.clone()));
        assert_eq!(after.messages, before.messages);
        assert_eq!(after.subject, before.subject);
        assert_eq!(after.is_in_inbox, before.is_in_inbox);
        assert_eq!(store.cursor().expect("cursor unchanged"), cursor_before);

        // Restart preserves metadata; a legacy database without the new column
        // migrates it additively and leaves old rows NULL.
        drop(store);
        let reopened = GmailStore::open(&dir, Arc::new(SystemClock)).expect("reopen");
        assert_eq!(
            reopened
                .get_conversation(&target)
                .expect("persisted reader")
                .reply_context,
            Some(context)
        );
        drop(reopened);
        let legacy = Connection::open(dir.join("gmail.db")).expect("legacy db");
        legacy
            .execute(
                "ALTER TABLE gmail_conversations DROP COLUMN reply_context_json",
                [],
            )
            .expect("simulate legacy schema");
        drop(legacy);
        let migrated = GmailStore::open(&dir, Arc::new(SystemClock)).expect("additive migration");
        assert_eq!(
            migrated
                .get_conversation(&target)
                .expect("legacy reader")
                .reply_context,
            None
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_cached_reply_context_is_a_storage_error() {
        let (store, dir) = open_store("reply-context-invalid-json");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
            .expect("account");
        let source = thread(
            "acct-alpha",
            "thr-invalid-json",
            "hist-2",
            vec![message("m-latest", "2026-01-02T00:00:00Z")],
            &["m-latest"],
        );
        store
            .apply_discovery_page(&[cached(source)], None, true, false, 0)
            .expect("cache source");
        {
            let conn = store.lock_conn().expect("cache lock");
            conn.execute(
                "UPDATE gmail_conversations SET reply_context_json = '{not-json}'
                 WHERE account_id = 'acct-alpha' AND conversation_id = 'thr-invalid-json'",
                [],
            )
            .expect("corrupt cached JSON");
        }
        assert_eq!(
            store.get_conversation(&ConversationRef {
                account_id: "acct-alpha".to_string(),
                conversation_id: "thr-invalid-json".to_string(),
            }),
            Err(MailError::StorageUnavailable)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reply_context_save_rejects_generation_and_latest_source_races() {
        let (store, dir) = open_store("reply-context-races");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
            .expect("account");
        let source = thread(
            "acct-alpha",
            "thr-race",
            "hist-2",
            vec![
                message("m1", "2026-01-01T00:00:00Z"),
                message("m2", "2026-01-02T00:00:00Z"),
            ],
            &["m2"],
        );
        store
            .apply_discovery_page(&[cached(source)], None, true, false, 0)
            .expect("cache source");
        let target = ConversationRef {
            account_id: "acct-alpha".to_string(),
            conversation_id: "thr-race".to_string(),
        };
        let context = ReplyContext {
            source_message_id: "m2".to_string(),
            from_mailbox: "sender@example.test".to_string(),
            reply_to_mailboxes: None,
            message_id: "<m2@example.test>".to_string(),
            references: vec!["<m2@example.test>".to_string()],
        };
        {
            let conn = store.lock_conn().expect("test cache lock");
            conn.execute(
                "INSERT INTO gmail_messages
                 (account_id, conversation_id, message_id, from_display, from_mailbox,
                  to_json, sent_at, body_text, in_inbox)
                 VALUES ('acct-alpha', 'thr-race', 'm3', NULL, 'new@example.test', '[]',
                         '2026-01-03T00:00:00Z', 'new body', 1)",
                [],
            )
            .expect("simulate newer cached source");
        }
        assert!(!store
            .save_reply_context(&target, "m2", &context, 0)
            .expect("changed latest source rejected"));
        store.advance_generation().expect("disconnect generation");
        assert!(!store
            .save_reply_context(&target, "m2", &context, 0)
            .expect("old generation rejected"));
        assert_eq!(
            store
                .get_conversation(&target)
                .expect("reader")
                .reply_context,
            None
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    fn history_page(
        changed: Vec<ThreadFetch>,
        deleted: Vec<&str>,
        next: Option<&str>,
        history_id: &str,
    ) -> (HistoryPage, Vec<ThreadFetch>) {
        let page = HistoryPage {
            changed_thread_ids: changed.iter().map(|f| f.id().to_string()).collect(),
            deleted_message_ids: deleted.into_iter().map(str::to_string).collect(),
            next_page_token: next.map(str::to_string),
            history_id: history_id.to_string(),
        };
        (page, changed)
    }

    #[test]
    fn account_identity_mismatch_fails_closed() {
        let (store, dir) = open_store("identity");
        assert_eq!(
            store.begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0),
            Ok(Commit::Applied)
        );
        match store.begin_account(&profile("acct-beta", "beta@example.test", "hist-2"), 0) {
            Err(MailError::InvalidRequest { field }) => assert_eq!(field, "accountId"),
            other => panic!("expected invalid_request(accountId), got {other:?}"),
        }
        assert_eq!(
            store.account().expect("account"),
            Some(AccountInfo {
                account_id: "acct-alpha".to_string(),
                email_address: "alpha@example.test".to_string(),
            })
        );
        // Baseline cursor was pinned by the first begin_account only.
        assert_eq!(store.cursor().expect("cursor").as_deref(), Some("hist-1"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn baseline_is_pinned_before_discovery_and_pages_are_idempotent() {
        let (store, dir) = open_store("discovery");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-base"), 0)
            .expect("begin account");
        assert_eq!(
            store.discovery().expect("discovery"),
            DiscoveryProgress::Pending,
            "baseline pinned before discovery, discovery still pending"
        );
        let page1 = [cached(thread(
            "acct-alpha",
            "thr-1",
            "hist-base",
            vec![message("m-1", "2026-01-01T00:00:00Z")],
            &["m-1"],
        ))];
        store
            .apply_discovery_page(&page1, Some("page-2"), false, false, 0)
            .expect("page 1");
        assert!(matches!(
            store.discovery().expect("discovery"),
            DiscoveryProgress::Running { .. }
        ));
        let page2 = [cached(thread(
            "acct-alpha",
            "thr-2",
            "hist-base",
            vec![message("m-2", "2026-01-02T00:00:00Z")],
            &["m-2"],
        ))];
        store
            .apply_discovery_page(&page2, None, true, false, 0)
            .expect("page 2");
        assert!(matches!(
            store.discovery().expect("discovery"),
            DiscoveryProgress::Done
        ));
        assert_eq!(store.cached_count().expect("count"), 2);
        assert_eq!(
            store.seen_ids().expect("seen"),
            Vec::<String>::new(),
            "seen cleared on done"
        );
        // Replaying the final committed page must not duplicate anything.
        store
            .apply_discovery_page(&page2, None, true, false, 0)
            .expect("replay");
        assert_eq!(store.cached_count().expect("count"), 2, "idempotent replay");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn history_cursor_advances_only_after_the_final_page() {
        let (store, dir) = open_store("history-cursor");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-base"), 0)
            .expect("begin account");
        let (page1, fetched1) = history_page(
            vec![cached(thread(
                "acct-alpha",
                "thr-1",
                "hist-base",
                vec![message("m-1", "2026-01-01T00:00:00Z")],
                &["m-1"],
            ))],
            vec![],
            Some("hist-batch-2"),
            "hist-mid",
        );
        store
            .apply_history_page(&page1, &fetched1, "hist-base", 0)
            .expect("page 1");
        // Mid-batch: cursor unchanged, batch resumable from the original start.
        assert_eq!(
            store.cursor().expect("cursor").as_deref(),
            Some("hist-base")
        );
        assert_eq!(
            store.history().expect("history"),
            HistoryProgress::Resuming {
                batch_start: "hist-base".to_string(),
                page_token: Some("hist-batch-2".to_string()),
            }
        );
        let (page2, fetched2) = history_page(
            vec![cached(thread(
                "acct-alpha",
                "thr-2",
                "hist-base",
                vec![message("m-2", "2026-01-02T00:00:00Z")],
                &["m-2"],
            ))],
            vec![],
            None,
            "hist-final",
        );
        store
            .apply_history_page(&page2, &fetched2, "hist-base", 0)
            .expect("page 2");
        assert_eq!(
            store.cursor().expect("cursor").as_deref(),
            Some("hist-final")
        );
        assert_eq!(
            store.history().expect("history"),
            HistoryProgress::Idle {
                cursor: Some("hist-final".to_string())
            }
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn migration_backfills_inbox_membership_from_existing_message_rows() {
        let (store, dir) = open_store("membership-migration");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
            .expect("begin account");
        store
            .apply_discovery_page(
                &[cached(thread(
                    "acct-alpha",
                    "thread-1",
                    "hist-1",
                    vec![message("message-1", "2026-01-01T00:00:00Z")],
                    &["message-1"],
                ))],
                None,
                true,
                false,
                0,
            )
            .expect("seed existing profile");
        drop(store);

        // Simulate a gmail-1 profile opened by the version before independent
        // membership storage was introduced; startup migration recreates and
        // backfills the table from its existing message rows.
        let legacy = Connection::open(dir.join("gmail.db")).expect("open legacy db");
        legacy
            .execute_batch("DROP TABLE gmail_inbox_membership")
            .expect("remove newly introduced table");
        drop(legacy);
        let migrated = GmailStore::open(&dir, Arc::new(SystemClock)).expect("migrated store");
        assert_eq!(
            migrated
                .list_snapshot()
                .expect("snapshot")
                .conversations
                .len(),
            1
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unsupported_inbox_membership_is_cached_without_a_renderable_body() {
        let (store, dir) = open_store("unsupported-membership");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
            .expect("begin account");
        let mut unsupported = thread(
            "acct-alpha",
            "html-only",
            "hist-1",
            Vec::new(),
            &["html-message"],
        );
        unsupported.conversation.subject = "HTML only".to_string();
        unsupported.conversation.context_complete = Some(false);
        unsupported.conversation.unsupported_reason = Some("no safe plain-text body".to_string());
        store
            .apply_discovery_page(&[cached(unsupported)], None, true, false, 0)
            .expect("persist unsupported membership");

        let snapshot = store.list_snapshot().expect("inbox snapshot");
        assert_eq!(snapshot.conversations.len(), 1);
        assert_eq!(snapshot.conversations[0].subject, "HTML only");
        let conversation = store
            .get_conversation(&ConversationRef {
                account_id: "acct-alpha".to_string(),
                conversation_id: "html-only".to_string(),
            })
            .expect("reader context remains reachable");
        assert!(conversation.messages.is_empty());
        assert_eq!(conversation.context_complete, Some(false));
        assert_eq!(
            conversation.unsupported_reason.as_deref(),
            Some("no safe plain-text body")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn account_mismatched_thread_facts_are_rejected_at_store_boundary() {
        let (store, dir) = open_store("thread-account-mismatch");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
            .expect("begin account");
        let foreign = thread(
            "acct-beta",
            "foreign-thread",
            "hist-2",
            vec![message("foreign-message", "2026-01-01T00:00:00Z")],
            &["foreign-message"],
        );
        assert_eq!(
            store.apply_discovery_page(&[cached(foreign)], None, true, false, 0),
            Err(MailError::InvalidProviderResponse)
        );
        assert_eq!(store.cached_count().expect("cache count"), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn discovery_checkpoints_keep_cache_capped_and_prefer_observed_threads() {
        let (store, dir) = open_store("partial-cap");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
            .expect("begin account");
        let initial: Vec<_> = (0..DISCOVERY_CAP)
            .map(|index| {
                cached(thread(
                    "acct-alpha",
                    &format!("old-{index:03}"),
                    "hist-1",
                    vec![message(
                        &format!("old-message-{index:03}"),
                        "2025-01-01T00:00:00Z",
                    )],
                    &[&format!("old-message-{index:03}")],
                ))
            })
            .collect();
        store
            .apply_discovery_page(&initial, None, true, false, 0)
            .expect("seed full cache");
        let fresh: Vec<_> = (0..60)
            .map(|index| {
                cached(thread(
                    "acct-alpha",
                    &format!("new-{index:03}"),
                    "hist-2",
                    vec![message(
                        &format!("new-message-{index:03}"),
                        "2026-01-01T00:00:00Z",
                    )],
                    &[&format!("new-message-{index:03}")],
                ))
            })
            .collect();
        store
            .apply_discovery_page(&fresh, Some("resume"), false, false, 0)
            .expect("commit partial rediscovery page");
        assert_eq!(
            store.cached_count().expect("bounded cache count"),
            DISCOVERY_CAP
        );
        let ids: Vec<_> = store
            .list_snapshot()
            .expect("snapshot")
            .conversations
            .into_iter()
            .map(|summary| summary.conversation_ref.conversation_id)
            .collect();
        for index in 0..60 {
            assert!(
                ids.contains(&format!("new-{index:03}")),
                "observed thread retained"
            );
        }
        // Completing an uncapped continuation remains capped before history.
        let tail: Vec<_> = (60..65)
            .map(|index| {
                cached(thread(
                    "acct-alpha",
                    &format!("new-{index:03}"),
                    "hist-2",
                    vec![message(
                        &format!("new-message-{index:03}"),
                        "2026-01-01T00:00:00Z",
                    )],
                    &[&format!("new-message-{index:03}")],
                ))
            })
            .collect();
        store
            .apply_discovery_page(&tail, None, true, false, 0)
            .expect("complete rediscovery");
        assert!(store.cached_count().expect("bounded cache count") <= DISCOVERY_CAP);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stale_inbox_membership_is_reconciled_by_a_complete_discovery_pass() {
        let (store, dir) = open_store("reconcile");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-base"), 0)
            .expect("begin account");
        let initial = [cached(thread(
            "acct-alpha",
            "thr-1",
            "hist-base",
            vec![message("m-1", "2026-01-01T00:00:00Z")],
            &["m-1"],
        ))];
        store
            .apply_discovery_page(&initial, None, true, false, 0)
            .expect("initial page");
        assert_eq!(
            store.list_snapshot().expect("snapshot").conversations.len(),
            1
        );
        // A later complete pass that does not observe thr-1 reconciles its
        // stale INBOX membership (external archive/delete), same transaction.
        store
            .apply_discovery_page(&[], None, true, false, 0)
            .expect("reconciling pass");
        let snapshot = store.list_snapshot().expect("snapshot");
        assert!(
            snapshot.conversations.is_empty(),
            "stale member dropped from inbox"
        );
        let conversation = store
            .get_conversation(&ConversationRef {
                account_id: "acct-alpha".to_string(),
                conversation_id: "thr-1".to_string(),
            })
            .expect("still cached and readable");
        assert!(!conversation.is_in_inbox);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn deleted_messages_emptied_conversations_are_removed() {
        let (store, dir) = open_store("deletion");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-base"), 0)
            .expect("begin account");
        let (page1, fetched1) = history_page(
            vec![cached(thread(
                "acct-alpha",
                "thr-1",
                "hist-base",
                vec![
                    message("m-1", "2026-01-01T00:00:00Z"),
                    message("m-2", "2026-01-02T00:00:00Z"),
                ],
                &["m-1", "m-2"],
            ))],
            vec![],
            None,
            "hist-1",
        );
        store
            .apply_history_page(&page1, &fetched1, "hist-base", 0)
            .expect("seed page");
        // Provider-reported thread deletion (get_thread -> None) removes the thread.
        let (page2, fetched2) = history_page(
            vec![ThreadFetch::Missing("thr-1".to_string())],
            vec![],
            None,
            "hist-2",
        );
        store
            .apply_history_page(&page2, &fetched2, "hist-1", 0)
            .expect("removal page");
        assert_eq!(store.cached_count().expect("count"), 0);
        match store.get_conversation(&ConversationRef {
            account_id: "acct-alpha".to_string(),
            conversation_id: "thr-1".to_string(),
        }) {
            Err(MailError::NotFound) => {}
            other => panic!("expected not_found, got {other:?}"),
        }
        // Message-level deletion that empties a conversation also removes it.
        let seeded = [cached(thread(
            "acct-alpha",
            "thr-2",
            "hist-2",
            vec![message("m-3", "2026-01-03T00:00:00Z")],
            &["m-3"],
        ))];
        store
            .apply_discovery_page(&seeded, None, true, false, 0)
            .expect("seed thr-2");
        let (page3, fetched3) = history_page(vec![], vec!["m-3"], None, "hist-3");
        store
            .apply_history_page(&page3, &fetched3, "hist-2", 0)
            .expect("message deletion page");
        assert_eq!(
            store.cached_count().expect("count"),
            0,
            "emptied conversation removed"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stale_generation_discards_disconnect_raced_writes() {
        let (store, dir) = open_store("generation");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-base"), 0)
            .expect("begin account");
        store.advance_generation().expect("advance");
        let page = [cached(thread(
            "acct-alpha",
            "thr-1",
            "hist-base",
            vec![message("m-1", "2026-01-01T00:00:00Z")],
            &["m-1"],
        ))];
        assert_eq!(
            store.apply_discovery_page(&page, None, true, false, 0),
            Ok(Commit::Discarded),
            "in-flight write from before the generation bump is discarded"
        );
        assert_eq!(
            store.cached_count().expect("count"),
            0,
            "stale result did not repopulate"
        );
        let fresh = [cached(thread(
            "acct-alpha",
            "thr-1",
            "hist-base",
            vec![message("m-1", "2026-01-01T00:00:00Z")],
            &["m-1"],
        ))];
        assert_eq!(
            store.apply_discovery_page(&fresh, None, true, false, 1),
            Ok(Commit::Applied),
            "a fresh pass after the bump applies normally"
        );
        assert_eq!(store.cached_count().expect("count"), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn clear_account_wipes_identity_cache_and_checkpoints() {
        let (store, dir) = open_store("clear");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-base"), 0)
            .expect("begin account");
        let page = [cached(thread(
            "acct-alpha",
            "thr-1",
            "hist-base",
            vec![message("m-1", "2026-01-01T00:00:00Z")],
            &["m-1"],
        ))];
        store
            .apply_discovery_page(&page, None, true, false, 0)
            .expect("page");
        store.clear_account().expect("clear");
        assert!(!store.has_account().expect("has account"));
        assert_eq!(store.account().expect("account"), None);
        assert_eq!(store.cached_count().expect("count"), 0);
        assert!(store
            .list_snapshot()
            .expect("snapshot")
            .conversations
            .is_empty());
        assert_eq!(store.cursor().expect("cursor"), None);
        assert!(matches!(
            store.discovery().expect("discovery"),
            DiscoveryProgress::Pending
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Storage failures surface typed instead of being logged-and-ignored.
    #[test]
    fn operation_recovery_snapshot_survives_cache_eviction_and_can_be_restored() {
        let (store, dir) = open_store("operation-retention");
        store
            .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
            .expect("begin account");
        store
            .apply_discovery_page(
                &[cached(thread(
                    "acct-alpha",
                    "old-target",
                    "hist-1",
                    vec![message("old-message", "2026-01-01T00:00:00Z")],
                    &["old-message"],
                ))],
                None,
                true,
                false,
                0,
            )
            .expect("seed target");
        let target = ConversationRef {
            account_id: "acct-alpha".to_string(),
            conversation_id: "old-target".to_string(),
        };
        store
            .accept_read(&SetRead {
                conversation: target.clone(),
                read: true,
                request_id: "retained-read".to_string(),
            })
            .expect("durable acceptance");

        let mut additions = Vec::new();
        for index in 0..100 {
            let id = format!("new-{index:03}");
            additions.push(cached(thread(
                "acct-alpha",
                &id,
                "hist-2",
                vec![message(
                    &format!("message-{index:03}"),
                    "2026-03-01T00:00:00Z",
                )],
                &[&format!("message-{index:03}")],
            )));
        }
        let page = HistoryPage {
            changed_thread_ids: Vec::new(),
            deleted_message_ids: Vec::new(),
            next_page_token: None,
            history_id: "hist-2".to_string(),
        };
        store
            .apply_history_page(&page, &additions, "hist-1", 0)
            .expect("evict old target");
        assert_eq!(store.cached_count().expect("cache count"), DISCOVERY_CAP);
        // A later history fetch sees the evicted operation context archived,
        // with a new message and changed UNREAD facts. Persist those facts
        // without admitting its bodies back into the bounded cache.
        let mut fetched = thread(
            "acct-alpha",
            "old-target",
            "hist-3",
            vec![
                message("old-message", "2026-01-01T00:00:00Z"),
                message("new-message", "2026-04-01T00:00:00Z"),
            ],
            &[],
        );
        fetched.message_ids = Some(vec!["old-message".to_string(), "new-message".to_string()]);
        fetched.unread_message_ids = Some(vec!["new-message".to_string()]);
        let refresh_page = HistoryPage {
            changed_thread_ids: vec!["old-target".to_string()],
            deleted_message_ids: Vec::new(),
            next_page_token: None,
            history_id: "hist-3".to_string(),
        };
        store
            .apply_history_page(&refresh_page, &[cached(fetched)], "hist-2", 0)
            .expect("refresh retained operation facts");
        assert_eq!(store.cached_count().expect("bounded cache"), DISCOVERY_CAP);

        let retained = store
            .get_conversation(&target)
            .expect("retained recovery reader");
        assert!(retained
            .retained_snapshot_at
            .as_deref()
            .is_some_and(|saved_at| saved_at.contains('T')));
        assert_eq!(retained.messages[0].id, "old-message");
        assert!(!retained.is_in_inbox, "refreshed INBOX fact is persisted");
        assert_eq!(
            retained.is_read,
            Some(false),
            "refreshed UNREAD fact is persisted"
        );
        let restore = SetArchived {
            conversation: target.clone(),
            archived: false,
            request_id: "retained-unarchive".to_string(),
        };
        let receipt = store
            .accept_archived(&restore)
            .expect("restore after eviction");
        let conn = store.lock_conn().expect("store connection");
        let operation = load_operation(&conn, "acct-alpha", &receipt.operation_id)
            .expect("load restored targets")
            .expect("restored operation");
        assert_eq!(operation.message_ids, vec!["new-message", "old-message"]);
        drop(conn);
        let restored = store
            .get_conversation(&restore.conversation)
            .expect("reader remains available");
        assert!(restored.is_in_inbox);
        assert!(restored.retained_snapshot_at.is_some());
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn persistence_failure_is_surfaced_not_ignored() {
        let (store, dir) = open_store("failure");
        assert!(store.has_account().is_ok());
        store.set_test_persistence_failure(true);
        assert_eq!(store.has_account(), Err(MailError::StorageUnavailable));
        assert_eq!(store.clear_account(), Err(MailError::StorageUnavailable));
        store.set_test_persistence_failure(false);
        assert!(store.has_account().is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn list_cached_done_membership_scoping_ordering_bounds_and_recovery() {
        use crate::dto::CachedDoneRequest;
        let (store, dir) = open_store("cached-done");
        store
            .begin_account(&profile("acct", "a@example.test", "h1"), 0)
            .unwrap();
        let ids = [
            "a",
            "b",
            "failed",
            "restore",
            "incoming",
            "unknown",
            "sent-only",
            "spam-only",
            "trash-only",
        ];
        let threads: Vec<_> = ids
            .iter()
            .map(|id| {
                cached(thread(
                    "acct",
                    id,
                    "h1",
                    vec![message(&format!("m-{id}"), "2026-02-01T00:00:00Z")],
                    &[&format!("m-{id}")],
                ))
            })
            .collect();
        store
            .apply_discovery_page(&threads, None, true, false, 0)
            .unwrap();
        for id in &ids[..6] {
            store
                .accept_archived(&SetArchived {
                    conversation: ConversationRef {
                        account_id: "acct".into(),
                        conversation_id: (*id).into(),
                    },
                    archived: true,
                    request_id: format!("archive-{id}"),
                })
                .unwrap();
        }
        {
            let conn = store.lock_conn().unwrap();
            conn.execute("UPDATE gmail_message_facts SET in_inbox = 0 WHERE conversation_id IN ('sent-only', 'spam-only', 'trash-only')", []).unwrap();
            conn.execute(
                "UPDATE gmail_operations SET status = 'failed' WHERE conversation_id = 'failed'",
                [],
            )
            .unwrap();
            conn.execute("UPDATE gmail_operations SET status = 'confirmed' WHERE conversation_id IN ('a', 'b', 'incoming', 'unknown')", []).unwrap();
            conn.execute(
                "UPDATE gmail_message_facts SET in_inbox = 0 WHERE conversation_id IN ('a', 'b')",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE gmail_message_facts SET in_inbox = NULL WHERE conversation_id = 'unknown'",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO gmail_message_facts VALUES ('acct', 'incoming', 'new-arrival', 1, 0)",
                [],
            )
            .unwrap();
            // A foreign account with a lexically newer row must never leak in.
            conn.execute("INSERT INTO gmail_operations (account_id, operation_id, conversation_id, kind, requested_value, status, failure, last_error, accepted_seq, accepted_at, request_id, undo_of) SELECT 'foreign', 'foreign-op', 'a', kind, requested_value, status, failure, last_error, accepted_seq, accepted_at, request_id, undo_of FROM gmail_operations WHERE conversation_id = 'a'", []).unwrap();
        }
        store
            .accept_archived(&SetArchived {
                conversation: ConversationRef {
                    account_id: "acct".into(),
                    conversation_id: "restore".into(),
                },
                archived: false,
                request_id: "restore".into(),
            })
            .unwrap();
        let mut request = CachedDoneRequest {
            account_id: "acct".into(),
            limit: 1,
            cursor: None,
        };
        let first = store.list_cached_done(&request).unwrap();
        assert_eq!(first.conversations[0].conversation_ref.conversation_id, "a");
        assert_eq!(first.exact_total, None);
        assert_eq!(first.last_synced_at, store.last_synced_at().unwrap());
        request.cursor = first.next_cursor;
        let second = store.list_cached_done(&request).unwrap();
        assert_eq!(
            second.conversations[0].conversation_ref.conversation_id,
            "b"
        );
        request.cursor = second.next_cursor;
        let mut pages = 2;
        while request.cursor.is_some() {
            let page = store.list_cached_done(&request).unwrap();
            assert!(
                page.conversations.is_empty(),
                "restored, failed, incoming and unknown are excluded"
            );
            request.cursor = page.next_cursor;
            pages += 1;
            assert!(pages <= 6, "candidate paging must terminate");
        }
        assert_eq!(pages, 5); // failed and unrelated non-INBOX rows are not candidates.
        for limit in [0, 101, u32::MAX] {
            request.limit = limit;
            assert!(
                matches!(store.list_cached_done(&request), Err(MailError::InvalidRequest { field }) if field == "limit")
            );
        }
        request.limit = 100;
        request.cursor = Some("bad-cursor".into());
        assert!(
            matches!(store.list_cached_done(&request), Err(MailError::InvalidRequest { field }) if field == "cursor")
        );
        request.cursor = Some("cached-done-v1:[\"foreign\",\"date\",\"id\"]".into());
        assert!(
            matches!(store.list_cached_done(&request), Err(MailError::InvalidRequest { field }) if field == "cursor")
        );
        request.cursor = None;
        request.account_id = "foreign".into();
        assert_eq!(store.list_cached_done(&request), Err(MailError::NotFound));
        request.account_id = "acct".into();
        // Real persisted operation snapshot, then remove only bounded cache bodies.
        {
            let conn = store.lock_conn().unwrap();
            conn.execute("UPDATE gmail_conversations SET context_complete = 0, unsupported_reason = 'synthetic incomplete' WHERE conversation_id = 'a'", []).unwrap();
        }
        store
            .accept_archived(&SetArchived {
                conversation: ConversationRef {
                    account_id: "acct".into(),
                    conversation_id: "a".into(),
                },
                archived: true,
                request_id: "refresh-snapshot".into(),
            })
            .unwrap();
        {
            let conn = store.lock_conn().unwrap();
            conn.execute(
                "DELETE FROM gmail_messages WHERE account_id = 'acct' AND conversation_id = 'a'",
                [],
            )
            .unwrap();
            conn.execute("DELETE FROM gmail_conversations WHERE account_id = 'acct' AND conversation_id = 'a'", []).unwrap();
            // Simulate a pre-UX03 profile: reopen must backfill lightweight sort metadata.
            conn.execute(
                "ALTER TABLE gmail_operation_snapshots DROP COLUMN last_message_at",
                [],
            )
            .unwrap();
        }
        drop(store);
        let store = GmailStore::open(&dir, Arc::new(SystemClock)).unwrap();
        let page = store.list_cached_done(&request).unwrap();
        assert_eq!(page.conversations.len(), 2);
        assert_eq!(page.conversations[0].conversation_ref.conversation_id, "a");
        let retained = store
            .get_conversation(&page.conversations[0].conversation_ref)
            .unwrap();
        assert!(retained.retained_snapshot_at.is_some());
        assert_eq!(retained.context_complete, Some(false));
        assert_eq!(
            retained.unsupported_reason.as_deref(),
            Some("synthetic incomplete")
        );
        // An unselected retained body is not parsed to sort a one-row page.
        {
            let conn = store.lock_conn().unwrap();
            conn.execute("DELETE FROM gmail_messages WHERE conversation_id = 'b'", [])
                .unwrap();
            conn.execute(
                "DELETE FROM gmail_conversations WHERE conversation_id = 'b'",
                [],
            )
            .unwrap();
            conn.execute("UPDATE gmail_operation_snapshots SET snapshot_json = 'invalid-unselected-body' WHERE conversation_id = 'b'", []).unwrap();
        }
        request.limit = 1;
        let bounded = store.list_cached_done(&request).unwrap();
        assert_eq!(
            bounded.conversations[0].conversation_ref.conversation_id,
            "a"
        );
        assert!(bounded.next_cursor.is_some());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
    // -------------------------------------------------- UX-05 group tests

    fn open_store_with_clock(tag: &str, clock: Arc<dyn Clock>) -> (GmailStore, std::path::PathBuf) {
        let dir = temp_dir(tag);
        let store = GmailStore::open(&dir, clock).expect("store opens");
        (store, dir)
    }

    /// Seeds an account and three cached threads, each with two messages,
    /// all in the inbox and all unread (known read facts so read-kind
    /// preimages are capturable).
    fn seed_group_threads(store: &GmailStore, thread_ids: &[&str]) {
        store
            .begin_account(&profile("acct", "acct@example.test", "hist-1"), 0)
            .expect("account");
        let fetches: Vec<ThreadFetch> = thread_ids
            .iter()
            .map(|id| {
                let mut thread = thread(
                    "acct",
                    id,
                    "hist-2",
                    vec![
                        message(&format!("{id}-m1"), "2026-01-01T00:00:00Z"),
                        message(&format!("{id}-m2"), "2026-01-02T00:00:00Z"),
                    ],
                    &[&format!("{id}-m1"), &format!("{id}-m2")],
                );
                thread.unread_message_ids = Some(vec![format!("{id}-m1"), format!("{id}-m2")]);
                cached(thread)
            })
            .collect();
        store
            .apply_discovery_page(&fetches, None, true, false, 0)
            .expect("cache threads");
    }

    fn group_ref(id: &str) -> ConversationRef {
        ConversationRef {
            account_id: "acct".to_string(),
            conversation_id: id.to_string(),
        }
    }

    fn group_counts(store: &GmailStore) -> (usize, usize) {
        let conn = store.lock_conn().expect("conn");
        let operations: i64 = conn
            .query_row("SELECT COUNT(*) FROM gmail_operations", [], |row| {
                row.get(0)
            })
            .unwrap();
        let groups: i64 = conn
            .query_row("SELECT COUNT(*) FROM gmail_operation_groups", [], |row| {
                row.get(0)
            })
            .unwrap();
        (operations as usize, groups as usize)
    }

    /// Archive and read groups both accept atomically; the canonical payload
    /// makes reordered replays return the original receipt and ordering; a
    /// changed payload conflicts (§7.4).
    #[test]
    fn gmail_group_acceptance_is_idempotent_for_archive_and_read() {
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let (store, dir) = open_store_with_clock("gmail-group-idempotent", clock);
        seed_group_threads(&store, &["thr-a", "thr-b"]);

        let command = crate::groups::SetReadGroup {
            account_id: "acct".into(),
            members: vec![group_ref("thr-b"), group_ref("thr-a")],
            read: true,
            request_id: "gmail-group-req-1".into(),
        };
        let receipt = store.accept_read_group(&command).expect("read group");
        assert_eq!(receipt.kind, MailboxOperationKind::Read);
        assert_eq!(receipt.requested_read, Some(true));
        assert_eq!(receipt.members[0].conversation.conversation_id, "thr-b");
        let replay = store.accept_read_group(&command).expect("replay");
        assert_eq!(replay, receipt);
        // Reordered replay: same canonical identity, original ordering kept.
        let reordered = crate::groups::SetReadGroup {
            members: vec![group_ref("thr-a"), group_ref("thr-b")],
            ..command.clone()
        };
        assert_eq!(
            store.accept_read_group(&reordered).expect("replay"),
            receipt
        );
        // Changed payload conflicts.
        assert_eq!(
            store.accept_read_group(&crate::groups::SetReadGroup {
                read: false,
                ..command.clone()
            }),
            Err(MailError::RequestIdConflict)
        );
        // Cross-command reuse of the request id conflicts.
        assert_eq!(
            store.accept_archived(&SetArchived {
                conversation: group_ref("thr-a"),
                archived: true,
                request_id: "gmail-group-req-1".into(),
            }),
            Err(MailError::RequestIdConflict)
        );

        // Archive group on a fresh request id.
        let archive_receipt = store
            .accept_archived_group(&crate::groups::SetArchivedGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-a")],
                archived: true,
                request_id: "gmail-group-req-2".into(),
            })
            .expect("archive group");
        assert_eq!(archive_receipt.kind, MailboxOperationKind::Archive);
        assert_eq!(archive_receipt.requested_archived, Some(true));
        assert_eq!(group_counts(&store), (3, 2));
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A member without immutable targets is a persisted acceptance rejection
    /// (never a fabricated failed operation); valid siblings are accepted and
    /// the replay returns the identical receipt (§7.2).
    #[test]
    fn gmail_group_member_rejection_is_persisted_and_savepointed() {
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let (store, dir) = open_store_with_clock("gmail-group-rejection", clock);
        seed_group_threads(&store, &["thr-a"]);
        let receipt = store
            .accept_archived_group(&crate::groups::SetArchivedGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-a"), group_ref("missing-thr")],
                archived: true,
                request_id: "gmail-group-req-mixed".into(),
            })
            .expect("mixed group accepted");
        assert!(receipt.members[0].operation_id.is_some());
        assert_eq!(
            receipt.members[1].rejection,
            Some(GroupMemberRejection::ConversationMissing)
        );
        assert_eq!(receipt.members[1].operation_id, None);
        assert_eq!(group_counts(&store), (1, 1), "one child, one group");
        // Rejected member left no partial request/target rows behind: only
        // the group's own request row and the accepted child's remain.
        {
            let conn = store.lock_conn().unwrap();
            let requests: i64 = conn
                .query_row("SELECT COUNT(*) FROM gmail_operation_requests", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(requests, 2, "group request row + accepted child only");
        }
        let status = store
            .get_operation_group(&crate::groups::GetOperationGroupRequest {
                account_id: "acct".into(),
                request_id: "gmail-group-req-mixed".into(),
            })
            .expect("lookup")
            .expect("committed");
        assert_eq!(
            status.members[1].status,
            crate::groups::GroupMemberStatus::Rejected
        );
        assert_eq!(
            status.members[0].status,
            crate::groups::GroupMemberStatus::Queued
        );
        assert!(status.undo.available);
        let replay = store
            .accept_archived_group(&crate::groups::SetArchivedGroup {
                members: vec![group_ref("missing-thr"), group_ref("thr-a")],
                ..crate::groups::SetArchivedGroup {
                    account_id: "acct".into(),
                    members: Vec::new(),
                    archived: true,
                    request_id: "gmail-group-req-mixed".into(),
                }
            })
            .expect("replay");
        assert_eq!(replay, receipt, "original ordering preserved on replay");
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Storage failure at acceptance rejects the whole group; the same
    /// request retried after recovery commits exactly once (§7.3).
    #[test]
    fn gmail_group_storage_failure_rolls_back_and_retry_is_safe() {
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let (store, dir) = open_store_with_clock("gmail-group-rollback", clock);
        seed_group_threads(&store, &["thr-a", "thr-b"]);
        store.set_test_persistence_failure(true);
        assert_eq!(
            store.accept_archived_group(&crate::groups::SetArchivedGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-a"), group_ref("thr-b")],
                archived: true,
                request_id: "gmail-group-req-rb".into(),
            }),
            Err(MailError::StorageUnavailable)
        );
        assert_eq!(group_counts(&store), (0, 0));
        store.set_test_persistence_failure(false);
        let receipt = store
            .accept_archived_group(&crate::groups::SetArchivedGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-a"), group_ref("thr-b")],
                archived: true,
                request_id: "gmail-group-req-rb".into(),
            })
            .expect("retry safe");
        assert_eq!(receipt.members.len(), 2);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Group Undo at 9 seconds (§7.6): confirmed member compensates from the
    /// original targets/preimages, failed and unknown members are skipped
    /// with typed reasons, queued member cancels; no rollback of successful
    /// siblings; one attempt, idempotent replay.
    #[test]
    fn gmail_group_undo_is_partial_typed_and_one_shot() {
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let (store, dir) = open_store_with_clock("gmail-group-undo", clock.clone());
        seed_group_threads(&store, &["thr-a", "thr-b", "thr-c"]);
        let receipt = store
            .accept_read_group(&crate::groups::SetReadGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-a"), group_ref("thr-b"), group_ref("thr-c")],
                read: true,
                request_id: "gmail-group-req-u".into(),
            })
            .expect("read group");
        let ops: Vec<String> = receipt
            .members
            .iter()
            .map(|m| m.operation_id.clone().unwrap())
            .collect();
        // thr-a confirms, thr-b fails, thr-c stays queued.
        let claimed_a = store.claim_next_operation().unwrap().unwrap();
        assert_eq!(claimed_a.operation_id, ops[0]);
        store.confirm_operation(&claimed_a).unwrap();
        let claimed_b = store.claim_next_operation().unwrap().unwrap();
        assert_eq!(claimed_b.operation_id, ops[1]);
        store
            .fail_operation(&claimed_b, MailError::ProviderRejected)
            .unwrap();

        clock.advance_seconds(9);
        let undo = store
            .undo_operation_group(&crate::groups::UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "gmail-undo-group-1".into(),
            })
            .expect("group undo");
        assert_eq!(
            undo.members[0].decision,
            crate::groups::GroupMemberUndoDecision::Compensating
        );
        assert!(!undo.members[0].operation_ids.is_empty());
        assert_eq!(
            undo.members[1].decision,
            crate::groups::GroupMemberUndoDecision::Skipped {
                reason: crate::groups::GroupUndoSkipReason::Failed
            }
        );
        assert_eq!(
            undo.members[2].decision,
            crate::groups::GroupMemberUndoDecision::Cancelled
        );

        // One attempt: replay identical; second different request rejected.
        let replay = store
            .undo_operation_group(&crate::groups::UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "gmail-undo-group-1".into(),
            })
            .expect("replay");
        assert_eq!(replay, undo);
        assert_eq!(
            store.undo_operation_group(&crate::groups::UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "gmail-undo-group-2".into(),
            }),
            Err(MailError::UndoUnavailable {
                reason: UndoUnavailableReason::AlreadyUndone
            })
        );
        // Member statuses: confirmed original, failed original, cancelled.
        let status = store
            .get_operation_group(&crate::groups::GetOperationGroupRequest {
                account_id: "acct".into(),
                request_id: "gmail-group-req-u".into(),
            })
            .expect("lookup")
            .expect("committed");
        assert_eq!(
            status.members[0].status,
            crate::groups::GroupMemberStatus::Confirmed
        );
        assert_eq!(
            status.members[1].status,
            crate::groups::GroupMemberStatus::Failed
        );
        assert_eq!(
            status.members[2].status,
            crate::groups::GroupMemberStatus::Cancelled
        );
        assert_eq!(
            status.undo.reason,
            Some(UndoUnavailableReason::AlreadyUndone)
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Outcome-unknown members are explicitly skipped (never compensated,
    /// never silently retried) while eligible siblings still undo (§7.5/§7.6).
    #[test]
    fn gmail_group_undo_skips_unknown_members_and_keeps_sibling_recovery() {
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let (store, dir) = open_store_with_clock("gmail-group-unknown", clock.clone());
        seed_group_threads(&store, &["thr-a", "thr-b"]);
        let receipt = store
            .accept_read_group(&crate::groups::SetReadGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-a"), group_ref("thr-b")],
                read: true,
                request_id: "gmail-group-req-unk".into(),
            })
            .expect("read group");
        let ops: Vec<String> = receipt
            .members
            .iter()
            .map(|m| m.operation_id.clone().unwrap())
            .collect();
        // thr-a becomes outcome-unknown (interrupted dispatch).
        let claimed_a = store.claim_next_operation().unwrap().unwrap();
        assert_eq!(claimed_a.operation_id, ops[0]);
        store.unknown_operation(&claimed_a).unwrap();
        clock.advance_seconds(1);
        let undo = store
            .undo_operation_group(&crate::groups::UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "gmail-undo-unk".into(),
            })
            .expect("group undo");
        assert_eq!(
            undo.members[0].decision,
            crate::groups::GroupMemberUndoDecision::Skipped {
                reason: crate::groups::GroupUndoSkipReason::OutcomeUnknown
            }
        );
        assert_eq!(
            undo.members[1].decision,
            crate::groups::GroupMemberUndoDecision::Cancelled
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Expiry, supersession by a newer single/group/retry, and the child
    /// single-Undo bypass all fail closed with typed reasons (§7.7).
    #[test]
    fn gmail_group_undo_respects_expiry_supersession_and_no_child_bypass() {
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let (store, dir) = open_store_with_clock("gmail-group-gates", clock.clone());
        seed_group_threads(&store, &["thr-a", "thr-b", "thr-c"]);
        let receipt = store
            .accept_archived_group(&crate::groups::SetArchivedGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-a"), group_ref("thr-b")],
                archived: true,
                request_id: "gmail-group-req-g".into(),
            })
            .expect("group accepted");
        let child = receipt.members[0].operation_id.clone().unwrap();

        // A single Undo of a group child never bypasses group ordering.
        assert_eq!(
            store.undo_operation(&UndoOperation {
                operation_id: child.clone(),
                request_id: "child-bypass".into(),
            }),
            Err(MailError::UndoUnavailable {
                reason: UndoUnavailableReason::NotApplicable
            })
        );
        // A newer single action supersedes the group.
        store
            .accept_archived(&SetArchived {
                conversation: group_ref("thr-c"),
                archived: true,
                request_id: "single-after-group".into(),
            })
            .expect("single accepted");
        assert_eq!(
            store.undo_operation_group(&crate::groups::UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "undo-after-single".into(),
            }),
            Err(MailError::UndoUnavailable {
                reason: UndoUnavailableReason::Superseded
            })
        );
        // A newer group supersedes the older group.
        let newer = store
            .accept_archived_group(&crate::groups::SetArchivedGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-a")],
                archived: false,
                request_id: "gmail-group-req-new".into(),
            })
            .expect("newer group");
        assert_eq!(
            store.undo_operation_group(&crate::groups::UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "undo-after-newer-group".into(),
            }),
            Err(MailError::UndoUnavailable {
                reason: UndoUnavailableReason::Superseded
            })
        );
        // A retry of a failed member is also a new top-level action.
        // Mark one child failed first.
        let failed_child = newer.members[0].operation_id.clone().unwrap();
        let record = {
            let conn = store.lock_conn().unwrap();
            load_operation(&conn, "acct", &failed_child)
                .unwrap()
                .unwrap()
        };
        store
            .fail_operation(&record, MailError::ProviderRejected)
            .unwrap();
        let retry = store
            .accept_retry(&RetryOperation {
                operation_id: failed_child.clone(),
                request_id: "retry-after-group".into(),
            })
            .expect("retry accepted");
        assert_eq!(
            store.undo_operation_group(&crate::groups::UndoOperationGroup {
                group_id: newer.group_id.clone(),
                request_id: "undo-after-retry".into(),
            }),
            Err(MailError::UndoUnavailable {
                reason: UndoUnavailableReason::Superseded
            }),
            "a newer individual retry supersedes the older group"
        );
        // The retry itself is top-level and undoable (newest action).
        let record = {
            let conn = store.lock_conn().unwrap();
            load_operation(&conn, "acct", &retry.operation_id)
                .unwrap()
                .unwrap()
        };
        store.confirm_operation(&record).unwrap();
        assert!(store
            .undo_operation(&UndoOperation {
                operation_id: retry.operation_id.clone(),
                request_id: "undo-retry".into(),
            })
            .is_ok());
        // Expiry at 10 seconds.
        let expired = store
            .accept_archived_group(&crate::groups::SetArchivedGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-b")],
                archived: true,
                request_id: "gmail-group-req-exp".into(),
            })
            .expect("group accepted");
        clock.advance_seconds(10);
        assert_eq!(
            store.undo_operation_group(&crate::groups::UndoOperationGroup {
                group_id: expired.group_id.clone(),
                request_id: "undo-expired".into(),
            }),
            Err(MailError::UndoUnavailable {
                reason: UndoUnavailableReason::Expired
            })
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Group listing pagination and account fencing (§7.9); a group absent
    /// from a recent page stays queryable by request identity; foreign
    /// accounts fail closed.
    #[test]
    fn gmail_group_listing_paginates_and_fences_accounts() {
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let (store, dir) = open_store_with_clock("gmail-group-pages", clock);
        seed_group_threads(&store, &["thr-a"]);
        let mut group_ids = Vec::new();
        for i in 0..3 {
            let receipt = store
                .accept_archived_group(&crate::groups::SetArchivedGroup {
                    account_id: "acct".into(),
                    members: vec![group_ref("thr-a")],
                    archived: true,
                    request_id: format!("gmail-group-page-{i}"),
                })
                .expect("group accepted");
            group_ids.push(receipt.group_id);
        }
        let page = store
            .list_operation_groups(&crate::groups::ListOperationGroupsRequest {
                account_id: "acct".into(),
                limit: 2,
                cursor: None,
            })
            .expect("page 1");
        assert_eq!(page.groups.len(), 2);
        assert_eq!(page.groups[0].request_id, "gmail-group-page-2");
        let cursor = page.next_cursor.expect("continuation");
        assert!(page
            .groups
            .iter()
            .all(|g| g.request_id != "gmail-group-page-0"));
        let oldest = store
            .get_operation_group(&crate::groups::GetOperationGroupRequest {
                account_id: "acct".into(),
                request_id: "gmail-group-page-0".into(),
            })
            .expect("lookup")
            .expect("detail stays addressable");
        assert_eq!(oldest.group.group_id, group_ids[0]);
        let page2 = store
            .list_operation_groups(&crate::groups::ListOperationGroupsRequest {
                account_id: "acct".into(),
                limit: 2,
                cursor: Some(cursor),
            })
            .expect("page 2");
        assert_eq!(page2.groups.len(), 1);
        assert_eq!(page2.groups[0].request_id, "gmail-group-page-0");
        // Foreign account fencing and uncommitted lookups.
        assert_eq!(
            store.list_operation_groups(&crate::groups::ListOperationGroupsRequest {
                account_id: "foreign".into(),
                limit: 2,
                cursor: None,
            }),
            Err(MailError::NotFound)
        );
        assert!(store
            .get_operation_group(&crate::groups::GetOperationGroupRequest {
                account_id: "acct".into(),
                request_id: "never-committed".into(),
            })
            .unwrap()
            .is_none());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Disconnect cleanup (§4.2): `clear_account` deletes the durable group
    /// header/member rows in the same transaction as their backing
    /// operations/requests/preimages. Detail loads and a reused original
    /// request id must neither orphan the retained header nor trip its unique
    /// constraint into a storage halt.
    #[test]
    fn gmail_clear_account_removes_group_tables_and_allows_request_id_reuse() {
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let (store, dir) = open_store_with_clock("gmail-group-clear-account", clock);
        seed_group_threads(&store, &["thr-a", "thr-b"]);
        let receipt = store
            .accept_archived_group(&crate::groups::SetArchivedGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-a"), group_ref("thr-b")],
                archived: true,
                request_id: "gmail-group-req-clear".into(),
            })
            .expect("group accepted");
        assert_eq!(group_counts(&store), (2, 1));

        store.clear_account().expect("disconnect clears account");
        assert_eq!(group_counts(&store), (0, 0), "group tables are wiped too");

        // Reconnect the same Google account and reuse the ORIGINAL request id:
        // this must be a clean acceptance, not a unique-constraint failure.
        // Reconnect runs against the generation the disconnect bumped to.
        let generation = store.generation().expect("generation");
        store
            .begin_account(&profile("acct", "acct@example.test", "hist-1"), generation)
            .expect("reconnect begins the account");
        store
            .apply_discovery_page(
                &[
                    cached(thread(
                        "acct",
                        "thr-a",
                        "hist-2",
                        vec![
                            message("thr-a-m1", "2026-01-01T00:00:00Z"),
                            message("thr-a-m2", "2026-01-02T00:00:00Z"),
                        ],
                        &["thr-a-m1", "thr-a-m2"],
                    )),
                    cached(thread(
                        "acct",
                        "thr-b",
                        "hist-2",
                        vec![
                            message("thr-b-m1", "2026-01-01T00:00:00Z"),
                            message("thr-b-m2", "2026-01-02T00:00:00Z"),
                        ],
                        &["thr-b-m1", "thr-b-m2"],
                    )),
                ],
                None,
                true,
                false,
                generation,
            )
            .expect("reconnect caches threads");
        let reaccepted = store
            .accept_archived_group(&crate::groups::SetArchivedGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-a"), group_ref("thr-b")],
                archived: true,
                request_id: "gmail-group-req-clear".into(),
            })
            .expect("reused request id accepts cleanly after disconnect");
        assert_eq!(reaccepted.members.len(), 2);
        assert_ne!(
            reaccepted.group_id, receipt.group_id,
            "a fresh group identity is committed after disconnect"
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Restart after a partial group Undo with a FAILED compensation: the
    /// reopened store rebuilds the persisted undo record from durable rows,
    /// and compensation outcomes (failed, with its failure kind) stay
    /// inspectable and distinct from the original member's execution status.
    #[test]
    fn gmail_group_undo_record_survives_reopen_with_failed_compensation() {
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let dir;
        let compensation_id;
        {
            let (store, path) = open_store_with_clock("gmail-group-undo-reopen", clock.clone());
            dir = path;
            seed_group_threads(&store, &["thr-a", "thr-b"]);
            let receipt = store
                .accept_read_group(&crate::groups::SetReadGroup {
                    account_id: "acct".into(),
                    members: vec![group_ref("thr-a"), group_ref("thr-b")],
                    read: true,
                    request_id: "gmail-group-req-reopen".into(),
                })
                .expect("read group");
            let child = receipt.members[0].operation_id.clone().unwrap();
            let claimed = store.claim_next_operation().unwrap().unwrap();
            assert_eq!(claimed.operation_id, child);
            store.confirm_operation(&claimed).unwrap();
            let undo = store
                .undo_operation_group(&crate::groups::UndoOperationGroup {
                    group_id: receipt.group_id.clone(),
                    request_id: "gmail-undo-reopen-1".into(),
                })
                .expect("group undo");
            assert_eq!(
                undo.members[0].decision,
                crate::groups::GroupMemberUndoDecision::Compensating
            );
            assert_eq!(
                undo.members[1].decision,
                crate::groups::GroupMemberUndoDecision::Cancelled
            );
            compensation_id = undo.members[0].operation_ids[0].clone();
            // The compensation fails before the "restart".
            let claimed = store.claim_next_operation().unwrap().unwrap();
            assert_eq!(claimed.operation_id, compensation_id);
            store
                .fail_operation(&claimed, MailError::ProviderRejected)
                .expect("compensation fails");
        }

        // Reopen (same profile, fresh store): the undo record comes back.
        let store = GmailStore::open(&dir, clock).expect("reopen");
        let status = store
            .get_operation_group(&crate::groups::GetOperationGroupRequest {
                account_id: "acct".into(),
                request_id: "gmail-group-req-reopen".into(),
            })
            .expect("lookup")
            .expect("committed group after reopen");
        let undo_record = status
            .undo_receipt
            .as_ref()
            .expect("persisted undo record survives reopen");
        assert_eq!(undo_record.request_id, "gmail-undo-reopen-1");
        assert_eq!(
            undo_record.members[0].decision,
            crate::groups::GroupMemberUndoDecision::Compensating
        );
        assert_eq!(undo_record.members[0].compensations.len(), 1);
        assert_eq!(
            undo_record.members[0].compensations[0].operation_id,
            compensation_id
        );
        assert_eq!(
            undo_record.members[0].compensations[0].status,
            OperationStatus::Failed,
            "failed compensation outcome visible after reopen"
        );
        assert_eq!(
            undo_record.members[0].compensations[0].failure,
            Some(OperationFailure::ProviderRejected)
        );
        assert_eq!(
            undo_record.members[1].decision,
            crate::groups::GroupMemberUndoDecision::Cancelled
        );
        // The original member's execution status is untouched history.
        assert_eq!(
            status.members[0].status,
            crate::groups::GroupMemberStatus::Confirmed
        );
        // Activity exposes the group linkage on the child and the undo/none
        // linkage on the compensation.
        let activity = store.list_snapshot().unwrap().activity;
        let child_row = activity
            .iter()
            .find(|row| row.id == "x")
            .or_else(|| activity.iter().find(|row| row.group_id.is_some()))
            .expect("group child present in activity");
        assert!(
            child_row.group_id.is_some(),
            "group child carries its groupId"
        );
        let compensation_row = activity
            .iter()
            .find(|row| row.id == compensation_id)
            .expect("compensation in activity");
        assert_eq!(
            compensation_row.group_id, None,
            "compensations are ungrouped"
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A retried failed group member stays linked for inspection across a
    /// restart: the retry row carries `retryOf` (its own top-level action,
    /// no group), while the original member's historical failure is not
    /// rewritten (§4.3).
    #[test]
    fn gmail_retry_lineage_persists_across_restart() {
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let (store, dir) = open_store_with_clock("gmail-group-retry-lineage", clock.clone());
        seed_group_threads(&store, &["thr-a", "thr-b"]);
        let receipt = store
            .accept_read_group(&crate::groups::SetReadGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-a"), group_ref("thr-b")],
                read: true,
                request_id: "gmail-group-req-retry".into(),
            })
            .expect("read group");
        let failed_child = receipt.members[0].operation_id.clone().unwrap();
        let claimed = store.claim_next_operation().unwrap().unwrap();
        assert_eq!(claimed.operation_id, failed_child);
        store
            .fail_operation(&claimed, MailError::ProviderRejected)
            .expect("member fails");

        // Explicit retry of the failed member: a new top-level action linked
        // to the original member for inspection.
        let retry = store
            .accept_retry(&crate::dto::RetryOperation {
                operation_id: failed_child.clone(),
                request_id: "gmail-retry-1".into(),
            })
            .expect("retry accepted");
        let retry_id = retry.operation_id.clone();
        // The other member is still queued and older; drain it first.
        let claimed = store.claim_next_operation().unwrap().unwrap();
        assert_eq!(
            claimed.operation_id,
            receipt.members[1].operation_id.clone().unwrap()
        );
        store
            .fail_operation(&claimed, MailError::ProviderRejected)
            .expect("sibling member fails");
        let claimed = store.claim_next_operation().unwrap().unwrap();
        assert_eq!(claimed.operation_id, retry_id);
        store.confirm_operation(&claimed).unwrap();

        // Restart: the lineage and the historical failure both survive.
        drop(store);
        let store = GmailStore::open(&dir, clock).expect("reopen");
        let activity = store.list_snapshot().unwrap().activity;
        let retry_row = activity
            .iter()
            .find(|row| row.id == retry_id)
            .expect("retry row");
        assert_eq!(retry_row.retry_of.as_deref(), Some(failed_child.as_str()));
        assert_eq!(
            retry_row.group_id, None,
            "a retry is a new top-level action, ungrouped"
        );
        let failed_row = activity
            .iter()
            .find(|row| row.id == failed_child)
            .expect("failed member row");
        assert_eq!(
            failed_row.status,
            OperationStatus::Failed,
            "history not rewritten"
        );
        assert_eq!(
            failed_row.group_id.as_deref(),
            Some(receipt.group_id.as_str())
        );
        // Group detail still addresses the group by its original request id.
        let status = store
            .get_operation_group(&crate::groups::GetOperationGroupRequest {
                account_id: "acct".into(),
                request_id: "gmail-group-req-retry".into(),
            })
            .expect("lookup")
            .expect("group");
        assert_eq!(
            status.members[0].status,
            crate::groups::GroupMemberStatus::Failed
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
