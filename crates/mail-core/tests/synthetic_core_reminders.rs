//! Local reminders on a synthetic session (ADR 0002 decision 3): they follow
//! the Gmail core's local rules — hide locally, never write the provider —
//! with fresh reads from the durable synthetic provider. Time is the injected
//! clock; the worker observes it when woken.

use mail_core::dto::{OperationStatus, SetArchived, UndoOperation};
use mail_core::gmail::types::GmailProvider as _;
use mail_core::reminders::{
    CancelReminder, PutReminder, Reminder, ReminderCondition, ReminderPhase,
};
use mail_core::testing::synthetic::*;
use mail_core::testing::until;
use mail_core::{MailError, ACCOUNT_ID};

fn put(conv: &str, due: Option<&str>, condition: ReminderCondition, request: &str) -> PutReminder {
    PutReminder {
        conversation: conversation(conv),
        source_message_id: latest_message(conv),
        due_at: due.map(str::to_string),
        condition,
        expected_revision: None,
        request_id: request.to_string(),
    }
}

/// The newest message of a seeded conversation (the reminder source).
fn latest_message(conv: &str) -> String {
    use mail_core::gmail::types::GmailProvider;
    let dir = mail_core::testing::temp_profile("reminder-source");
    let provider = mail_core::synthetic::SyntheticGmailProvider::open(dir.path()).unwrap();
    provider
        .get_thread(conv, &mail_core::CancelToken::default())
        .unwrap()
        .unwrap()
        .conversation
        .messages
        .last()
        .unwrap()
        .id
        .clone()
}

fn only(s: &Synthetic<impl mail_core::gmail::types::GmailProvider + 'static>) -> Reminder {
    let mut rows = s.core.list_reminders().unwrap();
    assert_eq!(rows.len(), 1);
    rows.remove(0)
}

fn phase_reaches(
    s: &Synthetic<impl mail_core::gmail::types::GmailProvider + 'static>,
    phase: ReminderPhase,
) -> bool {
    until(|| {
        s.core
            .list_reminders()
            .is_ok_and(|rows| rows.iter().all(|r| r.phase == phase))
    })
}

/// Legacy: `fire_once_exact_inventory_restart_and_receipt_replay`,
/// `serial_fake_provider_fires_future_reminder_once_while_worker_stays_alive`
/// and (obsolete under decision 3) `restore_preserves_mixed_prior_membership…`:
/// there is no archive/restore any more, so nothing is written to the provider.
#[test]
fn reminder_hides_locally_returns_once_and_never_writes_the_provider() {
    let s = Synthetic::open_wrapped("reminder-fire", Overlay::wrap);
    let command = put(
        "conv-01",
        Some("2026-02-01T00:01:00Z"),
        ReminderCondition::Regardless,
        "schedule",
    );
    let accepted = s.core.put_reminder(&command).unwrap();
    assert_eq!(accepted.phase, ReminderPhase::Pending);
    assert_eq!(accepted.revision, 1);
    assert!(
        !in_inbox(&s.core, "conv-01"),
        "hidden locally while pending"
    );
    assert!(
        s.core.list_conversations().unwrap().activity.is_empty(),
        "no operation"
    );
    // The provider's mailbox is untouched and never written.
    assert!(s.provider.writes().is_empty());
    assert_eq!(s.synthetic.write_call_count(), 0);
    let thread = s
        .synthetic
        .get_thread_for_account(ACCOUNT_ID, "conv-01", &Default::default());
    assert_eq!(
        thread.unwrap().unwrap().inbox_message_ids.len(),
        3,
        "all messages still INBOX"
    );
    // Receipt replay is the same receipt; a changed payload conflicts.
    assert_eq!(s.core.put_reminder(&command).unwrap(), accepted);
    let mut changed = command.clone();
    changed.due_at = None;
    assert_eq!(
        s.core.put_reminder(&changed),
        Err(MailError::RequestIdConflict)
    );

    advance_and_observe(&s, 61);
    assert!(phase_reaches(&s, ReminderPhase::Returned));
    assert!(in_inbox(&s.core, "conv-01"), "returned to the Inbox");
    let returned = only(&s);
    assert_eq!(returned.revision, 2);
    for seconds in [60, 86_400] {
        advance_and_observe(&s, seconds);
        assert_eq!(only(&s), returned, "fires exactly once");
    }
    assert!(s.provider.writes().is_empty());
    assert_eq!(s.synthetic.write_call_count(), 0);
    assert!(s.core.list_conversations().unwrap().activity.is_empty());

    // Restart: still returned, receipt replay survives.
    let Synthetic {
        core, dir, clock, ..
    } = s;
    core.stop();
    drop(core);
    let core = open_core_on(dir.path(), new_provider(dir.path()), &clock);
    assert_eq!(core.list_reminders().unwrap(), vec![returned]);
    assert_eq!(core.put_reminder(&command).unwrap(), accepted);
}

