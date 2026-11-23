use super::*;

/// Durable send admission. The frozen payload must never be logged.
#[derive(Clone)]
pub(crate) struct SendIntent {
    pub account_id: String,
    pub operation_id: String,
    pub draft_id: String,
    pub draft_revision: u32,
    pub request_id: String,
    pub frozen_mime: Vec<u8>,
    pub not_before: String,
    pub state: String,
    pub retry_of: Option<String>,
    pub dismissed: bool,
}

fn read_intent(row: &rusqlite::Row<'_>) -> rusqlite::Result<SendIntent> {
    Ok(SendIntent {
        account_id: row.get(0)?,
        operation_id: row.get(1)?,
        draft_id: row.get(2)?,
        draft_revision: row.get(3)?,
        request_id: row.get(4)?,
        frozen_mime: row.get(5)?,
        not_before: row.get(6)?,
        state: row.get(7)?,
        retry_of: row.get(8)?,
        dismissed: row.get(9)?,
    })
}

impl GmailStore {
    pub(crate) fn confirmed_send_thread(
        &self,
        account: &str,
        operation: &str,
    ) -> Result<String, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        conn.query_row(
            "SELECT provider_thread_id FROM gmail_send_intents WHERE account_id=?1 AND operation_id=?2 AND state='confirmed' AND dismissed=0 AND provider_thread_id IS NOT NULL",
            params![account, operation],
            |row| row.get(0),
        ).optional().map_err(storage_err())?.ok_or(MailError::NotFound)
    }

    pub(crate) fn finish_send_for_generation(
        &self,
        account: &str,
        operation: &str,
        generation: u64,
        result: &crate::gmail::types::SendResult,
    ) -> Result<bool, MailError> {
        use crate::gmail::types::SendResult;
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        if generation_of(&tx)? != generation || account_id_of(&tx)? != account {
            return Ok(false);
        }
        let (state, message, thread, clear) = match result {
            SendResult::Confirmed {
                message_id,
                thread_id,
            } if !message_id.is_empty() && !thread_id.is_empty() => (
                "confirmed",
                Some(message_id.as_str()),
                Some(thread_id.as_str()),
                true,
            ),
            SendResult::Confirmed { .. } | SendResult::Unknown => ("unknown", None, None, false),
            SendResult::Refused => ("failed", None, None, false),
            SendResult::Paused => ("queued", None, None, false),
        };
        let changed = tx.execute("UPDATE gmail_send_intents SET state=?3, provider_message_id=?4, provider_thread_id=?5, frozen_mime=CASE WHEN ?6 THEN X'' ELSE frozen_mime END WHERE account_id=?1 AND operation_id=?2 AND state='applying'", params![account, operation, state, message, thread, clear]).map_err(storage_err())?;
        tx.commit().map_err(storage_err())?;
        Ok(changed == 1)
    }

    /// Confirm only an unknown intent belonging to the current session.
    pub(crate) fn confirm_unknown_send_for_generation(
        &self,
        account: &str,
        operation: &str,
        generation: u64,
        message_id: &str,
        thread_id: &str,
    ) -> Result<bool, MailError> {
        if message_id.is_empty() || thread_id.is_empty() {
            return Ok(false);
        }
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        if generation_of(&tx)? != generation || account_id_of(&tx)? != account {
            return Ok(false);
        }
        let changed = tx.execute(
            "UPDATE gmail_send_intents SET state='confirmed', provider_message_id=?3, provider_thread_id=?4, frozen_mime=X'' WHERE account_id=?1 AND operation_id=?2 AND state='unknown'",
            params![account, operation, message_id, thread_id],
        ).map_err(storage_err())?;
        tx.commit().map_err(storage_err())?;
        Ok(changed == 1)
    }

    pub(crate) fn send_now(&self) -> Result<chrono::DateTime<chrono::FixedOffset>, MailError> {
        chrono::DateTime::parse_from_rfc3339(&self.clock.now_iso()).map_err(storage_err())
    }

    pub(crate) fn send_receipt(
        &self,
        account: &str,
        request: &str,
    ) -> Result<Option<SendIntent>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        conn.query_row("SELECT account_id, operation_id, draft_id, draft_revision, request_id, frozen_mime, not_before, state, retry_of, dismissed FROM gmail_send_intents WHERE account_id=?1 AND request_id=?2", params![account, request], read_intent)
            .optional().map_err(storage_err())
    }

    pub(crate) fn insert_send_intent(&self, intent: &SendIntent) -> Result<(), MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        if account_id_of(&tx)? != intent.account_id {
            return Err(MailError::NotFound);
        }
        tx.execute("INSERT INTO gmail_send_intents(account_id, operation_id, draft_id, draft_revision, request_id, frozen_mime, not_before, state, retry_of) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![intent.account_id, intent.operation_id, intent.draft_id, intent.draft_revision, intent.request_id, intent.frozen_mime, intent.not_before, intent.state, intent.retry_of]).map_err(storage_err())?;
        tx.commit().map_err(storage_err())
    }

    pub(crate) fn insert_retry_send(
        &self,
        intent: &SendIntent,
        generation: u64,
    ) -> Result<(), MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        if generation_of(&tx)? != generation || account_id_of(&tx)? != intent.account_id {
            return Err(MailError::AuthRequired);
        }
        let eligible: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM gmail_send_intents WHERE account_id=?1 AND draft_id=?2 AND draft_revision=?3 AND operation_id=?4 AND state='failed' AND length(frozen_mime)>0 AND rowid=(SELECT MAX(rowid) FROM gmail_send_intents WHERE account_id=?1 AND draft_id=?2))",
            params![intent.account_id, intent.draft_id, intent.draft_revision, intent.retry_of], |row| row.get(0),
        ).map_err(storage_err())?;
        if !eligible {
            return Err(MailError::InvalidRequest {
                field: "operationId".into(),
            });
        }
        tx.execute("INSERT INTO gmail_send_intents(account_id, operation_id, draft_id, draft_revision, request_id, frozen_mime, not_before, state, retry_of) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![intent.account_id, intent.operation_id, intent.draft_id, intent.draft_revision, intent.request_id, intent.frozen_mime, intent.not_before, intent.state, intent.retry_of]).map_err(storage_err())?;
        tx.commit().map_err(storage_err())
    }

    pub(crate) fn list_send_intents(&self, account: &str) -> Result<Vec<SendIntent>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare("SELECT account_id, operation_id, draft_id, draft_revision, request_id, frozen_mime, not_before, state, retry_of, dismissed FROM gmail_send_intents WHERE account_id=?1 ORDER BY rowid").map_err(storage_err())?;
        let rows = stmt
            .query_map(params![account], read_intent)
            .map_err(storage_err())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(storage_err())
    }
    pub(crate) fn dismiss_send(&self, account: &str, operation: &str) -> Result<bool, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE gmail_send_intents SET dismissed=1 WHERE account_id=?1 AND operation_id=?2 AND state IN ('unknown', 'failed', 'confirmed')",
            params![account, operation],
        ).map_err(storage_err())?;
        Ok(changed == 1)
    }

    /// Cancel only a still-held intent before its deadline. Replays remain cancelled.
    pub(crate) fn undo_send(&self, account: &str, operation: &str) -> Result<bool, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        let now = self.clock.now_iso();
        tx.execute("UPDATE gmail_send_intents SET state='undone', frozen_mime=X'' WHERE account_id=?1 AND operation_id=?2 AND state='hold' AND julianday(not_before)>julianday(?3)", params![account, operation, now]).map_err(storage_err())?;
        let cancelled = tx.query_row("SELECT state='undone' FROM gmail_send_intents WHERE account_id=?1 AND operation_id=?2", params![account, operation], |row| row.get(0)).optional().map_err(storage_err())?.unwrap_or(false);
        tx.commit().map_err(storage_err())?;
        Ok(cancelled)
    }

    /// Release expired holds without waiting for provider connectivity.
    pub(crate) fn release_due_sends(&self, account: &str) -> Result<usize, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        conn.execute("UPDATE gmail_send_intents SET state='queued' WHERE account_id=?1 AND state='hold' AND julianday(not_before)<=julianday(?2)", params![account, self.clock.now_iso()]).map_err(storage_err())
    }

    /// Startup recovery must precede release or dispatch.
    pub(crate) fn recover_send_intents(&self) -> Result<(), MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        tx.execute(
            "UPDATE gmail_send_intents SET state='cancelled', frozen_mime=X'' WHERE state='hold'",
            [],
        )
        .map_err(storage_err())?;
        tx.execute(
            "UPDATE gmail_send_intents SET state='unknown' WHERE state='applying'",
            [],
        )
        .map_err(storage_err())?;
        tx.commit().map_err(storage_err())
    }

    /// The applying marker is the dispatch barrier; unknown work is never reclaimed.
    #[cfg(test)]
    pub(crate) fn claim_send(&self, account: &str, operation: &str) -> Result<bool, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let changed = conn.execute("UPDATE gmail_send_intents SET state='applying' WHERE account_id=?1 AND operation_id=?2 AND state='queued' AND julianday(not_before)<=julianday(?3)", params![account, operation, self.clock.now_iso()]).map_err(storage_err())?;
        Ok(changed == 1)
    }

    /// Fence a claim against a session change in the same ledger transaction.
    /// The caller must verify the exact draft lock under the lifecycle gate.
    pub(crate) fn claim_send_for_generation(
        &self,
        account: &str,
        operation: &str,
        generation: u64,
    ) -> Result<bool, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        if generation_of(&tx)? != generation || account_id_of(&tx)? != account {
            return Ok(false);
        }
        let changed = tx.execute("UPDATE gmail_send_intents SET state='applying' WHERE account_id=?1 AND operation_id=?2 AND state='queued' AND julianday(not_before)<=julianday(?3)", params![account, operation, self.clock.now_iso()]).map_err(storage_err())?;
        tx.commit().map_err(storage_err())?;
        Ok(changed == 1)
    }
    /// Cancel queued work only while the same session still owns it.
    pub(crate) fn cancel_queued_send_for_generation(
        &self,
        account: &str,
        operation: &str,
        generation: u64,
    ) -> Result<bool, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        if generation_of(&tx)? != generation || account_id_of(&tx)? != account {
            return Ok(false);
        }
        let changed = tx.execute(
            "UPDATE gmail_send_intents SET state='cancelled', frozen_mime=X'' WHERE account_id=?1 AND operation_id=?2 AND state='queued'",
            params![account, operation],
        ).map_err(storage_err())?;
        tx.commit().map_err(storage_err())?;
        Ok(changed == 1)
    }
}
