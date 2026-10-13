//! Concrete SQLite store for the fixture slice. Not a generic repository
//! framework: one schema, explicit queries, short serialized transactions.
//! Every persistence error maps to [`MailError::StorageUnavailable`] and is
//! surfaced; nothing is logged-and-ignored. No subjects, addresses, or bodies
//! are ever logged.

use std::path::Path;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::clock::Clock;
use crate::dto::{
    Address, Conversation, ConversationRef, ConversationSummary, InboxSnapshot, Message,
    OperationFailure, OperationReceipt, OperationStatus, OperationSummary, SetArchived,
};
use crate::error::MailError;
use crate::seed::{self, SeedConversation};
use crate::ACCOUNT_ID;

/// Longest plain-text preview appended to conversation summaries.
const PREVIEW_MAX_CHARS: usize = 140;

/// A claimed operation handed to the worker.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ClaimedOp {
    pub operation_id: String,
    pub account_id: String,
    pub conversation_id: String,
    pub requested_archived: bool,
    /// Message ids observed when the command was accepted.
    pub message_ids: Vec<String>,
}

pub(crate) struct Store {
    conn: Mutex<Connection>,
    clock: Arc<dyn Clock>,
    /// Test-only injection so worker-halt behavior is deterministically
    /// observable; `cfg(test)` keeps it out of the shipped crate.
    #[cfg(test)]
    injected_persistence_failure: AtomicBool,
}

struct OperationRow {
    operation_id: String,
    account_id: String,
    conversation_id: String,
    requested_archived: bool,
    status: OperationStatus,
    failure: Option<OperationFailure>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately opaque: never debug-print connection contents
        // (which could include message data).
        f.debug_struct("Store").finish_non_exhaustive()
    }
}

