use super::*;

impl GmailStore {
    #[cfg(test)]
    pub(crate) fn accept_archived(
        &self,
        command: &SetArchived,
    ) -> Result<OperationReceipt, MailError> {
        self.accept_archived_observed(command, None)
    }

    pub(crate) fn accept_archived_observed(
        &self,
        command: &SetArchived,
        observation: Option<&SearchObservation>,
    ) -> Result<OperationReceipt, MailError> {
        self.accept_new_operation(
            &command.conversation,
            MailboxOperationKind::Archive,
            command.archived,
            &command.request_id,
            serde_json::json!({
                "accountId": command.conversation.account_id,
                "conversationId": command.conversation.conversation_id,
                "kind": "archive",
                "value": command.archived,
            })
            .to_string(),
            observation,
        )
    }

    pub(crate) fn accept_starred(
        &self,
        command: &crate::stars::SetStarred,
    ) -> Result<OperationReceipt, MailError> {
        self.accept_new_operation(&command.conversation, MailboxOperationKind::Star, command.starred,
            &command.request_id, serde_json::json!({
                "accountId": command.conversation.account_id, "conversationId": command.conversation.conversation_id,
                "kind": "star", "value": command.starred
            }).to_string(), None)
    }

    pub(crate) fn accept_starred_group(
        &self,
        command: &crate::stars::SetStarredGroup,
    ) -> Result<OperationGroupReceipt, MailError> {
        self.accept_group(
            &command.account_id,
            MailboxOperationKind::Star,
            command.starred,
            &command.request_id,
            &command.members,
            None,
        )
    }

    #[cfg(test)]
    pub(crate) fn accept_read(&self, command: &SetRead) -> Result<OperationReceipt, MailError> {
        self.accept_read_observed(command, None)
    }

    pub(crate) fn accept_read_observed(
        &self,
        command: &SetRead,
        observation: Option<&SearchObservation>,
    ) -> Result<OperationReceipt, MailError> {
        self.accept_new_operation(
            &command.conversation,
            MailboxOperationKind::Read,
            command.read,
            &command.request_id,
            serde_json::json!({
                "accountId": command.conversation.account_id,
                "conversationId": command.conversation.conversation_id,
                "kind": "read",
                "value": command.read,
            })
            .to_string(),
            observation,
        )
    }

    fn accept_new_operation(
        &self,
        conversation: &ConversationRef,
        kind: MailboxOperationKind,
        value: bool,
        request_id: &str,
        payload: String,
        observation: Option<&SearchObservation>,
    ) -> Result<OperationReceipt, MailError> {
        validate_request_id(request_id)?;
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account_id = account_id_of(&tx)?;
        if account_id != conversation.account_id {
            return Err(MailError::NotFound);
        }
        if let Some(receipt) = existing_receipt(&tx, &account_id, request_id, &payload)? {
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(receipt);
        }
        admit_action_observation(&tx, observation, &account_id)?;
        let accepted_at = self.clock.now_iso();
        let receipt = accept_operation_tx(
            &tx,
            &account_id,
            OperationAcceptance {
                conversation,
                kind,
                value,
                request_id,
                payload: &payload,
                clone_targets_from: None,
                explicit_targets: None,
                undo_of: None,
                action_id: None,
                retry_of: None,
                accepted_at: &accepted_at,
            },
        )?;
        evict_search(&tx, &account_id)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(receipt)
    }

    pub(crate) fn accept_retry(
        &self,
        command: &RetryOperation,
    ) -> Result<OperationReceipt, MailError> {
        validate_request_id(&command.request_id)?;
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account_id = account_id_of(&tx)?;
        let payload = serde_json::json!({ "retryOperationId": command.operation_id }).to_string();
        if let Some(receipt) = existing_receipt(&tx, &account_id, &command.request_id, &payload)? {
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(receipt);
        }
        let original =
            load_operation(&tx, &account_id, &command.operation_id)?.ok_or(MailError::NotFound)?;
        if !matches!(
            original.status,
            OperationStatus::Failed | OperationStatus::OutcomeUnknown
        ) {
            return Err(MailError::InvalidRequest {
                field: "operationId".to_string(),
            });
        }
        let conversation = ConversationRef {
            account_id: account_id.clone(),
            conversation_id: original.conversation_id.clone(),
        };
        // A retry of a compensating operation stays a compensation: it keeps
        // the original's `undo_of`, so it is never itself undoable (no redo)
        // and keeps the `Undo of …` linkage in Activity.
        let original_undo_of: Option<String> = tx
            .query_row(
                "SELECT undo_of FROM gmail_operations
                 WHERE account_id = ?1 AND operation_id = ?2",
                params![account_id, original.operation_id],
                |row| row.get(0),
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        let accepted_at = self.clock.now_iso();
        let receipt = accept_operation_tx(
            &tx,
            &account_id,
            OperationAcceptance {
                conversation: &conversation,
                kind: original.kind,
                value: original.value,
                request_id: &command.request_id,
                payload: &payload,
                // A retry restores the same prior world as the operation it
                // retries, so it clones the original's preimage verbatim.
                clone_targets_from: Some(&original.operation_id),
                explicit_targets: None,
                undo_of: original_undo_of.as_deref(),
                action_id: None,
                // Inspection link to the retried operation (backend-only).
                retry_of: Some(original.operation_id.as_str()),
                accepted_at: &accepted_at,
            },
        )?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(receipt)
    }
}
