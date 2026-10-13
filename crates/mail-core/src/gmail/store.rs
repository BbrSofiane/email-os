//! Concrete SQLite cache for the read-only Gmail slice (docs/vertical-slice-02.md,
//! "Persistence and synchronization"): a dedicated schema and database file
//! (`gmail.db`) separate from the fixture store, account-scoped conversation
//! and message rows, per-message INBOX membership, and resumable
//! discovery/history checkpoints. Cached facts and their page/cursor
//! checkpoints commit in one short serialized transaction; the network never
//! runs inside a lock. Every persistence error maps to
//! [`MailError::StorageUnavailable`] and is surfaced — nothing is
//! logged-and-ignored, and no mail content, addresses, or credentials are
//! ever logged.

use std::path::Path;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};

use crate::clock::Clock;
use crate::dto::{
    Address, Conversation, ConversationRef, ConversationSummary, InboxSnapshot, Message,
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
    Cached(GmailThread),
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
            );",
        )
        .map_err(|_| MailError::StorageUnavailable)?;

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

    /// Effective inbox plus (empty) activity for this read-only slice.
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
                 WHERE c.account_id = ?1 AND EXISTS (
                     SELECT 1 FROM gmail_inbox_membership i
                     WHERE i.account_id = c.account_id
                       AND i.conversation_id = c.conversation_id)",
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
            summaries.push(ConversationSummary {
                conversation_ref: built.conversation_ref,
                subject: built.subject,
                participants: participants_of(&built.messages),
                preview: preview_of(&built.messages),
                last_message_at: built
                    .messages
                    .last()
                    .map(|m| m.sent_at.clone())
                    .unwrap_or_default(),
                pending_operation_id: None,
            });
        }
        summaries.sort_by(|a, b| {
            b.last_message_at.cmp(&a.last_message_at).then_with(|| {
                a.conversation_ref
                    .conversation_id
                    .cmp(&b.conversation_ref.conversation_id)
            })
        });
        Ok(InboxSnapshot {
            conversations: summaries,
            activity: Vec::new(),
        })
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
        let built = built.ok_or(MailError::NotFound)?;
        Ok(Conversation {
            conversation_ref: built.conversation_ref,
            subject: built.subject,
            messages: built.messages,
            is_in_inbox: built.is_in_inbox,
            context_complete: built.context_complete,
            unsupported_reason: built.unsupported_reason,
            pending_operation_id: None,
        })
    }

    // --------------------------------------------------------------- writes

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
    /// checkpoint. A completed capped pass replaces the cache view with its
    /// observed set; a complete uncapped pass clears stale INBOX membership.
    pub(crate) fn apply_discovery_page(
        &self,
        fetched: &[ThreadFetch],
        incoming_token: Option<&str>,
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
        if incoming_token.is_none() {
            // (Re)starting the discovery run: any earlier run's seen set is stale.
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
            // History can mention arbitrarily old archived threads. Do not
            // import their bodies into the bounded inbox cache.
            return Ok(());
        }
    }
    conn.execute(
        "INSERT INTO gmail_conversations
            (account_id, conversation_id, subject, context_complete, unsupported_reason)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(account_id, conversation_id) DO UPDATE SET
            subject = excluded.subject,
            context_complete = excluded.context_complete,
            unsupported_reason = excluded.unsupported_reason",
        params![
            account_id,
            conversation_id,
            thread.conversation.subject,
            thread.conversation.context_complete.unwrap_or(false) as i64,
            thread.conversation.unsupported_reason,
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
    is_in_inbox: bool,
    context_complete: Option<bool>,
    unsupported_reason: Option<String>,
}

fn build_conversation(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<Option<BuiltConversation>, MailError> {
    let row = conn
        .query_row(
            "SELECT subject, context_complete, unsupported_reason FROM gmail_conversations
             WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some((subject, context_flag, unsupported_reason)) = row else {
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
    let is_in_inbox: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM gmail_inbox_membership
             WHERE account_id = ?1 AND conversation_id = ?2)",
            params![account_id, conversation_id],
            |row| row.get(0),
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    Ok(Some(BuiltConversation {
        conversation_ref: ConversationRef {
            account_id: account_id.to_string(),
            conversation_id: conversation_id.to_string(),
        },
        subject,
        messages: messages.into_iter().map(|(message, _)| message).collect(),
        is_in_inbox,
        context_complete: Some(context_flag != 0),
        unsupported_reason,
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
                context_complete: Some(true),
                unsupported_reason: None,
                pending_operation_id: None,
            },
            inbox_message_ids: inbox.iter().map(|s| s.to_string()).collect(),
            history_id: history_id.to_string(),
        }
    }

    fn cached(thread: GmailThread) -> ThreadFetch {
        ThreadFetch::Cached(thread)
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
            .apply_discovery_page(&page1, None, Some("page-2"), false, false, 0)
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
            .apply_discovery_page(&page2, Some("page-2"), None, true, false, 0)
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
            .apply_discovery_page(&page2, Some("page-2"), None, true, false, 0)
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
            .apply_discovery_page(&[cached(unsupported)], None, None, true, false, 0)
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
            store.apply_discovery_page(&[cached(foreign)], None, None, true, false, 0),
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
            .apply_discovery_page(&initial, None, None, true, false, 0)
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
            .apply_discovery_page(&fresh, None, Some("resume"), false, false, 0)
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
            .apply_discovery_page(&tail, Some("resume"), None, true, false, 0)
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
            .apply_discovery_page(&initial, None, None, true, false, 0)
            .expect("initial page");
        assert_eq!(
            store.list_snapshot().expect("snapshot").conversations.len(),
            1
        );
        // A later complete pass that does not observe thr-1 reconciles its
        // stale INBOX membership (external archive/delete), same transaction.
        store
            .apply_discovery_page(&[], Some("resume"), None, true, false, 0)
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
            .apply_discovery_page(&seeded, None, None, true, false, 0)
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
            store.apply_discovery_page(&page, None, None, true, false, 0),
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
            store.apply_discovery_page(&fresh, None, None, true, false, 1),
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
            .apply_discovery_page(&page, None, None, true, false, 0)
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
}
