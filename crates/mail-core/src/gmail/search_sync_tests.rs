// Included in sync::worker_halt_tests: synthetic provider only, no HTTP/account access.
use std::sync::atomic::AtomicBool;

/// Runs on the calling thread's synchronous preflight change notification,
/// never on an unrelated worker notification or recursively during reconnect.
fn search_reconnect_on_preflight(
    core: &GmailCore,
    offline: bool,
) -> (GmailUnsubscribe, Arc<AtomicBool>) {
    let fired = Arc::new(AtomicBool::new(false));
    let once = fired.clone();
    let caller = std::thread::current().id();
    let reconnect = core.clone();
    let listener = core.subscribe(move || {
        if std::thread::current().id() != caller || once.swap(true, Ordering::SeqCst) {
            return;
        }
        reconnect.disconnect_account().unwrap();
        reconnect.connect_account().unwrap();
        assert!(until(|| reconnect.account_status().is_ok_and(|s| s
            .connection
            == ConnectionState::Connected
            && s.sync.initial_sync_complete
            && s.sync.state == SyncState::Idle)));
        if offline {
            reconnect.inner.ctrl.state.lock().unwrap().connection = ConnectionState::Disconnected;
        }
    });
    (listener, fired)
}

#[test]
fn search_deferred_single_rejects_same_account_reconnect_before_provider_read() {
    let (core, provider, dir) = search_test_core();
    let generation = core.inner.store.generation().unwrap();
    let reads = provider.search_reads.load(Ordering::SeqCst);
    let (listener, fired) = search_reconnect_on_preflight(&core, false);
    let command = SetRead {
        conversation: search_ref("search-000"),
        read: true,
        request_id: "old-lifecycle-read".into(),
    };
    assert_eq!(core.set_read(&command), Err(MailError::NotFound));
    assert!(fired.load(Ordering::SeqCst));
    assert!(core.inner.store.generation().unwrap() > generation);
    assert_eq!(provider.search_reads.load(Ordering::SeqCst), reads);
    assert!(core.list_conversations().unwrap().activity.is_empty());
    drop(listener);
    // A fresh explicit invocation in the new lifecycle remains valid.
    core.set_read(&command).unwrap();
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn search_deferred_offline_group_rejects_same_account_reconnect_without_accepting_cached_sibling() {
    let (core, provider, dir) = search_test_core();
    let reads = provider.search_reads.load(Ordering::SeqCst);
    let (listener, fired) = search_reconnect_on_preflight(&core, true);
    let command = crate::groups::SetReadGroup {
        account_id: TEST_ACCOUNT.into(),
        members: vec![search_ref(TEST_THREAD), search_ref("search-000")],
        read: false,
        request_id: "old-offline-group".into(),
    };
    assert_eq!(core.set_read_group(&command), Err(MailError::NotFound));
    assert!(fired.load(Ordering::SeqCst));
    assert_eq!(provider.search_reads.load(Ordering::SeqCst), reads);
    assert!(core.list_conversations().unwrap().activity.is_empty());
    assert!(core
        .get_operation_group(&crate::groups::GetOperationGroupRequest {
            account_id: TEST_ACCOUNT.into(),
            request_id: command.request_id.clone(),
        })
        .unwrap()
        .is_none());
    drop(listener);
    // Without a lifecycle transition, offline partial acceptance is unchanged.
    core.set_read_group(&command).unwrap();
    let status = core
        .get_operation_group(&crate::groups::GetOperationGroupRequest {
            account_id: TEST_ACCOUNT.into(),
            request_id: command.request_id,
        })
        .unwrap()
        .unwrap();
    assert!(status.members[0].rejection.is_none());
    assert_eq!(
        status.members[1].rejection,
        Some(crate::groups::GroupMemberRejection::ConversationMissing)
    );
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn search_deferred_provider_read_is_cancelled_by_real_disconnect_and_reconnect() {
    let (core, provider, dir) = search_test_core();
    let reconnect = core.clone();
    let generation = core.inner.store.generation().unwrap();
    let finished = Arc::new(Mutex::new(None));
    let completion = finished.clone();
    *provider.search_hook.lock().unwrap() = Some(Box::new(move || {
        let observer = reconnect.clone();
        let handle = std::thread::spawn(move || {
            reconnect.disconnect_account().unwrap();
            reconnect.connect_account().unwrap();
            assert!(until(|| reconnect.account_status().is_ok_and(|s| s
                .connection
                == ConnectionState::Connected
                && s.sync.initial_sync_complete
                && s.sync.state == SyncState::Idle)));
        });
        // Disconnect publishes cancellation and its generation checkpoint,
        // then waits for this real facade read registration to be dropped.
        assert!(until(
            || observer.inner.store.generation().unwrap() > generation
        ));
        *completion.lock().unwrap() = Some(handle);
    }));
    assert_eq!(
        core.set_read(&SetRead {
            conversation: search_ref("search-000"),
            read: true,
            request_id: "cancelled-action-read".into(),
        }),
        Err(MailError::NotFound)
    );
    finished.lock().unwrap().take().unwrap().join().unwrap();
    assert!(core.list_conversations().unwrap().activity.is_empty());
    assert_eq!(
        core.get_conversation(&search_ref("search-000")),
        Err(MailError::NotFound)
    );
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn search_deferred_final_transaction_fences_generation_but_allows_durable_replay() {
    for group in [false, true] {
        let (core, provider, dir) = search_test_core();
        // The read has finished and passed its cancellation check before the
        // final permission gate advances the real store's disconnect checkpoint.
        // This isolates the transactional fence from the provider-read guard.
        let inner = core.inner.clone();
        let gate_provider = provider.clone();
        *provider.search_hook.lock().unwrap() = Some(Box::new(move || {
            *gate_provider.mutation_hook.lock().unwrap() = Some(Box::new(move || {
                inner.store.advance_generation().unwrap();
            }));
        }));
        if group {
            assert_eq!(
                core.set_archived_group(&crate::groups::SetArchivedGroup {
                    account_id: TEST_ACCOUNT.into(),
                    members: vec![search_ref("search-000"), search_ref(TEST_THREAD)],
                    archived: true,
                    request_id: "final-group".into(),
                }),
                Err(MailError::NotFound)
            );
        } else {
            assert_eq!(
                core.set_read(&SetRead {
                    conversation: search_ref("search-000"),
                    read: true,
                    request_id: "final-single".into(),
                }),
                Err(MailError::NotFound)
            );
        }
        assert!(core.list_conversations().unwrap().activity.is_empty());
        assert_eq!(
            core.get_conversation(&search_ref("search-000")),
            Err(MailError::NotFound)
        );
        // Retained accepted commands replay even after a generation advance
        // (e.g. failed disconnect cleanup); observations must not precede replay.
        provider.block_history();
        // Preflight can leave a harmless empty operations pass in flight.
        // Wait for sync admission rather than racing its legitimate Busy gate.
        assert!(until(|| match core.request_sync() {
            Ok(()) => true,
            Err(MailError::Busy) => false,
            Err(error) => panic!("unexpected sync setup error: {error:?}"),
        }));
        assert!(provider.wait_for_history());
        let command = SetRead {
            conversation: search_ref("search-001"),
            read: true,
            request_id: "durable-before-generation".into(),
        };
        let receipt = core.set_read(&command).unwrap();
        let generation = core.inner.store.generation().unwrap();
        core.inner.store.advance_generation().unwrap();
        let reads = provider.search_reads.load(Ordering::SeqCst);
        assert_eq!(
            core.inner
                .store
                .accept_read_observed(
                    &command,
                    Some(&super::super::store::SearchObservation::Cached {
                        generation,
                        members: vec![search_ref("absent")],
                    })
                )
                .unwrap(),
            receipt
        );
        assert_eq!(core.set_read(&command).unwrap(), receipt);
        assert_eq!(provider.search_reads.load(Ordering::SeqCst), reads);
        provider.release_history();
        core.stop();
        drop(core);
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn search_evicted_recovery_context_accepts_fresh_local_setters_and_mixed_group_without_reads() {
    for error in [MailError::NetworkUnavailable, MailError::RateLimited] {
        let (core, provider, dir) = search_test_core();
        search_load_six_pages(&core);
        provider.block_history();
        core.request_sync().unwrap();
        assert!(provider.wait_for_history());
        let archived = SetArchived {
            conversation: search_ref("search-000"),
            archived: true,
            request_id: "recovery-archive".into(),
        };
        let original = core.set_archived(&archived).unwrap();
        // Real bounded search admission evicts the rehydrated body again;
        // operation targets/facts and its recovery snapshot remain pinned.
        let mut request = search_request();
        for _ in 0..6 {
            request.cursor = core.search_mail(&request).unwrap().next_cursor;
        }
        let snapshot = core.get_conversation(&search_ref("search-000")).unwrap();
        assert!(snapshot.retained_snapshot_at.is_some());
        assert_eq!(snapshot.messages[0].id, "message-search-000");
        assert_eq!(
            core.account_status().unwrap().connection,
            ConnectionState::Connected
        );
        let reads = provider.search_reads.load(Ordering::SeqCst);
        *provider.search_error.lock().unwrap() = Some(error);
        assert_eq!(core.set_archived(&archived).unwrap(), original);
        let restore = SetArchived {
            archived: false,
            request_id: "fresh-recovery-restore".into(),
            ..archived
        };
        let restored = core.set_archived(&restore).unwrap();
        assert_eq!(core.set_archived(&restore).unwrap(), restored);
        let read = SetRead {
            conversation: search_ref("search-000"),
            read: true,
            request_id: "fresh-recovery-read".into(),
        };
        let receipt = core.set_read(&read).unwrap();
        assert_eq!(core.set_read(&read).unwrap(), receipt);
        let group = crate::groups::SetReadGroup {
            account_id: TEST_ACCOUNT.into(),
            members: vec![search_ref("search-000"), search_ref("search-119")],
            read: false,
            request_id: "fresh-recovery-mixed-group".into(),
        };
        let receipt = core.set_read_group(&group).unwrap();
        assert_eq!(core.set_read_group(&group).unwrap(), receipt);
        assert_eq!(provider.search_reads.load(Ordering::SeqCst), reads);
        let mut targets = Vec::new();
        while let Some(record) = core.inner.store.claim_next_operation().unwrap() {
            assert_eq!(
                record.message_ids,
                vec![format!("message-{}", record.conversation_id)]
            );
            targets.push(record.conversation_id.clone());
            core.inner.store.confirm_operation(&record).unwrap();
        }
        targets.sort();
        assert_eq!(
            targets,
            vec![
                "search-000",
                "search-000",
                "search-000",
                "search-000",
                "search-119"
            ]
        );
        assert!(core
            .get_conversation(&search_ref("search-000"))
            .unwrap()
            .retained_snapshot_at
            .is_some());
        provider.release_history();
        core.stop();
        drop(core);
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn search_test_thread(id: &str) -> GmailThread {
    let mut thread = test_thread();
    thread.conversation.conversation_ref.conversation_id = id.into();
    thread.conversation.subject = format!("synthetic {id}");
    let message = format!("message-{id}");
    thread.conversation.messages[0].id = message.clone();
    thread.conversation.is_in_inbox = false;
    thread.conversation.is_read = Some(false);
    thread.inbox_message_ids.clear();
    thread.message_ids = Some(vec![message.clone()]);
    thread.unread_message_ids = Some(vec![message]);
    thread
}

fn search_test_core() -> (GmailCore, Arc<HaltTestProvider>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "mail-search-p1-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let provider = HaltTestProvider::new();
    let core = GmailCore::open(&dir, provider.clone()).unwrap();
    assert!(until(|| core
        .account_status()
        .is_ok_and(|s| s.connection == ConnectionState::Connected
            && s.sync.initial_sync_complete
            && s.sync.state == SyncState::Idle)));
    (core, provider, dir)
}

fn search_request() -> crate::search::SearchRequest {
    crate::search::SearchRequest {
        account_id: TEST_ACCOUNT.into(),
        query: "synthetic".into(),
        cursor: None,
        cached_only: false,
    }
}

fn search_ref(id: &str) -> ConversationRef {
    ConversationRef {
        account_id: TEST_ACCOUNT.into(),
        conversation_id: id.into(),
    }
}

fn search_load_six_pages(core: &GmailCore) {
    let mut request = search_request();
    for _ in 0..6 {
        let page = core.search_mail(&request).unwrap();
        assert_eq!(page.conversations.len(), 20);
        request.cursor = page.next_cursor;
    }
    assert!(request.cursor.is_none());
    assert_eq!(
        core.get_conversation(&search_ref("search-000")),
        Err(MailError::NotFound)
    );
    assert_eq!(
        core.list_conversations().unwrap().conversations.len(),
        1,
        "search doesn't widen inbox discovery"
    );
}

#[test]
fn search_evicted_exact_single_and_mixed_group_actions_rehydrate_atomically() {
    let (core, provider, dir) = search_test_core();
    search_load_six_pages(&core);
    // Hold serial execution so acceptance/target assertions are deterministic.
    provider.block_history();
    core.request_sync().unwrap();
    assert!(provider.wait_for_history());

    provider.set_mutation_access(false);
    let reads = provider
        .search_reads
        .load(std::sync::atomic::Ordering::SeqCst);
    let command = SetArchived {
        conversation: search_ref("search-000"),
        archived: true,
        request_id: "evicted-archive".into(),
    };
    assert_eq!(
        core.set_archived(&command),
        Err(MailError::PermissionRequired)
    );
    assert_eq!(
        provider
            .search_reads
            .load(std::sync::atomic::Ordering::SeqCst),
        reads
    );
    provider.set_mutation_access(true);
    let receipt = core.set_archived(&command).unwrap();
    assert_eq!(core.set_archived(&command).unwrap(), receipt);
    assert_eq!(
        provider
            .search_reads
            .load(std::sync::atomic::Ordering::SeqCst),
        reads + 1,
        "replay performs no provider reads"
    );
    core.set_read(&SetRead {
        conversation: search_ref("search-001"),
        read: true,
        request_id: "evicted-read".into(),
    })
    .unwrap();

    let group = crate::groups::SetReadGroup {
        account_id: TEST_ACCOUNT.into(),
        members: vec![
            search_ref("search-002"),
            search_ref("search-037"),
            search_ref("gone"),
        ],
        read: true,
        request_id: "mixed-evicted-read".into(),
    };
    let receipt = core.set_read_group(&group).unwrap();
    assert_eq!(core.set_read_group(&group).unwrap(), receipt);
    let status = core
        .get_operation_group(&crate::groups::GetOperationGroupRequest {
            account_id: TEST_ACCOUNT.into(),
            request_id: group.request_id.clone(),
        })
        .unwrap()
        .unwrap();
    assert_eq!(
        status.members[0].status,
        crate::groups::GroupMemberStatus::Queued
    );
    assert_eq!(
        status.members[1].status,
        crate::groups::GroupMemberStatus::Queued
    );
    assert_eq!(
        status.members[2].rejection,
        Some(crate::groups::GroupMemberRejection::ConversationMissing)
    );
    core.set_archived_group(&crate::groups::SetArchivedGroup {
        account_id: TEST_ACCOUNT.into(),
        members: vec![search_ref("search-003"), search_ref("search-118")],
        archived: true,
        request_id: "mixed-evicted-archive".into(),
    })
    .unwrap();

    // The unchanged worker sees exact message IDs captured by real store acceptance.
    let mut records = Vec::new();
    while let Some(record) = core.inner.store.claim_next_operation().unwrap() {
        assert_eq!(
            record.message_ids,
            vec![format!("message-{}", record.conversation_id)]
        );
        core.inner.store.confirm_operation(&record).unwrap();
        records.push(record.conversation_id);
    }
    records.sort();
    assert_eq!(
        records,
        vec![
            "search-000",
            "search-001",
            "search-002",
            "search-003",
            "search-037",
            "search-118"
        ]
    );
    // This already-cached selected member sat at the LRU tail during admission
    // of a missing sibling. Deferred eviction must preserve its accepted context.
    assert!(core
        .get_conversation(&search_ref("search-037"))
        .unwrap()
        .retained_snapshot_at
        .is_some());
    provider.release_history();
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn search_page_and_explicit_load_reject_concurrent_history_deletion() {
    let (core, provider, dir) = search_test_core();
    core.search_mail(&search_request()).unwrap();
    assert!(core.get_conversation(&search_ref("search-000")).is_ok());
    let inner = core.inner.clone();
    *provider.search_hook.lock().unwrap() = Some(Box::new(move || {
        let page = HistoryPage {
            changed_thread_ids: vec![],
            deleted_message_ids: vec!["message-search-000".into()],
            next_page_token: None,
            history_id: "after-delete".into(),
        };
        inner
            .store
            .apply_history_page(
                &page,
                &[ThreadFetch::Missing("search-000".into())],
                "history-1",
                inner.store.generation().unwrap(),
            )
            .unwrap();
    }));
    assert!(matches!(
        core.search_mail(&search_request()),
        Err(MailError::Busy)
    ));
    assert_eq!(
        core.get_conversation(&search_ref("search-000")),
        Err(MailError::NotFound)
    );
    assert_eq!(
        core.inner.store.cursor().unwrap().as_deref(),
        Some("after-delete")
    );

    let inner = core.inner.clone();
    *provider.search_hook.lock().unwrap() = Some(Box::new(move || {
        let page = HistoryPage {
            changed_thread_ids: vec![],
            deleted_message_ids: vec!["message-search-000".into()],
            next_page_token: None,
            history_id: "after-second-delete".into(),
        };
        inner
            .store
            .apply_history_page(
                &page,
                &[ThreadFetch::Missing("search-000".into())],
                "after-delete",
                inner.store.generation().unwrap(),
            )
            .unwrap();
    }));
    assert_eq!(
        core.load_search_conversation(&search_ref("search-000")),
        Err(MailError::Busy)
    );
    assert_eq!(
        core.get_conversation(&search_ref("search-000")),
        Err(MailError::NotFound)
    );
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn search_action_rehydration_rejects_concurrent_update_before_acceptance() {
    let (core, provider, dir) = search_test_core();
    search_load_six_pages(&core);
    let inner = core.inner.clone();
    *provider.search_hook.lock().unwrap() = Some(Box::new(move || {
        inner
            .store
            .apply_history_page(
                &HistoryPage {
                    changed_thread_ids: vec![],
                    deleted_message_ids: vec![],
                    next_page_token: None,
                    history_id: "advanced".into(),
                },
                &[],
                "history-1",
                inner.store.generation().unwrap(),
            )
            .unwrap();
    }));
    assert_eq!(
        core.set_read(&SetRead {
            conversation: search_ref("search-000"),
            read: true,
            request_id: "concurrent-action".into()
        }),
        Err(MailError::Busy)
    );
    assert!(core.list_conversations().unwrap().activity.is_empty());
    assert_eq!(
        core.get_conversation(&search_ref("search-000")),
        Err(MailError::NotFound)
    );
    // Explicit retry starts a fresh provider observation and succeeds.
    core.set_read(&SetRead {
        conversation: search_ref("search-000"),
        read: true,
        request_id: "concurrent-action".into(),
    })
    .unwrap();
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn search_known_expired_auth_requires_explicit_cached_only() {
    let (core, provider, dir) = search_test_core();
    core.search_mail(&search_request()).unwrap();
    provider.state.lock().unwrap().auth_expired = true;
    core.request_sync().unwrap();
    assert!(until(|| core
        .account_status()
        .is_ok_and(|s| s.connection == ConnectionState::AuthRequired)));
    let reads = provider
        .search_reads
        .load(std::sync::atomic::Ordering::SeqCst);
    assert!(matches!(
        core.search_mail(&search_request()),
        Err(MailError::AuthRequired)
    ));
    let cached = core
        .search_mail(&crate::search::SearchRequest {
            cached_only: true,
            ..search_request()
        })
        .unwrap();
    assert!(!cached.conversations.is_empty());
    assert!(matches!(
        cached.coverage,
        crate::search::SearchCoverage::CachedIncomplete
    ));
    assert_eq!(
        provider
            .search_reads
            .load(std::sync::atomic::Ordering::SeqCst),
        reads
    );
    // Intentional disconnected initial/offline fallback is unchanged.
    core.inner.ctrl.state.lock().unwrap().connection = ConnectionState::Disconnected;
    core.inner.ctrl.state.lock().unwrap().error = None;
    assert!(matches!(
        core.search_mail(&search_request()).unwrap().coverage,
        crate::search::SearchCoverage::CachedIncomplete
    ));
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}
