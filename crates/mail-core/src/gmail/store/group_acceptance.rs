use super::*;

impl GmailStore {
    /// Accepts a bounded archive or read group atomically
    /// (docs/ux-05-safe-bulk-processing.md §4.1): canonical fingerprint
    /// idempotency, per-member savepointed child acceptance with persisted
    /// rejections, one commit.
    pub(super) fn accept_group(
        &self,
        account_id_command: &str,
        kind: MailboxOperationKind,
        value: bool,
        request_id: &str,
        members: &[ConversationRef],
        observation: Option<&SearchObservation>,
    ) -> Result<OperationGroupReceipt, MailError> {
        crate::groups::validate_group_request_id(request_id)?;
        crate::groups::validate_group_members(account_id_command, members)?;
        let payload = serde_json::json!({
            "kind": kind_name(kind),
            "value": value,
            "members": crate::groups::canonical_member_ids(members),
        })
        .to_string();
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let mut tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account_id = account_id_of(&tx)?;
        if account_id != account_id_command {
            return Err(MailError::NotFound);
        }
        // Same request/payload returns the original receipt — including the
        // original persisted member ordering (§4.1 step 1).
        if let Some(receipt) = existing_group_receipt(&tx, &account_id, request_id, &payload)? {
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(receipt);
        }

        admit_action_observation(&tx, observation, &account_id)?;
        let accepted_at = self.clock.now_iso();
        let group_id = uuid::Uuid::new_v4().to_string();
        let group_seq: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(group_seq), 0) + 1 FROM gmail_operation_groups
                 WHERE account_id = ?1",
                params![account_id],
                |row| row.get(0),
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        let mut member_rows = Vec::with_capacity(members.len());
        for (ordinal, member) in members.iter().enumerate() {
            let child_request_id = format!("{group_id}-{ordinal}");
            let child_payload = serde_json::json!({
                "groupOf": group_id,
                "ordinal": ordinal,
            })
            .to_string();
            // Member savepoint (§4.1 step 3): a rejected member rolls back to
            // a clean slate and keeps its typed rejection; valid siblings are
            // unaffected; storage errors still abort the whole acceptance.
            let mut savepoint = tx.savepoint().map_err(|_| MailError::StorageUnavailable)?;
            let outcome = accept_operation_tx(
                &savepoint,
                &account_id,
                OperationAcceptance {
                    conversation: member,
                    kind,
                    value,
                    request_id: &child_request_id,
                    payload: &child_payload,
                    clone_targets_from: None,
                    explicit_targets: None,
                    undo_of: None,
                    action_id: Some(&group_id),
                    retry_of: None,
                    accepted_at: &accepted_at,
                },
            );
            match outcome {
                Ok(receipt) => {
                    savepoint
                        .commit()
                        .map_err(|_| MailError::StorageUnavailable)?;
                    member_rows.push(GroupMemberInsert {
                        ordinal,
                        conversation_id: member.conversation_id.clone(),
                        operation_id: Some(receipt.operation_id),
                        rejection: None,
                    });
                }
                Err(MailError::NotFound) => {
                    // Gone or unactionable: no immutable targets exist.
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
        tx.execute(
            "INSERT INTO gmail_operation_groups
                (group_id, account_id, request_id, kind, requested_value, accepted_at,
                 undone_at, group_seq)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
            params![
                group_id,
                account_id,
                request_id,
                kind_name(kind),
                value as i64,
                accepted_at,
                group_seq,
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        for member in &member_rows {
            insert_group_member_row(&tx, &account_id, &group_id, member)?;
        }
        // The group's own idempotency request row: a replay (including a lost
        // response) resolves here instead of re-running acceptance, and no
        // other command kind can silently reuse this request id (payload
        // mismatch → request_id_conflict).
        tx.execute(
            "INSERT INTO gmail_operation_requests
             (account_id, request_id, payload, operation_id, accepted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![account_id, request_id, payload, group_id, accepted_at],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        evict_search(&tx, &account_id)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(group_receipt(
            &group_id,
            request_id,
            &account_id,
            kind,
            Some(value),
            &accepted_at,
            &member_rows,
        ))
    }

    #[cfg(test)]
    pub(crate) fn accept_archived_group(
        &self,
        command: &crate::groups::SetArchivedGroup,
    ) -> Result<OperationGroupReceipt, MailError> {
        self.accept_archived_group_observed(command, None)
    }

    pub(crate) fn accept_archived_group_observed(
        &self,
        command: &crate::groups::SetArchivedGroup,
        observation: Option<&SearchObservation>,
    ) -> Result<OperationGroupReceipt, MailError> {
        self.accept_group(
            &command.account_id,
            MailboxOperationKind::Archive,
            command.archived,
            &command.request_id,
            &command.members,
            observation,
        )
    }

    #[cfg(test)]
    pub(crate) fn accept_read_group(
        &self,
        command: &crate::groups::SetReadGroup,
    ) -> Result<OperationGroupReceipt, MailError> {
        self.accept_read_group_observed(command, None)
    }

    pub(crate) fn accept_read_group_observed(
        &self,
        command: &crate::groups::SetReadGroup,
        observation: Option<&SearchObservation>,
    ) -> Result<OperationGroupReceipt, MailError> {
        self.accept_group(
            &command.account_id,
            MailboxOperationKind::Read,
            command.read,
            &command.request_id,
            &command.members,
            observation,
        )
    }
}
