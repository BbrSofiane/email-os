use super::*;

impl GmailStore {
    /// Bounded local evidence only; pagination scans cache candidates and may
    /// return a short page with a continuation. No provider discovery is implied.
    pub(crate) fn list_cached_starred(
        &self,
        request: &crate::dto::CachedDoneRequest,
    ) -> Result<crate::dto::CachedDoneSnapshot, MailError> {
        self.persistence_gate()?;
        let (candidates, synced_at) = {
            let conn = self.lock_conn()?;
            let account = account_id_of(&conn)?;
            let mut paging = request.clone();
            paging.cursor = request
                .cursor
                .as_ref()
                .map(|cursor| {
                    cursor
                        .strip_prefix("cached-starred-v1:")
                        .map(|body| format!("cached-done-v1:{body}"))
                        .ok_or(MailError::InvalidRequest {
                            field: "cursor".into(),
                        })
                })
                .transpose()?;
            let position = crate::cached_done::validate(&paging, &account)?;
            let mut stmt = conn.prepare(
                "WITH candidates AS (
                    SELECT c.conversation_id, COALESCE((SELECT MAX(m.sent_at) FROM gmail_messages m
                        WHERE m.account_id = c.account_id AND m.conversation_id = c.conversation_id), '') AS date
                    FROM gmail_conversations c WHERE c.account_id = ?1
                    UNION
                    SELECT s.conversation_id, s.last_message_at AS date FROM gmail_operation_snapshots s
                    WHERE s.account_id = ?1 AND NOT EXISTS (SELECT 1 FROM gmail_conversations c
                        WHERE c.account_id = s.account_id AND c.conversation_id = s.conversation_id))
                SELECT date, conversation_id FROM candidates
                WHERE ?2 IS NULL OR date < ?2 OR (date = ?2 AND conversation_id > ?3)
                ORDER BY date DESC, conversation_id ASC LIMIT ?4"
            ).map_err(|_| MailError::StorageUnavailable)?;
            let rows = stmt
                .query_map(
                    params![
                        account,
                        position.as_ref().map(|p| &p.0),
                        position.as_ref().map(|p| &p.1),
                        request.limit + 1
                    ],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .map_err(|_| MailError::StorageUnavailable)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| MailError::StorageUnavailable)?;
            (rows, meta_get(&conn, "last_synced_at")?)
        };
        let mut summaries = Vec::new();
        for (_, id) in candidates.iter().take(request.limit as usize) {
            let conversation = self.get_conversation(&ConversationRef {
                account_id: request.account_id.clone(),
                conversation_id: id.clone(),
            })?;
            if conversation.stars.as_ref().and_then(|s| s.is_starred()) != Some(true) {
                continue;
            }
            // Sender identity belongs to the newest provider message, not the
            // last renderable body. Legacy and recovery-only rows stay unknown.
            let newest_sender_json: Option<String> = self
                .lock_conn()?
                .query_row(
                    "SELECT newest_sender_json FROM gmail_conversations
                     WHERE account_id = ?1 AND conversation_id = ?2",
                    params![request.account_id, id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| MailError::StorageUnavailable)?
                .flatten();
            let primary_correspondent = newest_sender_json
                .map(|json| serde_json::from_str(&json))
                .transpose()
                .map_err(|_| MailError::StorageUnavailable)?;
            let has_attachments = crate::search::has_attachments(&conversation);
            summaries.push(ConversationSummary {
                stars: conversation.stars,
                conversation_ref: conversation.conversation_ref,
                subject: conversation.subject,
                participants: participants_of(&conversation.messages),
                primary_correspondent,
                preview: preview_of(&conversation.messages),
                last_message_at: conversation
                    .messages
                    .last()
                    .map(|m| m.sent_at.clone())
                    .unwrap_or_default(),
                is_read: conversation.is_read,
                has_attachments,
                pending_operation_id: conversation.pending_operation_id,
            });
        }
        let mut result = crate::cached_done::finish(request, &candidates, summaries, synced_at);
        result.next_cursor = result
            .next_cursor
            .map(|cursor| cursor.replacen("cached-done-v1:", "cached-starred-v1:", 1));
        Ok(result)
    }

