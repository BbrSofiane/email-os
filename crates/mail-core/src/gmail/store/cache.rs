use super::*;

impl GmailStore {
    pub(crate) fn list_attachments(
        &self,
        target: &ConversationRef,
    ) -> Result<Vec<crate::attachments::AttachmentDescriptor>, MailError> {
        let conversation = self.get_conversation(target)?;
        if conversation.retained_snapshot_at.is_some() {
            return Ok(Vec::new());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        if account_id_of(&conn)? != target.account_id {
            return Err(MailError::NotFound);
        }
        let json: Option<String> = conn.query_row("SELECT attachments_json FROM gmail_conversations WHERE account_id = ?1 AND conversation_id = ?2",
            params![target.account_id, target.conversation_id], |row| row.get(0)).optional().map_err(|_| MailError::StorageUnavailable)?.flatten();
        let descriptors: Vec<crate::attachments::AttachmentDescriptor> = json
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|_| MailError::StorageUnavailable)?
            .unwrap_or_default();
        if descriptors.len() > crate::attachments::MAX_ATTACHMENTS {
            return Err(MailError::StorageUnavailable);
        }
        // Tombstone-only history pages can remove a message without replacing
        // the conversation metadata column. Never retain fetch authority for it.
        let mut current = Vec::new();
        for descriptor in descriptors {
            let present: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM gmail_message_facts WHERE account_id = ?1 AND conversation_id = ?2 AND message_id = ?3)",
                params![target.account_id, target.conversation_id, descriptor.message_id], |row| row.get(0),
            ).map_err(|_| MailError::StorageUnavailable)?;
            if present {
                current.push(descriptor);
            }
        }
        Ok(current)
    }

    /// Effective inbox and durable mailbox-operation activity.
    pub(crate) fn list_snapshot(&self) -> Result<InboxSnapshot, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let account_id = match meta_get(&conn, "account_id")? {
            Some(account_id) => account_id,
            None => {
                return Ok(InboxSnapshot {
                    conversations: Vec::new(),
                    activity: Vec::new(),
                })
            }
        };
        let mut stmt = conn
            .prepare(
                "SELECT c.conversation_id FROM gmail_conversations c
                 WHERE c.account_id = ?1 AND NOT EXISTS (
                     SELECT 1 FROM gmail_reminders r WHERE r.account_id=c.account_id
                       AND r.conversation_id=c.conversation_id
                       AND json_extract(r.data, '$.phase')='pending'
                       AND NOT EXISTS (SELECT 1 FROM gmail_message_facts newer
                         WHERE newer.account_id=r.account_id AND newer.conversation_id=r.conversation_id
                           AND newer.message_id NOT IN (SELECT value FROM json_each(r.baseline_ids)))
                 ) AND (NOT EXISTS (
                     SELECT 1 FROM gmail_search_cache sc WHERE sc.account_id = c.account_id AND sc.conversation_id = c.conversation_id)
                     OR EXISTS (SELECT 1 FROM gmail_operations restored WHERE restored.account_id = c.account_id
                         AND restored.conversation_id = c.conversation_id AND restored.kind = 'archive'
                         AND restored.requested_value = 0 AND restored.status IN ('queued','applying','confirmed','outcome_unknown')))
                 AND (EXISTS (
                     SELECT 1 FROM gmail_message_facts f
                     WHERE f.account_id = c.account_id
                       AND f.conversation_id = c.conversation_id
                       AND COALESCE(f.in_inbox, 0) = 1)
                    OR EXISTS (
                     SELECT 1 FROM gmail_operations o
                     JOIN gmail_operation_targets t
                       ON t.account_id = o.account_id AND t.operation_id = o.operation_id
                     WHERE o.account_id = c.account_id
                       AND o.conversation_id = c.conversation_id
                       AND o.kind = 'archive' AND o.requested_value = 0
                       AND o.status IN ('queued', 'applying', 'outcome_unknown')
                       AND t.conversation_id = c.conversation_id))",
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        let ids = stmt
            .query_map(params![&account_id], |row| row.get::<_, String>(0))
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
        let mut summaries = Vec::with_capacity(ids.len());
        for conversation_id in ids {
            let Some(built) = build_conversation(&conn, &account_id, &conversation_id)? else {
                continue;
            };
            let (is_in_inbox, is_read, pending_operation_id) =
                effective_conversation_state(&conn, &account_id, &conversation_id)?;
            if !is_in_inbox || has_excluded_membership(&conn, &account_id, &conversation_id)? {
                continue;
            }
            summaries.push(ConversationSummary {
                stars: Some(star_state(&conn, &account_id, &conversation_id)?),
                conversation_ref: built.conversation_ref,
                subject: built.subject,
                participants: participants_of(&built.messages),
                primary_correspondent: built.newest_sender,
                is_read,
                has_attachments: crate::search::messages_have_attachments(&built.messages),
                preview: preview_of(&built.messages),
                last_message_at: built
                    .messages
                    .last()
                    .map(|m| m.sent_at.clone())
                    .unwrap_or_default(),
                pending_operation_id,
            });
        }
        summaries.sort_by(|a, b| {
            b.last_message_at.cmp(&a.last_message_at).then_with(|| {
                a.conversation_ref
                    .conversation_id
                    .cmp(&b.conversation_ref.conversation_id)
            })
        });
        let activity = load_activity(&conn, &account_id, self.clock.as_ref())?;
        Ok(InboxSnapshot {
            conversations: summaries,
            activity,
        })
    }

    /// Full reader view of one conversation, scoped by the connected account.
    pub(crate) fn get_conversation(
        &self,
        r#ref: &ConversationRef,
    ) -> Result<Conversation, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let Some(account_id) = meta_get(&conn, "account_id")? else {
            return Err(MailError::NotFound);
        };
        if account_id != r#ref.account_id {
            return Err(MailError::NotFound);
        }
        let built = build_conversation(&conn, &account_id, &r#ref.conversation_id)?;
        let recovered = if let Some(built) = built {
            built
        } else {
            let recovered: Option<(String, String)> = conn
                .query_row(
                    "SELECT snapshot_json, snapshot_saved_at FROM gmail_operation_snapshots
                     WHERE account_id = ?1 AND conversation_id = ?2
                     UNION ALL
                     SELECT snapshot_json, COALESCE(json_extract(snapshot_json, '$.retainedSnapshotAt'), '') FROM gmail_reminders
                     WHERE account_id = ?1 AND conversation_id = ?2
                     LIMIT 1",
                    params![account_id, r#ref.conversation_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|_| MailError::StorageUnavailable)?;
            let (json, saved_at) = recovered.ok_or(MailError::NotFound)?;
            let mut snapshot: Conversation =
                serde_json::from_str(&json).map_err(|_| MailError::StorageUnavailable)?;
            snapshot.retained_snapshot_at = Some(saved_at);
            let (is_in_inbox, is_read, pending_operation_id) =
                effective_conversation_state(&conn, &account_id, &r#ref.conversation_id)?;
            snapshot.is_in_inbox = is_in_inbox;
            snapshot.is_read = is_read;
            snapshot.stars = Some(star_state(&conn, &account_id, &r#ref.conversation_id)?);
            snapshot.pending_operation_id = pending_operation_id;
            return Ok(snapshot);
        };
        let (is_in_inbox, is_read, pending_operation_id) =
            effective_conversation_state(&conn, &account_id, &r#ref.conversation_id)?;
        Ok(Conversation {
            stars: Some(star_state(&conn, &account_id, &r#ref.conversation_id)?),
            conversation_ref: recovered.conversation_ref,
            subject: recovered.subject,
            messages: recovered.messages,
            is_in_inbox,
            is_read,
            context_complete: recovered.context_complete,
            unsupported_reason: recovered.unsupported_reason,
            retained_snapshot_at: None,
            reply_context: recovered.reply_context,
            pending_operation_id,
        })
    }

    /// Saves only reply metadata when the cached account, generation, and
    /// latest source message still match the read that fetched it.
    pub(crate) fn save_reply_context(
        &self,
        r#ref: &ConversationRef,
        source_message_id: &str,
        reply_context: &ReplyContext,
        expected_generation: u64,
    ) -> Result<bool, MailError> {
        self.persistence_gate()?;
        if reply_context.source_message_id != source_message_id {
            return Ok(false);
        }
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        if meta_get(&tx, "account_id")?.as_deref() != Some(r#ref.account_id.as_str())
            || !generation_matches(&tx, expected_generation)?
        {
            return Ok(false);
        }
        let cache_state: Option<(i64, String)> = tx
            .query_row(
                "SELECT c.context_complete, m.message_id FROM gmail_conversations c
                 JOIN gmail_messages m
                   ON m.account_id = c.account_id AND m.conversation_id = c.conversation_id
                 WHERE c.account_id = ?1 AND c.conversation_id = ?2
                 ORDER BY m.sent_at DESC, m.message_id DESC LIMIT 1",
                params![r#ref.account_id, r#ref.conversation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| MailError::StorageUnavailable)?;
        if !cache_state
            .is_some_and(|(complete, latest_id)| complete == 1 && latest_id == source_message_id)
        {
            return Ok(false);
        }
        let reply_context_json =
            serde_json::to_string(reply_context).map_err(|_| MailError::StorageUnavailable)?;
        let updated = tx
            .execute(
                "UPDATE gmail_conversations SET reply_context_json = ?1
                 WHERE account_id = ?2 AND conversation_id = ?3
                   AND context_complete = 1 AND reply_context_json IS NULL",
                params![reply_context_json, r#ref.account_id, r#ref.conversation_id],
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        if updated != 1 {
            return Ok(false);
        }
        tx.commit().map_err(|_| MailError::StorageUnavailable)?;
        Ok(true)
    }
}
