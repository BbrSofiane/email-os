use super::*;

impl GmailStore {
    /// Atomically applies one discovery page's thread facts and its page
    /// checkpoint (`next_token`: the page token to resume from; `None` keeps
    /// an unset token). A completed capped pass replaces the cache view with
    /// its observed set; a complete uncapped pass clears stale INBOX
    /// membership. The seen set is reset only when a genuinely fresh run
    /// starts (durable state was not `running`), so a resumed page keeps the
    /// committed progress that lets retries skip already-saved threads.
    pub(crate) fn apply_discovery_page(
        &self,
        fetched: &[ThreadFetch],
        next_token: Option<&str>,
        done: bool,
        capped: bool,
        expected_generation: u64,
    ) -> Result<Commit, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        if !generation_matches(&tx, expected_generation)? {
            return Ok(Commit::Discarded);
        }
        let account_id = account_id_of(&tx)?;
        // (Re)starting the discovery run: any earlier run's seen set is
        // stale. A `running` state with no page token can also be a resumed
        // first page after a mid-page partial commit; its seen set is the
        // current run's durable progress and must be kept so committed
        // threads are never re-fetched.
        let fresh_run = meta_get(&tx, "discovery_state")?.as_deref() != Some("running");
        if fresh_run {
            tx.execute("DELETE FROM gmail_discovery_seen", [])
                .map_err(storage_err())?;
        }
        for fetch in fetched {
            match fetch {
                ThreadFetch::Cached(thread) => upsert_thread(&tx, &account_id, thread)?,
                ThreadFetch::Missing(id) => delete_conversation(&tx, &account_id, id)?,
            }
            tx.execute(
                "INSERT OR IGNORE INTO gmail_discovery_seen (conversation_id) VALUES (?1)",
                params![fetch.id()],
            )
            .map_err(storage_err())?;
        }
        // Keep every durable checkpoint within the advertised cap. Current
        // discovery observations win over older cached conversations.
        trim_discovery_cache(&tx, &account_id)?;
        if done {
            if capped {
                // A capped discovery is an explicit bounded cache view: keep
                // only conversations observed within the cap. This also
                // reconciles stale inbox membership after cursor expiry, when
                // advancing the fresh baseline means old archive events cannot
                // be recovered by a later history catch-up.
                tx.execute(
                    "DELETE FROM gmail_messages
                     WHERE account_id = ?1 AND conversation_id NOT IN
                         (SELECT conversation_id FROM gmail_discovery_seen UNION SELECT conversation_id FROM gmail_search_cache WHERE account_id=?1 UNION SELECT conversation_id FROM gmail_reminders WHERE account_id=?1 AND json_extract(data,'$.phase')='pending')",
                    params![account_id],
                )
                .map_err(storage_err())?;
                tx.execute(
                    "DELETE FROM gmail_inbox_membership
                     WHERE account_id = ?1 AND conversation_id NOT IN
                         (SELECT conversation_id FROM gmail_discovery_seen UNION SELECT conversation_id FROM gmail_reminders WHERE account_id=?1 AND json_extract(data,'$.phase')='pending')",
                    params![account_id],
                )
                .map_err(storage_err())?;
                // Recovery readers need the current conversation inventory,
                // including later Trash/Spam messages outside immutable targets.
                // Retain facts only under existing recovery/operation ownership;
                // provider replacement and deletion still clear stale facts.
                tx.execute(
                    "DELETE FROM gmail_message_facts
                     WHERE account_id = ?1 AND conversation_id NOT IN
                         (SELECT conversation_id FROM gmail_discovery_seen UNION SELECT conversation_id FROM gmail_search_cache WHERE account_id=?1 UNION SELECT conversation_id FROM gmail_reminders WHERE account_id=?1 AND json_extract(data,'$.phase')='pending')
                       AND NOT EXISTS (
                         SELECT 1 FROM gmail_operation_snapshots s
                         WHERE s.account_id = gmail_message_facts.account_id
                           AND s.conversation_id = gmail_message_facts.conversation_id)
                       AND NOT EXISTS (
                         SELECT 1 FROM gmail_operation_targets t
                         WHERE t.account_id = gmail_message_facts.account_id
                           AND t.conversation_id = gmail_message_facts.conversation_id
                           AND t.message_id = gmail_message_facts.message_id)
                       AND NOT EXISTS (
                         SELECT 1 FROM gmail_operation_snapshots s
                         WHERE s.account_id = gmail_message_facts.account_id
                           AND s.conversation_id = gmail_message_facts.conversation_id)",
                    params![account_id],
                )
                .map_err(storage_err())?;
                tx.execute(
                    "DELETE FROM gmail_conversations
                     WHERE account_id = ?1 AND conversation_id NOT IN
                         (SELECT conversation_id FROM gmail_discovery_seen UNION SELECT conversation_id FROM gmail_search_cache WHERE account_id=?1 UNION SELECT conversation_id FROM gmail_reminders WHERE account_id=?1 AND json_extract(data,'$.phase')='pending')",
                    params![account_id],
                )
                .map_err(storage_err())?;
            } else {
                // Complete uncapped discovery: cached in-inbox conversations
                // not observed were archived or deleted externally; drop their
                // INBOX membership while retaining locally cached reader data.
                tx.execute(
                    "UPDATE gmail_messages SET in_inbox = 0
                     WHERE account_id = ?1 AND in_inbox = 1
                       AND conversation_id NOT IN
                           (SELECT conversation_id FROM gmail_discovery_seen)",
                    params![account_id],
                )
                .map_err(storage_err())?;
                tx.execute(
                    "UPDATE gmail_message_facts SET in_inbox = 0
                     WHERE account_id = ?1 AND conversation_id NOT IN
                         (SELECT conversation_id FROM gmail_discovery_seen)",
                    params![account_id],
                )
                .map_err(storage_err())?;
                tx.execute(
                    "DELETE FROM gmail_inbox_membership
                     WHERE account_id = ?1 AND conversation_id NOT IN
                         (SELECT conversation_id FROM gmail_discovery_seen)",
                    params![account_id],
                )
                .map_err(storage_err())?;
            }
            tx.execute("DELETE FROM gmail_discovery_seen", [])
                .map_err(storage_err())?;
            meta_set(&tx, "discovery_state", "done")?;
            meta_del(&tx, "discovery_page_token")?;
            meta_set(&tx, "last_synced_at", &self.clock.now_iso())?;
        } else {
            meta_set(&tx, "discovery_state", "running")?;
            match next_token {
                Some(token) => meta_set(&tx, "discovery_page_token", token)?,
                None => meta_del(&tx, "discovery_page_token")?,
            }
        }
        tx.commit().map_err(storage_err())?;
        Ok(Commit::Applied)
    }

    /// Atomically applies one history page's facts/deletions and its
    /// checkpoint. The final history cursor advances only when the page is
    /// the batch's last (`next_page_token == None`), so interrupted batches
    /// resume from the original start id.
    pub(crate) fn apply_history_page(
        &self,
        page: &HistoryPage,
        fetched: &[ThreadFetch],
        batch_start: &str,
        expected_generation: u64,
    ) -> Result<Commit, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        if !generation_matches(&tx, expected_generation)? {
            return Ok(Commit::Discarded);
        }
        let account_id = account_id_of(&tx)?;
        for fetch in fetched {
            match fetch {
                ThreadFetch::Cached(thread) => upsert_thread(&tx, &account_id, thread)?,
                ThreadFetch::Missing(id) => delete_conversation(&tx, &account_id, id)?,
            }
        }
        trim_cache(&tx, &account_id)?;
        for message_id in &page.deleted_message_ids {
            tx.execute(
                "DELETE FROM gmail_messages WHERE account_id = ?1 AND message_id = ?2",
                params![account_id, message_id],
            )
            .map_err(storage_err())?;
            tx.execute(
                "DELETE FROM gmail_inbox_membership WHERE account_id = ?1 AND message_id = ?2",
                params![account_id, message_id],
            )
            .map_err(storage_err())?;
            tx.execute(
                "DELETE FROM gmail_message_facts WHERE account_id = ?1 AND message_id = ?2",
                params![account_id, message_id],
            )
            .map_err(storage_err())?;
        }
        // Conversations left with no messages disappear from the cache.
        tx.execute(
            "DELETE FROM gmail_conversations
             WHERE account_id = ?1 AND NOT EXISTS (
                 SELECT 1 FROM gmail_messages m
                 WHERE m.account_id = gmail_conversations.account_id
                   AND m.conversation_id = gmail_conversations.conversation_id)
               AND NOT EXISTS (
                 SELECT 1 FROM gmail_inbox_membership i
                 WHERE i.account_id = gmail_conversations.account_id
                   AND i.conversation_id = gmail_conversations.conversation_id)",
            params![account_id],
        )
        .map_err(storage_err())?;
        if page.next_page_token.is_none() {
            meta_set(&tx, "history_id", &page.history_id)?;
            meta_del(&tx, "history_batch_start")?;
            meta_del(&tx, "history_page_token")?;
            meta_set(&tx, "last_synced_at", &self.clock.now_iso())?;
        } else {
            meta_set(&tx, "history_batch_start", batch_start)?;
            meta_set(
                &tx,
                "history_page_token",
                page.next_page_token.as_deref().unwrap_or_default(),
            )?;
        }
        tx.commit().map_err(storage_err())?;
        Ok(Commit::Applied)
    }

    /// Cursor-expiry recovery: pin a fresh baseline and restart bounded
    /// discovery, which reconciles its cache view before proceeding instead
    /// of silently skipping the expired window.
    pub(crate) fn begin_rediscovery(
        &self,
        baseline_history_id: &str,
        expected_generation: u64,
    ) -> Result<Commit, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        if !generation_matches(&tx, expected_generation)? {
            return Ok(Commit::Discarded);
        }
        account_id_of(&tx)?;
        meta_set(&tx, "history_id", baseline_history_id)?;
        meta_set(&tx, "discovery_state", "running")?;
        meta_del(&tx, "discovery_page_token")?;
        meta_del(&tx, "history_batch_start")?;
        meta_del(&tx, "history_page_token")?;
        tx.execute("DELETE FROM gmail_discovery_seen", [])
            .map_err(storage_err())?;
        tx.commit().map_err(storage_err())?;
        Ok(Commit::Applied)
    }
}
