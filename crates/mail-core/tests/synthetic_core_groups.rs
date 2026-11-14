//! Fixture group/undo and reader guarantees ported to `GmailCore` on the
//! built-in synthetic provider (ADR 0002 appendix: `store.rs`, `lib.rs`).

use std::sync::Arc;

use mail_core::dto::OperationStatus;
use mail_core::groups::{
    GetOperationGroupRequest, GroupMemberRejection, GroupMemberStatus, GroupMemberUndoDecision,
    SetArchivedGroup, UndoOperationGroup,
};
use mail_core::testing::synthetic::*;
use mail_core::testing::TIMEOUT;
use mail_core::{MailError, ACCOUNT_ID};

fn group_rows(dir: &std::path::Path) -> (i64, i64) {
    let db = gmail_db(dir);
    let count = |table: &str| -> i64 {
        db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    };
    (count("gmail_operations"), count("gmail_operation_groups"))
}

/// Legacy: `invalid_group_commands_write_nothing`.
#[test]
fn invalid_group_commands_write_nothing() {
    let s = Synthetic::open_operations_paused("group-invalid");
    let invalid = |field: &str| MailError::InvalidRequest {
        field: field.into(),
    };
    assert_eq!(
        s.core
            .set_archived_group(&archive_group("bad-empty", &[], true)),
        Err(invalid("members"))
    );
    let oversized: Vec<String> = (0..101)
        .map(|i| format!("conv-{:02}", i % 18 + 1))
        .collect();
    let refs: Vec<&str> = oversized.iter().map(String::as_str).collect();
    assert_eq!(
        s.core
            .set_archived_group(&archive_group("bad-bound", &refs, true)),
        Err(invalid("members"))
    );
    assert_eq!(
        s.core
            .set_archived_group(&archive_group("bad-dup", &["conv-01", "conv-01"], true)),
        Err(invalid("members"))
    );
    let mut cross = archive_group("bad-cross", &["conv-01", "conv-02"], true);
    cross.members[1].account_id = "other-account".into();
    assert_eq!(s.core.set_archived_group(&cross), Err(invalid("members")));
    let mut foreign = archive_group("bad-account", &["conv-01"], true);
    foreign.account_id = "other-account".into();
    foreign.members[0].account_id = "other-account".into();
    assert_eq!(
        s.core.set_archived_group(&foreign),
        Err(MailError::NotFound)
    );
    assert_eq!(
        s.core
            .set_archived_group(&archive_group("  ", &["conv-01"], true)),
        Err(invalid("requestId"))
    );
    assert_eq!(group_rows(s.dir.path()), (0, 0), "no group or child writes");
    assert_eq!(s.synthetic.write_call_count(), 0);
}

/// Legacy: `member_rejection_is_persisted_and_siblings_accepted_without_undo_slot_loss`.
#[test]
fn member_rejection_is_persisted_and_siblings_accepted_without_undo_slot_loss() {
    // All-rejected: a receipt exists, no children, the undo slot is kept.
    let s = Synthetic::open_operations_paused("group-all-rejected");
    s.core
        .set_archived(&set_archived("conv-05", true, "single-req-1"))
        .unwrap();
    let receipt = s
        .core
        .set_archived_group(&archive_group("group-req-x", &["missing-conv"], true))
        .expect("an all-rejected request still commits a receipt");
    assert_eq!(receipt.members.len(), 1);
    assert_eq!(receipt.members[0].operation_id, None);
    assert_eq!(
        receipt.members[0].rejection,
        Some(GroupMemberRejection::ConversationMissing)
    );
    assert_eq!(group_rows(s.dir.path()), (1, 1), "receipt, zero children");
    assert_eq!(
        s.core
            .set_archived_group(&archive_group("group-req-x", &["missing-conv"], true))
            .unwrap(),
        receipt,
        "idempotent replay"
    );
    let activity = s.core.list_conversations().unwrap().activity;
    let single = activity.iter().find(|row| row.undo_of.is_none()).unwrap();
    assert!(single.undoable_until.is_some(), "undo slot not consumed");

    // Mixed: the rejected member keeps its ordinal next to accepted siblings.
    let s = Synthetic::open_operations_paused("group-mixed-rejection");
    let receipt = s
        .core
        .set_archived_group(&archive_group(
            "group-req-mixed",
            &["conv-01", "missing-conv", "conv-03"],
            true,
        ))
        .unwrap();
    assert_eq!(
        receipt.members[1].rejection,
        Some(GroupMemberRejection::ConversationMissing)
    );
    assert!(receipt.members[0].operation_id.is_some());
    assert!(receipt.members[2].operation_id.is_some());
    assert_eq!(
        receipt.members[1].conversation.conversation_id,
        "missing-conv"
    );
    let status = s
        .core
        .get_operation_group(&GetOperationGroupRequest {
            account_id: ACCOUNT_ID.into(),
            request_id: "group-req-mixed".into(),
        })
        .unwrap()
        .expect("committed");
    assert_eq!(status.members[1].status, GroupMemberStatus::Rejected);
    assert_eq!(status.members[0].status, GroupMemberStatus::Queued);
    assert!(status.undo.available);
    assert_eq!(group_rows(s.dir.path()), (2, 1));
}

