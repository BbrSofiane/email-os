//! `DraftService`: draft operations scoped to the active account, with reply
//! revalidation (moved out of the native shell, which now only adapts IPC).
//!
//! The synthetic core supplies the fixture account and its 18 conversations;
//! a Gmail core without credentials supplies "no active account".

use mail_core::drafts::{
    load_validated_reply_context, require_draft_account, validate_reply_conversation, CreateDraft,
    DeleteDraft, DraftContent, DraftCore, DraftRef, DraftService, DraftSource, SaveDraft,
};
use mail_core::dto::ConversationRef;
use mail_core::gmail::sync::GmailCore;
use mail_core::gmail::types::{AccountInfo, MailMode};
use mail_core::testing::operations_fake::FakeProvider;
use mail_core::testing::synthetic::{conversation, Synthetic};
use mail_core::testing::temp_profile;
use mail_core::{MailError, ACCOUNT_ID, FIXTURE_MAILBOX};

fn content(subject: &str) -> DraftContent {
    DraftContent {
        to: "someone@example.test".into(),
        cc: String::new(),
        subject: subject.into(),
        body_text: "body".into(),
    }
}

fn new_message(key: &str) -> CreateDraft {
    CreateDraft {
        request_id: key.into(),
        source: DraftSource::NewMessage,
        initial_content: Some(content("Hello")),
    }
}

fn reply(key: &str, conversation: ConversationRef, source_message_id: &str) -> CreateDraft {
    CreateDraft {
        request_id: key.into(),
        source: DraftSource::Reply {
            conversation,
            source_message_id: source_message_id.into(),
        },
        initial_content: None,
    }
}

struct Fixture {
    s: Synthetic,
    drafts: DraftService,
}

fn fixture(tag: &str) -> Fixture {
    let s = Synthetic::open(tag);
    let store = DraftCore::open(s.dir.path().join("local-drafts")).unwrap();
    let drafts = DraftService::new(s.core.clone(), store);
    Fixture { s, drafts }
}

fn latest_message_id(core: &GmailCore, id: &str) -> String {
    core.get_conversation(&conversation(id))
        .unwrap()
        .messages
        .last()
        .unwrap()
        .id
        .clone()
}

/// A core on a Gmail session with no credentials: there is no active account.
fn signed_out(tag: &str) -> (tempfile::TempDir, GmailCore, DraftService) {
    let provider = FakeProvider::new(false);
    provider.set_configured(false);
    provider.set_credentials(false);
    let dir = temp_profile(tag);
    let core = GmailCore::open(dir.path().join("gmail-profile"), provider).unwrap();
    let store = DraftCore::open(dir.path().join("local-drafts")).unwrap();
    let drafts = DraftService::new(core.clone(), store);
    (dir, core, drafts)
}

#[test]
fn active_account_is_the_connected_account_or_auth_required() {
    let f = fixture("draft-service-account");
    let account = f.s.core.active_account().unwrap();
    assert_eq!(account.account_id, ACCOUNT_ID);
    assert_eq!(account.email_address, FIXTURE_MAILBOX);
    assert_eq!(f.s.core.account_status().unwrap().mode, MailMode::Fixture);

    let (_dir, core, _) = signed_out("draft-service-signed-out");
    assert_eq!(core.active_account(), Err(MailError::AuthRequired));
    core.stop();
    f.s.core.stop();
}

#[test]
fn without_an_active_account_every_draft_operation_is_auth_required() {
    let (_dir, core, drafts) = signed_out("draft-service-no-account");
    let own = DraftRef {
        account_id: "acct".into(),
        draft_id: "d".into(),
    };
    assert_eq!(drafts.list_drafts(), Err(MailError::AuthRequired));
    assert_eq!(drafts.get_draft(&own), Err(MailError::AuthRequired));
    assert_eq!(
        drafts.create_draft(&new_message("k")),
        Err(MailError::AuthRequired)
    );
    assert_eq!(
        drafts.save_draft(&SaveDraft {
            draft_ref: own.clone(),
            expected_revision: 1,
            request_id: "s".into(),
            content: content("x"),
        }),
        Err(MailError::AuthRequired)
    );
    assert_eq!(
        drafts.delete_draft(&DeleteDraft {
            draft_ref: own,
            expected_revision: 1,
            request_id: "x".into(),
        }),
        Err(MailError::AuthRequired)
    );
    core.stop();
}

