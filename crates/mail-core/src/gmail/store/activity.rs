use super::*;

pub(super) fn star_state(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<crate::stars::StarState, MailError> {
    let effective = effective_conversation_state_with_coverage(conn, account_id, conversation_id)?;
    Ok(crate::stars::StarState::from_facts(
        effective.facts.values().map(|fact| fact.2),
    ))
}

pub(super) fn effective_conversation_state(
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
pub(super) type MessageFacts = (Option<bool>, Option<bool>, Option<bool>);

pub(crate) struct EffectiveState {
    pub(crate) inbox: bool,
    pub(crate) is_read: Option<bool>,
    pub(crate) pending_operation_id: Option<String>,
    pub(crate) coverage_known: bool,
    pub(crate) facts: HashMap<String, MessageFacts>,
}

pub(super) fn effective_conversation_state_with_coverage(
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
pub(super) fn load_activity(
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
pub(super) fn has_undo_rows(
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

pub(super) fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, MailError> {
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
pub(super) fn latest_action_id(
    conn: &Connection,
    account_id: &str,
) -> Result<Option<String>, MailError> {
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
