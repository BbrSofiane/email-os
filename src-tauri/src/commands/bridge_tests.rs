//! Native bridge tests for the opt-in synthetic core (ADR 0002 stage 3): the
//! same core methods the Tauri commands call, on a synthetic session.

use crate::test_support::{conv, open};
use mail_core::attachments::SaveAttachment;
use mail_core::drafts::types::DraftRef;
use mail_core::drafts::{load_validated_reply_context, require_draft_account, DraftLifecycle};
use mail_core::dto::{
    CachedDoneRequest, CachedTrashRequest, ConversationRef, RetryOperation, SetArchived, SetRead,
};
use mail_core::error::MailError;
use mail_core::gmail::browsing::DestinationRequest;
use mail_core::gmail::sync::GmailCore;
use mail_core::gmail::types::{ConnectionState, MailMode};
use mail_core::reminders::PutReminder;
use mail_core::synthetic::WriteControls;
use mail_core::testing::temp_profile as temp_dir;
use mail_core::testing::{temp_profile, until, TIMEOUT};
use mail_core::CancelToken;
use mail_core::ACCOUNT_ID;
use std::sync::mpsc;

fn mode_error() -> MailError {
    MailError::InvalidRequest {
        field: "mode".to_owned(),
    }
}

#[test]
fn status_is_explicit_and_mutations_need_no_google_grant() {
    let dir = temp_profile("synthetic-status");
    let core = open(dir.path(), WriteControls::default());
    let status = core.account_status().unwrap();
    assert_eq!(status.mode, MailMode::Fixture);
    assert_eq!(status.connection, ConnectionState::Connected);
    assert_eq!(status.mutation_access, None);
    assert_eq!(status.sync.coverage_limit, 0);
    assert_eq!(status.sync.cached_conversations, 24);
    let account = core.active_account().unwrap();
    assert_eq!(account.account_id, ACCOUNT_ID);
    assert_eq!(account.email_address, mail_core::FIXTURE_MAILBOX);
    core.stop();
}

#[test]
fn rejects_lifecycle_trash_and_destinations_with_todays_variants_and_admits_read_and_star() {
    let dir = temp_profile("synthetic-rejects");
    let core = open(dir.path(), WriteControls::default());
    assert_eq!(core.connect_account(), Err(mode_error()));
    assert_eq!(core.disconnect_account(), Err(mode_error()));
    assert_eq!(core.request_sync(), Err(mode_error()));
    assert_eq!(core.enable_mutations(), Err(mode_error()));
    assert_eq!(core.cancel_mutation_upgrade(), Err(mode_error()));
    assert_eq!(
        core.list_cached_trash(&CachedTrashRequest {
            account_id: ACCOUNT_ID.into(),
            limit: 50,
            cursor: None,
        }),
        Err(mode_error())
    );
    assert_eq!(
        core.list_provider_destinations(ACCOUNT_ID, false),
        Err(MailError::ReadOnly)
    );
    assert_eq!(
        core.browse_provider_destination(&DestinationRequest {
            account_id: ACCOUNT_ID.into(),
            destination_id: "SENT".into(),
            cursor: None,
            cached: false,
        }),
        Err(MailError::ReadOnly)
    );
    // Nothing local was erased by the rejected lifecycle commands.
    assert_eq!(core.account_status().unwrap().sync.cached_conversations, 24);
    // Decision 2: read, star and retry are admitted.
    let read = core
        .set_read(&SetRead {
            conversation: conv("conv-02"),
            read: true,
            request_id: "bridge-read".into(),
        })
        .unwrap();
    let star = core
        .set_starred(&mail_core::stars::SetStarred {
            conversation: conv("conv-03"),
            starred: true,
            request_id: "bridge-star".into(),
        })
        .unwrap();
    assert!(until(|| {
        let snapshot = core.list_conversations().unwrap();
        [&read.operation_id, &star.operation_id].iter().all(|id| {
            snapshot
                .activity
                .iter()
                .any(|op| &op.id == *id && op.status == mail_core::dto::OperationStatus::Confirmed)
        })
    }));
    let starred = core
        .list_cached_starred(&CachedDoneRequest {
            account_id: ACCOUNT_ID.into(),
            limit: 100,
            cursor: None,
        })
        .unwrap();
    assert_eq!(starred.conversations.len(), 1);
    assert_eq!(
        core.retry_operation(&RetryOperation {
            operation_id: "unknown-operation".into(),
            request_id: "bridge-retry".into(),
        }),
        Err(MailError::NotFound)
    );
    core.stop();
}