#[test]
fn drafts_are_created_read_saved_and_deleted_under_the_active_account() {
    let f = fixture("draft-service-crud");
    let created = f.drafts.create_draft(&new_message("create-1")).unwrap();
    assert_eq!(created.draft_ref.account_id, ACCOUNT_ID);
    // The same request key is answered from its receipt, not created twice.
    assert_eq!(
        f.drafts.create_draft(&new_message("create-1")).unwrap(),
        created
    );
    let listed = f.drafts.list_drafts().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].draft_ref, created.draft_ref);

    let saved = f
        .drafts
        .save_draft(&SaveDraft {
            draft_ref: created.draft_ref.clone(),
            expected_revision: created.revision,
            request_id: "save-1".into(),
            content: content("Edited"),
        })
        .unwrap();
    let draft = f.drafts.get_draft(&saved.draft_ref).unwrap();
    assert_eq!(draft.content.subject, "Edited");
    assert_eq!(draft.revision, saved.revision);

    f.drafts
        .delete_draft(&DeleteDraft {
            draft_ref: saved.draft_ref.clone(),
            expected_revision: saved.revision,
            request_id: "delete-1".into(),
        })
        .unwrap();
    assert!(f.drafts.list_drafts().unwrap().is_empty());
    assert_eq!(
        f.drafts.get_draft(&saved.draft_ref),
        Err(MailError::NotFound)
    );
    f.s.core.stop();
}

#[test]
fn a_draft_reference_from_another_account_is_not_found_for_every_operation() {
    let f = fixture("draft-service-foreign");
    let created = f.drafts.create_draft(&new_message("mine")).unwrap();
    let foreign = DraftRef {
        account_id: "untrusted-other-account".into(),
        draft_id: created.draft_ref.draft_id.clone(),
    };
    assert_eq!(f.drafts.get_draft(&foreign), Err(MailError::NotFound));
    assert_eq!(
        f.drafts.save_draft(&SaveDraft {
            draft_ref: foreign.clone(),
            expected_revision: created.revision,
            request_id: "save-foreign".into(),
            content: content("Stolen"),
        }),
        Err(MailError::NotFound)
    );
    assert_eq!(
        f.drafts.delete_draft(&DeleteDraft {
            draft_ref: foreign,
            expected_revision: created.revision,
            request_id: "delete-foreign".into(),
        }),
        Err(MailError::NotFound)
    );
    // Nothing about the real draft changed.
    let draft = f.drafts.get_draft(&created.draft_ref).unwrap();
    assert_eq!(draft.revision, created.revision);
    assert_eq!(draft.content.subject, "Hello");
    f.s.core.stop();
}

#[test]
fn require_draft_account_only_admits_the_active_account() {
    let account = AccountInfo {
        account_id: ACCOUNT_ID.into(),
        email_address: FIXTURE_MAILBOX.into(),
    };
    let own = DraftRef {
        account_id: ACCOUNT_ID.into(),
        draft_id: "d".into(),
    };
    assert_eq!(require_draft_account(&account, &own), Ok(()));
    let other = DraftRef {
        account_id: "untrusted-other-account".into(),
        draft_id: "d".into(),
    };
    assert_eq!(
        require_draft_account(&account, &other),
        Err(MailError::NotFound)
    );
}