/// Legacy: `serial_fake_provider_resumes_overdue_once_after_native_fixture_restart`.
#[test]
fn overdue_reminder_resumes_once_after_restart() {
    let s = Synthetic::open("reminder-overdue");
    s.core
        .put_reminder(&put(
            "conv-01",
            Some("2026-02-01T00:01:00Z"),
            ReminderCondition::IfNoReply,
            "schedule",
        ))
        .unwrap();
    let Synthetic {
        core, dir, clock, ..
    } = s;
    core.stop();
    drop(core);
    clock.advance_seconds(61);
    let core = open_core_on(dir.path(), new_provider(dir.path()), &clock);
    assert!(until(|| core
        .list_reminders()
        .is_ok_and(|rows| rows[0].phase == ReminderPhase::Returned)));
    let once = core.list_reminders().unwrap();
    assert_eq!(once[0].revision, 2);
    assert!(in_inbox(&core, "conv-01"));
    core.stop();
    drop(core);
    // A second restart changes nothing: the due reminder is not replayed.
    let provider = new_provider(dir.path());
    let core = open_core_on(dir.path(), provider.clone(), &clock);
    core.wait_for_test_idle(mail_core::testing::TIMEOUT)
        .unwrap();
    assert_eq!(core.list_reminders().unwrap(), once);
    assert_eq!(provider.write_call_count(), 0);
    assert!(core.list_conversations().unwrap().activity.is_empty());
}

/// Legacy: `reply_suppresses_only_conditional_and_self_does_not_qualify`.
#[test]
fn reply_suppresses_only_conditional_and_self_does_not_qualify() {
    for (condition, sender, phase) in [
        (
            ReminderCondition::IfNoReply,
            "other@example.test",
            ReminderPhase::Suppressed,
        ),
        (
            ReminderCondition::Regardless,
            "other@example.test",
            ReminderPhase::Returned,
        ),
        (
            ReminderCondition::IfNoReply,
            mail_core::FIXTURE_MAILBOX,
            ReminderPhase::Returned,
        ),
    ] {
        let s = Synthetic::open_wrapped("reminder-reply", Overlay::wrap);
        s.core
            .put_reminder(&put(
                "conv-01",
                Some("2026-02-01T00:01:00Z"),
                condition,
                "schedule",
            ))
            .unwrap();
        s.provider.deliver(
            "conv-01",
            mail_core::testing::message("m-new", sender, "2026-02-01T00:00:30Z", "new plain text"),
        );
        advance_and_observe(&s, 61);
        assert!(phase_reaches(&s, phase), "{condition:?} from {sender}");
        assert!(in_inbox(&s.core, "conv-01"));
        assert!(s.provider.writes().is_empty());
    }
}

/// Legacy: `someday_never_fires_and_cancellation_orders_after_inflight_removal`.
#[test]
fn someday_never_fires_and_cancel_is_a_replayable_one_shot() {
    let s = Synthetic::open("reminder-someday");
    let scheduled = s
        .core
        .put_reminder(&put(
            "conv-01",
            None,
            ReminderCondition::IfNoReply,
            "schedule",
        ))
        .unwrap();
    advance_and_observe(&s, 1_000_000);
    assert_eq!(
        only(&s).phase,
        ReminderPhase::Pending,
        "someday never fires"
    );
    assert!(!in_inbox(&s.core, "conv-01"));
    let cancel = CancelReminder {
        conversation: conversation("conv-01"),
        expected_revision: scheduled.revision,
        request_id: "cancel".into(),
    };
    let receipt = s.core.cancel_reminder(&cancel).unwrap();
    assert_eq!(receipt.phase, ReminderPhase::Cancelled);
    assert_eq!(s.core.cancel_reminder(&cancel).unwrap(), receipt, "replay");
    assert!(
        in_inbox(&s.core, "conv-01"),
        "cancel returns it to the Inbox"
    );
    // A stale revision never cancels.
    assert!(s
        .core
        .cancel_reminder(&CancelReminder {
            expected_revision: 99,
            request_id: "stale".into(),
            ..cancel
        })
        .is_err());
}