#[test]
fn reminder_bridge_preserves_exact_source_and_account_gate() {
    let dir = temp_profile("synthetic-reminders");
    let core = open(dir.path(), WriteControls::default());
    let detail = core.get_conversation(&conv("conv-01")).unwrap();
    let mut command = PutReminder {
        conversation: conv("conv-01"),
        source_message_id: detail.messages.last().unwrap().id.clone(),
        due_at: None,
        condition: mail_core::reminders::ReminderCondition::IfNoReply,
        expected_revision: None,
        request_id: "bridge-reminder".into(),
    };
    let receipt = core.put_reminder(&command).unwrap();
    assert_eq!(core.put_reminder(&command).unwrap(), receipt);
    assert_eq!(core.list_reminders().unwrap(), vec![receipt]);
    command.conversation.account_id = "foreign".into();
    assert_eq!(core.put_reminder(&command), Err(MailError::NotFound));
    let mut stale = command.clone();
    stale.conversation = conv("conv-02");
    stale.source_message_id = "not-the-latest".into();
    stale.request_id = "bridge-stale".into();
    assert!(core.put_reminder(&stale).is_err());
    core.stop();
}

#[test]
fn saved_split_bridge_coexists_with_the_star_surface() {
    let dir = temp_profile("synthetic-split");
    let core = open(dir.path(), WriteControls::default());
    let split = mail_core::splits::SavedSplit {
        name: "Clients".into(),
        criterion: mail_core::splits::SplitCriterion::Domain,
        value: "example.test".into(),
        enabled: true,
        hide_when_empty: false,
    };
    assert_eq!(core.get_saved_split(ACCOUNT_ID).unwrap(), None);
    assert_eq!(core.save_saved_split(ACCOUNT_ID, &split).unwrap(), split);
    assert_eq!(core.get_saved_split(ACCOUNT_ID).unwrap(), Some(split));
    assert_eq!(core.get_saved_split("foreign"), Err(MailError::NotFound));
    assert!(core
        .set_starred(&mail_core::stars::SetStarred {
            conversation: conv("conv-01"),
            starred: true,
            request_id: "split-star".into(),
        })
        .is_ok());
    core.stop();
}

#[test]
fn draft_scope_and_reply_sources_come_from_the_synthetic_account() {
    let dir = temp_profile("synthetic-drafts");
    let core = open(dir.path(), WriteControls::default());
    let account = core.active_account().unwrap();
    assert_eq!(account.account_id, ACCOUNT_ID);
    assert_eq!(
        require_draft_account(
            &account,
            &DraftRef {
                account_id: "untrusted-other-account".into(),
                draft_id: "draft-id".into(),
            }
        ),
        Err(MailError::NotFound)
    );
    // Reply context: complete, latest-source, deterministic headers.
    let detail = core.get_conversation(&conv("conv-02")).unwrap();
    let source = detail.messages.last().unwrap().id.clone();
    let replied = load_validated_reply_context(&core, &conv("conv-02"), &source).unwrap();
    let context = replied.reply_context.unwrap();
    assert_eq!(context.source_message_id, source);
    assert!(context.message_id.ends_with("@fixture.emailos>"));
    assert_eq!(
        load_validated_reply_context(&core, &conv("conv-02"), "an-older-message"),
        Err(MailError::ReplyUnavailable)
    );
    // A session change invalidates reply reads (core-independent).
    let mut lifecycle = DraftLifecycle::default();
    let before = lifecycle.session_epoch();
    assert!(lifecycle.is_current(before));
    lifecycle.advance();
    assert!(!lifecycle.is_current(before));
    assert!(lifecycle.is_current(lifecycle.session_epoch()));
    core.stop();
}

#[test]
fn paused_write_does_not_block_reads_or_shutdown() {
    let dir = temp_profile("synthetic-paused");
    let core = open(
        dir.path(),
        WriteControls {
            paused: true,
            reject_next: false,
        },
    );
    let receipt = core
        .set_archived(&SetArchived {
            conversation: conv("conv-01"),
            archived: true,
            request_id: "paused".into(),
        })
        .unwrap();
    // Reads, status and a second command stay responsive while paused.
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .iter()
        .any(|op| {
            op.id == receipt.operation_id && op.status == mail_core::dto::OperationStatus::Applying
        })));
    core.get_conversation(&conv("conv-02")).unwrap();
    core.account_status().unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let stopper = core.clone();
    std::thread::spawn(move || {
        stopper.stop();
        let _ = done_tx.send(());
    });
    done_rx
        .recv_timeout(TIMEOUT)
        .expect("stop completes while paused");
}

