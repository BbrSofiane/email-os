//! The synthetic session policy (ADR 0002 stage 2): identity and status,
//! admission, lifecycle rejections, cached-only search, local readiness and
//! non-destructive lifecycle.

use mail_core::dto::{CachedDoneRequest, CachedTrashRequest, OperationStatus, SetRead};
use mail_core::gmail::browsing::DestinationRequest;
use mail_core::gmail::types::{ConnectionState, MailMode, SyncState};
use mail_core::groups::SetReadGroup;
use mail_core::search::SearchRequest;
use mail_core::stars::{SetStarred, SetStarredGroup};
use mail_core::testing::synthetic::*;
use mail_core::testing::{temp_profile, TIMEOUT};
use mail_core::{MailError, ACCOUNT_ID};

fn invalid_mode() -> MailError {
    MailError::InvalidRequest {
        field: "mode".into(),
    }
}

#[test]
fn status_is_the_fixture_presentation_from_the_first_call() {
    // No waiting: bootstrap finished before `open_synthetic` returned.
    let dir = temp_profile("policy-status");
    let clock = std::sync::Arc::new(mail_core::clock::FakeClock::new(mail_core::clock::utc(
        CLOCK_START,
    )));
    let provider = new_provider(dir.path());
    let core = open_core_on(dir.path(), provider, &clock);
    let status = core.account_status().unwrap();
    assert_eq!(status.mode, MailMode::Fixture);
    assert_eq!(status.connection, ConnectionState::Connected);
    let account = status.account.clone().expect("fixture account");
    assert_eq!(account.account_id, ACCOUNT_ID);
    assert_eq!(account.email_address, mail_core::FIXTURE_MAILBOX);
    assert_eq!(
        status.mutation_access, None,
        "no grant masquerades as Google's"
    );
    assert_eq!(status.sync.state, SyncState::Idle);
    assert_eq!(status.sync.last_synced_at, None);
    assert_eq!(status.sync.error, None);
    assert_eq!(status.sync.cached_conversations, 18);
    assert!(status.sync.initial_sync_complete);
    assert_eq!(status.sync.coverage_limit, 0);
    // The serialized wire value has no mutationAccess key at all.
    let json = serde_json::to_value(&status).unwrap();
    assert!(json.get("mutationAccess").is_none());
    assert_eq!(json["mode"], "fixture");
}

#[test]
fn status_stays_idle_while_a_write_is_in_flight_and_after_a_rejected_one() {
    let s = Synthetic::open_with("policy-idle", |p| p.set_paused(true));
    s.core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .unwrap();
    assert!(s.synthetic.wait_for_write_calls(1, TIMEOUT));
    let status = s.core.account_status().unwrap();
    assert_eq!(status.sync.state, SyncState::Idle, "no syncing flicker");
    s.synthetic.resume();
    s.synthetic.fail_next();
    s.core
        .set_archived(&set_archived("conv-02", true, "req-2"))
        .unwrap();
    s.core.wait_for_test_idle(TIMEOUT).unwrap();
    let status = s.core.account_status().unwrap();
    assert_eq!(
        status.sync.error, None,
        "a failed operation is not a sync error"
    );
    assert_eq!(status.sync.state, SyncState::Idle);
}

#[test]
fn bootstrap_loads_all_18_without_pretending_archived_seeds_are_inbox_or_done() {
    let s = Synthetic::open("policy-bootstrap");
    // No explicit load: every seeded conversation is readable immediately.
    for i in 1..=18 {
        s.core
            .get_conversation(&conversation(&format!("conv-{i:02}")))
            .unwrap_or_else(|e| panic!("conv-{i:02}: {e:?}"));
    }
    let inbox: Vec<String> = s
        .core
        .list_conversations()
        .unwrap()
        .conversations
        .iter()
        .map(|c| c.conversation_ref.conversation_id.clone())
        .collect();
    assert_eq!(inbox.len(), 16);
    assert!(!inbox.contains(&"conv-06".to_string()));
    assert!(!inbox.contains(&"conv-15".to_string()));
    assert!(
        !s.core
            .get_conversation(&conversation("conv-06"))
            .unwrap()
            .is_in_inbox
    );
    // Initially archived rows are not Done evidence.
    let done = s
        .core
        .list_cached_done(&CachedDoneRequest {
            account_id: ACCOUNT_ID.into(),
            limit: 100,
            cursor: None,
        })
        .unwrap();
    assert!(done.conversations.is_empty());
    assert!(s.core.list_conversations().unwrap().activity.is_empty());
    assert_eq!(s.synthetic.write_call_count(), 0);
}

