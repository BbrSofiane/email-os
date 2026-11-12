use super::*;
use crate::clock::SystemClock;
use crate::dto::Message;

use crate::testing::temp_profile as temp_dir;

fn open_store(tag: &str) -> (GmailStore, tempfile::TempDir) {
    let dir = temp_dir(tag);
    let store = GmailStore::open(dir.path(), Arc::new(SystemClock)).expect("store opens");
    (store, dir)
}

#[test]
fn committed_current_schema_golden() {
    let (store, _dir) = open_store("schema-golden");
    let conn = store.lock_conn().expect("lock store");
    let mut statement = conn
        .prepare(
            "SELECT type, name, tbl_name, COALESCE(sql, '') FROM sqlite_master ORDER BY type, name",
        )
        .expect("query schema");
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .expect("read schema");
    let normalized = rows
        .map(|row| {
            let (kind, name, table, sql) = row.expect("schema row");
            let sql = sql.split_whitespace().collect::<Vec<_>>().join(" ");
            format!("{kind}|{name}|{table}|{sql}")
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    assert_eq!(
        normalized,
        include_str!("../../tests/fixtures/gmail-current-schema.txt")
    );
}

use crate::testing::profile;

fn message(id: &str, sent_at: &str) -> Message {
    Message {
        id: id.to_string(),
        from: Address {
            display_name: Some("Sender".to_string()),
            mailbox: "sender@example.test".to_string(),
        },
        to: Vec::new(),
        sent_at: sent_at.to_string(),
        body_text: "plain text body".to_string(),
        has_attachment: None,
    }
}

fn thread(
    account_id: &str,
    id: &str,
    history_id: &str,
    msgs: Vec<Message>,
    inbox: &[&str],
) -> GmailThread {
    let is_in_inbox = inbox
        .iter()
        .any(|inbox_id| msgs.iter().any(|m| m.id == **inbox_id));
    GmailThread {
        star_facts: None,
        newest_sender: msgs
            .iter()
            .max_by(|a, b| (&a.sent_at, &a.id).cmp(&(&b.sent_at, &b.id)))
            .map(|m| m.from.clone()),
        attachments: Vec::new(),
        conversation: Conversation {
            stars: None,
            conversation_ref: ConversationRef {
                account_id: account_id.to_string(),
                conversation_id: id.to_string(),
            },
            subject: format!("subject {id}"),
            messages: msgs,
            is_in_inbox,
            is_read: None,
            context_complete: Some(true),
            unsupported_reason: None,
            retained_snapshot_at: None,
            reply_context: None,
            pending_operation_id: None,
        },
        inbox_message_ids: inbox.iter().map(|s| s.to_string()).collect(),
        message_ids: None,
        unread_message_ids: None,
        trash_message_ids: None,
        spam_message_ids: None,
        history_id: history_id.to_string(),
    }
}

fn cached(thread: GmailThread) -> ThreadFetch {
    ThreadFetch::Cached(Box::new(thread))
}

#[test]
fn due_thread_merge_rejects_stale_observation_revision_and_generation() {
    use crate::reminders::{CancelReminder, PutReminder, ReminderCondition};
    let (store, _dir) = open_store("due-thread-fences");
    store
        .begin_account(&profile("acct", "test@example.test", "h1"), 0)
        .unwrap();
    let original = thread(
        "acct",
        "thr",
        "h1",
        vec![message("m1", "2026-01-01T00:00:00Z")],
        &["m1"],
    );
    store
        .apply_discovery_page(&[cached(original.clone())], None, true, false, 0)
        .unwrap();
    let command = PutReminder {
        conversation: original.conversation.conversation_ref.clone(),
        source_message_id: "m1".into(),
        due_at: Some("2099-01-01T00:00:00Z".into()),
        condition: ReminderCondition::IfNoReply,
        expected_revision: None,
        request_id: "fenced-put".into(),
    };
    let accepted = store.put_reminder(&command).unwrap();
    let generation = store.generation().unwrap();
    let observation = store.observation_revision().unwrap();
    let mut stale = original.clone();
    stale.inbox_message_ids.clear();
    stale.conversation.is_in_inbox = false;
    stale.conversation.subject = "stale remote facts".into();
    // An unrelated cache write invalidates the observation, even with the
    // same reminder revision.
    store
        .apply_discovery_page(&[cached(original.clone())], None, true, false, generation)
        .unwrap();
    assert!(!store
        .finish_due_reminder_with_thread(&accepted, generation, observation, false, Some(&stale))
        .unwrap());
    assert_eq!(store.list_reminders().unwrap()[0], accepted);
    assert_eq!(
        store
            .get_conversation(&command.conversation)
            .unwrap()
            .subject,
        original.conversation.subject
    );
    let cancelled = store
        .cancel_reminder(&CancelReminder {
            conversation: command.conversation.clone(),
            expected_revision: accepted.revision,
            request_id: "fenced-cancel".into(),
        })
        .unwrap();
    // A fresh observation cannot bypass the reminder revision/phase fence.
    assert!(!store
        .finish_due_reminder_with_thread(
            &accepted,
            generation,
            store.observation_revision().unwrap(),
            false,
            Some(&stale)
        )
        .unwrap());
    assert_eq!(store.list_reminders().unwrap()[0], cancelled);
    assert_eq!(store.list_snapshot().unwrap().conversations.len(), 1);
    store.clear_account().unwrap();
    assert!(!store
        .finish_due_reminder_with_thread(
            &accepted,
            generation,
            store.observation_revision().unwrap(),
            false,
            Some(&stale)
        )
        .unwrap());
    assert!(store.list_snapshot().unwrap().conversations.is_empty());
    assert!(store.list_reminders().unwrap().is_empty());
    drop(store);
}

#[test]
fn gmail_reminder_is_local_account_scoped_revisioned_and_replayed() {
    use crate::reminders::{CancelReminder, PutReminder, ReminderCondition, ReminderPhase};
    let (store, dir) = open_store("gmail-reminder-local");
    store
        .begin_account(&profile("acct", "test@example.test", "h1"), 0)
        .unwrap();
    store
        .apply_discovery_page(
            &[cached(thread(
                "acct",
                "thr",
                "h1",
                vec![message("m1", "2026-01-01T00:00:00Z")],
                &["m1"],
            ))],
            None,
            true,
            false,
            0,
        )
        .unwrap();
    let put = PutReminder {
        conversation: ConversationRef {
            account_id: "acct".into(),
            conversation_id: "thr".into(),
        },
        source_message_id: "m1".into(),
        due_at: Some("2099-01-01T00:00:00Z".into()),
        condition: ReminderCondition::Regardless,
        expected_revision: None,
        request_id: "put-1".into(),
    };
    let scheduled = store.put_reminder(&put).unwrap();
    assert_eq!(store.put_reminder(&put).unwrap(), scheduled);
    assert!(
        store.list_snapshot().unwrap().conversations.is_empty(),
        "pending baseline is hidden locally"
    );
    store
        .apply_discovery_page(
            &[cached(thread(
                "acct",
                "thr",
                "h2",
                vec![
                    message("m1", "2026-01-01T00:00:00Z"),
                    message("m2", "2026-01-02T00:00:00Z"),
                ],
                &["m1", "m2"],
            ))],
            None,
            false,
            false,
            0,
        )
        .unwrap();
    assert_eq!(
        store.list_snapshot().unwrap().conversations.len(),
        1,
        "new external ID releases hiding"
    );
    let mut conflict = put.clone();
    conflict.due_at = None;
    assert_eq!(
        store.put_reminder(&conflict),
        Err(MailError::RequestIdConflict)
    );
    assert_eq!(
        store.get_conversation(&put.conversation).unwrap().messages[0].id,
        "m1"
    );
    let cancel = CancelReminder {
        conversation: put.conversation.clone(),
        expected_revision: 1,
        request_id: "cancel-1".into(),
    };
    let cancelled = store.cancel_reminder(&cancel).unwrap();
    assert_eq!(cancelled.phase, ReminderPhase::Cancelled);
    assert_eq!(store.cancel_reminder(&cancel).unwrap(), cancelled);
    assert_eq!(
        store.list_snapshot().unwrap().conversations.len(),
        1,
        "cancel releases local hiding"
    );
    assert_eq!(
        store.put_reminder(&PutReminder {
            conversation: ConversationRef {
                account_id: "other".into(),
                conversation_id: "thr".into()
            },
            ..put.clone()
        }),
        Err(MailError::NotFound)
    );
    drop(store);
    let reopened = open_store_in(dir.path());
    assert_eq!(reopened.list_reminders().unwrap(), vec![cancelled]);
}

#[test]
fn gmail_reminder_lost_ack_replays_after_due_and_reopen() {
    use crate::reminders::{PutReminder, ReminderCondition};
    let dir = temp_dir("gmail-reminder-lost-ack");
    let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
        "2026-01-01T00:00:00Z",
    )));
    let store = GmailStore::open(dir.path(), clock.clone()).unwrap();
    store
        .begin_account(&profile("acct", "test@example.test", "h1"), 0)
        .unwrap();
    store
        .apply_discovery_page(
            &[cached(thread(
                "acct",
                "thr",
                "h1",
                vec![message("m1", "2026-01-01T00:00:00Z")],
                &["m1"],
            ))],
            None,
            true,
            false,
            0,
        )
        .unwrap();
    let put = PutReminder {
        conversation: ConversationRef {
            account_id: "acct".into(),
            conversation_id: "thr".into(),
        },
        source_message_id: "m1".into(),
        due_at: Some("2026-01-01T00:01:00Z".into()),
        condition: ReminderCondition::Regardless,
        expected_revision: None,
        request_id: "lost-ack".into(),
    };
    let receipt = store.put_reminder(&put).unwrap();
    assert!(store.list_snapshot().unwrap().conversations.is_empty());
    clock.advance_seconds(120);
    assert!(
        store.list_snapshot().unwrap().conversations.is_empty(),
        "deadline alone does not resolve a pending reminder"
    );
    assert_eq!(
        store.get_conversation(&put.conversation).unwrap().messages[0].id,
        "m1"
    );
    assert_eq!(store.put_reminder(&put).unwrap(), receipt);
    let mut conflict = put.clone();
    conflict.condition = ReminderCondition::IfNoReply;
    assert_eq!(
        store.put_reminder(&conflict),
        Err(MailError::RequestIdConflict)
    );
    drop(store);
    let reopened = GmailStore::open(dir.path(), clock).unwrap();
    assert_eq!(reopened.put_reminder(&put).unwrap(), receipt);
    drop(reopened);
}

#[test]
fn local_reminder_replacement_pins_new_baseline_and_survives_rediscovery() {
    use crate::reminders::{CancelReminder, PutReminder, ReminderCondition, ReminderPhase};
    let dir = temp_dir("reminder-replacement-pin");
    let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
        "2026-01-01T00:00:00Z",
    )));
    let store = GmailStore::open(dir.path(), clock.clone()).unwrap();
    store
        .begin_account(&profile("acct", "self@example.test", "h1"), 0)
        .unwrap();
    store
        .apply_discovery_page(
            &[cached(thread(
                "acct",
                "original",
                "h1",
                vec![message("m1", "2020-01-01T00:00:00Z")],
                &["m1"],
            ))],
            None,
            true,
            false,
            0,
        )
        .unwrap();
    let first = PutReminder {
        conversation: ConversationRef {
            account_id: "acct".into(),
            conversation_id: "original".into(),
        },
        source_message_id: "m1".into(),
        due_at: None,
        condition: ReminderCondition::Regardless,
        expected_revision: None,
        request_id: "first".into(),
    };
    let scheduled = store.put_reminder(&first).unwrap();
    assert!(
        store.list_snapshot().unwrap().conversations.is_empty(),
        "Someday must stay hidden"
    );
    store
        .cancel_reminder(&CancelReminder {
            conversation: first.conversation.clone(),
            expected_revision: scheduled.revision,
            request_id: "cancel-first".into(),
        })
        .unwrap();
    store
        .apply_discovery_page(
            &[cached(thread(
                "acct",
                "original",
                "h2",
                vec![
                    message("m1", "2020-01-01T00:00:00Z"),
                    message("m2", "2020-01-02T00:00:00Z"),
                ],
                &["m1", "m2"],
            ))],
            None,
            false,
            false,
            0,
        )
        .unwrap();
    let replacement = PutReminder {
        source_message_id: "m2".into(),
        due_at: Some("2026-01-01T00:01:00Z".into()),
        request_id: "replacement".into(),
        ..first
    };
    let receipt = store.put_reminder(&replacement).unwrap();
    assert!(
        store.list_snapshot().unwrap().conversations.is_empty(),
        "replacement baseline includes m2"
    );
    store.begin_rediscovery("h2", 0).unwrap();
    assert_eq!(
        store.put_reminder(&replacement).unwrap(),
        receipt,
        "rediscovery preserves receipts"
    );
    let mut newer = Vec::new();
    for index in 0..=DISCOVERY_CAP {
        let id = format!("new-{index}");
        newer.push(cached(thread(
            "acct",
            &id,
            "h2",
            vec![message(&id, "2026-01-01T00:00:00Z")],
            &[&id],
        )));
    }
    store
        .apply_discovery_page(&newer, None, true, true, 0)
        .unwrap();
    assert_eq!(
        store
            .get_conversation(&replacement.conversation)
            .unwrap()
            .messages
            .len(),
        2,
        "active reminder bodies survive real cap pruning"
    );
    drop(store);
    clock.advance_seconds(120);
    let store = GmailStore::open(dir.path(), clock).unwrap();
    let due = store.due_reminders().unwrap();
    assert_eq!(due[0].1.len(), 2, "replacement inventory persists");
    assert!(store
        .finish_due_reminder(
            &due[0].0,
            store.generation().unwrap(),
            store.observation_revision().unwrap(),
            false
        )
        .unwrap());
    assert_eq!(
        store.list_reminders().unwrap()[0].phase,
        ReminderPhase::Returned
    );
    assert!(store
        .list_snapshot()
        .unwrap()
        .conversations
        .iter()
        .any(|c| c.conversation_ref == replacement.conversation));
    store.clear_account().unwrap();
    let conn = store.lock_conn().unwrap();
    for table in ["gmail_reminders", "gmail_reminder_requests"] {
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "disconnect removes reminder mail and receipts");
    }
    drop(conn);
    drop(store);
}

