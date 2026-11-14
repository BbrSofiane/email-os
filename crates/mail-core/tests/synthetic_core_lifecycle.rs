//! Fixture guarantees ported to `GmailCore` + the built-in synthetic provider
//! (ADR 0002 appendix: `integration.rs`, `lib.rs` facade tests).
//!
//! Each test names the legacy fixture test it replaces. Coordination uses the
//! provider's write-call barrier, change-listener condvars and the injected
//! clock; nothing waits on wall-clock time except the shared bounded `until`.

use mail_core::dto::{OperationFailure, OperationStatus};
use mail_core::gmail::sync::GmailCore;
use mail_core::gmail::types::GmailProvider;
use mail_core::testing::synthetic::*;
use mail_core::testing::{temp_profile, TIMEOUT};
use mail_core::MailError;

/// Legacy: `seeds_18_conversations_exactly_once_and_survives_restart`.
#[test]
fn seeds_18_conversations_exactly_once_and_survives_restart() {
    let s = Synthetic::open("seed-restart");
    assert_eq!(
        s.core.list_conversations().unwrap().conversations.len(),
        16,
        "16 of 18 seeded conversations start in the inbox (2 seeded archived)"
    );
    // Stage 1 loads the two archived seeds explicitly; stage 2's bootstrap
    // does it before the session reports ready.
    load_archived_seeds(&s.core).expect("archived seeds load");
    for i in 1..=18 {
        let conversation = s
            .core
            .get_conversation(&conversation(&format!("conv-{i:02}")))
            .expect("seeded conversation readable");
        assert!(!conversation.messages.is_empty());
    }
    assert_eq!(
        s.core.account_status().unwrap().sync.cached_conversations,
        18
    );
    let rows = |dir: &std::path::Path| -> i64 {
        rusqlite::Connection::open(dir.join("synthetic-provider.db"))
            .unwrap()
            .query_row("SELECT COUNT(*) FROM synthetic_messages", [], |r| r.get(0))
            .unwrap()
    };
    let seeded = rows(s.dir.path());
    assert_eq!(seeded, 26, "one fact row per seeded message");

    let s = s.reopen();
    assert_eq!(
        s.core.list_conversations().unwrap().conversations.len(),
        16,
        "no reseed after restart"
    );
    for i in 1..=18 {
        s.core
            .get_conversation(&conversation(&format!("conv-{i:02}")))
            .expect("seeded conversation still readable after restart");
    }
    assert_eq!(rows(s.dir.path()), seeded, "no duplicate fact rows");
}

/// Legacy: `restart_preserves_confirmed_facts_and_operation_history`.
#[test]
fn restart_preserves_confirmed_facts_and_operation_history() {
    let s = Synthetic::open("restart-facts");
    let receipt = s
        .core
        .set_archived(&set_archived("conv-01", true, "req-restart"))
        .unwrap();
    assert!(wait_for_status(
        &s.core,
        std::slice::from_ref(&receipt.operation_id),
        OperationStatus::Confirmed
    ));
    assert!(!in_inbox(&s.core, "conv-01"));
    let before = s.provider.write_call_count();
    assert_eq!(before, 1);

    // A NEW provider object over the same file: facts are durable, not seed.
    let s = s.reopen();
    assert!(!in_inbox(&s.core, "conv-01"), "provider fact persisted");
    let snapshot = s.core.list_conversations().unwrap();
    assert_eq!(snapshot.activity.len(), 1, "operation history persisted");
    assert_eq!(
        status_of(&s.core, &receipt.operation_id),
        Some(OperationStatus::Confirmed)
    );
    assert_eq!(
        s.provider.write_call_count(),
        0,
        "restart replays nothing to the provider"
    );
}

/// Legacy: `lookups_are_account_scoped`.
#[test]
fn lookups_are_account_scoped() {
    let s = Synthetic::open("account-scope");
    let mut foreign = conversation("conv-01");
    foreign.account_id = "other-account".into();
    assert_eq!(s.core.get_conversation(&foreign), Err(MailError::NotFound));
    s.core
        .set_archived(&set_archived("conv-01", true, "req-scope"))
        .expect("fixture-account command validates");
    let mut command = set_archived("conv-01", true, "req-scope2");
    command.conversation.account_id = "other-account".into();
    assert_eq!(s.core.set_archived(&command), Err(MailError::NotFound));
}

