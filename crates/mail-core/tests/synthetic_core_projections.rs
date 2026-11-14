//! Cached Done, saved split (ADR 0002 appendix: `cached_done.rs`,
//! `saved_split.rs`) and the synthetic provider's own durable-fact contract.

use mail_core::dto::{CachedDoneRequest, OperationStatus, UndoOperation};
use mail_core::gmail::types::{GmailHistoryError, GmailProvider};
use mail_core::splits::{SavedSplit, SplitCriterion};
use mail_core::synthetic::SyntheticGmailProvider;
use mail_core::testing::synthetic::*;
use mail_core::testing::{temp_profile, TIMEOUT};
use mail_core::{CancelToken, MailError, ACCOUNT_ID};

/// Legacy: `list_cached_done_fixture_persists_pending_archive_and_restores_after_restart`.
#[test]
fn cached_done_persists_pending_archive_and_restores_after_restart() {
    let s = Synthetic::open_operations_paused("done-restart");
    let mut request = CachedDoneRequest {
        account_id: ACCOUNT_ID.into(),
        limit: 1,
        cursor: None,
    };
    // Initially archived seed rows are NOT Done evidence.
    load_archived_seeds(&s.core).unwrap();
    assert!(s
        .core
        .list_cached_done(&request)
        .unwrap()
        .conversations
        .is_empty());
    let inbox = s.core.list_conversations().unwrap();
    let first = inbox.conversations[0].conversation_ref.clone();
    let second = inbox.conversations[1].conversation_ref.clone();
    for (index, target) in [first.clone(), second.clone()].into_iter().enumerate() {
        s.core
            .set_archived(&mail_core::dto::SetArchived {
                conversation: target,
                archived: true,
                request_id: format!("archive-{index}"),
            })
            .unwrap();
    }
    let s = s.reopen();
    let page = s.core.list_cached_done(&request).unwrap();
    assert_eq!(page.conversations.len(), 1);
    assert_eq!(page.exact_total, None);
    let first_done = page.conversations[0].conversation_ref.clone();
    assert!(first_done == first || first_done == second);
    request.cursor = page.next_cursor;
    let page = s.core.list_cached_done(&request).unwrap();
    assert_eq!(page.conversations.len(), 1);
    assert_ne!(page.conversations[0].conversation_ref, first_done);
    assert_eq!(page.next_cursor, None);
    // Restore one: it leaves Done; the bounded candidate page can be empty.
    assert!(!s.core.get_conversation(&first).unwrap().is_in_inbox);
    s.core
        .set_archived(&mail_core::dto::SetArchived {
            conversation: first.clone(),
            archived: false,
            request_id: "restore".into(),
        })
        .unwrap();
    s.core.wait_for_test_idle(TIMEOUT).unwrap();
    request.cursor = None;
    request.limit = 100;
    assert_eq!(
        s.core
            .list_cached_done(&request)
            .unwrap()
            .conversations
            .len(),
        1
    );
    request.account_id = "foreign".into();
    assert_eq!(s.core.list_cached_done(&request), Err(MailError::NotFound));
    request.account_id = ACCOUNT_ID.into();
    for limit in [0, 101] {
        request.limit = limit;
        assert!(matches!(s.core.list_cached_done(&request),
            Err(MailError::InvalidRequest { field }) if field == "limit"));
    }
    request.limit = 1;
    request.cursor = Some("malformed".into());
    assert!(matches!(s.core.list_cached_done(&request),
        Err(MailError::InvalidRequest { field }) if field == "cursor"));
}

