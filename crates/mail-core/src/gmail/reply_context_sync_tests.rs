use super::*;
use crate::drafts::types::ReplyContext;
use crate::gmail::types::GmailProfile;

type ReplyReadProvider = crate::testing::operations_fake::FakeProvider;

use crate::testing::temp_profile as temp_dir;

fn reply_context(source_message_id: &str) -> ReplyContext {
    ReplyContext {
        source_message_id: source_message_id.to_string(),
        from_mailbox: "sender@example.test".to_string(),
        reply_to_mailboxes: None,
        message_id: "<latest@example.test>".to_string(),
        references: vec![
            "<parent@example.test>".to_string(),
            "<latest@example.test>".to_string(),
        ],
    }
}

fn thread(context: Option<ReplyContext>, complete: bool) -> GmailThread {
    let messages = vec![
        Message {
            id: "m-earlier".to_string(),
            from: Address {
                display_name: None,
                mailbox: "sender@example.test".to_string(),
            },
            to: Vec::new(),
            sent_at: "2026-01-01T00:00:00Z".to_string(),
            body_text: "earlier body".to_string(),
            has_attachment: None,
        },
        Message {
            id: "m-latest".to_string(),
            from: Address {
                display_name: Some("Sender".to_string()),
                mailbox: "sender@example.test".to_string(),
            },
            to: Vec::new(),
            sent_at: "2026-01-02T00:00:00Z".to_string(),
            body_text: "latest plain body".to_string(),
            has_attachment: None,
        },
    ];
    let newest_sender = messages
        .iter()
        .max_by(|a, b| (&a.sent_at, &a.id).cmp(&(&b.sent_at, &b.id)))
        .map(|m| m.from.clone());
    let mut thread = crate::testing::thread(
        "acct-reply",
        "thread-reply",
        messages,
        &["m-latest"],
        Some(vec![]),
        "history-2",
    );
    thread.newest_sender = newest_sender;
    thread.conversation.subject = "Synthetic reply context".to_string();
    thread.conversation.is_read = Some(true);
    thread.conversation.context_complete = Some(complete);
    thread.conversation.reply_context = context;
    thread
}

fn setup(
    tag: &str,
    cached_context: Option<ReplyContext>,
    remote_context: Option<ReplyContext>,
    cached_complete: bool,
    remote_complete: bool,
) -> (
    GmailCore,
    Arc<ReplyReadProvider>,
    tempfile::TempDir,
    ConversationRef,
) {
    let dir = temp_dir(tag);
    let provider = ReplyReadProvider::with_thread(thread(remote_context, remote_complete));
    let core = GmailCore::open(&dir, provider.clone()).expect("core opens");
    core.inner
        .store
        .begin_account(
            &GmailProfile {
                account_id: "acct-reply".to_string(),
                email_address: "you@example.test".to_string(),
                history_id: "history-1".to_string(),
            },
            0,
        )
        .expect("seed cached account");
    core.inner
        .store
        .apply_discovery_page(
            &[ThreadFetch::Cached(Box::new(thread(
                cached_context,
                cached_complete,
            )))],
            None,
            true,
            false,
            0,
        )
        .expect("seed cached thread");
    (
        core,
        provider,
        dir,
        ConversationRef {
            account_id: "acct-reply".to_string(),
            conversation_id: "thread-reply".to_string(),
        },
    )
}

fn close(core: GmailCore, dir: tempfile::TempDir) {
    core.stop();
    drop(core);
    drop(dir);
}

#[test]
fn retained_thread_bytes_include_newest_sender_allocations() {
    let mut observed = thread(None, true);
    let sender = observed.newest_sender.take().unwrap();
    let without = retained_thread_bytes(&observed);
    let expected =
        sender.mailbox.capacity() + sender.display_name.as_ref().map_or(0, String::capacity);
    observed.newest_sender = Some(sender);
    assert_eq!(retained_thread_bytes(&observed), without + expected);
}