/// P5a: per-message attachment facts parse -> persist -> summary. Known
/// facts aggregate to the conversation row; a NULL column (legacy cache)
/// stays unknown and never guesses.
#[test]
fn attachment_facts_persist_per_message_and_drive_summaries() {
    let (store, dir) = open_store("attachment-facts");
    store
        .begin_account(&profile("acct", "test@example.test", "h1"), 0)
        .unwrap();
    let mut attached = message("m-att", "2026-01-01T00:00:00Z");
    attached.has_attachment = Some(true);
    let mut plain = message("m-plain", "2026-01-02T00:00:00Z");
    plain.has_attachment = Some(false);
    let attached_thread = thread(
        "acct",
        "thr-att",
        "h2",
        vec![attached.clone(), plain.clone()],
        &["m-att", "m-plain"],
    );
    let plain_thread = thread("acct", "thr-plain", "h2", vec![plain.clone()], &["m-plain"]);
    store
        .apply_discovery_page(
            &[cached(attached_thread), cached(plain_thread)],
            None,
            true,
            false,
            0,
        )
        .unwrap();
    let rows = store.list_snapshot().unwrap().conversations;
    let att_row = rows
        .iter()
        .find(|c| c.conversation_ref.conversation_id == "thr-att")
        .unwrap();
    let plain_row = rows
        .iter()
        .find(|c| c.conversation_ref.conversation_id == "thr-plain")
        .unwrap();
    assert_eq!(att_row.has_attachments, Some(true), "any known attachment");
    assert_eq!(plain_row.has_attachments, Some(false), "known absent");
    let detail = store
        .get_conversation(&att_row.conversation_ref.clone())
        .unwrap();
    assert_eq!(detail.messages[0].has_attachment, Some(true));
    assert_eq!(detail.messages[1].has_attachment, Some(false));

    // The facts are durable across reopen (column, not just parse state).
    drop(store);
    let store = open_store_in(dir.path());
    let rows = store.list_snapshot().unwrap().conversations;
    let att_row = rows
        .iter()
        .find(|c| c.conversation_ref.conversation_id == "thr-att")
        .unwrap();
    assert_eq!(att_row.has_attachments, Some(true), "survives reopen");

    // A legacy cached row (NULL column) reports unknown, never false.
    store
        .lock_conn()
        .unwrap()
        .execute(
            "UPDATE gmail_messages SET has_attachment = NULL
                 WHERE conversation_id = 'thr-plain'",
            [],
        )
        .unwrap();
    let rows = store.list_snapshot().unwrap().conversations;
    let legacy_row = rows
        .iter()
        .find(|c| c.conversation_ref.conversation_id == "thr-plain")
        .unwrap();
    assert_eq!(
        legacy_row.has_attachments, None,
        "legacy cache stays unknown"
    );
}

fn open_store_in(dir: &std::path::Path) -> GmailStore {
    GmailStore::open(dir, Arc::new(SystemClock)).expect("store reopens")
}

#[test]
fn search_observations_cannot_overwrite_confirmed_archive_or_read() {
    let (store, _dir) = open_store("search-authoritative-fence");
    store
        .begin_account(&profile("acct", "test@example.test", "h1"), 0)
        .unwrap();
    let mut old = thread(
        "acct",
        "observed",
        "h2",
        vec![message("m1", "2020-01-01T00:00:00Z")],
        &["m1"],
    );
    old.message_ids = Some(vec!["m1".into()]);
    old.unread_message_ids = Some(vec!["m1".into()]);
    store
        .apply_discovery_page(&[cached(old.clone())], None, true, false, 0)
        .unwrap();
    let target = old.conversation.conversation_ref.clone();
    let revision = store.observation_revision().unwrap(); // fetch completed before archive
    store
        .accept_archived(&SetArchived {
            conversation: target.clone(),
            archived: true,
            request_id: "archive".into(),
        })
        .unwrap();
    let record = store.claim_next_operation().unwrap().unwrap();
    store.confirm_operation(&record).unwrap();
    assert_eq!(
        store.save_search(&[old.clone()], 0, revision, "acct"),
        Err(MailError::Busy)
    );
    assert!(!store.get_conversation(&target).unwrap().is_in_inbox);
    let revision = store.observation_revision().unwrap(); // independently fetched stale unread facts
    store
        .accept_read(&SetRead {
            conversation: target.clone(),
            read: true,
            request_id: "read".into(),
        })
        .unwrap();
    let record = store.claim_next_operation().unwrap().unwrap();
    store.confirm_operation(&record).unwrap();
    assert_eq!(
        store.save_search(&[old], 0, revision, "acct"),
        Err(MailError::Busy)
    );
    let current = store.get_conversation(&target).unwrap();
    assert!(!current.is_in_inbox);
    assert_eq!(current.is_read, Some(true));
    drop(store);
}

#[test]
fn search_admits_older_archived_mail_without_touching_discovery_and_fences_accounts() {
    let (store, _dir) = open_store("search-archived");
    store
        .begin_account(&profile("acct", "test@example.test", "h1"), 0)
        .unwrap();
    let older = thread(
        "acct",
        "older",
        "h2",
        vec![message("m1", "2020-01-01T00:00:00Z")],
        &[],
    );
    let cursor = store.cursor().unwrap();
    store
        .save_search(
            std::slice::from_ref(&older),
            0,
            store.observation_revision().unwrap(),
            "acct",
        )
        .unwrap();
    assert_eq!(store.cursor().unwrap(), cursor);
    assert!(store.list_snapshot().unwrap().conversations.is_empty());
    let request = crate::search::SearchRequest {
        account_id: "acct".into(),
        query: "from:sender subject:older".into(),
        cursor: None,
        cached_only: true,
    };
    assert_eq!(store.search_mail(&request).unwrap().conversations.len(), 1);
    assert!(
        !store
            .get_conversation(&older.conversation.conversation_ref)
            .unwrap()
            .is_in_inbox
    );
    let wrong = crate::search::SearchRequest {
        account_id: "other".into(),
        ..request
    };
    assert!(matches!(
        store.search_mail(&wrong),
        Err(MailError::NotFound)
    ));
    assert!(matches!(
        store.save_search(&[older], 999, store.observation_revision().unwrap(), "acct"),
        Err(MailError::NotFound)
    ));
    drop(store);
}

#[test]
fn search_cache_is_bounded_and_eviction_preserves_operation_recovery() {
    let (store, _dir) = open_store("search-retention");
    store
        .begin_account(&profile("acct", "test@example.test", "h1"), 0)
        .unwrap();
    let older = thread(
        "acct",
        "older",
        "h2",
        vec![message("m1", "2020-01-01T00:00:00Z")],
        &[],
    );
    store
        .save_search(
            std::slice::from_ref(&older),
            0,
            store.observation_revision().unwrap(),
            "acct",
        )
        .unwrap();
    store
        .accept_archived(&SetArchived {
            conversation: older.conversation.conversation_ref.clone(),
            archived: false,
            request_id: "restore".into(),
        })
        .unwrap();
    assert_eq!(store.list_snapshot().unwrap().conversations.len(), 1);
    for n in 0..101 {
        let t = thread(
            "acct",
            &format!("new-{n:03}"),
            "h3",
            vec![message(&format!("msg-{n}"), "2026-01-01T00:00:00Z")],
            &[],
        );
        store
            .save_search(&[t], 0, store.observation_revision().unwrap(), "acct")
            .unwrap();
    }
    let conn = store.lock_conn().unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM gmail_search_cache", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 100);
    drop(conn);
    let recovered = store
        .get_conversation(&older.conversation.conversation_ref)
        .unwrap();
    assert!(recovered.retained_snapshot_at.is_some());
    assert!(recovered.is_in_inbox);
    drop(store);
}