/// Legacy: `reschedule_cancel_fire_cas_failure_and_superseding_triage`.
#[test]
fn reschedule_cancel_fire_cas_failures_fail_closed() {
    let s = Synthetic::open("reminder-cas");
    let first_cmd = put(
        "conv-01",
        Some("2026-02-01T00:01:00Z"),
        ReminderCondition::Regardless,
        "schedule",
    );
    let first = s.core.put_reminder(&first_cmd).unwrap();
    let mut reschedule = first_cmd.clone();
    reschedule.expected_revision = Some(first.revision);
    reschedule.request_id = "reschedule".into();
    reschedule.due_at = Some("2026-02-01T00:02:00Z".into());
    let moved = s.core.put_reminder(&reschedule).unwrap();
    assert_eq!(moved.revision, first.revision + 1);
    advance_and_observe(&s, 61);
    assert_eq!(
        only(&s).phase,
        ReminderPhase::Pending,
        "the old deadline no longer fires"
    );
    assert!(s
        .core
        .cancel_reminder(&CancelReminder {
            conversation: conversation("conv-01"),
            expected_revision: first.revision,
            request_id: "stale-cancel".into(),
        })
        .is_err());
    advance_and_observe(&s, 60);
    assert!(phase_reaches(&s, ReminderPhase::Returned));
    // A late reschedule of the fired revision is refused...
    let mut late = reschedule.clone();
    late.request_id = "late-reschedule".into();
    late.expected_revision = Some(moved.revision);
    late.due_at = Some("2026-02-01T00:05:00Z".into());
    assert!(s.core.put_reminder(&late).is_err());
    // ...and a fresh schedule after it fired is a new revision.
    let mut again = first_cmd.clone();
    again.request_id = "again".into();
    again.due_at = Some("2026-02-01T00:05:00Z".into());
    let next = s.core.put_reminder(&again).unwrap();
    assert!(next.revision > moved.revision);
    assert_eq!(next.phase, ReminderPhase::Pending);
}

/// Legacy: `source_account_time_and_persistence_fail_closed_and_undo_slot_survives`.
#[test]
fn source_account_time_and_persistence_fail_closed_and_undo_slot_survives() {
    let s = Synthetic::open("reminder-fail-closed");
    let good = put(
        "conv-01",
        Some("2026-02-01T00:01:00Z"),
        ReminderCondition::IfNoReply,
        "schedule",
    );
    for due in [
        "2026-11-03T01:30:00",
        "2026-03-29T02:30:00",
        "yesterday",
        "2026-01-01T00:00:00Z",
        "2026-02-01T00:01:60Z",
    ] {
        let mut bad = good.clone();
        bad.due_at = Some(due.into());
        assert!(
            matches!(s.core.put_reminder(&bad), Err(MailError::InvalidRequest { field }) if field == "dueAt"),
            "{due}"
        );
    }
    let mut foreign = good.clone();
    foreign.conversation.account_id = "foreign".into();
    assert_eq!(s.core.put_reminder(&foreign), Err(MailError::NotFound));
    let mut stale = good.clone();
    stale.source_message_id = "stale".into();
    assert!(s.core.put_reminder(&stale).is_err());
    assert!(s.core.list_reminders().unwrap().is_empty());
    // Explicit offsets are the only unambiguous local times (DST-safe).
    let mut offset = good.clone();
    offset.due_at = Some("2026-03-29T03:30:00+02:00".into());
    offset.request_id = "offset".into();
    assert!(s.core.put_reminder(&offset).is_ok());
    s.core
        .cancel_reminder(&CancelReminder {
            conversation: conversation("conv-01"),
            expected_revision: 1,
            request_id: "cancel-offset".into(),
        })
        .unwrap();

    // A reminder never consumes the undo slot of an ordinary action.
    let action = s
        .core
        .set_archived(&SetArchived {
            conversation: conversation("conv-02"),
            archived: true,
            request_id: "ordinary".into(),
        })
        .unwrap();
    assert!(wait_for_status(
        &s.core,
        std::slice::from_ref(&action.operation_id),
        OperationStatus::Confirmed
    ));
    let mut other = good.clone();
    other.conversation = conversation("conv-03");
    other.source_message_id = latest_message("conv-03");
    other.request_id = "other".into();
    s.core.put_reminder(&other).unwrap();
    s.core
        .undo_operation(&UndoOperation {
            operation_id: action.operation_id,
            request_id: "ordinary-undo".into(),
        })
        .expect("the reminder did not supersede the undo slot");

    // Storage failure is typed and leaves nothing behind (then a restart).
    let db = gmail_db(s.dir.path());
    db.execute_batch(
        "CREATE TRIGGER inject_reminder_failure BEFORE INSERT ON gmail_reminders
         BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    )
    .unwrap();
    let mut doomed = good.clone();
    doomed.conversation = conversation("conv-04");
    doomed.source_message_id = latest_message("conv-04");
    doomed.request_id = "doomed".into();
    assert_eq!(
        s.core.put_reminder(&doomed),
        Err(MailError::StorageUnavailable)
    );
    db.execute_batch("DROP TRIGGER inject_reminder_failure")
        .unwrap();
    let rows = s.core.list_reminders().unwrap();
    assert!(rows
        .iter()
        .all(|r| r.conversation.conversation_id != "conv-04"));
}

