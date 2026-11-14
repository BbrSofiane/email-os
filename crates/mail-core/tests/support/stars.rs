//! Synthetic provider/storage evidence only, never native or Gmail convergence.
use super::*;
use mail_core::dto::{CachedDoneRequest, UndoOperation};
use mail_core::stars::{SetStarred, SetStarredGroup, StarState};

fn command(starred: bool, key: &str) -> SetStarred {
    SetStarred {
        conversation: conversation_ref(),
        starred,
        request_id: key.into(),
    }
}
fn page() -> CachedDoneRequest {
    CachedDoneRequest {
        account_id: ACCOUNT.into(),
        limit: 100,
        cursor: None,
    }
}
fn wait_confirmed(core: &GmailCore, id: &str) {
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .iter()
        .any(
            |op| op.id == id && op.status == OperationStatus::Confirmed
        )));
}
fn known_provider() -> Arc<FakeProvider> {
    let provider = FakeProvider::new(true);
    provider.state.lock().unwrap().thread.star_facts = Some(
        [("m-1".into(), false), ("m-2".into(), false)]
            .into_iter()
            .collect(),
    );
    provider
}

#[test]
fn star_aggregation_is_existential_and_unknown_is_not_false() {
    for (facts, expected, known, starred) in [
        (vec![], None, 0, 0),
        (vec![None, None], None, 0, 0),
        (vec![Some(false), None], None, 1, 0),
        (vec![Some(true), None], Some(true), 1, 1),
        (vec![Some(false), Some(false)], Some(false), 2, 0),
        (vec![Some(true), Some(false)], Some(true), 2, 1),
    ] {
        let state = StarState::from_facts(facts);
        assert_eq!(state.is_starred(), expected);
        assert_eq!(state.known_messages, known);
        assert_eq!(state.starred_messages, starred);
    }
}