#[test]
fn attachment_download_checks_identity_offline_size_and_cancellation() {
    use crate::attachments::*;
    let (core, provider, dir, target) = setup("attachments", None, None, false, false);
    let mut cached = thread(None, false);
    cached.attachments = vec![AttachmentDescriptor {
        message_id: "m-latest".into(),
        attachment_id: "a1".into(),
        filename: "../../x.pdf".into(),
        mime_type: "application/pdf".into(),
        size: 9,
    }];
    core.inner
        .store
        .apply_discovery_page(
            &[ThreadFetch::Cached(Box::new(cached.clone()))],
            None,
            true,
            false,
            0,
        )
        .unwrap();
    let downloads = test_directory();
    let mut request = SaveAttachment {
        conversation: target.clone(),
        message_id: "m-latest".into(),
        attachment_id: "a1".into(),
        request_id: "r1".into(),
    };
    let before = core.get_conversation(&target).unwrap();
    let saved = core
        .download_attachment(&request, &CancelToken::default(), downloads.path())
        .unwrap();
    assert_eq!(
        std::fs::read(downloads.path().join(saved.filename)).unwrap(),
        b"%PDF-1.7\n"
    );
    assert_eq!(core.get_conversation(&target).unwrap(), before);
    request.conversation.account_id = "foreign".into();
    assert!(core
        .download_attachment(&request, &CancelToken::default(), downloads.path())
        .is_err());
    request.conversation = target;
    request.attachment_id = "missing".into();
    assert_eq!(
        core.download_attachment(&request, &CancelToken::default(), downloads.path()),
        Err(MailError::NotFound)
    );
    request.attachment_id = "a1".into();
    provider.set_reply_error(Some(MailError::NetworkUnavailable));
    assert_eq!(
        core.download_attachment(&request, &CancelToken::default(), downloads.path()),
        Err(MailError::NetworkUnavailable)
    );
    provider.set_reply_error(None);
    let cancel = CancelToken::default();
    cancel.cancel();
    assert_eq!(
        core.download_attachment(&request, &cancel, downloads.path()),
        Err(MailError::AuthCancelled)
    );
    cached.attachments[0].size = (MAX_ATTACHMENT_BYTES + 1) as u32;
    core.inner
        .store
        .apply_discovery_page(
            &[ThreadFetch::Cached(Box::new(cached))],
            None,
            true,
            false,
            0,
        )
        .unwrap();
    assert!(core
        .download_attachment(&request, &CancelToken::default(), downloads.path())
        .is_err());
    assert_eq!(std::fs::read_dir(downloads.path()).unwrap().count(), 1);
    close(core, dir);
}