/// Legacy: `mid_transaction_failure_after_staged_member_rolls_back_whole_group`.
#[test]
fn mid_transaction_failure_after_staged_member_rolls_back_whole_group() {
    let s = Synthetic::open_operations_paused("group-mid-tx-failure");
    let db = gmail_db(s.dir.path());
    db.execute_batch(
        "CREATE TRIGGER inject_member_failure BEFORE INSERT ON gmail_operations
         WHEN NEW.conversation_id = 'conv-02'
         BEGIN SELECT RAISE(ABORT, 'injected mid-group failure'); END;",
    )
    .unwrap();
    let command = archive_group("group-req-mid", &["conv-01", "conv-02", "conv-03"], true);
    assert_eq!(
        s.core.set_archived_group(&command),
        Err(MailError::StorageUnavailable),
        "the aborted member insert surfaces as a storage failure"
    );
    db.execute_batch("DROP TRIGGER inject_member_failure")
        .unwrap();
    assert_eq!(
        group_rows(s.dir.path()),
        (0, 0),
        "no partial group/children"
    );
    let keys: i64 = db
        .query_row("SELECT COUNT(*) FROM gmail_operation_requests", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(keys, 0, "no request key survives the rollback");
    // The core latched its worker halt on the storage failure (existing Gmail
    // behaviour); a restart recovers, and the same request then commits once.
    let s = s.reopen();
    let receipt = s.core.set_archived_group(&command).expect("retried safely");
    assert_eq!(receipt.members.len(), 3);
    assert_eq!(group_rows(s.dir.path()), (3, 1));
}

/// Legacy: `new_reply_after_acceptance_is_untouched_by_group_undo`.
#[test]
fn new_reply_after_acceptance_is_untouched_by_group_undo() {
    let s = Synthetic::open_wrapped("group-new-reply", Overlay::wrap);
    let receipt = s
        .core
        .set_archived_group(&archive_group("group-req-reply", &["conv-01"], true))
        .unwrap();
    let child = receipt.members[0].operation_id.clone().unwrap();
    assert!(wait_for_status(
        &s.core,
        std::slice::from_ref(&child),
        OperationStatus::Confirmed
    ));
    // A new message arrives in conv-01 after acceptance and confirmation.
    s.provider.deliver(
        "conv-01",
        mail_core::testing::message(
            "m-new-reply",
            "new@example.test",
            "2026-01-14T00:00:00Z",
            "later reply",
        ),
    );
    mail_core::testing::request_sync_when_idle(&s.core);
    assert!(mail_core::testing::until(|| s
        .core
        .get_conversation(&conversation("conv-01"))
        .unwrap()
        .messages
        .iter()
        .any(|m| m.id == "m-new-reply")));
    let undo = s
        .core
        .undo_operation_group(&UndoOperationGroup {
            group_id: receipt.group_id.clone(),
            request_id: "undo-reply".into(),
        })
        .expect("group undo");
    assert_eq!(
        undo.members[0].decision,
        GroupMemberUndoDecision::Compensating
    );
    let compensation = undo.members[0].operation_ids[0].clone();
    let targets: String = gmail_db(s.dir.path())
        .query_row(
            "SELECT group_concat(message_id) FROM gmail_operation_targets WHERE operation_id = ?1",
            [&compensation],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        !targets.contains("m-new-reply"),
        "targets come from acceptance"
    );
    assert!(targets.contains("m-01-1"));
}

/// Legacy: `worker_claims_and_group_undo_interleave_without_deadlock_or_duplicates`.
#[test]
fn worker_claims_and_group_undo_interleave_without_deadlock_or_duplicates() {
    let s = Synthetic::open_operations_paused("group-claim-race");
    let receipt = s
        .core
        .set_archived_group(&archive_group(
            "group-req-race",
            &["conv-01", "conv-02", "conv-03"],
            true,
        ))
        .unwrap();
    let group_id = receipt.group_id.clone();
    let core = s.core.clone();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let undo_barrier = Arc::clone(&barrier);
    let undoer = std::thread::spawn(move || {
        undo_barrier.wait();
        core.undo_operation_group(&UndoOperationGroup {
            group_id,
            request_id: "undo-group-race".into(),
        })
    });
    // The worker claims the queued members while the undo runs.
    barrier.wait();
    s.core.release_test_operations();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(undoer.join().expect("undoer does not panic"));
    });
    let undo = rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .expect("claim/undo interleave must not deadlock")
        .expect("group undo succeeds under concurrent claims");
    s.core.wait_for_test_idle(TIMEOUT).unwrap();
    assert_eq!(undo.members.len(), 3);
    let ids: Vec<&String> = undo.members.iter().flat_map(|m| &m.operation_ids).collect();
    let unique: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len(), "no duplicate compensations");
    let db = gmail_db(s.dir.path());
    for member in &undo.members {
        let child: String = db
            .query_row(
                "SELECT operation_id FROM gmail_operation_group_members
                 WHERE group_id = ?1 AND ordinal = ?2",
                rusqlite::params![undo.group_id, member.ordinal],
                |r| r.get(0),
            )
            .unwrap();
        match &member.decision {
            GroupMemberUndoDecision::Cancelled => {
                let status: String = db
                    .query_row(
                        "SELECT status FROM gmail_operations WHERE operation_id = ?1",
                        [&child],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(status, "cancelled");
                assert!(member.operation_ids.is_empty());
            }
            GroupMemberUndoDecision::Compensating => {
                for compensation in &member.operation_ids {
                    let undo_of: String = db
                        .query_row(
                            "SELECT undo_of FROM gmail_operations WHERE operation_id = ?1",
                            [compensation],
                            |r| r.get(0),
                        )
                        .unwrap();
                    assert_eq!(undo_of, child, "compensation points at its own member");
                }
            }
            GroupMemberUndoDecision::Skipped { .. } => {
                assert!(member.operation_ids.is_empty());
                let compensated: bool = db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM gmail_operations WHERE undo_of = ?1)",
                        [&child],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert!(!compensated, "skipped members are never compensated");
            }
        }
    }
    // Whatever interleaving happened, the mailbox converges to the restored
    // state: nothing archived remains (cancelled or compensated).
    for id in ["conv-01", "conv-02", "conv-03"] {
        assert!(
            mail_core::testing::until(|| in_inbox(&s.core, id)),
            "{id} restored"
        );
    }
}

