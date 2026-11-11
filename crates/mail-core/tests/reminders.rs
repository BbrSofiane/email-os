use mail_core::{
    clock::{utc, Clock, FakeClock},
    dto::{ConversationRef, OperationStatus},
    reminders::{PutReminder, ReminderCondition, ReminderPhase},
    FakeArchiveProvider, MailCore, ACCOUNT_ID,
};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
fn until(mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(3);
    while !f() {
        assert!(Instant::now() < end, "fixture worker did not converge");
        std::thread::sleep(Duration::from_millis(5));
    }
}
// Observe worker polls without relying on a fixed sleep or counting clock reads
// from the test's own snapshot queries. The time source is still FakeClock.
struct ObservedClock {
    fake: FakeClock,
    worker_reads: AtomicUsize,
}
impl Clock for ObservedClock {
    fn now_iso(&self) -> String {
        let now = self.fake.now_iso();
        if std::thread::current().name() == Some("mail-core-worker") {
            self.worker_reads.fetch_add(1, Ordering::SeqCst);
        }
        now
    }
}

#[test]
fn serial_fake_provider_fires_future_reminder_once_while_worker_stays_alive() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(ObservedClock {
        fake: FakeClock::new(utc("2030-01-01T00:00:00Z")),
        worker_reads: AtomicUsize::new(0),
    });
    let core = MailCore::open_with_clock(dir.path(), clock.clone()).unwrap();
    let target = ConversationRef {
        account_id: ACCOUNT_ID.into(),
        conversation_id: "conv-01".into(),
    };
    let detail = core.get_conversation(&target).unwrap();
    assert!(detail.messages.len() > 1);
    let originally_archived = &detail.messages[0].id;
    let original_inbox_ids: Vec<_> = detail.messages[1..].iter().map(|m| m.id.clone()).collect();
    let conn = rusqlite::Connection::open(dir.path().join("mail.db")).unwrap();
    conn.execute(
        "UPDATE messages SET provider_inbox=0 WHERE message_id=?1",
        [originally_archived],
    )
    .unwrap();
    let provider = Arc::new(FakeArchiveProvider::new());
    core.start_worker(provider.clone()).unwrap();
    core.put_reminder(&PutReminder {
        conversation: target.clone(),
        source_message_id: detail.messages.last().unwrap().id.clone(),
        due_at: Some("2030-01-01T00:01:00Z".into()),
        condition: ReminderCondition::Regardless,
        expected_revision: None,
        request_id: "schedule-live".into(),
    })
    .unwrap();
    assert!(provider.wait_for_calls(1, Duration::from_secs(2)));
    until(|| core.list_reminders().unwrap()[0].phase == ReminderPhase::Pending);
    let removed = core.list_conversations().unwrap();
    assert_eq!(removed.activity.len(), 1);
    assert_eq!(removed.activity[0].status, OperationStatus::Confirmed);
    assert!(removed.activity[0].requested_archived);
    assert!(!core.get_conversation(&target).unwrap().is_in_inbox);

    // New mail must stay in Inbox and never widen the original restore targets.
    conn.execute(
        "INSERT INTO messages SELECT account_id,conversation_id,'new-mail',NULL,
         'friend@example.test',to_json,'2030-01-01T00:00:30Z','new plain text',1,0
         FROM messages WHERE conversation_id='conv-01' LIMIT 1",
        [],
    )
    .unwrap();
    // Neither a restart nor a direct reconcile drives the deadline transition.
    clock.fake.advance_seconds(61);
    assert!(provider.wait_for_calls(2, Duration::from_secs(2)));
    until(|| core.list_reminders().unwrap()[0].phase == ReminderPhase::Returned);
    let returned = core.list_reminders().unwrap();
    let snapshot = core.list_conversations().unwrap();
    assert_eq!(snapshot.activity.len(), 2);
    assert!(snapshot
        .activity
        .iter()
        .all(|op| { op.conversation == target && op.status == OperationStatus::Confirmed }));
    assert_eq!(
        snapshot
            .activity
            .iter()
            .filter(|op| !op.requested_archived)
            .count(),
        1
    );
    for op in &snapshot.activity {
        let ids: String = conn
            .query_row(
                "SELECT message_ids FROM operations WHERE operation_id=?1",
                [&op.id],
                |row| row.get(0),
            )
            .unwrap();
        let mut ids: Vec<String> = serde_json::from_str(&ids).unwrap();
        ids.sort();
        let mut expected = original_inbox_ids.clone();
        expected.sort();
        assert_eq!(ids, expected);
    }
    assert!(core.get_conversation(&target).unwrap().is_in_inbox);
    let archived_stayed_archived: bool = conn
        .query_row(
            "SELECT provider_inbox=0 FROM messages WHERE message_id=?1",
            [originally_archived],
            |row| row.get(0),
        )
        .unwrap();
    assert!(archived_stayed_archived);
    let new_mail_in_inbox: bool = conn
        .query_row(
            "SELECT provider_inbox FROM messages WHERE message_id='new-mail'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(new_mail_in_inbox);

    for seconds in [60, 86_400] {
        clock.fake.advance_seconds(seconds);
        let reads = clock.worker_reads.load(Ordering::SeqCst);
        // Three more worker clock reads guarantee multiple reconciliation
        // passes after advancing time, not just a fast assertion before a poll.
        until(|| clock.worker_reads.load(Ordering::SeqCst) >= reads + 3);
        assert!(core.is_worker_running());
        assert_eq!(core.list_reminders().unwrap(), returned);
        assert_eq!(
            core.list_conversations().unwrap().activity,
            snapshot.activity
        );
        assert_eq!(provider.call_count(), 2);
    }
    core.stop_worker();
    drop(conn);
    drop(core);
}