impl Store {
    pub(crate) fn open(profile_dir: &Path, clock: Arc<dyn Clock>) -> Result<Store, MailError> {
        std::fs::create_dir_all(profile_dir).map_err(|_| MailError::StorageUnavailable)?;
        let db_path = profile_dir.join("mail.db");
        let conn = Connection::open(&db_path).map_err(|_| MailError::StorageUnavailable)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| MailError::StorageUnavailable)?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(|_| MailError::StorageUnavailable)?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|_| MailError::StorageUnavailable)?;
        let store = Store {
            conn: Mutex::new(conn),
            clock,
            #[cfg(test)]
            injected_persistence_failure: AtomicBool::new(false),
        };
        store.migrate_and_seed()?;
        Ok(store)
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

    fn migrate_and_seed(&self) -> Result<(), MailError> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS conversations (
                account_id      TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                subject         TEXT NOT NULL,
                PRIMARY KEY (account_id, conversation_id)
            );
            CREATE TABLE IF NOT EXISTS messages (
                account_id      TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                message_id      TEXT NOT NULL,
                from_display    TEXT,
                from_mailbox    TEXT NOT NULL,
                to_json         TEXT NOT NULL,
                sent_at         TEXT NOT NULL,
                body_text       TEXT NOT NULL,
                provider_inbox  INTEGER NOT NULL CHECK (provider_inbox IN (0, 1)),
                PRIMARY KEY (account_id, conversation_id, message_id)
            );
            CREATE TABLE IF NOT EXISTS operations (
                seq                INTEGER PRIMARY KEY AUTOINCREMENT,
                operation_id       TEXT NOT NULL UNIQUE,
                account_id         TEXT NOT NULL,
                conversation_id    TEXT NOT NULL,
                requested_archived INTEGER NOT NULL CHECK (requested_archived IN (0, 1)),
                status             TEXT NOT NULL
                    CHECK (status IN ('queued', 'applying', 'confirmed', 'failed')),
                failure_kind       TEXT,
                accepted_at        TEXT NOT NULL,
                confirmed_at       TEXT,
                message_ids        TEXT NOT NULL,
                request_id         TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS request_keys (
                account_id      TEXT NOT NULL,
                request_id      TEXT NOT NULL,
                operation_id    TEXT NOT NULL,
                fingerprint     TEXT NOT NULL,
                accepted_at     TEXT NOT NULL,
                PRIMARY KEY (account_id, request_id)
            );",
        )
        .map_err(|_| MailError::StorageUnavailable)?;

        let schema_version: Option<String> = tx
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| MailError::StorageUnavailable)?;
        match schema_version {
            Some(version) if version == "1" => {}
            Some(_) => return Err(MailError::StorageUnavailable),
            None => {
                tx.execute(
                    "INSERT INTO meta (key, value) VALUES ('schema_version', '1')",
                    [],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
            }
        }

        let seeded: Option<String> = tx
            .query_row(
                "SELECT value FROM meta WHERE key = 'seed_version'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| MailError::StorageUnavailable)?;
        if seeded.is_none() {
            let existing: i64 = tx
                .query_row("SELECT COUNT(*) FROM conversations", [], |row| row.get(0))
                .map_err(|_| MailError::StorageUnavailable)?;
            if existing == 0 {
                let seeded_at = self.clock.now_iso();
                for conversation in seed::fixtures() {
                    insert_seed_conversation(&tx, &conversation, seeded_at.as_str())?;
                }
            }
            tx.execute(
                "INSERT INTO meta (key, value) VALUES ('seed_version', ?1)",
                [seed::SEED_VERSION],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        }
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(())
    }

    /// Startup recovery specific to the fixture archive setter: interrupted
    /// `applying` operations return to `queued` in their original acceptance
    /// sequence. This is not a send recovery policy.
    pub(crate) fn recover_applying(&self) -> Result<usize, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let recovered = tx
            .execute(
                "UPDATE operations SET status = 'queued' WHERE status = 'applying'",
                [],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(recovered)
    }

    /// Accepts an archive command. Validates, dedups on the request key, and
    /// snapshots the currently observed message ids in the same transaction
    /// that inserts the operation. The receipt is returned only after commit.
    pub(crate) fn set_archived(
        &self,
        command: &SetArchived,
    ) -> Result<OperationReceipt, MailError> {
        if command.request_id.trim().is_empty() {
            return Err(MailError::InvalidRequest {
                field: "requestId".to_string(),
            });
        }
        if command.conversation.account_id != ACCOUNT_ID {
            return Err(MailError::NotFound);
        }
        let fingerprint = format!(
            "set_archived|v1|account={}|conversation={}|archived={}",
            command.conversation.account_id, command.conversation.conversation_id, command.archived
        );
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;

        let exists: bool = tx
            .query_row(
                "SELECT 1 FROM conversations WHERE account_id = ?1 AND conversation_id = ?2",
                params![
                    command.conversation.account_id,
                    command.conversation.conversation_id
                ],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| MailError::StorageUnavailable)?
            .is_some();
        if !exists {
            return Err(MailError::NotFound);
        }

        // Retry the original receipt lookup before deriving new targets.
        let existing = tx
            .query_row(
                "SELECT operation_id, fingerprint, accepted_at FROM request_keys
                 WHERE account_id = ?1 AND request_id = ?2",
                params![command.conversation.account_id, command.request_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| MailError::StorageUnavailable)?;
        if let Some((operation_id, stored_fingerprint, accepted_at)) = existing {
            if stored_fingerprint == fingerprint {
                return Ok(OperationReceipt {
                    operation_id,
                    accepted_at,
                });
            }
            return Err(MailError::RequestIdConflict);
        }

        let message_ids = snapshot_message_ids(
            &tx,
            &command.conversation.account_id,
            &command.conversation.conversation_id,
        )?;
        let operation_id = format!("op-{}", uuid::Uuid::new_v4());
        let accepted_at = self.clock.now_iso();
        let message_ids_json =
            serde_json::to_string(&message_ids).map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "INSERT INTO operations
                (operation_id, account_id, conversation_id, requested_archived, status,
                 failure_kind, accepted_at, confirmed_at, message_ids, request_id)
             VALUES (?1, ?2, ?3, ?4, 'queued', NULL, ?5, NULL, ?6, ?7)",
            params![
                operation_id,
                command.conversation.account_id,
                command.conversation.conversation_id,
                command.archived as i64,
                accepted_at,
                message_ids_json,
                command.request_id,
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "INSERT INTO request_keys
                (account_id, request_id, operation_id, fingerprint, accepted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                command.conversation.account_id,
                command.request_id,
                operation_id,
                fingerprint,
                accepted_at,
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(OperationReceipt {
            operation_id,
            accepted_at,
        })
    }

    /// Effective inbox list plus full operation history.
    pub(crate) fn list_snapshot(&self) -> Result<InboxSnapshot, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let conversation_ids: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT conversation_id FROM conversations WHERE account_id = ?1")
                .map_err(|_| MailError::StorageUnavailable)?;
            let collected = stmt
                .query_map([ACCOUNT_ID], |row| row.get::<_, String>(0))
                .map_err(|_| MailError::StorageUnavailable)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| MailError::StorageUnavailable)?;
            collected
        };

        let mut summaries = Vec::with_capacity(conversation_ids.len());
        for conversation_id in &conversation_ids {
            let built = build_conversation_view(&conn, ACCOUNT_ID, conversation_id)?;
            if built.is_in_inbox {
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
                    pending_operation_id: built.pending_operation_id,
                });
            }
        }
        summaries.sort_by(|a, b| {
            b.last_message_at.cmp(&a.last_message_at).then_with(|| {
                a.conversation_ref
                    .conversation_id
                    .cmp(&b.conversation_ref.conversation_id)
            })
        });

        let activity = self.activity_rows(&conn)?;
        Ok(InboxSnapshot {
            conversations: summaries,
            activity,
        })
    }

    /// Full reader view of one conversation, scoped by account.
    pub(crate) fn get_conversation(
        &self,
        r#ref: &ConversationRef,
    ) -> Result<Conversation, MailError> {
        if r#ref.account_id != ACCOUNT_ID {
            return Err(MailError::NotFound);
        }
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let built = build_conversation_view(&conn, &r#ref.account_id, &r#ref.conversation_id)?;
        if built.messages.is_empty() {
            return Err(MailError::NotFound);
        }
        Ok(Conversation {
            conversation_ref: built.conversation_ref,
            subject: built.subject,
            is_in_inbox: built.is_in_inbox,
            messages: built.messages,
            pending_operation_id: built.pending_operation_id,
        })
    }

    fn activity_rows(&self, conn: &Connection) -> Result<Vec<OperationSummary>, MailError> {
        let mut stmt = conn
            .prepare(
                "SELECT operation_id, account_id, conversation_id, requested_archived,
                        status, failure_kind
                 FROM operations WHERE account_id = ?1 ORDER BY seq DESC",
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        let rows = stmt
            .query_map([ACCOUNT_ID], |row| {
                Ok(OperationRow {
                    operation_id: row.get(0)?,
                    account_id: row.get(1)?,
                    conversation_id: row.get(2)?,
                    requested_archived: row.get::<_, i64>(3)? != 0,
                    status: status_from_str(&row.get::<_, String>(4)?),
                    failure: failure_from_str(&row.get::<_, Option<String>>(5)?),
                })
            })
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
        Ok(rows
            .into_iter()
            .map(|row| OperationSummary {
                id: row.operation_id,
                conversation: ConversationRef {
                    account_id: row.account_id,
                    conversation_id: row.conversation_id,
                },
                requested_archived: row.requested_archived,
                status: row.status,
                failure: row.failure,
            })
            .collect())
    }

    /// Claims the oldest queued operation and flips it to `applying` atomically.
    pub(crate) fn claim_next_queued(&self) -> Result<Option<ClaimedOp>, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let claimed = tx
            .query_row(
                "SELECT operation_id, account_id, conversation_id, requested_archived, message_ids
                 FROM operations WHERE status = 'queued' ORDER BY seq ASC LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)? != 0,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| MailError::StorageUnavailable)?;
        let claimed = claimed
            .map(
                |(operation_id, account_id, conversation_id, requested_archived, message_ids)| {
                    Ok(ClaimedOp {
                        operation_id,
                        account_id,
                        conversation_id,
                        requested_archived,
                        message_ids: parse_ids(&message_ids)?,
                    })
                },
            )
            .transpose()?;
        if let Some(op) = &claimed {
            tx.execute(
                "UPDATE operations SET status = 'applying' WHERE operation_id = ?1",
                params![op.operation_id],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        }
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(claimed)
    }

    /// Confirms a claimed operation: updates cached provider facts and marks
    /// it confirmed in one transaction. Older confirmations never erase newer
    /// pending intent because only base facts and this row's status change.
    pub(crate) fn confirm_op(&self, op: &ClaimedOp) -> Result<(), MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "UPDATE operations SET status = 'confirmed', confirmed_at = ?2
             WHERE operation_id = ?1 AND status = 'applying'",
            params![op.operation_id, self.clock.now_iso()],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        let fact: i64 = if op.requested_archived { 0 } else { 1 };
        for message_id in &op.message_ids {
            tx.execute(
                "UPDATE messages SET provider_inbox = ?4
                 WHERE account_id = ?1 AND conversation_id = ?2 AND message_id = ?3",
                params![op.account_id, op.conversation_id, message_id, fact],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        }
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(())
    }

    /// Marks a claimed operation failed with its definite failure kind.
    pub(crate) fn fail_op(&self, operation_id: &str, failure_kind: &str) -> Result<(), MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        conn.execute(
            "UPDATE operations SET status = 'failed', failure_kind = ?2
             WHERE operation_id = ?1 AND status = 'applying'",
            params![operation_id, failure_kind],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        Ok(())
    }
}