#[test]
fn cached_trash_is_account_scoped_paged_retained_and_distinct_from_done() {
    use crate::dto::{CachedDoneRequest, CachedTrashRequest};
    let (store, dir) = open_store("ux10-trash");
    store
        .begin_account(&profile("acct", "a@example.test", "h1"), 0)
        .unwrap();
    for id in ["a", "b", "spam", "independent"] {
        let source = thread(
            "acct",
            id,
            "h1",
            vec![message(&format!("m-{id}"), "2026-01-01T00:00:00Z")],
            &[&format!("m-{id}")],
        );
        store
            .apply_discovery_page(&[cached(source)], None, true, false, 0)
            .unwrap();
        store
            .accept_archived(&SetArchived {
                conversation: ConversationRef {
                    account_id: "acct".into(),
                    conversation_id: id.into(),
                },
                archived: true,
                request_id: format!("archive-{id}"),
            })
            .unwrap();
        let mut observed = thread(
            "acct",
            id,
            "h2",
            vec![message(&format!("m-{id}"), "2026-01-01T00:00:00Z")],
            &[],
        );
        observed.trash_message_ids = Some(if id == "a" || id == "b" {
            vec![format!("m-{id}")]
        } else {
            vec![]
        });
        observed.spam_message_ids = Some(if id == "spam" {
            vec![format!("m-{id}")]
        } else {
            vec![]
        });
        upsert_thread(&store.lock_conn().unwrap(), "acct", &observed).unwrap();
    }
    let done = store
        .list_cached_done(&CachedDoneRequest {
            account_id: "acct".into(),
            limit: 100,
            cursor: None,
        })
        .unwrap();
    assert_eq!(
        done.conversations
            .iter()
            .map(|row| row.conversation_ref.conversation_id.as_str())
            .collect::<Vec<_>>(),
        ["independent"]
    );
    let request = CachedTrashRequest {
        account_id: "acct".into(),
        limit: 1,
        cursor: None,
    };
    let first = store.list_cached_trash(&request).unwrap();
    assert_eq!(first.conversations[0].conversation_ref.conversation_id, "a");
    assert_eq!(first.exact_total, None);
    let second = store
        .list_cached_trash(&CachedTrashRequest {
            cursor: first.next_cursor.clone(),
            ..request.clone()
        })
        .unwrap();
    assert_eq!(
        second.conversations[0].conversation_ref.conversation_id,
        "b"
    );
    assert_eq!(second.next_cursor, None);
    assert_eq!(
        store.list_cached_trash(&CachedTrashRequest {
            account_id: "foreign".into(),
            ..request.clone()
        }),
        Err(MailError::NotFound)
    );
    for cursor in [
        "cached-done-v1:[]",
        "cached-trash-v1:[\"foreign\",\"\",\"a\"]",
        "malformed",
    ] {
        assert!(matches!(
            store.list_cached_trash(&CachedTrashRequest {
                cursor: Some(cursor.into()),
                ..request.clone()
            }),
            Err(MailError::InvalidRequest { .. })
        ));
    }
    for limit in [0, 101] {
        assert!(matches!(
            store.list_cached_trash(&CachedTrashRequest {
                limit,
                ..request.clone()
            }),
            Err(MailError::InvalidRequest { .. })
        ));
    }
    // Evicted bodies still have durable operation snapshots/facts.
    {
        let conn = store.lock_conn().unwrap();
        conn.execute(
            "DELETE FROM gmail_conversations WHERE conversation_id = 'a'",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM gmail_messages WHERE conversation_id = 'a'", [])
            .unwrap();
    }
    drop(store);
    let reopened = GmailStore::open(dir.path(), Arc::new(SystemClock)).unwrap();
    assert_eq!(reopened.list_cached_trash(&request).unwrap(), first);
    let target = ConversationRef {
        account_id: "acct".into(),
        conversation_id: "a".into(),
    };
    assert!(reopened
        .get_conversation(&target)
        .unwrap()
        .retained_snapshot_at
        .is_some());
    // Current membership overrides old archive evidence; removing only TRASH does not restore INBOX.
    let mut recovered = thread(
        "acct",
        "a",
        "h3",
        vec![message("m-a", "2026-01-01T00:00:00Z")],
        &[],
    );
    recovered.trash_message_ids = Some(vec![]);
    recovered.spam_message_ids = Some(vec![]);
    upsert_message_facts(&reopened.lock_conn().unwrap(), "acct", &recovered).unwrap();
    assert_eq!(
        reopened.list_cached_trash(&request).unwrap().conversations[0]
            .conversation_ref
            .conversation_id,
        "b"
    );
    assert!(!reopened.get_conversation(&target).unwrap().is_in_inbox);
    drop(reopened);
}

#[test]
fn triage_facts_survive_real_cache_eviction_and_capped_rediscovery() {
    use crate::dto::{CachedDoneRequest, CachedTrashRequest};

    // Exercise each pruning query independently: capped rediscovery below
    // the cap must not rely on evict_over_cap to retain recovery evidence.
    for capped in [false, true] {
        let (store, dir) = open_store(if capped {
            "triage-capped-rediscovery"
        } else {
            "triage-cap-eviction"
        });
        store
            .begin_account(&profile("acct", "a@example.test", "h1"), 0)
            .unwrap();
        let original = |id: &str| {
            thread(
                "acct",
                id,
                "h1",
                vec![message(&format!("{id}-a"), "2026-01-01T00:00:00Z")],
                &[&format!("{id}-a")],
            )
        };
        store
            .apply_discovery_page(
                &["trash", "spam", "independent", "unowned"].map(|id| cached(original(id))),
                None,
                true,
                false,
                0,
            )
            .unwrap();
        for id in ["trash", "spam", "independent"] {
            store
                .accept_archived(&SetArchived {
                    conversation: original(id).conversation.conversation_ref,
                    archived: true,
                    request_id: format!("archive-{id}"),
                })
                .unwrap();
        }
        let evidence = |store: &GmailStore| {
            let conn = store.lock_conn().unwrap();
            let counts: (i64, i64) = conn.query_row(
                    "SELECT (SELECT COUNT(*) FROM gmail_operation_targets WHERE account_id = 'acct'),
                            (SELECT COUNT(*) FROM gmail_operation_preimages WHERE account_id = 'acct')",
                    [], |row| Ok((row.get(0)?, row.get(1)?)),
                ).unwrap();
            assert_eq!(counts, (3, 3), "no unmatched or widened immutable evidence");
            let mut stmt = conn
                .prepare(
                    "SELECT t.operation_id, t.conversation_id, t.message_id, p.prior_value
                     FROM gmail_operation_targets t JOIN gmail_operation_preimages p
                     ON p.account_id = t.account_id AND p.operation_id = t.operation_id
                        AND p.message_id = t.message_id
                     WHERE t.account_id = 'acct' ORDER BY t.conversation_id, t.message_id",
                )
                .unwrap();
            stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
        };
        let accepted = evidence(&store);
        assert_eq!(accepted.len(), 3);
        for (_, id, message_id, prior) in &accepted {
            assert_eq!(message_id, &format!("{id}-a"));
            assert_eq!(*prior, Some(0));
        }
        let history = HistoryPage {
            changed_thread_ids: Vec::new(),
            deleted_message_ids: Vec::new(),
            next_page_token: None,
            history_id: "h2".into(),
        };
        let mut observed = Vec::new();
        for id in ["trash", "spam", "unowned"] {
            let mut newer = original(id);
            newer.inbox_message_ids.clear();
            newer
                .conversation
                .messages
                .push(message(&format!("{id}-b"), "2026-01-02T00:00:00Z"));
            // B arrived after acceptance and must never become a target or
            // preimage of archive A. Unsupported bodies are not required.
            newer.trash_message_ids = Some(if id != "spam" {
                vec![format!("{id}-b")]
            } else {
                vec![]
            });
            newer.spam_message_ids = Some(if id == "spam" {
                vec![format!("{id}-b")]
            } else {
                vec![]
            });
            observed.push(cached(newer));
        }
        store
            .apply_history_page(&history, &observed, "h1", 0)
            .unwrap();
        let done_request = CachedDoneRequest {
            account_id: "acct".into(),
            limit: 100,
            cursor: None,
        };
        let trash_request = CachedTrashRequest {
            account_id: "acct".into(),
            limit: 100,
            cursor: None,
        };
        let ids = |rows: Vec<ConversationSummary>| {
            rows.into_iter()
                .map(|row| row.conversation_ref.conversation_id)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids(store.list_cached_done(&done_request).unwrap().conversations),
            ["independent"]
        );
        assert_eq!(
            ids(store
                .list_cached_trash(&trash_request)
                .unwrap()
                .conversations),
            ["trash", "unowned"]
        );

        // Same conversation ID in another account must not grant retention.
        store.lock_conn().unwrap().execute(
                "INSERT INTO gmail_operation_snapshots
                 (account_id, conversation_id, snapshot_json, snapshot_saved_at, last_message_at)
                 SELECT 'foreign', 'unowned', snapshot_json, snapshot_saved_at, last_message_at
                 FROM gmail_operation_snapshots WHERE account_id = 'acct' AND conversation_id = 'trash'",
                [],
            ).unwrap();
        let additions: Vec<_> = (0..if capped { 1 } else { DISCOVERY_CAP })
            .map(|index| {
                let id = format!("new-{index:03}");
                cached(thread(
                    "acct",
                    &id,
                    "h3",
                    vec![message(&format!("{id}-a"), "2026-03-01T00:00:00Z")],
                    &[&format!("{id}-a")],
                ))
            })
            .collect();
        if capped {
            store.begin_rediscovery("h3", 0).unwrap();
            store
                .apply_discovery_page(&additions, None, true, true, 0)
                .unwrap();
        } else {
            store
                .apply_history_page(&history, &additions, "h2", 0)
                .unwrap();
        }
        assert_eq!(
            store.cached_count().unwrap(),
            if capped { 1 } else { DISCOVERY_CAP }
        );
        drop(store);
        let reopened = GmailStore::open(dir.path(), Arc::new(SystemClock)).unwrap();
        assert_eq!(
            ids(reopened
                .list_cached_done(&done_request)
                .unwrap()
                .conversations),
            ["independent"]
        );
        assert_eq!(
            ids(reopened
                .list_cached_trash(&trash_request)
                .unwrap()
                .conversations),
            ["trash"]
        );
        assert_eq!(evidence(&reopened), accepted);
        for id in ["trash", "spam", "independent"] {
            let retained = reopened
                .get_conversation(&original(id).conversation.conversation_ref)
                .unwrap();
            assert!(retained.retained_snapshot_at.is_some());
            assert_eq!(retained.messages.len(), 1);
            assert_eq!(retained.messages[0].id, format!("{id}-a"));
            assert!(!retained.is_in_inbox);
        }
        {
            let conn = reopened.lock_conn().unwrap();
            let count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM gmail_message_facts WHERE account_id = 'acct' AND conversation_id = 'unowned'", [], |row| row.get(0),
                ).unwrap();
            assert_eq!(
                count, 0,
                "no facts retained without same-account recovery ownership"
            );
            let count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM gmail_message_facts WHERE account_id = 'acct' AND conversation_id IN ('trash', 'spam')", [], |row| row.get(0),
                ).unwrap();
            assert_eq!(
                count, 4,
                "both current inventories survive, not just targets"
            );
        }
        assert_eq!(
            reopened
                .get_conversation(&ConversationRef {
                    account_id: "acct".into(),
                    conversation_id: "new-000".into(),
                })
                .unwrap()
                .messages[0]
                .id,
            "new-000-a"
        );

        // Full provider replacement removes membership even without body
        // cache admission. Message deletion and missing-thread paths must
        // also clear triage facts, while immutable history stays exact.
        let mut cleared = original("trash");
        cleared
            .conversation
            .messages
            .push(message("trash-b", "2026-01-02T00:00:00Z"));
        cleared.inbox_message_ids.clear();
        cleared.trash_message_ids = Some(vec![]);
        cleared.spam_message_ids = Some(vec![]);
        reopened
            .apply_history_page(&history, &[cached(cleared)], "h2", 0)
            .unwrap();
        assert!(reopened
            .list_cached_trash(&trash_request)
            .unwrap()
            .conversations
            .is_empty());
        let deleted = HistoryPage {
            deleted_message_ids: vec!["spam-b".into()],
            ..history.clone()
        };
        reopened.apply_history_page(&deleted, &[], "h2", 0).unwrap();
        assert_eq!(
            ids(reopened
                .list_cached_done(&done_request)
                .unwrap()
                .conversations),
            ["independent", "spam", "trash"]
        );
        reopened
            .apply_history_page(&history, &[ThreadFetch::Missing("spam".into())], "h2", 0)
            .unwrap();
        let count: i64 = reopened.lock_conn().unwrap().query_row(
                "SELECT COUNT(*) FROM gmail_message_facts WHERE account_id = 'acct' AND (message_id = 'spam-b' OR conversation_id = 'spam' OR (message_id = 'trash-b' AND (in_trash = 1 OR in_spam = 1)))", [], |row| row.get(0),
            ).unwrap();
        assert_eq!(count, 0);
        let membership: (i64, i64) = reopened.lock_conn().unwrap().query_row(
                "SELECT in_trash, in_spam FROM gmail_message_facts WHERE account_id = 'acct' AND message_id = 'trash-b'", [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
        assert_eq!(
            membership,
            (0, 0),
            "provider membership removal replaces retained evidence"
        );
        assert_eq!(evidence(&reopened), accepted);
        reopened.clear_account().unwrap();
        let count: i64 = reopened.lock_conn().unwrap().query_row(
                "SELECT (SELECT COUNT(*) FROM gmail_message_facts) + (SELECT COUNT(*) FROM gmail_operation_snapshots)", [], |row| row.get(0),
            ).unwrap();
        assert_eq!(
            count, 0,
            "disconnect leaves no recovery-owned facts or snapshots"
        );
        drop(reopened);
    }
}

#[test]
fn triage_fact_migration_keeps_legacy_membership_unknown() {
    let (store, dir) = open_store("ux10-migration");
    {
        let conn = store.lock_conn().unwrap();
        conn.execute("INSERT INTO gmail_message_facts (account_id, conversation_id, message_id, in_inbox, is_unread) VALUES ('a', 'c', 'm', 0, 1)", []).unwrap();
        conn.execute_batch("ALTER TABLE gmail_message_facts DROP COLUMN in_trash; ALTER TABLE gmail_message_facts DROP COLUMN in_spam; UPDATE meta SET value = 'gmail-2' WHERE key = 'schema_version';").unwrap();
    }
    drop(store);
    let reopened = GmailStore::open(dir.path(), Arc::new(SystemClock)).unwrap();
    let facts: (Option<i64>, Option<i64>, i64) = reopened
        .lock_conn()
        .unwrap()
        .query_row(
            "SELECT in_trash, in_spam, is_unread FROM gmail_message_facts",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(facts, (None, None, 1));
    drop(reopened);
}

#[test]
fn attachment_descriptors_persist_without_body_or_action_mutation() {
    let (store, dir) = open_store("attachments");
    store
        .begin_account(&profile("acct", "a@example.test", "h1"), 0)
        .unwrap();
    let mut source = thread(
        "acct",
        "t1",
        "h2",
        vec![message("m1", "2026-01-01T00:00:00Z")],
        &["m1"],
    );
    source.attachments = vec![crate::attachments::AttachmentDescriptor {
        message_id: "m1".into(),
        attachment_id: "a1".into(),
        filename: "../evil.html".into(),
        mime_type: "text/html".into(),
        size: 12,
    }];
    store
        .apply_discovery_page(&[cached(source.clone())], None, true, false, 0)
        .unwrap();
    let target = source.conversation.conversation_ref.clone();
    assert_eq!(store.list_attachments(&target).unwrap(), source.attachments);
    assert_eq!(
        store.get_conversation(&target).unwrap().messages,
        source.conversation.messages
    );
    assert!(store
        .list_attachments(&ConversationRef {
            account_id: "other".into(),
            ..target.clone()
        })
        .is_err());
    drop(store);
    let store = GmailStore::open(dir.path(), Arc::new(SystemClock)).unwrap();
    assert_eq!(store.list_attachments(&target).unwrap(), source.attachments);
    store
        .conn
        .lock()
        .unwrap()
        .execute(
            "DELETE FROM gmail_message_facts WHERE message_id = 'm1'",
            [],
        )
        .unwrap();
    assert!(store.list_attachments(&target).unwrap().is_empty());
    store.clear_account().unwrap();
    assert!(store.list_attachments(&target).is_err());
    drop(store);
}

#[test]
fn reply_context_cache_is_additive_persistent_and_metadata_only() {
    let (store, dir) = open_store("reply-context-cache");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
        .expect("account");
    let source = thread(
        "acct-alpha",
        "thr-reply",
        "hist-2",
        vec![
            message("m-old", "2026-01-01T00:00:00Z"),
            message("m-latest", "2026-01-02T00:00:00Z"),
        ],
        &["m-latest"],
    );
    store
        .apply_discovery_page(&[cached(source.clone())], None, true, false, 0)
        .expect("cache source");
    let target = ConversationRef {
        account_id: "acct-alpha".to_string(),
        conversation_id: "thr-reply".to_string(),
    };
    let before = store.get_conversation(&target).expect("cached reader");
    let cursor_before = store.cursor().expect("cursor");
    let context = ReplyContext {
        source_message_id: "m-latest".to_string(),
        from_mailbox: "sender@example.test".to_string(),
        reply_to_mailboxes: None,
        message_id: "<m-latest@example.test>".to_string(),
        references: vec![
            "<m-old@example.test>".to_string(),
            "<m-latest@example.test>".to_string(),
        ],
    };

    assert!(!store
        .save_reply_context(&target, "m-old", &context, 0)
        .expect("stale source rejected"));
    assert!(!store
        .save_reply_context(
            &ConversationRef {
                account_id: "acct-beta".to_string(),
                ..target.clone()
            },
            "m-latest",
            &context,
            0,
        )
        .expect("foreign account rejected"));
    assert!(store
        .save_reply_context(&target, "m-latest", &context, 0)
        .expect("metadata saved"));
    let after = store
        .get_conversation(&target)
        .expect("reader after metadata");
    assert_eq!(after.reply_context, Some(context.clone()));
    assert_eq!(after.messages, before.messages);
    assert_eq!(after.subject, before.subject);
    assert_eq!(after.is_in_inbox, before.is_in_inbox);
    assert_eq!(store.cursor().expect("cursor unchanged"), cursor_before);

    // Restart preserves metadata; a legacy database without the new column
    // migrates it additively and leaves old rows NULL.
    drop(store);
    let reopened = GmailStore::open(dir.path(), Arc::new(SystemClock)).expect("reopen");
    assert_eq!(
        reopened
            .get_conversation(&target)
            .expect("persisted reader")
            .reply_context,
        Some(context)
    );
    drop(reopened);
    let legacy = Connection::open(dir.path().join("gmail.db")).expect("legacy db");
    legacy
        .execute(
            "ALTER TABLE gmail_conversations DROP COLUMN reply_context_json",
            [],
        )
        .expect("simulate legacy schema");
    legacy
        .execute(
            "UPDATE meta SET value = 'gmail-2' WHERE key = 'schema_version'",
            [],
        )
        .unwrap();
    drop(legacy);
    let migrated = GmailStore::open(dir.path(), Arc::new(SystemClock)).expect("additive migration");
    assert_eq!(
        migrated
            .get_conversation(&target)
            .expect("legacy reader")
            .reply_context,
        None
    );
}

#[test]
fn malformed_cached_reply_context_is_a_storage_error() {
    let (store, _dir) = open_store("reply-context-invalid-json");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
        .expect("account");
    let source = thread(
        "acct-alpha",
        "thr-invalid-json",
        "hist-2",
        vec![message("m-latest", "2026-01-02T00:00:00Z")],
        &["m-latest"],
    );
    store
        .apply_discovery_page(&[cached(source)], None, true, false, 0)
        .expect("cache source");
    {
        let conn = store.lock_conn().expect("cache lock");
        conn.execute(
            "UPDATE gmail_conversations SET reply_context_json = '{not-json}'
                 WHERE account_id = 'acct-alpha' AND conversation_id = 'thr-invalid-json'",
            [],
        )
        .expect("corrupt cached JSON");
    }
    assert_eq!(
        store.get_conversation(&ConversationRef {
            account_id: "acct-alpha".to_string(),
            conversation_id: "thr-invalid-json".to_string(),
        }),
        Err(MailError::StorageUnavailable)
    );
}

#[test]
fn reply_context_save_rejects_generation_and_latest_source_races() {
    let (store, _dir) = open_store("reply-context-races");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
        .expect("account");
    let source = thread(
        "acct-alpha",
        "thr-race",
        "hist-2",
        vec![
            message("m1", "2026-01-01T00:00:00Z"),
            message("m2", "2026-01-02T00:00:00Z"),
        ],
        &["m2"],
    );
    store
        .apply_discovery_page(&[cached(source)], None, true, false, 0)
        .expect("cache source");
    let target = ConversationRef {
        account_id: "acct-alpha".to_string(),
        conversation_id: "thr-race".to_string(),
    };
    let context = ReplyContext {
        source_message_id: "m2".to_string(),
        from_mailbox: "sender@example.test".to_string(),
        reply_to_mailboxes: None,
        message_id: "<m2@example.test>".to_string(),
        references: vec!["<m2@example.test>".to_string()],
    };
    {
        let conn = store.lock_conn().expect("test cache lock");
        conn.execute(
            "INSERT INTO gmail_messages
                 (account_id, conversation_id, message_id, from_display, from_mailbox,
                  to_json, sent_at, body_text, in_inbox)
                 VALUES ('acct-alpha', 'thr-race', 'm3', NULL, 'new@example.test', '[]',
                         '2026-01-03T00:00:00Z', 'new body', 1)",
            [],
        )
        .expect("simulate newer cached source");
    }
    assert!(!store
        .save_reply_context(&target, "m2", &context, 0)
        .expect("changed latest source rejected"));
    store.advance_generation().expect("disconnect generation");
    assert!(!store
        .save_reply_context(&target, "m2", &context, 0)
        .expect("old generation rejected"));
    assert_eq!(
        store
            .get_conversation(&target)
            .expect("reader")
            .reply_context,
        None
    );
}

fn history_page(
    changed: Vec<ThreadFetch>,
    deleted: Vec<&str>,
    next: Option<&str>,
    history_id: &str,
) -> (HistoryPage, Vec<ThreadFetch>) {
    let page = HistoryPage {
        changed_thread_ids: changed.iter().map(|f| f.id().to_string()).collect(),
        deleted_message_ids: deleted.into_iter().map(str::to_string).collect(),
        next_page_token: next.map(str::to_string),
        history_id: history_id.to_string(),
    };
    (page, changed)
}

#[test]
fn account_identity_mismatch_fails_closed() {
    let (store, _dir) = open_store("identity");
    assert_eq!(
        store.begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0),
        Ok(Commit::Applied)
    );
    match store.begin_account(&profile("acct-beta", "beta@example.test", "hist-2"), 0) {
        Err(MailError::InvalidRequest { field }) => assert_eq!(field, "accountId"),
        other => panic!("expected invalid_request(accountId), got {other:?}"),
    }
    assert_eq!(
        store.account().expect("account"),
        Some(AccountInfo {
            account_id: "acct-alpha".to_string(),
            email_address: "alpha@example.test".to_string(),
        })
    );
    // Baseline cursor was pinned by the first begin_account only.
    assert_eq!(store.cursor().expect("cursor").as_deref(), Some("hist-1"));
}

#[test]
fn baseline_is_pinned_before_discovery_and_pages_are_idempotent() {
    let (store, _dir) = open_store("discovery");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-base"), 0)
        .expect("begin account");
    assert_eq!(
        store.discovery().expect("discovery"),
        DiscoveryProgress::Pending,
        "baseline pinned before discovery, discovery still pending"
    );
    let page1 = [cached(thread(
        "acct-alpha",
        "thr-1",
        "hist-base",
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
    ))];
    store
        .apply_discovery_page(&page1, Some("page-2"), false, false, 0)
        .expect("page 1");
    assert!(matches!(
        store.discovery().expect("discovery"),
        DiscoveryProgress::Running { .. }
    ));
    let page2 = [cached(thread(
        "acct-alpha",
        "thr-2",
        "hist-base",
        vec![message("m-2", "2026-01-02T00:00:00Z")],
        &["m-2"],
    ))];
    store
        .apply_discovery_page(&page2, None, true, false, 0)
        .expect("page 2");
    assert!(matches!(
        store.discovery().expect("discovery"),
        DiscoveryProgress::Done
    ));
    assert_eq!(store.cached_count().expect("count"), 2);
    assert_eq!(
        store.seen_ids().expect("seen"),
        Vec::<String>::new(),
        "seen cleared on done"
    );
    // Replaying the final committed page must not duplicate anything.
    store
        .apply_discovery_page(&page2, None, true, false, 0)
        .expect("replay");
    assert_eq!(store.cached_count().expect("count"), 2, "idempotent replay");
}

#[test]
fn history_cursor_advances_only_after_the_final_page() {
    let (store, _dir) = open_store("history-cursor");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-base"), 0)
        .expect("begin account");
    let (page1, fetched1) = history_page(
        vec![cached(thread(
            "acct-alpha",
            "thr-1",
            "hist-base",
            vec![message("m-1", "2026-01-01T00:00:00Z")],
            &["m-1"],
        ))],
        vec![],
        Some("hist-batch-2"),
        "hist-mid",
    );
    store
        .apply_history_page(&page1, &fetched1, "hist-base", 0)
        .expect("page 1");
    // Mid-batch: cursor unchanged, batch resumable from the original start.
    assert_eq!(
        store.cursor().expect("cursor").as_deref(),
        Some("hist-base")
    );
    assert_eq!(
        store.history().expect("history"),
        HistoryProgress::Resuming {
            batch_start: "hist-base".to_string(),
            page_token: Some("hist-batch-2".to_string()),
        }
    );
    let (page2, fetched2) = history_page(
        vec![cached(thread(
            "acct-alpha",
            "thr-2",
            "hist-base",
            vec![message("m-2", "2026-01-02T00:00:00Z")],
            &["m-2"],
        ))],
        vec![],
        None,
        "hist-final",
    );
    store
        .apply_history_page(&page2, &fetched2, "hist-base", 0)
        .expect("page 2");
    assert_eq!(
        store.cursor().expect("cursor").as_deref(),
        Some("hist-final")
    );
    assert_eq!(
        store.history().expect("history"),
        HistoryProgress::Idle {
            cursor: Some("hist-final".to_string())
        }
    );
}

#[test]
fn migration_backfills_inbox_membership_from_existing_message_rows() {
    let (store, dir) = open_store("membership-migration");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
        .expect("begin account");
    store
        .apply_discovery_page(
            &[cached(thread(
                "acct-alpha",
                "thread-1",
                "hist-1",
                vec![message("message-1", "2026-01-01T00:00:00Z")],
                &["message-1"],
            ))],
            None,
            true,
            false,
            0,
        )
        .expect("seed existing profile");
    drop(store);

    // Simulate a gmail-1 profile opened by the version before independent
    // membership storage was introduced; startup migration recreates and
    // backfills the table from its existing message rows.
    let legacy = Connection::open(dir.path().join("gmail.db")).expect("open legacy db");
    legacy
            .execute_batch("DROP TABLE gmail_inbox_membership; UPDATE meta SET value = 'gmail-1' WHERE key = 'schema_version';")
            .expect("remove newly introduced table");
    drop(legacy);
    let migrated = GmailStore::open(dir.path(), Arc::new(SystemClock)).expect("migrated store");
    assert_eq!(
        migrated
            .list_snapshot()
            .expect("snapshot")
            .conversations
            .len(),
        1
    );
}

#[test]
fn unsupported_inbox_membership_is_cached_without_a_renderable_body() {
    let (store, _dir) = open_store("unsupported-membership");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
        .expect("begin account");
    let mut unsupported = thread(
        "acct-alpha",
        "html-only",
        "hist-1",
        Vec::new(),
        &["html-message"],
    );
    unsupported.conversation.subject = "HTML only".to_string();
    unsupported.conversation.context_complete = Some(false);
    unsupported.conversation.unsupported_reason = Some("no safe plain-text body".to_string());
    store
        .apply_discovery_page(&[cached(unsupported)], None, true, false, 0)
        .expect("persist unsupported membership");

    let snapshot = store.list_snapshot().expect("inbox snapshot");
    assert_eq!(snapshot.conversations.len(), 1);
    assert_eq!(snapshot.conversations[0].subject, "HTML only");
    let conversation = store
        .get_conversation(&ConversationRef {
            account_id: "acct-alpha".to_string(),
            conversation_id: "html-only".to_string(),
        })
        .expect("reader context remains reachable");
    assert!(conversation.messages.is_empty());
    assert_eq!(conversation.context_complete, Some(false));
    assert_eq!(
        conversation.unsupported_reason.as_deref(),
        Some("no safe plain-text body")
    );
}

#[test]
fn account_mismatched_thread_facts_are_rejected_at_store_boundary() {
    let (store, _dir) = open_store("thread-account-mismatch");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
        .expect("begin account");
    let foreign = thread(
        "acct-beta",
        "foreign-thread",
        "hist-2",
        vec![message("foreign-message", "2026-01-01T00:00:00Z")],
        &["foreign-message"],
    );
    assert_eq!(
        store.apply_discovery_page(&[cached(foreign)], None, true, false, 0),
        Err(MailError::InvalidProviderResponse)
    );
    assert_eq!(store.cached_count().expect("cache count"), 0);
}

#[test]
fn discovery_checkpoints_keep_cache_capped_and_prefer_observed_threads() {
    let (store, _dir) = open_store("partial-cap");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
        .expect("begin account");
    let initial: Vec<_> = (0..DISCOVERY_CAP)
        .map(|index| {
            cached(thread(
                "acct-alpha",
                &format!("old-{index:03}"),
                "hist-1",
                vec![message(
                    &format!("old-message-{index:03}"),
                    "2025-01-01T00:00:00Z",
                )],
                &[&format!("old-message-{index:03}")],
            ))
        })
        .collect();
    store
        .apply_discovery_page(&initial, None, true, false, 0)
        .expect("seed full cache");
    let fresh: Vec<_> = (0..60)
        .map(|index| {
            cached(thread(
                "acct-alpha",
                &format!("new-{index:03}"),
                "hist-2",
                vec![message(
                    &format!("new-message-{index:03}"),
                    "2026-01-01T00:00:00Z",
                )],
                &[&format!("new-message-{index:03}")],
            ))
        })
        .collect();
    store
        .apply_discovery_page(&fresh, Some("resume"), false, false, 0)
        .expect("commit partial rediscovery page");
    assert_eq!(
        store.cached_count().expect("bounded cache count"),
        DISCOVERY_CAP
    );
    let ids: Vec<_> = store
        .list_snapshot()
        .expect("snapshot")
        .conversations
        .into_iter()
        .map(|summary| summary.conversation_ref.conversation_id)
        .collect();
    for index in 0..60 {
        assert!(
            ids.contains(&format!("new-{index:03}")),
            "observed thread retained"
        );
    }
    // Completing an uncapped continuation remains capped before history.
    let tail: Vec<_> = (60..65)
        .map(|index| {
            cached(thread(
                "acct-alpha",
                &format!("new-{index:03}"),
                "hist-2",
                vec![message(
                    &format!("new-message-{index:03}"),
                    "2026-01-01T00:00:00Z",
                )],
                &[&format!("new-message-{index:03}")],
            ))
        })
        .collect();
    store
        .apply_discovery_page(&tail, None, true, false, 0)
        .expect("complete rediscovery");
    assert!(store.cached_count().expect("bounded cache count") <= DISCOVERY_CAP);
}

#[test]
fn stale_inbox_membership_is_reconciled_by_a_complete_discovery_pass() {
    let (store, _dir) = open_store("reconcile");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-base"), 0)
        .expect("begin account");
    let initial = [cached(thread(
        "acct-alpha",
        "thr-1",
        "hist-base",
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
    ))];
    store
        .apply_discovery_page(&initial, None, true, false, 0)
        .expect("initial page");
    assert_eq!(
        store.list_snapshot().expect("snapshot").conversations.len(),
        1
    );
    // A later complete pass that does not observe thr-1 reconciles its
    // stale INBOX membership (external archive/delete), same transaction.
    store
        .apply_discovery_page(&[], None, true, false, 0)
        .expect("reconciling pass");
    let snapshot = store.list_snapshot().expect("snapshot");
    assert!(
        snapshot.conversations.is_empty(),
        "stale member dropped from inbox"
    );
    let conversation = store
        .get_conversation(&ConversationRef {
            account_id: "acct-alpha".to_string(),
            conversation_id: "thr-1".to_string(),
        })
        .expect("still cached and readable");
    assert!(!conversation.is_in_inbox);
}

#[test]
fn deleted_messages_emptied_conversations_are_removed() {
    let (store, _dir) = open_store("deletion");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-base"), 0)
        .expect("begin account");
    let (page1, fetched1) = history_page(
        vec![cached(thread(
            "acct-alpha",
            "thr-1",
            "hist-base",
            vec![
                message("m-1", "2026-01-01T00:00:00Z"),
                message("m-2", "2026-01-02T00:00:00Z"),
            ],
            &["m-1", "m-2"],
        ))],
        vec![],
        None,
        "hist-1",
    );
    store
        .apply_history_page(&page1, &fetched1, "hist-base", 0)
        .expect("seed page");
    // Provider-reported thread deletion (get_thread -> None) removes the thread.
    let (page2, fetched2) = history_page(
        vec![ThreadFetch::Missing("thr-1".to_string())],
        vec![],
        None,
        "hist-2",
    );
    store
        .apply_history_page(&page2, &fetched2, "hist-1", 0)
        .expect("removal page");
    assert_eq!(store.cached_count().expect("count"), 0);
    match store.get_conversation(&ConversationRef {
        account_id: "acct-alpha".to_string(),
        conversation_id: "thr-1".to_string(),
    }) {
        Err(MailError::NotFound) => {}
        other => panic!("expected not_found, got {other:?}"),
    }
    // Message-level deletion that empties a conversation also removes it.
    let seeded = [cached(thread(
        "acct-alpha",
        "thr-2",
        "hist-2",
        vec![message("m-3", "2026-01-03T00:00:00Z")],
        &["m-3"],
    ))];
    store
        .apply_discovery_page(&seeded, None, true, false, 0)
        .expect("seed thr-2");
    let (page3, fetched3) = history_page(vec![], vec!["m-3"], None, "hist-3");
    store
        .apply_history_page(&page3, &fetched3, "hist-2", 0)
        .expect("message deletion page");
    assert_eq!(
        store.cached_count().expect("count"),
        0,
        "emptied conversation removed"
    );
}

#[test]
fn stale_generation_discards_disconnect_raced_writes() {
    let (store, _dir) = open_store("generation");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-base"), 0)
        .expect("begin account");
    store.advance_generation().expect("advance");
    let page = [cached(thread(
        "acct-alpha",
        "thr-1",
        "hist-base",
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
    ))];
    assert_eq!(
        store.apply_discovery_page(&page, None, true, false, 0),
        Ok(Commit::Discarded),
        "in-flight write from before the generation bump is discarded"
    );
    assert_eq!(
        store.cached_count().expect("count"),
        0,
        "stale result did not repopulate"
    );
    let fresh = [cached(thread(
        "acct-alpha",
        "thr-1",
        "hist-base",
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
    ))];
    assert_eq!(
        store.apply_discovery_page(&fresh, None, true, false, 1),
        Ok(Commit::Applied),
        "a fresh pass after the bump applies normally"
    );
    assert_eq!(store.cached_count().expect("count"), 1);
}

#[test]
fn saved_split_is_durable_account_scoped_and_removed_on_disconnect() {
    use crate::splits::{SavedSplit, SplitCriterion};
    let (store, dir) = open_store("saved-split");
    store
        .begin_account(&profile("acct", "a@example.test", "h1"), 0)
        .unwrap();
    let split = SavedSplit {
        name: "Clients".into(),
        criterion: SplitCriterion::Sender,
        value: "Alice@Example.TEST".into(),
        enabled: true,
        hide_when_empty: false,
    };
    let saved = store.save_saved_split("acct", &split).unwrap();
    assert_eq!(saved.value, "alice@example.test");
    assert_eq!(store.get_saved_split("other"), Err(MailError::NotFound));
    assert_eq!(
        store.save_saved_split("other", &split),
        Err(MailError::NotFound)
    );
    drop(store);
    let store = GmailStore::open(dir.path(), Arc::new(SystemClock)).unwrap();
    assert_eq!(store.get_saved_split("acct").unwrap(), Some(saved));
    store.set_test_persistence_failure(true);
    assert_eq!(
        store.save_saved_split("acct", &split),
        Err(MailError::StorageUnavailable)
    );
    store.set_test_persistence_failure(false);
    store.clear_account().unwrap();
    store
        .begin_account(&profile("acct", "a@example.test", "h2"), 1)
        .unwrap();
    assert_eq!(store.get_saved_split("acct").unwrap(), None);
    drop(store);
}

#[test]
fn clear_account_wipes_identity_cache_and_checkpoints() {
    let (store, _dir) = open_store("clear");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-base"), 0)
        .expect("begin account");
    let page = [cached(thread(
        "acct-alpha",
        "thr-1",
        "hist-base",
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
    ))];
    store
        .apply_discovery_page(&page, None, true, false, 0)
        .expect("page");
    store.clear_account().expect("clear");
    assert!(!store.has_account().expect("has account"));
    assert_eq!(store.account().expect("account"), None);
    assert_eq!(store.cached_count().expect("count"), 0);
    assert!(store
        .list_snapshot()
        .expect("snapshot")
        .conversations
        .is_empty());
    assert_eq!(store.cursor().expect("cursor"), None);
    assert!(matches!(
        store.discovery().expect("discovery"),
        DiscoveryProgress::Pending
    ));
}

/// Storage failures surface typed instead of being logged-and-ignored.
#[test]
fn operation_recovery_snapshot_survives_cache_eviction_and_can_be_restored() {
    let (store, _dir) = open_store("operation-retention");
    store
        .begin_account(&profile("acct-alpha", "alpha@example.test", "hist-1"), 0)
        .expect("begin account");
    store
        .apply_discovery_page(
            &[cached(thread(
                "acct-alpha",
                "old-target",
                "hist-1",
                vec![message("old-message", "2026-01-01T00:00:00Z")],
                &["old-message"],
            ))],
            None,
            true,
            false,
            0,
        )
        .expect("seed target");
    let target = ConversationRef {
        account_id: "acct-alpha".to_string(),
        conversation_id: "old-target".to_string(),
    };
    store
        .accept_read(&SetRead {
            conversation: target.clone(),
            read: true,
            request_id: "retained-read".to_string(),
        })
        .expect("durable acceptance");

    let mut additions = Vec::new();
    for index in 0..100 {
        let id = format!("new-{index:03}");
        additions.push(cached(thread(
            "acct-alpha",
            &id,
            "hist-2",
            vec![message(
                &format!("message-{index:03}"),
                "2026-03-01T00:00:00Z",
            )],
            &[&format!("message-{index:03}")],
        )));
    }
    let page = HistoryPage {
        changed_thread_ids: Vec::new(),
        deleted_message_ids: Vec::new(),
        next_page_token: None,
        history_id: "hist-2".to_string(),
    };
    store
        .apply_history_page(&page, &additions, "hist-1", 0)
        .expect("evict old target");
    assert_eq!(store.cached_count().expect("cache count"), DISCOVERY_CAP);
    // A later history fetch sees the evicted operation context archived,
    // with a new message and changed UNREAD facts. Persist those facts
    // without admitting its bodies back into the bounded cache.
    let mut fetched = thread(
        "acct-alpha",
        "old-target",
        "hist-3",
        vec![
            message("old-message", "2026-01-01T00:00:00Z"),
            message("new-message", "2026-04-01T00:00:00Z"),
        ],
        &[],
    );
    fetched.message_ids = Some(vec!["old-message".to_string(), "new-message".to_string()]);
    fetched.unread_message_ids = Some(vec!["new-message".to_string()]);
    let refresh_page = HistoryPage {
        changed_thread_ids: vec!["old-target".to_string()],
        deleted_message_ids: Vec::new(),
        next_page_token: None,
        history_id: "hist-3".to_string(),
    };
    store
        .apply_history_page(&refresh_page, &[cached(fetched)], "hist-2", 0)
        .expect("refresh retained operation facts");
    assert_eq!(store.cached_count().expect("bounded cache"), DISCOVERY_CAP);

    let retained = store
        .get_conversation(&target)
        .expect("retained recovery reader");
    assert!(retained
        .retained_snapshot_at
        .as_deref()
        .is_some_and(|saved_at| saved_at.contains('T')));
    assert_eq!(retained.messages[0].id, "old-message");
    assert!(!retained.is_in_inbox, "refreshed INBOX fact is persisted");
    assert_eq!(
        retained.is_read,
        Some(false),
        "refreshed UNREAD fact is persisted"
    );
    let restore = SetArchived {
        conversation: target.clone(),
        archived: false,
        request_id: "retained-unarchive".to_string(),
    };
    let receipt = store
        .accept_archived(&restore)
        .expect("restore after eviction");
    let conn = store.lock_conn().expect("store connection");
    let operation = load_operation(&conn, "acct-alpha", &receipt.operation_id)
        .expect("load restored targets")
        .expect("restored operation");
    assert_eq!(operation.message_ids, vec!["new-message", "old-message"]);
    drop(conn);
    let restored = store
        .get_conversation(&restore.conversation)
        .expect("reader remains available");
    assert!(restored.is_in_inbox);
    assert!(restored.retained_snapshot_at.is_some());
    drop(store);
}

#[test]
fn capped_rediscovery_retains_full_recovery_inventory_not_unretained_facts() {
    let (store, _dir) = open_store("rediscovery-inventory");
    store
        .begin_account(&profile("acct", "a@example.test", "h1"), 0)
        .unwrap();
    let original = thread(
        "acct",
        "retained",
        "h1",
        vec![message("original", "2026-01-01T00:00:00Z")],
        &["original"],
    );
    store
        .apply_discovery_page(
            &[
                cached(original.clone()),
                cached(thread(
                    "acct",
                    "unretained",
                    "h1",
                    vec![message("orphan", "2026-01-01T00:00:00Z")],
                    &["orphan"],
                )),
            ],
            None,
            true,
            false,
            0,
        )
        .unwrap();
    let target = original.conversation.conversation_ref.clone();
    let receipt = store
        .accept_starred(&crate::stars::SetStarred {
            conversation: target.clone(),
            starred: false,
            request_id: "original-unstar".into(),
        })
        .unwrap();
    let mut updated = original;
    updated.message_ids = Some(vec![
        "original".into(),
        "arrival".into(),
        "unknown-arrival".into(),
    ]);
    updated.inbox_message_ids.push("arrival".into());
    updated.unread_message_ids = Some(vec!["arrival".into()]);
    updated.star_facts = Some(HashMap::from([
        ("original".into(), false),
        ("arrival".into(), true),
    ]));
    store
        .apply_discovery_page(&[cached(updated)], None, false, false, 0)
        .unwrap();
    store.begin_rediscovery("h2", 0).unwrap();
    // A capped replacement excludes both old conversations. Only the one
    // with a durable recovery snapshot keeps its whole observed inventory.
    store
        .apply_discovery_page(&[], None, true, true, 0)
        .unwrap();
    let retained = store.get_conversation(&target).unwrap();
    assert!(retained.retained_snapshot_at.is_some());
    let stars = retained.stars.unwrap();
    assert_eq!(stars.total_messages, 3);
    assert_eq!(stars.known_messages, 2);
    assert_eq!(stars.starred_messages, 1);
    assert!(retained.is_in_inbox);
    assert_eq!(retained.is_read, Some(false));
    let conn = store.lock_conn().unwrap();
    let operation = load_operation(&conn, "acct", &receipt.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(operation.message_ids, vec!["original"]);
    let orphan_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM gmail_message_facts WHERE conversation_id = 'unretained'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(orphan_count, 0);
    drop(conn);
    store
        .apply_history_page(
            &HistoryPage {
                changed_thread_ids: Vec::new(),
                deleted_message_ids: vec!["arrival".into()],
                next_page_token: None,
                history_id: "h3".into(),
            },
            &[],
            "h2",
            0,
        )
        .unwrap();
    let remaining = store.get_conversation(&target).unwrap().stars.unwrap();
    assert_eq!(remaining.total_messages, 2);
    assert_eq!(remaining.known_messages, 1);
    assert_eq!(remaining.is_starred(), None, "unknown arrival is not false");
    store.clear_account().unwrap();
    let conn = store.lock_conn().unwrap();
    let fact_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM gmail_message_facts", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(fact_count, 0, "disconnect also clears retained inventory");
    drop(conn);
    drop(store);
}

#[test]
fn persistence_failure_is_surfaced_not_ignored() {
    let (store, _dir) = open_store("failure");
    assert!(store.has_account().is_ok());
    store.set_test_persistence_failure(true);
    assert_eq!(store.has_account(), Err(MailError::StorageUnavailable));
    assert_eq!(store.clear_account(), Err(MailError::StorageUnavailable));
    store.set_test_persistence_failure(false);
    assert!(store.has_account().is_ok());
}
#[test]
fn list_cached_done_membership_scoping_ordering_bounds_and_recovery() {
    use crate::dto::CachedDoneRequest;
    let (store, dir) = open_store("cached-done");
    store
        .begin_account(&profile("acct", "a@example.test", "h1"), 0)
        .unwrap();
    let ids = [
        "a",
        "b",
        "failed",
        "restore",
        "incoming",
        "unknown",
        "sent-only",
        "spam-only",
        "trash-only",
    ];
    let threads: Vec<_> = ids
        .iter()
        .map(|id| {
            cached(thread(
                "acct",
                id,
                "h1",
                vec![message(&format!("m-{id}"), "2026-02-01T00:00:00Z")],
                &[&format!("m-{id}")],
            ))
        })
        .collect();
    store
        .apply_discovery_page(&threads, None, true, false, 0)
        .unwrap();
    for id in &ids[..6] {
        store
            .accept_archived(&SetArchived {
                conversation: ConversationRef {
                    account_id: "acct".into(),
                    conversation_id: (*id).into(),
                },
                archived: true,
                request_id: format!("archive-{id}"),
            })
            .unwrap();
    }
    {
        let conn = store.lock_conn().unwrap();
        conn.execute("UPDATE gmail_message_facts SET in_inbox = 0 WHERE conversation_id IN ('sent-only', 'spam-only', 'trash-only')", []).unwrap();
        conn.execute(
            "UPDATE gmail_operations SET status = 'failed' WHERE conversation_id = 'failed'",
            [],
        )
        .unwrap();
        conn.execute("UPDATE gmail_operations SET status = 'confirmed' WHERE conversation_id IN ('a', 'b', 'incoming', 'unknown')", []).unwrap();
        conn.execute(
            "UPDATE gmail_message_facts SET in_inbox = 0 WHERE conversation_id IN ('a', 'b')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE gmail_message_facts SET in_inbox = NULL WHERE conversation_id = 'unknown'",
            [],
        )
        .unwrap();
        conn.execute(
                "INSERT INTO gmail_message_facts (account_id, conversation_id, message_id, in_inbox, is_unread) VALUES ('acct', 'incoming', 'new-arrival', 1, 0)",
                [],
            )
            .unwrap();
        // A foreign account with a lexically newer row must never leak in.
        conn.execute("INSERT INTO gmail_operations (account_id, operation_id, conversation_id, kind, requested_value, status, failure, last_error, accepted_seq, accepted_at, request_id, undo_of) SELECT 'foreign', 'foreign-op', 'a', kind, requested_value, status, failure, last_error, accepted_seq, accepted_at, request_id, undo_of FROM gmail_operations WHERE conversation_id = 'a'", []).unwrap();
    }
    store
        .accept_archived(&SetArchived {
            conversation: ConversationRef {
                account_id: "acct".into(),
                conversation_id: "restore".into(),
            },
            archived: false,
            request_id: "restore".into(),
        })
        .unwrap();
    let mut request = CachedDoneRequest {
        account_id: "acct".into(),
        limit: 1,
        cursor: None,
    };
    let first = store.list_cached_done(&request).unwrap();
    assert_eq!(first.conversations[0].conversation_ref.conversation_id, "a");
    assert_eq!(first.exact_total, None);
    assert_eq!(first.last_synced_at, store.last_synced_at().unwrap());
    request.cursor = first.next_cursor;
    let second = store.list_cached_done(&request).unwrap();
    assert_eq!(
        second.conversations[0].conversation_ref.conversation_id,
        "b"
    );
    request.cursor = second.next_cursor;
    let mut pages = 2;
    while request.cursor.is_some() {
        let page = store.list_cached_done(&request).unwrap();
        assert!(
            page.conversations.is_empty(),
            "restored, failed, incoming and unknown are excluded"
        );
        request.cursor = page.next_cursor;
        pages += 1;
        assert!(pages <= 6, "candidate paging must terminate");
    }
    assert_eq!(pages, 5); // failed and unrelated non-INBOX rows are not candidates.
    for limit in [0, 101, u32::MAX] {
        request.limit = limit;
        assert!(
            matches!(store.list_cached_done(&request), Err(MailError::InvalidRequest { field }) if field == "limit")
        );
    }
    request.limit = 100;
    request.cursor = Some("bad-cursor".into());
    assert!(
        matches!(store.list_cached_done(&request), Err(MailError::InvalidRequest { field }) if field == "cursor")
    );
    request.cursor = Some("cached-done-v1:[\"foreign\",\"date\",\"id\"]".into());
    assert!(
        matches!(store.list_cached_done(&request), Err(MailError::InvalidRequest { field }) if field == "cursor")
    );
    request.cursor = None;
    request.account_id = "foreign".into();
    assert_eq!(store.list_cached_done(&request), Err(MailError::NotFound));
    request.account_id = "acct".into();
    // Real persisted operation snapshot, then remove only bounded cache bodies.
    {
        let conn = store.lock_conn().unwrap();
        conn.execute("UPDATE gmail_conversations SET context_complete = 0, unsupported_reason = 'synthetic incomplete' WHERE conversation_id = 'a'", []).unwrap();
    }
    store
        .accept_archived(&SetArchived {
            conversation: ConversationRef {
                account_id: "acct".into(),
                conversation_id: "a".into(),
            },
            archived: true,
            request_id: "refresh-snapshot".into(),
        })
        .unwrap();
    {
        let conn = store.lock_conn().unwrap();
        conn.execute(
            "DELETE FROM gmail_messages WHERE account_id = 'acct' AND conversation_id = 'a'",
            [],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM gmail_conversations WHERE account_id = 'acct' AND conversation_id = 'a'",
            [],
        )
        .unwrap();
        // Simulate a pre-UX03 profile: reopen must backfill lightweight sort metadata.
        conn.execute(
            "UPDATE meta SET value = 'gmail-2' WHERE key = 'schema_version'",
            [],
        )
        .unwrap();
        conn.execute(
            "ALTER TABLE gmail_operation_snapshots DROP COLUMN last_message_at",
            [],
        )
        .unwrap();
    }
    drop(store);
    let store = GmailStore::open(dir.path(), Arc::new(SystemClock)).unwrap();
    let page = store.list_cached_done(&request).unwrap();
    assert_eq!(page.conversations.len(), 2);
    assert_eq!(page.conversations[0].conversation_ref.conversation_id, "a");
    let retained = store
        .get_conversation(&page.conversations[0].conversation_ref)
        .unwrap();
    assert!(retained.retained_snapshot_at.is_some());
    assert_eq!(retained.context_complete, Some(false));
    assert_eq!(
        retained.unsupported_reason.as_deref(),
        Some("synthetic incomplete")
    );
    // An unselected retained body is not parsed to sort a one-row page.
    {
        let conn = store.lock_conn().unwrap();
        conn.execute("DELETE FROM gmail_messages WHERE conversation_id = 'b'", [])
            .unwrap();
        conn.execute(
            "DELETE FROM gmail_conversations WHERE conversation_id = 'b'",
            [],
        )
        .unwrap();
        conn.execute("UPDATE gmail_operation_snapshots SET snapshot_json = 'invalid-unselected-body' WHERE conversation_id = 'b'", []).unwrap();
    }
    request.limit = 1;
    let bounded = store.list_cached_done(&request).unwrap();
    assert_eq!(
        bounded.conversations[0].conversation_ref.conversation_id,
        "a"
    );
    assert!(bounded.next_cursor.is_some());
    drop(store);
}
// -------------------------------------------------- UX-05 group tests

fn open_store_with_clock(tag: &str, clock: Arc<dyn Clock>) -> (GmailStore, tempfile::TempDir) {
    let dir = temp_dir(tag);
    let store = GmailStore::open(dir.path(), clock).expect("store opens");
    (store, dir)
}

/// Seeds an account and three cached threads, each with two messages,
/// all in the inbox and all unread (known read facts so read-kind
/// preimages are capturable).
fn seed_group_threads(store: &GmailStore, thread_ids: &[&str]) {
    store
        .begin_account(&profile("acct", "acct@example.test", "hist-1"), 0)
        .expect("account");
    let fetches: Vec<ThreadFetch> = thread_ids
        .iter()
        .map(|id| {
            let mut thread = thread(
                "acct",
                id,
                "hist-2",
                vec![
                    message(&format!("{id}-m1"), "2026-01-01T00:00:00Z"),
                    message(&format!("{id}-m2"), "2026-01-02T00:00:00Z"),
                ],
                &[&format!("{id}-m1"), &format!("{id}-m2")],
            );
            thread.unread_message_ids = Some(vec![format!("{id}-m1"), format!("{id}-m2")]);
            cached(thread)
        })
        .collect();
    store
        .apply_discovery_page(&fetches, None, true, false, 0)
        .expect("cache threads");
}

fn group_ref(id: &str) -> ConversationRef {
    ConversationRef {
        account_id: "acct".to_string(),
        conversation_id: id.to_string(),
    }
}

fn group_counts(store: &GmailStore) -> (usize, usize) {
    let conn = store.lock_conn().expect("conn");
    let operations: i64 = conn
        .query_row("SELECT COUNT(*) FROM gmail_operations", [], |row| {
            row.get(0)
        })
        .unwrap();
    let groups: i64 = conn
        .query_row("SELECT COUNT(*) FROM gmail_operation_groups", [], |row| {
            row.get(0)
        })
        .unwrap();
    (operations as usize, groups as usize)
}

/// Archive and read groups both accept atomically; the canonical payload
/// makes reordered replays return the original receipt and ordering; a
/// changed payload conflicts (§7.4).
#[test]
fn gmail_group_acceptance_is_idempotent_for_archive_and_read() {
    let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
        "2026-01-01T00:00:00Z",
    )));
    let (store, _dir) = open_store_with_clock("gmail-group-idempotent", clock);
    seed_group_threads(&store, &["thr-a", "thr-b"]);

    let command = crate::groups::SetReadGroup {
        account_id: "acct".into(),
        members: vec![group_ref("thr-b"), group_ref("thr-a")],
        read: true,
        request_id: "gmail-group-req-1".into(),
    };
    let receipt = store.accept_read_group(&command).expect("read group");
    assert_eq!(receipt.kind, MailboxOperationKind::Read);
    assert_eq!(receipt.requested_read, Some(true));
    assert_eq!(receipt.members[0].conversation.conversation_id, "thr-b");
    let replay = store.accept_read_group(&command).expect("replay");
    assert_eq!(replay, receipt);
    // Reordered replay: same canonical identity, original ordering kept.
    let reordered = crate::groups::SetReadGroup {
        members: vec![group_ref("thr-a"), group_ref("thr-b")],
        ..command.clone()
    };
    assert_eq!(
        store.accept_read_group(&reordered).expect("replay"),
        receipt
    );
    // Changed payload conflicts.
    assert_eq!(
        store.accept_read_group(&crate::groups::SetReadGroup {
            read: false,
            ..command.clone()
        }),
        Err(MailError::RequestIdConflict)
    );
    // Cross-command reuse of the request id conflicts.
    assert_eq!(
        store.accept_archived(&SetArchived {
            conversation: group_ref("thr-a"),
            archived: true,
            request_id: "gmail-group-req-1".into(),
        }),
        Err(MailError::RequestIdConflict)
    );

    // Archive group on a fresh request id.
    let archive_receipt = store
        .accept_archived_group(&crate::groups::SetArchivedGroup {
            account_id: "acct".into(),
            members: vec![group_ref("thr-a")],
            archived: true,
            request_id: "gmail-group-req-2".into(),
        })
        .expect("archive group");
    assert_eq!(archive_receipt.kind, MailboxOperationKind::Archive);
    assert_eq!(archive_receipt.requested_archived, Some(true));
    assert_eq!(group_counts(&store), (3, 2));
    drop(store);
}

