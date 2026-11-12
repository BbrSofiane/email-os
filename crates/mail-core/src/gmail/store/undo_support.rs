use super::*;

pub(super) fn validate_request_id(request_id: &str) -> Result<(), MailError> {
    if request_id.trim().is_empty() || request_id.len() > 200 {
        return Err(MailError::InvalidRequest {
            field: "requestId".to_string(),
        });
    }
    Ok(())
}

pub(super) fn existing_receipt(
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
pub(super) fn existing_undo_receipt(
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

pub(super) fn compensating_ids(
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
pub(super) struct UndoTarget {
    pub(super) operation_id: String,
    pub(super) conversation_id: String,
    pub(super) kind: MailboxOperationKind,
    pub(super) status: OperationStatus,
    pub(super) undo_of: Option<String>,
    pub(super) accepted_at: String,
    /// Top-level action identity (docs/ux-05-safe-bulk-processing.md §5):
    /// standalone setters/retries carry their own operation id, group
    /// children carry their group id, compensations none.
    pub(super) action_id: Option<String>,
}

pub(super) fn load_undo_target(
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
pub(super) fn check_undoable(
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

pub(super) fn undo_unavailable(reason: UndoUnavailableReason) -> MailError {
    MailError::UndoUnavailable { reason }
}

/// True when any target lacks a known (non-NULL) preimage row.
pub(super) fn has_unknown_prior_value(
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
pub(super) fn compensate_tx(
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
