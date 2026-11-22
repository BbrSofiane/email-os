//! Durable synthetic provider facts.
//!
//! Message content is fixed code ([`super::data`]); only the facts a mailbox
//! write can change live in SQLite: per-message INBOX, UNREAD and STARRED,
//! plus a monotonically numbered change log that backs `history`. Archive is
//! therefore modelled per message, exactly as Gmail labels are.
//!
//! Every write is one transaction and the file runs with WAL and
//! `synchronous = FULL`, so a crash leaves either the whole write or none of
//! it. Seeding is one `IMMEDIATE` transaction guarded by a meta marker:
//! reopening never overwrites facts that have changed since.
//!
//! Seed version 2 (ADR 0006) added six HTML sample conversations. A profile
//! seeded at version 1 is upgraded additively in the same transaction: facts
//! are inserted only for messages that have none, existing facts are never
//! touched, and the new conversations are recorded as one history change so a
//! history pass picks them up. Any other seed mismatch still fails closed.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::data::{fixtures, seeded_unread, SEED_VERSION};
use crate::dto::MailboxOperationKind;
use crate::error::MailError;
use crate::storage_log::storage_err;

const SCHEMA_VERSION: i64 = 2;

/// The mutable facts of one message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct MessageFacts {
    pub in_inbox: bool,
    pub unread: bool,
    pub starred: bool,
}

pub(super) struct FactStore {
    conn: Mutex<Connection>,
}