#[test]
fn download_revalidates_exact_targets_and_never_opens_documents() {
    let dir = temp_profile("synthetic-attachment");
    let core = open(dir.path(), WriteControls::default());
    let target = core.list_conversations().unwrap().conversations[0]
        .conversation_ref
        .clone();
    let descriptor = core.list_attachments(&target).unwrap().remove(0);
    assert_eq!(descriptor.attachment_id, "fixture-text");
    assert_eq!(descriptor.filename, "example.txt");
    assert_eq!(descriptor.mime_type, "text/plain");
    let request = SaveAttachment {
        conversation: target,
        message_id: descriptor.message_id,
        attachment_id: descriptor.attachment_id,
        request_id: "r1".into(),
    };
    let downloads = temp_profile("synthetic-downloads");
    let saved = core
        .download_attachment(&request, &CancelToken::default(), downloads.path())
        .unwrap();
    assert_eq!(
        std::fs::read(downloads.path().join(&saved.filename)).unwrap(),
        b"Synthetic attachment only.\n"
    );
    let mut wrong_message = request.clone();
    wrong_message.message_id = "another-message".into();
    assert_eq!(
        core.download_attachment(&wrong_message, &CancelToken::default(), downloads.path()),
        Err(MailError::NotFound)
    );
    let mut wrong_attachment = request.clone();
    wrong_attachment.attachment_id = "another-attachment".into();
    assert_eq!(
        core.download_attachment(&wrong_attachment, &CancelToken::default(), downloads.path()),
        Err(MailError::NotFound)
    );
    let mut foreign = request.clone();
    foreign.conversation.account_id = "foreign".into();
    assert_eq!(
        core.download_attachment(&foreign, &CancelToken::default(), downloads.path()),
        Err(MailError::NotFound)
    );
    let cancelled = CancelToken::default();
    cancelled.cancel();
    assert_eq!(
        core.download_attachment(&request, &cancelled, downloads.path()),
        Err(MailError::AuthCancelled)
    );
    assert_eq!(
        std::fs::read_dir(downloads.path()).unwrap().count(),
        1,
        "only the one download"
    );
    core.stop();
}

#[test]
fn gmail_mutations_require_verified_access() {
    // Construction-level guard, covered without real credentials/network.
    let provider = mail_core::testing::operations_fake::FakeProvider::new(false);
    provider.set_configured(false);
    provider.set_credentials(false);
    let dir = temp_dir("gmail-readonly");
    let gmail = GmailCore::open(dir.path(), provider).unwrap();
    assert!(gmail.list_reminders().unwrap().is_empty());
    let status = gmail.account_status().unwrap();
    assert_eq!(status.mode, MailMode::Gmail);
    assert_eq!(
        status.mutation_access,
        Some(mail_core::gmail::types::MutationAccess::ReadOnly)
    );
    let result = gmail.set_archived(&SetArchived {
        conversation: ConversationRef {
            account_id: "a".into(),
            conversation_id: "c".into(),
        },
        archived: true,
        request_id: "bridge-readonly".into(),
    });
    assert_eq!(result, Err(MailError::PermissionRequired));
    assert_eq!(gmail.enable_mutations(), Err(MailError::NotConfigured));
    assert_eq!(gmail.cancel_mutation_upgrade(), Ok(()));
    assert_eq!(
        gmail.set_read(&SetRead {
            conversation: ConversationRef {
                account_id: "a".into(),
                conversation_id: "c".into(),
            },
            read: true,
            request_id: "bridge-readonly-read".into(),
        }),
        Err(MailError::PermissionRequired)
    );
    assert_eq!(
        gmail.retry_operation(&RetryOperation {
            operation_id: "bridge-operation".into(),
            request_id: "bridge-retry".into(),
        }),
        Err(MailError::PermissionRequired)
    );
    // Undo requires an active account that owns the operation; without
    // credentials the Gmail core has none.
    assert_eq!(
        gmail.undo_operation(&mail_core::dto::UndoOperation {
            operation_id: "bridge-operation".into(),
            request_id: "bridge-undo".into(),
        }),
        Err(MailError::AuthRequired)
    );
    gmail.stop();
    let _ = std::fs::remove_dir_all(dir);
}
