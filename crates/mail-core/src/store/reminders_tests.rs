use super::*;
use crate::{
    clock::{utc, FakeClock},
    reminders::*,
};

fn setup() -> (tempfile::TempDir, Arc<FakeClock>, Store) {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(FakeClock::new(utc("2030-01-01T00:00:00Z")));
    let store = Store::open(dir.path(), clock.clone()).unwrap();
    (dir, clock, store)
}
fn command(s: &Store, condition: ReminderCondition) -> PutReminder {
    let conversation = ConversationRef {
        account_id: ACCOUNT_ID.into(),
        conversation_id: "conv-01".into(),
    };
    let source = s
        .get_conversation(&conversation)
        .unwrap()
        .messages
        .last()
        .unwrap()
        .id
        .clone();
    PutReminder {
        conversation,
        source_message_id: source,
        due_at: Some("2030-01-01T00:01:00Z".into()),
        condition,
        expected_revision: None,
        request_id: "schedule".into(),
    }
}
fn confirm(s: &Store) {
    while let Some(op) = s.claim_next_queued().unwrap() {
        s.confirm_op(&op).unwrap();
    }
    s.reconcile_reminders().unwrap();
}
fn row(s: &Store) -> Reminder {
    s.list_reminders().unwrap().remove(0)
}
fn incoming(s: &Store, mailbox: &str) {
    let conn = s.lock_conn().unwrap();
    conn.execute("INSERT INTO messages SELECT account_id,conversation_id,'new-mail',NULL,?1,to_json,'2030-01-01T00:00:30Z','new plain text',1,0 FROM messages WHERE conversation_id='conv-01' LIMIT 1",[mailbox]).unwrap();
}
#[test]
fn fire_once_exact_inventory_restart_and_receipt_replay() {
    let (dir, clock, s) = setup();
    let c = command(&s, ReminderCondition::Regardless);
    let accepted = s.put_reminder(&c).unwrap();
    confirm(&s);
    incoming(&s, "friend@example.test");
    clock.advance_seconds(61);
    drop(s);
    let s = Store::open(dir.path(), clock).unwrap();
    s.recover_applying().unwrap();
    assert_eq!(s.put_reminder(&c).unwrap(), accepted);
    assert!(s.reconcile_reminders().unwrap());
    let op = s.claim_next_queued().unwrap().unwrap();
    assert!(!op.requested_archived);
    assert!(!op.message_ids.contains(&"new-mail".into()));
    s.confirm_op(&op).unwrap();
    s.reconcile_reminders().unwrap();
    assert_eq!(row(&s).phase, ReminderPhase::Returned);
    assert!(!s.reconcile_reminders().unwrap());
    assert!(s.claim_next_queued().unwrap().is_none());
    let mut conflict = c.clone();
    conflict.due_at = None;
    assert_eq!(s.put_reminder(&conflict), Err(MailError::RequestIdConflict));
    drop(s);
}
#[test]
fn reply_suppresses_only_conditional_and_self_does_not_qualify() {
    for (condition, mailbox, phase) in [
        (
            ReminderCondition::IfNoReply,
            "other@example.test",
            ReminderPhase::Suppressed,
        ),
        (
            ReminderCondition::Regardless,
            "other@example.test",
            ReminderPhase::Returning,
        ),
        (
            ReminderCondition::IfNoReply,
            crate::FIXTURE_MAILBOX,
            ReminderPhase::Returning,
        ),
    ] {
        let (_dir, clock, s) = setup();
        s.put_reminder(&command(&s, condition)).unwrap();
        confirm(&s);
        incoming(&s, mailbox);
        clock.advance_seconds(61);
        s.reconcile_reminders().unwrap();
        assert_eq!(row(&s).phase, phase);
        assert!(
            s.get_conversation(&row(&s).conversation)
                .unwrap()
                .is_in_inbox
        );
        drop(s);
    }
}
#[test]
fn someday_never_fires_and_cancellation_orders_after_inflight_removal() {
    let (_dir, clock, s) = setup();
    let mut c = command(&s, ReminderCondition::IfNoReply);
    c.due_at = None;
    s.put_reminder(&c).unwrap();
    let removal = s.claim_next_queued().unwrap().unwrap();
    let cancel = CancelReminder {
        conversation: c.conversation,
        expected_revision: 1,
        request_id: "cancel".into(),
    };
    let receipt = s.cancel_reminder(&cancel).unwrap();
    incoming(&s, "other@example.test");
    s.confirm_op(&removal).unwrap();
    clock.advance_seconds(1_000_000);
    confirm(&s);
    assert_eq!(row(&s).phase, ReminderPhase::Cancelled);
    assert_eq!(s.cancel_reminder(&cancel).unwrap(), receipt);
    drop(s);

    let (_dir, clock, s) = setup();
    let mut c = command(&s, ReminderCondition::Regardless);
    c.due_at = None;
    s.put_reminder(&c).unwrap();
    confirm(&s);
    incoming(&s, "other@example.test");
    clock.advance_seconds(1_000_000);
    assert!(!s.reconcile_reminders().unwrap());
    assert_eq!(row(&s).phase, ReminderPhase::Pending);
    drop(s);
}
#[test]
fn reschedule_cancel_fire_cas_failure_and_superseding_triage() {
    let (_dir, clock, s) = setup();
    let mut c = command(&s, ReminderCondition::Regardless);
    s.put_reminder(&c).unwrap();
    confirm(&s);
    let old = row(&s);
    c.expected_revision = Some(old.revision);
    c.request_id = "reschedule".into();
    c.due_at = Some("2030-01-01T00:02:00Z".into());
    s.put_reminder(&c).unwrap();
    clock.advance_seconds(61);
    assert!(!s.reconcile_reminders().unwrap());
    assert!(s
        .cancel_reminder(&CancelReminder {
            conversation: c.conversation.clone(),
            expected_revision: old.revision,
            request_id: "stale-cancel".into()
        })
        .is_err());
    clock.advance_seconds(60);
    s.reconcile_reminders().unwrap();
    c.request_id = "late-reschedule".into();
    assert!(s.put_reminder(&c).is_err());
    let returning = s.claim_next_queued().unwrap().unwrap();
    s.fail_op(&returning.operation_id, "provider_rejected")
        .unwrap();
    s.reconcile_reminders().unwrap();
    assert_eq!(row(&s).phase, ReminderPhase::Failed);
    s.cancel_reminder(&CancelReminder {
        conversation: c.conversation,
        expected_revision: row(&s).revision,
        request_id: "recover".into(),
    })
    .unwrap();
    confirm(&s);
    assert_eq!(row(&s).phase, ReminderPhase::Cancelled);
    drop(s);

    let (_dir, clock, s) = setup();
    let c = command(&s, ReminderCondition::Regardless);
    s.put_reminder(&c).unwrap();
    confirm(&s);
    s.set_archived(&SetArchived {
        conversation: c.conversation.clone(),
        archived: true,
        request_id: "new-triage".into(),
    })
    .unwrap();
    clock.advance_seconds(61);
    s.reconcile_reminders().unwrap();
    assert_eq!(row(&s).phase, ReminderPhase::Failed);
    s.cancel_reminder(&CancelReminder {
        conversation: c.conversation,
        expected_revision: row(&s).revision,
        request_id: "cancel-superseded".into(),
    })
    .unwrap();
    confirm(&s);
    assert_eq!(row(&s).phase, ReminderPhase::Cancelled);
    assert!(
        !s.get_conversation(&row(&s).conversation)
            .unwrap()
            .is_in_inbox
    );
    drop(s);
}
#[test]
fn source_account_time_and_persistence_fail_closed_and_undo_slot_survives() {
    let (_dir, _, s) = setup();
    let c = command(&s, ReminderCondition::IfNoReply);
    for due in [
        "2030-11-03T01:30:00",
        "2030-03-10T02:30:00",
        "yesterday",
        "2029-01-01T00:00:00Z",
        "2030-01-01T00:01:60Z",
    ] {
        let mut bad = c.clone();
        bad.due_at = Some(due.into());
        assert!(s.put_reminder(&bad).is_err());
    }
    let mut bad = c.clone();
    bad.conversation.account_id = "foreign".into();
    assert_eq!(s.put_reminder(&bad), Err(MailError::NotFound));
    bad = c.clone();
    bad.source_message_id = "stale".into();
    assert!(s.put_reminder(&bad).is_err());
    s.set_test_persistence_failure(true);
    assert_eq!(s.put_reminder(&c), Err(MailError::StorageUnavailable));
    s.set_test_persistence_failure(false);
    assert!(s.list_reminders().unwrap().is_empty());
    let action = s
        .set_archived(&SetArchived {
            conversation: ConversationRef {
                account_id: ACCOUNT_ID.into(),
                conversation_id: "conv-02".into(),
            },
            archived: true,
            request_id: "ordinary".into(),
        })
        .unwrap();
    confirm(&s);
    s.put_reminder(&c).unwrap();
    confirm(&s);
    s.undo_operation(&UndoOperation {
        operation_id: action.operation_id,
        request_id: "ordinary-undo".into(),
    })
    .unwrap();
    drop(s);
}