/// A member without immutable targets is a persisted acceptance rejection
/// (never a fabricated failed operation); valid siblings are accepted and
/// the replay returns the identical receipt (§7.2).
#[test]
fn gmail_group_member_rejection_is_persisted_and_savepointed() {
    let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
        "2026-01-01T00:00:00Z",
    )));
    let (store, _dir) = open_store_with_clock("gmail-group-rejection", clock);
    seed_group_threads(&store, &["thr-a"]);
    let receipt = store
        .accept_archived_group(&crate::groups::SetArchivedGroup {
            account_id: "acct".into(),
            members: vec![group_ref("thr-a"), group_ref("missing-thr")],
            archived: true,
            request_id: "gmail-group-req-mixed".into(),
        })
        .expect("mixed group accepted");
    assert!(receipt.members[0].operation_id.is_some());
    assert_eq!(
        receipt.members[1].rejection,
        Some(GroupMemberRejection::ConversationMissing)
    );
    assert_eq!(receipt.members[1].operation_id, None);
    assert_eq!(group_counts(&store), (1, 1), "one child, one group");
    // Rejected member left no partial request/target rows behind: only
    // the group's own request row and the accepted child's remain.
    {
        let conn = store.lock_conn().unwrap();
        let requests: i64 = conn
            .query_row("SELECT COUNT(*) FROM gmail_operation_requests", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(requests, 2, "group request row + accepted child only");
    }
    let status = store
        .get_operation_group(&crate::groups::GetOperationGroupRequest {
            account_id: "acct".into(),
            request_id: "gmail-group-req-mixed".into(),
        })
        .expect("lookup")
        .expect("committed");
    assert_eq!(
        status.members[1].status,
        crate::groups::GroupMemberStatus::Rejected
    );
    assert_eq!(
        status.members[0].status,
        crate::groups::GroupMemberStatus::Queued
    );
    assert!(status.undo.available);
    let replay = store
        .accept_archived_group(&crate::groups::SetArchivedGroup {
            members: vec![group_ref("missing-thr"), group_ref("thr-a")],
            ..crate::groups::SetArchivedGroup {
                account_id: "acct".into(),
                members: Vec::new(),
                archived: true,
                request_id: "gmail-group-req-mixed".into(),
            }
        })
        .expect("replay");
    assert_eq!(replay, receipt, "original ordering preserved on replay");
    drop(store);
}