/// Legacy: `receipt_is_durable_and_request_key_dedups_or_conflicts`.
#[test]
fn receipt_is_durable_and_request_key_dedups_or_conflicts() {
    let s = Synthetic::open_operations_paused("dedup");
    let receipt = s
        .core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .unwrap();
    let replay = s
        .core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .unwrap();
    assert_eq!(replay, receipt);
    assert_eq!(
        s.core.list_conversations().unwrap().activity.len(),
        1,
        "replay did not derive new targets"
    );
    assert_eq!(
        s.core.set_archived(&set_archived("conv-02", true, "req-1")),
        Err(MailError::RequestIdConflict)
    );
    let s = s.reopen();
    let replay = s
        .core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .unwrap();
    assert_eq!(replay, receipt, "receipt survived restart");
}

/// Legacy: `interrupted_applying_returns_to_queued_on_startup`. The Gmail
/// ledger does not blindly requeue an interrupted write: the row becomes
/// `outcome_unknown` and is reconciled against the provider's durable facts.
/// It is never replayed automatically (it may have landed); the user retries.
/// Case 1: the write never reached the provider (paused, then cancelled).
#[test]
fn interrupted_applying_is_reconciled_against_durable_facts_when_the_write_never_landed() {
    let s = Synthetic::open_with("recovery-unlanded", |p| p.set_paused(true));
    let receipt = s
        .core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .unwrap();
    assert!(s.synthetic.wait_for_write_calls(1, TIMEOUT));
    assert_eq!(
        status_of(&s.core, &receipt.operation_id),
        Some(OperationStatus::Applying)
    );
    let s = s.reopen();
    s.core.wait_for_test_idle(TIMEOUT).unwrap();
    // The facts say conv-01 is still in the Inbox, so the interrupted
    // archive is reconciled as NOT applied: uncertain, never confirmed, and
    // never replayed on its own.
    assert_eq!(
        status_of(&s.core, &receipt.operation_id),
        Some(OperationStatus::OutcomeUnknown)
    );
    assert_eq!(s.synthetic.write_call_count(), 0, "no automatic replay");
    let thread = s
        .synthetic
        .get_thread("conv-01", &mail_core::CancelToken::default())
        .unwrap()
        .unwrap();
    assert_eq!(
        thread.inbox_message_ids.len(),
        3,
        "unlanded write changed nothing"
    );
    // The explicit retry lands the write exactly once.
    let retry = s
        .core
        .retry_operation(&mail_core::dto::RetryOperation {
            operation_id: receipt.operation_id.clone(),
            request_id: "retry-1".into(),
        })
        .unwrap();
    assert!(wait_for_status(
        &s.core,
        std::slice::from_ref(&retry.operation_id),
        OperationStatus::Confirmed
    ));
    assert_eq!(s.synthetic.write_call_count(), 1);
}

/// Case 2: the write committed in the provider but the ledger never saw the
/// confirmation (crash between the two). Reconciliation observes the durable
/// fact and confirms without a second provider write.
#[test]
fn interrupted_applying_confirms_from_durable_facts_when_the_write_had_landed() {
    let s = Synthetic::open_wrapped("recovery-landed", Overlay::wrap);
    s.provider.hang_after_next_write();
    let receipt = s
        .core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .unwrap();
    assert!(mail_core::testing::until(|| s.provider.is_hung()));
    let Synthetic {
        core, dir, clock, ..
    } = s;
    core.stop();
    drop(core);
    let provider = new_provider(dir.path());
    let core = open_core_on(dir.path(), provider.clone(), &clock);
    core.wait_for_test_idle(TIMEOUT).unwrap();
    assert_eq!(
        status_of(&core, &receipt.operation_id),
        Some(OperationStatus::Confirmed),
        "reconciled from the durable provider fact"
    );
    assert_eq!(provider.write_call_count(), 0, "no second provider write");
    assert!(!in_inbox(&core, "conv-01"));
}

