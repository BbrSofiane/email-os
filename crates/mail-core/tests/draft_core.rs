use std::sync::{Arc, Barrier};

use mail_core::drafts::{
    CreateDraft, DeleteDraft, Draft, DraftContent, DraftCore, DraftRef, DraftSource, ReplyContext,
    SaveDraft,
};
use mail_core::dto::{Address, Conversation, ConversationRef, Message};
use mail_core::gmail::types::AccountInfo;
use mail_core::MailError;
use rusqlite::Connection;
use uuid::Uuid;

fn temp_profile() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("mail-core-drafts-{}", Uuid::new_v4()))
}
fn account(id: &str, email: &str) -> AccountInfo {
    AccountInfo {
        account_id: id.into(),
        email_address: email.into(),
    }
}
fn content(to: &str, cc: &str, subject: &str, body: &str) -> DraftContent {
    DraftContent {
        to: to.into(),
        cc: cc.into(),
        subject: subject.into(),
        body_text: body.into(),
    }
}
fn new_command(key: &str, initial: Option<DraftContent>) -> CreateDraft {
    CreateDraft {
        request_id: key.into(),
        source: DraftSource::NewMessage,
        initial_content: initial,
    }
}
fn conversation(reply_context: Option<ReplyContext>) -> Conversation {
    let reference = ConversationRef {
        account_id: "acct".into(),
        conversation_id: "thread-1".into(),
    };
    Conversation {
        conversation_ref: reference,
        subject: "Re: café".into(),
        messages: vec![Message {
            id: "provider-message-7".into(),
            from: Address {
                display_name: Some("Ignored Name".into()),
                mailbox: "sender@example.test".into(),
            },
            to: vec![],
            sent_at: "2025-01-01T00:00:00Z".into(),
            body_text: "text".into(),
        }],
        is_in_inbox: true,
        is_read: Some(true),
        context_complete: Some(true),
        unsupported_reason: None,
        retained_snapshot_at: None,
        reply_context,
        pending_operation_id: None,
    }
}
fn reply_context(from: &str, reply_to: Option<Vec<&str>>) -> ReplyContext {
    ReplyContext {
        source_message_id: "provider-message-7".into(),
        from_mailbox: from.into(),
        reply_to_mailboxes: reply_to.map(|values| values.into_iter().map(str::to_string).collect()),
        message_id: "<message-7@example.test>".into(),
        references: vec![
            "<prior@example.test>".into(),
            "<message-7@example.test>".into(),
        ],
    }
}
fn save(ref_: &DraftRef, key: &str, revision: u32, value: DraftContent) -> SaveDraft {
    SaveDraft {
        draft_ref: ref_.clone(),
        expected_revision: revision,
        request_id: key.into(),
        content: value,
    }
}
fn assert_error<T>(result: Result<T, MailError>, expected: fn(&MailError) -> bool) {
    let error = result.err().expect("expected error");
    assert!(expected(&error), "unexpected error: {error:?}");
}

