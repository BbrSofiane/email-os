use super::*;

impl GmailStore {
    pub(crate) fn claim_next_operation(&self) -> Result<Option<OperationRecord>, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        let account_id = match meta_get(&tx, "account_id")? {
            Some(id) => id,
            None => return Ok(None),
        };
        let operation = tx
            .query_row(
                "SELECT operation_id FROM gmail_operations
                 WHERE account_id = ?1 AND (status = 'queued' OR (status = 'outcome_unknown' AND last_error IS NULL))
                 ORDER BY CASE status WHEN 'outcome_unknown' THEN 0 ELSE 1 END, accepted_seq LIMIT 1",
                params![account_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_err())?;
        let Some(operation_id) = operation else {
            tx.commit().map_err(storage_err())?;
            return Ok(None);
        };
        let record = load_operation(&tx, &account_id, &operation_id)?
            .ok_or_else(|| storage_fault("missing_persisted_row"))?;
        if record.status == OperationStatus::Queued {
            tx.execute(
                "UPDATE gmail_operations SET status = 'applying', last_error = NULL WHERE account_id = ?1 AND operation_id = ?2 AND status = 'queued'",
                params![account_id, operation_id],
            )
            .map_err(storage_err())?;
        }
        tx.commit().map_err(storage_err())?;
        Ok(Some(record))
    }

    /// A successful fresh sync makes exact-ID facts available for another
    /// safe reconciliation attempt; this never changes an unknown operation
    /// into a setter replay.
    pub(crate) fn schedule_unknown_reconciliation(&self) -> Result<(), MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let Some(account_id) = meta_get(&conn, "account_id")? else {
            return Ok(());
        };
        conn.execute(
            "UPDATE gmail_operations SET last_error = NULL
             WHERE account_id = ?1 AND status = 'outcome_unknown'",
            params![account_id],
        )
        .map_err(storage_err())?;
        Ok(())
    }

    pub(crate) fn claimable_operation_count(&self) -> Result<usize, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let Some(account_id) = meta_get(&conn, "account_id")? else {
            return Ok(0);
        };
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM gmail_operations
                 WHERE account_id = ?1 AND
                       (status = 'queued' OR (status = 'outcome_unknown' AND last_error IS NULL))",
                params![account_id],
                |row| row.get(0),
            )
            .map_err(storage_err())?;
        Ok(count as usize)
    }

    pub(crate) fn confirm_operation(&self, record: &OperationRecord) -> Result<(), MailError> {
        self.finish_operation(record, OperationStatus::Confirmed, None, None, true, None)
    }

    pub(crate) fn reconcile_operation(
        &self,
        record: &OperationRecord,
        fetched: &GmailThread,
        confirmed: bool,
    ) -> Result<(), MailError> {
        self.finish_operation(
            record,
            if confirmed {
                OperationStatus::Confirmed
            } else {
                OperationStatus::OutcomeUnknown
            },
            None,
            (!confirmed).then_some(MailError::OutcomeUnknown),
            confirmed,
            Some(fetched),
        )
    }

    pub(crate) fn unknown_operation(&self, record: &OperationRecord) -> Result<(), MailError> {
        self.finish_operation(
            record,
            OperationStatus::OutcomeUnknown,
            None,
            None,
            false,
            None,
        )
    }

    pub(crate) fn reconciled_unknown_operation(
        &self,
        record: &OperationRecord,
    ) -> Result<(), MailError> {
        self.finish_operation(
            record,
            OperationStatus::OutcomeUnknown,
            None,
            Some(MailError::OutcomeUnknown),
            false,
            None,
        )
    }

    pub(crate) fn defer_unknown_operation(
        &self,
        record: &OperationRecord,
        error: &MailError,
    ) -> Result<(), MailError> {
        self.finish_operation(
            record,
            OperationStatus::OutcomeUnknown,
            None,
            Some(error.clone()),
            false,
            None,
        )
    }

    pub(crate) fn requeue_operation(
        &self,
        record: &OperationRecord,
        error: &MailError,
    ) -> Result<(), MailError> {
        self.finish_operation(
            record,
            OperationStatus::Queued,
            None,
            Some(error.clone()),
            false,
            None,
        )
    }

    pub(crate) fn fail_operation(
        &self,
        record: &OperationRecord,
        error: MailError,
    ) -> Result<(), MailError> {
        self.finish_operation(
            record,
            OperationStatus::Failed,
            Some(OperationFailure::ProviderRejected),
            Some(error),
            false,
            None,
        )
    }

    fn finish_operation(
        &self,
        record: &OperationRecord,
        status: OperationStatus,
        failure: Option<OperationFailure>,
        error: Option<MailError>,
        apply_facts: bool,
        fetched: Option<&GmailThread>,
    ) -> Result<(), MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        let account_id = account_id_of(&tx)?;
        if account_id != record.account_id || !generation_matches(&tx, record.generation)? {
            return Ok(());
        }
        if let Some(thread) = fetched {
            if thread.conversation.conversation_ref.conversation_id != record.conversation_id {
                return Err(MailError::InvalidProviderResponse);
            }
            upsert_thread(&tx, &account_id, thread)?;
            trim_cache(&tx, &account_id)?;
        }
        if apply_facts {
            for message_id in &record.message_ids {
                match record.kind {
                    MailboxOperationKind::Star => {
                        tx.execute("INSERT INTO gmail_message_facts (account_id, conversation_id, message_id, is_starred)
                            VALUES (?1, ?2, ?3, ?4)
                            ON CONFLICT(account_id, conversation_id, message_id) DO UPDATE SET is_starred = excluded.is_starred",
                            params![account_id, record.conversation_id, message_id, i64::from(record.value)])
                            .map_err(storage_err())?;
                    }
                    MailboxOperationKind::Archive => {
                        let inbox = (!record.value) as i64;
                        tx.execute(
                            "INSERT INTO gmail_message_facts (account_id, conversation_id, message_id, in_inbox, is_unread)
                             VALUES (?1, ?2, ?3, ?4, NULL)
                             ON CONFLICT(account_id, conversation_id, message_id) DO UPDATE SET in_inbox = excluded.in_inbox",
                            params![account_id, record.conversation_id, message_id, inbox],
                        ).map_err(storage_err())?;
                    }
                    MailboxOperationKind::Read => {
                        let unread = (!record.value) as i64;
                        tx.execute(
                            "INSERT INTO gmail_message_facts (account_id, conversation_id, message_id, in_inbox, is_unread)
                             VALUES (?1, ?2, ?3, NULL, ?4)
                             ON CONFLICT(account_id, conversation_id, message_id) DO UPDATE SET is_unread = excluded.is_unread",
                            params![account_id, record.conversation_id, message_id, unread],
                        ).map_err(storage_err())?;
                    }
                }
            }
        }
        tx.execute(
            "UPDATE gmail_operations SET status = ?3, failure = ?4, last_error = ?5
             WHERE account_id = ?1 AND operation_id = ?2",
            params![
                account_id,
                record.operation_id,
                status_name(status),
                failure
                    .map(|f| format!("{f:?}"))
                    .map(|s| s.to_ascii_lowercase()),
                error.map(|e| serde_json::to_string(&e).unwrap_or_default())
            ],
        )
        .map_err(storage_err())?;
        tx.commit().map_err(storage_err())
    }
}