/// Legacy: `failure_is_retained_and_overlay_reverts`.
#[test]
fn failure_is_retained_and_overlay_reverts() {
    let s = Synthetic::open_with("failure", |p| p.fail_next());
    load_archived_seeds(&s.core).unwrap();
    let (counter, _sub) = ChangeCounter::subscribe(&s.core);
    let receipt = s
        .core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .unwrap();
    assert!(counter.until(|| {
        s.core
            .list_conversations()
            .unwrap()
            .activity
            .iter()
            .any(|op| {
                op.id == receipt.operation_id
                    && op.status == OperationStatus::Failed
                    && op.failure == Some(OperationFailure::ProviderRejected)
            })
    }));
    assert!(
        in_inbox(&s.core, "conv-01"),
        "failed archive reverts the overlay: conversation stays in the inbox"
    );
    // Failure stays discoverable for an out-of-inbox target as well.
    s.synthetic.fail_next();
    let second = s
        .core
        .set_archived(&set_archived("conv-06", true, "req-2"))
        .unwrap();
    assert!(
        counter.until(|| status_of(&s.core, &second.operation_id) == Some(OperationStatus::Failed))
    );
    assert!(!in_inbox(&s.core, "conv-06"));
    assert_eq!(
        s.synthetic.write_call_count(),
        2,
        "failed operations are not automatically replayed"
    );
}

/// Legacy: `archive_unarchive_ordering_survives_late_intent`.
#[test]
fn archive_unarchive_ordering_survives_late_intent() {
    let s = Synthetic::open_with("ordering", |p| p.set_paused(true));
    let archive = s
        .core
        .set_archived(&set_archived("conv-01", true, "req-archive"))
        .unwrap();
    assert!(s.synthetic.wait_for_write_calls(1, TIMEOUT));
    let unarchive = s
        .core
        .set_archived(&set_archived("conv-01", false, "req-unarchive"))
        .unwrap();
    assert!(
        in_inbox(&s.core, "conv-01"),
        "newer pending unarchive wins the overlay over the applying archive"
    );
    let reader = s.core.get_conversation(&conversation("conv-01")).unwrap();
    assert!(reader.is_in_inbox);
    assert_eq!(
        reader.pending_operation_id.as_deref(),
        Some(unarchive.operation_id.as_str())
    );
    s.synthetic.resume();
    assert!(wait_for_status(
        &s.core,
        &[archive.operation_id.clone(), unarchive.operation_id.clone()],
        OperationStatus::Confirmed
    ));
    assert!(
        in_inbox(&s.core, "conv-01"),
        "final state follows newest intent"
    );
    assert!(
        s.core
            .get_conversation(&conversation("conv-01"))
            .unwrap()
            .is_in_inbox
    );
}

/// Legacy: `paused_provider_does_not_hold_the_db_lock`. Also covers the
/// "claims do not overlap" half of `worker_claims_do_not_overlap_and_restart_is_rejected`.
#[test]
fn paused_provider_does_not_hold_the_db_lock_and_claims_do_not_overlap() {
    let s = Synthetic::open_with("no-db-lock", |p| p.set_paused(true));
    s.core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .unwrap();
    assert!(s.synthetic.wait_for_write_calls(1, TIMEOUT));
    // Reads, a second command and a second status read all commit while the
    // provider write is paused.
    s.core.list_conversations().unwrap();
    s.core.get_conversation(&conversation("conv-02")).unwrap();
    s.core.account_status().unwrap();
    let second = s
        .core
        .set_archived(&set_archived("conv-02", true, "req-2"))
        .unwrap();
    assert_eq!(
        status_of(&s.core, &second.operation_id),
        Some(OperationStatus::Queued)
    );
    assert_eq!(
        s.synthetic.write_call_count(),
        1,
        "serial worker: no overlap"
    );
    assert_eq!(s.synthetic.write_inflight_count(), 1);
    s.core.stop();
    assert_eq!(
        s.synthetic.write_call_count(),
        1,
        "the cancelled call never completes twice"
    );
}