#[test]
fn attachment_disconnect_drains_and_cancels_without_publishing_file() {
    use crate::attachments::*;
    let (core, provider, dir, target) = setup("attachment-disconnect", None, None, false, false);
    let mut cached = thread(None, false);
    cached.attachments = vec![AttachmentDescriptor {
        message_id: "m-latest".into(),
        attachment_id: "a1".into(),
        filename: "x.pdf".into(),
        mime_type: "application/pdf".into(),
        size: 9,
    }];
    core.inner
        .store
        .apply_discovery_page(
            &[ThreadFetch::Cached(Box::new(cached))],
            None,
            true,
            false,
            0,
        )
        .unwrap();
    let request = SaveAttachment {
        conversation: target,
        message_id: "m-latest".into(),
        attachment_id: "a1".into(),
        request_id: "r1".into(),
    };
    let downloads = test_directory();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    provider.set_reply_get_thread_cancel_hook(Some(Arc::new(move |cancel| {
        entered_tx.send(()).unwrap();
        assert!(cancel.wait_until_cancelled(Duration::from_secs(4)));
    })));
    provider.set_reply_configured(true);
    let reader = core.clone();
    let destination = downloads.path().to_path_buf();
    let transfer = std::thread::spawn(move || {
        reader.download_attachment(&request, &CancelToken::default(), &destination)
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    core.disconnect_account().unwrap();
    assert_eq!(transfer.join().unwrap(), Err(MailError::AuthCancelled));
    assert!(!provider.premature_disconnect());
    assert_eq!(std::fs::read_dir(downloads.path()).unwrap().count(), 0);
    close(core, dir);
}

#[test]
fn retained_thread_bytes_include_nested_reply_context_allocations() {
    let empty = thread(None, true);
    let mut with_context = thread(Some(reply_context("m-latest")), true);
    with_context
        .conversation
        .reply_context
        .as_mut()
        .unwrap()
        .reply_to_mailboxes = Some(vec![
        "first@example.test".to_string(),
        "second@example.test".to_string(),
    ]);
    assert!(retained_thread_bytes(&with_context) > retained_thread_bytes(&empty));
}

#[test]
fn reply_metadata_cache_hit_is_network_free_and_requires_the_explicit_latest_source() {
    let (core, provider, dir, target) =
        setup("cached", Some(reply_context("m-latest")), None, true, true);
    let loaded = core
        .load_reply_context(&target, "m-latest")
        .expect("cache hit");
    assert_eq!(loaded.reply_context, Some(reply_context("m-latest")));
    assert_eq!(provider.reply_thread_calls(), 0);
    assert_eq!(
        core.load_reply_context(&target, "m-earlier"),
        Err(MailError::ReplyUnavailable)
    );
    assert_eq!(provider.reply_thread_calls(), 0);
    close(core, dir);
}

#[test]
fn legacy_reply_metadata_enrichment_is_readonly_and_survives_restart() {
    let (core, provider, dir, target) =
        setup("legacy", None, Some(reply_context("m-latest")), true, true);
    let before = core.get_conversation(&target).expect("cached reader");
    let cursor_before = core.inner.store.cursor().expect("cursor");
    let loaded = core
        .load_reply_context(&target, "m-latest")
        .expect("enriched reader");
    assert_eq!(loaded.reply_context, Some(reply_context("m-latest")));
    assert_eq!(provider.reply_thread_calls(), 1);
    assert_eq!(loaded.messages, before.messages);
    assert_eq!(loaded.subject, before.subject);
    assert_eq!(loaded.is_in_inbox, before.is_in_inbox);
    assert_eq!(
        core.inner.store.cursor().expect("cursor unchanged"),
        cursor_before
    );

    core.stop();
    drop(core);
    let reopened = GmailStore::open(dir.path(), Arc::new(SystemClock)).expect("reopen cache");
    assert_eq!(
        reopened
            .get_conversation(&target)
            .expect("restart reader")
            .reply_context,
        Some(reply_context("m-latest"))
    );
    drop(reopened);
    drop(provider);
    drop(dir);
}

#[test]
fn incomplete_or_mismatched_fetched_context_is_not_cached() {
    let (core, provider, dir, target) = setup(
        "incomplete",
        None,
        Some(reply_context("m-latest")),
        true,
        false,
    );
    assert_eq!(
        core.load_reply_context(&target, "m-latest"),
        Err(MailError::ReplyUnavailable)
    );
    assert_eq!(
        core.get_conversation(&target).unwrap().reply_context,
        None,
        "failed enrichment must leave metadata absent"
    );
    assert_eq!(provider.reply_thread_calls(), 1);
    close(core, dir);

    let (core, provider, dir, target) = setup(
        "mismatched",
        None,
        Some(reply_context("different-source")),
        true,
        true,
    );
    assert_eq!(
        core.load_reply_context(&target, "m-latest"),
        Err(MailError::ReplyUnavailable)
    );
    assert_eq!(core.get_conversation(&target).unwrap().reply_context, None);
    assert_eq!(provider.reply_thread_calls(), 1);
    close(core, dir);
}

#[test]
fn provider_error_and_generation_source_account_races_leave_no_metadata_write() {
    let (core, provider, dir, target) = setup(
        "provider-error",
        None,
        Some(reply_context("m-latest")),
        true,
        true,
    );
    provider.set_reply_error(Some(MailError::ProviderUnavailable));
    let before = core.get_conversation(&target).expect("reader before error");
    let cursor_before = core.inner.store.cursor().expect("cursor before error");
    assert_eq!(
        core.load_reply_context(&target, "m-latest"),
        Err(MailError::ProviderUnavailable)
    );
    assert_eq!(
        core.get_conversation(&target).expect("reader after error"),
        before
    );
    assert_eq!(
        core.inner.store.cursor().expect("cursor after error"),
        cursor_before
    );
    assert!(core
        .inner
        .ctrl
        .state
        .lock()
        .unwrap()
        .reply_enrichments
        .is_empty());
    core.disconnect_account()
        .expect("provider error releases enrichment admission");
    close(core, dir);

    for (tag, race) in [
        ("generation-race", "generation"),
        ("source-race", "source"),
        ("account-race", "account"),
    ] {
        let (core, provider, dir, target) =
            setup(tag, None, Some(reply_context("m-latest")), true, true);
        let store = Arc::clone(&core.inner.store);
        let mut newer_thread = thread(None, true);
        newer_thread.conversation.messages.push(Message {
            id: "m-newer".to_string(),
            from: Address {
                display_name: None,
                mailbox: "new@example.test".to_string(),
            },
            to: Vec::new(),
            sent_at: "2026-01-03T00:00:00Z".to_string(),
            body_text: "new body".to_string(),
            has_attachment: None,
        });
        newer_thread.inbox_message_ids.push("m-newer".to_string());
        newer_thread.message_ids = Some(vec![
            "m-earlier".to_string(),
            "m-latest".to_string(),
            "m-newer".to_string(),
        ]);
        provider.set_reply_get_thread_hook(Some(Arc::new(move || match race {
            "generation" => store.advance_generation().expect("advance generation"),
            "source" => {
                store
                    .apply_discovery_page(
                        &[ThreadFetch::Cached(Box::new(newer_thread.clone()))],
                        None,
                        true,
                        false,
                        0,
                    )
                    .expect("simulate newer cached source");
            }
            "account" => store.clear_account().expect("clear account"),
            _ => unreachable!(),
        })));
        assert_eq!(
            core.load_reply_context(&target, "m-latest"),
            Err(MailError::ReplyUnavailable),
            "the {race} race must discard the stale metadata"
        );
        if race != "account" {
            assert_eq!(core.get_conversation(&target).unwrap().reply_context, None);
        } else {
            assert_eq!(core.inner.store.account().unwrap(), None);
        }
        close(core, dir);
    }
}

mod enrichment_lifecycle_tests {
    use super::*;
    use std::sync::Barrier;
    use std::time::Duration;

    struct ReadBarriers {
        entered: Arc<Barrier>,
        cancelled: Arc<Barrier>,
        release: Arc<Barrier>,
        cancel_observed: std::sync::mpsc::Receiver<bool>,
    }

    fn block_refresh_after_cancel(
        provider: &Arc<ReplyReadProvider>,
        concurrent_reads: usize,
    ) -> ReadBarriers {
        let entered = Arc::new(Barrier::new(concurrent_reads + 1));
        let cancelled = Arc::new(Barrier::new(concurrent_reads + 1));
        let release = Arc::new(Barrier::new(concurrent_reads + 1));
        let (cancel_tx, cancel_observed) = std::sync::mpsc::channel();
        let entered_hook = Arc::clone(&entered);
        let cancelled_hook = Arc::clone(&cancelled);
        let release_hook = Arc::clone(&release);
        let publishes_credentials = Arc::clone(provider);
        provider.set_reply_get_thread_cancel_hook(Some(Arc::new(move |cancel| {
            entered_hook.wait();
            let observed = cancel.wait_until_cancelled(Duration::from_secs(10));
            cancel_tx
                .send(observed)
                .expect("test receiver remains open");
            cancelled_hook.wait();
            release_hook.wait();
            // Model a refresh response that commits credentials after the
            // caller was cancelled; cancellation cannot be trusted as a join.
            publishes_credentials.set_reply_credentials(true);
        })));
        ReadBarriers {
            entered,
            cancelled,
            release,
            cancel_observed,
        }
    }

    #[test]
    fn disconnect_cancels_and_drains_every_independent_reply_enrichment() {
        let (core, provider, dir, target) = setup(
            "disconnect-drains",
            None,
            Some(reply_context("m-latest")),
            true,
            true,
        );
        provider.set_reply_configured(true);
        let generation_before_disconnect = core
            .inner
            .store
            .generation()
            .expect("read pre-disconnect generation");
        let read_count = 2;
        let barriers = block_refresh_after_cancel(&provider, read_count);
        let mut reads = Vec::new();
        for _ in 0..read_count {
            let reader = core.clone();
            let target = target.clone();
            reads.push(std::thread::spawn(move || {
                reader.load_reply_context(&target, "m-latest")
            }));
        }
        barriers.entered.wait();

        let disconnector = core.clone();
        let (disconnect_tx, disconnect_rx) = std::sync::mpsc::channel();
        let disconnect = std::thread::spawn(move || {
            disconnect_tx
                .send(disconnector.disconnect_account())
                .expect("disconnect receiver remains open");
        });
        for _ in 0..read_count {
            assert!(barriers
                .cancel_observed
                .recv_timeout(Duration::from_secs(2))
                .expect("disconnect cancels each registered read"));
        }
        barriers.cancelled.wait();
        assert_eq!(
            core.load_reply_context(&target, "m-latest"),
            Err(MailError::Busy),
            "disconnect's admission barrier rejects another enrichment"
        );
        assert_eq!(provider.reply_disconnect_calls(), 0);
        assert!(!provider.reply_credentials());

        let generation_deadline = std::time::Instant::now() + Duration::from_secs(2);
        while core
            .inner
            .store
            .generation()
            .expect("read disconnect generation")
            == generation_before_disconnect
            && std::time::Instant::now() < generation_deadline
        {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_ne!(
            core.inner
                .store
                .generation()
                .expect("read generation after disconnect fence"),
            generation_before_disconnect,
            "disconnect advances the generation fence before provider reads are released"
        );

        barriers.release.wait();
        for read in reads {
            assert_eq!(
                read.join().expect("reply read thread completes"),
                Err(MailError::ReplyUnavailable)
            );
        }
        disconnect_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("disconnect drains the reads")
            .expect("disconnect succeeds after drain");
        disconnect.join().expect("disconnect thread completes");
        assert!(!provider.premature_disconnect());
        assert!(!provider.reply_credentials());
        assert_eq!(provider.reply_disconnect_calls(), 1);
        assert_eq!(core.inner.store.account().unwrap(), None);
        assert!(core
            .inner
            .ctrl
            .state
            .lock()
            .unwrap()
            .reply_enrichments
            .is_empty());

        core.stop();
        drop(core);
        let reopened =
            GmailCore::open(&dir, provider.clone()).expect("profile reopens after disconnect");
        assert_eq!(reopened.account_status().unwrap().account, None);
        assert_eq!(
            reopened.account_status().unwrap().connection,
            ConnectionState::Disconnected
        );
        reopened.stop();
        drop(reopened);
        drop(dir);
    }

    #[test]
    fn disconnect_timeout_fails_closed_until_enrichment_finishes() {
        let (core, provider, dir, target) = setup(
            "disconnect-timeout",
            None,
            Some(reply_context("m-latest")),
            true,
            true,
        );
        provider.set_reply_configured(true);
        let barriers = block_refresh_after_cancel(&provider, 1);
        let reader = core.clone();
        let target_for_read = target.clone();
        let read =
            std::thread::spawn(move || reader.load_reply_context(&target_for_read, "m-latest"));
        barriers.entered.wait();

        let disconnector = core.clone();
        let (disconnect_tx, disconnect_rx) = std::sync::mpsc::channel();
        let disconnect = std::thread::spawn(move || {
            disconnect_tx
                .send(disconnector.disconnect_account())
                .expect("disconnect receiver remains open");
        });
        assert!(barriers
            .cancel_observed
            .recv_timeout(Duration::from_secs(2))
            .expect("disconnect cancellation is observed"));
        barriers.cancelled.wait();
        let timed_out = disconnect_rx
            .recv_timeout(Duration::from_secs(7))
            .expect("disconnect returns on its bounded timeout");
        assert_eq!(timed_out, Err(MailError::Busy));
        disconnect.join().expect("disconnect thread completes");
        assert_eq!(provider.reply_disconnect_calls(), 0);
        assert!(!provider.premature_disconnect());
        assert_eq!(
            core.inner
                .store
                .account()
                .unwrap()
                .as_ref()
                .unwrap()
                .account_id,
            "acct-reply"
        );

        barriers.release.wait();
        assert_eq!(
            read.join().expect("reply read finishes after release"),
            Err(MailError::ReplyUnavailable)
        );
        assert!(provider.reply_credentials());
        core.disconnect_account()
            .expect("retry succeeds after the timed-out read drained");
        assert!(!provider.reply_credentials());
        assert_eq!(core.inner.store.account().unwrap(), None);
        core.stop();
        drop(core);
        drop(dir);
    }

    #[test]
    fn stop_cancels_and_drains_active_enrichment_and_rejects_new_admissions() {
        let (core, provider, dir, target) = setup(
            "stop-admission",
            None,
            Some(reply_context("m-latest")),
            true,
            true,
        );
        let barriers = block_refresh_after_cancel(&provider, 1);
        let reader = core.clone();
        let target_for_read = target.clone();
        let read =
            std::thread::spawn(move || reader.load_reply_context(&target_for_read, "m-latest"));
        barriers.entered.wait();

        let stopper = core.clone();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel();
        let stop = std::thread::spawn(move || {
            stopper.stop();
            stop_tx.send(()).expect("stop receiver remains open");
        });
        assert!(barriers
            .cancel_observed
            .recv_timeout(Duration::from_secs(2))
            .expect("stop cancellation is observed"));
        barriers.cancelled.wait();
        assert_eq!(
            core.load_reply_context(&target, "m-latest"),
            Err(MailError::StorageUnavailable)
        );
        barriers.release.wait();
        assert!(read.join().expect("reply read finishes").is_ok());
        stop_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("stop drains its active read");
        stop.join().expect("stop thread completes");
        close(core, dir);
    }
}
