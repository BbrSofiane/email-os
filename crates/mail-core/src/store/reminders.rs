use super::*;
use crate::reminders::*;
use crate::storage_log::storage_err;

#[track_caller]
fn storage<T>(result: rusqlite::Result<T>) -> Result<T, MailError> {
    result.map_err(storage_err())
}
fn invalid(field: &str) -> MailError {
    MailError::InvalidRequest {
        field: field.into(),
    }
}
#[track_caller]
fn json<T: serde::Serialize>(value: &T) -> Result<String, MailError> {
    serde_json::to_string(value).map_err(storage_err())
}
fn parse<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, MailError> {
    serde_json::from_str(value).map_err(storage_err())
}
pub(super) fn migrate(tx: &Connection) -> Result<(), MailError> {
    storage(tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS reminders (
        conversation_id TEXT PRIMARY KEY, data TEXT NOT NULL,
        baseline TEXT NOT NULL, restore_ids TEXT NOT NULL,
        remove_op TEXT NOT NULL, current_op TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reminder_receipts (
        request_id TEXT PRIMARY KEY, payload TEXT NOT NULL, receipt TEXT NOT NULL);",
    ))
}
fn load(conn: &Connection, id: &str) -> Result<Option<Reminder>, MailError> {
    let data: Option<String> = storage(
        conn.query_row(
            "SELECT data FROM reminders WHERE conversation_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional(),
    )?;
    data.map(|s| parse(&s)).transpose()
}
fn save(conn: &Connection, r: &Reminder) -> Result<(), MailError> {
    storage(conn.execute(
        "UPDATE reminders SET data=?2 WHERE conversation_id=?1",
        params![r.conversation.conversation_id, json(r)?],
    ))?;
    Ok(())
}
fn replay(conn: &Connection, key: &str, payload: &str) -> Result<Option<Reminder>, MailError> {
    if key.is_empty() || key.len() > 128 {
        return Err(invalid("requestId"));
    }
    let row: Option<(String, String)> = storage(
        conn.query_row(
            "SELECT payload,receipt FROM reminder_receipts WHERE request_id=?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional(),
    )?;
    match row {
        Some((p, r)) if p == payload => Ok(Some(parse(&r)?)),
        Some(_) => Err(MailError::RequestIdConflict),
        None => Ok(None),
    }
}
fn receipt(conn: &Connection, key: &str, payload: &str, r: &Reminder) -> Result<(), MailError> {
    storage(conn.execute(
        "INSERT INTO reminder_receipts VALUES (?1,?2,?3)",
        params![key, payload, json(r)?],
    ))?;
    Ok(())
}
fn op(
    conn: &Connection,
    id: &str,
    ids: &[String],
    archived: bool,
    now: &str,
) -> Result<String, MailError> {
    let operation_id = format!("reminder-{}", uuid::Uuid::new_v4());
    storage(conn.execute("INSERT INTO operations
        (operation_id,account_id,conversation_id,requested_archived,status,accepted_at,message_ids,request_id)
        VALUES (?1,?2,?3,?4,'queued',?5,?6,?1)", params![operation_id,ACCOUNT_ID,id,archived,now,json(&ids)?]))?;
    Ok(operation_id)
}
fn status(conn: &Connection, id: &str) -> Result<String, MailError> {
    storage(conn.query_row(
        "SELECT status FROM operations WHERE operation_id=?1",
        [id],
        |r| r.get(0),
    ))
}
fn superseded(conn: &Connection, id: &str) -> Result<bool, MailError> {
    storage(conn.query_row("SELECT EXISTS(SELECT 1 FROM operations o JOIN reminders r ON r.conversation_id=o.conversation_id
        WHERE r.conversation_id=?1 AND o.seq>(SELECT seq FROM operations WHERE operation_id=r.remove_op)
        AND o.operation_id != r.current_op AND o.operation_id NOT LIKE 'reminder-%'
        AND o.status != 'cancelled')", [id], |r| r.get(0)))
}
fn bump(r: &mut Reminder) -> Result<(), MailError> {
    r.revision = r
        .revision
        .checked_add(1)
        .ok_or_else(|| invalid("revision"))?;
    Ok(())
}
impl Store {
    pub(crate) fn list_reminders(&self) -> Result<Vec<Reminder>, MailError> {
        self.persistence_gate()?;
        let conn = self.lock_conn()?;
        let mut stmt =
            storage(conn.prepare("SELECT data FROM reminders ORDER BY conversation_id"))?;
        let rows = storage(stmt.query_map([], |r| r.get::<_, String>(0)))?;
        rows.map(|row| parse(&storage(row)?)).collect()
    }
    pub(crate) fn put_reminder(&self, c: &PutReminder) -> Result<Reminder, MailError> {
        if c.conversation.account_id != ACCOUNT_ID {
            return Err(MailError::NotFound);
        }
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = storage(conn.transaction())?;
        let payload = format!("put:{}", json(c)?);
        if let Some(r) = replay(&tx, &c.request_id, &payload)? {
            return Ok(r);
        }
        if let Some(due) = &c.due_at {
            let parsed = chrono::DateTime::parse_from_rfc3339(due).map_err(|_| invalid("dueAt"))?;
            let now = chrono::DateTime::parse_from_rfc3339(&self.clock.now_iso())
                .map_err(storage_err())?;
            if due.len() > 40
                || parsed.timestamp() <= now.timestamp()
                || parsed.timestamp_subsec_nanos() != 0
                || due.contains(":60")
            {
                return Err(invalid("dueAt"));
            }
        }
        let previous = load(&tx, &c.conversation.conversation_id)?;
        let mut r = if let Some(expected) = c.expected_revision {
            let mut r = previous.ok_or(MailError::NotFound)?;
            if r.revision != expected
                || r.phase != ReminderPhase::Pending
                || r.source_message_id != c.source_message_id
                || superseded(&tx, &c.conversation.conversation_id)?
            {
                return Err(invalid("revision"));
            }
            bump(&mut r)?;
            r
        } else {
            if previous.as_ref().is_some_and(|r| {
                !matches!(
                    r.phase,
                    ReminderPhase::Returned | ReminderPhase::Cancelled | ReminderPhase::Suppressed
                )
            }) {
                return Err(invalid("revision"));
            }
            let view = build_conversation_view(&tx, ACCOUNT_ID, &c.conversation.conversation_id)?;
            if view.messages.last().map(|m| m.id.as_str()) != Some(c.source_message_id.as_str()) {
                return Err(invalid("sourceMessageId"));
            }
            let inflight: bool = storage(tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE conversation_id=?1 AND status IN ('queued','applying'))", [&c.conversation.conversation_id], |r|r.get(0)))?;
            if inflight {
                return Err(invalid("pendingOperation"));
            }
            let baseline = snapshot_message_ids(&tx, ACCOUNT_ID, &c.conversation.conversation_id)?;
            if baseline.len() > 1000 {
                return Err(invalid("targets"));
            }
            let ids: Vec<String> = baseline
                .iter()
                .filter(|id| view.effective_inbox.get(*id) == Some(&true))
                .cloned()
                .collect();
            if ids.is_empty() {
                return Err(invalid("inbox"));
            }
            let operation = op(
                &tx,
                &c.conversation.conversation_id,
                &ids,
                true,
                &self.clock.now_iso(),
            )?;
            let r = Reminder {
                conversation: c.conversation.clone(),
                subject: view.subject,
                revision: previous.map_or(Ok(1), |r| {
                    r.revision.checked_add(1).ok_or_else(|| invalid("revision"))
                })?,
                source_message_id: c.source_message_id.clone(),
                due_at: c.due_at.clone(),
                condition: c.condition,
                phase: ReminderPhase::Removing,
            };
            storage(tx.execute(
                "INSERT OR REPLACE INTO reminders VALUES (?1,?2,?3,?4,?5,?5)",
                params![
                    c.conversation.conversation_id,
                    json(&r)?,
                    json(&baseline)?,
                    json(&ids)?,
                    operation
                ],
            ))?;
            r
        };
        r.due_at = c.due_at.clone();
        r.condition = c.condition;
        save(&tx, &r)?;
        receipt(&tx, &c.request_id, &payload, &r)?;
        storage(tx.commit())?;
        Ok(r)
    }
    pub(crate) fn cancel_reminder(&self, c: &CancelReminder) -> Result<Reminder, MailError> {
        if c.conversation.account_id != ACCOUNT_ID {
            return Err(MailError::NotFound);
        }
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = storage(conn.transaction())?;
        let payload = format!("cancel:{}", json(c)?);
        if let Some(r) = replay(&tx, &c.request_id, &payload)? {
            return Ok(r);
        }
        let mut r = load(&tx, &c.conversation.conversation_id)?.ok_or(MailError::NotFound)?;
        if r.revision != c.expected_revision
            || matches!(
                r.phase,
                ReminderPhase::Cancelled
                    | ReminderPhase::Suppressed
                    | ReminderPhase::Returned
                    | ReminderPhase::Cancelling
            )
        {
            return Err(invalid("revision"));
        }
        bump(&mut r)?;
        if superseded(&tx, &c.conversation.conversation_id)? {
            r.phase = ReminderPhase::Cancelled;
        } else {
            stage_restore(
                &tx,
                &mut r,
                &self.clock.now_iso(),
                ReminderPhase::Cancelling,
            )?;
        }
        save(&tx, &r)?;
        receipt(&tx, &c.request_id, &payload, &r)?;
        storage(tx.commit())?;
        Ok(r)
    }
    /// Complete synthetic provider inventory is read inside the transition transaction.
    /// This is deliberately not exposed for Gmail's incomplete local cache.
    pub(crate) fn reconcile_reminders(&self) -> Result<bool, MailError> {
        self.persistence_gate()?;
        let mut conn = self.lock_conn()?;
        let tx = storage(conn.transaction())?;
        let all: Vec<String> = {
            let mut stmt = storage(tx.prepare("SELECT data FROM reminders"))?;
            let rows = storage(stmt.query_map([], |r| r.get::<_, String>(0)))?;
            rows.map(storage).collect::<Result<_, _>>()?
        };
        let now = self.clock.now_iso();
        let now_instant = chrono::DateTime::parse_from_rfc3339(&now).map_err(storage_err())?;
        let mut changed = false;
        for data in all {
            let mut r: Reminder = parse(&data)?;
            let original = r.clone();
            let id = &r.conversation.conversation_id;
            let (current, baseline): (String, String) = storage(tx.query_row(
                "SELECT current_op,baseline FROM reminders WHERE conversation_id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ))?;
            match r.phase {
                ReminderPhase::Removing | ReminderPhase::Returning | ReminderPhase::Cancelling => {
                    match status(&tx, &current)?.as_str() {
                        "confirmed" => {
                            r.phase = match r.phase {
                                ReminderPhase::Removing => ReminderPhase::Pending,
                                ReminderPhase::Returning => ReminderPhase::Returned,
                                _ => ReminderPhase::Cancelled,
                            }
                        }
                        "failed" | "cancelled" => r.phase = ReminderPhase::Failed,
                        _ => {}
                    }
                }
                _ => {}
            }
            if r.phase == ReminderPhase::Pending {
                if superseded(&tx, id)? {
                    r.phase = ReminderPhase::Failed;
                } else if r.due_at.as_ref().is_some_and(|due| {
                    chrono::DateTime::parse_from_rfc3339(due).is_ok_and(|d| d <= now_instant)
                }) {
                    let baseline: Vec<String> = parse(&baseline)?;
                    let conversation = build_conversation_view(&tx, ACCOUNT_ID, id)?;
                    let replied = conversation.messages.iter().any(|m| {
                        !baseline.contains(&m.id)
                            && !m.from.mailbox.eq_ignore_ascii_case(crate::FIXTURE_MAILBOX)
                    });
                    if r.condition == ReminderCondition::IfNoReply && replied {
                        r.phase = ReminderPhase::Suppressed;
                    } else {
                        stage_restore(&tx, &mut r, &now, ReminderPhase::Returning)?;
                    }
                }
            }
            if r != original {
                bump(&mut r)?;
                save(&tx, &r)?;
                changed = true;
            }
        }
        storage(tx.commit())?;
        Ok(changed)
    }
}
fn stage_restore(
    tx: &Connection,
    r: &mut Reminder,
    now: &str,
    phase: ReminderPhase,
) -> Result<(), MailError> {
    let ids: String = storage(tx.query_row(
        "SELECT restore_ids FROM reminders WHERE conversation_id=?1",
        [&r.conversation.conversation_id],
        |row| row.get(0),
    ))?;
    let ids: Vec<String> = parse(&ids)?;
    let operation = op(tx, &r.conversation.conversation_id, &ids, false, now)?;
    storage(tx.execute(
        "UPDATE reminders SET current_op=?2 WHERE conversation_id=?1",
        params![r.conversation.conversation_id, operation],
    ))?;
    r.phase = phase;
    Ok(())
}
