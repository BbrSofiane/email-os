use super::*;

pub(super) fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, MailError> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|_| MailError::StorageUnavailable)
}

pub(super) fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), MailError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    Ok(())
}

pub(super) fn meta_del(conn: &Connection, key: &str) -> Result<(), MailError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", params![key])
        .map_err(|_| MailError::StorageUnavailable)?;
    Ok(())
}

pub(super) fn generation_of(conn: &Connection) -> Result<u64, MailError> {
    Ok(meta_get(conn, "generation")?
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0))
}

/// Guard evaluated inside every checkpointed write transaction: writes from a
/// pass that raced a disconnect are discarded, never applied.
pub(super) fn generation_matches(conn: &Connection, expected: u64) -> Result<bool, MailError> {
    Ok(generation_of(conn)? == expected)
}

/// Invariant: checkpointed writes require a connected account. Violation
/// fails closed instead of writing unscoped rows.
pub(super) fn account_id_of(conn: &Connection) -> Result<String, MailError> {
    meta_get(conn, "account_id")?.ok_or(MailError::StorageUnavailable)
}

/// Observed Trash/Spam is not Done, even when older archive evidence exists.
pub(super) fn has_excluded_membership(
    conn: &Connection,
    account: &str,
    id: &str,
) -> Result<bool, MailError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM gmail_message_facts
        WHERE account_id = ?1 AND conversation_id = ?2 AND (in_trash = 1 OR in_spam = 1))",
        params![account, id],
        |row| row.get(0),
    )
    .map_err(|_| MailError::StorageUnavailable)
}

/// Replaces one thread's cached facts atomically. Effective INBOX membership
/// is derived from `inbox_message_ids`, never trusted from the provider
/// conversation flags. Pathological provider data (empty ids) fails typed.
pub(super) fn upsert_thread(
    conn: &Connection,
    account_id: &str,
    thread: &GmailThread,
) -> Result<(), MailError> {
    if thread.conversation.conversation_ref.account_id != account_id {
        return Err(MailError::InvalidProviderResponse);
    }
    let conversation_id = &thread.conversation.conversation_ref.conversation_id;
    if conversation_id.is_empty() {
        return Err(MailError::InvalidProviderResponse);
    }
    if !thread.inbox_message_ids.is_empty() {
        conn.execute(
            "DELETE FROM gmail_search_cache WHERE account_id=?1 AND conversation_id=?2",
            params![account_id, conversation_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    }
    if thread.inbox_message_ids.is_empty() {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM gmail_conversations
                 WHERE account_id = ?1 AND conversation_id = ?2)",
                params![account_id, conversation_id],
                |row| row.get(0),
            )
            .map_err(|_| MailError::StorageUnavailable)?;
        if !exists {
            // History can mention arbitrarily old archived threads. Keep their
            // bodies out of the bounded cache, but refresh facts needed by a
            // durable operation's recovery view and future target snapshots.
            let retained_by_operation: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM gmail_operation_targets
                     WHERE account_id = ?1 AND conversation_id = ?2)",
                    params![account_id, conversation_id],
                    |row| row.get(0),
                )
                .map_err(|_| MailError::StorageUnavailable)?;
            if retained_by_operation {
                upsert_message_facts(conn, account_id, thread)?;
            }
            return Ok(());
        }
    }
    conn.execute(
        "INSERT INTO gmail_conversations
            (account_id, conversation_id, subject, context_complete, unsupported_reason,
             reply_context_json, newest_sender_json, attachments_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(account_id, conversation_id) DO UPDATE SET
            subject = excluded.subject,
            context_complete = excluded.context_complete,
            unsupported_reason = excluded.unsupported_reason,
            reply_context_json = excluded.reply_context_json,
            newest_sender_json = excluded.newest_sender_json,
            attachments_json = excluded.attachments_json",
        params![
            account_id,
            conversation_id,
            thread.conversation.subject,
            thread.conversation.context_complete.unwrap_or(false) as i64,
            thread.conversation.unsupported_reason,
            thread
                .conversation
                .reply_context
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|_| MailError::StorageUnavailable)?,
            thread
                .newest_sender
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|_| MailError::StorageUnavailable)?,
            serde_json::to_string(&thread.attachments)
                .map_err(|_| MailError::StorageUnavailable)?,
        ],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    conn.execute(
        "DELETE FROM gmail_messages WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    conn.execute(
        "DELETE FROM gmail_inbox_membership WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    for message_id in &thread.inbox_message_ids {
        conn.execute(
            "INSERT INTO gmail_inbox_membership (account_id, conversation_id, message_id)
             VALUES (?1, ?2, ?3)",
            params![account_id, conversation_id, message_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    }
    upsert_message_facts(conn, account_id, thread)?;
    for message in &thread.conversation.messages {
        let in_inbox = thread.inbox_message_ids.iter().any(|id| id == &message.id);
        let to_json =
            serde_json::to_string(&message.to).map_err(|_| MailError::StorageUnavailable)?;
        conn.execute(
            "INSERT OR REPLACE INTO gmail_messages
                (account_id, conversation_id, message_id, from_display, from_mailbox,
                 to_json, sent_at, body_text, in_inbox, has_attachment)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                account_id,
                conversation_id,
                message.id,
                message.from.display_name,
                message.from.mailbox,
                to_json,
                message.sent_at,
                message.body_text,
                in_inbox as i64,
                message.has_attachment.map(|present| present as i64),
            ],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    }
    Ok(())
}

/// Replaces provider facts without requiring body-cache admission. Operation-
/// retained archived conversations still need current inventory and labels for
/// recovery reads and future immutable target snapshots.
pub(super) fn upsert_message_facts(
    conn: &Connection,
    account_id: &str,
    thread: &GmailThread,
) -> Result<(), MailError> {
    let conversation_id = &thread.conversation.conversation_ref.conversation_id;
    conn.execute(
        "DELETE FROM gmail_message_facts WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    let mut inventory = thread.message_ids.clone().unwrap_or_else(|| {
        let mut ids = thread.inbox_message_ids.clone();
        for message in &thread.conversation.messages {
            if !ids.contains(&message.id) {
                ids.push(message.id.clone());
            }
        }
        ids
    });
    inventory.sort();
    inventory.dedup();
    for message_id in &inventory {
        let inbox = thread.inbox_message_ids.iter().any(|id| id == message_id) as i64;
        let unread = thread
            .unread_message_ids
            .as_ref()
            .map(|ids| ids.iter().any(|id| id == message_id) as i64);
        conn.execute(
            "INSERT INTO gmail_message_facts (account_id, conversation_id, message_id, in_inbox, is_unread, in_trash, in_spam)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![account_id, conversation_id, message_id, inbox, unread,
                thread.trash_message_ids.as_ref().map(|ids| ids.contains(message_id) as i64),
                thread.spam_message_ids.as_ref().map(|ids| ids.contains(message_id) as i64)],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        conn.execute("UPDATE gmail_message_facts SET is_starred = ?4 WHERE account_id = ?1 AND conversation_id = ?2 AND message_id = ?3",
            params![account_id, conversation_id, message_id, thread.star_facts.as_ref().and_then(|facts| facts.get(message_id).copied()).map(i64::from)])
            .map_err(|_| MailError::StorageUnavailable)?;
    }
    Ok(())
}

