//! Pins the core half of the "Undo returns focus to the restored row" fix: the
//! moment the undo receipt of a CONFIRMED archive returns, `list_conversations`
//! already contains the conversation (same position as before the archive),
//! carrying the compensation as its pending operation. That is the honest
//! pending state; the frontend must not need a later projection change to find
//! the row (docs: PRODUCT.md "honest state over smooth feel").
//!
//! Covered on the synthetic session and on a Gmail-policy core with the shared
//! scripted provider. The compensation is held queued (`pause_test_operations`)
//! so the assertion does not race the worker.

use std::sync::Arc;

use mail_core::clock::{utc, FakeClock};
use mail_core::dto::{ConversationRef, InboxSnapshot, OperationStatus, SetArchived, UndoOperation};
use mail_core::gmail::sync::GmailCore;
use mail_core::testing::operations_fake::FakeProvider;
use mail_core::testing::synthetic::{conversation, set_archived, wait_for_status, Synthetic};
use mail_core::testing::{open_core_with_clock, temp_profile, until, TIMEOUT};

fn ids(snapshot: &InboxSnapshot) -> Vec<String> {
    snapshot
        .conversations
        .iter()
        .map(|c| c.conversation_ref.conversation_id.clone())
        .collect()
}

fn assert_restored_immediately(
    core: &GmailCore,
    target: &ConversationRef,
    undo_of: &str,
    before: &[String],
) {
    let after = core.list_conversations().unwrap();
    assert_eq!(
        ids(&after),
        before,
        "restored row is back in its original position"
    );
    let row = after
        .conversations
        .iter()
        .find(|c| &c.conversation_ref == target)
        .unwrap();
    let compensation = after
        .activity
        .iter()
        .find(|op| op.undo_of.as_deref() == Some(undo_of))
        .expect("the compensating operation is listed");
    assert_eq!(
        compensation.status,
        OperationStatus::Queued,
        "compensation still pending"
    );
    assert_eq!(
        row.pending_operation_id.as_deref(),
        Some(compensation.id.as_str()),
        "the row carries the pending compensation, not a confirmed claim"
    );
}

#[test]
fn synthetic_session_lists_the_restored_row_with_its_compensation_pending() {
    let s = Synthetic::open("undo-restores-synthetic");
    let before = ids(&s.core.list_conversations().unwrap());
    let target = conversation(&before[1]);
    let receipt = s
        .core
        .set_archived(&set_archived(&target.conversation_id, true, "archive"))
        .unwrap();
    assert!(wait_for_status(
        &s.core,
        std::slice::from_ref(&receipt.operation_id),
        OperationStatus::Confirmed
    ));
    assert!(!ids(&s.core.list_conversations().unwrap()).contains(&target.conversation_id));
    s.core.pause_test_operations(TIMEOUT).unwrap();
    s.core
        .undo_operation(&UndoOperation {
            operation_id: receipt.operation_id.clone(),
            request_id: "undo".into(),
        })
        .unwrap();
    assert_restored_immediately(&s.core, &target, &receipt.operation_id, &before);
}

#[test]
fn gmail_policy_core_lists_the_restored_row_with_its_compensation_pending() {
    let dir = temp_profile("undo-restores-gmail");
    let clock = Arc::new(FakeClock::new(utc("2026-02-01T00:00:00Z")));
    let thread = |id: &str, at: &str| {
        let message = format!("m-{id}");
        mail_core::testing::thread(
            "acct-probe",
            id,
            vec![mail_core::testing::message(
                &message,
                "x@example.test",
                at,
                "body",
            )],
            &[message.as_str()],
            Some(vec![message.clone()]),
            "h1",
        )
    };
    let provider = FakeProvider::with_threads(vec![
        thread("c-a", "2026-01-03T00:00:00Z"),
        thread("c-b", "2026-01-02T00:00:00Z"),
        thread("c-c", "2026-01-01T00:00:00Z"),
    ]);
    let core = open_core_with_clock(dir.path(), &provider, &clock);
    assert!(until(|| core
        .account_status()
        .is_ok_and(|status| status.sync.initial_sync_complete)));
    core.wait_for_test_idle(TIMEOUT).unwrap();
    let before = ids(&core.list_conversations().unwrap());
    let target = ConversationRef {
        account_id: "acct-probe".into(),
        conversation_id: before[1].clone(),
    };
    let receipt = core
        .set_archived(&SetArchived {
            conversation: target.clone(),
            archived: true,
            request_id: "archive".into(),
        })
        .unwrap();
    assert!(wait_for_status(
        &core,
        std::slice::from_ref(&receipt.operation_id),
        OperationStatus::Confirmed
    ));
    assert!(!ids(&core.list_conversations().unwrap()).contains(&target.conversation_id));
    core.pause_test_operations(TIMEOUT).unwrap();
    core.undo_operation(&UndoOperation {
        operation_id: receipt.operation_id.clone(),
        request_id: "undo".into(),
    })
    .unwrap();
    assert_restored_immediately(&core, &target, &receipt.operation_id, &before);
}
