//! Deterministic Gmail cache/sync contract tests (docs/vertical-slice-02.md,
//! cache/sync seam): restart during initial/history pages, interrupted page
//! commits, cursor expiry with bounded rediscovery and stale-membership
//! reconciliation, external-client changes/deletion, offline cached reads,
//! account identity switching, serialized/coalesced sync, cancellation and
//! disconnect racing an in-flight call, and profile-lock exclusivity.
//!
//! All coordination uses provider pause gates, call-log barriers, and
//! bounded assertion loops; the fake `GmailReadProvider` is pure memory —
//! no test opens sockets, performs network I/O, or touches real
//! credentials. History ids are arbitrary opaque strings throughout.

use mail_core::testing::operations_fake::{FakeProvider as FakeGmail, ProfilePlan};
use mail_core::testing::{open_core as open_at, open_profile as open_core, until, TIMEOUT};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use mail_core::dto::{ConversationRef, Message};
use mail_core::error::MailError;
use mail_core::gmail::sync::{GmailCore, COVERAGE_LIMIT};
use mail_core::gmail::types::{
    AccountInfo, AccountStatus, ConnectionState, GmailThread, HistoryPage, InboxPage, MailMode,
    SyncState,
};

const ACCOUNT: &str = "acct-alpha-9f3";
const EMAIL: &str = "alpha@example.test";

// ------------------------------------------------------------- builders
use mail_core::testing::profile as gmail_profile;

fn msg(id: &str, sent_at: &str) -> Message {
    let mut message =
        mail_core::testing::message(id, "ada@example.test", sent_at, "plain text body");
    message.from.display_name = Some("Ada Sender".to_string());
    message.to.push(mail_core::dto::Address {
        display_name: None,
        mailbox: "me@example.test".to_string(),
    });
    message
}

fn thread(id: &str, history_id: &str, msgs: Vec<Message>, inbox_ids: &[&str]) -> GmailThread {
    let is_in_inbox = inbox_ids.iter().any(|id| msgs.iter().any(|m| m.id == **id));
    let newest = msgs
        .iter()
        .max_by(|a, b| (&a.sent_at, &a.id).cmp(&(&b.sent_at, &b.id)))
        .map(|m| m.from.clone());
    let mut thread = mail_core::testing::thread(ACCOUNT, id, msgs, inbox_ids, None, history_id);
    thread.newest_sender = newest;
    thread.message_ids = None;
    thread.conversation.subject = format!("subject {id}");
    thread.conversation.is_in_inbox = is_in_inbox;
    thread
}

fn inbox_page(thread_ids: &[&str], next_page_token: Option<&str>) -> InboxPage {
    InboxPage {
        thread_ids: thread_ids.iter().map(|s| s.to_string()).collect(),
        next_page_token: next_page_token.map(str::to_string),
    }
}

fn history_page(
    changed_thread_ids: &[&str],
    deleted_message_ids: &[&str],
    next_page_token: Option<&str>,
    history_id: &str,
) -> HistoryPage {
    HistoryPage {
        changed_thread_ids: changed_thread_ids.iter().map(|s| s.to_string()).collect(),
        deleted_message_ids: deleted_message_ids.iter().map(|s| s.to_string()).collect(),
        next_page_token: next_page_token.map(str::to_string),
        history_id: history_id.to_string(),
    }
}

fn conv_ref(conversation_id: &str) -> ConversationRef {
    ConversationRef {
        account_id: ACCOUNT.to_string(),
        conversation_id: conversation_id.to_string(),
    }
}

/// The shared two-page baseline inbox: thr-1a, thr-2b, thr-3c.
fn baseline_world(fake: &FakeGmail) {
    let mut inbox = HashMap::new();
    inbox.insert(
        None::<String>,
        inbox_page(&["thr-1a", "thr-2b"], Some("page-2")),
    );
    inbox.insert(Some("page-2".to_string()), inbox_page(&["thr-3c"], None));
    fake.set_inbox(inbox);

    let mut threads = HashMap::new();
    threads.insert(
        "thr-1a".to_string(),
        thread(
            "thr-1a",
            "hist-1000",
            vec![msg("m-1a1", "2026-01-01T10:00:00Z")],
            &["m-1a1"],
        ),
    );
    threads.insert(
        "thr-2b".to_string(),
        thread(
            "thr-2b",
            "hist-1000",
            vec![
                msg("m-2b1", "2026-01-02T10:00:00Z"),
                msg("m-2b2", "2026-01-03T10:00:00Z"),
            ],
            &["m-2b1", "m-2b2"],
        ),
    );
    let mut thr_3c = thread(
        "thr-3c",
        "hist-1000",
        vec![msg("m-3c1", "2026-01-04T10:00:00Z")],
        &["m-3c1"],
    );
    thr_3c.conversation.unsupported_reason = Some("html-only-body".to_string());
    threads.insert("thr-3c".to_string(), thr_3c);
    fake.set_threads(threads);

    let mut history = HashMap::new();
    history.insert(None::<String>, history_page(&[], &[], None, "hist-1001"));
    fake.set_history(history);
}

fn status(core: &GmailCore) -> AccountStatus {
    core.account_status().expect("account status")
}

fn inbox_ids(core: &GmailCore) -> Vec<String> {
    core.list_conversations()
        .expect("snapshot")
        .conversations
        .iter()
        .map(|c| c.conversation_ref.conversation_id.clone())
        .collect()
}

/// Waits until the initial discovery + catch-up pass completed for the
/// baseline world.
fn wait_initial_sync(core: &GmailCore) {
    assert!(
        until(|| {
            let st = status(core);
            st.connection == ConnectionState::Connected
                && st.sync.initial_sync_complete
                && st.sync.cached_conversations == 3
                && st.sync.state == SyncState::Idle
        }),
        "initial sync should complete: {:?}",
        status(core)
    );
    assert_eq!(inbox_ids(core).len(), 3);
}

// --------------------------------------------------------------- tests