/// Legacy: `list_cached_done_caps_large_sqlite_result_and_pages_equal_dates_by_id`.
/// 137 extra equal-dated conversations are served by a test overlay (the
/// synthetic mailbox itself is fixed at 18).
#[test]
fn cached_done_caps_large_results_and_pages_equal_dates_by_id() {
    let s = Synthetic::open_wrapped("done-bounded", |synthetic| {
        let overlay = Overlay::wrap(synthetic);
        overlay.add_extra_threads(
            (0..137)
                .map(|index| {
                    let id = format!("bounded-{index:03}");
                    mail_core::testing::thread(
                        ACCOUNT_ID,
                        &id,
                        vec![mail_core::testing::message(
                            &id,
                            "bounded@example.test",
                            "2026-04-01T00:00:00Z",
                            "synthetic bounded",
                        )],
                        &[id.as_str()],
                        Some(vec![]),
                        "bounded",
                    )
                })
                .collect(),
        );
        overlay
    });
    for index in 0..137 {
        let id = format!("bounded-{index:03}");
        // A concurrent worker write fences the cached-observation read as
        // `busy`; the caller retries (bounded).
        assert!(
            mail_core::testing::until(|| {
                match s.core.set_archived(&set_archived(&id, true, &id)) {
                    Ok(_) => true,
                    Err(MailError::Busy) => false,
                    Err(error) => panic!("accept {id}: {error:?}"),
                }
            }),
            "{id} accepted"
        );
    }
    s.core.wait_for_test_idle(TIMEOUT).unwrap();
    let mut request = CachedDoneRequest {
        account_id: ACCOUNT_ID.into(),
        limit: 100,
        cursor: None,
    };
    let first = s.core.list_cached_done(&request).unwrap();
    assert_eq!(first.conversations.len(), 100);
    assert_eq!(
        first.conversations[0].conversation_ref.conversation_id,
        "bounded-000"
    );
    assert_eq!(
        first.conversations[99].conversation_ref.conversation_id,
        "bounded-099"
    );
    request.cursor = first.next_cursor;
    let second = s.core.list_cached_done(&request).unwrap();
    assert_eq!(second.conversations.len(), 37);
    assert_eq!(
        second.conversations[0].conversation_ref.conversation_id,
        "bounded-100"
    );
    assert_eq!(second.next_cursor, None);
}

/// Legacy: `split_survives_restart_and_never_moves_mail_or_supersedes_undo`.
#[test]
fn saved_split_survives_restart_and_never_moves_mail_or_supersedes_undo() {
    let s = Synthetic::open("split");
    let inbox = s.core.list_conversations().unwrap();
    let target = inbox.conversations[0].conversation_ref.clone();
    let split = SavedSplit {
        name: " Clients ".into(),
        criterion: SplitCriterion::Domain,
        value: " EXAMPLE.COM ".into(),
        enabled: true,
        hide_when_empty: true,
    };
    assert_eq!(s.core.get_saved_split(ACCOUNT_ID).unwrap(), None);
    assert_eq!(
        s.core.save_saved_split("foreign", &split),
        Err(MailError::NotFound)
    );
    let saved = s.core.save_saved_split(ACCOUNT_ID, &split).unwrap();
    assert_eq!(saved.value, "example.com");
    assert_eq!(
        s.core.list_conversations().unwrap(),
        inbox,
        "never moves mail"
    );
    let s = s.reopen();
    assert_eq!(
        s.core.get_saved_split(ACCOUNT_ID).unwrap(),
        Some(saved.clone())
    );
    let receipt = s
        .core
        .set_archived(&set_archived(&target.conversation_id, true, "archive"))
        .unwrap();
    s.core
        .save_saved_split(
            ACCOUNT_ID,
            &SavedSplit {
                enabled: false,
                ..saved.clone()
            },
        )
        .unwrap();
    assert!(!s.core.get_conversation(&target).unwrap().is_in_inbox);
    s.core
        .undo_operation(&UndoOperation {
            operation_id: receipt.operation_id,
            request_id: "undo".into(),
        })
        .expect("a split save never supersedes undo");
    assert!(wait_for_status_inbox(&s, &target.conversation_id));
    let invalid = SavedSplit {
        value: "not a domain".into(),
        ..saved
    };
    assert!(matches!(
        s.core.save_saved_split(ACCOUNT_ID, &invalid),
        Err(MailError::InvalidRequest { .. })
    ));
    assert!(!s.core.get_saved_split(ACCOUNT_ID).unwrap().unwrap().enabled);
}

fn wait_for_status_inbox(s: &Synthetic, id: &str) -> bool {
    mail_core::testing::until(|| {
        s.core
            .get_conversation(&conversation(id))
            .unwrap()
            .is_in_inbox
    })
}

// ----------------------------------------------- provider durable-fact contract

fn thread_of(provider: &SyntheticGmailProvider, id: &str) -> mail_core::gmail::types::GmailThread {
    provider
        .get_thread(id, &CancelToken::default())
        .unwrap()
        .unwrap()
}

