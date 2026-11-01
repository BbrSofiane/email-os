use super::*;
use crate::{
    clock::{utc, FakeClock},
    reminders::*,
};
#[test]
fn restore_preserves_mixed_prior_membership_and_commit_failure_creates_no_return() {
    let dir = std::env::temp_dir().join(format!("reminder-mixed-{}", uuid::Uuid::new_v4()));
    let clock = Arc::new(FakeClock::new(utc("2030-01-01T00:00:00Z")));
    let s = Store::open(&dir, clock.clone()).unwrap();
    let target = ConversationRef {
        account_id: ACCOUNT_ID.into(),
        conversation_id: "conv-01".into(),
    };
    let detail = s.get_conversation(&target).unwrap();
    let old = &detail.messages[0].id;
    assert!(detail.messages.len() > 1);
    s.lock_conn()
        .unwrap()
        .execute(
            "UPDATE messages SET provider_inbox=0 WHERE message_id=?1",
            [old],
        )
        .unwrap();
    let c = PutReminder {
        conversation: target.clone(),
        source_message_id: detail.messages.last().unwrap().id.clone(),
        due_at: Some("2030-01-01T01:01:00+01:00".into()),
        condition: ReminderCondition::Regardless,
        expected_revision: None,
        request_id: "mixed".into(),
    };
    s.put_reminder(&c).unwrap();
    let remove = s.claim_next_queued().unwrap().unwrap();
    assert!(!remove.message_ids.contains(old));
    s.confirm_op(&remove).unwrap();
    s.reconcile_reminders().unwrap();
    clock.advance_seconds(61);
    s.set_test_persistence_failure(true);
    assert_eq!(s.reconcile_reminders(), Err(MailError::StorageUnavailable));
    s.set_test_persistence_failure(false);
    assert_eq!(s.list_reminders().unwrap()[0].phase, ReminderPhase::Pending);
    assert!(s.claim_next_queued().unwrap().is_none());
    s.reconcile_reminders().unwrap();
    let returning = s.claim_next_queued().unwrap().unwrap();
    assert_eq!(returning.message_ids, remove.message_ids);
    s.confirm_op(&returning).unwrap();
    s.reconcile_reminders().unwrap();
    let conn = s.lock_conn().unwrap();
    let inbox: bool = conn
        .query_row(
            "SELECT provider_inbox FROM messages WHERE message_id=?1",
            [old],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!inbox);
    drop(conn);
    drop(s);
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn concurrent_cancel_and_reschedule_have_only_one_revision_winner_and_dst_offsets_are_explicit() {
    let dir = std::env::temp_dir().join(format!("reminder-cas-{}", uuid::Uuid::new_v4()));
    let clock = Arc::new(FakeClock::new(utc("2030-01-01T00:00:00Z")));
    let s = Arc::new(Store::open(&dir, clock).unwrap());
    let target = ConversationRef {
        account_id: ACCOUNT_ID.into(),
        conversation_id: "conv-01".into(),
    };
    let source = s
        .get_conversation(&target)
        .unwrap()
        .messages
        .last()
        .unwrap()
        .id
        .clone();
    let mut c = PutReminder {
        conversation: target.clone(),
        source_message_id: source,
        due_at: Some("2030-11-03T01:30:00-04:00".into()),
        condition: ReminderCondition::IfNoReply,
        expected_revision: None,
        request_id: "dst-first".into(),
    };
    s.put_reminder(&c).unwrap();
    let remove = s.claim_next_queued().unwrap().unwrap();
    s.confirm_op(&remove).unwrap();
    s.reconcile_reminders().unwrap();
    let revision = s.list_reminders().unwrap()[0].revision;
    c.due_at = Some("2030-11-03T01:30:00-05:00".into());
    c.expected_revision = Some(revision);
    c.request_id = "dst-fold-choice".into();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let one = {
        let s = s.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            barrier.wait();
            s.put_reminder(&c)
        })
    };
    let two = {
        let s = s.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            barrier.wait();
            s.cancel_reminder(&CancelReminder {
                conversation: target,
                expected_revision: revision,
                request_id: "cancel-race".into(),
            })
        })
    };
    barrier.wait();
    let results = [one.join().unwrap(), two.join().unwrap()];
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    drop(s);
    std::fs::remove_dir_all(dir).unwrap();
}