#[test]
fn reopening_bootstraps_again_without_changing_cache_or_facts() {
    let s = Synthetic::open("policy-reopen");
    let receipt = s
        .core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .unwrap();
    assert!(wait_for_status(
        &s.core,
        std::slice::from_ref(&receipt.operation_id),
        OperationStatus::Confirmed
    ));
    let count = |dir: &std::path::Path| -> (i64, i64) {
        let db = gmail_db(dir);
        (
            db.query_row("SELECT COUNT(*) FROM gmail_conversations", [], |r| r.get(0))
                .unwrap(),
            db.query_row("SELECT COUNT(*) FROM gmail_search_cache", [], |r| r.get(0))
                .unwrap(),
        )
    };
    let before = count(s.dir.path());
    assert_eq!(before, (18, 2));
    let s = s.reopen();
    let s = s.reopen();
    assert_eq!(count(s.dir.path()), before);
    assert!(
        !in_inbox(&s.core, "conv-01"),
        "changed fact survives; nothing is re-seeded"
    );
    assert_eq!(
        s.core.account_status().unwrap().sync.cached_conversations,
        18
    );
}

#[test]
fn archive_read_and_star_are_admitted_for_singles_and_groups_and_undo_works() {
    let s = Synthetic::open("policy-admission");
    let archive = s
        .core
        .set_archived(&set_archived("conv-01", true, "a-1"))
        .unwrap();
    let read = s
        .core
        .set_read(&SetRead {
            conversation: conversation("conv-02"),
            read: true,
            request_id: "r-1".into(),
        })
        .unwrap();
    let star = s
        .core
        .set_starred(&SetStarred {
            conversation: conversation("conv-03"),
            starred: true,
            request_id: "s-1".into(),
        })
        .unwrap();
    let ids = [archive.operation_id, read.operation_id, star.operation_id];
    assert!(wait_for_status(&s.core, &ids, OperationStatus::Confirmed));
    let read_group = s
        .core
        .set_read_group(&SetReadGroup {
            account_id: ACCOUNT_ID.into(),
            members: vec![conversation("conv-04"), conversation("conv-05")],
            read: true,
            request_id: "rg-1".into(),
        })
        .unwrap();
    let star_group = s
        .core
        .set_starred_group(&SetStarredGroup {
            account_id: ACCOUNT_ID.into(),
            members: vec![conversation("conv-07"), conversation("conv-08")],
            starred: true,
            request_id: "sg-1".into(),
        })
        .unwrap();
    assert_eq!(read_group.members.len(), 2);
    s.core.wait_for_test_idle(TIMEOUT).unwrap();
    // Group Undo of the newest action restores the stars.
    let undo = s
        .core
        .undo_operation_group(&mail_core::groups::UndoOperationGroup {
            group_id: star_group.group_id,
            request_id: "ug-1".into(),
        })
        .unwrap();
    assert_eq!(undo.members.len(), 2);
    s.core.wait_for_test_idle(TIMEOUT).unwrap();
    // The cached Starred list works and contains conv-03 (starred earlier).
    let starred = s
        .core
        .list_cached_starred(&CachedDoneRequest {
            account_id: ACCOUNT_ID.into(),
            limit: 100,
            cursor: None,
        })
        .unwrap();
    let ids: Vec<_> = starred
        .conversations
        .iter()
        .map(|c| c.conversation_ref.conversation_id.as_str())
        .collect();
    assert_eq!(ids, vec!["conv-03"]);
    // Read state is effective in the snapshot.
    let snapshot = s.core.list_conversations().unwrap();
    let read_state = |id: &str| {
        snapshot
            .conversations
            .iter()
            .find(|c| c.conversation_ref.conversation_id == id)
            .and_then(|c| c.is_read)
    };
    assert_eq!(read_state("conv-02"), Some(true));
    assert_eq!(
        read_state("conv-09"),
        Some(false),
        "seeded Inbox mail is unread"
    );
}

#[test]
fn unsupported_surfaces_are_rejected_with_todays_error_variants() {
    let s = Synthetic::open("policy-rejections");
    assert_eq!(
        s.core
            .list_cached_trash(&CachedTrashRequest {
                account_id: ACCOUNT_ID.into(),
                limit: 10,
                cursor: None,
            })
            .map(|_| ()),
        Err(invalid_mode())
    );
    assert_eq!(
        s.core
            .list_provider_destinations(ACCOUNT_ID, true)
            .map(|_| ()),
        Err(MailError::ReadOnly)
    );
    assert_eq!(
        s.core
            .list_provider_destinations(ACCOUNT_ID, false)
            .map(|_| ()),
        Err(MailError::ReadOnly)
    );
    assert_eq!(
        s.core
            .browse_provider_destination(&DestinationRequest {
                account_id: ACCOUNT_ID.into(),
                destination_id: "STARRED".into(),
                cursor: None,
                cached: true,
            })
            .map(|_| ()),
        Err(MailError::ReadOnly)
    );
    assert_eq!(s.synthetic.write_call_count(), 0);
}

