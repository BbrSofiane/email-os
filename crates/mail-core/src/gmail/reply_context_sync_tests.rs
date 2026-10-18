use super::*;
use crate::drafts::types::ReplyContext;
use crate::gmail::types::{GmailHistoryError, GmailProfile, HistoryPage, InboxPage};
use std::sync::atomic::{AtomicUsize, Ordering};

type ReplyReadHook = Arc<dyn Fn(&CancelToken) + Send + Sync>;

struct ReplyReadProvider {
    thread: Mutex<GmailThread>,
    error: Mutex<Option<MailError>>,
    get_thread_calls: AtomicUsize,
    active_provider_reads: AtomicUsize,
    configured: std::sync::atomic::AtomicBool,
    credentials: std::sync::atomic::AtomicBool,
    disconnect_calls: AtomicUsize,
    premature_disconnect: std::sync::atomic::AtomicBool,
    on_get_thread: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    on_get_thread_cancel: Mutex<Option<ReplyReadHook>>,
}

impl ReplyReadProvider {
    fn new(thread: GmailThread) -> Self {
        Self {
            thread: Mutex::new(thread),
            error: Mutex::new(None),
            get_thread_calls: AtomicUsize::new(0),
            active_provider_reads: AtomicUsize::new(0),
            configured: std::sync::atomic::AtomicBool::new(false),
            credentials: std::sync::atomic::AtomicBool::new(false),
            disconnect_calls: AtomicUsize::new(0),
            premature_disconnect: std::sync::atomic::AtomicBool::new(false),
            on_get_thread: Mutex::new(None),
            on_get_thread_cancel: Mutex::new(None),
        }
    }
}

impl GmailReadProvider for ReplyReadProvider {
    fn is_configured(&self) -> bool {
        self.configured.load(Ordering::SeqCst)
    }

    fn has_credentials(&self) -> Result<bool, MailError> {
        Ok(self.credentials.load(Ordering::SeqCst))
    }

    fn connect(&self, _cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        Err(MailError::AuthRequired)
    }

    fn disconnect(&self) -> Result<(), MailError> {
        self.disconnect_calls.fetch_add(1, Ordering::SeqCst);
        if self.active_provider_reads.load(Ordering::SeqCst) != 0 {
            self.premature_disconnect.store(true, Ordering::SeqCst);
        }
        self.credentials.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn profile(&self, _cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        Err(MailError::AuthRequired)
    }

    fn list_inbox(
        &self,
        _page_token: Option<&str>,
        _cancel: &CancelToken,
    ) -> Result<InboxPage, MailError> {
        Ok(InboxPage {
            thread_ids: Vec::new(),
            next_page_token: None,
        })
    }

    fn get_thread(
        &self,
        _thread_id: &str,
        cancel: &CancelToken,
    ) -> Result<Option<GmailThread>, MailError> {
        self.get_thread_calls.fetch_add(1, Ordering::SeqCst);
        self.active_provider_reads.fetch_add(1, Ordering::SeqCst);
        let result = (|| {
            let cancel_hook = self.on_get_thread_cancel.lock().unwrap().clone();
            if let Some(hook) = cancel_hook {
                hook(cancel);
            }
            let hook = self.on_get_thread.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook();
            }
            if let Some(error) = self.error.lock().unwrap().clone() {
                return Err(error);
            }
            Ok(Some(self.thread.lock().unwrap().clone()))
        })();
        self.active_provider_reads.fetch_sub(1, Ordering::SeqCst);
        result
    }

