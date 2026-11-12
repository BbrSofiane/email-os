use super::*;

impl GmailStore {
    pub(crate) fn list_reminders(&self) -> Result<Vec<crate::reminders::Reminder>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let account = meta_get(&conn, "account_id")?;
        let Some(account) = account else {
            return Ok(Vec::new());
        };
        let mut stmt = conn
            .prepare(
                "SELECT data FROM gmail_reminders WHERE account_id=?1 ORDER BY conversation_id",
            )
            .map_err(storage_err())?;
        let rows = stmt
            .query_map([account], |row| row.get::<_, String>(0))
            .map_err(storage_err())?;
        rows.map(|row| serde_json::from_str(&row.map_err(storage_err())?).map_err(storage_err()))
            .collect()
    }

    pub(crate) fn put_reminder(
        &self,
        c: &crate::reminders::PutReminder,
    ) -> Result<crate::reminders::Reminder, MailError> {
        use crate::reminders::{Reminder, ReminderPhase};
        use chrono::DateTime;
        self.persistence_gate()?;
        if c.request_id.is_empty() || c.request_id.len() > 128 {
            return Err(MailError::InvalidRequest {
                field: "requestId".into(),
            });
        }
        let payload = serde_json::to_string(c).map_err(storage_err())?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        let account = meta_get(&tx, "account_id")?.ok_or(MailError::NotFound)?;
        if account != c.conversation.account_id {
            return Err(MailError::NotFound);
        }
        if let Some((old, receipt)) = tx.query_row("SELECT payload,receipt FROM gmail_reminder_requests WHERE account_id=?1 AND request_id=?2", params![account,c.request_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(storage_err())? {
            if old != payload { return Err(MailError::RequestIdConflict); }
            let result = serde_json::from_str(&receipt).map_err(storage_err())?;
            tx.commit().map_err(storage_err())?;
            return Ok(result);
        }
        if let Some(due) = &c.due_at {
            let parsed =
                DateTime::parse_from_rfc3339(due).map_err(|_| MailError::InvalidRequest {
                    field: "dueAt".into(),
                })?;
            let now = DateTime::parse_from_rfc3339(&self.clock.now_iso()).map_err(storage_err())?;
            if due.len() > 40
                || parsed <= now
                || parsed.timestamp_subsec_nanos() != 0
                || due.contains(":60")
            {
                return Err(MailError::InvalidRequest {
                    field: "dueAt".into(),
                });
            }
        }
        let existing: Option<String> = tx
            .query_row(
                "SELECT data FROM gmail_reminders WHERE account_id=?1 AND conversation_id=?2",
                params![account, c.conversation.conversation_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_err())?;
        let mut baseline: Vec<String>;
        let snapshot: Option<String>;
        let revision;
        if let Some(data) = existing {
            let mut prior: Reminder = serde_json::from_str(&data).map_err(storage_err())?;
            if c.expected_revision == Some(prior.revision)
                && prior.phase == ReminderPhase::Pending
                && prior.source_message_id == c.source_message_id
            {
                let raw: (String, String) = tx.query_row(
                    "SELECT baseline_ids,snapshot_json FROM gmail_reminders WHERE account_id=?1 AND conversation_id=?2",
                    params![account, c.conversation.conversation_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                ).map_err(storage_err())?;
                baseline = serde_json::from_str(&raw.0).map_err(storage_err())?;
                snapshot = Some(raw.1);
                prior.revision =
                    prior
                        .revision
                        .checked_add(1)
                        .ok_or(MailError::InvalidRequest {
                            field: "revision".into(),
                        })?;
                prior.due_at = c.due_at.clone();
                prior.condition = c.condition;
                prior.phase = ReminderPhase::Pending;
                revision = prior;
            } else if c.expected_revision.is_none()
                && matches!(
                    prior.phase,
                    ReminderPhase::Returned | ReminderPhase::Cancelled | ReminderPhase::Suppressed
                )
            {
                let next_revision =
                    prior
                        .revision
                        .checked_add(1)
                        .ok_or(MailError::InvalidRequest {
                            field: "revision".into(),
                        })?;
                let built = build_conversation(&tx, &account, &c.conversation.conversation_id)?
                    .ok_or(MailError::NotFound)?;
                if built.messages.last().map(|m| m.id.as_str())
                    != Some(c.source_message_id.as_str())
                {
                    return Err(MailError::InvalidRequest {
                        field: "sourceMessageId".into(),
                    });
                }
                let (inbox, _, _) =
                    effective_conversation_state(&tx, &account, &c.conversation.conversation_id)?;
                let pending_intent: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM gmail_operations WHERE account_id=?1 AND conversation_id=?2 AND status IN ('queued','applying','outcome_unknown'))",
                    params![account, c.conversation.conversation_id],
                    |row| row.get(0),
                ).map_err(storage_err())?;
                if !inbox || pending_intent {
                    return Err(MailError::InvalidRequest {
                        field: "conversation".into(),
                    });
                }
                let mut baseline_stmt = tx.prepare("SELECT message_id FROM gmail_message_facts WHERE account_id=?1 AND conversation_id=?2 ORDER BY message_id").map_err(storage_err())?;
                baseline = baseline_stmt
                    .query_map(params![account, c.conversation.conversation_id], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(storage_err())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(storage_err())?;
                if baseline.is_empty() {
                    baseline = built.messages.iter().map(|m| m.id.clone()).collect();
                }
                let pinned = crate::dto::Conversation {
                    stars: None,
                    conversation_ref: built.conversation_ref.clone(),
                    subject: built.subject.clone(),
                    messages: built.messages.clone(),
                    is_in_inbox: true,
                    is_read: None,
                    context_complete: built.context_complete,
                    unsupported_reason: built.unsupported_reason.clone(),
                    retained_snapshot_at: Some(self.clock.now_iso()),
                    reply_context: built.reply_context.clone(),
                    pending_operation_id: None,
                };
                snapshot = Some(serde_json::to_string(&pinned).map_err(storage_err())?);
                revision = Reminder {
                    conversation: c.conversation.clone(),
                    subject: built.subject,
                    revision: next_revision,
                    source_message_id: c.source_message_id.clone(),
                    due_at: c.due_at.clone(),
                    condition: c.condition,
                    phase: ReminderPhase::Pending,
                };
            } else {
                return Err(MailError::InvalidRequest {
                    field: "revision".into(),
                });
            }
        } else {
            if c.expected_revision.is_some() {
                return Err(MailError::NotFound);
            }
            let built = build_conversation(&tx, &account, &c.conversation.conversation_id)?
                .ok_or(MailError::NotFound)?;
            if built.messages.last().map(|m| m.id.as_str()) != Some(c.source_message_id.as_str()) {
                return Err(MailError::InvalidRequest {
                    field: "sourceMessageId".into(),
                });
            }
            let (inbox, _, _) =
                effective_conversation_state(&tx, &account, &c.conversation.conversation_id)?;
            let pending_intent: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM gmail_operations WHERE account_id=?1 AND conversation_id=?2 AND status IN ('queued','applying','outcome_unknown'))",
                params![account, c.conversation.conversation_id],
                |row| row.get(0),
            ).map_err(storage_err())?;
            if !inbox || pending_intent {
                return Err(MailError::InvalidRequest {
                    field: "conversation".into(),
                });
            }
            let mut baseline_stmt = tx
                .prepare(
                    "SELECT message_id FROM gmail_message_facts
                     WHERE account_id=?1 AND conversation_id=?2 ORDER BY message_id",
                )
                .map_err(storage_err())?;
            baseline = baseline_stmt
                .query_map(params![account, c.conversation.conversation_id], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(storage_err())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage_err())?;
            if baseline.is_empty() {
                baseline = built.messages.iter().map(|m| m.id.clone()).collect();
            }
            let pinned = crate::dto::Conversation {
                stars: None,
                conversation_ref: built.conversation_ref.clone(),
                subject: built.subject.clone(),
                messages: built.messages.clone(),
                is_in_inbox: true,
                is_read: None,
                context_complete: built.context_complete,
                unsupported_reason: built.unsupported_reason.clone(),
                retained_snapshot_at: Some(self.clock.now_iso()),
                reply_context: built.reply_context.clone(),
                pending_operation_id: None,
            };
            snapshot = Some(serde_json::to_string(&pinned).map_err(storage_err())?);
            revision = Reminder {
                conversation: c.conversation.clone(),
                subject: built.subject,
                revision: 1,
                source_message_id: c.source_message_id.clone(),
                due_at: c.due_at.clone(),
                condition: c.condition,
                phase: ReminderPhase::Pending,
            };
        }
        let snapshot = snapshot.ok_or_else(|| storage_fault("missing_persisted_row"))?;
        tx.execute("INSERT INTO gmail_reminders(account_id,conversation_id,data,baseline_ids,snapshot_json) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(account_id,conversation_id) DO UPDATE SET data=excluded.data, baseline_ids=excluded.baseline_ids, snapshot_json=excluded.snapshot_json", params![account,c.conversation.conversation_id,serde_json::to_string(&revision).map_err(storage_err())?,serde_json::to_string(&baseline).map_err(storage_err())?,snapshot]).map_err(storage_err())?;
        let receipt = serde_json::to_string(&revision).map_err(storage_err())?;
        tx.execute(
            "INSERT INTO gmail_reminder_requests VALUES (?1,?2,?3,?4)",
            params![account, c.request_id, payload, receipt],
        )
        .map_err(storage_err())?;
        tx.commit().map_err(storage_err())?;
        Ok(revision)
    }

    pub(crate) fn cancel_reminder(
        &self,
        c: &crate::reminders::CancelReminder,
    ) -> Result<crate::reminders::Reminder, MailError> {
        use crate::reminders::{Reminder, ReminderPhase};
        self.persistence_gate()?;
        if c.request_id.is_empty() || c.request_id.len() > 128 {
            return Err(MailError::InvalidRequest {
                field: "requestId".into(),
            });
        }
        let payload = serde_json::to_string(c).map_err(storage_err())?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        let account = meta_get(&tx, "account_id")?.ok_or(MailError::NotFound)?;
        if account != c.conversation.account_id {
            return Err(MailError::NotFound);
        }
        if let Some((old, receipt)) = tx.query_row("SELECT payload,receipt FROM gmail_reminder_requests WHERE account_id=?1 AND request_id=?2", params![account,c.request_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(storage_err())? {
            if old != payload { return Err(MailError::RequestIdConflict); }
            return serde_json::from_str(&receipt).map_err(storage_err());
        }
        let data: String = tx
            .query_row(
                "SELECT data FROM gmail_reminders WHERE account_id=?1 AND conversation_id=?2",
                params![account, c.conversation.conversation_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_err())?
            .ok_or(MailError::NotFound)?;
        let mut result: Reminder = serde_json::from_str(&data).map_err(storage_err())?;
        if result.revision != c.expected_revision || result.phase != ReminderPhase::Pending {
            return Err(MailError::InvalidRequest {
                field: "revision".into(),
            });
        }
        result.revision = result
            .revision
            .checked_add(1)
            .ok_or(MailError::InvalidRequest {
                field: "revision".into(),
            })?;
        result.phase = ReminderPhase::Cancelled;
        let receipt = serde_json::to_string(&result).map_err(storage_err())?;
        tx.execute(
            "UPDATE gmail_reminders SET data=?3 WHERE account_id=?1 AND conversation_id=?2",
            params![account, c.conversation.conversation_id, receipt],
        )
        .map_err(storage_err())?;
        tx.execute(
            "INSERT INTO gmail_reminder_requests VALUES (?1,?2,?3,?4)",
            params![account, c.request_id, payload, receipt],
        )
        .map_err(storage_err())?;
        tx.commit().map_err(storage_err())?;
        Ok(result)
    }

    pub(crate) fn due_reminders(
        &self,
    ) -> Result<Vec<(crate::reminders::Reminder, Vec<String>)>, MailError> {
        self.persistence_gate()?;
        let now =
            chrono::DateTime::parse_from_rfc3339(&self.clock.now_iso()).map_err(storage_err())?;
        let conn = self.lock_conn()?;
        let account = meta_get(&conn, "account_id")?;
        let Some(account) = account else {
            return Ok(Vec::new());
        };
        let mut stmt = conn
            .prepare("SELECT data,baseline_ids FROM gmail_reminders WHERE account_id=?1")
            .map_err(storage_err())?;
        let rows = stmt
            .query_map([account], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(storage_err())?;
        let mut due = Vec::new();
        for row in rows {
            let (data, baseline) = row.map_err(storage_err())?;
            let reminder: crate::reminders::Reminder =
                serde_json::from_str(&data).map_err(storage_err())?;
            if reminder.phase == crate::reminders::ReminderPhase::Pending
                && reminder
                    .due_at
                    .as_ref()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .is_some_and(|at| at <= now)
            {
                due.push((
                    reminder,
                    serde_json::from_str(&baseline).map_err(storage_err())?,
                ));
            }
        }
        Ok(due)
    }

    pub(crate) fn reminder_wait(&self) -> Result<Option<std::time::Duration>, MailError> {
        self.persistence_gate()?;
        let now =
            chrono::DateTime::parse_from_rfc3339(&self.clock.now_iso()).map_err(storage_err())?;
        let conn = self.lock_conn()?;
        let Some(account) = meta_get(&conn, "account_id")? else {
            return Ok(None);
        };
        let mut stmt = conn
            .prepare("SELECT data FROM gmail_reminders WHERE account_id=?1")
            .map_err(storage_err())?;
        let rows = stmt
            .query_map([account], |r| r.get::<_, String>(0))
            .map_err(storage_err())?;
        let mut next = None;
        for row in rows {
            let reminder: crate::reminders::Reminder =
                serde_json::from_str(&row.map_err(storage_err())?).map_err(storage_err())?;
            if reminder.phase == crate::reminders::ReminderPhase::Pending {
                if let Some(at) = reminder
                    .due_at
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
                {
                    let wait = if at <= now {
                        if reminder.condition == crate::reminders::ReminderCondition::IfNoReply {
                            std::time::Duration::from_secs(60)
                        } else {
                            std::time::Duration::ZERO
                        }
                    } else {
                        (at - now).to_std().unwrap_or_default()
                    };
                    next =
                        Some(next.map_or(wait, |current: std::time::Duration| current.min(wait)));
                }
            }
        }
        Ok(next)
    }

    pub(crate) fn finish_due_reminder(
        &self,
        reminder: &crate::reminders::Reminder,
        generation: u64,
        observation: u64,
        replied: bool,
    ) -> Result<bool, MailError> {
        self.finish_due_reminder_with_thread(reminder, generation, observation, replied, None)
    }

    pub(crate) fn finish_due_reminder_with_thread(
        &self,
        reminder: &crate::reminders::Reminder,
        generation: u64,
        observation: u64,
        replied: bool,
        fetched: Option<&GmailThread>,
    ) -> Result<bool, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(storage_err())?;
        if !generation_matches(&tx, generation)?
            || tx.total_changes() != observation
            || meta_get(&tx, "account_id")?.as_deref() != Some(&reminder.conversation.account_id)
        {
            return Ok(false);
        }
        let data: Option<String> = tx
            .query_row(
                "SELECT data FROM gmail_reminders WHERE account_id=?1 AND conversation_id=?2",
                params![
                    reminder.conversation.account_id,
                    reminder.conversation.conversation_id
                ],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_err())?;
        let Some(data) = data else { return Ok(false) };
        let mut current: crate::reminders::Reminder =
            serde_json::from_str(&data).map_err(storage_err())?;
        if current.revision != reminder.revision
            || current.phase != crate::reminders::ReminderPhase::Pending
        {
            return Ok(false);
        }
        // Check the captured observation and reminder revision before any merge.
        // Fresh provider facts and the local transition commit together.
        if let Some(thread) = fetched {
            if thread.conversation.conversation_ref != reminder.conversation {
                return Err(MailError::InvalidProviderResponse);
            }
            upsert_thread(&tx, &reminder.conversation.account_id, thread)?;
            trim_cache(&tx, &reminder.conversation.account_id)?;
        }
        current.phase =
            if current.condition == crate::reminders::ReminderCondition::IfNoReply && replied {
                crate::reminders::ReminderPhase::Suppressed
            } else {
                crate::reminders::ReminderPhase::Returned
            };
        current.revision = current
            .revision
            .checked_add(1)
            .ok_or(MailError::InvalidRequest {
                field: "revision".into(),
            })?;
        tx.execute(
            "UPDATE gmail_reminders SET data=?3 WHERE account_id=?1 AND conversation_id=?2",
            params![
                reminder.conversation.account_id,
                reminder.conversation.conversation_id,
                serde_json::to_string(&current).map_err(storage_err())?
            ],
        )
        .map_err(storage_err())?;
        tx.commit().map_err(storage_err())?;
        Ok(true)
    }
}
