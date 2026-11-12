use super::*;

impl GmailStore {
    pub(crate) fn open(profile_dir: &Path, clock: Arc<dyn Clock>) -> Result<GmailStore, MailError> {
        std::fs::create_dir_all(profile_dir).map_err(|_| MailError::StorageUnavailable)?;
        let db_path = profile_dir.join("gmail.db");
        let conn = Connection::open(&db_path).map_err(|_| MailError::StorageUnavailable)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| MailError::StorageUnavailable)?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(|_| MailError::StorageUnavailable)?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|_| MailError::StorageUnavailable)?;
        let store = GmailStore {
            conn: Mutex::new(conn),
            clock,
            #[cfg(test)]
            injected_persistence_failure: AtomicBool::new(false),
        };
        store.migrate()?;
        store.recover_interrupted_operations_on_startup()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), MailError> {
        let mut conn = self.lock_conn()?;
        schema::migrate(&mut conn)
    }

    fn recover_interrupted_operations_on_startup(&self) -> Result<(), MailError> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "UPDATE gmail_operations SET status = 'outcome_unknown', last_error = NULL
             WHERE status = 'applying'",
            [],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)
    }

    /// Fail-closed gate; under `cfg(test)` it can simulate persistence loss.
    pub(super) fn persistence_gate(&self) -> Result<(), MailError> {
        #[cfg(test)]
        if self.injected_persistence_failure.load(Ordering::SeqCst) {
            return Err(MailError::StorageUnavailable);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn set_test_persistence_failure(&self, on: bool) {
        self.injected_persistence_failure
            .store(on, Ordering::SeqCst);
    }

    pub(crate) fn get_saved_split(
        &self,
        account: &str,
    ) -> Result<Option<crate::splits::SavedSplit>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        if meta_get(&conn, "account_id")?.as_deref() != Some(account) {
            return Err(MailError::NotFound);
        }
        crate::splits::get(&conn, account)
    }

    pub(crate) fn save_saved_split(
        &self,
        account: &str,
        split: &crate::splits::SavedSplit,
    ) -> Result<crate::splits::SavedSplit, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        if meta_get(&conn, "account_id")?.as_deref() != Some(account) {
            return Err(MailError::NotFound);
        }
        crate::splits::save(&conn, account, split)
    }

    pub(super) fn lock_conn(&self) -> Result<MutexGuard<'_, Connection>, MailError> {
        self.conn.lock().map_err(|_| MailError::StorageUnavailable)
    }

    pub(crate) fn account(&self) -> Result<Option<AccountInfo>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let account_id = meta_get(&conn, "account_id")?;
        let email_address = meta_get(&conn, "email_address")?;
        Ok(account_id
            .zip(email_address)
            .map(|(account_id, email_address)| AccountInfo {
                account_id,
                email_address,
            }))
    }

    pub(crate) fn has_account(&self) -> Result<bool, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        Ok(meta_get(&conn, "account_id")?.is_some())
    }

    pub(crate) fn generation(&self) -> Result<u64, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        generation_of(&conn)
    }

    /// The committed final history cursor. Advanced only after every page of
    /// a history batch has been applied.
    #[cfg(test)]
    pub(crate) fn cursor(&self) -> Result<Option<String>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        meta_get(&conn, "history_id")
    }

    pub(crate) fn discovery(&self) -> Result<DiscoveryProgress, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let state = meta_get(&conn, "discovery_state")?;
        match state.as_deref() {
            Some("done") => Ok(DiscoveryProgress::Done),
            Some("running") => Ok(DiscoveryProgress::Running {
                page_token: meta_get(&conn, "discovery_page_token")?,
            }),
            _ => Ok(DiscoveryProgress::Pending),
        }
    }

    pub(crate) fn history(&self) -> Result<HistoryProgress, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        if let Some(batch_start) = meta_get(&conn, "history_batch_start")? {
            return Ok(HistoryProgress::Resuming {
                batch_start,
                page_token: meta_get(&conn, "history_page_token")?,
            });
        }
        Ok(HistoryProgress::Idle {
            cursor: meta_get(&conn, "history_id")?,
        })
    }

    /// Conversation ids already observed by the current discovery run (used
    /// for cross-page dedup and stale-membership reconciliation).
    pub(crate) fn seen_ids(&self) -> Result<Vec<String>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare("SELECT conversation_id FROM gmail_discovery_seen")
            .map_err(|_| MailError::StorageUnavailable)?;
        let collected = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
        Ok(collected)
    }

    pub(crate) fn cached_count(&self) -> Result<usize, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        match meta_get(&conn, "account_id")? {
            Some(account_id) => {
                let count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM gmail_conversations WHERE account_id = ?1",
                        params![account_id],
                        |row| row.get(0),
                    )
                    .map_err(|_| MailError::StorageUnavailable)?;
                Ok(count as usize)
            }
            None => Ok(0),
        }
    }

    pub(crate) fn last_synced_at(&self) -> Result<Option<String>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        meta_get(&conn, "last_synced_at")
    }

    pub(crate) fn discovery_done(&self) -> Result<bool, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        Ok(meta_get(&conn, "discovery_state")?.as_deref() == Some("done"))
    }

    /// Search owns an independent 100-row retention budget, never discovery
    /// checkpoints. Operation snapshots and immutable target facts survive eviction.
    pub(crate) fn observation_revision(&self) -> Result<u64, MailError> {
        Ok(self.lock_conn()?.total_changes())
    }

    /// Only missing exact action references need provider revalidation. Replays
    /// must reach the durable idempotency check without requiring the network.
    pub(crate) fn missing_action_context(
        &self,
        account: &str,
        request: &str,
        members: &[ConversationRef],
    ) -> Result<Vec<String>, MailError> {
        let conn = self.lock_conn()?;
        if account_id_of(&conn)? != account {
            return Err(MailError::NotFound);
        }
        let replay: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM gmail_operation_requests WHERE account_id=?1 AND request_id=?2)",
            params![account, request], |r| r.get(0)).map_err(|_| MailError::StorageUnavailable)?;
        if replay {
            return Ok(vec![]);
        }
        let mut missing = Vec::new();
        for member in members {
            if !has_action_context(&conn, account, &member.conversation_id)? {
                missing.push(member.conversation_id.clone());
            }
        }
        Ok(missing)
    }

    /// Records the account identity and pins the baseline history cursor
    /// BEFORE discovery runs. Restoring the same account after a restart
    /// keeps the persisted cursor and discovery progress so offline changes
    /// are not skipped. A different account id fails closed.
    pub(crate) fn begin_account(
        &self,
        profile: &GmailProfile,
        expected_generation: u64,
    ) -> Result<Commit, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        if !generation_matches(&tx, expected_generation)? {
            return Ok(Commit::Discarded);
        }
        if let Some(existing) = meta_get(&tx, "account_id")? {
            if existing != profile.account_id {
                return Err(MailError::InvalidRequest {
                    field: "accountId".to_string(),
                });
            }
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(Commit::Applied);
        }
        meta_set(&tx, "account_id", &profile.account_id)?;
        meta_set(&tx, "email_address", &profile.email_address)?;
        meta_set(&tx, "history_id", &profile.history_id)?;
        meta_set(&tx, "discovery_state", "pending")?;
        meta_del(&tx, "discovery_page_token")?;
        meta_del(&tx, "history_batch_start")?;
        meta_del(&tx, "history_page_token")?;
        meta_del(&tx, "last_synced_at")?;
        tx.execute("DELETE FROM gmail_discovery_seen", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(Commit::Applied)
    }

    /// Bumps the stale-write generation without touching data: every
    /// in-flight checkpointed write from before this point is discarded.
    pub(crate) fn advance_generation(&self) -> Result<(), MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let next = generation_of(&tx)?.saturating_add(1);
        meta_set(&tx, "generation", &next.to_string())?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(())
    }

    /// Converts interrupted operations that survived unsuccessful disconnect
    /// cleanup into GET-reconciled unknown outcomes under the current account.
    pub(crate) fn recover_interrupted_operations(&self) -> Result<bool, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let Some(account_id) = meta_get(&tx, "account_id")? else {
            tx.commit().map_err(|_| MailError::StorageUnavailable)?;
            return Ok(false);
        };
        let changed = tx
            .execute(
                "UPDATE gmail_operations
                 SET status = 'outcome_unknown', failure = NULL, last_error = NULL
                 WHERE account_id = ?1 AND status = 'applying'",
                params![account_id],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(changed > 0)
    }

    /// Disconnect cleanup: bumps the generation (stale results can no longer
    /// repopulate) and wipes the account identity, cache and checkpoints in
    /// one transaction.
    pub(crate) fn clear_account(&self) -> Result<(), MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        let next = generation_of(&tx)?.saturating_add(1);
        meta_set(&tx, "generation", &next.to_string())?;
        tx.execute("DELETE FROM meta WHERE key LIKE 'saved_split:%'", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_search_cache", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_destination_snapshots", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_conversations", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_messages", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_inbox_membership", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_message_facts", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_operations", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_operation_targets", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_operation_requests", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_operation_snapshots", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_operation_preimages", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        // Durable group headers/manifests are account-scoped recovery records
        // whose child operations, requests and preimages are deleted above;
        // keeping them would leave detail loads typed-failing and let a
        // reused request id collide with the retained header's unique
        // constraint (docs/ux-05-safe-bulk-processing.md §4.2).
        tx.execute("DELETE FROM gmail_operation_group_members", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_operation_groups", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_reminders", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_reminder_requests", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute("DELETE FROM gmail_discovery_seen", [])
            .map_err(|_| MailError::StorageUnavailable)?;
        tx.execute(
            "DELETE FROM meta WHERE key IN
             ('account_id', 'email_address', 'history_id', 'discovery_state',
              'discovery_page_token', 'history_batch_start', 'history_page_token',
              'last_synced_at')",
            [],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(())
    }
}