/// Legacy: `group_children_execute_serially_and_group_undo_compensates`.
#[test]
fn group_children_execute_serially_and_group_undo_compensates() {
    let s = Synthetic::open_wrapped("group-serial", Overlay::wrap);
    let request = archive_group("core-group-1", &["conv-01", "conv-02"], true);
    let receipt = s.core.set_archived_group(&request).unwrap();
    let reordered = SetArchivedGroup {
        members: request.members.iter().rev().cloned().collect(),
        ..request.clone()
    };
    assert!(
        s.core.set_archived_group(&reordered).is_ok(),
        "reordered replay is the same request"
    );
    let children: Vec<String> = receipt
        .members
        .iter()
        .map(|m| m.operation_id.clone().unwrap())
        .collect();
    assert!(wait_for_status(
        &s.core,
        &children,
        OperationStatus::Confirmed
    ));
    let writes = s.provider.writes();
    assert_eq!(writes.len(), 2, "one provider write per member, serially");
    assert!(writes[0].2.iter().all(|id| id.starts_with("m-01-")));
    assert!(writes[1].2.iter().all(|id| id.starts_with("m-02-")));
    let status = s
        .core
        .get_operation_group(&GetOperationGroupRequest {
            account_id: ACCOUNT_ID.into(),
            request_id: "core-group-1".into(),
        })
        .unwrap()
        .unwrap();
    assert!(status
        .members
        .iter()
        .all(|m| m.status == GroupMemberStatus::Confirmed));
    assert!(status.undo.available, "inside the 10 s window");

    let undo = s
        .core
        .undo_operation_group(&UndoOperationGroup {
            group_id: receipt.group_id.clone(),
            request_id: "core-undo-group-1".into(),
        })
        .unwrap();
    assert!(undo
        .members
        .iter()
        .all(|m| m.decision == GroupMemberUndoDecision::Compensating));
    let compensations: Vec<String> = undo
        .members
        .iter()
        .flat_map(|m| m.operation_ids.clone())
        .collect();
    assert_eq!(compensations.len(), 2);
    assert!(wait_for_status(
        &s.core,
        &compensations,
        OperationStatus::Confirmed
    ));
    assert!(in_inbox(&s.core, "conv-01") && in_inbox(&s.core, "conv-02"));

    // Restart: the group, member outcomes and receipt replay survive.
    let Synthetic {
        core, dir, clock, ..
    } = s;
    core.stop();
    drop(core);
    let reopened = open_core_on(dir.path(), new_provider(dir.path()), &clock);
    assert_eq!(reopened.set_archived_group(&request).unwrap(), receipt);
    let status = reopened
        .get_operation_group(&GetOperationGroupRequest {
            account_id: ACCOUNT_ID.into(),
            request_id: "core-group-1".into(),
        })
        .unwrap()
        .unwrap();
    assert_eq!(
        status.undo.reason,
        Some(mail_core::dto::UndoUnavailableReason::AlreadyUndone)
    );
}

