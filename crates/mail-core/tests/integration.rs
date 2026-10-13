//! Deterministic contract tests for mail-core (docs/vertical-slice-01.md):
//! seed-once/restart, account scoping, durable receipts/dedup/conflict,
//! queued and interrupted-applying recovery, failure visibility and overlay
//! reversion, ordering with late intent, no DB lock during paused provider
//! calls, single non-overlapping claims, shutdown cancellation, profile lock
//! contention, literal hostile markup, and change subscription.
//!
//! All coordination uses condvar barriers (provider pause gates and change
//! listeners); the only polling is bounded assertion loops. The fake
//! provider is pure memory: no test opens sockets or performs network I/O.

use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use mail_core::dto::{
    ConversationRef, InboxSnapshot, OperationFailure, OperationStatus, SetArchived,
};
use mail_core::{FakeArchiveProvider, MailCore, MailError};

const TIMEOUT: Duration = Duration::from_secs(5);

/// Unique temp profile per test; stale dirs from crashed runs are tolerated.
fn temp_profile(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "mail-core-it-{}-{}-{}",
        tag,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open_core(tag: &str) -> (MailCore, PathBuf) {
    let dir = temp_profile(tag);
    let core = MailCore::open(&dir).expect("open core");
    (core, dir)
}

fn conv_ref(account: &str, conversation_id: &str) -> ConversationRef {
    ConversationRef {
        account_id: account.to_string(),
        conversation_id: conversation_id.to_string(),
    }
}

fn set_archived(conversation_id: &str, archived: bool, request_id: &str) -> SetArchived {
    SetArchived {
        conversation: conv_ref("fixture-account", conversation_id),
        archived,
        request_id: request_id.to_string(),
    }
}

/// Counts change notifications, with a condvar so tests await events
/// deterministically instead of sleeping.
struct ChangeCounter {
    count: Mutex<u32>,
    notified: Condvar,
}

impl ChangeCounter {
    fn subscribe(self: &Arc<Self>, core: &MailCore) -> mail_core::Unsubscribe {
        let counter = Arc::clone(self);
        core.subscribe(move || {
            *counter.count.lock().expect("counter poisoned") += 1;
            counter.notified.notify_all();
        })
    }

    fn get(&self) -> u32 {
        *self.count.lock().expect("counter poisoned")
    }

    /// Waits until `f` holds or the timeout elapses; woken by change events.
    /// The count guard is released before `f` runs and while waiting, so the
    /// listener (which locks the count) can never deadlock against this loop.
    fn until(&self, mut f: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if f() {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let count = self.count.lock().expect("counter poisoned");
            let (guard, _) = self
                .notified
                .wait_timeout(count, remaining)
                .expect("counter poisoned");
            drop(guard);
        }
    }
}

fn status_of(snapshot: &InboxSnapshot, operation_id: &str) -> OperationStatus {
    snapshot
        .activity
        .iter()
        .find(|op| op.id == operation_id)
        .map(|op| op.status)
        .expect("operation present in activity")
}

fn in_inbox(core: &MailCore, conversation_id: &str) -> bool {
    core.list_conversations()
        .expect("list conversations")
        .conversations
        .iter()
        .any(|c| c.conversation_ref.conversation_id == conversation_id)
}

#[test]
fn seeds_18_conversations_exactly_once_and_survives_restart() {
    let (core, dir) = open_core("seed-restart");
    let snapshot = core.list_conversations().expect("snapshot");
    assert_eq!(
        snapshot.conversations.len(),
        16,
        "16 of 18 seeded conversations start in the inbox (2 seeded archived)"
    );
    for i in 1..=18 {
        let conversation_id = format!("conv-{i:02}");
        let conversation = core
            .get_conversation(&conv_ref("fixture-account", &conversation_id))
            .expect("seeded conversation readable");
        assert!(!conversation.messages.is_empty());
    }
    core.stop_worker();
    drop(core);

    // Restart: no reseed, no duplicate rows, facts and history intact.
    let core = MailCore::open(&dir).expect("reopen core");
    let snapshot = core.list_conversations().expect("snapshot after restart");
    assert_eq!(snapshot.conversations.len(), 16);
    for i in 1..=18 {
        let conversation_id = format!("conv-{i:02}");
        core.get_conversation(&conv_ref("fixture-account", &conversation_id))
            .expect("seeded conversation still readable");
    }
    core.stop_worker();
}

#[test]
fn restart_preserves_confirmed_facts_and_operation_history() {
    let (core, dir) = open_core("restart-facts");
    let fake = Arc::new(FakeArchiveProvider::new());
    core.start_worker(fake.clone()).expect("start worker");
    let receipt = core
        .set_archived(&set_archived("conv-01", true, "req-restart"))
        .expect("accept command");
    let counter = Arc::new(ChangeCounter {
        count: Mutex::new(0),
        notified: Condvar::new(),
    });
    let _sub = counter.subscribe(&core);
    assert!(
        counter.until(|| {
            status_of(
                &core.list_conversations().expect("snapshot"),
                &receipt.operation_id,
            ) == OperationStatus::Confirmed
        }),
        "operation confirms"
    );
    assert!(
        !in_inbox(&core, "conv-01"),
        "confirmed archive removes from inbox"
    );
    core.stop_worker();
    drop(core);

    let core = MailCore::open(&dir).expect("reopen");
    let snapshot = core.list_conversations().expect("snapshot");
    assert!(
        !in_inbox(&core, "conv-01"),
        "provider fact persisted, not reset"
    );
    assert_eq!(snapshot.activity.len(), 1, "operation history persisted");
    assert_eq!(
        status_of(&snapshot, &receipt.operation_id),
        OperationStatus::Confirmed
    );
    core.stop_worker();
}

#[test]
fn lookups_are_account_scoped() {
    let (core, _dir) = open_core("account-scope");
    assert_eq!(core.account_id(), "fixture-account");
    match core.get_conversation(&conv_ref("other-account", "conv-01")) {
        Err(MailError::NotFound) => {}
        other => panic!("expected not_found for foreign account, got {other:?}"),
    }
    core.set_archived(&set_archived("conv-01", true, "req-scope"))
        .expect("fixture account command should validate");
    let mut foreign = set_archived("conv-01", true, "req-scope2");
    foreign.conversation.account_id = "other-account".to_string();
    match core.set_archived(&foreign) {
        Err(MailError::NotFound) => {}
        other => panic!("expected not_found for foreign account command, got {other:?}"),
    }
    core.stop_worker();
}

#[test]
fn receipt_is_durable_and_request_key_dedups_or_conflicts() {
    let (core, dir) = open_core("dedup");
    let receipt = core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .expect("first command accepted");
    // Identical replay of the request id and payload: same receipt.
    let replay = core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .expect("replayed command deduped");
    assert_eq!(replay, receipt);
    assert_eq!(
        core.list_conversations().expect("snapshot").activity.len(),
        1,
        "replay did not derive new targets"
    );
    // Same request id, different payload: conflict.
    match core.set_archived(&set_archived("conv-02", true, "req-1")) {
        Err(MailError::RequestIdConflict) => {}
        other => panic!("expected request_id_conflict, got {other:?}"),
    }
    // Receipt is durable across restart.
    core.stop_worker();
    drop(core);
    let core = MailCore::open(&dir).expect("reopen");
    let replay = core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .expect("replay after restart");
    assert_eq!(replay, receipt, "receipt survived restart");
    core.stop_worker();
}

#[test]
fn interrupted_applying_returns_to_queued_on_startup() {
    let (core, dir) = open_core("recovery");
    let fake = Arc::new(FakeArchiveProvider::new());
    fake.set_paused(true);
    core.start_worker(fake.clone()).expect("start worker");
    let receipt = core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .expect("accept");
    assert!(
        fake.wait_for_calls(1, TIMEOUT),
        "worker claimed and called the paused provider"
    );
    assert_eq!(
        status_of(
            &core.list_conversations().expect("snapshot"),
            &receipt.operation_id
        ),
        OperationStatus::Applying
    );
    core.stop_worker();
    drop(core);

    // Startup recovery: applying -> queued in original sequence.
    let core = MailCore::open(&dir).expect("reopen");
    assert_eq!(
        status_of(
            &core.list_conversations().expect("snapshot"),
            &receipt.operation_id
        ),
        OperationStatus::Queued,
        "interrupted applying operation requeued"
    );
    // It then applies and confirms once the provider is available.
    let fake = Arc::new(FakeArchiveProvider::new());
    core.start_worker(fake).expect("start worker");
    let counter = Arc::new(ChangeCounter {
        count: Mutex::new(0),
        notified: Condvar::new(),
    });
    let _sub = counter.subscribe(&core);
    assert!(
        counter.until(|| {
            status_of(
                &core.list_conversations().expect("snapshot"),
                &receipt.operation_id,
            ) == OperationStatus::Confirmed
        }),
        "requeued operation confirms"
    );
    assert!(!in_inbox(&core, "conv-01"));
    core.stop_worker();
}

#[test]
fn failure_is_retained_and_overlay_reverts() {
    let (core, _dir) = open_core("failure");
    let fake = Arc::new(FakeArchiveProvider::new());
    fake.fail_next();
    core.start_worker(fake.clone()).expect("start worker");
    let receipt = core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .expect("accept");
    let counter = Arc::new(ChangeCounter {
        count: Mutex::new(0),
        notified: Condvar::new(),
    });
    let _sub = counter.subscribe(&core);
    assert!(
        counter.until(|| {
            let snapshot = core.list_conversations().expect("snapshot");
            status_of(&snapshot, &receipt.operation_id) == OperationStatus::Failed
                && snapshot.activity.iter().any(|op| {
                    op.id == receipt.operation_id
                        && op.failure == Some(OperationFailure::ProviderRejected)
                })
        }),
        "failure visible in activity with typed kind"
    );
    assert!(
        in_inbox(&core, "conv-01"),
        "failed archive reverts the overlay: conversation stays in the inbox"
    );
    // Failure stays discoverable in activity even for an out-of-inbox target.
    fake.fail_next();
    let receipt2 = core
        .set_archived(&set_archived("conv-06", true, "req-2"))
        .expect("accept");
    assert!(
        counter.until(|| {
            let snapshot = core.list_conversations().expect("snapshot");
            snapshot
                .activity
                .iter()
                .any(|op| op.id == receipt2.operation_id && op.status == OperationStatus::Failed)
        }),
        "second failure visible"
    );
    assert!(!in_inbox(&core, "conv-06"));
    // Failed operations are not automatically replayed: exactly two calls.
    assert_eq!(fake.call_count(), 2);
    core.stop_worker();
}

#[test]
fn archive_unarchive_ordering_survives_late_intent() {
    let (core, _dir) = open_core("ordering");
    let fake = Arc::new(FakeArchiveProvider::new());
    fake.set_paused(true);
    core.start_worker(fake.clone()).expect("start worker");
    let archive_receipt = core
        .set_archived(&set_archived("conv-01", true, "req-archive"))
        .expect("accept archive");
    assert!(fake.wait_for_calls(1, TIMEOUT), "first operation claimed");
    // Newer unarchive intent arrives while the archive is still applying.
    let unarchive_receipt = core
        .set_archived(&set_archived("conv-01", false, "req-unarchive"))
        .expect("accept unarchive");
    assert!(
        in_inbox(&core, "conv-01"),
        "newer pending unarchive wins the overlay over the applying archive"
    );
    let conversation = core
        .get_conversation(&conv_ref("fixture-account", "conv-01"))
        .expect("reader");
    assert!(conversation.is_in_inbox);
    assert_eq!(
        conversation.pending_operation_id.as_deref(),
        Some(unarchive_receipt.operation_id.as_str()),
        "newest pending operation surfaced"
    );
    fake.resume();
    let counter = Arc::new(ChangeCounter {
        count: Mutex::new(0),
        notified: Condvar::new(),
    });
    let _sub = counter.subscribe(&core);
    assert!(
        counter.until(|| {
            let snapshot = core.list_conversations().expect("snapshot");
            status_of(&snapshot, &archive_receipt.operation_id) == OperationStatus::Confirmed
                && status_of(&snapshot, &unarchive_receipt.operation_id)
                    == OperationStatus::Confirmed
        }),
        "both operations confirm in acceptance order"
    );
    // The older confirmation (archive) must not erase the newer intent
    // (unarchive): final provider fact is inbox membership.
    let conversation = core
        .get_conversation(&conv_ref("fixture-account", "conv-01"))
        .expect("reader");
    assert!(
        conversation.is_in_inbox,
        "final effective state follows the newest intent"
    );
    assert!(in_inbox(&core, "conv-01"));
    core.stop_worker();
}

#[test]
fn paused_provider_does_not_hold_the_db_lock() {
    let (core, _dir) = open_core("no-db-lock");
    let fake = Arc::new(FakeArchiveProvider::new());
    fake.set_paused(true);
    core.start_worker(fake.clone()).expect("start worker");
    let _receipt = core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .expect("accept");
    assert!(
        fake.wait_for_calls(1, TIMEOUT),
        "provider call in flight and paused"
    );
    // While the provider is paused: reads, and a second command, all commit.
    let _ = core
        .list_conversations()
        .expect("list while provider paused");
    let _ = core
        .get_conversation(&conv_ref("fixture-account", "conv-02"))
        .expect("read while provider paused");
    let second = core
        .set_archived(&set_archived("conv-02", true, "req-2"))
        .expect("second command while provider paused");
    assert_eq!(
        status_of(
            &core.list_conversations().expect("snapshot"),
            &second.operation_id
        ),
        OperationStatus::Queued
    );
    assert_eq!(
        fake.call_count(),
        1,
        "worker is serial: no overlapping claim"
    );
    core.stop_worker();
}

#[test]
fn worker_claims_do_not_overlap_and_restart_is_rejected() {
    let (core, _dir) = open_core("overlap");
    let fake = Arc::new(FakeArchiveProvider::new());
    fake.set_paused(true);
    core.start_worker(fake.clone()).expect("start worker");
    let _ = core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .expect("accept");
    assert!(fake.wait_for_calls(1, TIMEOUT));
    match core.start_worker(Arc::new(FakeArchiveProvider::new())) {
        Err(MailError::InvalidRequest { .. }) => {}
        other => panic!("second start must be rejected, got {other:?}"),
    }
    // Queue more work: still exactly one in-flight call, no overlap.
    let _ = core
        .set_archived(&set_archived("conv-02", true, "req-2"))
        .expect("queue while paused");
    assert_eq!(fake.call_count(), 1);
    assert_eq!(fake.inflight_count(), 1);
    core.stop_worker();
    assert_eq!(fake.call_count(), 1, "cancelled call never completed twice");
}

#[test]
fn shutdown_completes_while_provider_paused_and_work_stays_durable() {
    let (core, dir) = open_core("cancellation");
    let fake = Arc::new(FakeArchiveProvider::new());
    fake.set_paused(true);
    core.start_worker(fake.clone()).expect("start worker");
    let receipt = core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .expect("accept");
    assert!(fake.wait_for_calls(1, TIMEOUT));
    assert_eq!(
        status_of(
            &core.list_conversations().expect("snapshot"),
            &receipt.operation_id
        ),
        OperationStatus::Applying
    );
    // Stop must complete despite the paused provider call.
    core.stop_worker();
    assert!(!core.is_worker_running(), "worker joined after cancel");
    drop(core);

    // Interrupted work is durable and recovered at next launch.
    let core = MailCore::open(&dir).expect("reopen");
    assert_eq!(
        status_of(
            &core.list_conversations().expect("snapshot"),
            &receipt.operation_id
        ),
        OperationStatus::Queued,
        "interrupted applying operation recovered to queued"
    );
    core.stop_worker();
}

#[test]
fn profile_lock_rejects_a_second_writer() {
    let (core, dir) = open_core("profile-lock");
    match MailCore::open(&dir).map(|_| ()) {
        Err(MailError::ProfileInUse) => {}
        other => panic!("second open must be rejected with profile_in_use: {other:?}"),
    }
    drop(core);
    let core = MailCore::open(&dir).expect("reopen after release");
    core.stop_worker();
}

/// Regression: dropping the core RAII-stops the worker (cancel + join) even
/// while the fake provider is paused, and the profile lock is released only
/// after the worker thread exits, so a fresh open succeeds immediately.
#[test]
fn dropping_core_stops_worker_and_releases_profile_lock() {
    let (core, dir) = open_core("drop-paused");
    let fake = Arc::new(FakeArchiveProvider::new());
    fake.set_paused(true);
    core.start_worker(fake.clone()).expect("start worker");
    let receipt = core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .expect("accept");
    assert!(
        fake.wait_for_calls(1, TIMEOUT),
        "worker paused inside the provider call"
    );
    // Drop without calling stop_worker: RAII shutdown must not hang.
    drop(core);
    // The profile lock was held by the worker thread until it exited, so the
    // immediate reopen both proves exclusivity and succeeds.
    let core = MailCore::open(&dir).expect("lock released after drop");
    assert_eq!(
        status_of(
            &core.list_conversations().expect("snapshot"),
            &receipt.operation_id
        ),
        OperationStatus::Queued,
        "interrupted applying operation recovered to queued"
    );
    core.stop_worker();
}

#[test]
fn hostile_markup_is_literal_data() {
    let (core, _dir) = open_core("hostile");
    let conversation = core
        .get_conversation(&conv_ref("fixture-account", "conv-02"))
        .expect("reader");
    assert!(conversation
        .subject
        .contains("<script>alert(\"xss\")</script>"));
    assert!(conversation.messages[0].body_text.contains("&amp;"));
    let conversation = core
        .get_conversation(&conv_ref("fixture-account", "conv-17"))
        .expect("reader");
    assert!(conversation.subject.contains("&lt;b&gt;bold&lt;/b&gt;"));
    assert!(conversation.messages[0]
        .body_text
        .contains("&quot;quotes&quot;"));
    // Summaries carry the same literal text.
    let snapshot = core.list_conversations().expect("snapshot");
    let summary = snapshot
        .conversations
        .iter()
        .find(|c| c.conversation_ref.conversation_id == "conv-02")
        .expect("summary");
    assert!(summary.subject.contains("<script>"));
    core.stop_worker();
}

#[test]
fn subscription_fires_on_accept_and_confirm_and_can_unsubscribe() {
    let (core, _dir) = open_core("subscription");
    let counter = Arc::new(ChangeCounter {
        count: Mutex::new(0),
        notified: Condvar::new(),
    });
    let sub = counter.subscribe(&core);
    let before = counter.get();
    let receipt = core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .expect("accept");
    assert!(
        counter.until(|| counter.get() > before),
        "listener fired after commit"
    );
    let fake = Arc::new(FakeArchiveProvider::new());
    core.start_worker(fake.clone()).expect("start worker");
    assert!(
        counter.until(|| {
            status_of(
                &core.list_conversations().expect("snapshot"),
                &receipt.operation_id,
            ) == OperationStatus::Confirmed
                && counter.get() > before + 1
        }),
        "listener fired on confirmation"
    );
    sub.unsubscribe();
    let after = counter.get();
    let _ = core
        .set_archived(&set_archived("conv-02", true, "req-2"))
        .expect("accept after unsubscribe");
    // Dispatch happens synchronously inside set_archived before it returns,
    // so no sleep is needed to prove the unsubscribed listener stays quiet.
    assert_eq!(counter.get(), after, "unsubscribed listener stays quiet");
    core.stop_worker();
}

#[test]
fn invalid_requests_fail_closed() {
    let (core, _dir) = open_core("invalid");
    match core.set_archived(&SetArchived {
        conversation: conv_ref("fixture-account", "conv-01"),
        archived: true,
        request_id: "   ".to_string(),
    }) {
        Err(MailError::InvalidRequest { field }) => assert_eq!(field, "requestId"),
        other => panic!("expected invalid_request, got {other:?}"),
    }
    match core.get_conversation(&conv_ref("fixture-account", "conv-missing")) {
        Err(MailError::NotFound) => {}
        other => panic!("expected not_found, got {other:?}"),
    }
    core.stop_worker();
}
