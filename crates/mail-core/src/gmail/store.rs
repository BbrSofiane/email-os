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
    OperationSummary, RetryOperation, SetArchived, SetRead,
};
use crate::error::MailError;
use crate::gmail::types::{AccountInfo, GmailProfile, GmailThread, HistoryPage};

/// Cache cap: at most this many conversations are retained after a completed
/// discovery/history pass. Disclosed to the wire through `SyncInfo.coverageLimit`.
pub(crate) const DISCOVERY_CAP: usize = 100;

const SCHEMA_VERSION: &str = "gmail-1";

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
                PRIMARY KEY (account_id, request_id)
            );
            CREATE TABLE IF NOT EXISTS gmail_operation_snapshots (
                account_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                snapshot_saved_at TEXT NOT NULL,
                PRIMARY KEY (account_id, conversation_id)
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

        let version: Option<String> = meta_get(&tx, "schema_version")?;
        match version {
            Some(v) if v == SCHEMA_VERSION => {}
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
        let activity = load_activity(&conn, &account_id)?;
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
            let (inbox, is_read, pending_operation_id, known) =
                effective_conversation_state_with_coverage(&conn, &account, id)?;
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
                clone_targets_from: Some(&original.operation_id),
                accepted_at: &accepted_at,
            },
        )?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(receipt)
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

fn accept_operation_tx(
    tx: &rusqlite::Transaction<'_>,
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
        accepted_at,
    } = acceptance;
    let mut targets: Vec<String>;
    if let Some(original_id) = clone_targets_from {
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
    let existing_snapshot: Option<(String, String)> = tx
        .query_row(
            "SELECT snapshot_json, snapshot_saved_at FROM gmail_operation_snapshots
         WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation.conversation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let (snapshot_json, snapshot_saved_at) = if clone_targets_from.is_some() {
        existing_snapshot.ok_or(MailError::NotFound)?
    } else if let Some(built) = build_conversation(tx, account_id, &conversation.conversation_id)? {
        let (is_in_inbox, is_read, pending_operation_id) =
            effective_conversation_state(tx, account_id, &conversation.conversation_id)?;
        let current = Conversation {
            conversation_ref: built.conversation_ref,
            subject: built.subject,
            messages: built.messages,
            is_in_inbox,
            is_read,
            context_complete: built.context_complete,
            unsupported_reason: built.unsupported_reason,
            retained_snapshot_at: None,
            reply_context: None,
            pending_operation_id,
        };
        (
            serde_json::to_string(&current).map_err(|_| MailError::StorageUnavailable)?,
            accepted_at.to_string(),
        )
    } else {
        existing_snapshot.ok_or(MailError::NotFound)?
    };
    let operation_id = uuid::Uuid::new_v4().to_string();
    let accepted_seq: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(accepted_seq), 0) + 1 FROM gmail_operations WHERE account_id = ?1",
            params![account_id],
            |row| row.get(0),
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    tx.execute(
        "INSERT INTO gmail_operations
         (account_id, operation_id, conversation_id, kind, requested_value, status,
          accepted_seq, accepted_at, request_id)
         VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?8)",
        params![
            account_id,
            operation_id,
            conversation.conversation_id,
            kind_name(kind),
            value as i64,
            accepted_seq,
            accepted_at,
            request_id
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
    }
}

fn parse_status(status: &str) -> Result<OperationStatus, MailError> {
    match status {
        "queued" => Ok(OperationStatus::Queued),
        "applying" => Ok(OperationStatus::Applying),
        "confirmed" => Ok(OperationStatus::Confirmed),
        "failed" => Ok(OperationStatus::Failed),
        "outcome_unknown" => Ok(OperationStatus::OutcomeUnknown),
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
    let (inbox, read, pending, _) =
        effective_conversation_state_with_coverage(conn, account_id, conversation_id)?;
    Ok((inbox, read, pending))
}

fn effective_conversation_state_with_coverage(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<(bool, Option<bool>, Option<String>, bool), MailError> {
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
    Ok((
        inbox,
        is_read,
        active.map(|(_, id)| id),
        !facts.is_empty() && facts.values().all(|(inbox, _)| inbox.is_some()),
    ))
}

fn load_activity(conn: &Connection, account_id: &str) -> Result<Vec<OperationSummary>, MailError> {
    let mut stmt = conn.prepare(
        "SELECT operation_id, conversation_id, kind, requested_value, status, failure, last_error
         FROM gmail_operations WHERE account_id = ?1 ORDER BY accepted_seq DESC",
    ).map_err(|_| MailError::StorageUnavailable)?;
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
            ))
        })
        .map_err(|_| MailError::StorageUnavailable)?
    {
        let (id, conversation_id, kind, value, status, failure, last_error) =
            row.map_err(|_| MailError::StorageUnavailable)?;
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
        });
    }
    Ok(activity)
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
            conn.execute("INSERT INTO gmail_operations SELECT 'foreign', 'foreign-op', 'a', kind, requested_value, status, failure, last_error, accepted_seq, accepted_at, request_id FROM gmail_operations WHERE conversation_id = 'a'", []).unwrap();
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
}