#[test]
fn states_are_visible_and_rejections_are_typed() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    fake.set_configured(false);
    let (core, dir) = open_core("states", &fake);
    assert_eq!(status(&core).mode, MailMode::Gmail);
    assert_eq!(status(&core).connection, ConnectionState::NotConfigured);
    assert_eq!(status(&core).account, None);
    assert_eq!(core.connect_account(), Err(MailError::NotConfigured));
    core.stop();
    drop(core);

    // Configured but no credentials and no cached account: disconnected.
    fake.set_configured(true);
    fake.set_credentials(false);
    let (core, _dir) = open_core("states2", &fake);
    assert_eq!(status(&core).connection, ConnectionState::Disconnected);
    assert_eq!(core.request_sync(), Err(MailError::AuthRequired));

    // Connect enqueues and returns void acceptance before any outcome.
    fake.set_connect_plan(ProfilePlan::Error(MailError::AuthFailed));
    assert_eq!(core.connect_account(), Ok(()));
    assert!(
        until(|| {
            status(&core).connection == ConnectionState::AuthRequired
                && status(&core).sync.error == Some(MailError::AuthFailed)
        }),
        "auth failure visible: {:?}",
        status(&core)
    );
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn startup_restore_completes_bounded_discovery_and_catchup() {
    let (fake, profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("initial", &fake);
    assert_eq!(
        profile.history_id, "hist-1000",
        "baseline is an opaque string id"
    );
    wait_initial_sync(&core);

    let st = status(&core);
    assert_eq!(
        st.account,
        Some(AccountInfo {
            account_id: ACCOUNT.to_string(),
            email_address: EMAIL.to_string(),
        })
    );
    assert_eq!(st.sync.coverage_limit, COVERAGE_LIMIT);
    assert!(st.sync.last_synced_at.is_some());

    // Discovery listed the first page once, resumed at the committed token.
    assert_eq!(fake.calls_matching("list_inbox|-").len(), 1);
    assert_eq!(fake.calls_matching("list_inbox|page-2").len(), 1);
    // History catch-up ran from the pinned baseline after discovery.
    assert_eq!(fake.calls_matching("history|hist-1000|-").len(), 1);

    // Newest message first, plain-text disclosure fields present.
    let snapshot = core.list_conversations().expect("snapshot");
    assert_eq!(
        snapshot.conversations[0].conversation_ref.conversation_id,
        "thr-3c"
    );
    let conversation = core.get_conversation(&conv_ref("thr-3c")).expect("reader");
    assert_eq!(conversation.context_complete, Some(true));
    assert_eq!(
        conversation.unsupported_reason.as_deref(),
        Some("html-only-body")
    );
    assert_eq!(conversation.pending_operation_id, None);
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

/// BROWSE-01 contact context: Gmail summaries derive the primary correspondent
/// from the newest cached message in the ordered stack — never participants[0].
#[test]
fn gmail_summaries_derive_primary_correspondent_from_the_newest_message() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    let mut inbox = HashMap::new();
    inbox.insert(None::<String>, inbox_page(&["thr-self"], None));
    fake.set_inbox(inbox);

    let mut first = msg("m-self-1", "2026-01-05T10:00:00Z");
    first.from = mail_core::dto::Address {
        display_name: Some("Boris Thread".to_string()),
        mailbox: "boris@example.test".to_string(),
    };
    let mut self_authored = msg("m-self-2", "2026-01-06T10:00:00Z");
    self_authored.from = mail_core::dto::Address {
        display_name: Some("You".to_string()),
        mailbox: "me@example.test".to_string(),
    };
    let mut nameless = msg("m-nameless", "2026-01-07T10:00:00Z");
    nameless.from = mail_core::dto::Address {
        display_name: None,
        mailbox: "anon@example.test".to_string(),
    };

    let mut threads = HashMap::new();
    threads.insert(
        "thr-self".to_string(),
        thread(
            "thr-self",
            "hist-1000",
            vec![first, self_authored, nameless],
            &["m-self-1", "m-self-2", "m-nameless"],
        ),
    );
    fake.set_threads(threads);
    let mut history = HashMap::new();
    history.insert(None::<String>, history_page(&[], &[], None, "hist-1001"));
    fake.set_history(history);

    let (core, dir) = open_core("gmail-primary-correspondent", &fake);
    assert!(
        until(|| {
            let st = status(&core);
            st.connection == ConnectionState::Connected
                && st.sync.initial_sync_complete
                && st.sync.cached_conversations == 1
                && st.sync.state == SyncState::Idle
        }),
        "initial sync should complete: {:?}",
        status(&core)
    );
    let snapshot = core.list_conversations().expect("snapshot");
    let summary = snapshot
        .conversations
        .iter()
        .find(|c| c.conversation_ref.conversation_id == "thr-self")
        .expect("summary");
    assert_eq!(
        summary
            .primary_correspondent
            .as_ref()
            .map(|a| a.mailbox.as_str()),
        Some("anon@example.test"),
        "newest message's sender wins"
    );
    assert_eq!(
        summary
            .primary_correspondent
            .as_ref()
            .and_then(|a| a.display_name.clone()),
        None,
        "nullable display name is passed through, not fabricated"
    );
    assert_ne!(
        summary.participants[0].mailbox, "anon@example.test",
        "participants order must not be used as the primary correspondent"
    );
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn restored_credentials_for_another_account_never_sync_into_cached_profile() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("restore-account-mismatch", &fake);
    wait_initial_sync(&core);
    core.stop();
    drop(core);
    let list_calls_before = fake.calls_matching("list_inbox|").len();

    fake.set_profile_plan(ProfilePlan::Value(gmail_profile(
        "acct-beta-foreign",
        "beta@example.test",
        "foreign-history",
    )));
    let restored = open_at(dir.path(), &fake);
    assert!(
        until(|| {
            let state = status(&restored);
            state.connection == ConnectionState::Disconnected
                && state.sync.error
                    == Some(MailError::InvalidRequest {
                        field: "accountId".to_string(),
                    })
        }),
        "restored profile mismatch must fail closed: {:?}",
        status(&restored)
    );
    assert_eq!(
        inbox_ids(&restored).len(),
        3,
        "cached account A remains readable"
    );
    assert_eq!(
        status(&restored).account.as_ref().unwrap().account_id,
        ACCOUNT
    );
    assert_eq!(fake.calls_matching("list_inbox|").len(), list_calls_before);
    restored.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn restart_during_discovery_resumes_committed_pages_without_duplication() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    fake.set_paused_method(Some("get_thread"));
    fake.pause_thread(Some("thr-3c"));

    let (core, dir) = open_core("discovery-restart", &fake);
    assert!(
        fake.wait_for_calls("get_thread|thr-3c", 1),
        "worker paused fetching the second page"
    );
    // Simulate a crash before the second page commits.
    core.stop();
    drop(core);

    fake.set_paused_method(None);
    fake.pause_thread(None);
    let core = open_at(dir.path(), &fake);
    wait_initial_sync(&core);

    // Committed pages were not re-listed or re-fetched; the interrupted page
    // was re-listed from its committed token and applied exactly once.
    assert_eq!(
        fake.calls_matching("list_inbox|-").len(),
        1,
        "{:?}",
        fake.calls_matching("list_inbox")
    );
    assert_eq!(
        fake.calls_matching("list_inbox|page-2").len(),
        2,
        "{:?}",
        fake.calls_matching("list_inbox")
    );
    assert_eq!(fake.calls_matching("get_thread|thr-1a").len(), 1);
    assert_eq!(fake.calls_matching("get_thread|thr-2b").len(), 1);
    let snapshot = core.list_conversations().expect("snapshot");
    assert_eq!(snapshot.conversations.len(), 3);
    let conversation = core.get_conversation(&conv_ref("thr-2b")).expect("reader");
    assert_eq!(conversation.messages.len(), 2, "no duplicated messages");
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn discovery_caps_at_one_hundred_conversations() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    let mut inbox = HashMap::new();
    let first: Vec<String> = (1..=60).map(|i| format!("cap-{i:03}")).collect();
    let second: Vec<String> = (61..=120).map(|i| format!("cap-{i:03}")).collect();
    let first_refs: Vec<&str> = first.iter().map(String::as_str).collect();
    let second_refs: Vec<&str> = second.iter().map(String::as_str).collect();
    inbox.insert(None::<String>, inbox_page(&first_refs, Some("cap-page-2")));
    inbox.insert(
        Some("cap-page-2".to_string()),
        inbox_page(&second_refs, None),
    );
    fake.set_inbox(inbox);
    let mut threads = HashMap::new();
    for i in 1..=120 {
        let id = format!("cap-{i:03}");
        threads.insert(
            id.clone(),
            thread(
                &id,
                "hist-1000",
                vec![msg(&format!("m-{id}"), "2026-01-01T10:00:00Z")],
                &[&format!("m-{id}")],
            ),
        );
    }
    fake.set_threads(threads);

    let (core, dir) = open_core("cap", &fake);
    assert!(
        until(|| {
            let st = status(&core);
            st.sync.initial_sync_complete && st.sync.cached_conversations == 100
        }),
        "discovery caps at 100: {:?}",
        status(&core)
    );
    let st = status(&core);
    assert_eq!(st.sync.coverage_limit, COVERAGE_LIMIT);
    assert_eq!(
        core.list_conversations()
            .expect("snapshot")
            .conversations
            .len(),
        100
    );
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn rate_limit_mid_discovery_preserves_and_reuses_durable_progress() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    // Two pages; the second read of page 2 is rate limited mid-page.
    let mut inbox = HashMap::new();
    inbox.insert(
        None::<String>,
        inbox_page(&["thr-1a", "thr-2b"], Some("page-2")),
    );
    inbox.insert(
        Some("page-2".to_string()),
        inbox_page(&["thr-3c", "thr-4d"], None),
    );
    fake.set_inbox(inbox);
    let mut threads = HashMap::new();
    for id in ["thr-1a", "thr-2b", "thr-3c", "thr-4d"] {
        threads.insert(
            id.to_string(),
            thread(
                id,
                "hist-1000",
                vec![msg(&format!("m-{id}"), "2026-01-01T10:00:00Z")],
                &[&format!("m-{id}")],
            ),
        );
    }
    fake.set_threads(threads);
    let mut history = HashMap::new();
    history.insert(None::<String>, history_page(&[], &[], None, "hist-1001"));
    fake.set_history(history);
    fake.fail_thread("thr-4d", Some(MailError::RateLimited));

    let (core, dir) = open_core("rate-limit-mid-discovery", &fake);
    assert!(
        until(|| status(&core).sync.error == Some(MailError::RateLimited)),
        "rate limit visible: {:?}",
        status(&core)
    );

    // Threads fetched before the rate limit are durably cached even though
    // their page never completed, and discovery stays unfinished.
    let st = status(&core);
    assert!(!st.sync.initial_sync_complete);
    assert_eq!(st.sync.cached_conversations, 3);
    assert_eq!(fake.calls_matching("get_thread|thr-3c").len(), 1);

    core.stop();
    drop(core);
    // The limit clears; the restart resumes from the durable checkpoints.
    fake.fail_thread("thr-4d", None);
    let core = open_at(dir.path(), &fake);
    assert!(
        until(|| {
            let st = status(&core);
            st.connection == ConnectionState::Connected
                && st.sync.initial_sync_complete
                && st.sync.cached_conversations == 4
                && st.sync.state == SyncState::Idle
        }),
        "restart completes discovery: {:?}",
        status(&core)
    );

    // Page 1 was never re-listed or re-fetched; thr-3c was reused from
    // durable mid-page progress (never re-fetched); only the failed read
    // (recorded once, then retried) ran again.
    assert_eq!(
        fake.calls_matching("list_inbox|-").len(),
        1,
        "{:?}",
        fake.calls_matching("list_inbox")
    );
    assert_eq!(fake.calls_matching("list_inbox|page-2").len(), 2);
    assert_eq!(fake.calls_matching("get_thread|thr-1a").len(), 1);
    assert_eq!(fake.calls_matching("get_thread|thr-2b").len(), 1);
    assert_eq!(
        fake.calls_matching("get_thread|thr-3c").len(),
        1,
        "saved thread must not be refetched"
    );
    assert_eq!(fake.calls_matching("get_thread|thr-4d").len(), 2);
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn first_page_mid_page_failures_preserve_and_reuse_durable_progress() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    // The first (and only) inbox page fails on its second thread read; the
    // running checkpoint keeps a `None` page token across reopens.
    let mut inbox = HashMap::new();
    inbox.insert(None::<String>, inbox_page(&["thr-1a", "thr-2b"], None));
    fake.set_inbox(inbox);
    let mut threads = HashMap::new();
    for id in ["thr-1a", "thr-2b"] {
        threads.insert(
            id.to_string(),
            thread(
                id,
                "hist-1000",
                vec![msg(&format!("m-{id}"), "2026-01-01T10:00:00Z")],
                &[&format!("m-{id}")],
            ),
        );
    }
    fake.set_threads(threads);
    let mut history = HashMap::new();
    history.insert(None::<String>, history_page(&[], &[], None, "hist-1001"));
    fake.set_history(history);
    fake.fail_thread("thr-2b", Some(MailError::RateLimited));

    let (core, dir) = open_core("first-page-mid-page", &fake);
    // Failure 1: thr-1a is committed mid-page; discovery stays unfinished.
    assert!(
        until(|| status(&core).sync.error == Some(MailError::RateLimited)),
        "first rate limit visible: {:?}",
        status(&core)
    );
    let st = status(&core);
    assert!(!st.sync.initial_sync_complete);
    assert_eq!(st.sync.cached_conversations, 1);
    core.stop();
    drop(core);

    // Reopen onto a durable `running` state with no page token: discovery
    // must resume the first page, and the limit still holds (failure 2).
    let core = open_at(dir.path(), &fake);
    assert!(
        until(|| status(&core).sync.error == Some(MailError::RateLimited)),
        "second rate limit visible: {:?}",
        status(&core)
    );
    let st = status(&core);
    assert!(!st.sync.initial_sync_complete);
    assert_eq!(st.sync.cached_conversations, 1);
    core.stop();
    drop(core);

    // The limit clears; the second reopen completes discovery and catch-up.
    fake.fail_thread("thr-2b", None);
    let core = open_at(dir.path(), &fake);
    assert!(
        until(|| {
            let st = status(&core);
            st.connection == ConnectionState::Connected
                && st.sync.initial_sync_complete
                && st.sync.cached_conversations == 2
                && st.sync.state == SyncState::Idle
        }),
        "restart completes discovery: {:?}",
        status(&core)
    );

    // The first page was re-listed on every resumption, but the thread
    // saved by the mid-page commit was fetched exactly once, never
    // refetched by the retries that re-listed its page.
    assert_eq!(
        fake.calls_matching("list_inbox|-").len(),
        3,
        "{:?}",
        fake.calls_matching("list_inbox")
    );
    assert_eq!(
        fake.calls_matching("get_thread|thr-1a").len(),
        1,
        "saved thread must not be refetched"
    );
    // The failing thread is retried once per resumption (three list/fetch
    // passes total); the saved thread is never refetched.
    assert_eq!(fake.calls_matching("get_thread|thr-2b").len(), 3);
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn capped_expiry_rediscovery_drops_unseen_cached_inbox_threads_before_rebasing() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    let old_ids: Vec<String> = (1..=100).map(|n| format!("old-{n:03}")).collect();
    let old_refs: Vec<&str> = old_ids.iter().map(String::as_str).collect();
    let mut inbox = HashMap::new();
    inbox.insert(None::<String>, inbox_page(&old_refs, None));
    fake.set_inbox(inbox);
    let mut threads = HashMap::new();
    for id in &old_ids {
        let message_id = format!("m-{id}");
        threads.insert(
            id.clone(),
            thread(
                id,
                "hist-1000",
                vec![msg(&message_id, "2026-01-01T00:00:00Z")],
                &[&message_id],
            ),
        );
    }
    fake.set_threads(threads);
    fake.set_history(HashMap::from([(
        None,
        history_page(&[], &[], None, "hist-1000"),
    )]));

    let (core, dir) = open_core("expiry-capped-cache", &fake);
    assert!(until(|| {
        let state = status(&core);
        state.connection == ConnectionState::Connected
            && state.sync.initial_sync_complete
            && state.sync.cached_conversations == 100
            && state.sync.state == SyncState::Idle
    }));

    // History adds seven newer inbox threads. The bounded cache is full, but
    // old-050 remains cached and can later demonstrate stale membership.
    let added_ids: Vec<String> = (1..=7).map(|n| format!("new-{n:02}")).collect();
    let added_refs: Vec<&str> = added_ids.iter().map(String::as_str).collect();
    let mut added_threads = HashMap::new();
    for id in &added_ids {
        let message_id = format!("m-{id}");
        added_threads.insert(
            id.clone(),
            thread(
                id,
                "hist-1001",
                vec![msg(&message_id, "2026-03-01T00:00:00Z")],
                &[&message_id],
            ),
        );
    }
    fake.set_threads(added_threads);
    fake.set_history(HashMap::from([(
        None,
        history_page(&added_refs, &[], None, "hist-1001"),
    )]));
    assert_eq!(core.request_sync(), Ok(()));
    assert!(until(|| {
        core.get_conversation(&conv_ref("new-07")).is_ok()
            && status(&core).sync.cached_conversations == 100
            && status(&core).sync.state == SyncState::Idle
    }));
    assert!(core.get_conversation(&conv_ref("old-050")).is_ok());
    // The added-thread history batch is complete; subsequent cursor reads
    // return an empty page based on their requested opaque history id.
    fake.set_history(HashMap::new());

    // old-050 was archived while history cursor hist-1001 expired. More than
    // 100 current inbox threads remain, so rediscovery is capped and must
    // reconcile unseen prior cache entries before pinning the new baseline.
    let mut current_ids: Vec<String> = old_ids
        .iter()
        .filter(|id| id.as_str() != "old-050")
        .cloned()
        .collect();
    current_ids.extend(added_ids);
    current_ids.extend(["extra-01".to_owned(), "extra-02".to_owned()]);
    let page1_refs: Vec<&str> = current_ids[..100].iter().map(String::as_str).collect();
    let page2_refs: Vec<&str> = current_ids[100..].iter().map(String::as_str).collect();
    let mut rediscovery = HashMap::new();
    rediscovery.insert(
        None::<String>,
        inbox_page(&page1_refs, Some("inbox-page-2")),
    );
    rediscovery.insert(
        Some("inbox-page-2".to_owned()),
        inbox_page(&page2_refs, None),
    );
    fake.set_inbox(rediscovery);
    let mut current_threads = HashMap::new();
    for id in &current_ids {
        let message_id = format!("m-{id}");
        let sent_at = if id.starts_with("extra-") {
            "2026-04-01T00:00:00Z"
        } else if id.starts_with("new-") {
            "2026-03-01T00:00:00Z"
        } else {
            "2026-01-01T00:00:00Z"
        };
        current_threads.insert(
            id.clone(),
            thread(
                id,
                "hist-2000",
                vec![msg(&message_id, sent_at)],
                &[&message_id],
            ),
        );
    }
    fake.set_threads(current_threads);
    fake.set_profile_plan(ProfilePlan::Value(gmail_profile(
        ACCOUNT,
        EMAIL,
        "hist-2000",
    )));
    fake.expire_history_start("hist-1001");
    assert_eq!(core.request_sync(), Ok(()));
    assert!(
        until(|| {
            status(&core).sync.state == SyncState::Idle
                && status(&core).sync.cached_conversations == 100
                && fake.calls_matching("history|hist-2000|-").len() == 1
                && !inbox_ids(&core).iter().any(|id| id == "old-050")
        }),
        "capped rediscovery status: {:?}",
        status(&core)
    );
    assert_eq!(
        core.get_conversation(&conv_ref("old-050")),
        Err(MailError::NotFound)
    );

    // The cursor is now beyond the expired change. A subsequent catch-up does
    // not rediscover, and the archived thread must still remain absent.
    let discovery_calls = fake.calls_matching("list_inbox|-").len();
    assert_eq!(core.request_sync(), Ok(()));
    assert!(until(|| {
        fake.calls_matching("history|hist-2000|-").len() == 2
            && status(&core).sync.state == SyncState::Idle
    }));
    assert!(!inbox_ids(&core).iter().any(|id| id == "old-050"));
    assert_eq!(
        fake.calls_matching("list_inbox|-").len(),
        discovery_calls,
        "rediscovery unexpectedly reran: list={:?} history={:?}",
        fake.calls_matching("list_inbox|"),
        fake.calls_matching("history|")
    );
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn history_catch_up_reflects_external_changes_deletions_and_archives() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("external", &fake);
    wait_initial_sync(&core);

    // An external client added a message, archived thr-1a, and deleted
    // thr-3c's only message (removing the conversation).
    let mut threads = HashMap::new();
    threads.insert(
        "thr-1a".to_string(),
        thread(
            "thr-1a",
            "hist-1001",
            vec![msg("m-1a1", "2026-01-01T10:00:00Z")],
            &[],
        ),
    );
    threads.insert(
        "thr-2b".to_string(),
        thread(
            "thr-2b",
            "hist-1001",
            vec![
                msg("m-2b1", "2026-01-02T10:00:00Z"),
                msg("m-2b3", "2026-01-05T10:00:00Z"),
            ],
            &["m-2b1", "m-2b3"],
        ),
    );
    threads.insert(
        "thr-3c".to_string(),
        thread(
            "thr-3c",
            "hist-1001",
            vec![msg("m-3c1", "2026-01-04T10:00:00Z")],
            &["m-3c1"],
        ),
    );
    fake.set_threads(threads);
    let mut history = HashMap::new();
    history.insert(
        None::<String>,
        history_page(&["thr-1a", "thr-2b"], &["m-3c1"], None, "hist-1002"),
    );
    fake.set_history(history);

    assert_eq!(core.request_sync(), Ok(()), "request_sync enqueues");
    assert!(
        until(|| {
            let ids = inbox_ids(&core);
            ids.len() == 1 && ids[0] == "thr-2b" && status(&core).sync.state == SyncState::Idle
        }),
        "external changes applied: {:?}",
        inbox_ids(&core)
    );
    assert_eq!(
        status(&core).sync.cached_conversations,
        2,
        "thr-3c removed, thr-1a cached"
    );
    let archived = core
        .get_conversation(&conv_ref("thr-1a"))
        .expect("archived cached");
    assert!(!archived.is_in_inbox);
    match core.get_conversation(&conv_ref("thr-3c")) {
        Err(MailError::NotFound) => {}
        other => panic!("deleted conversation must disappear, got {other:?}"),
    }
    let updated = core.get_conversation(&conv_ref("thr-2b")).expect("updated");
    assert_eq!(
        updated
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec!["m-2b1", "m-2b3"]
    );
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn history_does_not_import_new_archived_thread_bodies_into_the_bounded_cache() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("history-archived-thread", &fake);
    wait_initial_sync(&core);

    fake.set_threads(HashMap::from([(
        "archived-only".to_owned(),
        thread(
            "archived-only",
            "hist-1001",
            vec![msg("archived-message", "2026-01-08T00:00:00Z")],
            &[],
        ),
    )]));
    fake.set_history(HashMap::from([(
        None,
        history_page(&["archived-only"], &[], None, "hist-1002"),
    )]));
    assert_eq!(core.request_sync(), Ok(()));
    assert!(
        until(|| {
            status(&core).sync.state == SyncState::Idle
                && fake.calls_matching("history|").len() >= 2
                && core.get_conversation(&conv_ref("archived-only")) == Err(MailError::NotFound)
        }),
        "history update state={:?} calls={:?} cached={:?}",
        status(&core),
        fake.calls_matching("history|"),
        core.get_conversation(&conv_ref("archived-only"))
    );
    assert_eq!(status(&core).sync.cached_conversations, 3);
    let visible = inbox_ids(&core);
    assert_eq!(visible.len(), 3);
    assert!(!visible.iter().any(|id| id == "archived-only"));
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn history_cursor_only_advances_after_all_pages_and_resumes_mid_batch() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("batch-restart", &fake);
    wait_initial_sync(&core);

    // A two-page history batch: the cursor may only advance after page 2.
    let mut threads = HashMap::new();
    threads.insert(
        "thr-1a".to_string(),
        thread(
            "thr-1a",
            "hist-1001",
            vec![
                msg("m-1a1", "2026-01-01T10:00:00Z"),
                msg("m-1a2", "2026-01-06T10:00:00Z"),
            ],
            &["m-1a1", "m-1a2"],
        ),
    );
    threads.insert(
        "thr-2b".to_string(),
        thread(
            "thr-2b",
            "hist-1001",
            vec![
                msg("m-2b1", "2026-01-02T10:00:00Z"),
                msg("m-2b3", "2026-01-07T10:00:00Z"),
            ],
            &["m-2b1", "m-2b3"],
        ),
    );
    threads.insert(
        "thr-3c".to_string(),
        thread(
            "thr-3c",
            "hist-1001",
            vec![msg("m-3c1", "2026-01-04T10:00:00Z")],
            &["m-3c1"],
        ),
    );
    fake.set_threads(threads);
    let mut history = HashMap::new();
    history.insert(
        None::<String>,
        history_page(&["thr-1a"], &[], Some("hist-page-2"), "hist-1002"),
    );
    history.insert(
        Some("hist-page-2".to_string()),
        history_page(&["thr-2b"], &[], None, "hist-1003"),
    );
    fake.set_history(history);
    fake.set_paused_method(Some("get_thread"));
    fake.pause_thread(Some("thr-2b"));

    assert_eq!(core.request_sync(), Ok(()));
    assert!(
        fake.wait_for_calls("get_thread|thr-2b", 1),
        "paused mid-batch after page 1 committed"
    );
    core.stop();
    drop(core);
    fake.set_paused_method(None);
    fake.pause_thread(None);

    let core = open_at(dir.path(), &fake);
    assert!(
        until(|| {
            core.get_conversation(&conv_ref("thr-2b"))
                .map(|c| c.messages.iter().any(|m| m.id == "m-2b3"))
                .unwrap_or(false)
                && status(&core).sync.state == SyncState::Idle
        }),
        "resumed batch applies: {:?}",
        status(&core)
    );
    // The resume replayed the SAME batch start (cursor had not advanced
    // mid-batch) with the committed page token; page 1 was not re-fetched.
    let history_calls = fake.calls_matching("history|");
    assert_eq!(
        history_calls.len(),
        3,
        "{history_calls:?} full: {:?}",
        fake.state.lock().expect("log").calls
    );
    assert_eq!(history_calls[0], "history|hist-1000|-");
    assert_eq!(history_calls[1], "history|hist-1001|-");
    assert_eq!(history_calls[2], "history|hist-1001|hist-page-2");
    // thr-1a was fetched exactly twice overall (initial discovery + batch
    // page 1); a third fetch would mean page 1 was replayed after restart.
    assert_eq!(
        fake.calls_matching("get_thread|thr-1a").len(),
        2,
        "page 1 not replayed"
    );
    let updated = core.get_conversation(&conv_ref("thr-2b")).expect("updated");
    assert!(updated.messages.iter().any(|m| m.id == "m-2b3"));
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn cursor_expiry_triggers_bounded_rediscovery_and_reconciles_stale_members() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("expiry", &fake);
    wait_initial_sync(&core);

    // External client archived thr-3c and a new thr-4d arrived while the
    // cached cursor was expired server-side.
    let mut inbox = HashMap::new();
    inbox.insert(
        None::<String>,
        inbox_page(&["thr-1a", "thr-2b", "thr-4d"], None),
    );
    fake.set_inbox(inbox);
    let mut threads = HashMap::new();
    threads.insert(
        "thr-1a".to_string(),
        thread(
            "thr-1a",
            "hist-1001",
            vec![msg("m-1a1", "2026-01-01T10:00:00Z")],
            &["m-1a1"],
        ),
    );
    threads.insert(
        "thr-2b".to_string(),
        thread(
            "thr-2b",
            "hist-1001",
            vec![
                msg("m-2b1", "2026-01-02T10:00:00Z"),
                msg("m-2b2", "2026-01-03T10:00:00Z"),
            ],
            &["m-2b1", "m-2b2"],
        ),
    );
    threads.insert(
        "thr-4d".to_string(),
        thread(
            "thr-4d",
            "hist-1001",
            vec![msg("m-4d1", "2026-01-07T10:00:00Z")],
            &["m-4d1"],
        ),
    );
    fake.set_threads(threads);
    let mut history = HashMap::new();
    history.insert(None::<String>, history_page(&[], &[], None, "hist-2001"));
    fake.set_history(history);
    fake.expire_history_start("hist-1001");
    fake.set_profile_plan(ProfilePlan::Value(gmail_profile(
        ACCOUNT,
        EMAIL,
        "hist-2000",
    )));

    assert_eq!(core.request_sync(), Ok(()));
    assert!(
        until(|| {
            let ids = inbox_ids(&core);
            ids.contains(&"thr-4d".to_string())
                && !ids.contains(&"thr-3c".to_string())
                && status(&core).sync.state == SyncState::Idle
        }),
        "rediscovery reconciles stale members: {:?}",
        inbox_ids(&core)
    );
    // Rediscovery actually ran from a fresh baseline; the stale member was
    // reconciled instead of silently skipped, and the cursor moved forward.
    assert_eq!(fake.calls_matching("list_inbox|-").len(), 2);
    assert_eq!(fake.calls_matching("history|hist-2000|-").len(), 1);
    assert_eq!(
        status(&core).sync.cached_conversations,
        4,
        "archived thread stays cached"
    );
    assert!(status(&core).sync.initial_sync_complete);
    assert!(fake.wait_until_idle());
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn cached_reads_survive_offline_and_auth_errors() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("offline", &fake);
    wait_initial_sync(&core);

    fake.set_sticky_error(Some(MailError::NetworkUnavailable));
    assert_eq!(core.request_sync(), Ok(()));
    assert!(
        until(|| {
            let st = status(&core);
            st.sync.state == SyncState::Error
                && st.sync.error == Some(MailError::NetworkUnavailable)
        }),
        "sync error visible: {:?}",
        status(&core).sync
    );
    // Connection stays connected for network failures; cache stays readable.
    assert_eq!(status(&core).connection, ConnectionState::Connected);
    assert_eq!(
        core.list_conversations()
            .expect("snapshot")
            .conversations
            .len(),
        3
    );
    assert!(core.get_conversation(&conv_ref("thr-2b")).is_ok());

    // Credential/auth failure flips the connection hint but never the cache.
    fake.set_sticky_error(Some(MailError::AuthRequired));
    assert_eq!(core.request_sync(), Ok(()));
    assert!(
        until(|| status(&core).connection == ConnectionState::AuthRequired),
        "auth required visible: {:?}",
        status(&core)
    );
    assert_eq!(core.request_sync(), Err(MailError::AuthRequired));
    assert_eq!(
        core.list_conversations()
            .expect("snapshot")
            .conversations
            .len(),
        3
    );
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn account_identity_switch_is_rejected_fail_closed() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("identity", &fake);
    wait_initial_sync(&core);

    // The provider now reports a different Google account: fail closed.
    fake.set_connect_plan(ProfilePlan::Value(gmail_profile(
        "acct-beta-22",
        "beta@example.test",
        "hist-9999",
    )));
    assert_eq!(core.connect_account(), Ok(()));
    assert!(
        until(|| {
            let st = status(&core);
            st.connection == ConnectionState::Disconnected
                && st.sync.error
                    == Some(MailError::InvalidRequest {
                        field: "accountId".to_string(),
                    })
        }),
        "identity switch rejected and visible: {:?}",
        status(&core)
    );
    // Existing account and cache are untouched.
    assert_eq!(
        status(&core).account,
        Some(AccountInfo {
            account_id: ACCOUNT.to_string(),
            email_address: EMAIL.to_string(),
        })
    );
    assert_eq!(
        core.list_conversations()
            .expect("snapshot")
            .conversations
            .len(),
        3
    );
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn discovery_rejects_repeated_page_tokens_without_spinning() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    let mut inbox = HashMap::new();
    inbox.insert(None, inbox_page(&[], Some("cycle")));
    inbox.insert(Some("cycle".to_string()), inbox_page(&[], Some("cycle")));
    fake.set_inbox(inbox);
    let (core, dir) = open_core("discovery-token-cycle", &fake);
    assert!(
        until(|| {
            let state = status(&core);
            state.sync.error == Some(MailError::InvalidProviderResponse)
                && state.sync.state == SyncState::Error
        }),
        "repeated discovery cursor must fail boundedly: {:?}",
        status(&core)
    );
    assert_eq!(fake.calls_matching("list_inbox|-").len(), 1);
    assert_eq!(fake.calls_matching("list_inbox|cycle").len(), 1);
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn discovery_page_budget_yields_with_each_checkpoint_durable() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    let mut pages = HashMap::new();
    for index in 0..100 {
        let incoming = if index == 0 {
            None
        } else {
            Some(format!("p{}", index - 1))
        };
        pages.insert(incoming, inbox_page(&[], Some(&format!("p{index}"))));
    }
    fake.set_inbox(pages);
    let (core, dir) = open_core("discovery-page-budget", &fake);
    assert!(until(
        || status(&core).sync.error == Some(MailError::InvalidProviderResponse)
    ));
    assert_eq!(fake.calls_matching("list_inbox|").len(), 100);
    assert_eq!(status(&core).sync.state, SyncState::Error);
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn history_rejects_repeated_page_tokens_without_advancing_cursor() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let mut history = HashMap::new();
    history.insert(None, history_page(&[], &[], Some("cycle"), "hist-1001"));
    history.insert(
        Some("cycle".to_string()),
        history_page(&[], &[], Some("cycle"), "hist-1002"),
    );
    fake.set_history(history);
    let (core, dir) = open_core("history-token-cycle", &fake);
    assert!(
        until(|| {
            let state = status(&core);
            state.sync.error == Some(MailError::InvalidProviderResponse)
                && state.sync.initial_sync_complete
        }),
        "repeated history cursor must fail boundedly: {:?}",
        status(&core)
    );
    assert_eq!(fake.calls_matching("history|").len(), 2);
    assert_eq!(status(&core).sync.state, SyncState::Error);
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn disconnect_from_pass_start_hint_cancels_the_published_dispatch_token() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    fake.set_credentials(false);
    let (core, dir) = open_core("dispatch-cancel", &fake);
    let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let fired_from_listener = Arc::clone(&fired);
    let callback_core = core.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let _subscription = core.subscribe(move || {
        if status(&callback_core).sync.state == SyncState::Syncing
            && !fired_from_listener.swap(true, Ordering::SeqCst)
        {
            let disconnect_core = callback_core.clone();
            let tx = tx.clone();
            std::thread::spawn(move || {
                let _ = tx.send(disconnect_core.disconnect_account());
            });
        }
    });
    fake.set_paused_method(Some("connect"));
    assert_eq!(core.connect_account(), Ok(()));
    assert_eq!(
        rx.recv_timeout(TIMEOUT).expect("disconnect completes"),
        Ok(())
    );
    assert!(
        fired.load(Ordering::SeqCst),
        "worker dispatched its active state"
    );
    assert_eq!(fake.disconnect_calls(), 1);
    assert_eq!(status(&core).connection, ConnectionState::Disconnected);
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn subscribers_receive_a_progress_hint_after_history_checkpoint_before_next_page_finishes() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("sync-progress-hint", &fake);
    wait_initial_sync(&core);
    let notifications = Arc::new(AtomicUsize::new(0));
    let notifications_for_listener = Arc::clone(&notifications);
    let _subscription = core.subscribe(move || {
        notifications_for_listener.fetch_add(1, Ordering::SeqCst);
    });
    let before = notifications.load(Ordering::SeqCst);
    let mut history = HashMap::new();
    history.insert(
        None,
        history_page(&["thr-1a"], &[], Some("history-page-2"), "hist-1002"),
    );
    history.insert(
        Some("history-page-2".to_string()),
        history_page(&["thr-2b"], &[], None, "hist-1003"),
    );
    fake.set_history(history);
    fake.set_paused_method(Some("get_thread"));
    fake.pause_thread(Some("thr-2b"));
    assert_eq!(core.request_sync(), Ok(()));
    assert!(
        fake.wait_for_calls("get_thread|thr-2b", 1),
        "second-page fetch is paused"
    );
    assert!(until(|| notifications.load(Ordering::SeqCst) >= before + 2));
    assert_eq!(status(&core).sync.state, SyncState::Syncing);
    fake.set_paused_method(None);
    fake.pause_thread(None);
    assert!(fake.wait_until_idle());
    assert!(until(|| status(&core).sync.state == SyncState::Idle));
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn subscribers_observe_sync_start_before_a_paused_provider_call_returns() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("sync-start-hint", &fake);
    wait_initial_sync(&core);
    let notifications = Arc::new(AtomicUsize::new(0));
    let notifications_for_listener = Arc::clone(&notifications);
    let _subscription = core.subscribe(move || {
        notifications_for_listener.fetch_add(1, Ordering::SeqCst);
    });
    let before = notifications.load(Ordering::SeqCst);
    fake.set_paused_method(Some("history"));
    assert_eq!(core.request_sync(), Ok(()));
    assert!(
        fake.wait_for_inflight(1),
        "history call reached its pause gate"
    );
    assert!(until(|| notifications.load(Ordering::SeqCst) > before));
    assert_eq!(status(&core).sync.state, SyncState::Syncing);
    fake.set_paused_method(None);
    assert!(fake.wait_until_idle());
    assert!(until(|| status(&core).sync.state == SyncState::Idle));
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn history_page_budget_yields_after_durable_checkpoints() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("history-page-budget", &fake);
    wait_initial_sync(&core);
    let mut pages = HashMap::new();
    for index in 0..100 {
        let incoming = if index == 0 {
            None
        } else {
            Some(format!("h{}", index - 1))
        };
        pages.insert(
            incoming,
            history_page(
                &[],
                &[],
                Some(&format!("h{index}")),
                &format!("hist-page-{index}"),
            ),
        );
    }
    fake.set_history(pages);
    assert_eq!(core.request_sync(), Ok(()));
    assert!(until(
        || status(&core).sync.error == Some(MailError::InvalidProviderResponse)
    ));
    assert_eq!(fake.calls_matching("history|hist-1001|").len(), 100);
    assert_eq!(status(&core).sync.state, SyncState::Error);
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn sync_is_serial_and_in_flight_requests_reject_as_busy() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    fake.set_paused_method(Some("get_thread"));
    fake.pause_thread(Some("thr-3c"));

    let (core, dir) = open_core("serial", &fake);
    assert!(
        fake.wait_for_calls("get_thread|thr-3c", 1),
        "initial pass paused mid-discovery"
    );
    // One pass in flight: further requests reject as busy, no concurrency.
    assert_eq!(core.request_sync(), Err(MailError::Busy));
    assert_eq!(core.connect_account(), Err(MailError::Busy));
    assert_eq!(
        fake.calls_matching("connect").len(),
        0,
        "no second worker pass"
    );

    fake.set_paused_method(None);
    fake.pause_thread(None);
    wait_initial_sync(&core);
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn disconnect_barrier_rejects_connect_and_sync_until_cleanup_finishes() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("disconnect-barrier", &fake);
    wait_initial_sync(&core);
    fake.set_disconnect_paused(true);

    let disconnect_core = core.clone();
    let disconnect = std::thread::spawn(move || disconnect_core.disconnect_account());
    assert!(
        fake.wait_for_calls("disconnect", 1),
        "credential deletion reached barrier"
    );
    assert_eq!(core.connect_account(), Err(MailError::Busy));
    assert_eq!(core.request_sync(), Err(MailError::Busy));
    assert!(
        fake.has_credentials(),
        "credentials are still present while deletion is paused"
    );

    fake.set_disconnect_paused(false);
    assert_eq!(disconnect.join().unwrap(), Ok(()));
    assert!(!fake.has_credentials());
    assert_eq!(status(&core).connection, ConnectionState::Disconnected);
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn disconnect_cancels_in_flight_clears_state_and_blocks_repopulation() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("disconnect", &fake);
    wait_initial_sync(&core);

    // An in-flight catch-up pass is paused inside get_thread.
    let mut threads = HashMap::new();
    threads.insert(
        "thr-2b".to_string(),
        thread(
            "thr-2b",
            "hist-1001",
            vec![
                msg("m-2b1", "2026-01-02T10:00:00Z"),
                msg("m-2b3", "2026-01-05T10:00:00Z"),
            ],
            &["m-2b1", "m-2b3"],
        ),
    );
    threads.insert(
        "thr-1a".to_string(),
        thread(
            "thr-1a",
            "hist-1001",
            vec![msg("m-1a1", "2026-01-01T10:00:00Z")],
            &["m-1a1"],
        ),
    );
    threads.insert(
        "thr-3c".to_string(),
        thread(
            "thr-3c",
            "hist-1001",
            vec![msg("m-3c1", "2026-01-04T10:00:00Z")],
            &["m-3c1"],
        ),
    );
    fake.set_threads(threads);
    let mut history = HashMap::new();
    history.insert(
        None::<String>,
        history_page(&["thr-2b"], &[], None, "hist-1002"),
    );
    fake.set_history(history);
    fake.set_paused_method(Some("get_thread"));
    fake.pause_thread(Some("thr-2b"));
    let thread_calls_before_sync = fake.calls_matching("get_thread|thr-2b").len();
    assert_eq!(core.request_sync(), Ok(()));
    assert!(fake.wait_for_calls("get_thread|thr-2b", thread_calls_before_sync + 1));

    // Disconnect cancels the in-flight call, deletes credentials, clears the
    // account and cache, and only then returns success.
    assert_eq!(core.disconnect_account(), Ok(()));
    assert_eq!(fake.disconnect_calls(), 1);
    assert!(!fake.has_credentials(), "credentials securely deleted");
    let st = status(&core);
    assert_eq!(st.connection, ConnectionState::Disconnected);
    assert_eq!(st.account, None);
    assert_eq!(st.sync.cached_conversations, 0);
    assert!(!st.sync.initial_sync_complete);
    assert!(core
        .list_conversations()
        .expect("snapshot")
        .conversations
        .is_empty());
    assert_eq!(core.request_sync(), Err(MailError::AuthRequired));

    // Release the paused call: the stale result must not repopulate.
    fake.set_paused_method(None);
    fake.pause_thread(None);
    assert!(fake.wait_until_idle());
    assert!(
        until(|| {
            fake.calls_matching("get_thread|thr-2b").len() == thread_calls_before_sync + 1
        }),
        "the cancelled catch-up call ran exactly once"
    );
    core.wait_for_test_idle(TIMEOUT).unwrap();
    assert!(
        core.list_conversations()
            .expect("snapshot")
            .conversations
            .is_empty(),
        "stale in-flight result never repopulates the cache"
    );

    // Reconnect after disconnect: a fresh per-pass cancel token means the
    // cancelled token never poisons later passes.
    assert_eq!(core.connect_account(), Ok(()));
    assert!(
        until(|| {
            let st = status(&core);
            st.connection == ConnectionState::Connected
                && st.sync.initial_sync_complete
                && st.sync.cached_conversations == 3
        }),
        "reconnect completes a fresh initial sync: {:?}",
        status(&core)
    );
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn stop_is_bounded_and_durable_work_resumes_on_restart() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    fake.set_paused_method(Some("get_thread"));
    fake.pause_thread(Some("thr-3c"));

    let (core, dir) = open_core("stop-bounded", &fake);
    assert!(fake.wait_for_calls("get_thread|thr-3c", 1));
    let started = Instant::now();
    core.stop();
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "stop joins the cancelled worker with a bounded wait"
    );
    drop(core);

    fake.set_paused_method(None);
    fake.pause_thread(None);
    let core = open_at(dir.path(), &fake);
    wait_initial_sync(&core);
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn profile_lock_rejects_a_second_gmail_writer() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("profile-lock", &fake);
    let second = GmailCore::open(&dir, fake.clone());
    assert_eq!(second.err(), Some(MailError::ProfileInUse));
    core.stop();
    drop(core);
    let core = open_at(dir.path(), &fake);
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn discovery_page_rejects_aggregate_retained_threads_over_budget_before_commit() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    fake.set_inbox(HashMap::from([(
        None,
        inbox_page(&["huge-discovery"], None),
    )]));
    let mut huge = thread(
        "huge-discovery",
        "hist-1000",
        vec![msg("huge-message", "2026-01-01T00:00:00Z")],
        &["huge-message"],
    );
    huge.conversation.messages[0].body_text = "x".repeat(17 * 1024 * 1024);
    fake.set_threads(HashMap::from([("huge-discovery".to_string(), huge)]));

    let (core, dir) = open_core("discovery-retained-byte-budget", &fake);
    assert!(until(|| {
        let sync = status(&core).sync;
        sync.state == SyncState::Error && sync.error == Some(MailError::InvalidProviderResponse)
    }));
    let sync = status(&core).sync;
    assert!(!sync.initial_sync_complete);
    assert_eq!(sync.cached_conversations, 0);
    assert!(core.list_conversations().unwrap().conversations.is_empty());
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn history_page_rejects_aggregate_retained_threads_without_advancing_cursor() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("history-retained-byte-budget", &fake);
    wait_initial_sync(&core);
    let mut huge = thread(
        "thr-1a",
        "hist-1002",
        vec![msg("m-1a1", "2026-01-01T10:00:00Z")],
        &["m-1a1"],
    );
    huge.conversation.messages[0].body_text = "x".repeat(17 * 1024 * 1024);
    fake.set_threads(HashMap::from([("thr-1a".to_string(), huge)]));
    fake.set_history(HashMap::from([(
        None,
        history_page(&["thr-1a"], &[], None, "hist-1002"),
    )]));
    core.request_sync().unwrap();
    assert!(until(|| {
        let sync = status(&core).sync;
        sync.state == SyncState::Error && sync.error == Some(MailError::InvalidProviderResponse)
    }));
    assert_eq!(
        core.get_conversation(&conv_ref("thr-1a")).unwrap().messages[0].body_text,
        "plain text body"
    );
    assert_eq!(fake.calls_matching("history|hist-1001|-").len(), 1);

    // The failed page did not advance the durable history cursor. An explicit
    // retry replays the same batch start and can commit after the provider is
    // healthy again.
    fake.set_threads(HashMap::new());
    fake.set_history(HashMap::from([(
        None,
        history_page(&[], &[], None, "hist-1003"),
    )]));
    core.request_sync().unwrap();
    assert!(until(|| {
        fake.calls_matching("history|hist-1001|-").len() == 2
            && status(&core).sync.state == SyncState::Idle
    }));
    assert_eq!(
        core.get_conversation(&conv_ref("thr-1a")).unwrap().messages[0].body_text,
        "plain text body"
    );
    core.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn subscription_fires_on_sync_changes() {
    let (fake, _profile) = FakeGmail::new_for_cache();
    baseline_world(&fake);
    let (core, dir) = open_core("subscribe", &fake);

    let count = Arc::new(Mutex::new(0u32));
    let counter = Arc::new(Condvar::new());
    let subscription = {
        let count = Arc::clone(&count);
        core.subscribe(move || {
            *count.lock().expect("counter poisoned") += 1;
            counter.notify_all();
        })
    };
    assert!(
        until(|| *count.lock().expect("counter poisoned") > 0),
        "listener fires when the initial sync commits"
    );
    wait_initial_sync(&core);

    // Disconnect also notifies; only after that is the guard dropped.
    let after = *count.lock().expect("counter poisoned");
    assert_eq!(core.disconnect_account(), Ok(()));
    assert!(
        until(|| *count.lock().expect("counter poisoned") > after),
        "listener fires on disconnect clearing"
    );
    subscription.unsubscribe();
    let quiet = *count.lock().expect("counter poisoned");
    core.stop();
    assert_eq!(
        *count.lock().expect("counter poisoned"),
        quiet,
        "unsubscribed listener stays quiet"
    );
    let _ = std::fs::remove_dir_all(dir);
}