impl FactStore {
    pub(super) fn open(db_path: &Path) -> Result<Self, MailError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(storage_err())?;
        }
        let mut conn = Connection::open(db_path).map_err(storage_err())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(storage_err())?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(storage_err())?;
        Self::migrate_and_seed(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn migrate_and_seed(conn: &mut Connection) -> Result<(), MailError> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_err())?;
        let version: i64 = tx
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(storage_err())?;
        match version {
            0 => {
                tx.execute_batch(
                    "CREATE TABLE synthetic_meta (
                         key   TEXT PRIMARY KEY,
                         value TEXT NOT NULL
                     ) WITHOUT ROWID;
                     CREATE TABLE synthetic_messages (
                         message_id      TEXT PRIMARY KEY,
                         conversation_id TEXT NOT NULL,
                         in_inbox        INTEGER NOT NULL CHECK (in_inbox IN (0, 1)),
                         unread          INTEGER NOT NULL CHECK (unread IN (0, 1)),
                         starred         INTEGER NOT NULL CHECK (starred IN (0, 1))
                     ) WITHOUT ROWID;
                     CREATE INDEX synthetic_messages_by_conversation
                         ON synthetic_messages (conversation_id);
                     CREATE TABLE synthetic_sent (
                         message_id TEXT PRIMARY KEY,
                         conversation_id TEXT NOT NULL,
                         raw_mime BLOB NOT NULL
                     ) WITHOUT ROWID;
                     CREATE INDEX synthetic_sent_by_conversation
                         ON synthetic_sent (conversation_id);
                     CREATE TABLE synthetic_changes (
                         history_id      INTEGER NOT NULL,
                         conversation_id TEXT NOT NULL,
                         PRIMARY KEY (history_id, conversation_id)
                     ) WITHOUT ROWID;",
                )
                .map_err(storage_err())?;
                seed(&tx)?;
                tx.pragma_update(None, "user_version", SCHEMA_VERSION)
                    .map_err(storage_err())?;
            }
            1 | SCHEMA_VERSION => {
                if version == 1 {
                    tx.execute_batch(
                        "CREATE TABLE synthetic_sent (
                             message_id TEXT PRIMARY KEY,
                             conversation_id TEXT NOT NULL,
                             raw_mime BLOB NOT NULL
                         ) WITHOUT ROWID;
                         CREATE INDEX synthetic_sent_by_conversation
                             ON synthetic_sent (conversation_id);",
                    )
                    .map_err(storage_err())?;
                    tx.pragma_update(None, "user_version", SCHEMA_VERSION)
                        .map_err(storage_err())?;
                }
                // Seeded earlier. Never re-seed or reset facts; a different
                // seed would need an explicit migration, so fail closed.
                let seeded = meta_get(&tx, "seed_version")?;
                if seeded.as_deref() == Some("1") && SEED_VERSION == "2" {
                    upgrade_v1(&tx)?;
                } else if seeded.as_deref() != Some(SEED_VERSION) {
                    return Err(crate::storage_log::storage_fault(
                        "synthetic_seed_version_mismatch",
                    ));
                }
            }
            _ => {
                return Err(crate::storage_log::storage_fault(
                    "synthetic_schema_version_unsupported",
                ))
            }
        }
        tx.commit().map_err(storage_err())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, MailError> {
        self.conn.lock().map_err(storage_err())
    }

    /// The current (latest) history id; changes strictly after an earlier id
    /// are what `history` reports.
    pub(super) fn history_id(&self) -> Result<u64, MailError> {
        let conn = self.lock()?;
        current_history_id(&conn)
    }

    /// Facts of every message of one conversation, keyed by message id, and
    /// the history id they were read at (one consistent snapshot).
    pub(super) fn conversation_facts(
        &self,
        conversation_id: &str,
    ) -> Result<(HashMap<String, MessageFacts>, u64), MailError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(storage_err())?;
        let history = current_history_id(&tx)?;
        let mut stmt = tx
            .prepare(
                "SELECT message_id, in_inbox, unread, starred FROM synthetic_messages
                 WHERE conversation_id = ?1",
            )
            .map_err(storage_err())?;
        let rows = stmt
            .query_map(params![conversation_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    MessageFacts {
                        in_inbox: row.get::<_, i64>(1)? != 0,
                        unread: row.get::<_, i64>(2)? != 0,
                        starred: row.get::<_, i64>(3)? != 0,
                    },
                ))
            })
            .map_err(storage_err())?
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(storage_err())?;
        drop(stmt);
        Ok((rows, history))
    }

    /// Ids of conversations with at least one INBOX message.
    pub(super) fn inbox_conversation_ids(&self) -> Result<Vec<String>, MailError> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT DISTINCT conversation_id FROM synthetic_messages WHERE in_inbox = 1")
            .map_err(storage_err())?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_err())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_err())?;
        Ok(ids)
    }

    /// Persist a sent message and its mailbox facts in the same transaction.
    pub(super) fn insert_sent(
        &self,
        message_id: &str,
        conversation_id: &str,
        raw_mime: &[u8],
    ) -> Result<(), MailError> {
        let mut conn = self.lock()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_err())?;
        tx.execute(
            "INSERT INTO synthetic_sent (message_id, conversation_id, raw_mime) VALUES (?1, ?2, ?3)",
            params![message_id, conversation_id, raw_mime],
        ).map_err(storage_err())?;
        tx.execute(
            "INSERT INTO synthetic_messages (message_id, conversation_id, in_inbox, unread, starred) VALUES (?1, ?2, 0, 0, 0)",
            params![message_id, conversation_id],
        ).map_err(storage_err())?;
        let next = current_history_id(&tx)?
            .checked_add(1)
            .ok_or_else(|| crate::storage_log::storage_fault("synthetic_history_id_overflow"))?;
        meta_set(&tx, "history_id", &next.to_string())?;
        tx.execute(
            "INSERT INTO synthetic_changes (history_id, conversation_id) VALUES (?1, ?2)",
            params![next as i64, conversation_id],
        )
        .map_err(storage_err())?;
        tx.commit().map_err(storage_err())
    }

    /// Read all persisted Sent evidence for exact header verification.
    pub(super) fn all_sent(&self) -> Result<Vec<(String, String, Vec<u8>)>, MailError> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT message_id, conversation_id, raw_mime FROM synthetic_sent")
            .map_err(storage_err())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(storage_err())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(storage_err())
    }

    /// Read persisted sent messages for an exact conversation after reopening.
    pub(super) fn sent_in_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<(String, Vec<u8>)>, MailError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT message_id, raw_mime FROM synthetic_sent WHERE conversation_id = ?1 ORDER BY message_id",
        ).map_err(storage_err())?;
        let rows = stmt
            .query_map(params![conversation_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(storage_err())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(storage_err())
    }

    /// Applies one mailbox write atomically. Every id must be a known
    /// message or nothing is written. Returns the number of messages whose
    /// fact actually changed; an idempotent repeat changes nothing and does
    /// not advance the history id.
    pub(super) fn apply(
        &self,
        kind: MailboxOperationKind,
        message_ids: &[String],
        value: bool,
    ) -> Result<usize, MailError> {
        let mut conn = self.lock()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_err())?;
        // (column, stored value): archived=true removes INBOX, read=true
        // removes UNREAD, starred=true sets STARRED.
        let (column, stored) = match kind {
            MailboxOperationKind::Archive => ("in_inbox", !value),
            MailboxOperationKind::Read => ("unread", !value),
            MailboxOperationKind::Star => ("starred", value),
        };
        let select = format!(
            "SELECT conversation_id, {column} FROM synthetic_messages WHERE message_id = ?1"
        );
        let mut changed: Vec<(String, String)> = Vec::new();
        for id in message_ids {
            let current: Option<(String, i64)> = tx
                .query_row(&select, params![id], |row| Ok((row.get(0)?, row.get(1)?)))
                .optional()
                .map_err(storage_err())?;
            let Some((conversation_id, current)) = current else {
                // Unknown message: a definite provider rejection; the
                // transaction drops, so nothing from this write persists.
                return Err(MailError::ProviderRejected);
            };
            if (current != 0) != stored {
                changed.push((id.clone(), conversation_id));
            }
        }
        if changed.is_empty() {
            return Ok(0);
        }
        let update = format!("UPDATE synthetic_messages SET {column} = ?1 WHERE message_id = ?2");
        for (id, _) in &changed {
            tx.execute(&update, params![stored as i64, id])
                .map_err(storage_err())?;
        }
        let next = current_history_id(&tx)? + 1;
        meta_set(&tx, "history_id", &next.to_string())?;
        for (_, conversation_id) in &changed {
            tx.execute(
                "INSERT OR IGNORE INTO synthetic_changes (history_id, conversation_id)
                 VALUES (?1, ?2)",
                params![next as i64, conversation_id],
            )
            .map_err(storage_err())?;
        }
        tx.commit().map_err(storage_err())?;
        Ok(changed.len())
    }

    /// Conversations changed strictly after `start`, or `None` when `start`
    /// is not a history id this store ever issued (expired/invalid cursor).
    pub(super) fn changes_since(
        &self,
        start: &str,
    ) -> Result<Option<(Vec<String>, u64)>, MailError> {
        let conn = self.lock()?;
        let current = current_history_id(&conn)?;
        let Ok(start) = start.parse::<u64>() else {
            return Ok(None);
        };
        if start > current {
            return Ok(None);
        }
        if start == current {
            return Ok(Some((Vec::new(), current)));
        }
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT conversation_id FROM synthetic_changes
                 WHERE history_id > ?1 ORDER BY conversation_id",
            )
            .map_err(storage_err())?;
        let ids = stmt
            .query_map(params![start as i64], |row| row.get::<_, String>(0))
            .map_err(storage_err())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_err())?;
        Ok(Some((ids, current)))
    }
}