pub(super) fn trim_cache(conn: &Connection, account_id: &str) -> Result<(), MailError> {
    evict_over_cap(conn, account_id, false)
}

pub(super) fn trim_discovery_cache(conn: &Connection, account_id: &str) -> Result<(), MailError> {
    evict_over_cap(conn, account_id, true)
}

/// Evicts excess conversations in one transaction. During rediscovery, ids
/// observed in the current pass are retained ahead of old cache entries.
/// Recovery snapshots retain the whole observed inventory/label facts, not just
/// immutable operation targets: later arrivals must survive body eviction too.
/// Conversations without recovery context still lose their non-target facts.
pub(super) fn evict_over_cap(
    conn: &Connection,
    account_id: &str,
    prefer_discovery_seen: bool,
) -> Result<(), MailError> {
    let seen_order = if prefer_discovery_seen {
        "CASE WHEN EXISTS (
             SELECT 1 FROM gmail_discovery_seen s
             WHERE s.conversation_id = c.conversation_id
         ) THEN 0 ELSE 1 END,"
    } else {
        ""
    };
    let sql = format!(
        "SELECT c.conversation_id FROM gmail_conversations c
         LEFT JOIN gmail_messages m
           ON m.account_id = c.account_id
          AND m.conversation_id = c.conversation_id
         WHERE c.account_id = ?1 AND NOT EXISTS (SELECT 1 FROM gmail_reminders r WHERE r.account_id=c.account_id AND r.conversation_id=c.conversation_id AND json_extract(r.data,'$.phase')='pending')
           AND NOT EXISTS (SELECT 1 FROM gmail_search_cache sc WHERE sc.account_id=c.account_id AND sc.conversation_id=c.conversation_id)
         GROUP BY c.conversation_id
         ORDER BY {seen_order} MAX(m.sent_at) DESC, c.conversation_id ASC
         LIMIT -1 OFFSET ?2"
    );
    let evicted = {
        let mut statement = conn
            .prepare(&sql)
            .map_err(|_| MailError::StorageUnavailable)?;
        let rows = statement
            .query_map(params![account_id, DISCOVERY_CAP as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|_| MailError::StorageUnavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| MailError::StorageUnavailable)?;
        rows
    };
    for conversation_id in evicted {
        conn.execute(
            "DELETE FROM gmail_messages WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        conn.execute(
            "DELETE FROM gmail_message_facts
             WHERE account_id = ?1 AND conversation_id = ?2
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
            params![account_id, conversation_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        conn.execute(
            "DELETE FROM gmail_inbox_membership WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        conn.execute(
            "DELETE FROM gmail_conversations WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation_id],
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    }
    Ok(())
}

pub(super) fn delete_conversation(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<(), MailError> {
    conn.execute(
        "DELETE FROM gmail_messages WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    conn.execute(
        "DELETE FROM gmail_inbox_membership WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    conn.execute(
        "DELETE FROM gmail_message_facts WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    conn.execute(
        "DELETE FROM gmail_conversations WHERE account_id = ?1 AND conversation_id = ?2",
        params![account_id, conversation_id],
    )
    .map_err(|_| MailError::StorageUnavailable)?;
    Ok(())
}

pub(super) struct BuiltConversation {
    pub(super) conversation_ref: ConversationRef,
    pub(super) subject: String,
    pub(super) messages: Vec<Message>,
    pub(super) context_complete: Option<bool>,
    pub(super) unsupported_reason: Option<String>,
    pub(super) reply_context: Option<ReplyContext>,
    pub(super) newest_sender: Option<Address>,
}

pub(super) fn build_conversation(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
) -> Result<Option<BuiltConversation>, MailError> {
    let row = conn
        .query_row(
            "SELECT subject, context_complete, unsupported_reason, reply_context_json, newest_sender_json
             FROM gmail_conversations WHERE account_id = ?1 AND conversation_id = ?2",
            params![account_id, conversation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    let Some((subject, context_flag, unsupported_reason, reply_context_json, newest_sender_json)) =
        row
    else {
        return Ok(None);
    };
    let mut stmt = conn
        .prepare(
            "SELECT message_id, from_display, from_mailbox, to_json, sent_at, body_text, in_inbox,
                    has_attachment
             FROM gmail_messages
             WHERE account_id = ?1 AND conversation_id = ?2
             ORDER BY sent_at ASC, message_id ASC",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
    let messages: Vec<(Message, bool)> = stmt
        .query_map(params![account_id, conversation_id], |row| {
            let from_display: Option<String> = row.get(1)?;
            let to_json: String = row.get(3)?;
            // NULL (legacy cache rows) stays unknown; 0/1 are observed facts.
            let has_attachment = row.get::<_, Option<i64>>(7)?.map(|value| value != 0);
            Ok((
                Message {
                    id: row.get(0)?,
                    from: Address {
                        display_name: from_display,
                        mailbox: row.get(2)?,
                    },
                    to: serde_json::from_str(&to_json).map_err(|_| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            "invalid address JSON".into(),
                        )
                    })?,
                    sent_at: row.get(4)?,
                    body_text: row.get(5)?,
                    has_attachment,
                },
                row.get::<_, i64>(6)? != 0,
            ))
        })
        .map_err(|_| MailError::StorageUnavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| MailError::StorageUnavailable)?;
    Ok(Some(BuiltConversation {
        conversation_ref: ConversationRef {
            account_id: account_id.to_string(),
            conversation_id: conversation_id.to_string(),
        },
        subject,
        messages: messages.into_iter().map(|(message, _)| message).collect(),
        newest_sender: newest_sender_json
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(|_| MailError::StorageUnavailable)?,
        context_complete: Some(context_flag != 0),
        unsupported_reason,
        reply_context: reply_context_json
            .map(|json| serde_json::from_str::<ReplyContext>(&json))
            .transpose()
            .map_err(|_| MailError::StorageUnavailable)?,
    }))
}

pub(super) fn participants_of(messages: &[Message]) -> Vec<Address> {
    let mut seen_mailboxes: Vec<String> = Vec::new();
    let mut participants: Vec<Address> = Vec::new();
    for message in messages {
        let mut push = |address: &Address| {
            if !seen_mailboxes.contains(&address.mailbox) {
                seen_mailboxes.push(address.mailbox.clone());
                participants.push(address.clone());
            }
        };
        push(&message.from);
        for to in &message.to {
            push(to);
        }
    }
    participants
}

pub(super) fn preview_of(messages: &[Message]) -> String {
    const PREVIEW_MAX_CHARS: usize = 140;
    messages
        .last()
        .map(|message| {
            let line = message
                .body_text
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or_default();
            let mut preview: String = line.chars().take(PREVIEW_MAX_CHARS).collect();
            if line.chars().count() > PREVIEW_MAX_CHARS {
                preview.push('…');
            }
            preview
        })
        .unwrap_or_default()
}
