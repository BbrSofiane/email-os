//! Ordered Gmail-only schema upgrades. The pre-numbered gmail-1/gmail-2
//! markers described several physical layouts. Compatibility checks live in
//! these historical migration bodies, never on an already-current open.
use super::{has_column, meta_get, meta_set, MailError, SCHEMA_VERSION};
use rusqlite::Connection;

const CURRENT: u32 = 9;

pub(super) fn migrate(conn: &mut Connection) -> Result<(), MailError> {
    migrate_with_hook(conn, |_| Ok(()))
}

// The hook lets tests simulate interruption after DDL/backfill and before the
// marker commits. Production uses a no-op; dropping the transaction rolls back
// both schema and data, including its version marker.
pub(super) fn migrate_with_hook(
    conn: &mut Connection,
    mut before_commit: impl FnMut(u32) -> Result<(), MailError>,
) -> Result<(), MailError> {
    let has_meta = table_exists(conn, "meta")?;
    let version = if has_meta {
        meta_get(conn, "schema_version")?
    } else {
        None
    };
    let applied = match version.as_deref() {
        Some("gmail-1" | "gmail-2") | None => 0,
        Some(SCHEMA_VERSION) => return Ok(()),
        Some(value) => match value.strip_prefix("gmail-migrations-") {
            Some(number) => match number.parse::<u32>() {
                Ok(n) if (1..CURRENT).contains(&n) && n.to_string() == number => n,
                _ => return Err(MailError::StorageUnavailable),
            },
            None => return Err(MailError::StorageUnavailable),
        },
    };
    let empty: bool = conn
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%')",
            [],
            |row| row.get(0),
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    if empty {
        // Canonical fresh layout is the full schema captured before this change.
        // Old layouts can have a different ALTER column order; no table rebuild
        // is needed merely to make that cosmetic order match.
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute_batch(include_str!("current-schema.sql"))
            .map_err(|_| MailError::StorageUnavailable)?;
        meta_set(&tx, "schema_version", SCHEMA_VERSION)?;
        meta_set(&tx, "generation", "0")?;
        before_commit(CURRENT)?;
        return tx.commit().map_err(|_| MailError::StorageUnavailable);
    }
    for next in applied + 1..=CURRENT {
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        apply(&tx, next)?;
        meta_set(&tx, "schema_version", &format!("gmail-migrations-{next}"))?;
        before_commit(next)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
    }
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, MailError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [name],
        |row| row.get(0),
    )
    .map_err(|_| MailError::StorageUnavailable)
}

fn add_legacy_column(
    conn: &Connection,
    table: &str,
    column: &str,
    ddl: &str,
) -> Result<bool, MailError> {
    if has_column(conn, table, column)? {
        return Ok(false);
    }
    conn.execute_batch(ddl)
        .map_err(|_| MailError::StorageUnavailable)?;
    Ok(true)
}

fn apply(conn: &Connection, version: u32) -> Result<(), MailError> {
    match version {
        // Establish the common pre-numbered table foundation. IF NOT EXISTS is
        // intentional: both legacy markers shipped with multiple table sets.
        1 => conn.execute_batch(include_str!("legacy-foundation.sql"))
            .map_err(|_| MailError::StorageUnavailable)?,
        2 => {
            for (column, ddl) in [
                ("is_starred", "ALTER TABLE gmail_message_facts ADD COLUMN is_starred INTEGER"),
                ("in_trash", "ALTER TABLE gmail_message_facts ADD COLUMN in_trash INTEGER"),
                ("in_spam", "ALTER TABLE gmail_message_facts ADD COLUMN in_spam INTEGER"),
            ] { add_legacy_column(conn, "gmail_message_facts", column, ddl)?; }
        }
        3 => { add_legacy_column(conn, "gmail_messages", "has_attachment",
            "ALTER TABLE gmail_messages ADD COLUMN has_attachment INTEGER")?; }
        4 => {
            for (column, ddl) in [
                ("attachments_json", "ALTER TABLE gmail_conversations ADD COLUMN attachments_json TEXT"),
                ("reply_context_json", "ALTER TABLE gmail_conversations ADD COLUMN reply_context_json TEXT"),
                ("newest_sender_json", "ALTER TABLE gmail_conversations ADD COLUMN newest_sender_json TEXT"),
            ] { add_legacy_column(conn, "gmail_conversations", column, ddl)?; }
        }
        5 => {
            if add_legacy_column(conn, "gmail_operation_snapshots", "last_message_at",
                "ALTER TABLE gmail_operation_snapshots ADD COLUMN last_message_at TEXT NOT NULL DEFAULT ''")? {
                conn.execute("UPDATE gmail_operation_snapshots SET last_message_at = COALESCE(json_extract(snapshot_json, '$.messages[#-1].sentAt'), '')", [])
                    .map_err(|_| MailError::StorageUnavailable)?;
            }
        }
        6 => {
            add_legacy_column(conn, "gmail_operations", "undo_of", "ALTER TABLE gmail_operations ADD COLUMN undo_of TEXT")?;
            add_legacy_column(conn, "gmail_operation_requests", "accepted_at", "ALTER TABLE gmail_operation_requests ADD COLUMN accepted_at TEXT")?;
        }
        7 => {
            add_legacy_column(conn, "gmail_operations", "action_id", "ALTER TABLE gmail_operations ADD COLUMN action_id TEXT")?;
            add_legacy_column(conn, "gmail_operations", "retry_of", "ALTER TABLE gmail_operations ADD COLUMN retry_of TEXT")?;
            conn.execute("UPDATE gmail_operations SET action_id = operation_id WHERE undo_of IS NULL AND action_id IS NULL", [])
                .map_err(|_| MailError::StorageUnavailable)?;
        }
        8 => {
            conn.execute_batch("INSERT OR IGNORE INTO gmail_inbox_membership
                (account_id, conversation_id, message_id)
                SELECT account_id, conversation_id, message_id FROM gmail_messages WHERE in_inbox = 1;
                INSERT OR IGNORE INTO gmail_message_facts
                (account_id, conversation_id, message_id, in_inbox, is_unread)
                SELECT account_id, conversation_id, message_id, in_inbox, NULL FROM gmail_messages;
                INSERT OR IGNORE INTO gmail_message_facts
                (account_id, conversation_id, message_id, in_inbox, is_unread)
                SELECT account_id, conversation_id, message_id, 1, NULL FROM gmail_inbox_membership;")
                .map_err(|_| MailError::StorageUnavailable)?;
        }
        9 => {
            conn.execute_batch("CREATE TABLE IF NOT EXISTS gmail_search_cache (
                account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
                PRIMARY KEY(account_id, conversation_id));
                INSERT OR IGNORE INTO meta (key, value) VALUES ('generation', '0');")
                .map_err(|_| MailError::StorageUnavailable)?;
        }
        _ => unreachable!("only ordered known migration numbers are dispatched"),
    }
    Ok(())
}