/// Storage failure at acceptance rejects the whole group; the same
/// request retried after recovery commits exactly once (§7.3).
#[test]
fn gmail_group_storage_failure_rolls_back_and_retry_is_safe() {
    let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
        "2026-01-01T00:00:00Z",
    )));
    let (store, _dir) = open_store_with_clock("gmail-group-rollback", clock);
    seed_group_threads(&store, &["thr-a", "thr-b"]);
    store.set_test_persistence_failure(true);
    assert_eq!(
        store.accept_archived_group(&crate::groups::SetArchivedGroup {
            account_id: "acct".into(),
            members: vec![group_ref("thr-a"), group_ref("thr-b")],
            archived: true,
            request_id: "gmail-group-req-rb".into(),
        }),
        Err(MailError::StorageUnavailable)
    );
    assert_eq!(group_counts(&store), (0, 0));
    store.set_test_persistence_failure(false);
    let receipt = store
        .accept_archived_group(&crate::groups::SetArchivedGroup {
            account_id: "acct".into(),
            members: vec![group_ref("thr-a"), group_ref("thr-b")],
            archived: true,
            request_id: "gmail-group-req-rb".into(),
        })
        .expect("retry safe");
    assert_eq!(receipt.members.len(), 2);
    drop(store);
}

/// Group Undo at 9 seconds (§7.6): confirmed member compensates from the
/// original targets/preimages, failed and unknown members are skipped
/// with typed reasons, queued member cancels; no rollback of successful
/// siblings; one attempt, idempotent replay.
#[test]
fn gmail_group_undo_is_partial_typed_and_one_shot() {
    let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
        "2026-01-01T00:00:00Z",
    )));
    let (store, _dir) = open_store_with_clock("gmail-group-undo", clock.clone());
    seed_group_threads(&store, &["thr-a", "thr-b", "thr-c"]);
    let receipt = store
        .accept_read_group(&crate::groups::SetReadGroup {
            account_id: "acct".into(),
            members: vec![group_ref("thr-a"), group_ref("thr-b"), group_ref("thr-c")],
            read: true,
            request_id: "gmail-group-req-u".into(),
        })
        .expect("read group");
    let ops: Vec<String> = receipt
        .members
        .iter()
        .map(|m| m.operation_id.clone().unwrap())
        .collect();
    // thr-a confirms, thr-b fails, thr-c stays queued.
    let claimed_a = store.claim_next_operation().unwrap().unwrap();
    assert_eq!(claimed_a.operation_id, ops[0]);
    store.confirm_operation(&claimed_a).unwrap();
    let claimed_b = store.claim_next_operation().unwrap().unwrap();
    assert_eq!(claimed_b.operation_id, ops[1]);
    store
        .fail_operation(&claimed_b, MailError::ProviderRejected)
        .unwrap();

    clock.advance_seconds(9);
    let undo = store
        .undo_operation_group(&crate::groups::UndoOperationGroup {
            group_id: receipt.group_id.clone(),
            request_id: "gmail-undo-group-1".into(),
        })
        .expect("group undo");
    assert_eq!(
        undo.members[0].decision,
        crate::groups::GroupMemberUndoDecision::Compensating
    );
    assert!(!undo.members[0].operation_ids.is_empty());
    assert_eq!(
        undo.members[1].decision,
        crate::groups::GroupMemberUndoDecision::Skipped {
            reason: crate::groups::GroupUndoSkipReason::Failed
        }
    );
    assert_eq!(
        undo.members[2].decision,
        crate::groups::GroupMemberUndoDecision::Cancelled
    );

    // One attempt: replay identical; second different request rejected.
    let replay = store
        .undo_operation_group(&crate::groups::UndoOperationGroup {
            group_id: receipt.group_id.clone(),
            request_id: "gmail-undo-group-1".into(),
        })
        .expect("replay");
    assert_eq!(replay, undo);
    assert_eq!(
        store.undo_operation_group(&crate::groups::UndoOperationGroup {
            group_id: receipt.group_id.clone(),
            request_id: "gmail-undo-group-2".into(),
        }),
        Err(MailError::UndoUnavailable {
            reason: UndoUnavailableReason::AlreadyUndone
        })
    );
    // Member statuses: confirmed original, failed original, cancelled.
    let status = store
        .get_operation_group(&crate::groups::GetOperationGroupRequest {
            account_id: "acct".into(),
            request_id: "gmail-group-req-u".into(),
        })
        .expect("lookup")
        .expect("committed");
    assert_eq!(
        status.members[0].status,
        crate::groups::GroupMemberStatus::Confirmed
    );
    assert_eq!(
        status.members[1].status,
        crate::groups::GroupMemberStatus::Failed
    );
    assert_eq!(
        status.members[2].status,
        crate::groups::GroupMemberStatus::Cancelled
    );
    assert_eq!(
        status.undo.reason,
        Some(UndoUnavailableReason::AlreadyUndone)
    );
    drop(store);
}