fn insert_seed_conversation(
    tx: &Transaction<'_>,
    conversation: &SeedConversation,
    _seeded_at: &str,
) -> Result<(), MailError> {
    tx.execute(
        "INSERT INTO conversations (account_id, conversation_id, subject) VALUES (?1, ?2, ?3)",
        params![ACCOUNT_ID, conversation.id, conversation.subject],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    for message in conversation.messages {
        let to_json = serde_json::to_string(
            &message
                .to
                .iter()
                .map(|(display, mailbox)| Address {
                    display_name: non_empty(display),
                    mailbox: (*mailbox).to_string(),
                })
                .collect::<Vec<_>>(),
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "INSERT INTO messages
                (account_id, conversation_id, message_id, from_display, from_mailbox,
                 to_json, sent_at, body_text, provider_inbox)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                ACCOUNT_ID,
                conversation.id,
                message.id,
                non_empty(message.from.0),
                message.from.1,
                to_json,
                message.sent_at,
                message.body,
                conversation.in_inbox as i64,
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    }
    Ok(())
}

fn non_empty(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

fn snapshot_message_ids(
    tx: &Transaction<'_>,
    account_id: &str,
    conversation_id: &str,
) -> Result<Vec<String>, MailError> {
    let mut stmt = tx
        .prepare(
            "SELECT message_id FROM messages
             WHERE account_id = ?1 AND conversation_id = ?2
             ORDER BY sent_at ASC, message_id ASC",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    let collected = stmt
        .query_map(params![account_id, conversation_id], |row| row.get(0))
        .map_err(|_| MailError::StorageUnavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| MailError::StorageUnavailable)?;
    Ok(collected)
}

fn parse_ids(json: &str) -> Result<Vec<String>, MailError> {
    serde_json::from_str(json).map_err(|_| MailError::StorageUnavailable)
}

fn status_from_str(s: &str) -> OperationStatus {
    match s {
        "queued" => OperationStatus::Queued,
        "applying" => OperationStatus::Applying,
        "confirmed" => OperationStatus::Confirmed,
        _ => OperationStatus::Failed,
    }
}

fn failure_from_str(s: &Option<String>) -> Option<OperationFailure> {
    match s.as_deref() {
        Some("provider_unavailable") => Some(OperationFailure::ProviderUnavailable),
        Some("provider_rejected") => Some(OperationFailure::ProviderRejected),
        _ => None,
    }
}

struct ConversationView {
    conversation_ref: ConversationRef,
    subject: String,
    messages: Vec<Message>,
    is_in_inbox: bool,
    pending_operation_id: Option<String>,
}

/// Reads base provider facts plus pending operations (acceptance order) and
/// derives the effective per-message INBOX membership. Vue never computes
/// this overlay itself.
fn build_conversation_view(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<ConversationView, MailError> {
    let subject: Option<String> = conn
        .query_row(
            "SELECT subject FROM conversations WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some(subject) = subject else {
        return Ok(ConversationView {
            conversation_ref: ConversationRef {
                account_id: account_id.to_string(),
                conversation_id: conversation_id.to_string(),
            },
            subject: String::new(),
            messages: Vec::new(),
            is_in_inbox: false,
            pending_operation_id: None,
        });
    };

    let mut message_stmt = conn
        .prepare(
            "SELECT message_id, from_display, from_mailbox, to_json, sent_at, body_text,
                    provider_inbox
             FROM messages
             WHERE account_id = ?1 AND conversation_id = ?2
             ORDER BY sent_at ASC, message_id ASC",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    let mut messages: Vec<(Message, bool)> = message_stmt
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

    let mut op_stmt = conn
        .prepare(
            "SELECT operation_id, requested_archived, message_ids FROM operations
             WHERE account_id = ?1 AND conversation_id = ?2 AND status IN ('queued', 'applying')
             ORDER BY seq ASC",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    let pending: Vec<(String, bool, Vec<String>)> = op_stmt
        .query_map(params![account_id, conversation_id], |row| {
            let ids_json: String = row.get(2)?;
            let ids: Vec<String> = serde_json::from_str(&ids_json).map_err(|_| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    "invalid message id JSON".into(),
                )
            })?;
            Ok((row.get(0)?, row.get::<_, i64>(1)? != 0, ids))
        })
        .map_err(|_| MailError::StorageUnavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| MailError::StorageUnavailable)?;

    // Overlay: each pending operation applies, in acceptance order, to the
    // message ids it snapshotted at acceptance time.
    for (_, archived, ids) in &pending {
        for (message, in_inbox) in &mut messages {
            if ids.contains(&message.id) {
                *in_inbox = !archived;
            }
        }
    }

    Ok(ConversationView {
        is_in_inbox: messages.iter().any(|(_, in_inbox)| *in_inbox),
        pending_operation_id: pending.last().map(|(id, _, _)| id.clone()),
        conversation_ref: ConversationRef {
            account_id: account_id.to_string(),
            conversation_id: conversation_id.to_string(),
        },
        subject,
        messages: messages.into_iter().map(|(message, _)| message).collect(),
    })
}

fn participants_of(messages: &[Message]) -> Vec<Address> {
    let mut seen_mailboxes: Vec<String> = Vec::new();
    let mut participants: Vec<Address> = Vec::new();
    let mut push = |address: &Address| {
        if !seen_mailboxes.contains(&address.mailbox) {
            seen_mailboxes.push(address.mailbox.clone());
            participants.push(address.clone());
        }
    };
    for message in messages {
        push(&message.from);
        for to in &message.to {
            push(to);
        }
    }
    participants
}

fn preview_of(messages: &[Message]) -> String {
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
    use crate::dto::ConversationRef;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "mail-core-store-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    fn sample_command() -> SetArchived {
        SetArchived {
            conversation: ConversationRef {
                account_id: ACCOUNT_ID.to_string(),
                conversation_id: "conv-01".to_string(),
            },
            archived: true,
            request_id: "req-test".to_string(),
        }
    }

    /// Storage errors surface instead of being ignored (fail closed): an
    /// unusable profile directory fails at open time.
    #[test]
    fn open_fails_closed_on_unusable_profile_directory() {
        let blocker = temp_dir("blocker");
        std::fs::write(&blocker, b"not a directory").expect("write blocker file");
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        match Store::open(&blocker, clock) {
            Err(MailError::StorageUnavailable) => {}
            other => panic!("expected storage_unavailable, got {other:?}"),
        }
        let _ = std::fs::remove_file(&blocker);
    }

    /// An injected persistence failure makes every write/read surface
    /// `storage_unavailable`; nothing is logged-and-ignored.
    #[test]
    fn persistence_failure_is_surfaced_not_ignored() {
        let dir = temp_dir("injected");
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let store = Store::open(&dir, clock).expect("store opens");
        assert!(store.list_snapshot().is_ok());
        store.set_test_persistence_failure(true);
        assert_eq!(
            store.set_archived(&sample_command()),
            Err(MailError::StorageUnavailable)
        );
        assert_eq!(store.list_snapshot(), Err(MailError::StorageUnavailable));
        assert_eq!(
            store.claim_next_queued(),
            Err(MailError::StorageUnavailable)
        );
        store.set_test_persistence_failure(false);
        assert!(store.list_snapshot().is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