/// Legacy: `fixture_reader_has_safe_synthetic_reply_context_without_reseeding`.
#[test]
fn reader_has_safe_synthetic_reply_context_without_reseeding() {
    let s = Synthetic::open("reply-context");
    let check = |core: &mail_core::gmail::sync::GmailCore| {
        let conversation = core.get_conversation(&conversation("conv-01")).unwrap();
        let context = conversation.reply_context.expect("synthetic reply context");
        assert_eq!(context.source_message_id, "m-01-3");
        assert_eq!(context.from_mailbox, "ana@ridpath.example");
        assert_eq!(context.reply_to_mailboxes, None);
        assert_eq!(context.message_id, "<conv-01.m-01-3@fixture.emailos>");
        assert_eq!(
            context.references,
            vec![
                "<conv-01.m-01-1@fixture.emailos>",
                "<conv-01.m-01-2@fixture.emailos>"
            ]
        );
        assert_eq!(conversation.context_complete, Some(true));
        assert!(conversation
            .messages
            .iter()
            .any(|m| m.to.iter().any(|r| r.mailbox == mail_core::FIXTURE_MAILBOX)));
    };
    check(&s.core);
    // Served from the cache without any provider read.
    let source = s
        .core
        .load_reply_context(&conversation("conv-01"), "m-01-3")
        .expect("cached reply context loads without network");
    assert_eq!(source.reply_context.unwrap().source_message_id, "m-01-3");
    let s = s.reopen();
    check(&s.core);
}

/// Legacy: `fresh_v4_seed_marks_first_message_attachment_fact`.
#[test]
fn fresh_seed_marks_first_message_attachment_fact() {
    let s = Synthetic::open("attachment-fact");
    let snapshot = s.core.list_conversations().unwrap();
    assert!(!snapshot.conversations.is_empty());
    for row in &snapshot.conversations {
        assert_eq!(
            row.has_attachments,
            Some(true),
            "first message carries the synthetic attachment"
        );
    }
    let conversation_view = s.core.get_conversation(&conversation("conv-01")).unwrap();
    assert_eq!(conversation_view.messages[0].has_attachment, Some(true));
    assert_eq!(conversation_view.messages[1].has_attachment, None);
    let attachments = s.core.list_attachments(&conversation("conv-01")).unwrap();
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0].message_id, "m-01-1");
    assert_eq!(attachments[0].attachment_id, "fixture-text");
    assert_eq!(attachments[0].filename, "example.txt");
    assert_eq!(attachments[0].mime_type, "text/plain");
    assert_eq!(
        attachments[0].size as usize,
        mail_core::synthetic::SYNTHETIC_ATTACHMENT_BYTES.len()
    );
}