#[test]
fn drafts_reopen_exact_raw_text_and_are_account_scoped() {
    let dir = temp_profile();
    let a = account("acct", "me@example.test");
    let b = account("other", "other@example.test");
    let initial = content(
        "partial, not a mailbox",
        "Cc: unfinished",
        "  café\u{301} ✉  ",
        "line one\r\n🙂\0 raw",
    );
    let core = DraftCore::open(&dir).unwrap();
    assert_error(DraftCore::open(&dir), |e| {
        matches!(e, MailError::ProfileInUse)
    });
    let accepted = core
        .create_draft(&a, &new_command("new-1", Some(initial.clone())), None)
        .unwrap();
    assert_eq!(accepted.revision, 1);
    assert_eq!(
        core.get_draft(&a, &accepted.draft_ref).unwrap().content,
        initial
    );
    assert!(core.list_drafts(&b).unwrap().is_empty());
    assert_error(core.get_draft(&b, &accepted.draft_ref), |e| {
        matches!(e, MailError::NotFound)
    });
    drop(core);

    let reopened = DraftCore::open(&dir).unwrap();
    let draft = reopened.get_draft(&a, &accepted.draft_ref).unwrap();
    assert_eq!(
        draft.content,
        content(
            "partial, not a mailbox",
            "Cc: unfinished",
            "  café\u{301} ✉  ",
            "line one\r\n🙂\0 raw"
        )
    );
    assert_eq!(draft.revision, 1);
    assert_eq!(
        reopened.list_drafts(&a).unwrap()[0].subject,
        draft.content.subject
    );
    drop(reopened);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn receipts_are_atomic_stable_and_conflict_across_operations() {
    let dir = temp_profile();
    let core = DraftCore::open(&dir).unwrap();
    let a = account("acct", "me@example.test");
    let first = new_command("create-key", Some(content("x", "", "first", "body")));
    let accepted = core.create_draft(&a, &first, None).unwrap();
    assert_eq!(
        core.lookup_create_receipt(&a, &first).unwrap(),
        Some(accepted.clone())
    );
    let changed_create = new_command("create-key", Some(content("x", "", "changed", "body")));
    assert_error(core.create_draft(&a, &changed_create, None), |e| {
        matches!(e, MailError::RequestIdConflict)
    });

    let save1 = save(
        &accepted.draft_ref,
        "save-key",
        1,
        content("raw to", "raw cc", "subject 2", "body 2"),
    );
    let receipt1 = core.save_draft(&a, &save1).unwrap();
    assert_eq!(receipt1.revision, 2);
    let save2 = save(
        &accepted.draft_ref,
        "save-next",
        2,
        content("", "", "latest", "latest body"),
    );
    core.save_draft(&a, &save2).unwrap();
    assert_eq!(core.save_draft(&a, &save1).unwrap(), receipt1);
    assert_error(
        core.delete_draft(
            &a,
            &DeleteDraft {
                draft_ref: accepted.draft_ref.clone(),
                expected_revision: 3,
                request_id: "save-key".into(),
            },
        ),
        |e| matches!(e, MailError::RequestIdConflict),
    );

    let deletion = DeleteDraft {
        draft_ref: accepted.draft_ref.clone(),
        expected_revision: 3,
        request_id: "delete-key".into(),
    };
    let deleted = core.delete_draft(&a, &deletion).unwrap();
    assert_eq!(core.delete_draft(&a, &deletion).unwrap(), deleted);
    assert_eq!(core.save_draft(&a, &save1).unwrap(), receipt1);
    // A committed create receipt never recreates a draft after deletion.
    assert_eq!(
        core.create_draft(&a, &first, None).unwrap(),
        accepted.clone()
    );
    assert!(core.list_drafts(&a).unwrap().is_empty());
    assert_error(
        core.save_draft(
            &a,
            &save(&accepted.draft_ref, "late", 3, content("", "", "", "")),
        ),
        |e| matches!(e, MailError::NotFound),
    );
    assert_error(core.get_draft(&a, &accepted.draft_ref), |e| {
        matches!(e, MailError::NotFound)
    });
    drop(core);

    let reopened = DraftCore::open(&dir).unwrap();
    assert_eq!(reopened.create_draft(&a, &first, None).unwrap(), accepted);
    assert_eq!(reopened.save_draft(&a, &save1).unwrap(), receipt1);
    assert_eq!(reopened.delete_draft(&a, &deletion).unwrap(), deleted);
    assert!(reopened.list_drafts(&a).unwrap().is_empty());
    drop(reopened);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn concurrent_cas_has_one_winner_and_stale_writes_never_overwrite() {
    let dir = temp_profile();
    let core = DraftCore::open(&dir).unwrap();
    let a = account("acct", "me@example.test");
    let created = core
        .create_draft(&a, &new_command("create", None), None)
        .unwrap();
    let gate = Arc::new(Barrier::new(3));
    let mut threads = Vec::new();
    for i in 0..2 {
        let worker = core.clone();
        let account = a.clone();
        let reference = created.draft_ref.clone();
        let gate = Arc::clone(&gate);
        threads.push(std::thread::spawn(move || {
            gate.wait();
            worker.save_draft(
                &account,
                &save(
                    &reference,
                    &format!("race-{i}"),
                    1,
                    content("", "", &i.to_string(), "body"),
                ),
            )
        }));
    }
    gate.wait();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(
                result,
                Err(MailError::DraftConflict {
                    current_revision: 2
                })
            ))
            .count(),
        1
    );
    assert_eq!(core.get_draft(&a, &created.draft_ref).unwrap().revision, 2);
    drop(core);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn failed_commit_creates_neither_draft_nor_request_receipt() {
    let dir = temp_profile();
    let core = DraftCore::open(&dir).unwrap();
    let a = account("acct", "me@example.test");
    let command = new_command(
        "retry-after-storage-failure",
        Some(content("", "", "s", "b")),
    );
    let external = Connection::open(dir.join("drafts.db")).unwrap();
    external.execute_batch("CREATE TRIGGER reject_draft BEFORE INSERT ON drafts BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
    assert_error(core.create_draft(&a, &command, None), |e| {
        matches!(e, MailError::StorageUnavailable)
    });
    assert_eq!(core.lookup_create_receipt(&a, &command).unwrap(), None);
    external
        .execute_batch("DROP TRIGGER reject_draft;")
        .unwrap();
    let accepted = core.create_draft(&a, &command, None).unwrap();
    assert_eq!(accepted.revision, 1);

    let update = save(
        &accepted.draft_ref,
        "retry-save",
        1,
        content("", "", "saved", "saved body"),
    );
    external.execute_batch("CREATE TRIGGER reject_update BEFORE UPDATE ON drafts BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
    assert_error(core.save_draft(&a, &update), |e| {
        matches!(e, MailError::StorageUnavailable)
    });
    assert_error(core.save_draft(&a, &update), |e| {
        matches!(e, MailError::StorageUnavailable)
    });
    external
        .execute_batch("DROP TRIGGER reject_update;")
        .unwrap();
    assert_eq!(core.save_draft(&a, &update).unwrap().revision, 2);
    drop(external);
    drop(core);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn reply_defaults_are_strict_and_reply_link_survives_cache_loss() {
    let dir = temp_profile();
    let core = DraftCore::open(&dir).unwrap();
    let a = account("acct", "me@example.test");
    let conv = conversation(Some(reply_context(
        "sender@example.test",
        Some(vec![
            "Me@Example.Test",
            "reply+tag@example.test",
            "REPLY+TAG@example.test",
        ]),
    )));
    let source = DraftSource::Reply {
        conversation: conv.conversation_ref.clone(),
        source_message_id: "provider-message-7".into(),
    };
    let command = CreateDraft {
        request_id: "reply-1".into(),
        source,
        initial_content: None,
    };
    let accepted = core.create_draft(&a, &command, Some(&conv)).unwrap();
    let draft = core.get_draft(&a, &accepted.draft_ref).unwrap();
    assert_eq!(draft.content.to, "reply+tag@example.test");
    assert_eq!(draft.content.cc, "");
    assert_eq!(draft.content.subject, "Re: café");
    assert_eq!(draft.content.body_text, "");
    assert_eq!(
        draft.reply_link.as_ref().unwrap().references,
        vec!["<prior@example.test>", "<message-7@example.test>"]
    );
    let updated = core
        .save_draft(
            &a,
            &save(
                &accepted.draft_ref,
                "reply-save",
                1,
                content("raw", "", "edited", "body"),
            ),
        )
        .unwrap();
    assert_eq!(updated.revision, 2);
    let reloaded = core.get_draft(&a, &accepted.draft_ref).unwrap();
    assert_eq!(reloaded.reply_link, draft.reply_link);
    assert_error(
        core.create_draft(
            &a,
            &CreateDraft {
                request_id: "reply-1".into(),
                source: DraftSource::NewMessage,
                initial_content: None,
            },
            None,
        ),
        |e| matches!(e, MailError::RequestIdConflict),
    );
    drop(core);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn reply_to_absence_falls_back_but_malformed_or_stale_context_is_denied() {
    let dir = temp_profile();
    let core = DraftCore::open(&dir).unwrap();
    let a = account("acct", "me@example.test");
    let fallback = conversation(Some(reply_context("sender@example.test", None)));
    let source = DraftSource::Reply {
        conversation: fallback.conversation_ref.clone(),
        source_message_id: "provider-message-7".into(),
    };
    let result = core
        .create_draft(
            &a,
            &CreateDraft {
                request_id: "fallback".into(),
                source: source.clone(),
                initial_content: None,
            },
            Some(&fallback),
        )
        .unwrap();
    assert_eq!(
        core.get_draft(&a, &result.draft_ref).unwrap().content.to,
        "sender@example.test"
    );

    let malformed = conversation(Some(reply_context(
        "sender@example.test",
        Some(vec!["Display Name <bad@example.test>"]),
    )));
    assert_error(
        core.create_draft(
            &a,
            &CreateDraft {
                request_id: "bad-mailbox".into(),
                source: source.clone(),
                initial_content: None,
            },
            Some(&malformed),
        ),
        |e| matches!(e, MailError::ReplyUnavailable),
    );
    let empty_reply_to = conversation(Some(reply_context("sender@example.test", Some(vec![]))));
    assert_error(
        core.create_draft(
            &a,
            &CreateDraft {
                request_id: "empty-reply-to".into(),
                source: source.clone(),
                initial_content: None,
            },
            Some(&empty_reply_to),
        ),
        |e| matches!(e, MailError::ReplyUnavailable),
    );
    let missing = conversation(None);
    assert_error(
        core.create_draft(
            &a,
            &CreateDraft {
                request_id: "missing".into(),
                source: source.clone(),
                initial_content: None,
            },
            Some(&missing),
        ),
        |e| matches!(e, MailError::ReplyUnavailable),
    );
    let mut retained = fallback.clone();
    retained.retained_snapshot_at = Some("yesterday".into());
    assert_error(
        core.create_draft(
            &a,
            &CreateDraft {
                request_id: "retained".into(),
                source: source.clone(),
                initial_content: None,
            },
            Some(&retained),
        ),
        |e| matches!(e, MailError::ReplyUnavailable),
    );
    let mut incomplete = fallback.clone();
    incomplete.context_complete = Some(false);
    assert_error(
        core.create_draft(
            &a,
            &CreateDraft {
                request_id: "incomplete".into(),
                source: source.clone(),
                initial_content: None,
            },
            Some(&incomplete),
        ),
        |e| matches!(e, MailError::ReplyUnavailable),
    );
    let mut bad_from = fallback.clone();
    bad_from.reply_context.as_mut().unwrap().from_mailbox =
        "Display Name <sender@example.test>".into();
    assert_error(
        core.create_draft(
            &a,
            &CreateDraft {
                request_id: "bad-from".into(),
                source: source.clone(),
                initial_content: None,
            },
            Some(&bad_from),
        ),
        |e| matches!(e, MailError::ReplyUnavailable),
    );
    let mut malformed_id = fallback.clone();
    malformed_id.reply_context.as_mut().unwrap().message_id = "<bad\r\n@example.test>".into();
    assert_error(
        core.create_draft(
            &a,
            &CreateDraft {
                request_id: "bad-message-id".into(),
                source: source.clone(),
                initial_content: None,
            },
            Some(&malformed_id),
        ),
        |e| matches!(e, MailError::ReplyUnavailable),
    );
    let mut self_sent = fallback.clone();
    self_sent.messages[0].from.mailbox = "ME@example.test".into();
    assert_error(
        core.create_draft(
            &a,
            &CreateDraft {
                request_id: "own-sent".into(),
                source: source.clone(),
                initial_content: None,
            },
            Some(&self_sent),
        ),
        |e| matches!(e, MailError::ReplyUnavailable),
    );
    let mut context_mismatch = fallback.clone();
    context_mismatch
        .reply_context
        .as_mut()
        .unwrap()
        .source_message_id = "old-message".into();
    assert_error(
        core.create_draft(
            &a,
            &CreateDraft {
                request_id: "context-mismatch".into(),
                source: source.clone(),
                initial_content: None,
            },
            Some(&context_mismatch),
        ),
        |e| matches!(e, MailError::ReplyUnavailable),
    );
    let mut stale = fallback.clone();
    stale.messages[0].id = "different".into();
    assert_error(
        core.create_draft(
            &a,
            &CreateDraft {
                request_id: "stale".into(),
                source,
                initial_content: None,
            },
            Some(&stale),
        ),
        |e| matches!(e, MailError::ReplyUnavailable),
    );
    drop(core);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn limits_overflow_and_profile_lock_fail_closed() {
    let dir = temp_profile();
    let core = DraftCore::open(&dir).unwrap();
    let a = account("acct", "me@example.test");
    let too_large = content("x".repeat(16 * 1024 + 1).as_str(), "", "", "");
    assert_error(
        core.create_draft(&a, &new_command("too-large", Some(too_large)), None),
        |e| matches!(e, MailError::InvalidRequest { field } if field == "to"),
    );
    let created = core
        .create_draft(&a, &new_command("overflow", None), None)
        .unwrap();
    let external = Connection::open(dir.join("drafts.db")).unwrap();
    external
        .execute(
            "UPDATE drafts SET revision=?1 WHERE account_id='acct' AND draft_id=?2",
            rusqlite::params![u32::MAX as i64, created.draft_ref.draft_id],
        )
        .unwrap();
    assert_error(
        core.save_draft(
            &a,
            &save(
                &created.draft_ref,
                "overflow-save",
                u32::MAX,
                content("", "", "", ""),
            ),
        ),
        |e| matches!(e, MailError::StorageUnavailable),
    );
    assert!(DraftCore::open(&dir).is_err());
    drop(external);
    drop(core);
    std::fs::remove_dir_all(dir).unwrap();
}

#[allow(dead_code)]
fn _draft_contract_is_public(_: Draft) {}
