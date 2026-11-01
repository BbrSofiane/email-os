use mail_core::{
    clock::{utc, FakeClock},
    dto::ConversationRef,
    reminders::{PutReminder, ReminderCondition, ReminderPhase},
    FakeArchiveProvider, MailCore, ACCOUNT_ID,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
fn until(mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(3);
    while !f() {
        assert!(Instant::now() < end, "fixture worker did not converge");
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn serial_fake_provider_resumes_overdue_once_after_native_fixture_restart() {
    let dir = std::env::temp_dir().join(format!("reminder-worker-{}", uuid::Uuid::new_v4()));
    let clock = Arc::new(FakeClock::new(utc("2030-01-01T00:00:00Z")));
    let core = MailCore::open_with_clock(&dir, clock.clone()).unwrap();
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
    let core = MailCore::open_with_clock(&dir, clock).unwrap();
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
    let core = MailCore::open(&dir).unwrap();
    let provider = Arc::new(FakeArchiveProvider::new());
    core.start_worker(provider.clone()).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(core.list_conversations().unwrap().activity.len(), 2);
    assert_eq!(provider.call_count(), 0);
    core.stop_worker();
    drop(core);
    std::fs::remove_dir_all(dir).unwrap();
}