#[test]
fn provider_models_archive_per_message_and_facts_survive_a_new_provider() {
    let dir = temp_profile("provider-facts");
    let provider = SyntheticGmailProvider::open(dir.path()).unwrap();
    let cancel = CancelToken::default();
    assert_eq!(thread_of(&provider, "conv-01").inbox_message_ids.len(), 3);
    // Archive ONE message of a three-message conversation.
    provider
        .apply_archive(&["m-01-2".into()], true, &cancel)
        .unwrap();
    let after = thread_of(&provider, "conv-01");
    assert_eq!(
        after.inbox_message_ids,
        vec!["m-01-1".to_string(), "m-01-3".to_string()]
    );
    assert!(
        after.conversation.is_in_inbox,
        "still in the Inbox via other messages"
    );
    provider
        .apply_read(&["m-01-1".into()], true, &cancel)
        .unwrap();
    provider
        .apply_star(&["m-01-3".into()], true, &cancel)
        .unwrap();
    drop(provider);
    // A NEW provider reads its saved facts; seeding never overwrites them.
    let provider = SyntheticGmailProvider::open(dir.path()).unwrap();
    let reopened = thread_of(&provider, "conv-01");
    assert_eq!(
        reopened.inbox_message_ids,
        vec!["m-01-1".to_string(), "m-01-3".to_string()]
    );
    assert!(!reopened
        .unread_message_ids
        .unwrap()
        .contains(&"m-01-1".to_string()));
    let stars = reopened.star_facts.unwrap();
    assert!(stars["m-01-3"]);
    assert!(!stars["m-01-1"]);
}

#[test]
fn provider_history_is_stable_cheap_and_expires_unknown_cursors() {
    let dir = temp_profile("provider-history");
    let provider = SyntheticGmailProvider::open(dir.path()).unwrap();
    let cancel = CancelToken::default();
    let start = provider.profile(&cancel).unwrap().history_id;
    let empty = provider.history(&start, None, &cancel).unwrap();
    assert!(empty.changed_thread_ids.is_empty());
    assert_eq!(
        empty.history_id, start,
        "a stable mailbox reports no change"
    );
    provider
        .apply_archive(&["m-02-1".into()], true, &cancel)
        .unwrap();
    let changed = provider.history(&start, None, &cancel).unwrap();
    assert_eq!(changed.changed_thread_ids, vec!["conv-02".to_string()]);
    assert_ne!(changed.history_id, start);
    // An idempotent repeat changes nothing and does not advance history.
    provider
        .apply_archive(&["m-02-1".into()], true, &cancel)
        .unwrap();
    assert_eq!(
        provider.profile(&cancel).unwrap().history_id,
        changed.history_id
    );
    for bad in ["not-a-number", "999999"] {
        assert!(matches!(
            provider.history(bad, None, &cancel),
            Err(GmailHistoryError::Expired)
        ));
    }
}

#[test]
fn provider_write_is_all_or_nothing_and_rejects_unknown_messages() {
    let dir = temp_profile("provider-atomic");
    let provider = SyntheticGmailProvider::open(dir.path()).unwrap();
    let cancel = CancelToken::default();
    assert_eq!(
        provider.apply_archive(&["m-01-1".into(), "m-ghost".into()], true, &cancel),
        Err(MailError::ProviderRejected)
    );
    assert_eq!(
        thread_of(&provider, "conv-01").inbox_message_ids.len(),
        3,
        "nothing applied"
    );
}

#[test]
fn provider_controls_apply_to_writes_only_and_are_cancellation_aware() {
    let dir = temp_profile("provider-controls");
    let provider = std::sync::Arc::new(SyntheticGmailProvider::open(dir.path()).unwrap());
    provider.set_paused(true);
    // Reads and the profile stay responsive while writes are paused.
    let cancel = CancelToken::default();
    provider.profile(&cancel).unwrap();
    provider.list_inbox(None, &cancel).unwrap();
    assert!(provider.get_thread("conv-01", &cancel).unwrap().is_some());
    let writer = {
        let provider = provider.clone();
        let cancel = cancel.clone();
        std::thread::spawn(move || provider.apply_archive(&["m-01-1".into()], true, &cancel))
    };
    assert!(provider.wait_for_write_calls(1, TIMEOUT));
    cancel.cancel();
    assert_eq!(writer.join().unwrap(), Err(MailError::AuthCancelled));
    assert_eq!(thread_of(&provider, "conv-01").inbox_message_ids.len(), 3);
    provider.resume();
    provider.fail_next();
    let live = CancelToken::default();
    assert_eq!(
        provider.apply_archive(&["m-01-1".into()], true, &live),
        Err(MailError::ProviderRejected)
    );
    assert!(
        provider
            .apply_archive(&["m-01-1".into()], true, &live)
            .is_ok(),
        "reject is one-shot"
    );
}

