use super::*;

impl GmailStore {
    pub(crate) fn destination_snapshot(
        &self,
        account: &str,
        id: &str,
    ) -> Result<Option<String>, MailError> {
        let conn = self.lock_conn()?;
        if meta_get(&conn, "account_id")?.as_deref() != Some(account) {
            return Err(MailError::NotFound);
        }
        conn.query_row("SELECT snapshot_json FROM gmail_destination_snapshots WHERE account_id=?1 AND destination_id=?2",
            params![account, id], |r| r.get(0)).optional().map_err(|_| MailError::StorageUnavailable)
    }

    /// Fails with `NotFound` unless the stored account binding names
    /// `account`. Live destination/catalog reads preflight this so a missing
    /// or mismatched stored account never dispatches a provider fetch, even
    /// when current credentials name the caller's account.
    pub(crate) fn require_destination_account(&self, account: &str) -> Result<(), MailError> {
        let conn = self.lock_conn()?;
        if meta_get(&conn, "account_id")?.as_deref() != Some(account) {
            return Err(MailError::NotFound);
        }
        Ok(())
    }

    pub(crate) fn save_destination_snapshot(
        &self,
        account: &str,
        id: &str,
        json: &str,
        generation: u64,
    ) -> Result<(), MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        if !generation_matches(&tx, generation)?
            || meta_get(&tx, "account_id")?.as_deref() != Some(account)
        {
            return Err(MailError::NotFound);
        }
        tx.execute("INSERT INTO gmail_destination_snapshots(account_id,destination_id,snapshot_json) VALUES (?1,?2,?3)
            ON CONFLICT(account_id,destination_id) DO UPDATE SET snapshot_json=excluded.snapshot_json",
            params![account, id, json]).map_err(|_| MailError::StorageUnavailable)?;
        // Retain at most 20 destination pages plus the catalog. Never evict mail/recovery facts.
        tx.execute("DELETE FROM gmail_destination_snapshots WHERE destination_id <> '' AND rowid NOT IN
            (SELECT rowid FROM gmail_destination_snapshots WHERE destination_id <> '' ORDER BY rowid DESC LIMIT 20)", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)
    }
}