/// Outcome-unknown members are explicitly skipped (never compensated,
/// never silently retried) while eligible siblings still undo (§7.5/§7.6).
#[test]
fn gmail_group_undo_skips_unknown_members_and_keeps_sibling_recovery() {
    let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
        "2026-01-01T00:00:00Z",
    )));
    let (store, _dir) = open_store_with_clock("gmail-group-unknown", clock.clone());
    seed_group_threads(&store, &["thr-a", "thr-b"]);
    let receipt = store
        .accept_read_group(&crate::groups::SetReadGroup {
            account_id: "acct".into(),
            members: vec![group_ref("thr-a"), group_ref("thr-b")],
            read: true,
            request_id: "gmail-group-req-unk".into(),
        })
        .expect("read group");
    let ops: Vec<String> = receipt
        .members
        .iter()
        .map(|m| m.operation_id.clone().unwrap())
        .collect();
    // thr-a becomes outcome-unknown (interrupted dispatch).
    let claimed_a = store.claim_next_operation().unwrap().unwrap();
    assert_eq!(claimed_a.operation_id, ops[0]);
    store.unknown_operation(&claimed_a).unwrap();
    clock.advance_seconds(1);
    let undo = store
        .undo_operation_group(&crate::groups::UndoOperationGroup {
            group_id: receipt.group_id.clone(),
            request_id: "gmail-undo-unk".into(),
        })
        .expect("group undo");
    assert_eq!(
        undo.members[0].decision,
        crate::groups::GroupMemberUndoDecision::Skipped {
            reason: crate::groups::GroupUndoSkipReason::OutcomeUnknown
        }
    );
    assert_eq!(
        undo.members[1].decision,
        crate::groups::GroupMemberUndoDecision::Cancelled
    );
    drop(store);
}