    pub(crate) fn search_mail(
        &self,
        request: &crate::search::SearchRequest,
    ) -> Result<crate::search::SearchPage, MailError> {
        if self.account()?.as_ref().map(|a| &a.account_id) != Some(&request.account_id) {
            return Err(MailError::NotFound);
        }
        let ids = {
            let conn = self.lock_conn()?;
            let mut stmt = conn.prepare("SELECT conversation_id FROM (SELECT c.conversation_id, COALESCE(MAX(m.sent_at),'') AS date FROM gmail_conversations c LEFT JOIN gmail_messages m ON m.account_id=c.account_id AND m.conversation_id=c.conversation_id WHERE c.account_id=?1 GROUP BY c.conversation_id UNION ALL SELECT conversation_id, last_message_at AS date FROM gmail_operation_snapshots WHERE account_id=?1) GROUP BY conversation_id ORDER BY MAX(date) DESC, conversation_id LIMIT 1000").map_err(|_| MailError::StorageUnavailable)?;
            let ids = stmt
                .query_map([&request.account_id], |row| row.get::<_, String>(0))
                .map_err(|_| MailError::StorageUnavailable)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| MailError::StorageUnavailable)?;
            ids
        };
        let rows = ids
            .into_iter()
            .map(|id| {
                self.get_conversation(&ConversationRef {
                    account_id: request.account_id.clone(),
                    conversation_id: id,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        crate::search::cached_page(request, rows)
    }

    pub(crate) fn save_search(
        &self,
        threads: &[GmailThread],
        expected: u64,
        revision: u64,
        account: &str,
    ) -> Result<(), MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|_| MailError::StorageUnavailable)?;
        if !generation_matches(&tx, expected)?
            || meta_get(&tx, "account_id")?.as_deref() != Some(account)
        {
            return Err(MailError::NotFound);
        }
        if tx.total_changes() != revision {
            return Err(MailError::Busy);
        }
        admit_search_rows(&tx, threads, account)?;
        evict_search(&tx, account)?;
        tx.commit().map_err(|_| MailError::StorageUnavailable)
    }

    pub(crate) fn list_cached_done(
        &self,
        request: &crate::dto::CachedDoneRequest,
    ) -> Result<crate::dto::CachedDoneSnapshot, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let account = meta_get(&conn, "account_id")?.ok_or(MailError::NotFound)?;
        let position = crate::cached_done::validate(request, &account)?;
        // Only durable archive evidence qualifies, never arbitrary absence of INBOX.
        // Bodies remain bounded to the requested candidate page, including recovery data.
        let mut stmt = conn.prepare(
            "WITH candidates AS (
                SELECT o.conversation_id, COALESCE(
                    (SELECT MAX(m.sent_at) FROM gmail_messages m WHERE m.account_id = o.account_id AND m.conversation_id = o.conversation_id),
                    s.last_message_at, '') AS date
                FROM gmail_operations o LEFT JOIN gmail_operation_snapshots s
                ON s.account_id = o.account_id AND s.conversation_id = o.conversation_id
                WHERE o.account_id = ?1 AND o.kind = 'archive' AND o.requested_value = 1
                AND o.status IN ('queued', 'applying', 'confirmed', 'outcome_unknown')
                AND (s.conversation_id IS NOT NULL OR EXISTS (SELECT 1 FROM gmail_conversations c
                    WHERE c.account_id = o.account_id AND c.conversation_id = o.conversation_id))
                AND NOT EXISTS (
                    SELECT 1 FROM gmail_operations u
                    WHERE u.account_id = o.account_id AND u.undo_of = o.operation_id
                    AND u.status IN ('queued', 'applying', 'confirmed', 'outcome_unknown'))
                GROUP BY o.conversation_id)
             SELECT date, conversation_id FROM candidates
             WHERE ?2 IS NULL OR date < ?2 OR (date = ?2 AND conversation_id > ?3)
             ORDER BY date DESC, conversation_id ASC LIMIT ?4"
        ).map_err(|_| MailError::StorageUnavailable)?;
        let candidates = stmt
            .query_map(
                params![
                    account,
                    position.as_ref().map(|p| &p.0),
                    position.as_ref().map(|p| &p.1),
                    request.limit + 1
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
        let mut summaries = Vec::new();
        for (_, id) in candidates.iter().take(request.limit as usize) {
            let effective = effective_conversation_state_with_coverage(&conn, &account, id)?;
            let (inbox, is_read, pending_operation_id, known) = (
                effective.inbox,
                effective.is_read,
                effective.pending_operation_id,
                effective.coverage_known,
            );
            if inbox || !known || has_excluded_membership(&conn, &account, id)? {
                continue;
            }
            let built = if let Some(built) = build_conversation(&conn, &account, id)? {
                built
            } else {
                let json: String = conn.query_row("SELECT snapshot_json FROM gmail_operation_snapshots WHERE account_id = ?1 AND conversation_id = ?2", params![account, id], |row| row.get(0)).map_err(|_| MailError::StorageUnavailable)?;
                let snapshot: Conversation =
                    serde_json::from_str(&json).map_err(|_| MailError::StorageUnavailable)?;
                BuiltConversation {
                    conversation_ref: snapshot.conversation_ref,
                    subject: snapshot.subject,
                    messages: snapshot.messages,
                    context_complete: snapshot.context_complete,
                    unsupported_reason: snapshot.unsupported_reason,
                    reply_context: snapshot.reply_context,
                    newest_sender: None,
                }
            };
            summaries.push(ConversationSummary {
                stars: Some(star_state(&conn, &account, id)?),
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
        Ok(crate::cached_done::finish(
            request,
            &candidates,
            summaries,
            meta_get(&conn, "last_synced_at")?,
        ))
    }

    /// UX-10 A: read-only known cached Trash, not provider-folder discovery.
    pub(crate) fn list_cached_trash(
        &self,
        request: &crate::dto::CachedTrashRequest,
    ) -> Result<crate::dto::CachedTrashSnapshot, MailError> {
        self.persistence_gate()?;
        let paging = crate::dto::CachedDoneRequest {
            account_id: request.account_id.clone(),
            limit: request.limit,
            cursor: request.cursor.clone(),
        };
        let (candidates, last_synced_at) = {
            let conn = self.lock_conn()?;
            let account = meta_get(&conn, "account_id")?.ok_or(MailError::NotFound)?;
            let position =
                crate::cached_done::validate_with_prefix(&paging, &account, "cached-trash-v1:")?;
            let mut stmt = conn.prepare(
                "WITH candidates AS (
                    SELECT f.conversation_id, COALESCE(
                        (SELECT MAX(m.sent_at) FROM gmail_messages m WHERE m.account_id = f.account_id AND m.conversation_id = f.conversation_id),
                        s.last_message_at, '') AS date
                    FROM gmail_message_facts f LEFT JOIN gmail_operation_snapshots s
                    ON s.account_id = f.account_id AND s.conversation_id = f.conversation_id
                    WHERE f.account_id = ?1 AND f.in_trash = 1
                    AND (s.conversation_id IS NOT NULL OR EXISTS (SELECT 1 FROM gmail_conversations c
                        WHERE c.account_id = f.account_id AND c.conversation_id = f.conversation_id))
                    GROUP BY f.conversation_id)
                 SELECT date, conversation_id FROM candidates
                 WHERE ?2 IS NULL OR date < ?2 OR (date = ?2 AND conversation_id > ?3)
                 ORDER BY date DESC, conversation_id ASC LIMIT ?4"
            ).map_err(|_| MailError::StorageUnavailable)?;
            let candidates = stmt
                .query_map(
                    params![
                        account,
                        position.as_ref().map(|p| &p.0),
                        position.as_ref().map(|p| &p.1),
                        request.limit + 1
                    ],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .map_err(|_| MailError::StorageUnavailable)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| MailError::StorageUnavailable)?;
            (candidates, meta_get(&conn, "last_synced_at")?)
        };
        let mut conversations = Vec::new();
        for (_, id) in candidates.iter().take(request.limit as usize) {
            let conversation = match self.get_conversation(&ConversationRef {
                account_id: request.account_id.clone(),
                conversation_id: id.clone(),
            }) {
                Ok(conversation) => conversation,
                Err(MailError::NotFound) => continue,
                Err(error) => return Err(error),
            };
            let has_attachments = crate::search::has_attachments(&conversation);
            conversations.push(ConversationSummary {
                stars: conversation.stars,
                conversation_ref: conversation.conversation_ref,
                subject: conversation.subject,
                participants: participants_of(&conversation.messages),
                primary_correspondent: conversation.messages.last().map(|m| m.from.clone()),
                preview: preview_of(&conversation.messages),
                last_message_at: conversation
                    .messages
                    .last()
                    .map(|m| m.sent_at.clone())
                    .unwrap_or_default(),
                is_read: conversation.is_read,
                has_attachments,
                pending_operation_id: conversation.pending_operation_id,
            });
        }
        let page = crate::cached_done::finish(&paging, &candidates, conversations, last_synced_at);
        Ok(crate::dto::CachedTrashSnapshot {
            conversations: page.conversations,
            next_cursor: page
                .next_cursor
                .map(|cursor| cursor.replacen("cached-done-v1:", "cached-trash-v1:", 1)),
            coverage: crate::dto::CachedTrashCoverage::LocalCache,
            exact_total: None,
            last_synced_at: page.last_synced_at,
        })
    }
}