    fn history(
        &self,
        start_history_id: &str,
        _page_token: Option<&str>,
        _cancel: &CancelToken,
    ) -> Result<HistoryPage, GmailHistoryError> {
        Ok(HistoryPage {
            changed_thread_ids: Vec::new(),
            deleted_message_ids: Vec::new(),
            next_page_token: None,
            history_id: start_history_id.to_string(),
        })
    }
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "mail-core-reply-context-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ))
}

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
        },
    ];
    GmailThread {
        conversation: Conversation {
            conversation_ref: ConversationRef {
                account_id: "acct-reply".to_string(),
                conversation_id: "thread-reply".to_string(),
            },
            subject: "Synthetic reply context".to_string(),
            messages,
            is_in_inbox: true,
            is_read: Some(true),
            context_complete: Some(complete),
            unsupported_reason: None,
            retained_snapshot_at: None,
            reply_context: context,
            pending_operation_id: None,
        },
        inbox_message_ids: vec!["m-latest".to_string()],
        message_ids: Some(vec!["m-earlier".to_string(), "m-latest".to_string()]),
        unread_message_ids: Some(Vec::new()),
        history_id: "history-2".to_string(),
    }
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
    std::path::PathBuf,
    ConversationRef,
) {
    let dir = temp_dir(tag);
    let provider = Arc::new(ReplyReadProvider::new(thread(
        remote_context,
        remote_complete,
    )));
    let core = GmailCore::open(&dir, Arc::clone(&provider) as Arc<dyn GmailReadProvider>)
        .expect("core opens");
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

fn close(core: GmailCore, dir: std::path::PathBuf) {
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
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
    assert_eq!(provider.get_thread_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        core.load_reply_context(&target, "m-earlier"),
        Err(MailError::ReplyUnavailable)
    );
    assert_eq!(provider.get_thread_calls.load(Ordering::SeqCst), 0);
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
    assert_eq!(provider.get_thread_calls.load(Ordering::SeqCst), 1);
    assert_eq!(loaded.messages, before.messages);
    assert_eq!(loaded.subject, before.subject);
    assert_eq!(loaded.is_in_inbox, before.is_in_inbox);
    assert_eq!(
        core.inner.store.cursor().expect("cursor unchanged"),
        cursor_before
    );

    core.stop();
    drop(core);
    let reopened = GmailStore::open(&dir, Arc::new(SystemClock)).expect("reopen cache");
    assert_eq!(
        reopened
            .get_conversation(&target)
            .expect("restart reader")
            .reply_context,
        Some(reply_context("m-latest"))
    );
    drop(reopened);
    drop(provider);
    let _ = std::fs::remove_dir_all(dir);
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
    assert_eq!(provider.get_thread_calls.load(Ordering::SeqCst), 1);
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
    assert_eq!(provider.get_thread_calls.load(Ordering::SeqCst), 1);
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
    *provider.error.lock().unwrap() = Some(MailError::ProviderUnavailable);
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
        });
        newer_thread.inbox_message_ids.push("m-newer".to_string());
        newer_thread.message_ids = Some(vec![
            "m-earlier".to_string(),
            "m-latest".to_string(),
            "m-newer".to_string(),
        ]);
        *provider.on_get_thread.lock().unwrap() = Some(Arc::new(move || match race {
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
        }));
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
        *provider.on_get_thread_cancel.lock().unwrap() = Some(Arc::new(move |cancel| {
            entered_hook.wait();
            let observed = cancel.wait_until_cancelled(Duration::from_secs(10));
            cancel_tx
                .send(observed)
                .expect("test receiver remains open");
            cancelled_hook.wait();
            release_hook.wait();
            // Model a refresh response that commits credentials after the
            // caller was cancelled; cancellation cannot be trusted as a join.
            publishes_credentials
                .credentials
                .store(true, Ordering::SeqCst);
        }));
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
        provider.configured.store(true, Ordering::SeqCst);
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
        assert_eq!(provider.disconnect_calls.load(Ordering::SeqCst), 0);
        assert!(!provider.credentials.load(Ordering::SeqCst));

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
        assert!(!provider.premature_disconnect.load(Ordering::SeqCst));
        assert!(!provider.credentials.load(Ordering::SeqCst));
        assert_eq!(provider.disconnect_calls.load(Ordering::SeqCst), 1);
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
        let reopened = GmailCore::open(&dir, Arc::clone(&provider) as Arc<dyn GmailReadProvider>)
            .expect("profile reopens after disconnect");
        assert_eq!(reopened.account_status().unwrap().account, None);
        assert_eq!(
            reopened.account_status().unwrap().connection,
            ConnectionState::Disconnected
        );
        reopened.stop();
        drop(reopened);
        let _ = std::fs::remove_dir_all(dir);
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
        provider.configured.store(true, Ordering::SeqCst);
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
        assert_eq!(provider.disconnect_calls.load(Ordering::SeqCst), 0);
        assert!(!provider.premature_disconnect.load(Ordering::SeqCst));
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
        assert!(provider.credentials.load(Ordering::SeqCst));
        core.disconnect_account()
            .expect("retry succeeds after the timed-out read drained");
        assert!(!provider.credentials.load(Ordering::SeqCst));
        assert_eq!(core.inner.store.account().unwrap(), None);
        core.stop();
        drop(core);
        let _ = std::fs::remove_dir_all(dir);
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
