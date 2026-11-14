use super::*;

pub(super) struct GroupMemberInsert {
    pub(super) ordinal: usize,
    pub(super) conversation_id: String,
    pub(super) operation_id: Option<String>,
    pub(super) rejection: Option<GroupMemberRejection>,
}

pub(super) fn insert_group_member_row(
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
    .map_err(storage_err())?;
    Ok(())
}

pub(super) fn group_receipt(
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
pub(super) fn existing_group_receipt(
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
        .map_err(storage_err())?;
    let Some((saved_payload, group_id)) = existing else {
        return Ok(None);
    };
    if saved_payload != payload {
        return Err(MailError::RequestIdConflict);
    }
    load_group_receipt(conn, account_id, &group_id).map(Some)
}

pub(super) fn existing_group_undo_receipt(
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
        .map_err(storage_err())?;
    let Some((saved_payload, group_id, accepted_at)) = existing else {
        return Ok(None);
    };
    if saved_payload != payload {
        return Err(MailError::RequestIdConflict);
    }
    let accepted_at = accepted_at.ok_or_else(|| storage_fault("missing_persisted_row"))?;
    reconstruct_group_undo_receipt(conn, account_id, &group_id, request_id, &accepted_at).map(Some)
}

pub(super) struct GroupHeader {
    pub(super) group_id: String,
    pub(super) request_id: String,
    pub(super) kind: MailboxOperationKind,
    pub(super) requested_value: bool,
    pub(super) accepted_at: String,
    pub(super) undone_at: Option<String>,
}

pub(super) fn load_group_header(
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
        .map_err(storage_err())?;
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

pub(super) struct GroupMemberRow {
    pub(super) ordinal: i64,
    pub(super) conversation_id: String,
    pub(super) operation_id: Option<String>,
    pub(super) rejection: Option<GroupMemberRejection>,
    pub(super) undo_decision: Option<String>,
    pub(super) undo_skip_reason: Option<String>,
    pub(super) undo_operation_ids: Option<String>,
}

pub(super) fn load_group_undo_rows(
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
        .map_err(storage_err())?;
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
        .map_err(storage_err())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_err())?;
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
                            .ok_or_else(|| storage_fault("missing_persisted_row"))
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

pub(super) fn load_group_member_refs(
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

pub(super) fn load_group_receipt(
    conn: &Connection,
    account_id: &str,
    group_id: &str,
) -> Result<OperationGroupReceipt, MailError> {
    let header = load_group_header(conn, account_id, group_id)?
        .ok_or_else(|| storage_fault("missing_persisted_row"))?;
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
pub(super) fn check_group_undoable(
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

pub(super) fn member_status_of(status: OperationStatus) -> crate::groups::GroupMemberStatus {
    match status {
        OperationStatus::Queued => crate::groups::GroupMemberStatus::Queued,
        OperationStatus::Applying => crate::groups::GroupMemberStatus::Applying,
        OperationStatus::Confirmed => crate::groups::GroupMemberStatus::Confirmed,
        OperationStatus::Failed => crate::groups::GroupMemberStatus::Failed,
        OperationStatus::OutcomeUnknown => crate::groups::GroupMemberStatus::OutcomeUnknown,
        OperationStatus::Cancelled => crate::groups::GroupMemberStatus::Cancelled,
    }
}

pub(super) fn load_group_status(
    conn: &Connection,
    account_id: &str,
    group_id: &str,
    now: String,
) -> Result<OperationGroupStatus, MailError> {
    let header = load_group_header(conn, account_id, group_id)?
        .ok_or_else(|| storage_fault("missing_persisted_row"))?;
    let members = load_group_undo_rows(conn, account_id, group_id)?;
    let mut views = Vec::with_capacity(members.len());
    for member in &members {
        let (status, failure) = if member.rejection.is_some() {
            (crate::groups::GroupMemberStatus::Rejected, None)
        } else {
            let Some(operation_id) = &member.operation_id else {
                return Err(storage_fault("invalid_persisted_state"));
            };
            let row = conn
                .query_row(
                    "SELECT status, failure FROM gmail_operations
                     WHERE account_id = ?1 AND operation_id = ?2",
                    params![account_id, operation_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()
                .map_err(storage_err())?
                .ok_or_else(|| storage_fault("missing_persisted_row"))?;
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
pub(super) fn persisted_group_undo_record(
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
        .map_err(storage_err())?;
    let Some((request_id, accepted_at)) = undo_request else {
        return Ok(None);
    };
    let accepted_at = accepted_at.ok_or_else(|| storage_fault("missing_persisted_row"))?;
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
                    .ok_or_else(|| storage_fault("missing_persisted_row"))?;
                crate::groups::GroupMemberUndoDecision::Skipped { reason }
            }
            _ => return Err(storage_fault("invalid_persisted_state")),
        };
        let compensation_ids: Vec<String> = member
            .undo_operation_ids
            .as_deref()
            .map(|json| serde_json::from_str(json).map_err(storage_err()))
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
                .map_err(storage_err())?
                .ok_or_else(|| storage_fault("missing_persisted_row"))?;
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

pub(super) fn group_undo_availability(
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

pub(super) fn group_decision_name(
    decision: &crate::groups::GroupMemberUndoDecision,
) -> &'static str {
    match decision {
        crate::groups::GroupMemberUndoDecision::Cancelled => "cancelled",
        crate::groups::GroupMemberUndoDecision::Compensating => "compensating",
        crate::groups::GroupMemberUndoDecision::Skipped { .. } => "skipped",
    }
}

pub(super) fn decision_skip_reason(
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
pub(super) fn decide_member_undo(
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
        return Err(storage_fault("invalid_persisted_state"));
    };
    let Some(target) = load_undo_target(tx, account_id, operation_id)? else {
        return Err(storage_fault("invalid_persisted_state"));
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
                .map_err(storage_err())?;
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

pub(super) fn member_compensation(
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

pub(super) fn reconstruct_group_undo_receipt(
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
                    .ok_or_else(|| storage_fault("missing_persisted_row"))?;
                crate::groups::GroupMemberUndoDecision::Skipped { reason }
            }
            _ => return Err(storage_fault("invalid_persisted_state")),
        };
        let operation_ids = member
            .undo_operation_ids
            .as_deref()
            .map(|json| serde_json::from_str(json).map_err(storage_err()))
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
