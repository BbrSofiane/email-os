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
    })
}

impl GmailStore {
    pub(crate) fn send_receipt(
        &self,
        account: &str,
        request: &str,
    ) -> Result<Option<SendIntent>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        conn.query_row("SELECT account_id, operation_id, draft_id, draft_revision, request_id, frozen_mime, not_before, state FROM gmail_send_intents WHERE account_id=?1 AND request_id=?2", params![account, request], read_intent)
            .optional().map_err(storage_err())
    }

    pub(crate) fn insert_send_intent(&self, intent: &SendIntent) -> Result<(), MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        if account_id_of(&tx)? != intent.account_id {
            return Err(MailError::NotFound);
        }
        tx.execute("INSERT INTO gmail_send_intents(account_id, operation_id, draft_id, draft_revision, request_id, frozen_mime, not_before, state) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![intent.account_id, intent.operation_id, intent.draft_id, intent.draft_revision, intent.request_id, intent.frozen_mime, intent.not_before, intent.state]).map_err(storage_err())?;
        tx.commit().map_err(storage_err())
    }

    pub(crate) fn list_send_intents(&self, account: &str) -> Result<Vec<SendIntent>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare("SELECT account_id, operation_id, draft_id, draft_revision, request_id, frozen_mime, not_before, state FROM gmail_send_intents WHERE account_id=?1 ORDER BY rowid").map_err(storage_err())?;
        let rows = stmt
            .query_map(params![account], read_intent)
            .map_err(storage_err())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(storage_err())
    }
}
