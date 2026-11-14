use super::*;

pub(super) fn accept_operation_tx(
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
pub(super) fn capture_preimages(
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

pub(super) fn kind_name(kind: MailboxOperationKind) -> &'static str {
    match kind {
        MailboxOperationKind::Archive => "archive",
        MailboxOperationKind::Read => "read",
        MailboxOperationKind::Star => "star",
    }
}

pub(super) fn parse_kind(kind: &str) -> Result<MailboxOperationKind, MailError> {
    match kind {
        "archive" => Ok(MailboxOperationKind::Archive),
        "read" => Ok(MailboxOperationKind::Read),
        "star" => Ok(MailboxOperationKind::Star),
        _ => Err(MailError::StorageUnavailable),
    }
}

pub(super) fn status_name(status: OperationStatus) -> &'static str {
    match status {
        OperationStatus::Queued => "queued",
        OperationStatus::Applying => "applying",
        OperationStatus::Confirmed => "confirmed",
        OperationStatus::Failed => "failed",
        OperationStatus::OutcomeUnknown => "outcome_unknown",
        OperationStatus::Cancelled => "cancelled",
    }
}

pub(super) fn parse_status(status: &str) -> Result<OperationStatus, MailError> {
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

pub(super) fn load_operation(
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