/// Legacy: `shutdown_completes_while_provider_paused_and_work_stays_durable`.
#[test]
fn shutdown_completes_while_provider_paused_and_work_stays_durable() {
    let s = Synthetic::open_with("cancellation", |p| p.set_paused(true));
    let receipt = s
        .core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .unwrap();
    assert!(s.synthetic.wait_for_write_calls(1, TIMEOUT));
    // Stop must complete despite the paused provider call.
    s.core.stop();
    assert_eq!(
        s.synthetic.write_inflight_count(),
        0,
        "paused write released"
    );
    let s = s.reopen();
    // The interrupted operation is durable: still present, never lost, and
    // never silently confirmed without the provider's fact.
    s.core.wait_for_test_idle(TIMEOUT).unwrap();
    assert_eq!(
        status_of(&s.core, &receipt.operation_id),
        Some(OperationStatus::OutcomeUnknown),
        "interrupted operation stays in the ledger as uncertain"
    );
}

/// Legacy: `profile_lock_rejects_a_second_writer`.
#[test]
fn profile_lock_rejects_a_second_writer() {
    let s = Synthetic::open("profile-lock");
    let second = new_provider(s.dir.path());
    match GmailCore::open(s.dir.path(), second).map(|_| ()) {
        Err(MailError::ProfileInUse) => {}
        other => panic!("second open must be rejected with profile_in_use: {other:?}"),
    }
}

/// Legacy: `dropping_core_stops_worker_and_releases_profile_lock`.
#[test]
fn dropping_core_stops_worker_and_releases_profile_lock() {
    let s = Synthetic::open_with("drop-paused", |p| p.set_paused(true));
    let Synthetic {
        core,
        synthetic,
        dir,
        clock,
        ..
    } = s;
    core.set_archived(&set_archived("conv-01", true, "req-1"))
        .unwrap();
    assert!(synthetic.wait_for_write_calls(1, TIMEOUT));
    // Drop without stop(): RAII shutdown must not hang while paused.
    drop(core);
    drop(synthetic);
    // The lock was released only after the worker exited, so a reopen works.
    let provider = new_provider(dir.path());
    let core = open_core_on(dir.path(), provider, &clock);
    assert!(core.list_conversations().is_ok());
}

/// Legacy: `hostile_markup_is_literal_data`.
#[test]
fn hostile_markup_is_literal_data() {
    let s = Synthetic::open("hostile");
    let conv02 = s.core.get_conversation(&conversation("conv-02")).unwrap();
    assert!(conv02.subject.contains("<script>alert(\"xss\")</script>"));
    assert!(conv02.messages[0].body_text.contains("&amp;"));
    let conv17 = s.core.get_conversation(&conversation("conv-17")).unwrap();
    assert!(conv17.subject.contains("&lt;b&gt;bold&lt;/b&gt;"));
    assert!(conv17.messages[0].body_text.contains("&quot;quotes&quot;"));
    let snapshot = s.core.list_conversations().unwrap();
    let summary = snapshot
        .conversations
        .iter()
        .find(|c| c.conversation_ref.conversation_id == "conv-02")
        .unwrap();
    assert!(summary.subject.contains("<script>"));
}

/// Legacy: `subscription_fires_on_accept_and_confirm_and_can_unsubscribe`.
#[test]
fn subscription_fires_on_accept_and_confirm_and_can_unsubscribe() {
    let s = Synthetic::open_operations_paused("subscription");
    let (counter, subscription) = ChangeCounter::subscribe(&s.core);
    let before = counter.get();
    let receipt = s
        .core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .unwrap();
    assert!(counter.until(|| counter.get() > before), "fired on accept");
    let after_accept = counter.get();
    s.core.release_test_operations();
    assert!(counter.until(|| {
        status_of(&s.core, &receipt.operation_id) == Some(OperationStatus::Confirmed)
            && counter.get() > after_accept
    }));
    subscription.unsubscribe();
    s.core.wait_for_test_idle(TIMEOUT).unwrap();
    let quiet = counter.get();
    s.core
        .set_archived(&set_archived("conv-02", true, "req-2"))
        .unwrap();
    // Dispatch is synchronous inside the setter, so no sleep is needed.
    assert_eq!(counter.get(), quiet, "unsubscribed listener stays quiet");
}