/// Expiry, supersession by a newer single/group/retry, and the child
/// single-Undo bypass all fail closed with typed reasons (§7.7).
#[test]
fn gmail_group_undo_respects_expiry_supersession_and_no_child_bypass() {
    let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
        "2026-01-01T00:00:00Z",
    )));
    let (store, _dir) = open_store_with_clock("gmail-group-gates", clock.clone());
    seed_group_threads(&store, &["thr-a", "thr-b", "thr-c"]);
    let receipt = store
        .accept_archived_group(&crate::groups::SetArchivedGroup {
            account_id: "acct".into(),
            members: vec![group_ref("thr-a"), group_ref("thr-b")],
            archived: true,
            request_id: "gmail-group-req-g".into(),
        })
        .expect("group accepted");
    let child = receipt.members[0].operation_id.clone().unwrap();

    // A single Undo of a group child never bypasses group ordering.
    assert_eq!(
        store.undo_operation(&UndoOperation {
            operation_id: child.clone(),
            request_id: "child-bypass".into(),
        }),
        Err(MailError::UndoUnavailable {
            reason: UndoUnavailableReason::NotApplicable
        })
    );
    // A newer single action supersedes the group.
    store
        .accept_archived(&SetArchived {
            conversation: group_ref("thr-c"),
            archived: true,
            request_id: "single-after-group".into(),
        })
        .expect("single accepted");
    assert_eq!(
        store.undo_operation_group(&crate::groups::UndoOperationGroup {
            group_id: receipt.group_id.clone(),
            request_id: "undo-after-single".into(),
        }),
        Err(MailError::UndoUnavailable {
            reason: UndoUnavailableReason::Superseded
        })
    );
    // A newer group supersedes the older group.
    let newer = store
        .accept_archived_group(&crate::groups::SetArchivedGroup {
            account_id: "acct".into(),
            members: vec![group_ref("thr-a")],
            archived: false,
            request_id: "gmail-group-req-new".into(),
        })
        .expect("newer group");
    assert_eq!(
        store.undo_operation_group(&crate::groups::UndoOperationGroup {
            group_id: receipt.group_id.clone(),
            request_id: "undo-after-newer-group".into(),
        }),
        Err(MailError::UndoUnavailable {
            reason: UndoUnavailableReason::Superseded
        })
    );
    // A retry of a failed member is also a new top-level action.
    // Mark one child failed first.
    let failed_child = newer.members[0].operation_id.clone().unwrap();
    let record = {
        let conn = store.lock_conn().unwrap();
        load_operation(&conn, "acct", &failed_child)
            .unwrap()
            .unwrap()
    };
    store
        .fail_operation(&record, MailError::ProviderRejected)
        .unwrap();
    let retry = store
        .accept_retry(&RetryOperation {
            operation_id: failed_child.clone(),
            request_id: "retry-after-group".into(),
        })
        .expect("retry accepted");
    assert_eq!(
        store.undo_operation_group(&crate::groups::UndoOperationGroup {
            group_id: newer.group_id.clone(),
            request_id: "undo-after-retry".into(),
        }),
        Err(MailError::UndoUnavailable {
            reason: UndoUnavailableReason::Superseded
        }),
        "a newer individual retry supersedes the older group"
    );
    // The retry itself is top-level and undoable (newest action).
    let record = {
        let conn = store.lock_conn().unwrap();
        load_operation(&conn, "acct", &retry.operation_id)
            .unwrap()
            .unwrap()
    };
    store.confirm_operation(&record).unwrap();
    assert!(store
        .undo_operation(&UndoOperation {
            operation_id: retry.operation_id.clone(),
            request_id: "undo-retry".into(),
        })
        .is_ok());
    // Expiry at 10 seconds.
    let expired = store
        .accept_archived_group(&crate::groups::SetArchivedGroup {
            account_id: "acct".into(),
            members: vec![group_ref("thr-b")],
            archived: true,
            request_id: "gmail-group-req-exp".into(),
        })
        .expect("group accepted");
    clock.advance_seconds(10);
    assert_eq!(
        store.undo_operation_group(&crate::groups::UndoOperationGroup {
            group_id: expired.group_id.clone(),
            request_id: "undo-expired".into(),
        }),
        Err(MailError::UndoUnavailable {
            reason: UndoUnavailableReason::Expired
        })
    );
    drop(store);
}