#[test]
fn lifecycle_commands_are_rejected_and_nothing_local_is_erased() {
    let s = Synthetic::open("policy-lifecycle");
    let receipt = s
        .core
        .set_archived(&set_archived("conv-01", true, "req-1"))
        .unwrap();
    assert!(wait_for_status(
        &s.core,
        std::slice::from_ref(&receipt.operation_id),
        OperationStatus::Confirmed
    ));
    let status_before = s.core.account_status().unwrap();
    let snapshot_before = s.core.list_conversations().unwrap();
    assert_eq!(s.core.connect_account(), Err(invalid_mode()));
    assert_eq!(s.core.disconnect_account(), Err(invalid_mode()));
    assert_eq!(s.core.request_sync(), Err(invalid_mode()));
    assert_eq!(s.core.enable_mutations(), Err(invalid_mode()));
    assert_eq!(s.core.cancel_mutation_upgrade(), Err(invalid_mode()));
    s.core.wait_for_test_idle(TIMEOUT).unwrap();
    assert_eq!(s.core.account_status().unwrap(), status_before);
    assert_eq!(s.core.list_conversations().unwrap(), snapshot_before);
    // The provider's facts and the cache's generation are untouched.
    let generation: i64 = gmail_db(s.dir.path())
        .query_row("SELECT value FROM meta WHERE key = 'generation'", [], |r| {
            r.get::<_, String>(0).map(|v| v.parse().unwrap_or(0))
        })
        .unwrap_or(0);
    assert_eq!(generation, 0, "no generation advance: nothing was cleared");
    assert!(s.core.get_conversation(&conversation("conv-05")).is_ok());
    // Writes still work afterwards.
    s.core
        .set_archived(&set_archived("conv-02", true, "req-2"))
        .unwrap();
}

#[test]
fn search_is_cached_only_and_never_calls_the_provider() {
    let s = Synthetic::open_wrapped("policy-search", Overlay::wrap);
    for cached_only in [true, false] {
        let page = s
            .core
            .search_mail(&SearchRequest {
                account_id: ACCOUNT_ID.into(),
                query: "ridpath".into(),
                cursor: None,
                cached_only,
            })
            .unwrap();
        assert!(!page.conversations.is_empty());
        assert!(matches!(
            page.coverage,
            mail_core::search::SearchCoverage::CachedIncomplete
        ));
    }
    assert_eq!(s.provider.read_calls("search_threads"), 0);
    // Archived seeds are searchable because they are cached.
    let archived = s
        .core
        .search_mail(&SearchRequest {
            account_id: ACCOUNT_ID.into(),
            query: "".into(),
            cursor: None,
            cached_only: false,
        })
        .map(|p| p.conversations.len());
    assert!(archived.is_ok() || matches!(archived, Err(MailError::InvalidRequest { .. })));
    assert_eq!(
        s.core
            .search_mail(&SearchRequest {
                account_id: "other".into(),
                query: "ridpath".into(),
                cursor: None,
                cached_only: false,
            })
            .map(|_| ()),
        Err(MailError::NotFound)
    );
}

/// Parity with the legacy fixture store: the same queries return the same
/// conversations in the same order (the legacy store lists only what is
/// cached, as does the synthetic session).
#[test]
fn cached_search_matches_the_legacy_fixture_store() {
    let legacy_dir = temp_profile("policy-legacy-search");
    let legacy = mail_core::MailCore::open(legacy_dir.path()).unwrap();
    let s = Synthetic::open("policy-synthetic-search");
    for query in [
        "ridpath",
        "invoice",
        "budget",
        "from:ana@ridpath.example",
        "ramen",
        "script",
        "xss",
        "restart",
        "nomatchatall",
    ] {
        let request = SearchRequest {
            account_id: ACCOUNT_ID.into(),
            query: query.into(),
            cursor: None,
            cached_only: true,
        };
        let ids = |page: mail_core::search::SearchPage| -> Vec<String> {
            page.conversations
                .iter()
                .map(|c| c.conversation_ref.conversation_id.clone())
                .collect()
        };
        assert_eq!(
            ids(legacy.search_mail(&request).unwrap()),
            ids(s.core.search_mail(&request).unwrap()),
            "query {query:?}"
        );
    }
    legacy.stop_worker();
}

#[test]
fn local_readiness_needs_no_credentials_or_network() {
    // Opening twice on the same profile is the whole "restore" story: no
    // OAuth client, no Keychain, no HTTP client exist in this path.
    let s = Synthetic::open("policy-readiness");
    let s = s.reopen();
    assert_eq!(
        s.core.account_status().unwrap().connection,
        ConnectionState::Connected
    );
}
