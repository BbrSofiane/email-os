use super::*;

impl GmailStore {
    /// One partial group Undo attempt (docs/ux-05-safe-bulk-processing.md §5):
    /// whole-group eligibility, per-member cancel/compensate/skip decisions
    /// from the original immutable targets/preimages, all persisted in one
    /// transaction under the store lock; idempotent under `requestId`.
    pub(crate) fn undo_operation_group(
        &self,
        command: &crate::groups::UndoOperationGroup,
    ) -> Result<crate::groups::GroupUndoReceipt, MailError> {
        crate::groups::validate_group_request_id(&command.request_id)?;
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        let account_id = account_id_of(&tx)?;
        let payload = serde_json::json!({ "undoGroupId": command.group_id }).to_string();
        if let Some(receipt) =
            existing_group_undo_receipt(&tx, &account_id, &command.request_id, &payload)?
        {
            tx.commit().map_err(storage_err())?;
            return Ok(receipt);
        }
        let header =
            load_group_header(&tx, &account_id, &command.group_id)?.ok_or(MailError::NotFound)?;
        let members = load_group_undo_rows(&tx, &account_id, &command.group_id)?;
        let now = self.clock.now_iso();
        check_group_undoable(&tx, &account_id, &header, &now)?;

        let accepted_at = self.clock.now_iso();
        let mut results = Vec::with_capacity(members.len());
        for member in &members {
            let (decision, operation_ids) =
                decide_member_undo(&tx, &account_id, member, &accepted_at)?;
            tx.execute(
                "UPDATE gmail_operation_group_members
                 SET undo_decision = ?4, undo_skip_reason = ?5, undo_operation_ids = ?6
                 WHERE account_id = ?1 AND group_id = ?2 AND ordinal = ?3",
                params![
                    account_id,
                    command.group_id,
                    member.ordinal,
                    group_decision_name(&decision),
                    decision_skip_reason(&decision).map(crate::groups::skip_reason_name),
                    serde_json::to_string(&operation_ids).map_err(storage_err())?,
                ],
            )
            .map_err(storage_err())?;
            results.push(crate::groups::GroupMemberUndoResult {
                ordinal: member.ordinal as u32,
                conversation: ConversationRef {
                    account_id: account_id.clone(),
                    conversation_id: member.conversation_id.clone(),
                },
                decision,
                operation_ids,
            });
        }
        tx.execute(
            "UPDATE gmail_operation_groups SET undone_at = ?3
             WHERE account_id = ?1 AND group_id = ?2",
            params![account_id, command.group_id, accepted_at],
        )
        .map_err(storage_err())?;
        tx.execute(
            "INSERT INTO gmail_operation_requests
             (account_id, request_id, payload, operation_id, accepted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                account_id,
                command.request_id,
                payload,
                command.group_id,
                accepted_at
            ],
        )
        .map_err(storage_err())?;
        tx.commit().map_err(storage_err())?;
        Ok(crate::groups::GroupUndoReceipt {
            group_id: command.group_id.clone(),
            request_id: command.request_id.clone(),
            accepted_at,
            members: results,
        })
    }
}