#[test]
fn a_reply_is_built_only_from_the_displayed_latest_message() {
    let f = fixture("draft-service-reply");
    let conv = conversation("conv-01");
    let latest = latest_message_id(&f.s.core, "conv-01");
    let receipt = f
        .drafts
        .create_draft(&reply("reply-1", conv.clone(), &latest))
        .unwrap();
    let draft = f.drafts.get_draft(&receipt.draft_ref).unwrap();
    let link = draft.reply_link.expect("a reply carries its link");
    assert_eq!(link.source_message_id, latest);

    // An older message is not the displayed one.
    assert_eq!(
        f.drafts
            .create_draft(&reply("reply-older", conv.clone(), "an-older-message")),
        Err(MailError::ReplyUnavailable)
    );
    // A conversation of another account is refused before anything is read.
    let mut foreign = conv.clone();
    foreign.account_id = "untrusted-other-account".into();
    assert_eq!(
        f.drafts
            .create_draft(&reply("reply-foreign", foreign, &latest)),
        Err(MailError::ReplyUnavailable)
    );
    // An unknown conversation is not found.
    assert_eq!(
        f.drafts
            .create_draft(&reply("reply-missing", conversation("conv-99"), &latest)),
        Err(MailError::NotFound)
    );
    // The identical request is answered from its receipt, not created twice.
    assert_eq!(
        f.drafts
            .create_draft(&reply("reply-1", conv, &latest))
            .unwrap(),
        receipt
    );
    assert_eq!(f.drafts.list_drafts().unwrap().len(), 1);
    f.s.core.stop();
}

#[test]
fn validate_reply_conversation_rejects_each_way_the_displayed_thread_can_differ() {
    let f = fixture("draft-service-validate");
    let conv = conversation("conv-02");
    let latest = latest_message_id(&f.s.core, "conv-02");
    let displayed = f.s.core.get_conversation(&conv).unwrap();
    assert_eq!(
        validate_reply_conversation(&displayed, &conv, &latest),
        Ok(())
    );

    let reject = |change: &dyn Fn(&mut mail_core::dto::Conversation),
                  expected: &ConversationRef| {
        let mut changed = displayed.clone();
        change(&mut changed);
        assert_eq!(
            validate_reply_conversation(&changed, expected, &latest),
            Err(MailError::ReplyUnavailable)
        );
    };
    // The caller named a different conversation.
    reject(&|_| {}, &conversation("conv-03"));
    // Incomplete context.
    reject(&|c| c.context_complete = Some(false), &conv);
    reject(&|c| c.context_complete = None, &conv);
    // A retained snapshot is not a live thread.
    reject(
        &|c| c.retained_snapshot_at = Some("2026-02-01T00:00:00Z".into()),
        &conv,
    );
    // The source is not the newest message, or there are no messages.
    assert_eq!(
        validate_reply_conversation(&displayed, &conv, "an-older-message"),
        Err(MailError::ReplyUnavailable)
    );
    reject(&|c| c.messages.clear(), &conv);
    f.s.core.stop();
}

#[test]
fn load_validated_reply_context_returns_the_latest_message_headers_or_reply_unavailable() {
    let f = fixture("draft-service-context");
    let conv = conversation("conv-02");
    let latest = latest_message_id(&f.s.core, "conv-02");
    let loaded = load_validated_reply_context(&f.s.core, &conv, &latest).unwrap();
    let context = loaded.reply_context.unwrap();
    assert_eq!(context.source_message_id, latest);
    assert!(context.message_id.ends_with("@fixture.emailos>"));
    assert_eq!(
        load_validated_reply_context(&f.s.core, &conv, "an-older-message"),
        Err(MailError::ReplyUnavailable)
    );
    f.s.core.stop();
}

#[test]
fn connect_and_disconnect_are_rejected_in_a_synthetic_session_and_erase_no_drafts() {
    let f = fixture("draft-service-lifecycle");
    let created = f.drafts.create_draft(&new_message("keep")).unwrap();
    let mode = MailError::InvalidRequest {
        field: "mode".into(),
    };
    assert_eq!(f.drafts.connect_account(), Err(mode.clone()));
    assert_eq!(f.drafts.disconnect_account(), Err(mode));
    assert_eq!(f.drafts.get_draft(&created.draft_ref).unwrap().revision, 1);
    f.s.core.stop();
}