/// Legacy: `concurrent_cancel_and_reschedule_have_only_one_revision_winner_and_dst_offsets_are_explicit`.
#[test]
fn concurrent_cancel_and_reschedule_have_exactly_one_revision_winner() {
    for index in 1..=5 {
        let id = format!("conv-{index:02}");
        let s = Synthetic::open("reminder-race");
        let scheduled = s
            .core
            .put_reminder(&put(
                &id,
                Some("2026-02-01T01:00:00Z"),
                ReminderCondition::Regardless,
                "schedule",
            ))
            .unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let cancel = {
            let (core, barrier, id) = (s.core.clone(), barrier.clone(), id.clone());
            std::thread::spawn(move || {
                barrier.wait();
                core.cancel_reminder(&CancelReminder {
                    conversation: conversation(&id),
                    expected_revision: scheduled.revision,
                    request_id: "cancel".into(),
                })
            })
        };
        let reschedule = {
            let (core, barrier, id) = (s.core.clone(), barrier.clone(), id.clone());
            let mut command = put(
                &id,
                Some("2026-02-01T02:00:00Z"),
                ReminderCondition::Regardless,
                "reschedule",
            );
            command.expected_revision = Some(scheduled.revision);
            std::thread::spawn(move || {
                barrier.wait();
                core.put_reminder(&command)
            })
        };
        let results = (
            cancel.join().unwrap().is_ok(),
            reschedule.join().unwrap().is_ok(),
        );
        assert!(results.0 ^ results.1, "exactly one winner, got {results:?}");
        let row = only(&s);
        assert_eq!(row.revision, scheduled.revision + 1);
        assert_eq!(
            row.phase,
            if results.0 {
                ReminderPhase::Cancelled
            } else {
                ReminderPhase::Pending
            }
        );
    }
}

/// Legacy (triage half of `reschedule_cancel_fire_cas_failure_and_superseding_triage`).
/// Under the local rules ordinary triage on a conversation a reminder hides is
/// accepted as the newer intent: the archive is a real operation, the reminder
/// still resolves at its deadline, and returning it never resurrects mail the
/// user archived since.
#[test]
fn newer_triage_wins_and_the_returned_reminder_does_not_resurrect_the_conversation() {
    let s = Synthetic::open("reminder-triage");
    s.core
        .put_reminder(&put(
            "conv-01",
            Some("2026-02-01T00:01:00Z"),
            ReminderCondition::Regardless,
            "schedule",
        ))
        .unwrap();
    let triage = s
        .core
        .set_archived(&set_archived("conv-01", true, "new-triage"))
        .expect("triage of a hidden conversation is accepted");
    assert!(wait_for_status(
        &s.core,
        std::slice::from_ref(&triage.operation_id),
        OperationStatus::Confirmed
    ));
    assert_eq!(
        s.synthetic.write_call_count(),
        1,
        "only the user's archive is written"
    );
    advance_and_observe(&s, 61);
    assert!(phase_reaches(&s, ReminderPhase::Returned));
    assert!(
        !in_inbox(&s.core, "conv-01"),
        "the newer triage is not undone by the reminder"
    );
    assert_eq!(
        s.synthetic.write_call_count(),
        1,
        "returning writes nothing"
    );
}