#[test]
fn serial_fake_provider_resumes_overdue_once_after_native_fixture_restart() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(FakeClock::new(utc("2030-01-01T00:00:00Z")));
    let core = MailCore::open_with_clock(dir.path(), clock.clone()).unwrap();
    let target = ConversationRef {
        account_id: ACCOUNT_ID.into(),
        conversation_id: "conv-01".into(),
    };
    let source = core
        .get_conversation(&target)
        .unwrap()
        .messages
        .last()
        .unwrap()
        .id
        .clone();
    let command = PutReminder {
        conversation: target.clone(),
        source_message_id: source,
        due_at: Some("2030-01-01T00:01:00Z".into()),
        condition: ReminderCondition::IfNoReply,
        expected_revision: None,
        request_id: "schedule".into(),
    };
    let receipt = core.put_reminder(&command).unwrap();
    let provider = Arc::new(FakeArchiveProvider::new());
    provider.set_paused(true);
    core.start_worker(provider.clone()).unwrap();
    assert!(provider.wait_for_calls(1, Duration::from_secs(2)));
    core.stop_worker();
    drop(core);
    clock.advance_seconds(61);
    let core = MailCore::open_with_clock(dir.path(), clock).unwrap();
    assert_eq!(core.put_reminder(&command).unwrap(), receipt);
    let provider = Arc::new(FakeArchiveProvider::new());
    core.start_worker(provider.clone()).unwrap();
    until(|| core.list_reminders().unwrap()[0].phase == ReminderPhase::Returned);
    assert_eq!(provider.call_count(), 2);
    let snapshot = core.list_conversations().unwrap();
    assert_eq!(snapshot.activity.len(), 2);
    assert!(core.get_conversation(&target).unwrap().is_in_inbox);
    core.stop_worker();
    drop(core);
    let core = MailCore::open(dir.path()).unwrap();
    let provider = Arc::new(FakeArchiveProvider::new());
    core.start_worker(provider.clone()).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(core.list_conversations().unwrap().activity.len(), 2);
    assert_eq!(provider.call_count(), 0);
    core.stop_worker();
    drop(core);
}
