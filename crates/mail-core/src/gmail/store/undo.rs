use super::*;

impl GmailStore {
    /// Undo of the single latest accepted non-compensating operation
    /// (docs/ux-04-trustworthy-undo.md §3.2/§3.3). Idempotent under `requestId`
    /// through the existing request dedup; eligibility failures are typed
    /// [`MailError::UndoUnavailable`]. Still-queued intent is cancelled in
    /// place; anything already claimed or confirmed is compensated with one
    /// queued operation per distinct prior value with explicit targets.
    pub(crate) fn undo_operation(&self, command: &UndoOperation) -> Result<UndoReceipt, MailError> {
        validate_request_id(&command.request_id)?;
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account_id = match meta_get(&tx, "account_id")? {
            Some(id) => id,
            // Rule 1: the operation must belong to the active account.
            None => return Err(MailError::NotFound),
        };
        let payload = serde_json::json!({ "undoOperationId": command.operation_id }).to_string();
        if let Some(receipt) =
            existing_undo_receipt(&tx, &account_id, &command.request_id, &payload)?
        {
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(receipt);
        }
        let target = load_undo_target(&tx, &account_id, &command.operation_id)?
            .ok_or(MailError::NotFound)?;
        check_undoable(&tx, &account_id, &target, &self.clock.now_iso())?;
        let accepted_at = self.clock.now_iso();
        let receipt = if target.status == OperationStatus::Queued {
            // Cancel in place. The zero-rows branch is defensive only: the
            // status was read in this same transaction, which runs under the
            // connection mutex the worker's claim also needs, so the worker
            // cannot claim concurrently; fall through to compensation anyway.
            let cancelled = tx
                .execute(
                    "UPDATE gmail_operations SET status = 'cancelled', last_error = NULL
                     WHERE account_id = ?1 AND operation_id = ?2 AND status = 'queued'",
                    params![account_id, target.operation_id],
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
                compensate_tx(&tx, &account_id, &target, &accepted_at)?
            }
        } else {
            compensate_tx(&tx, &account_id, &target, &accepted_at)?
        };
        tx.execute(
            "INSERT INTO gmail_operation_requests
             (account_id, request_id, payload, operation_id, accepted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                account_id,
                command.request_id,
                payload,
                target.operation_id,
                accepted_at
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(receipt)
    }
}
