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

fn admit_action_observation(
    tx: &Connection,
    observation: Option<&SearchObservation>,
    account: &str,
) -> Result<(), MailError> {
    match observation {
        Some(SearchObservation::Cached {
            generation,
            members,
        }) => {
            if !generation_matches(tx, *generation)? {
                return Err(MailError::NotFound);
            }
            for member in members {
                // Normal concurrent setters/history are safe: acceptance uses
                // current transactional facts. Only concurrent eviction needs
                // a retry through the missing-context/provider path.
                if !has_action_context(tx, account, &member.conversation_id)? {
                    return Err(MailError::Busy);
                }
            }
        }
        Some(SearchObservation::Fetched {
            generation,
            revision,
            threads,
        }) => {
            if !generation_matches(tx, *generation)? {
                return Err(MailError::NotFound);
            }
            if tx.total_changes() != *revision {
                return Err(MailError::Busy);
            }
            admit_search_rows(tx, threads, account)?;
        }
        None => {}
    }
    Ok(())
}

fn has_action_context(conn: &Connection, account: &str, id: &str) -> Result<bool, MailError> {
    conn.query_row(
        // Eviction removes live bodies, not operation-pinned facts/snapshots.
        // accept_operation_tx can capture fresh preimages from those same facts
        // and reuse the recovery snapshot without reading or widening targets.
        "SELECT EXISTS(SELECT 1 FROM gmail_message_facts WHERE account_id=?1 AND conversation_id=?2) AND (EXISTS(SELECT 1 FROM gmail_conversations WHERE account_id=?1 AND conversation_id=?2) OR EXISTS(SELECT 1 FROM gmail_operation_snapshots WHERE account_id=?1 AND conversation_id=?2))",
        params![account, id], |r| r.get(0)).map_err(|_| MailError::StorageUnavailable)
}

fn admit_search_rows(
    tx: &Connection,
    threads: &[GmailThread],
    account: &str,
) -> Result<(), MailError> {
    let seq: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(seq),0)+1 FROM gmail_search_cache",
            [],
            |r| r.get(0),
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    for thread in threads {
        if thread.conversation.conversation_ref.account_id != account {
            return Err(MailError::NotFound);
        }
        let id = &thread.conversation.conversation_ref.conversation_id;
        let ordinary: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM gmail_conversations c WHERE account_id = ?1 AND conversation_id = ?2 AND NOT EXISTS(SELECT 1 FROM gmail_search_cache s WHERE s.account_id = c.account_id AND s.conversation_id = c.conversation_id))", params![account,id], |r| r.get(0)).map_err(|_| MailError::StorageUnavailable)?;
        // Search may admit archived threads that discovery/history omit.
        tx.execute("INSERT OR IGNORE INTO gmail_conversations (account_id, conversation_id, subject, context_complete) VALUES (?1,?2,'',0)", params![account,id]).map_err(|_| MailError::StorageUnavailable)?;
        upsert_thread(tx, account, thread)?;
        if !ordinary {
            tx.execute(
                "INSERT OR REPLACE INTO gmail_search_cache VALUES (?1,?2,?3)",
                params![account, id, seq],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        }
    }
    Ok(())
}