#[test]
fn archived_mail_is_starred_and_unstar_does_not_touch_read_or_inbox() {
    let dir = temp_profile("stars-archived");
    let provider = known_provider();

    let core = open_core(&dir, &provider);
    wait_ready(&core);
    let archived = core
        .set_archived(&super::archived(true, "archive-before-star"))
        .unwrap();
    wait_confirmed(&core, &archived.operation_id);
    let before = core.get_conversation(&conversation_ref()).unwrap();
    assert!(!before.is_in_inbox);
    let receipt = core.set_starred(&command(true, "star")).unwrap();
    wait_confirmed(&core, &receipt.operation_id);
    assert_eq!(core.set_starred(&command(true, "star")).unwrap(), receipt);
    assert_eq!(
        core.list_cached_starred(&page())
            .unwrap()
            .conversations
            .len(),
        1
    );
    let starred = core.get_conversation(&conversation_ref()).unwrap();
    assert_eq!(
        starred.stars.unwrap().total_messages,
        2,
        "unsupported bodies remain targets"
    );
    assert_eq!(starred.is_read, before.is_read);
    assert!(!starred.is_in_inbox);
    let receipt = core.set_starred(&command(false, "unstar")).unwrap();
    wait_confirmed(&core, &receipt.operation_id);
    assert!(core
        .list_cached_starred(&page())
        .unwrap()
        .conversations
        .is_empty());
    assert_eq!(provider.writes().last().unwrap().2, vec!["m-1", "m-2"]);
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn starred_browsing_retains_offline_operation_snapshot_after_body_eviction() {
    let dir = temp_profile("stars-retained");
    let provider = known_provider();
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    let starred = core.set_starred(&command(true, "retained-star")).unwrap();
    wait_confirmed(&core, &starred.operation_id);
    let archived = core
        .set_archived(&super::archived(true, "retained-archive"))
        .unwrap();
    wait_confirmed(&core, &archived.operation_id);
    core.stop();
    drop(core);
    // Model the cache-eviction boundary: recovery snapshot and immutable target
    // facts survive, while normal cached bodies/membership are removed.
    let db = rusqlite::Connection::open(dir.path().join("gmail.db")).unwrap();
    for table in [
        "gmail_messages",
        "gmail_conversations",
        "gmail_inbox_membership",
    ] {
        db.execute(&format!("DELETE FROM {table}"), []).unwrap();
    }
    drop(db);
    provider.set_profile_error(Some(MailError::NetworkUnavailable));
    let restarted = open_core(&dir, &provider);
    let retained = restarted.get_conversation(&conversation_ref()).unwrap();
    assert!(retained.retained_snapshot_at.is_some());
    assert_eq!(retained.stars.unwrap().starred_messages, 2);
    assert_eq!(
        restarted
            .list_cached_starred(&page())
            .unwrap()
            .conversations
            .len(),
        1
    );
    restarted.stop();
    drop(restarted);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn cache_trim_preserves_starred_arrival_outside_original_operation_targets() {
    let dir = temp_profile("stars-trim-arrival");
    let provider = known_provider();
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    let receipt = core
        .set_starred(&command(false, "unstar-before-arrival"))
        .unwrap();
    wait_confirmed(&core, &receipt.operation_id);
    core.stop();
    drop(core);

    provider.set_new_incoming_message();
    provider
        .state
        .lock()
        .unwrap()
        .thread
        .star_facts
        .as_mut()
        .unwrap()
        .insert("m-3".into(), true);
    provider.set_changed_history(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    let before = core.get_conversation(&conversation_ref()).unwrap();
    assert!(before.retained_snapshot_at.is_none());
    let expected = before.stars.clone().unwrap();
    assert_eq!(expected.starred_messages, 1);
    assert_eq!(expected.known_messages, 3);
    assert_eq!(expected.total_messages, 3);
    core.stop();
    drop(core);

    // Seed newer synthetic bodies, not a manual eviction. The next history
    // checkpoint must run the production 100-conversation cache trimmer.
    let db = rusqlite::Connection::open(dir.path().join("gmail.db")).unwrap();
    for n in 0..=100 {
        let id = format!("trim-{n:03}");
        let date = if n == 100 {
            "2025-01-01T00:00:00Z" // unretained control must be fully evicted
        } else {
            "2026-12-01T00:00:00Z"
        };
        db.execute(
            "INSERT INTO gmail_conversations
             (account_id, conversation_id, subject, context_complete)
             VALUES (?1, ?2, 'synthetic', 1)",
            rusqlite::params![ACCOUNT, id],
        )
        .unwrap();
        db.execute(
            "INSERT INTO gmail_messages
             (account_id, conversation_id, message_id, from_mailbox, to_json, sent_at, body_text, in_inbox)
             VALUES (?1, ?2, ?2, 'sender@example.test', '[]', ?3, 'synthetic', 1)",
            rusqlite::params![ACCOUNT, id, date],
        )
        .unwrap();
        db.execute(
            "INSERT INTO gmail_message_facts
             (account_id, conversation_id, message_id, in_inbox, is_unread, is_starred)
             VALUES (?1, ?2, ?2, 1, 0, 0)",
            rusqlite::params![ACCOUNT, id],
        )
        .unwrap();
    }
    drop(db);
    provider.set_changed_history(false); // no refetch can mask lost durable facts
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    let retained = core.get_conversation(&conversation_ref()).unwrap();
    assert!(retained.retained_snapshot_at.is_some());
    assert_eq!(retained.stars.unwrap(), expected);
    assert_eq!(retained.is_in_inbox, before.is_in_inbox);
    assert_eq!(retained.is_read, before.is_read);
    // Candidate pagination may return an empty page before this older snapshot.
    let first = core.list_cached_starred(&page()).unwrap();
    assert!(first.conversations.is_empty());
    let mut next = page();
    next.cursor = Some(first.next_cursor.expect("older recovery candidate remains"));
    let last = core.list_cached_starred(&next).unwrap();
    assert!(last.next_cursor.is_none());
    let rows = last.conversations;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].conversation_ref, conversation_ref());
    assert_eq!(rows[0].stars.as_ref(), Some(&expected));
    assert_eq!(provider.writes().len(), 1, "no implicit provider mutation");
    assert_eq!(provider.writes()[0].2, vec!["m-1", "m-2"]);
    core.stop();
    drop(core);

    let db = rusqlite::Connection::open(dir.path().join("gmail.db")).unwrap();
    let count = |sql: &str| {
        db.query_row(sql, [ACCOUNT], |row| row.get::<_, i64>(0))
            .unwrap()
    };
    assert_eq!(
        count("SELECT COUNT(*) FROM gmail_conversations WHERE account_id = ?1"),
        100
    );
    assert_eq!(count("SELECT COUNT(*) FROM gmail_message_facts WHERE account_id = ?1 AND conversation_id = 'trim-100'"), 0);
    let mut stmt = db
        .prepare(
            "SELECT message_id FROM gmail_operation_targets
         WHERE account_id = ?1 AND operation_id = ?2 ORDER BY message_id",
        )
        .unwrap();
    let targets = stmt
        .query_map(rusqlite::params![ACCOUNT, receipt.operation_id], |row| {
            row.get::<_, String>(0)
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(targets, vec!["m-1", "m-2"], "immutable targets exclude m-3");
    drop(stmt);
    drop(db);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn star_dispatch_restart_reconciles_without_reposting() {
    let dir = temp_profile("stars-restart");
    let provider = known_provider();
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::ApplyThenBlock);
    let receipt = core.set_starred(&command(true, "restart-star")).unwrap();
    assert!(provider.wait_for_apply(1));
    core.stop();
    drop(core);
    provider.release_apply();
    provider.set_apply_plan(ApplyPlan::Success);
    let restarted = open_core(&dir, &provider);
    wait_confirmed(&restarted, &receipt.operation_id);
    assert_eq!(
        provider.writes().len(),
        1,
        "only GET reconciliation after restart"
    );
    assert_eq!(
        restarted
            .list_cached_starred(&page())
            .unwrap()
            .conversations
            .len(),
        1
    );
    restarted.stop();
    drop(restarted);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn star_group_targets_are_exact_and_undo_restores_mixed_preimages() {
    let dir = temp_profile("stars-group");
    let provider = known_provider();
    provider
        .state
        .lock()
        .unwrap()
        .thread
        .star_facts
        .as_mut()
        .unwrap()
        .insert("m-1".into(), true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    let group = core
        .set_starred_group(&SetStarredGroup {
            account_id: ACCOUNT.into(),
            members: vec![
                conversation_ref(),
                ConversationRef {
                    account_id: ACCOUNT.into(),
                    conversation_id: "gone".into(),
                },
            ],
            starred: true,
            request_id: "star-group".into(),
        })
        .unwrap();
    assert_eq!(group.requested_starred, Some(true));
    assert!(group.members[1].operation_id.is_none());
    let id = group.members[0].operation_id.as_ref().unwrap();
    wait_confirmed(&core, id);
    assert_eq!(provider.writes()[0].2, vec!["m-1", "m-2"]);
    let undone = core
        .undo_operation_group(&mail_core::groups::UndoOperationGroup {
            group_id: group.group_id,
            request_id: "undo-star-group".into(),
        })
        .unwrap();
    assert_eq!(undone.members.len(), 2);
    assert!(until(|| {
        let activity = core.list_conversations().unwrap().activity;
        let restoring: Vec<_> = activity
            .iter()
            .filter(|op| op.undo_of.as_deref() == Some(id))
            .collect();
        restoring.len() == 2
            && restoring
                .iter()
                .all(|op| op.status == OperationStatus::Confirmed)
    }));
    let stars = core
        .get_conversation(&conversation_ref())
        .unwrap()
        .stars
        .unwrap();
    assert_eq!(stars.starred_messages, 1);
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn legacy_migration_keeps_unknown_stars_and_query_scope_fails_closed() {
    let dir = temp_profile("stars-legacy");
    let provider = known_provider();
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    let before = core.get_conversation(&conversation_ref()).unwrap();
    core.stop();
    drop(core);
    let db = rusqlite::Connection::open(dir.path().join("gmail.db")).unwrap();
    db.execute("ALTER TABLE gmail_message_facts DROP COLUMN is_starred", [])
        .unwrap();
    // A real pre-star profile carries the ambiguous legacy marker, not the current one.
    db.execute(
        "UPDATE meta SET value = 'gmail-2' WHERE key = 'schema_version'",
        [],
    )
    .unwrap();
    drop(db);
    provider.set_profile_error(Some(MailError::NetworkUnavailable));
    let restarted = open_core(&dir, &provider);
    let after = restarted.get_conversation(&conversation_ref()).unwrap();
    assert_eq!(after.is_in_inbox, before.is_in_inbox);
    assert_eq!(after.is_read, before.is_read);
    let stars = after.stars.unwrap();
    assert_eq!(stars.total_messages, 2);
    assert_eq!(stars.known_messages, 0);
    assert_eq!(stars.is_starred(), None);
    assert!(restarted
        .list_cached_starred(&page())
        .unwrap()
        .conversations
        .is_empty());
    let mut request = page();
    request.account_id = "other".into();
    assert_eq!(
        restarted.list_cached_starred(&request).unwrap_err(),
        MailError::NotFound
    );
    request = page();
    request.cursor = Some("cached-done-v1:[\\\"acct-operations\\\",\\\"d\\\",\\\"id\\\"]".into());
    assert!(matches!(
        restarted.list_cached_starred(&request),
        Err(MailError::InvalidRequest { .. })
    ));
    restarted.stop();
    drop(restarted);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn failed_star_retry_keeps_original_targets_and_new_arrivals_independent() {
    let dir = temp_profile("stars-failed-retry");
    let provider = known_provider();
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::Error(MailError::ProviderRejected));
    let failed = core.set_starred(&command(true, "fail-star")).unwrap();
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .iter()
        .any(
            |op| op.id == failed.operation_id && op.status == OperationStatus::Failed
        )));
    assert_eq!(
        core.get_conversation(&conversation_ref())
            .unwrap()
            .stars
            .unwrap()
            .is_starred(),
        Some(false)
    );
    core.stop();
    drop(core);
    provider.set_new_incoming_message();
    provider.set_apply_plan(ApplyPlan::Success);
    let restarted = open_core(&dir, &provider);
    wait_ready(&restarted);
    let retried = restarted
        .retry_operation(&RetryOperation {
            operation_id: failed.operation_id,
            request_id: "retry-star".into(),
        })
        .unwrap();
    wait_confirmed(&restarted, &retried.operation_id);
    assert_eq!(provider.writes().last().unwrap().2, vec!["m-1", "m-2"]);
    assert!(!provider
        .state
        .lock()
        .unwrap()
        .thread
        .star_facts
        .as_ref()
        .unwrap()
        .contains_key("m-3"));
    restarted.stop();
    drop(restarted);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn unknown_prior_disables_undo_and_denied_capability_rejects_star() {
    let dir = temp_profile("stars-unknown");
    let provider = FakeProvider::new(false);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    assert_eq!(
        core.set_starred(&command(true, "denied")).unwrap_err(),
        MailError::PermissionRequired
    );
    core.enable_mutations().unwrap();
    assert!(until(|| core.account_status().unwrap().mutation_access
        == Some(mail_core::gmail::types::MutationAccess::Enabled)));
    let receipt = core.set_starred(&command(true, "unknown")).unwrap();
    wait_confirmed(&core, &receipt.operation_id);
    assert!(core
        .undo_operation(&UndoOperation {
            operation_id: receipt.operation_id,
            request_id: "undo-unknown".into()
        })
        .is_err());
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}