#[test]
fn provider_session_methods_never_authenticate_or_erase() {
    let dir = temp_profile("provider-session");
    let provider = SyntheticGmailProvider::open(dir.path()).unwrap();
    let cancel = CancelToken::default();
    let invalid_mode = MailError::InvalidRequest {
        field: "mode".into(),
    };
    assert_eq!(
        provider.connect(&cancel).map(|_| ()),
        Err(invalid_mode.clone())
    );
    assert_eq!(provider.disconnect(), Err(invalid_mode.clone()));
    assert_eq!(
        provider.enable_mutations(&cancel).map(|_| ()),
        Err(invalid_mode)
    );
    let profile = provider.profile(&cancel).unwrap();
    assert_eq!(profile.account_id, ACCOUNT_ID);
    assert_eq!(profile.email_address, mail_core::FIXTURE_MAILBOX);
    assert_eq!(
        provider
            .get_thread_for_account("other-account", "conv-01", &cancel)
            .map(|_| ()),
        Err(MailError::AuthFailed)
    );
    // Cached-only search: the provider offers no remote search.
    assert!(provider.search_threads(None, &cancel).is_err());
    // Only the facts file is created; the legacy store is never touched.
    let mut names: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with("synthetic-provider.db"))
        .collect();
    names.sort();
    assert!(names.is_empty(), "unexpected files: {names:?}");
}

#[test]
fn provider_attachment_bytes_are_exact_and_bound_to_the_first_message() {
    let dir = temp_profile("provider-attachment");
    let provider = SyntheticGmailProvider::open(dir.path()).unwrap();
    let cancel = CancelToken::default();
    let bytes = provider
        .fetch_attachment(ACCOUNT_ID, "m-01-1", "fixture-text", &cancel)
        .unwrap();
    assert_eq!(bytes, b"Synthetic attachment only.\n");
    assert_eq!(
        provider.fetch_attachment(ACCOUNT_ID, "m-01-2", "fixture-text", &cancel),
        Err(MailError::NotFound)
    );
    assert_eq!(
        provider.fetch_attachment("other-account", "m-01-1", "fixture-text", &cancel),
        Err(MailError::NotFound)
    );
    assert_eq!(
        provider.fetch_attachment(ACCOUNT_ID, "m-01-1", "other", &cancel),
        Err(MailError::NotFound)
    );
    let cancelled = CancelToken::default();
    cancelled.cancel();
    assert_eq!(
        provider.fetch_attachment(ACCOUNT_ID, "m-01-1", "fixture-text", &cancelled),
        Err(MailError::AuthCancelled)
    );
}

#[test]
fn provider_inbox_lists_newest_first_and_archived_seeds_are_not_inbox() {
    let dir = temp_profile("provider-inbox");
    let provider = SyntheticGmailProvider::open(dir.path()).unwrap();
    let page = provider.list_inbox(None, &CancelToken::default()).unwrap();
    assert_eq!(page.thread_ids.len(), 16);
    assert!(!page.thread_ids.contains(&"conv-06".to_string()));
    assert!(!page.thread_ids.contains(&"conv-15".to_string()));
    assert_eq!(page.next_page_token, None);
    assert_eq!(page.thread_ids[0], "conv-18", "newest conversation first");
    // The two archived seeds exist, with no INBOX message and read facts.
    for id in ["conv-06", "conv-15"] {
        let thread = thread_of(&provider, id);
        assert!(thread.inbox_message_ids.is_empty());
        assert!(thread.unread_message_ids.unwrap().is_empty());
    }
    let _ = OperationStatus::Queued;
}