/// Defer action eviction until *all* selected members have immutable targets
/// and recovery snapshots, including already-cached members near the LRU tail.
fn evict_search(tx: &Connection, account: &str) -> Result<(), MailError> {
    let ids = {
        let mut stmt = tx.prepare("SELECT conversation_id FROM gmail_search_cache s WHERE account_id = ?1 AND NOT EXISTS (SELECT 1 FROM gmail_reminders r WHERE r.account_id=s.account_id AND r.conversation_id=s.conversation_id AND json_extract(r.data,'$.phase')='pending') ORDER BY seq DESC, conversation_id LIMIT -1 OFFSET 100").map_err(|_| MailError::StorageUnavailable)?;
        let ids = stmt
            .query_map([account], |r| r.get::<_, String>(0))
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
        ids
    };
    for id in ids {
        // Same preservation rule as discovery eviction: only unpinned facts go.
        tx.execute(
            "DELETE FROM gmail_messages WHERE account_id=?1 AND conversation_id=?2",
            params![account, id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "DELETE FROM gmail_inbox_membership WHERE account_id=?1 AND conversation_id=?2",
            params![account, id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_message_facts WHERE account_id=?1 AND conversation_id=?2 AND NOT EXISTS (SELECT 1 FROM gmail_operation_targets t WHERE t.account_id=gmail_message_facts.account_id AND t.message_id=gmail_message_facts.message_id)", params![account,id]).map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "DELETE FROM gmail_conversations WHERE account_id=?1 AND conversation_id=?2",
            params![account, id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "DELETE FROM gmail_search_cache WHERE account_id=?1 AND conversation_id=?2",
            params![account, id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    }

    Ok(())
}

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
            stars: Some(crate::stars::StarState::from_facts(
                effective.facts.values().map(|fact| fact.2),
            )),
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
    facts: &HashMap<String, MessageFacts>,
    targets: &[String],
) -> Result<(), MailError> {
    for message_id in targets {
        let Some((in_inbox, unread, starred)) = facts.get(message_id) else {
            continue;
        };
        let prior_value = match kind {
            MailboxOperationKind::Archive => in_inbox.map(|v| !v),
            MailboxOperationKind::Read => unread.map(|v| !v),
            MailboxOperationKind::Star => *starred,
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
        MailboxOperationKind::Star => "star",
    }
}

fn parse_kind(kind: &str) -> Result<MailboxOperationKind, MailError> {
    match kind {
        "archive" => Ok(MailboxOperationKind::Archive),
        "read" => Ok(MailboxOperationKind::Read),
        "star" => Ok(MailboxOperationKind::Star),
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

fn star_state(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<crate::stars::StarState, MailError> {
    let effective = effective_conversation_state_with_coverage(conn, account_id, conversation_id)?;
    Ok(crate::stars::StarState::from_facts(
        effective.facts.values().map(|fact| fact.2),
    ))
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
/// `(in_inbox, is_unread, is_starred)`; `None` marks an unknown fact.
type MessageFacts = (Option<bool>, Option<bool>, Option<bool>);
pub(crate) struct EffectiveState {
    pub(crate) inbox: bool,
    pub(crate) is_read: Option<bool>,
    pub(crate) pending_operation_id: Option<String>,
    pub(crate) coverage_known: bool,
    pub(crate) facts: HashMap<String, MessageFacts>,
}

fn effective_conversation_state_with_coverage(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<EffectiveState, MailError> {
    let mut facts = HashMap::<String, MessageFacts>::new();
    let mut stmt = conn
        .prepare(
            "SELECT message_id, in_inbox, is_unread, is_starred FROM gmail_message_facts
         WHERE account_id = ?1 AND conversation_id = ?2",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    for row in stmt
        .query_map(params![account_id, conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })
        .map_err(|_| MailError::StorageUnavailable)?
    {
        let (id, inbox, unread, starred) = row.map_err(|_| MailError::StorageUnavailable)?;
        facts.insert(
            id,
            (
                inbox.map(|v| v != 0),
                unread.map(|v| v != 0),
                starred.map(|v| v != 0),
            ),
        );
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
            let entry = facts.entry(id.clone()).or_insert((None, None, None));
            match op.kind {
                MailboxOperationKind::Archive => entry.0 = Some(!op.value),
                MailboxOperationKind::Read => entry.1 = Some(!op.value),
                MailboxOperationKind::Star => entry.2 = Some(op.value),
            }
        }
    }
    let inbox = facts.values().any(|(inbox, _, _)| *inbox == Some(true));
    let is_read = if facts.is_empty() || facts.values().any(|(_, unread, _)| unread.is_none()) {
        None
    } else {
        Some(!facts.values().any(|(_, unread, _)| *unread == Some(true)))
    };
    Ok(EffectiveState {
        inbox,
        is_read,
        pending_operation_id: active.map(|(_, id)| id),
        coverage_known: !facts.is_empty() && facts.values().all(|(inbox, _, _)| inbox.is_some()),
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
            requested_starred: (kind == MailboxOperationKind::Star).then_some(value != 0),
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
        requested_starred: (kind == MailboxOperationKind::Star)
            .then_some(requested_value)
            .flatten(),
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

/// Observed Trash/Spam is not Done, even when older archive evidence exists.
fn has_excluded_membership(conn: &Connection, account: &str, id: &str) -> Result<bool, MailError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM gmail_message_facts
        WHERE account_id = ?1 AND conversation_id = ?2 AND (in_trash = 1 OR in_spam = 1))",
        params![account, id],
        |row| row.get(0),
    )
    .map_err(|_| MailError::StorageUnavailable)
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
    if !thread.inbox_message_ids.is_empty() {
        conn.execute(
            "DELETE FROM gmail_search_cache WHERE account_id=?1 AND conversation_id=?2",
            params![account_id, conversation_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
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
             reply_context_json, newest_sender_json, attachments_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(account_id, conversation_id) DO UPDATE SET
            subject = excluded.subject,
            context_complete = excluded.context_complete,
            unsupported_reason = excluded.unsupported_reason,
            reply_context_json = excluded.reply_context_json,
            newest_sender_json = excluded.newest_sender_json,
            attachments_json = excluded.attachments_json",
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
            thread
                .newest_sender
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|_| MailError::StorageUnavailable)?,
            serde_json::to_string(&thread.attachments)
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
                 to_json, sent_at, body_text, in_inbox, has_attachment)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
                message.has_attachment.map(|present| present as i64),
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
            "INSERT INTO gmail_message_facts (account_id, conversation_id, message_id, in_inbox, is_unread, in_trash, in_spam)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![account_id, conversation_id, message_id, inbox, unread,
                thread.trash_message_ids.as_ref().map(|ids| ids.contains(message_id) as i64),
                thread.spam_message_ids.as_ref().map(|ids| ids.contains(message_id) as i64)],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        conn.execute("UPDATE gmail_message_facts SET is_starred = ?4 WHERE account_id = ?1 AND conversation_id = ?2 AND message_id = ?3",
            params![account_id, conversation_id, message_id, thread.star_facts.as_ref().and_then(|facts| facts.get(message_id).copied()).map(i64::from)])
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
/// Recovery snapshots retain the whole observed inventory/label facts, not just
/// immutable operation targets: later arrivals must survive body eviction too.
/// Conversations without recovery context still lose their non-target facts.
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
         WHERE c.account_id = ?1 AND NOT EXISTS (SELECT 1 FROM gmail_reminders r WHERE r.account_id=c.account_id AND r.conversation_id=c.conversation_id AND json_extract(r.data,'$.phase')='pending')
           AND NOT EXISTS (SELECT 1 FROM gmail_search_cache sc WHERE sc.account_id=c.account_id AND sc.conversation_id=c.conversation_id)
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
                 SELECT 1 FROM gmail_operation_snapshots s
                 WHERE s.account_id = gmail_message_facts.account_id
                   AND s.conversation_id = gmail_message_facts.conversation_id)
               AND NOT EXISTS (
                 SELECT 1 FROM gmail_operation_targets t
                 WHERE t.account_id = gmail_message_facts.account_id
                   AND t.conversation_id = gmail_message_facts.conversation_id
                   AND t.message_id = gmail_message_facts.message_id)
               AND NOT EXISTS (
                 SELECT 1 FROM gmail_operation_snapshots s
                 WHERE s.account_id = gmail_message_facts.account_id
                   AND s.conversation_id = gmail_message_facts.conversation_id)",
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
    newest_sender: Option<Address>,
}

fn build_conversation(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<Option<BuiltConversation>, MailError> {
    let row = conn
        .query_row(
            "SELECT subject, context_complete, unsupported_reason, reply_context_json, newest_sender_json
             FROM gmail_conversations WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some((subject, context_flag, unsupported_reason, reply_context_json, newest_sender_json)) =
        row
    else {
        return Ok(None);
    };
    let mut stmt = conn
        .prepare(
            "SELECT message_id, from_display, from_mailbox, to_json, sent_at, body_text, in_inbox,
                    has_attachment
             FROM gmail_messages
             WHERE account_id = ?1 AND conversation_id = ?2
             ORDER BY sent_at ASC, message_id ASC",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    let messages: Vec<(Message, bool)> = stmt
        .query_map(params![account_id, conversation_id], |row| {
            let from_display: Option<String> = row.get(1)?;
            let to_json: String = row.get(3)?;
            // NULL (legacy cache rows) stays unknown; 0/1 are observed facts.
            let has_attachment = row.get::<_, Option<i64>>(7)?.map(|value| value != 0);
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
                    has_attachment,
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
        newest_sender: newest_sender_json
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(|_| MailError::StorageUnavailable)?,
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
#[path = "newest_sender_tests.rs"]
mod newest_sender_tests;

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