/// Group listing pagination and account fencing (§7.9); a group absent
/// from a recent page stays queryable by request identity; foreign
/// accounts fail closed.
#[test]
fn gmail_group_listing_paginates_and_fences_accounts() {
    let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
        "2026-01-01T00:00:00Z",
    )));
    let (store, _dir) = open_store_with_clock("gmail-group-pages", clock);
    seed_group_threads(&store, &["thr-a"]);
    let mut group_ids = Vec::new();
    for i in 0..3 {
        let receipt = store
            .accept_archived_group(&crate::groups::SetArchivedGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-a")],
                archived: true,
                request_id: format!("gmail-group-page-{i}"),
            })
            .expect("group accepted");
        group_ids.push(receipt.group_id);
    }
    let page = store
        .list_operation_groups(&crate::groups::ListOperationGroupsRequest {
            account_id: "acct".into(),
            limit: 2,
            cursor: None,
        })
        .expect("page 1");
    assert_eq!(page.groups.len(), 2);
    assert_eq!(page.groups[0].request_id, "gmail-group-page-2");
    let cursor = page.next_cursor.expect("continuation");
    assert!(page
        .groups
        .iter()
        .all(|g| g.request_id != "gmail-group-page-0"));
    let oldest = store
        .get_operation_group(&crate::groups::GetOperationGroupRequest {
            account_id: "acct".into(),
            request_id: "gmail-group-page-0".into(),
        })
        .expect("lookup")
        .expect("detail stays addressable");
    assert_eq!(oldest.group.group_id, group_ids[0]);
    let page2 = store
        .list_operation_groups(&crate::groups::ListOperationGroupsRequest {
            account_id: "acct".into(),
            limit: 2,
            cursor: Some(cursor),
        })
        .expect("page 2");
    assert_eq!(page2.groups.len(), 1);
    assert_eq!(page2.groups[0].request_id, "gmail-group-page-0");
    // Foreign account fencing and uncommitted lookups.
    assert_eq!(
        store.list_operation_groups(&crate::groups::ListOperationGroupsRequest {
            account_id: "foreign".into(),
            limit: 2,
            cursor: None,
        }),
        Err(MailError::NotFound)
    );
    assert!(store
        .get_operation_group(&crate::groups::GetOperationGroupRequest {
            account_id: "acct".into(),
            request_id: "never-committed".into(),
        })
        .unwrap()
        .is_none());
    drop(store);
}

/// Disconnect cleanup (§4.2): `clear_account` deletes the durable group
/// header/member rows in the same transaction as their backing
/// operations/requests/preimages. Detail loads and a reused original
/// request id must neither orphan the retained header nor trip its unique
/// constraint into a storage halt.
#[test]
fn gmail_clear_account_removes_group_tables_and_allows_request_id_reuse() {
    let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
        "2026-01-01T00:00:00Z",
    )));
    let (store, _dir) = open_store_with_clock("gmail-group-clear-account", clock);
    seed_group_threads(&store, &["thr-a", "thr-b"]);
    let receipt = store
        .accept_archived_group(&crate::groups::SetArchivedGroup {
            account_id: "acct".into(),
            members: vec![group_ref("thr-a"), group_ref("thr-b")],
            archived: true,
            request_id: "gmail-group-req-clear".into(),
        })
        .expect("group accepted");
    assert_eq!(group_counts(&store), (2, 1));

    store.clear_account().expect("disconnect clears account");
    assert_eq!(group_counts(&store), (0, 0), "group tables are wiped too");

    // Reconnect the same Google account and reuse the ORIGINAL request id:
    // this must be a clean acceptance, not a unique-constraint failure.
    // Reconnect runs against the generation the disconnect bumped to.
    let generation = store.generation().expect("generation");
    store
        .begin_account(&profile("acct", "acct@example.test", "hist-1"), generation)
        .expect("reconnect begins the account");
    store
        .apply_discovery_page(
            &[
                cached(thread(
                    "acct",
                    "thr-a",
                    "hist-2",
                    vec![
                        message("thr-a-m1", "2026-01-01T00:00:00Z"),
                        message("thr-a-m2", "2026-01-02T00:00:00Z"),
                    ],
                    &["thr-a-m1", "thr-a-m2"],
                )),
                cached(thread(
                    "acct",
                    "thr-b",
                    "hist-2",
                    vec![
                        message("thr-b-m1", "2026-01-01T00:00:00Z"),
                        message("thr-b-m2", "2026-01-02T00:00:00Z"),
                    ],
                    &["thr-b-m1", "thr-b-m2"],
                )),
            ],
            None,
            true,
            false,
            generation,
        )
        .expect("reconnect caches threads");
    let reaccepted = store
        .accept_archived_group(&crate::groups::SetArchivedGroup {
            account_id: "acct".into(),
            members: vec![group_ref("thr-a"), group_ref("thr-b")],
            archived: true,
            request_id: "gmail-group-req-clear".into(),
        })
        .expect("reused request id accepts cleanly after disconnect");
    assert_eq!(reaccepted.members.len(), 2);
    assert_ne!(
        reaccepted.group_id, receipt.group_id,
        "a fresh group identity is committed after disconnect"
    );
    drop(store);
}

/// Restart after a partial group Undo with a FAILED compensation: the
/// reopened store rebuilds the persisted undo record from durable rows,
/// and compensation outcomes (failed, with its failure kind) stay
/// inspectable and distinct from the original member's execution status.
#[test]
fn gmail_group_undo_record_survives_reopen_with_failed_compensation() {
    let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
        "2026-01-01T00:00:00Z",
    )));
    let dir;
    let compensation_id;
    {
        let (store, path) = open_store_with_clock("gmail-group-undo-reopen", clock.clone());
        dir = path;
        seed_group_threads(&store, &["thr-a", "thr-b"]);
        let receipt = store
            .accept_read_group(&crate::groups::SetReadGroup {
                account_id: "acct".into(),
                members: vec![group_ref("thr-a"), group_ref("thr-b")],
                read: true,
                request_id: "gmail-group-req-reopen".into(),
            })
            .expect("read group");
        let child = receipt.members[0].operation_id.clone().unwrap();
        let claimed = store.claim_next_operation().unwrap().unwrap();
        assert_eq!(claimed.operation_id, child);
        store.confirm_operation(&claimed).unwrap();
        let undo = store
            .undo_operation_group(&crate::groups::UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "gmail-undo-reopen-1".into(),
            })
            .expect("group undo");
        assert_eq!(
            undo.members[0].decision,
            crate::groups::GroupMemberUndoDecision::Compensating
        );
        assert_eq!(
            undo.members[1].decision,
            crate::groups::GroupMemberUndoDecision::Cancelled
        );
        compensation_id = undo.members[0].operation_ids[0].clone();
        // The compensation fails before the "restart".
        let claimed = store.claim_next_operation().unwrap().unwrap();
        assert_eq!(claimed.operation_id, compensation_id);
        store
            .fail_operation(&claimed, MailError::ProviderRejected)
            .expect("compensation fails");
    }

    // Reopen (same profile, fresh store): the undo record comes back.
    let store = GmailStore::open(dir.path(), clock).expect("reopen");
    let status = store
        .get_operation_group(&crate::groups::GetOperationGroupRequest {
            account_id: "acct".into(),
            request_id: "gmail-group-req-reopen".into(),
        })
        .expect("lookup")
        .expect("committed group after reopen");
    let undo_record = status
        .undo_receipt
        .as_ref()
        .expect("persisted undo record survives reopen");
    assert_eq!(undo_record.request_id, "gmail-undo-reopen-1");
    assert_eq!(
        undo_record.members[0].decision,
        crate::groups::GroupMemberUndoDecision::Compensating
    );
    assert_eq!(undo_record.members[0].compensations.len(), 1);
    assert_eq!(
        undo_record.members[0].compensations[0].operation_id,
        compensation_id
    );
    assert_eq!(
        undo_record.members[0].compensations[0].status,
        OperationStatus::Failed,
        "failed compensation outcome visible after reopen"
    );
    assert_eq!(
        undo_record.members[0].compensations[0].failure,
        Some(OperationFailure::ProviderRejected)
    );
    assert_eq!(
        undo_record.members[1].decision,
        crate::groups::GroupMemberUndoDecision::Cancelled
    );
    // The original member's execution status is untouched history.
    assert_eq!(
        status.members[0].status,
        crate::groups::GroupMemberStatus::Confirmed
    );
    // Activity exposes the group linkage on the child and the undo/none
    // linkage on the compensation.
    let activity = store.list_snapshot().unwrap().activity;
    let child_row = activity
        .iter()
        .find(|row| row.id == "x")
        .or_else(|| activity.iter().find(|row| row.group_id.is_some()))
        .expect("group child present in activity");
    assert!(
        child_row.group_id.is_some(),
        "group child carries its groupId"
    );
    let compensation_row = activity
        .iter()
        .find(|row| row.id == compensation_id)
        .expect("compensation in activity");
    assert_eq!(
        compensation_row.group_id, None,
        "compensations are ungrouped"
    );
    drop(store);
}

/// A retried failed group member stays linked for inspection across a
/// restart: the retry row carries `retryOf` (its own top-level action,
/// no group), while the original member's historical failure is not
/// rewritten (§4.3).
#[test]
fn gmail_retry_lineage_persists_across_restart() {
    let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
        "2026-01-01T00:00:00Z",
    )));
    let (store, dir) = open_store_with_clock("gmail-group-retry-lineage", clock.clone());
    seed_group_threads(&store, &["thr-a", "thr-b"]);
    let receipt = store
        .accept_read_group(&crate::groups::SetReadGroup {
            account_id: "acct".into(),
            members: vec![group_ref("thr-a"), group_ref("thr-b")],
            read: true,
            request_id: "gmail-group-req-retry".into(),
        })
        .expect("read group");
    let failed_child = receipt.members[0].operation_id.clone().unwrap();
    let claimed = store.claim_next_operation().unwrap().unwrap();
    assert_eq!(claimed.operation_id, failed_child);
    store
        .fail_operation(&claimed, MailError::ProviderRejected)
        .expect("member fails");

    // Explicit retry of the failed member: a new top-level action linked
    // to the original member for inspection.
    let retry = store
        .accept_retry(&crate::dto::RetryOperation {
            operation_id: failed_child.clone(),
            request_id: "gmail-retry-1".into(),
        })
        .expect("retry accepted");
    let retry_id = retry.operation_id.clone();
    // The other member is still queued and older; drain it first.
    let claimed = store.claim_next_operation().unwrap().unwrap();
    assert_eq!(
        claimed.operation_id,
        receipt.members[1].operation_id.clone().unwrap()
    );
    store
        .fail_operation(&claimed, MailError::ProviderRejected)
        .expect("sibling member fails");
    let claimed = store.claim_next_operation().unwrap().unwrap();
    assert_eq!(claimed.operation_id, retry_id);
    store.confirm_operation(&claimed).unwrap();

    // Restart: the lineage and the historical failure both survive.
    drop(store);
    let store = GmailStore::open(dir.path(), clock).expect("reopen");
    let activity = store.list_snapshot().unwrap().activity;
    let retry_row = activity
        .iter()
        .find(|row| row.id == retry_id)
        .expect("retry row");
    assert_eq!(retry_row.retry_of.as_deref(), Some(failed_child.as_str()));
    assert_eq!(
        retry_row.group_id, None,
        "a retry is a new top-level action, ungrouped"
    );
    let failed_row = activity
        .iter()
        .find(|row| row.id == failed_child)
        .expect("failed member row");
    assert_eq!(
        failed_row.status,
        OperationStatus::Failed,
        "history not rewritten"
    );
    assert_eq!(
        failed_row.group_id.as_deref(),
        Some(receipt.group_id.as_str())
    );
    // Group detail still addresses the group by its original request id.
    let status = store
        .get_operation_group(&crate::groups::GetOperationGroupRequest {
            account_id: "acct".into(),
            request_id: "gmail-group-req-retry".into(),
        })
        .expect("lookup")
        .expect("group");
    assert_eq!(
        status.members[0].status,
        crate::groups::GroupMemberStatus::Failed
    );
    drop(store);
}