/// Legacy: `invalid_requests_fail_closed`.
#[test]
fn invalid_requests_fail_closed() {
    let s = Synthetic::open("invalid");
    match s.core.set_archived(&mail_core::dto::SetArchived {
        conversation: conversation("conv-01"),
        archived: true,
        request_id: "   ".into(),
    }) {
        Err(MailError::InvalidRequest { field }) => assert_eq!(field, "requestId"),
        other => panic!("expected invalid_request, got {other:?}"),
    }
    assert_eq!(
        s.core.get_conversation(&conversation("conv-missing")),
        Err(MailError::NotFound)
    );
}

/// Legacy: `open_fails_closed_on_unusable_profile_directory`.
#[test]
fn open_fails_closed_on_unusable_profile_directory() {
    let dir = temp_profile("blocker");
    let blocker = dir.path().join("not-a-directory");
    std::fs::write(&blocker, b"not a directory").unwrap();
    match mail_core::synthetic::SyntheticGmailProvider::open(&blocker).map(|_| ()) {
        Err(MailError::StorageUnavailable) => {}
        other => panic!("provider: expected storage_unavailable, got {other:?}"),
    }
    let provider = std::sync::Arc::new(
        mail_core::synthetic::SyntheticGmailProvider::open(dir.path()).unwrap(),
    );
    match GmailCore::open(&blocker, provider).map(|_| ()) {
        Err(MailError::StorageUnavailable) => {}
        other => panic!("core: expected storage_unavailable, got {other:?}"),
    }
}

/// A newer synthetic seed or schema is never overwritten or half-read:
/// an unknown schema version fails closed and leaves the file untouched.
#[test]
fn unsupported_provider_schema_fails_closed_without_modifying_facts() {
    let dir = temp_profile("provider-schema");
    drop(new_provider(dir.path()));
    let path = dir.path().join("synthetic-provider.db");
    rusqlite::Connection::open(&path)
        .unwrap()
        .pragma_update(None, "user_version", 99)
        .unwrap();
    match mail_core::synthetic::SyntheticGmailProvider::open(dir.path()).map(|_| ()) {
        Err(MailError::StorageUnavailable) => {}
        other => panic!("expected storage_unavailable, got {other:?}"),
    }
    let version: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 99);
}

/// Legacy: `worker_halt_remains_visible_through_commands_after_storage_recovers`.
/// A persistence failure inside a worker pass halts the worker; once storage
/// recovers the halt stays visible through every command until restart.
/// Gmail-core difference (documented): cached reads keep working while halted
/// instead of failing, which is the existing Gmail behaviour.
#[test]
fn worker_halt_remains_visible_through_commands_after_storage_recovers() {
    let s = Synthetic::open("worker-halt");
    let (counter, _sub) = ChangeCounter::subscribe(&s.core);
    let before = counter.get();
    let db = gmail_db(s.dir.path());
    db.execute_batch(
        "CREATE TRIGGER inject_sync_failure BEFORE INSERT ON meta
         WHEN NEW.key = 'last_synced_at'
         BEGIN SELECT RAISE(ABORT, 'injected'); END;
         CREATE TRIGGER inject_sync_failure_update BEFORE UPDATE ON meta
         WHEN NEW.key = 'last_synced_at'
         BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    )
    .unwrap();
    mail_core::testing::request_sync_when_idle(&s.core);
    assert!(
        counter.until(|| counter.get() > before
            && s.core
                .account_status()
                .is_ok_and(|st| st.sync.error == Some(MailError::StorageUnavailable))),
        "worker halt is announced"
    );
    db.execute_batch("DROP TRIGGER inject_sync_failure; DROP TRIGGER inject_sync_failure_update;")
        .unwrap();
    // Storage is healthy again, but the halted worker still refuses commands.
    assert_eq!(
        s.core
            .set_archived(&set_archived("conv-01", true, "after-halt")),
        Err(MailError::StorageUnavailable)
    );
    assert!(s.core.list_conversations().unwrap().activity.is_empty());
    let Synthetic {
        core, dir, clock, ..
    } = s;
    drop(core);
    let provider = new_provider(dir.path());
    let restarted = open_core_on(dir.path(), provider, &clock);
    assert!(restarted
        .set_archived(&set_archived("conv-01", true, "after-restart"))
        .is_ok());
}
