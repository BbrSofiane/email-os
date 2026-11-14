use super::*;

pub(super) fn admit_action_observation(
    tx: &Connection,
    observation: Option<&SearchObservation>,
    account: &str,
) -> Result<(), MailError> {
    match observation {
        Some(SearchObservation::Cached {
            generation,
            members,
        }) => {
            if !generation_matches(tx, *generation)? {
                return Err(MailError::NotFound);
            }
            for member in members {
                // Normal concurrent setters/history are safe: acceptance uses
                // current transactional facts. Only concurrent eviction needs
                // a retry through the missing-context/provider path.
                if !has_action_context(tx, account, &member.conversation_id)? {
                    return Err(MailError::Busy);
                }
            }
        }
        Some(SearchObservation::Fetched {
            generation,
            revision,
            threads,
        }) => {
            if !generation_matches(tx, *generation)? {
                return Err(MailError::NotFound);
            }
            if tx.total_changes() != *revision {
                return Err(MailError::Busy);
            }
            admit_search_rows(tx, threads, account)?;
        }
        None => {}
    }
    Ok(())
}

pub(super) fn has_action_context(
    conn: &Connection,
    account: &str,
    id: &str,
) -> Result<bool, MailError> {
    conn.query_row(
        // Eviction removes live bodies, not operation-pinned facts/snapshots.
        // accept_operation_tx can capture fresh preimages from those same facts
        // and reuse the recovery snapshot without reading or widening targets.
        "SELECT EXISTS(SELECT 1 FROM gmail_message_facts WHERE account_id=?1 AND conversation_id=?2) AND (EXISTS(SELECT 1 FROM gmail_conversations WHERE account_id=?1 AND conversation_id=?2) OR EXISTS(SELECT 1 FROM gmail_operation_snapshots WHERE account_id=?1 AND conversation_id=?2))",
        params![account, id], |r| r.get(0)).map_err(storage_err())
}

pub(super) fn admit_search_rows(
    tx: &Connection,
    threads: &[GmailThread],
    account: &str,
) -> Result<(), MailError> {
    let seq: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(seq),0)+1 FROM gmail_search_cache",
            [],
            |r| r.get(0),
        )
        .map_err(storage_err())?;
    for thread in threads {
        if thread.conversation.conversation_ref.account_id != account {
            return Err(MailError::NotFound);
        }
        let id = &thread.conversation.conversation_ref.conversation_id;
        let ordinary: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM gmail_conversations c WHERE account_id = ?1 AND conversation_id = ?2 AND NOT EXISTS(SELECT 1 FROM gmail_search_cache s WHERE s.account_id = c.account_id AND s.conversation_id = c.conversation_id))", params![account,id], |r| r.get(0)).map_err(storage_err())?;
        // Search may admit archived threads that discovery/history omit.
        tx.execute("INSERT OR IGNORE INTO gmail_conversations (account_id, conversation_id, subject, context_complete) VALUES (?1,?2,'',0)", params![account,id]).map_err(storage_err())?;
        upsert_thread(tx, account, thread)?;
        if !ordinary {
            tx.execute(
                "INSERT OR REPLACE INTO gmail_search_cache VALUES (?1,?2,?3)",
                params![account, id, seq],
            )
            .map_err(storage_err())?;
        }
    }
    Ok(())
}

/// Defer action eviction until *all* selected members have immutable targets
/// and recovery snapshots, including already-cached members near the LRU tail.
pub(super) fn evict_search(tx: &Connection, account: &str) -> Result<(), MailError> {
    let ids = {
        let mut stmt = tx.prepare("SELECT conversation_id FROM gmail_search_cache s WHERE account_id = ?1 AND NOT EXISTS (SELECT 1 FROM gmail_reminders r WHERE r.account_id=s.account_id AND r.conversation_id=s.conversation_id AND json_extract(r.data,'$.phase')='pending') ORDER BY seq DESC, conversation_id LIMIT -1 OFFSET 100").map_err(storage_err())?;
        let ids = stmt
            .query_map([account], |r| r.get::<_, String>(0))
            .map_err(storage_err())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_err())?;
        ids
    };
    for id in ids {
        // Same preservation rule as discovery eviction: only unpinned facts go.
        tx.execute(
            "DELETE FROM gmail_messages WHERE account_id=?1 AND conversation_id=?2",
            params![account, id],
        )
        .map_err(storage_err())?;
        tx.execute(
            "DELETE FROM gmail_inbox_membership WHERE account_id=?1 AND conversation_id=?2",
            params![account, id],
        )
        .map_err(storage_err())?;
        tx.execute("DELETE FROM gmail_message_facts WHERE account_id=?1 AND conversation_id=?2 AND NOT EXISTS (SELECT 1 FROM gmail_operation_targets t WHERE t.account_id=gmail_message_facts.account_id AND t.message_id=gmail_message_facts.message_id)", params![account,id]).map_err(storage_err())?;
        tx.execute(
            "DELETE FROM gmail_conversations WHERE account_id=?1 AND conversation_id=?2",
            params![account, id],
        )
        .map_err(storage_err())?;
        tx.execute(
            "DELETE FROM gmail_search_cache WHERE account_id=?1 AND conversation_id=?2",
            params![account, id],
        )
        .map_err(storage_err())?;
    }

    Ok(())
}