/// Additive seed upgrade from version 1 to 2 (see the module documentation).
fn upgrade_v1(tx: &rusqlite::Transaction<'_>) -> Result<(), MailError> {
    let history = current_history_id(tx)?
        .checked_add(1)
        .ok_or_else(|| crate::storage_log::storage_fault("synthetic_history_id_overflow"))?;
    for conversation in fixtures() {
        let mut added = false;
        for message in conversation.messages {
            let count = tx
                .execute(
                    "INSERT OR IGNORE INTO synthetic_messages
                        (message_id, conversation_id, in_inbox, unread, starred)
                     VALUES (?1, ?2, ?3, ?4, 0)",
                    params![
                        message.id,
                        conversation.id,
                        conversation.in_inbox as i64,
                        seeded_unread(&conversation, message) as i64
                    ],
                )
                .map_err(storage_err())?;
            added |= count > 0;
        }
        if added {
            tx.execute(
                "INSERT OR IGNORE INTO synthetic_changes (history_id, conversation_id)
                 VALUES (?1, ?2)",
                params![history as i64, conversation.id],
            )
            .map_err(storage_err())?;
        }
    }
    meta_set(tx, "history_id", &history.to_string())?;
    meta_set(tx, "seed_version", SEED_VERSION)
}

fn seed(tx: &rusqlite::Transaction<'_>) -> Result<(), MailError> {
    for conversation in fixtures() {
        for message in conversation.messages {
            let unread = seeded_unread(&conversation, message);
            tx.execute(
                "INSERT INTO synthetic_messages
                    (message_id, conversation_id, in_inbox, unread, starred)
                 VALUES (?1, ?2, ?3, ?4, 0)",
                params![
                    message.id,
                    conversation.id,
                    conversation.in_inbox as i64,
                    unread as i64
                ],
            )
            .map_err(storage_err())?;
        }
    }
    meta_set(tx, "seed_version", SEED_VERSION)?;
    meta_set(tx, "history_id", "1")?;
    Ok(())
}

fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, MailError> {
    conn.query_row(
        "SELECT value FROM synthetic_meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(storage_err())
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), MailError> {
    conn.execute(
        "INSERT INTO synthetic_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(storage_err())?;
    Ok(())
}

fn current_history_id(conn: &Connection) -> Result<u64, MailError> {
    meta_get(conn, "history_id")?
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| crate::storage_log::storage_fault("synthetic_history_id_missing"))
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;

    #[test]
    fn sent_facts_are_atomic_and_readable() {
        let mut conn = Connection::open_in_memory().unwrap();
        FactStore::migrate_and_seed(&mut conn).unwrap();
        let store = FactStore {
            conn: Mutex::new(conn),
        };
        let before = store.history_id().unwrap();
        store.insert_sent("sent-1", "conv-01", b"message").unwrap();
        assert_eq!(
            store.sent_in_conversation("conv-01").unwrap(),
            vec![("sent-1".into(), b"message".to_vec())]
        );
        assert!(store
            .insert_sent("sent-1", "conv-01", b"duplicate")
            .is_err());
        assert_eq!(store.history_id().unwrap(), before + 1);
        assert!(!store.conversation_facts("conv-01").unwrap().0["sent-1"].in_inbox);
    }

    #[test]
    fn upgrades_v1_additively_once() {
        let mut conn = Connection::open_in_memory().unwrap();
        FactStore::migrate_and_seed(&mut conn).unwrap();
        conn.execute("DELETE FROM synthetic_messages WHERE conversation_id IN ('conv-19','conv-20','conv-21','conv-22','conv-23','conv-24')", []).unwrap();
        conn.execute(
            "UPDATE synthetic_messages SET in_inbox = 0, starred = 1 WHERE message_id = 'm-01-1'",
            [],
        )
        .unwrap();
        meta_set(&conn, "seed_version", "1").unwrap();
        let old = current_history_id(&conn).unwrap();
        FactStore::migrate_and_seed(&mut conn).unwrap();
        assert_eq!(
            meta_get(&conn, "seed_version").unwrap().as_deref(),
            Some("2")
        );
        let facts: (i64, i64) = conn
            .query_row(
                "SELECT in_inbox, starred FROM synthetic_messages WHERE message_id = 'm-01-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(facts, (0, 1));
        let store = FactStore {
            conn: Mutex::new(conn),
        };
        let (ids, history) = store.changes_since(&old.to_string()).unwrap().unwrap();
        assert_eq!(
            ids,
            (19..=24).map(|n| format!("conv-{n}")).collect::<Vec<_>>()
        );
        for id in &ids {
            assert!(!store.conversation_facts(id).unwrap().0.is_empty());
        }
        let mut conn = store.conn.into_inner().unwrap();
        FactStore::migrate_and_seed(&mut conn).unwrap();
        assert_eq!(current_history_id(&conn).unwrap(), history);
    }
}
