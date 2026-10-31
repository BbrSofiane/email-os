//! Concrete SQLite store for the fixture slice. Not a generic repository
//! framework: one schema, explicit queries, short serialized transactions.
//! Every persistence error maps to [`MailError::StorageUnavailable`] and is
//! surfaced; nothing is logged-and-ignored. No subjects, addresses, or bodies
//! are ever logged.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::clock::Clock;
use crate::drafts::types::ReplyContext;
use crate::dto::{
    Address, Conversation, ConversationRef, ConversationSummary, InboxSnapshot,
    MailboxOperationKind, Message, OperationFailure, OperationReceipt, OperationStatus,
    OperationSummary, SetArchived, UndoOperation, UndoOutcome, UndoReceipt, UndoUnavailableReason,
};
use crate::error::MailError;
use crate::groups::{
    GetOperationGroupRequest, GroupMemberRejection, GroupMemberStatus, GroupMemberStatusView,
    GroupMemberUndoDecision, GroupMemberUndoResult, GroupUndoAvailability, GroupUndoReceipt,
    ListOperationGroupsRequest, OperationGroupPage, OperationGroupReceipt, OperationGroupStatus,
    OperationGroupSummary, SetArchivedGroup, UndoOperationGroup,
};
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
    undo_of: Option<String>,
    accepted_at: String,
    action_id: Option<String>,
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
                    CHECK (status IN ('queued', 'applying', 'confirmed', 'failed', 'cancelled')),
                failure_kind       TEXT,
                accepted_at        TEXT NOT NULL,
                confirmed_at       TEXT,
                message_ids        TEXT NOT NULL,
                request_id         TEXT NOT NULL,
                undo_of            TEXT,
                prior_values       TEXT,
                action_id          TEXT,
                retry_of           TEXT
            );
            CREATE TABLE IF NOT EXISTS request_keys (
                account_id      TEXT NOT NULL,
                request_id      TEXT NOT NULL,
                operation_id    TEXT NOT NULL,
                fingerprint     TEXT NOT NULL,
                accepted_at     TEXT NOT NULL,
                PRIMARY KEY (account_id, request_id)
            );
            CREATE TABLE IF NOT EXISTS operation_groups (
                group_id      TEXT PRIMARY KEY,
                account_id    TEXT NOT NULL,
                request_id    TEXT NOT NULL,
                kind          TEXT NOT NULL CHECK (kind IN ('archive', 'read')),
                requested_value INTEGER NOT NULL CHECK (requested_value IN (0, 1)),
                accepted_at   TEXT NOT NULL,
                undone_at     TEXT,
                group_seq     INTEGER NOT NULL,
                UNIQUE (account_id, request_id)
            );
            CREATE TABLE IF NOT EXISTS operation_group_members (
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
        let schema_version: Option<String> = tx
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| MailError::StorageUnavailable)?;
        match schema_version {
            Some(version) if version == "3" => {}
            Some(version) if version == "2" || version == "1" => {
                if version == "1" {
                    // UX-04 migration (docs/ux-04-trustworthy-undo.md §3.5): admit
                    // 'cancelled' and add the undo columns. Copy-rebuild in one
                    // transaction, preserving every row, its seq order and the
                    // request keys. Older versions still fail closed.
                    tx.execute_batch(
                        "ALTER TABLE operations RENAME TO operations_v1;
                         CREATE TABLE operations (
                             seq                INTEGER PRIMARY KEY AUTOINCREMENT,
                             operation_id       TEXT NOT NULL UNIQUE,
                             account_id         TEXT NOT NULL,
                             conversation_id    TEXT NOT NULL,
                             requested_archived INTEGER NOT NULL CHECK (requested_archived IN (0, 1)),
                             status             TEXT NOT NULL
                                 CHECK (status IN ('queued', 'applying', 'confirmed', 'failed', 'cancelled')),
                             failure_kind       TEXT,
                             accepted_at        TEXT NOT NULL,
                             confirmed_at       TEXT,
                             message_ids        TEXT NOT NULL,
                             request_id         TEXT NOT NULL,
                             undo_of            TEXT,
                             prior_values       TEXT,
                             action_id          TEXT,
                             retry_of           TEXT
                         );
                         INSERT INTO operations
                             (seq, operation_id, account_id, conversation_id, requested_archived,
                              status, failure_kind, accepted_at, confirmed_at, message_ids,
                              request_id, undo_of, prior_values)
                         SELECT seq, operation_id, account_id, conversation_id, requested_archived,
                                status, failure_kind, accepted_at, confirmed_at, message_ids,
                                request_id, NULL, NULL FROM operations_v1;
                         DROP TABLE operations_v1;",
                    )
                    .map_err(|_| MailError::StorageUnavailable)?;
                }
                // UX-05 migration (docs/ux-05-safe-bulk-processing.md §4.2):
                // group tables are created by the idempotent batch above; the
                // operation rows gain their top-level action-order identity.
                // Backfill: standalone setters are their own action;
                // compensations belong to none. Existing operations, requests,
                // preimages and undo links are preserved untouched.
                let has_action_id_column = has_column(&tx, "operations", "action_id")?;
                if !has_action_id_column {
                    tx.execute("ALTER TABLE operations ADD COLUMN action_id TEXT", [])
                        .map_err(|_| MailError::StorageUnavailable)?;
                }
                let has_retry_of_column = has_column(&tx, "operations", "retry_of")?;
                if !has_retry_of_column {
                    tx.execute("ALTER TABLE operations ADD COLUMN retry_of TEXT", [])
                        .map_err(|_| MailError::StorageUnavailable)?;
                }
                tx.execute(
                    "UPDATE operations SET action_id = operation_id
                     WHERE undo_of IS NULL AND action_id IS NULL",
                    [],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
                tx.execute(
                    "INSERT INTO meta (key, value) VALUES ('schema_version', '3')
                     ON CONFLICT(key) DO UPDATE SET value = '3'",
                    [],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
            }
            Some(_) => return Err(MailError::StorageUnavailable),
            None => {
                tx.execute(
                    "INSERT INTO meta (key, value) VALUES ('schema_version', '3')",
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
        // Preimage capture (docs/ux-04-trustworthy-undo.md §3.1): the effective
        // per-message INBOX state at acceptance, in the same transaction, in
        // the operation's own value domain (prior archived = !in_inbox).
        let view = build_conversation_view(
            &tx,
            &command.conversation.account_id,
            &command.conversation.conversation_id,
        )?;
        let prior_values: BTreeMap<&str, bool> = message_ids
            .iter()
            .map(|message_id| {
                let in_inbox = view
                    .effective_inbox
                    .get(message_id)
                    .copied()
                    .ok_or(MailError::StorageUnavailable)?;
                Ok((message_id.as_str(), !in_inbox))
            })
            .collect::<Result<BTreeMap<&str, bool>, MailError>>()?;
        let prior_values_json =
            serde_json::to_string(&prior_values).map_err(|_| MailError::StorageUnavailable)?;
        let message_ids_json =
            serde_json::to_string(&message_ids).map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "INSERT INTO operations
                (operation_id, account_id, conversation_id, requested_archived, status,
                 failure_kind, accepted_at, confirmed_at, message_ids, request_id,
                 undo_of, prior_values, action_id)
             VALUES (?1, ?2, ?3, ?4, 'queued', NULL, ?5, NULL, ?6, ?7, NULL, ?8, ?9)",
            params![
                operation_id,
                command.conversation.account_id,
                command.conversation.conversation_id,
                command.archived as i64,
                accepted_at,
                message_ids_json,
                command.request_id,
                prior_values_json,
                operation_id,
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

    /// Undo of the single latest accepted non-compensating operation for the
    /// fixture archive setter (docs/ux-04-trustworthy-undo.md §3.2/§3.3).
    /// Idempotent under `requestId` through the existing request dedup.
    pub(crate) fn undo_operation(&self, command: &UndoOperation) -> Result<UndoReceipt, MailError> {
        if command.request_id.trim().is_empty() {
            return Err(MailError::InvalidRequest {
                field: "requestId".to_string(),
            });
        }
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let fingerprint = format!("undo_operation|v1|operation={}", command.operation_id);
        let existing = tx
            .query_row(
                "SELECT operation_id, fingerprint, accepted_at FROM request_keys
                 WHERE account_id = ?1 AND request_id = ?2",
                params![ACCOUNT_ID, command.request_id],
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
                let receipt = reconstruct_undo_receipt(&tx, &operation_id, accepted_at)?;
                tx.commit().map_err(|_| MailError::StorageUnavailable)?;
                return Ok(receipt);
            }
            return Err(MailError::RequestIdConflict);
        }

        let target = load_undo_target(&tx, &command.operation_id)?.ok_or(MailError::NotFound)?;
        check_undoable(&tx, &target, &self.clock.now_iso())?;
        let accepted_at = self.clock.now_iso();
        let receipt = if target.status == OperationStatus::Queued {
            // Cancel in place. The zero-rows branch is defensive only: the
            // status was read in this same transaction, which runs under the
            // connection mutex the worker's claim also needs, so the worker
            // cannot claim concurrently; fall through to compensation anyway.
            let cancelled = tx
                .execute(
                    "UPDATE operations SET status = 'cancelled', failure_kind = NULL
                     WHERE operation_id = ?1 AND status = 'queued'",
                    params![target.operation_id],
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
                compensate_fixture_tx(&tx, &target, &accepted_at)?
            }
        } else {
            compensate_fixture_tx(&tx, &target, &accepted_at)?
        };
        tx.execute(
            "INSERT INTO request_keys
                (account_id, request_id, operation_id, fingerprint, accepted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                ACCOUNT_ID,
                command.request_id,
                target.operation_id,
                fingerprint,
                accepted_at,
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(receipt)
    }

    /// Accepts a bounded archive/unarchive group atomically
    /// (docs/ux-05-safe-bulk-processing.md §4.1): structural validation,
    /// canonical fingerprint idempotency, per-member savepointed child
    /// acceptance with persisted rejections, one commit. The fixture store
    /// covers archive groups; read groups are Gmail-only like the single
    /// setter.
    pub(crate) fn set_archived_group(
        &self,
        command: &SetArchivedGroup,
    ) -> Result<OperationGroupReceipt, MailError> {
        crate::groups::validate_group_request_id(&command.request_id)?;
        crate::groups::validate_group_members(&command.account_id, &command.members)?;
        if command.account_id != ACCOUNT_ID {
            return Err(MailError::NotFound);
        }
        let fingerprint = format!(
            "set_archived_group|v1|account={}|archived={}|members={:?}",
            command.account_id,
            command.archived,
            crate::groups::canonical_member_ids(&command.members)
        );
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let mut tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;

        // Same request/payload returns the original receipt — including the
        // original persisted member ordering (§4.1 step 1).
        if let Some(receipt) =
            existing_group_receipt(&tx, ACCOUNT_ID, &command.request_id, &fingerprint)?
        {
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(receipt);
        }

        let accepted_at = self.clock.now_iso();
        let group_id = format!("group-{}", uuid::Uuid::new_v4());
        let mut member_rows = Vec::with_capacity(command.members.len());
        for (ordinal, member) in command.members.iter().enumerate() {
            let child_request_id = format!("{group_id}-{ordinal}");
            // Member savepoint (§4.1 step 3): a rejected member rolls back to
            // a clean slate and keeps its typed rejection; valid siblings are
            // unaffected; storage errors still abort the whole acceptance.
            let mut savepoint = tx.savepoint().map_err(|_| MailError::StorageUnavailable)?;
            let outcome = accept_fixture_operation_tx(
                &savepoint,
                ACCOUNT_ID,
                &member.conversation_id,
                command.archived,
                &child_request_id,
                &accepted_at,
                Some(&group_id),
            );
            match outcome {
                Ok(operation_id) => {
                    savepoint
                        .commit()
                        .map_err(|_| MailError::StorageUnavailable)?;
                    member_rows.push(GroupMemberInsert {
                        ordinal,
                        conversation_id: member.conversation_id.clone(),
                        operation_id: Some(operation_id),
                        rejection: None,
                    });
                }
                Err(MailError::NotFound) => {
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

        let group_seq: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(group_seq), 0) + 1 FROM operation_groups WHERE account_id = ?1",
                params![ACCOUNT_ID],
                |row| row.get(0),
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "INSERT INTO operation_groups
                (group_id, account_id, request_id, kind, requested_value, accepted_at,
                 undone_at, group_seq)
             VALUES (?1, ?2, ?3, 'archive', ?4, ?5, NULL, ?6)",
            params![
                group_id,
                command.account_id,
                command.request_id,
                command.archived as i64,
                accepted_at,
                group_seq,
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        for member in &member_rows {
            insert_group_member_row(&tx, ACCOUNT_ID, &group_id, member)?;
        }
        // Group acceptance reuses the shared request-key table: `operation_id`
        // carries the group id for group fingerprints, so a request id already
        // used by a setter/undo/group command can never be silently reused by
        // another command kind (fingerprint mismatch → request_id_conflict).
        tx.execute(
            "INSERT INTO request_keys
                (account_id, request_id, operation_id, fingerprint, accepted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                ACCOUNT_ID,
                command.request_id,
                group_id,
                fingerprint,
                accepted_at
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(group_receipt(
            &group_id,
            &command.request_id,
            ACCOUNT_ID,
            MailboxOperationKind::Archive,
            Some(command.archived),
            &accepted_at,
            &member_rows,
        ))
    }

    /// Active-account lookup by original acceptance request ID
    /// (docs/ux-05-safe-bulk-processing.md §4.2): resolves a lost acceptance
    /// response; `Ok(None)` means nothing has committed for that request.
    pub(crate) fn get_operation_group(
        &self,
        request: &GetOperationGroupRequest,
    ) -> Result<Option<OperationGroupStatus>, MailError> {
        crate::groups::validate_group_request_id(&request.request_id)?;
        if request.account_id != ACCOUNT_ID {
            return Err(MailError::NotFound);
        }
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let group_id: Option<String> = conn
            .query_row(
                "SELECT operation_id FROM request_keys
                 WHERE account_id = ?1 AND request_id = ?2 AND fingerprint LIKE 'set_archived_group|v1|%'",
                params![ACCOUNT_ID, request.request_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| MailError::StorageUnavailable)?;
        let Some(group_id) = group_id else {
            return Ok(None);
        };
        load_group_status(&conn, ACCOUNT_ID, &group_id, self.clock.now_iso()).map(Some)
    }

    /// Bounded recent group summaries with cursor, independent of Inbox/Done
    /// rows (docs/ux-05-safe-bulk-processing.md §4.2).
    pub(crate) fn list_operation_groups(
        &self,
        request: &ListOperationGroupsRequest,
    ) -> Result<OperationGroupPage, MailError> {
        if request.account_id != ACCOUNT_ID {
            return Err(MailError::NotFound);
        }
        crate::groups::validate_group_page_limit(request.limit)?;
        let before_seq = request
            .cursor
            .as_deref()
            .map(|cursor| crate::groups::decode_group_cursor(ACCOUNT_ID, cursor))
            .transpose()?;
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT group_id, request_id, kind, requested_value, accepted_at, undone_at,
                        group_seq
                 FROM operation_groups WHERE account_id = ?1
                   AND (?2 IS NULL OR group_seq < ?2)
                 ORDER BY group_seq DESC LIMIT ?3",
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        let mut rows = stmt
            .query_map(
                params![ACCOUNT_ID, before_seq, request.limit as i64 + 1,],
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
        for (group_id, request_id, kind, value, accepted_at, undone_at, group_seq) in rows {
            let kind = parse_group_kind(&kind)?;
            let members = load_group_member_refs(&conn, ACCOUNT_ID, &group_id)?;
            summaries.push(OperationGroupSummary {
                group_id,
                request_id,
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
            .then(|| last_seq.map(|seq| crate::groups::encode_group_cursor(ACCOUNT_ID, seq)))
            .flatten();
        Ok(OperationGroupPage {
            groups: summaries,
            next_cursor,
        })
    }

    /// One partial group Undo attempt (docs/ux-05-safe-bulk-processing.md §5):
    /// whole-group eligibility, per-member cancel/compensate/skip decisions,
    /// all persisted in one transaction; idempotent under `requestId`.
    pub(crate) fn undo_operation_group(
        &self,
        command: &UndoOperationGroup,
    ) -> Result<GroupUndoReceipt, MailError> {
        crate::groups::validate_group_request_id(&command.request_id)?;
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let fingerprint = format!("undo_operation_group|v1|group={}", command.group_id);
        if let Some(existing) = tx
            .query_row(
                "SELECT operation_id, fingerprint, accepted_at FROM request_keys
                 WHERE account_id = ?1 AND request_id = ?2",
                params![ACCOUNT_ID, command.request_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| MailError::StorageUnavailable)?
        {
            let (group_id, stored_fingerprint, accepted_at) = existing;
            if stored_fingerprint == fingerprint {
                let receipt = reconstruct_group_undo_receipt(
                    &tx,
                    ACCOUNT_ID,
                    &group_id,
                    &command.request_id,
                    &accepted_at,
                )?;
                tx.commit().map_err(|_| MailError::StorageUnavailable)?;
                return Ok(receipt);
            }
            return Err(MailError::RequestIdConflict);
        }

        let header =
            load_group_header(&tx, ACCOUNT_ID, &command.group_id)?.ok_or(MailError::NotFound)?;
        let members = load_group_undo_rows(&tx, ACCOUNT_ID, &command.group_id)?;
        let now = self.clock.now_iso();
        check_group_undoable(&tx, ACCOUNT_ID, &header, &members, &now)?;

        let accepted_at = self.clock.now_iso();
        let mut results = Vec::with_capacity(members.len());
        for member in &members {
            let (decision, operation_ids) = decide_member_undo(&tx, member, &accepted_at)?;
            tx.execute(
                "UPDATE operation_group_members
                 SET undo_decision = ?4, undo_skip_reason = ?5, undo_operation_ids = ?6
                 WHERE account_id = ?1 AND group_id = ?2 AND ordinal = ?3",
                params![
                    ACCOUNT_ID,
                    command.group_id,
                    member.ordinal,
                    decision_name(&decision),
                    decision_skip_reason(&decision).map(crate::groups::skip_reason_name),
                    serde_json::to_string(&operation_ids)
                        .map_err(|_| MailError::StorageUnavailable)?,
                ],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
            results.push(GroupMemberUndoResult {
                ordinal: member.ordinal as u32,
                conversation: ConversationRef {
                    account_id: ACCOUNT_ID.to_string(),
                    conversation_id: member.conversation_id.clone(),
                },
                decision,
                operation_ids,
            });
        }
        tx.execute(
            "UPDATE operation_groups SET undone_at = ?3
             WHERE account_id = ?1 AND group_id = ?2",
            params![ACCOUNT_ID, command.group_id, accepted_at],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "INSERT INTO request_keys
                (account_id, request_id, operation_id, fingerprint, accepted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                ACCOUNT_ID,
                command.request_id,
                command.group_id,
                fingerprint,
                accepted_at
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(GroupUndoReceipt {
            group_id: command.group_id.clone(),
            request_id: command.request_id.clone(),
            accepted_at,
            members: results,
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
                    primary_correspondent: built.messages.last().map(|m| m.from.clone()),
                    is_read: None,
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

    pub(crate) fn list_cached_done(
        &self,
        request: &crate::dto::CachedDoneRequest,
    ) -> Result<crate::dto::CachedDoneSnapshot, MailError> {
        let position = crate::cached_done::validate(request, ACCOUNT_ID)?;
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare(
                "WITH candidates AS (
                SELECT c.conversation_id, COALESCE(MAX(m.sent_at), '') AS date
                FROM conversations c LEFT JOIN messages m
                ON m.account_id = c.account_id AND m.conversation_id = c.conversation_id
                WHERE c.account_id = ?1 AND EXISTS (
                    SELECT 1 FROM operations o WHERE o.account_id = c.account_id
                    AND o.conversation_id = c.conversation_id AND o.requested_archived = 1
                    AND o.status IN ('queued', 'applying', 'confirmed')
                    AND NOT EXISTS (
                        SELECT 1 FROM operations u
                        WHERE u.account_id = o.account_id AND u.undo_of = o.operation_id
                        AND u.status IN ('queued', 'applying', 'confirmed')))
                GROUP BY c.conversation_id)
             SELECT date, conversation_id FROM candidates
             WHERE ?2 IS NULL OR date < ?2 OR (date = ?2 AND conversation_id > ?3)
             ORDER BY date DESC, conversation_id ASC LIMIT ?4",
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        let candidates = stmt
            .query_map(
                params![
                    ACCOUNT_ID,
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
            let built = build_conversation_view(&conn, ACCOUNT_ID, id)?;
            if built.is_in_inbox || built.messages.is_empty() {
                continue;
            }
            summaries.push(ConversationSummary {
                conversation_ref: built.conversation_ref,
                subject: built.subject,
                participants: participants_of(&built.messages),
                primary_correspondent: built.messages.last().map(|m| m.from.clone()),
                is_read: None,
                preview: preview_of(&built.messages),
                last_message_at: built
                    .messages
                    .last()
                    .map(|m| m.sent_at.clone())
                    .unwrap_or_default(),
                pending_operation_id: built.pending_operation_id,
            });
        }
        Ok(crate::cached_done::finish(
            request,
            &candidates,
            summaries,
            None,
        ))
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
        let reply_context = fixture_reply_context(&built.conversation_ref, &built.messages);
        Ok(Conversation {
            conversation_ref: built.conversation_ref,
            subject: built.subject,
            is_in_inbox: built.is_in_inbox,
            is_read: None,
            messages: built.messages,
            pending_operation_id: built.pending_operation_id,
            context_complete: Some(true),
            unsupported_reason: None,
            retained_snapshot_at: None,
            reply_context,
        })
    }

    fn activity_rows(&self, conn: &Connection) -> Result<Vec<OperationSummary>, MailError> {
        // Shared eligibility facts (§3.2 rules 4–5 plus UX-05 action ordering),
        // computed once per load on the same injected clock as the undo
        // command path.
        let newest_action = latest_action_id(conn, ACCOUNT_ID)?;
        let now = self.clock.now_iso();
        let mut stmt = conn
            .prepare(
                "SELECT operation_id, account_id, conversation_id, requested_archived,
                        status, failure_kind, undo_of, accepted_at, action_id
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
                    undo_of: row.get(6)?,
                    accepted_at: row.get(7)?,
                    action_id: row.get(8)?,
                })
            })
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
        rows.into_iter()
            .map(|row| {
                let undoable_until = if row.undo_of.is_none()
                    && row.action_id.as_deref() == Some(row.operation_id.as_str())
                    && matches!(
                        row.status,
                        OperationStatus::Queued
                            | OperationStatus::Applying
                            | OperationStatus::Confirmed
                    )
                    && newest_action.as_deref() == Some(row.operation_id.as_str())
                    && !undo_rows_exist(conn, &row.operation_id)?
                    && prior_values_present(conn, &row.operation_id)?
                    && crate::clock::within_undo_window(&row.accepted_at, &now)
                {
                    crate::clock::undo_deadline_iso(&row.accepted_at)
                } else {
                    None
                };
                Ok(OperationSummary {
                    id: row.operation_id,
                    conversation: ConversationRef {
                        account_id: row.account_id,
                        conversation_id: row.conversation_id,
                    },
                    requested_archived: row.requested_archived,
                    status: row.status,
                    failure: row.failure,
                    kind: None,
                    requested_read: None,
                    last_error: None,
                    undo_of: row.undo_of,
                    group_id: None,
                    undoable_until,
                })
            })
            .collect::<Result<Vec<_>, MailError>>()
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

fn snapshot_message_ids(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<Vec<String>, MailError> {
    let mut stmt = conn
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

/// The persisted facts about a fixture operation needed to decide Undo.
struct UndoTarget {
    operation_id: String,
    conversation_id: String,
    status: OperationStatus,
    undo_of: Option<String>,
    accepted_at: String,
    prior_values: Option<String>,
    /// Top-level action identity (docs/ux-05-safe-bulk-processing.md §5):
    /// standalone setters/retries carry their own operation id, group children
    /// carry their group id, compensations none.
    action_id: Option<String>,
}

fn load_undo_target(
    conn: &Connection,
    operation_id: &str,
) -> Result<Option<UndoTarget>, MailError> {
    let row = conn
        .query_row(
            "SELECT conversation_id, requested_archived, status, undo_of, accepted_at,
                    prior_values, action_id
             FROM operations WHERE account_id = ?1 AND operation_id = ?2",
            params![ACCOUNT_ID, operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some((conversation_id, status, undo_of, accepted_at, prior_values, action_id)) = row else {
        return Ok(None);
    };
    Ok(Some(UndoTarget {
        operation_id: operation_id.to_string(),
        conversation_id,
        status: status_from_str(&status),
        undo_of,
        accepted_at,
        prior_values,
        action_id,
    }))
}

/// Applies eligibility rules §3.2 in order; the first failure returns its
/// typed reason. Fixture facts are never unknown, but pre-UX-04 rows have no
/// persisted preimage and fail closed as `unknown_prior`.
fn check_undoable(tx: &Transaction<'_>, target: &UndoTarget, now: &str) -> Result<(), MailError> {
    if target.undo_of.is_some() {
        return Err(undo_unavailable(UndoUnavailableReason::NotApplicable));
    }
    // UX-05 (§5): a group member is undone by the group's one attempt, never
    // individually — no last-child escape around group eligibility.
    if target.action_id.as_deref() != Some(target.operation_id.as_str()) {
        return Err(undo_unavailable(UndoUnavailableReason::NotApplicable));
    }
    if !crate::clock::within_undo_window(&target.accepted_at, now) {
        return Err(undo_unavailable(UndoUnavailableReason::Expired));
    }
    // Rule 4: newest top-level user action on the account — a single, a group,
    // or a retry; never a compensation (docs/ux-05-safe-bulk-processing.md §5).
    let newest = latest_action_id(tx, ACCOUNT_ID)?;
    if newest.as_deref() != Some(target.operation_id.as_str()) {
        return Err(undo_unavailable(UndoUnavailableReason::Superseded));
    }
    let undone: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE account_id = ?1 AND undo_of = ?2)",
            params![ACCOUNT_ID, target.operation_id],
            |row| row.get(0),
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    if undone {
        return Err(undo_unavailable(UndoUnavailableReason::AlreadyUndone));
    }
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
    if target.prior_values.is_none() {
        return Err(undo_unavailable(UndoUnavailableReason::UnknownPrior));
    }
    Ok(())
}

fn undo_unavailable(reason: UndoUnavailableReason) -> MailError {
    MailError::UndoUnavailable { reason }
}

/// Stages one queued compensating operation per distinct prior value with
/// explicit targets and `undo_of` set (docs/ux-04-trustworthy-undo.md §3.3).
/// Compensating operations record their own preimage from the effective
/// state at their acceptance.
fn compensate_fixture_tx(
    tx: &Transaction<'_>,
    target: &UndoTarget,
    accepted_at: &str,
) -> Result<UndoReceipt, MailError> {
    let prior_values: BTreeMap<String, bool> = serde_json::from_str(
        target
            .prior_values
            .as_deref()
            .ok_or(MailError::StorageUnavailable)?,
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    let message_ids: Vec<String> = parse_ids(&target_message_ids(tx, target)?)?;
    let mut restore_group = Vec::new();
    let mut reapply_group = Vec::new();
    for message_id in message_ids {
        match prior_values.get(&message_id) {
            Some(false) => restore_group.push(message_id),
            Some(true) => reapply_group.push(message_id),
            None => return Err(undo_unavailable(UndoUnavailableReason::UnknownPrior)),
        }
    }
    // Effective per-message state at compensation acceptance; each
    // compensating operation records it as its own preimage.
    let view = build_conversation_view(tx, ACCOUNT_ID, &target.conversation_id)?;
    let mut operation_ids = Vec::new();
    for (value, ids) in [(false, restore_group), (true, reapply_group)] {
        if ids.is_empty() {
            continue;
        }
        let operation_id = format!("op-{}", uuid::Uuid::new_v4());
        let request_id = format!("undo-{}", uuid::Uuid::new_v4());
        let own_prior: BTreeMap<&str, bool> = ids
            .iter()
            .map(|message_id| {
                let in_inbox = view
                    .effective_inbox
                    .get(message_id)
                    .copied()
                    .ok_or(MailError::StorageUnavailable)?;
                Ok((message_id.as_str(), !in_inbox))
            })
            .collect::<Result<BTreeMap<&str, bool>, MailError>>()?;
        tx.execute(
            "INSERT INTO operations
                (operation_id, account_id, conversation_id, requested_archived, status,
                 failure_kind, accepted_at, confirmed_at, message_ids, request_id,
                 undo_of, prior_values)
             VALUES (?1, ?2, ?3, ?4, 'queued', NULL, ?5, NULL, ?6, ?7, ?8, ?9)",
            params![
                operation_id,
                ACCOUNT_ID,
                target.conversation_id,
                value as i64,
                accepted_at,
                serde_json::to_string(&ids).map_err(|_| MailError::StorageUnavailable)?,
                request_id,
                target.operation_id,
                serde_json::to_string(&own_prior).map_err(|_| MailError::StorageUnavailable)?,
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "INSERT INTO request_keys
                (account_id, request_id, operation_id, fingerprint, accepted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                ACCOUNT_ID,
                request_id,
                operation_id,
                format!(
                    "undo_compensation|v1|undo_of={}|value={}",
                    target.operation_id, value
                ),
                accepted_at,
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        operation_ids.push(operation_id);
    }
    Ok(UndoReceipt {
        undone_operation_id: target.operation_id.clone(),
        outcome: UndoOutcome::Compensating,
        operation_ids,
        accepted_at: accepted_at.to_string(),
    })
}

fn target_message_ids(tx: &Transaction<'_>, target: &UndoTarget) -> Result<String, MailError> {
    tx.query_row(
        "SELECT message_ids FROM operations WHERE account_id = ?1 AND operation_id = ?2",
        params![ACCOUNT_ID, target.operation_id],
        |row| row.get(0),
    )
    .map_err(|_| MailError::StorageUnavailable)
}

/// Rebuilds a committed undo receipt from the durable compensating rows.
fn reconstruct_undo_receipt(
    conn: &Connection,
    undone_operation_id: &str,
    accepted_at: String,
) -> Result<UndoReceipt, MailError> {
    let mut stmt = conn
        .prepare(
            "SELECT operation_id FROM operations
             WHERE account_id = ?1 AND undo_of = ?2 ORDER BY seq",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    let operation_ids = stmt
        .query_map(params![ACCOUNT_ID, undone_operation_id], |row| row.get(0))
        .map_err(|_| MailError::StorageUnavailable)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|_| MailError::StorageUnavailable)?;
    let outcome = if operation_ids.is_empty() {
        UndoOutcome::Cancelled
    } else {
        UndoOutcome::Compensating
    };
    Ok(UndoReceipt {
        undone_operation_id: undone_operation_id.to_string(),
        outcome,
        operation_ids,
        accepted_at,
    })
}

/// Newest top-level user action on the account (docs/ux-05-safe-bulk-processing.md
/// §5): singles and retries are their own action, group children share the
/// group's identity, compensations are none. Transactional row order (`seq`)
/// is the action order; timestamp comparison alone is insufficient.
fn latest_action_id(conn: &Connection, account_id: &str) -> Result<Option<String>, MailError> {
    conn.query_row(
        "SELECT action_id FROM operations
         WHERE account_id = ?1 AND action_id IS NOT NULL
         GROUP BY action_id ORDER BY MAX(seq) DESC LIMIT 1",
        params![account_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|_| MailError::StorageUnavailable)
}

/// Transaction-local child acceptance used by group acceptance (§4.1 step 3):
/// existence check, immutable target snapshot with the existing per-operation
/// target bound, and effective per-message preimage capture in one insert
/// whose savepoint the caller owns. Returns the new operation id.
fn accept_fixture_operation_tx(
    tx: &Connection,
    account_id: &str,
    conversation_id: &str,
    archived: bool,
    request_id: &str,
    accepted_at: &str,
    action_id: Option<&str>,
) -> Result<String, MailError> {
    let exists: bool = tx
        .query_row(
            "SELECT 1 FROM conversations WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?
        .is_some();
    if !exists {
        return Err(MailError::NotFound);
    }
    let message_ids = snapshot_message_ids(tx, account_id, conversation_id)?;
    if message_ids.is_empty() {
        return Err(MailError::NotFound);
    }
    if message_ids.len() > 1000 {
        return Err(MailError::InvalidRequest {
            field: "targets".to_string(),
        });
    }
    let operation_id = format!("op-{}", uuid::Uuid::new_v4());
    let view = build_conversation_view(tx, account_id, conversation_id)?;
    let prior_values: BTreeMap<&str, bool> = message_ids
        .iter()
        .map(|message_id| {
            let in_inbox = view
                .effective_inbox
                .get(message_id)
                .copied()
                .ok_or(MailError::StorageUnavailable)?;
            Ok((message_id.as_str(), !in_inbox))
        })
        .collect::<Result<BTreeMap<&str, bool>, MailError>>()?;
    let prior_values_json =
        serde_json::to_string(&prior_values).map_err(|_| MailError::StorageUnavailable)?;
    let message_ids_json =
        serde_json::to_string(&message_ids).map_err(|_| MailError::StorageUnavailable)?;
    tx.execute(
        "INSERT INTO operations
            (operation_id, account_id, conversation_id, requested_archived, status,
             failure_kind, accepted_at, confirmed_at, message_ids, request_id,
             undo_of, prior_values, action_id)
         VALUES (?1, ?2, ?3, ?4, 'queued', NULL, ?5, NULL, ?6, ?7, NULL, ?8, ?9)",
        params![
            operation_id,
            account_id,
            conversation_id,
            archived as i64,
            accepted_at,
            message_ids_json,
            request_id,
            prior_values_json,
            action_id,
        ],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    Ok(operation_id)
}

struct GroupMemberInsert {
    ordinal: usize,
    conversation_id: String,
    operation_id: Option<String>,
    rejection: Option<GroupMemberRejection>,
}

fn insert_group_member_row(
    tx: &Transaction<'_>,
    account_id: &str,
    group_id: &str,
    member: &GroupMemberInsert,
) -> Result<(), MailError> {
    tx.execute(
        "INSERT INTO operation_group_members
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

/// Idempotent group-command replay: the stored fingerprint must match the
/// canonical one; any other request reuse is a typed conflict.
fn existing_group_receipt(
    conn: &Connection,
    account_id: &str,
    request_id: &str,
    fingerprint: &str,
) -> Result<Option<OperationGroupReceipt>, MailError> {
    let existing = conn
        .query_row(
            "SELECT operation_id, fingerprint, accepted_at FROM request_keys
             WHERE account_id = ?1 AND request_id = ?2",
            params![account_id, request_id],
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
    let Some((group_id, stored_fingerprint, accepted_at)) = existing else {
        return Ok(None);
    };
    if stored_fingerprint != fingerprint {
        return Err(MailError::RequestIdConflict);
    }
    load_group_receipt(conn, account_id, &group_id, &accepted_at).map(Some)
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
             FROM operation_groups WHERE account_id = ?1 AND group_id = ?2",
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
        kind: parse_group_kind(&kind)?,
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
             FROM operation_group_members
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

fn load_group_receipt(
    conn: &Connection,
    account_id: &str,
    group_id: &str,
    accepted_at: &str,
) -> Result<OperationGroupReceipt, MailError> {
    let header =
        load_group_header(conn, account_id, group_id)?.ok_or(MailError::StorageUnavailable)?;
    let members = load_group_undo_rows(conn, account_id, group_id)?;
    Ok(OperationGroupReceipt {
        group_id: header.group_id,
        request_id: header.request_id,
        account_id: account_id.to_string(),
        kind: header.kind,
        requested_archived: (header.kind == MailboxOperationKind::Archive)
            .then_some(header.requested_value),
        requested_read: (header.kind == MailboxOperationKind::Read)
            .then_some(header.requested_value),
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
    })
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

fn parse_group_kind(s: &str) -> Result<MailboxOperationKind, MailError> {
    match s {
        "archive" => Ok(MailboxOperationKind::Archive),
        "read" => Ok(MailboxOperationKind::Read),
        _ => Err(MailError::StorageUnavailable),
    }
}

/// Whole-group eligibility (§5): not already undone, inside the 10 s window
/// from the group's acceptance, and still the newest top-level action.
/// Per-member ineligibility never rejects the attempt; it becomes a persisted
/// skip.
fn check_group_undoable(
    conn: &Connection,
    account_id: &str,
    header: &GroupHeader,
    _members: &[GroupMemberRow],
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

fn member_status_of(status: OperationStatus) -> GroupMemberStatus {
    match status {
        OperationStatus::Queued => GroupMemberStatus::Queued,
        OperationStatus::Applying => GroupMemberStatus::Applying,
        OperationStatus::Confirmed => GroupMemberStatus::Confirmed,
        OperationStatus::Failed => GroupMemberStatus::Failed,
        OperationStatus::OutcomeUnknown => GroupMemberStatus::OutcomeUnknown,
        OperationStatus::Cancelled => GroupMemberStatus::Cancelled,
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
            (GroupMemberStatus::Rejected, None)
        } else {
            let Some(operation_id) = &member.operation_id else {
                return Err(MailError::StorageUnavailable);
            };
            let row = conn
                .query_row(
                    "SELECT status, failure_kind FROM operations
                     WHERE account_id = ?1 AND operation_id = ?2",
                    params![account_id, operation_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()
                .map_err(|_| MailError::StorageUnavailable)?
                .ok_or(MailError::StorageUnavailable)?;
            (
                member_status_of(status_from_str(&row.0)),
                failure_from_str(&row.1),
            )
        };
        views.push(GroupMemberStatusView {
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
    let receipt = load_group_receipt(conn, account_id, group_id, &header.accepted_at)?;
    Ok(OperationGroupStatus {
        group: receipt,
        members: views,
        undo,
    })
}

fn group_undo_availability(
    conn: &Connection,
    account_id: &str,
    header: &GroupHeader,
    members: &[GroupMemberRow],
    now: &str,
) -> Result<GroupUndoAvailability, MailError> {
    if header.undone_at.is_some() {
        return Ok(GroupUndoAvailability {
            available: false,
            reason: Some(UndoUnavailableReason::AlreadyUndone),
            undoable_until: None,
        });
    }
    if !crate::clock::within_undo_window(&header.accepted_at, now) {
        return Ok(GroupUndoAvailability {
            available: false,
            reason: Some(UndoUnavailableReason::Expired),
            undoable_until: None,
        });
    }
    if latest_action_id(conn, account_id)?.as_deref() != Some(header.group_id.as_str()) {
        return Ok(GroupUndoAvailability {
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
        let row = conn
            .query_row(
                "SELECT status FROM operations WHERE account_id = ?1 AND operation_id = ?2",
                params![account_id, operation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| MailError::StorageUnavailable)?;
        let Some(status) = row else {
            continue;
        };
        let live = matches!(
            status_from_str(&status),
            OperationStatus::Queued | OperationStatus::Applying | OperationStatus::Confirmed
        );
        if live
            && !undo_rows_exist(conn, operation_id)?
            && prior_values_present(conn, operation_id)?
        {
            any_eligible = true;
        }
    }
    if !any_eligible {
        return Ok(GroupUndoAvailability {
            available: false,
            reason: Some(UndoUnavailableReason::NotApplicable),
            undoable_until: None,
        });
    }
    Ok(GroupUndoAvailability {
        available: true,
        reason: None,
        undoable_until: crate::clock::undo_deadline_iso(&header.accepted_at),
    })
}

fn decision_name(decision: &GroupMemberUndoDecision) -> &'static str {
    match decision {
        GroupMemberUndoDecision::Cancelled => "cancelled",
        GroupMemberUndoDecision::Compensating => "compensating",
        GroupMemberUndoDecision::Skipped { .. } => "skipped",
    }
}

fn decision_skip_reason(
    decision: &GroupMemberUndoDecision,
) -> Option<crate::groups::GroupUndoSkipReason> {
    match decision {
        GroupMemberUndoDecision::Skipped { reason } => Some(*reason),
        _ => None,
    }
}

/// Per-member group Undo decision (§5): queued → atomic cancel;
/// applying/confirmed → ordered compensation from the original targets and
/// preimages; everything else is an explicit persisted skip.
fn decide_member_undo(
    tx: &Transaction<'_>,
    member: &GroupMemberRow,
    accepted_at: &str,
) -> Result<(GroupMemberUndoDecision, Vec<String>), MailError> {
    if member.rejection.is_some() {
        return Ok((
            GroupMemberUndoDecision::Skipped {
                reason: crate::groups::GroupUndoSkipReason::AcceptanceRejected,
            },
            Vec::new(),
        ));
    }
    let Some(operation_id) = &member.operation_id else {
        return Err(MailError::StorageUnavailable);
    };
    let Some(target) = load_undo_target(tx, operation_id)? else {
        return Err(MailError::StorageUnavailable);
    };
    match target.status {
        OperationStatus::Failed => Ok((
            GroupMemberUndoDecision::Skipped {
                reason: crate::groups::GroupUndoSkipReason::Failed,
            },
            Vec::new(),
        )),
        OperationStatus::OutcomeUnknown => Ok((
            GroupMemberUndoDecision::Skipped {
                reason: crate::groups::GroupUndoSkipReason::OutcomeUnknown,
            },
            Vec::new(),
        )),
        OperationStatus::Cancelled => Ok((
            GroupMemberUndoDecision::Skipped {
                reason: crate::groups::GroupUndoSkipReason::AlreadyUndone,
            },
            Vec::new(),
        )),
        OperationStatus::Queued => {
            let cancelled = tx
                .execute(
                    "UPDATE operations SET status = 'cancelled', failure_kind = NULL
                     WHERE operation_id = ?1 AND status = 'queued'",
                    params![target.operation_id],
                )
                .map_err(|_| MailError::StorageUnavailable)?;
            if cancelled == 1 {
                Ok((GroupMemberUndoDecision::Cancelled, Vec::new()))
            } else {
                // Defensive: the status was read in this same transaction,
                // which runs under the connection mutex the worker's claim
                // also needs.
                member_compensation(tx, &target, accepted_at)
            }
        }
        OperationStatus::Applying | OperationStatus::Confirmed => {
            member_compensation(tx, &target, accepted_at)
        }
    }
}

fn member_compensation(
    tx: &Transaction<'_>,
    target: &UndoTarget,
    accepted_at: &str,
) -> Result<(GroupMemberUndoDecision, Vec<String>), MailError> {
    match compensate_fixture_tx(tx, target, accepted_at) {
        Ok(receipt) => Ok((GroupMemberUndoDecision::Compensating, receipt.operation_ids)),
        Err(MailError::UndoUnavailable {
            reason: UndoUnavailableReason::UnknownPrior,
        }) => Ok((
            GroupMemberUndoDecision::Skipped {
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
) -> Result<GroupUndoReceipt, MailError> {
    let members = load_group_undo_rows(conn, account_id, group_id)?;
    let mut results = Vec::with_capacity(members.len());
    for member in members {
        let decision = match member.undo_decision.as_deref() {
            Some("cancelled") => GroupMemberUndoDecision::Cancelled,
            Some("compensating") => GroupMemberUndoDecision::Compensating,
            Some("skipped") => {
                let reason = member
                    .undo_skip_reason
                    .as_deref()
                    .and_then(crate::groups::skip_reason_from_name)
                    .ok_or(MailError::StorageUnavailable)?;
                GroupMemberUndoDecision::Skipped { reason }
            }
            _ => return Err(MailError::StorageUnavailable),
        };
        let operation_ids = member
            .undo_operation_ids
            .as_deref()
            .map(|json| serde_json::from_str(json).map_err(|_| MailError::StorageUnavailable))
            .transpose()?
            .unwrap_or_default();
        results.push(GroupMemberUndoResult {
            ordinal: member.ordinal as u32,
            conversation: ConversationRef {
                account_id: account_id.to_string(),
                conversation_id: member.conversation_id,
            },
            decision,
            operation_ids,
        });
    }
    Ok(GroupUndoReceipt {
        group_id: group_id.to_string(),
        request_id: request_id.to_string(),
        accepted_at: accepted_at.to_string(),
        members: results,
    })
}

fn status_from_str(s: &str) -> OperationStatus {
    match s {
        "queued" => OperationStatus::Queued,
        "applying" => OperationStatus::Applying,
        "confirmed" => OperationStatus::Confirmed,
        "cancelled" => OperationStatus::Cancelled,
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

/// Rule 5: whether any compensating operation already points at this one.
fn undo_rows_exist(conn: &Connection, operation_id: &str) -> Result<bool, MailError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM operations WHERE account_id = ?1 AND undo_of = ?2)",
        params![ACCOUNT_ID, operation_id],
        |row| row.get(0),
    )
    .map_err(|_| MailError::StorageUnavailable)
}

/// Rule 7: a preimage row must exist for the operation. Fixture facts are
/// never unknown, so presence of the JSON map means every target is known.
fn prior_values_present(conn: &Connection, operation_id: &str) -> Result<bool, MailError> {
    conn.query_row(
        "SELECT prior_values IS NOT NULL FROM operations
         WHERE account_id = ?1 AND operation_id = ?2",
        params![ACCOUNT_ID, operation_id],
        |row| row.get(0),
    )
    .map_err(|_| MailError::StorageUnavailable)
}

struct ConversationView {
    conversation_ref: ConversationRef,
    subject: String,
    messages: Vec<Message>,
    is_in_inbox: bool,
    pending_operation_id: Option<String>,
    /// Effective per-message INBOX membership (cached facts + pending
    /// overlay); the preimage source for undo (§3.1).
    effective_inbox: HashMap<String, bool>,
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
            effective_inbox: HashMap::new(),
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
    let mut effective_inbox = HashMap::<String, bool>::new();
    for (_, archived, ids) in &pending {
        for (message, in_inbox) in &mut messages {
            if ids.contains(&message.id) {
                *in_inbox = !archived;
            }
        }
    }
    for (message, in_inbox) in &messages {
        effective_inbox.insert(message.id.clone(), *in_inbox);
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
        effective_inbox,
    })
}

fn fixture_reply_context(
    conversation: &ConversationRef,
    messages: &[Message],
) -> Option<ReplyContext> {
    let latest = messages.last()?;
    let message_id = fixture_rfc_message_id(&conversation.conversation_id, &latest.id);
    let references = messages[..messages.len().saturating_sub(1)]
        .iter()
        .map(|message| fixture_rfc_message_id(&conversation.conversation_id, &message.id))
        .collect();
    Some(ReplyContext {
        source_message_id: latest.id.clone(),
        from_mailbox: latest.from.mailbox.clone(),
        reply_to_mailboxes: None,
        message_id,
        references,
    })
}

/// Produces deterministic RFC Message-IDs for the synthetic fixture's explicit
/// From, absent Reply-To, Message-ID, and References header facts.
fn fixture_rfc_message_id(conversation_id: &str, message_id: &str) -> String {
    let local = conversation_id
        .chars()
        .chain(std::iter::once('.'))
        .chain(message_id.chars())
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '.' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!("<{local}@fixture.emailos>")
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

    #[test]
    fn fixture_reader_has_safe_synthetic_reply_context_without_reseeding() {
        let dir = temp_dir("fixture-reply-context");
        let store = Store::open(&dir, Arc::new(SystemClock)).expect("store opens");
        let conversation = store
            .get_conversation(&ConversationRef {
                account_id: ACCOUNT_ID.to_string(),
                conversation_id: "conv-01".to_string(),
            })
            .expect("fixture conversation");
        let context = conversation.reply_context.expect("synthetic reply context");
        assert_eq!(context.source_message_id, "m-01-3");
        assert_eq!(context.from_mailbox, "ana@ridpath.example");
        assert_eq!(context.reply_to_mailboxes, None);
        assert_eq!(context.message_id, "<conv-01.m-01-3@fixture.emailos>");
        assert_eq!(
            context.references,
            vec![
                "<conv-01.m-01-1@fixture.emailos>",
                "<conv-01.m-01-2@fixture.emailos>"
            ]
        );
        assert_eq!(conversation.context_complete, Some(true));
        assert!(conversation.messages.iter().any(|message| {
            message
                .to
                .iter()
                .any(|recipient| recipient.mailbox == crate::FIXTURE_MAILBOX)
        }));
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
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

    // -------------------------------------------------- UX-05 group tests

    fn group_member(id: &str) -> ConversationRef {
        ConversationRef {
            account_id: ACCOUNT_ID.to_string(),
            conversation_id: id.to_string(),
        }
    }

    fn group_command(request_id: &str, ids: &[&str], archived: bool) -> SetArchivedGroup {
        SetArchivedGroup {
            account_id: ACCOUNT_ID.to_string(),
            members: ids.iter().map(|id| group_member(id)).collect(),
            archived,
            request_id: request_id.to_string(),
        }
    }

    fn counts(store: &Store) -> (usize, usize) {
        let conn = store.lock_conn().expect("conn");
        let operations: i64 = conn
            .query_row("SELECT COUNT(*) FROM operations", [], |row| row.get(0))
            .unwrap();
        let groups: i64 = conn
            .query_row("SELECT COUNT(*) FROM operation_groups", [], |row| {
                row.get(0)
            })
            .unwrap();
        (operations as usize, groups as usize)
    }

    /// Noncontiguous members are accepted once; the same request (even with
    /// reordered members) replays the identical receipt with the original
    /// persisted member ordering; a changed payload is a typed conflict; a
    /// request id already used by another command kind never crosses over.
    #[test]
    fn group_acceptance_is_idempotent_order_preserving_and_conflict_typed() {
        let dir = temp_dir("group-idempotent");
        let clock: Arc<dyn Clock> = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let store = Store::open(&dir, clock).expect("store opens");
        let receipt = store
            .set_archived_group(&group_command("group-req-1", &["conv-03", "conv-01"], true))
            .expect("group accepted");
        assert_eq!(receipt.members.len(), 2);
        assert_eq!(
            receipt.members[0].conversation.conversation_id, "conv-03",
            "original persisted member ordering"
        );
        assert!(receipt.members.iter().all(|m| m.rejection.is_none()));

        // Reordered replay: same payload identity, original ordering.
        let replay = store
            .set_archived_group(&group_command("group-req-1", &["conv-01", "conv-03"], true))
            .expect("replay");
        assert_eq!(replay, receipt);
        // Changed payload (different value) conflicts.
        assert_eq!(
            store.set_archived_group(&group_command(
                "group-req-1",
                &["conv-01", "conv-03"],
                false
            )),
            Err(MailError::RequestIdConflict)
        );
        // Changed payload (different members) conflicts.
        assert_eq!(
            store.set_archived_group(&group_command("group-req-1", &["conv-01"], true)),
            Err(MailError::RequestIdConflict)
        );
        // The group's request id cannot be reused by a single setter.
        assert_eq!(
            store.set_archived(&SetArchived {
                conversation: group_member("conv-02"),
                archived: true,
                request_id: "group-req-1".into(),
            }),
            Err(MailError::RequestIdConflict)
        );
        assert_eq!(counts(&store), (2, 1), "two children, one group");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Structural invalidity, duplicates, bounds and cross-account targets
    /// reject the whole request before any write (§7.2).
    #[test]
    fn invalid_group_commands_write_nothing() {
        let dir = temp_dir("group-invalid");
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let store = Store::open(&dir, clock).expect("store opens");
        // Empty members.
        assert!(matches!(
            store.set_archived_group(&group_command("bad-empty", &[], true)),
            Err(MailError::InvalidRequest { field }) if field == "members"
        ));
        // Over the approved 100-member bound.
        let oversized: Vec<String> = (0..101)
            .map(|i| format!("conv-{:02}", i % 18 + 1))
            .collect();
        let oversized_refs: Vec<ConversationRef> = oversized
            .iter()
            .map(|id| ConversationRef {
                account_id: ACCOUNT_ID.into(),
                conversation_id: id.clone(),
            })
            .collect();
        assert!(matches!(
            store.set_archived_group(&SetArchivedGroup {
                account_id: ACCOUNT_ID.into(),
                members: oversized_refs,
                archived: true,
                request_id: "bad-bound".into(),
            }),
            Err(MailError::InvalidRequest { field }) if field == "members"
        ));
        // Duplicate members.
        assert!(matches!(
            store.set_archived_group(&group_command("bad-dup", &["conv-01", "conv-01"], true)),
            Err(MailError::InvalidRequest { field }) if field == "members"
        ));
        // Cross-account member.
        let cross_account = SetArchivedGroup {
            account_id: ACCOUNT_ID.into(),
            members: vec![
                group_member("conv-01"),
                ConversationRef {
                    account_id: "other-account".into(),
                    conversation_id: "conv-02".into(),
                },
            ],
            archived: true,
            request_id: "bad-cross".into(),
        };
        assert!(matches!(
            store.set_archived_group(&cross_account),
            Err(MailError::InvalidRequest { field }) if field == "members"
        ));
        // Cross-account command.
        assert_eq!(
            store.set_archived_group(&SetArchivedGroup {
                account_id: "other-account".into(),
                members: vec![ConversationRef {
                    account_id: "other-account".into(),
                    conversation_id: "conv-01".into(),
                }],
                archived: true,
                request_id: "bad-account".into(),
            }),
            Err(MailError::NotFound)
        );
        // Blank request id.
        assert!(matches!(
            store.set_archived_group(&group_command("  ", &["conv-01"], true)),
            Err(MailError::InvalidRequest { field }) if field == "requestId"
        ));
        assert_eq!(counts(&store), (0, 0), "no group or child writes");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A member that is gone gets a persisted rejected acceptance result with
    /// a typed reason while valid siblings are accepted; an all-rejected valid
    /// request has an idempotent durable receipt with zero child operations
    /// and does not consume the account's Undo slot (§7.2).
    #[test]
    fn member_rejection_is_persisted_and_siblings_accepted_without_undo_slot_loss() {
        // All-rejected case: receipt exists, no children, no undo-slot
        // consumption.
        let dir = temp_dir("group-all-rejected");
        let clock: Arc<dyn Clock> = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let store = Store::open(&dir, clock).expect("store opens");
        store
            .set_archived(&SetArchived {
                conversation: group_member("conv-05"),
                archived: true,
                request_id: "single-req-1".into(),
            })
            .expect("single accepted");
        let receipt = store
            .set_archived_group(&group_command("group-req-x", &["missing-conv"], true))
            .expect("all-rejected request still commits a receipt");
        assert_eq!(receipt.members.len(), 1);
        assert_eq!(receipt.members[0].operation_id, None);
        assert_eq!(
            receipt.members[0].rejection,
            Some(GroupMemberRejection::ConversationMissing)
        );
        assert_eq!(
            counts(&store),
            (1, 1),
            "durable receipt, zero child operations"
        );
        let replay = store
            .set_archived_group(&group_command("group-req-x", &["missing-conv"], true))
            .expect("replay");
        assert_eq!(replay, receipt);
        // The prior single remains the newest top-level action and undoable.
        let activity = store.list_snapshot().unwrap().activity;
        let single = activity.iter().find(|row| row.undo_of.is_none()).unwrap();
        assert!(single.undoable_until.is_some(), "undo slot not consumed");
        let _ = std::fs::remove_dir_all(&dir);

        // Mixed case: rejected member persisted next to accepted siblings.
        let dir = temp_dir("group-mixed-rejection");
        let clock: Arc<dyn Clock> = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let store = Store::open(&dir, clock).expect("store opens");
        let receipt = store
            .set_archived_group(&group_command(
                "group-req-mixed",
                &["conv-01", "missing-conv", "conv-03"],
                true,
            ))
            .expect("mixed group accepted");
        assert_eq!(
            receipt.members[1].rejection,
            Some(GroupMemberRejection::ConversationMissing)
        );
        assert!(receipt.members[0].operation_id.is_some());
        assert!(receipt.members[2].operation_id.is_some());
        // The rejected member keeps its ordinal place in the manifest.
        assert_eq!(
            receipt.members[1].conversation.conversation_id,
            "missing-conv"
        );
        let status = store
            .get_operation_group(&GetOperationGroupRequest {
                account_id: ACCOUNT_ID.into(),
                request_id: "group-req-mixed".into(),
            })
            .expect("lookup")
            .expect("committed");
        assert_eq!(status.members[1].status, GroupMemberStatus::Rejected);
        assert_eq!(status.members[0].status, GroupMemberStatus::Queued);
        assert!(status.undo.available);
        assert_eq!(counts(&store), (2, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Injected storage failure at acceptance time rolls back the whole
    /// group: no group header, no child operations, and the same request is
    /// safely retried afterwards (§7.3).
    #[test]
    fn transaction_failure_rolls_back_whole_group_and_retry_is_safe() {
        let dir = temp_dir("group-rollback");
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let store = Store::open(&dir, clock).expect("store opens");
        store.set_test_persistence_failure(true);
        assert_eq!(
            store.set_archived_group(&group_command(
                "group-req-rb",
                &["conv-01", "conv-02"],
                true
            )),
            Err(MailError::StorageUnavailable)
        );
        assert_eq!(counts(&store), (0, 0), "no partial group/children");
        store.set_test_persistence_failure(false);
        let receipt = store
            .set_archived_group(&group_command(
                "group-req-rb",
                &["conv-01", "conv-02"],
                true,
            ))
            .expect("same request retried safely");
        assert_eq!(receipt.members.len(), 2);
        assert_eq!(counts(&store), (2, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Group Undo at 9 seconds (§7.6): queued member cancels in place,
    /// confirmed member compensates from the original targets/preimages,
    /// failed member is skipped with its reason; eligible siblings are never
    /// rolled back by each other; the attempt is one-shot and idempotent.
    #[test]
    fn group_undo_is_partial_typed_and_one_shot() {
        let dir = temp_dir("group-undo");
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let store = Store::open(&dir, clock.clone() as Arc<dyn Clock>).expect("store opens");
        let receipt = store
            .set_archived_group(&group_command(
                "group-req-u",
                &["conv-01", "conv-02", "conv-03"],
                true,
            ))
            .expect("group accepted");
        let ops: Vec<String> = receipt
            .members
            .iter()
            .map(|m| m.operation_id.clone().unwrap())
            .collect();
        // Member 1 confirms, member 2 definitively fails, member 3 stays queued.
        let claimed_a = store.claim_next_queued().unwrap().unwrap();
        assert_eq!(claimed_a.operation_id, ops[0]);
        store.confirm_op(&claimed_a).unwrap();
        let claimed_b = store.claim_next_queued().unwrap().unwrap();
        assert_eq!(claimed_b.operation_id, ops[1]);
        store.fail_op(&ops[1], "provider_unavailable").unwrap();

        clock.advance_seconds(9);
        let undo_receipt = store
            .undo_operation_group(&UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "undo-group-req-1".into(),
            })
            .expect("group undo accepted");
        assert_eq!(undo_receipt.members.len(), 3);
        assert_eq!(
            undo_receipt.members[0].decision,
            GroupMemberUndoDecision::Compensating,
            "confirmed member compensated from original targets"
        );
        assert_eq!(undo_receipt.members[0].operation_ids.len(), 1);
        assert_eq!(
            undo_receipt.members[1].decision,
            GroupMemberUndoDecision::Skipped {
                reason: crate::groups::GroupUndoSkipReason::Failed
            }
        );
        assert_eq!(
            undo_receipt.members[2].decision,
            GroupMemberUndoDecision::Cancelled,
            "queued member cancelled atomically"
        );
        // Member statuses reflect the outcomes; the group is no longer undoable.
        let status = store
            .get_operation_group(&GetOperationGroupRequest {
                account_id: ACCOUNT_ID.into(),
                request_id: "group-req-u".into(),
            })
            .unwrap()
            .unwrap();
        assert_eq!(status.members[0].status, GroupMemberStatus::Confirmed);
        assert_eq!(status.members[1].status, GroupMemberStatus::Failed);
        assert_eq!(status.members[2].status, GroupMemberStatus::Cancelled);
        assert!(!status.undo.available);
        assert_eq!(
            status.undo.reason,
            Some(UndoUnavailableReason::AlreadyUndone)
        );
        // One attempt: same request replays the same decisions; a second,
        // different request is rejected.
        let replay = store
            .undo_operation_group(&UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "undo-group-req-1".into(),
            })
            .expect("replay");
        assert_eq!(replay, undo_receipt);
        assert_eq!(
            store.undo_operation_group(&UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "undo-group-req-2".into(),
            }),
            Err(MailError::UndoUnavailable {
                reason: UndoUnavailableReason::AlreadyUndone
            })
        );
        // Compensation for the confirmed member was queued with the member's
        // own conversation, and the overlay puts its messages back in the inbox.
        let snapshot = store.list_snapshot().unwrap();
        assert!(snapshot
            .conversations
            .iter()
            .any(|c| c.conversation_ref.conversation_id == "conv-01"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Expiry at 10 seconds, supersession by a newer single/group, and the
    /// child single-Undo bypass are all rejected with typed reasons; the
    /// newest top-level action is the only undoable one (§7.7).
    #[test]
    fn group_undo_respects_expiry_supersession_and_no_child_bypass() {
        let dir = temp_dir("group-undo-gates");
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let store = Store::open(&dir, clock.clone() as Arc<dyn Clock>).expect("store opens");
        let receipt = store
            .set_archived_group(&group_command("group-req-g", &["conv-01", "conv-02"], true))
            .expect("group accepted");
        let child = receipt.members[0].operation_id.clone().unwrap();
        let _ = &child;

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
            .set_archived(&SetArchived {
                conversation: group_member("conv-04"),
                archived: true,
                request_id: "single-after-group".into(),
            })
            .expect("single accepted");
        assert_eq!(
            store.undo_operation_group(&UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "undo-after-single".into(),
            }),
            Err(MailError::UndoUnavailable {
                reason: UndoUnavailableReason::Superseded
            })
        );
        // And the newest single remains undoable (latest action, in window).
        let activity = store.list_snapshot().unwrap().activity;
        let single = activity
            .iter()
            .find(|row| row.undo_of.is_none() && row.undoable_until.is_some())
            .expect("newest single stays undoable");
        assert_eq!(single.conversation.conversation_id, "conv-04");

        // A newer group supersedes the older group.
        let older = store
            .set_archived_group(&group_command("group-req-old", &["conv-05"], true))
            .expect("older group");
        let newer = store
            .set_archived_group(&group_command("group-req-new", &["conv-06"], true))
            .expect("newer group");
        assert_eq!(
            store.undo_operation_group(&UndoOperationGroup {
                group_id: older.group_id.clone(),
                request_id: "undo-old".into(),
            }),
            Err(MailError::UndoUnavailable {
                reason: UndoUnavailableReason::Superseded
            })
        );
        assert!(
            store
                .undo_operation_group(&UndoOperationGroup {
                    group_id: newer.group_id.clone(),
                    request_id: "undo-new".into(),
                })
                .is_ok(),
            "the newest group itself is undoable"
        );

        // Expiry: 10 seconds after acceptance the window is over.
        let expired = store
            .set_archived_group(&group_command("group-req-exp", &["conv-07"], true))
            .expect("group accepted");
        clock.advance_seconds(10);
        assert_eq!(
            store.undo_operation_group(&UndoOperationGroup {
                group_id: expired.group_id.clone(),
                request_id: "undo-expired".into(),
            }),
            Err(MailError::UndoUnavailable {
                reason: UndoUnavailableReason::Expired
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Execution and Undo touch only the original immutable message ids: a
    /// reply accepted after the group never joins the compensation (§7.1).
    #[test]
    fn new_reply_after_acceptance_is_untouched_by_group_undo() {
        let dir = temp_dir("group-new-reply");
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let store = Store::open(&dir, clock).expect("store opens");
        let receipt = store
            .set_archived_group(&group_command("group-req-reply", &["conv-01"], true))
            .expect("group accepted");
        let child = receipt.members[0].operation_id.clone().unwrap();
        // The member is dispatched and confirmed before the undo.
        let claimed = store.claim_next_queued().unwrap().unwrap();
        assert_eq!(claimed.operation_id, child);
        store.confirm_op(&claimed).unwrap();
        {
            let conn = store.lock_conn().unwrap();
            conn.execute(
                "INSERT INTO messages (account_id, conversation_id, message_id, from_display,
                    from_mailbox, to_json, sent_at, body_text, provider_inbox)
                 VALUES (?1, ?2, 'm-new-reply', 'New', 'new@example.test', '[]',
                    '2026-01-02T00:00:00Z', 'later reply', 1)",
                params![ACCOUNT_ID, "conv-01"],
            )
            .unwrap();
        }
        // Undo inside the window: compensation targets come from the original
        // acceptance snapshot, never current inventory.
        let undo = store
            .undo_operation_group(&UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "undo-reply".into(),
            })
            .expect("group undo");
        assert_eq!(
            undo.members[0].decision,
            GroupMemberUndoDecision::Compensating
        );
        let compensation = undo.members[0].operation_ids[0].clone();
        let conn = store.lock_conn().unwrap();
        let targets: String = conn
            .query_row(
                "SELECT message_ids FROM operations WHERE operation_id = ?1",
                params![compensation],
                |row| row.get(0),
            )
            .unwrap();
        let targets: Vec<String> = serde_json::from_str(&targets).unwrap();
        assert!(!targets.iter().any(|id| id == "m-new-reply"));
        assert!(!targets.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Group detail/list pagination and account fencing (§7.9): a group
    /// absent from a recent page is still queryable by request identity;
    /// foreign accounts and malformed cursors fail closed.
    #[test]
    fn group_listing_paginates_and_fences_accounts() {
        let dir = temp_dir("group-pages");
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let store = Store::open(&dir, clock).expect("store opens");
        let mut group_ids = Vec::new();
        for i in 0..3 {
            let receipt = store
                .set_archived_group(&group_command(
                    &format!("group-page-{i}"),
                    &["conv-01"],
                    true,
                ))
                .expect("group accepted");
            group_ids.push(receipt.group_id);
        }
        let page = store
            .list_operation_groups(&ListOperationGroupsRequest {
                account_id: ACCOUNT_ID.into(),
                limit: 2,
                cursor: None,
            })
            .expect("page 1");
        assert_eq!(page.groups.len(), 2);
        assert_eq!(page.groups[0].request_id, "group-page-2");
        assert_eq!(page.groups[1].request_id, "group-page-1");
        let cursor = page.next_cursor.expect("continuation");
        // The oldest group is absent from page 1 but still queryable by its
        // original request id.
        assert!(page.groups.iter().all(|g| g.request_id != "group-page-0"));
        let oldest = store
            .get_operation_group(&GetOperationGroupRequest {
                account_id: ACCOUNT_ID.into(),
                request_id: "group-page-0".into(),
            })
            .expect("lookup")
            .expect("group detail stays addressable");
        assert_eq!(oldest.group.group_id, group_ids[0]);
        let page2 = store
            .list_operation_groups(&ListOperationGroupsRequest {
                account_id: ACCOUNT_ID.into(),
                limit: 2,
                cursor: Some(cursor),
            })
            .expect("page 2");
        assert_eq!(page2.groups.len(), 1);
        assert_eq!(page2.groups[0].request_id, "group-page-0");
        assert!(page2.next_cursor.is_none());
        // Account fencing and malformed cursors fail closed.
        assert_eq!(
            store.list_operation_groups(&ListOperationGroupsRequest {
                account_id: "other-account".into(),
                limit: 2,
                cursor: None,
            }),
            Err(MailError::NotFound)
        );
        assert!(matches!(
            store.list_operation_groups(&ListOperationGroupsRequest {
                account_id: ACCOUNT_ID.into(),
                limit: 2,
                cursor: Some("garbage".into()),
            }),
            Err(MailError::InvalidRequest { field }) if field == "cursor"
        ));
        // Lookup on a foreign account fails closed without leaking the group.
        assert_eq!(
            store.get_operation_group(&GetOperationGroupRequest {
                account_id: "other-account".into(),
                request_id: "group-page-0".into(),
            }),
            Err(MailError::NotFound)
        );
        // A not-yet-committed request resolves to None, not an error.
        assert!(store
            .get_operation_group(&GetOperationGroupRequest {
                account_id: ACCOUNT_ID.into(),
                request_id: "never-committed".into(),
            })
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The UX-05 additive migration preserves every operation, request,
    /// preimage and undo link, and backfills the action-order identity.
    #[test]
    fn migration_preserves_operations_requests_preimages_and_undo_links() {
        let dir = temp_dir("group-migration");
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let store = Store::open(&dir, clock.clone() as Arc<dyn Clock>).expect("store opens");
        let single = store
            .set_archived(&SetArchived {
                conversation: group_member("conv-01"),
                archived: true,
                request_id: "mig-single".into(),
            })
            .expect("single accepted");
        drop(store);

        // Simulate a pre-UX-05 profile: stamp the previous schema version.
        {
            let store = Store::open(&dir, clock.clone() as Arc<dyn Clock>).expect("reopen");
            let conn = store.lock_conn().unwrap();
            conn.execute(
                "UPDATE meta SET value = '2' WHERE key = 'schema_version'",
                [],
            )
            .unwrap();
        }
        let store = Store::open(&dir, clock.clone() as Arc<dyn Clock>).expect("upgrade");
        {
            let conn = store.lock_conn().unwrap();
            let version: String = conn
                .query_row(
                    "SELECT value FROM meta WHERE key = 'schema_version'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(version, "3");
            let action_id: Option<String> = conn
                .query_row(
                    "SELECT action_id FROM operations WHERE operation_id = ?1",
                    params![single.operation_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(action_id.as_deref(), Some(single.operation_id.as_str()));
        }
        // Preimage and undo eligibility survive the migration. Confirm the
        // single first so the undo exercises the preimage compensation.
        let claimed = store.claim_next_queued().unwrap().unwrap();
        assert_eq!(claimed.operation_id, single.operation_id);
        store.confirm_op(&claimed).unwrap();
        clock.advance_seconds(1);
        let undo = store
            .undo_operation(&UndoOperation {
                operation_id: single.operation_id.clone(),
                request_id: "mig-undo".into(),
            })
            .expect("historical single still undoable after migration");
        assert_eq!(undo.outcome, UndoOutcome::Compensating);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
