//! Synthetic provider tests for durable Gmail archive/read operations.
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use mail_core::dto::{
    Address, Conversation, ConversationRef, MailboxOperationKind, OperationStatus, RetryOperation,
    SetArchived, SetRead,
};
use mail_core::error::MailError;
use mail_core::gmail::sync::GmailCore;
use mail_core::gmail::types::{
    GmailHistoryError, GmailProfile, GmailReadProvider, GmailThread, HistoryPage, InboxPage,
};
use mail_core::CancelToken;

const ACCOUNT: &str = "acct-operations";
const THREAD: &str = "thread-operations";
const TIMEOUT: Duration = Duration::from_secs(5);

fn temp_profile(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "mail-core-gmail-operations-{tag}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn profile() -> GmailProfile {
    GmailProfile {
        account_id: ACCOUNT.to_string(),
        email_address: "operations@example.test".to_string(),
        history_id: "history-1".to_string(),
    }
}

fn sample_thread() -> GmailThread {
    GmailThread {
        conversation: Conversation {
            conversation_ref: ConversationRef {
                account_id: ACCOUNT.to_string(),
                conversation_id: THREAD.to_string(),
            },
            subject: "synthetic subject".to_string(),
            messages: vec![mail_core::dto::Message {
                id: "m-1".to_string(),
                from: Address {
                    display_name: None,
                    mailbox: "sender@example.test".to_string(),
                },
                to: vec![],
                sent_at: "2026-01-01T00:00:00Z".to_string(),
                body_text: "synthetic body".to_string(),
            }],
            is_in_inbox: true,
            is_read: None,
            context_complete: Some(false),
            unsupported_reason: Some("unsupported second body".to_string()),
            retained_snapshot_at: None,
            reply_context: None,
            pending_operation_id: None,
        },
        inbox_message_ids: vec!["m-1".to_string(), "m-2".to_string()],
        // m-2 has no renderable body, but it is still part of the immutable target set.
        message_ids: Some(vec!["m-1".to_string(), "m-2".to_string()]),
        unread_message_ids: Some(vec!["m-2".to_string()]),
        history_id: "history-1".to_string(),
    }
}

#[derive(Clone)]
enum ApplyPlan {
    Success,
    Error(MailError),
    BeforeDispatchError(MailError),
    BlockThenSuccess,
    ApplyThenBlock,
    UnknownAfterApply,
}

struct FakeState {
    enabled: bool,
    grant_blocked: bool,
    grant_started: bool,
    grant_error: Option<MailError>,
    apply_plan: ApplyPlan,
    apply_blocked: bool,
    profile_error: Option<MailError>,
    disconnect_error: Option<MailError>,
    mutation_access_error: Option<MailError>,
    mutation_access_error_after: Option<usize>,
    mutation_access_calls: usize,
    thread_fetch_error: Option<MailError>,
    thread_fetch_blocked: bool,
    history_blocked: bool,
    history_started: bool,
    changed_history: bool,
    thread_fetches: usize,
    thread: GmailThread,
    writes: Vec<(MailboxOperationKind, bool, Vec<String>)>,
    profile_account: String,
}

struct FakeProvider {
    state: Mutex<FakeState>,
    gate: Condvar,
}

impl FakeProvider {
    fn new(enabled: bool) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(FakeState {
                enabled,
                grant_blocked: false,
                grant_started: false,
                grant_error: None,
                apply_plan: ApplyPlan::Success,
                apply_blocked: false,
                profile_error: None,
                disconnect_error: None,
                mutation_access_error: None,
                mutation_access_error_after: None,
                mutation_access_calls: 0,
                thread_fetch_error: None,
                thread_fetch_blocked: false,
                history_blocked: false,
                history_started: false,
                changed_history: false,
                thread_fetches: 0,
                thread: sample_thread(),
                writes: Vec::new(),
                profile_account: ACCOUNT.to_string(),
            }),
            gate: Condvar::new(),
        })
    }

    fn set_apply_plan(&self, plan: ApplyPlan) {
        self.state.lock().unwrap().apply_plan = plan;
        self.gate.notify_all();
    }

    fn set_profile_error(&self, error: Option<MailError>) {
        self.state.lock().unwrap().profile_error = error;
        self.gate.notify_all();
    }

    fn set_disconnect_error(&self, error: Option<MailError>) {
        self.state.lock().unwrap().disconnect_error = error;
    }

    fn fail_mutation_access_after(&self, additional_calls: usize, error: MailError) {
        let mut state = self.state.lock().unwrap();
        state.mutation_access_error_after = Some(state.mutation_access_calls + additional_calls);
        state.mutation_access_error = Some(error);
        drop(state);
        self.gate.notify_all();
    }

    fn clear_mutation_access_error(&self) {
        let mut state = self.state.lock().unwrap();
        state.mutation_access_error_after = None;
        state.mutation_access_error = None;
        drop(state);
        self.gate.notify_all();
    }

    fn set_thread_fetch_error(&self, error: Option<MailError>) {
        self.state.lock().unwrap().thread_fetch_error = error;
        self.gate.notify_all();
    }

    fn set_thread_fetch_blocked(&self, blocked: bool) {
        let mut state = self.state.lock().unwrap();
        state.thread_fetch_blocked = blocked;
        drop(state);
        self.gate.notify_all();
    }

    fn set_external_read(&self, read: bool) {
        let mut state = self.state.lock().unwrap();
        let unread = state.thread.unread_message_ids.as_mut().unwrap();
        if read {
            unread.clear();
        } else if !unread.contains(&"m-2".to_string()) {
            unread.push("m-2".to_string());
        }
        state.thread.conversation.is_read = Some(unread.is_empty());
        drop(state);
        self.gate.notify_all();
    }

    fn set_grant_blocked(&self, blocked: bool) {
        self.state.lock().unwrap().grant_blocked = blocked;
        self.gate.notify_all();
    }

    fn set_grant_error(&self, error: Option<MailError>) {
        self.state.lock().unwrap().grant_error = error;
    }

    fn set_profile_account(&self, account: &str) {
        self.state.lock().unwrap().profile_account = account.to_string();
    }

    fn set_history_blocked(&self, blocked: bool) {
        let mut state = self.state.lock().unwrap();
        state.history_blocked = blocked;
        state.history_started = false;
        drop(state);
        self.gate.notify_all();
    }

    fn set_changed_history(&self, changed: bool) {
        self.state.lock().unwrap().changed_history = changed;
    }

    fn wait_for_history(&self) -> bool {
        self.wait_for(|state| state.history_started)
    }

    fn wait_for_thread_fetches(&self, count: usize) -> bool {
        self.wait_for(|state| state.thread_fetches >= count)
    }

    fn wait_for_grant(&self) -> bool {
        self.wait_for(|state| state.grant_started)
    }

    fn wait_for_apply(&self, count: usize) -> bool {
        self.wait_for(|state| state.writes.len() >= count)
    }

    fn wait_for(&self, mut predicate: impl FnMut(&FakeState) -> bool) -> bool {
        let deadline = Instant::now() + TIMEOUT;
        let mut state = self.state.lock().unwrap();
        loop {
            if predicate(&state) {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (next, _) = self.gate.wait_timeout(state, remaining).unwrap();
            state = next;
        }
    }

    fn writes(&self) -> Vec<(MailboxOperationKind, bool, Vec<String>)> {
        self.state.lock().unwrap().writes.clone()
    }

    fn set_new_incoming_message(&self) {
        let mut state = self.state.lock().unwrap();
        state
            .thread
            .message_ids
            .as_mut()
            .unwrap()
            .push("m-3".to_string());
        state.thread.inbox_message_ids.push("m-3".to_string());
        state
            .thread
            .conversation
            .messages
            .push(mail_core::dto::Message {
                id: "m-3".to_string(),
                from: Address {
                    display_name: None,
                    mailbox: "sender@example.test".to_string(),
                },
                to: vec![],
                sent_at: "2026-02-01T00:00:00Z".to_string(),
                body_text: "new incoming".to_string(),
            });
    }

    fn apply(
        &self,
        kind: MailboxOperationKind,
        ids: &[String],
        value: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        let plan = {
            let mut state = self.state.lock().unwrap();
            let plan = state.apply_plan.clone();
            if let ApplyPlan::BeforeDispatchError(error) = &plan {
                return Err(error.clone());
            }
            state.writes.push((kind, value, ids.to_vec()));
            self.gate.notify_all();
            plan
        };
        match plan {
            ApplyPlan::BlockThenSuccess => {
                let mut state = self.state.lock().unwrap();
                state.apply_blocked = true;
                while state.apply_blocked && !cancel.is_cancelled() {
                    let (next, _) = self
                        .gate
                        .wait_timeout(state, Duration::from_millis(10))
                        .unwrap();
                    state = next;
                }
                if cancel.is_cancelled() {
                    return Err(MailError::AuthCancelled);
                }
                drop(state);
            }
            ApplyPlan::ApplyThenBlock => {
                self.apply_remote(kind, ids, value);
                let mut state = self.state.lock().unwrap();
                state.apply_blocked = true;
                while state.apply_blocked && !cancel.is_cancelled() {
                    let (next, _) = self
                        .gate
                        .wait_timeout(state, Duration::from_millis(10))
                        .unwrap();
                    state = next;
                }
                return Err(MailError::AuthCancelled);
            }
            ApplyPlan::UnknownAfterApply => {
                self.apply_remote(kind, ids, value);
                return Err(MailError::OutcomeUnknown);
            }
            ApplyPlan::Error(error) => return Err(error),
            ApplyPlan::BeforeDispatchError(_) => unreachable!("handled before fake dispatch"),
            ApplyPlan::Success => {}
        }
        self.apply_remote(kind, ids, value);
        Ok(())
    }

    fn apply_remote(&self, kind: MailboxOperationKind, ids: &[String], value: bool) {
        let mut state = self.state.lock().unwrap();
        match kind {
            MailboxOperationKind::Archive => {
                state
                    .thread
                    .inbox_message_ids
                    .retain(|id| !ids.contains(id));
                if !value {
                    for id in ids {
                        if !state.thread.inbox_message_ids.contains(id) {
                            state.thread.inbox_message_ids.push(id.clone());
                        }
                    }
                }
            }
            MailboxOperationKind::Read => {
                let unread = state.thread.unread_message_ids.as_mut().unwrap();
                unread.retain(|id| !ids.contains(id));
                if !value {
                    for id in ids {
                        if !unread.contains(id) {
                            unread.push(id.clone());
                        }
                    }
                }
            }
        }
        state.thread.conversation.is_in_inbox = !state.thread.inbox_message_ids.is_empty();
        state.thread.conversation.is_read =
            Some(state.thread.unread_message_ids.as_ref().unwrap().is_empty());
    }

    fn release_apply(&self) {
        let mut state = self.state.lock().unwrap();
        state.apply_blocked = false;
        drop(state);
        self.gate.notify_all();
    }
}

impl GmailReadProvider for FakeProvider {
    fn mutation_access(&self) -> Result<bool, MailError> {
        let mut state = self.state.lock().unwrap();
        state.mutation_access_calls += 1;
        if state
            .mutation_access_error_after
            .is_some_and(|after| state.mutation_access_calls >= after)
        {
            return Err(state
                .mutation_access_error
                .clone()
                .unwrap_or(MailError::SecretsUnavailable));
        }
        Ok(state.enabled)
    }

    fn enable_mutations(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        let mut state = self.state.lock().unwrap();
        state.grant_started = true;
        self.gate.notify_all();
        while state.grant_blocked && !cancel.is_cancelled() {
            let (next, _) = self
                .gate
                .wait_timeout(state, Duration::from_millis(10))
                .unwrap();
            state = next;
        }
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        if let Some(error) = state.grant_error.clone() {
            return Err(error);
        }
        state.enabled = true;
        Ok(profile())
    }

    fn apply_archive(
        &self,
        ids: &[String],
        archived: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        self.apply(MailboxOperationKind::Archive, ids, archived, cancel)
    }

    fn apply_read(
        &self,
        ids: &[String],
        read: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        self.apply(MailboxOperationKind::Read, ids, read, cancel)
    }

    fn is_configured(&self) -> bool {
        true
    }
    fn has_credentials(&self) -> Result<bool, MailError> {
        Ok(true)
    }
    fn connect(&self, _cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        Ok(profile())
    }
    fn disconnect(&self) -> Result<(), MailError> {
        let mut state = self.state.lock().unwrap();
        if let Some(error) = state.disconnect_error.clone() {
            return Err(error);
        }
        state.enabled = false;
        Ok(())
    }
    fn profile(&self, _cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        let state = self.state.lock().unwrap();
        if let Some(error) = &state.profile_error {
            return Err(error.clone());
        }
        let mut value = profile();
        value.account_id = state.profile_account.clone();
        Ok(value)
    }
    fn list_inbox(
        &self,
        _page: Option<&str>,
        _cancel: &CancelToken,
    ) -> Result<InboxPage, MailError> {
        Ok(InboxPage {
            thread_ids: vec![THREAD.to_string()],
            next_page_token: None,
        })
    }
    fn get_thread(
        &self,
        _id: &str,
        cancel: &CancelToken,
    ) -> Result<Option<GmailThread>, MailError> {
        let mut state = self.state.lock().unwrap();
        state.thread_fetches += 1;
        self.gate.notify_all();
        while state.thread_fetch_blocked && !cancel.is_cancelled() {
            let (next, _) = self
                .gate
                .wait_timeout(state, Duration::from_millis(10))
                .unwrap();
            state = next;
        }
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        if let Some(error) = state.thread_fetch_error.clone() {
            return Err(error);
        }
        let thread = state.thread.clone();
        drop(state);
        Ok(Some(thread))
    }
    fn history(
        &self,
        start: &str,
        _page: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<HistoryPage, GmailHistoryError> {
        let mut state = self.state.lock().unwrap();
        if state.history_blocked {
            state.history_started = true;
            self.gate.notify_all();
            while state.history_blocked && !cancel.is_cancelled() {
                let (next, _) = self
                    .gate
                    .wait_timeout(state, Duration::from_millis(10))
                    .unwrap();
                state = next;
            }
        }
        if cancel.is_cancelled() {
            return Err(GmailHistoryError::Mail(MailError::AuthCancelled));
        }
        let changed = state.changed_history;
        drop(state);
        Ok(HistoryPage {
            changed_thread_ids: if changed {
                vec![THREAD.to_string()]
            } else {
                vec![]
            },
            deleted_message_ids: vec![],
            next_page_token: None,
            history_id: start.to_string(),
        })
    }
}

fn until(mut predicate: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        if predicate() {
            return true;
        }
        if Instant::now() >= deadline {
            return predicate();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn open_core(dir: &PathBuf, provider: &Arc<FakeProvider>) -> GmailCore {
    GmailCore::open(dir, Arc::clone(provider) as Arc<dyn GmailReadProvider>).unwrap()
}

fn wait_ready(core: &GmailCore) {
    assert!(
        until(|| {
            let status = core.account_status().unwrap();
            status.connection == mail_core::gmail::types::ConnectionState::Connected
                && status.sync.initial_sync_complete
                && status.sync.state == mail_core::gmail::types::SyncState::Idle
                && core
                    .get_conversation(&ConversationRef {
                        account_id: ACCOUNT.to_string(),
                        conversation_id: THREAD.to_string(),
                    })
                    .is_ok()
        }),
        "startup/sync did not complete: {:?}",
        core.account_status()
    );
}

fn conversation_ref() -> ConversationRef {
    ConversationRef {
        account_id: ACCOUNT.to_string(),
        conversation_id: THREAD.to_string(),
    }
}

fn archived(value: bool, request_id: &str) -> SetArchived {
    SetArchived {
        conversation: conversation_ref(),
        archived: value,
        request_id: request_id.to_string(),
    }
}

#[test]
fn capability_read_failure_does_not_hide_cached_mail() {
    let dir = temp_profile("capability-read-error");
    let provider = FakeProvider::new(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.fail_mutation_access_after(1, MailError::SecretsUnavailable);

    let status = core.account_status().unwrap();
    assert_eq!(
        status.mutation_access,
        Some(mail_core::gmail::types::MutationAccess::ReadOnly)
    );
    assert_eq!(status.sync.error, Some(MailError::SecretsUnavailable));
    assert_eq!(core.list_conversations().unwrap().conversations.len(), 1);
    assert_eq!(
        core.get_conversation(&conversation_ref()).unwrap().subject,
        "synthetic subject"
    );

    provider.clear_mutation_access_error();
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn archive_read_ordering_idempotency_and_unknown_after_apply() {
    let dir = temp_profile("ordering");
    let provider = FakeProvider::new(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);

    let first = core.set_archived(&archived(true, "archive-1")).unwrap();
    let duplicate = core.set_archived(&archived(true, "archive-1")).unwrap();
    assert_eq!(first, duplicate, "same key returns the committed receipt");
    assert_eq!(
        core.set_archived(&archived(false, "archive-1")),
        Err(MailError::RequestIdConflict)
    );
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .first()
        .is_some_and(|op| op.status == OperationStatus::Confirmed)));
    assert!(core.list_conversations().unwrap().conversations.is_empty());
    assert_eq!(
        provider.writes()[0].2,
        vec!["m-1", "m-2"],
        "unsupported-body message remains in the snapshot"
    );

    core.set_archived(&archived(false, "unarchive-1")).unwrap();
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .conversations
        .len()
        == 1));
    let mark_read = SetRead {
        conversation: conversation_ref(),
        read: true,
        request_id: "read-1".to_string(),
    };
    core.set_read(&mark_read).unwrap();
    assert!(until(|| core.list_conversations().unwrap().conversations
        [0]
    .is_read
        == Some(true)));
    let mark_unread = SetRead {
        conversation: conversation_ref(),
        read: false,
        request_id: "unread-1".to_string(),
    };
    core.set_read(&mark_unread).unwrap();
    assert!(until(|| core.list_conversations().unwrap().conversations
        [0]
    .is_read
        == Some(false)));
    assert!(core
        .list_conversations()
        .unwrap()
        .activity
        .iter()
        .any(|op| op.kind == Some(MailboxOperationKind::Read) && op.requested_read == Some(false)));

    // The provider applies before reporting uncertainty. Exact GET reconciliation
    // confirms it without a second setter attempt.
    provider.set_apply_plan(ApplyPlan::UnknownAfterApply);
    core.set_archived(&archived(true, "unknown-1")).unwrap();
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .first()
        .is_some_and(|op| op.status == OperationStatus::Confirmed)));
    assert_eq!(
        provider.writes().len(),
        5,
        "uncertain setter was not replayed"
    );
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn confirmed_unarchive_is_a_barrier_over_an_older_unknown_archive() {
    let dir = temp_profile("unknown-barrier");
    let provider = FakeProvider::new(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::Error(MailError::OutcomeUnknown));
    core.set_archived(&archived(true, "unknown-archive"))
        .unwrap();
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .first()
        .is_some_and(|op| op.status == OperationStatus::OutcomeUnknown)));
    provider.set_apply_plan(ApplyPlan::Success);
    core.set_archived(&archived(false, "confirmed-unarchive"))
        .unwrap();
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .first()
        .is_some_and(|op| op.status == OperationStatus::Confirmed)));
    assert!(until(|| core
        .account_status()
        .is_ok_and(
            |status| status.sync.state != mail_core::gmail::types::SyncState::Syncing
        )));
    provider.set_changed_history(true);
    let thread_fetches = provider.state.lock().unwrap().thread_fetches;
    core.request_sync().unwrap();
    assert!(provider.wait_for_thread_fetches(thread_fetches + 1));
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .conversations
        .len()
        == 1));
    assert!(
        core.get_conversation(&conversation_ref())
            .unwrap()
            .is_in_inbox
    );
    let snapshot = core.list_conversations().unwrap();
    assert_eq!(snapshot.activity[1].status, OperationStatus::OutcomeUnknown);
    core.stop();
    drop(core);

    let restarted = open_core(&dir, &provider);
    wait_ready(&restarted);
    assert!(
        restarted
            .get_conversation(&conversation_ref())
            .unwrap()
            .is_in_inbox
    );
    restarted.stop();
    drop(restarted);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn new_inventory_observed_during_reconciliation_is_persisted() {
    let dir = temp_profile("reconcile-new-arrival");
    let provider = FakeProvider::new(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::UnknownAfterApply);
    provider.set_thread_fetch_blocked(true);
    let before = provider.state.lock().unwrap().thread_fetches;

    core.set_archived(&archived(true, "archive-with-arrival"))
        .unwrap();
    assert!(
        provider.wait_for_thread_fetches(before + 1),
        "reconciliation GET started"
    );
    provider.set_new_incoming_message();
    provider.set_thread_fetch_blocked(false);
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .iter()
        .any(
            |op| op.requested_archived && op.status == OperationStatus::Confirmed
        )));

    let conversation = core.get_conversation(&conversation_ref()).unwrap();
    assert!(conversation.is_in_inbox);
    assert!(conversation
        .messages
        .iter()
        .any(|message| message.id == "m-3"));
    assert_eq!(core.list_conversations().unwrap().conversations.len(), 1);

    core.set_read(&SetRead {
        conversation: conversation_ref(),
        read: true,
        request_id: "read-new-inventory".to_string(),
    })
    .unwrap();
    assert!(provider.wait_for_apply(2));
    assert_eq!(provider.writes()[1].2, vec!["m-1", "m-2", "m-3"]);

    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn authenticated_cached_account_mismatch_never_dispatches_setter() {
    let dir = temp_profile("identity-before-write");
    let provider = FakeProvider::new(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.set_profile_account("acct-foreign");
    core.set_archived(&archived(true, "wrong-account")).unwrap();
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .first()
        .is_some_and(|op| op.status == OperationStatus::Failed)));
    assert!(provider.writes().is_empty());
    assert_eq!(
        core.account_status().unwrap().account.unwrap().account_id,
        ACCOUNT
    );
    assert_eq!(core.list_conversations().unwrap().conversations.len(), 1);
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn incoming_message_after_acceptance_is_not_added_to_target_snapshot() {
    let dir = temp_profile("snapshot");
    let provider = FakeProvider::new(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::BlockThenSuccess);
    core.set_archived(&archived(true, "archive-snapshot"))
        .unwrap();
    assert!(
        provider.wait_for_apply(1),
        "setter reached provider barrier"
    );
    provider.set_new_incoming_message();
    provider.release_apply();
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .first()
        .is_some_and(|op| op.status == OperationStatus::Confirmed)));
    assert_eq!(provider.writes()[0].2, vec!["m-1", "m-2"]);
    assert!(!provider.writes()[0].2.contains(&"m-3".to_string()));
    assert!(until(
        || core.account_status().unwrap().sync.state == mail_core::gmail::types::SyncState::Idle
    ));
    provider.set_changed_history(true);
    let thread_fetches = provider.state.lock().unwrap().thread_fetches;
    core.request_sync().unwrap();
    assert!(provider.wait_for_thread_fetches(thread_fetches + 1));
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .conversations
        .len()
        == 1));
    assert_eq!(
        core.list_conversations().unwrap().conversations[0].is_read,
        Some(false)
    );
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn predispatch_auth_failure_stays_queued_and_restart_resumes() {
    let dir = temp_profile("offline-restart");
    let provider = FakeProvider::new(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.set_profile_error(Some(MailError::AuthRequired));
    core.set_archived(&archived(true, "offline-archive"))
        .unwrap();
    assert!(until(|| core.account_status().unwrap().connection
        == mail_core::gmail::types::ConnectionState::AuthRequired));
    let activity = core.list_conversations().unwrap().activity;
    assert_eq!(activity[0].status, OperationStatus::Queued);
    assert!(
        provider.writes().is_empty(),
        "failed profile check precedes setter dispatch"
    );
    core.stop();
    drop(core);

    provider.set_profile_error(None);
    let restarted = open_core(&dir, &provider);
    assert!(until(|| restarted
        .list_conversations()
        .unwrap()
        .activity
        .first()
        .is_some_and(|op| op.status == OperationStatus::Confirmed)));
    assert_eq!(provider.writes().len(), 1);
    restarted.stop();
    drop(restarted);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn capability_query_failures_after_claim_requeue_and_resume_after_reconnect() {
    for (index, failing_check) in [2, 3].into_iter().enumerate() {
        let dir = temp_profile(&format!("capability-requeue-{index}"));
        let provider = FakeProvider::new(true);
        let core = open_core(&dir, &provider);
        wait_ready(&core);
        provider.fail_mutation_access_after(failing_check, MailError::SecretsUnavailable);

        core.set_archived(&archived(true, &format!("capability-requeue-{index}")))
            .unwrap();
        assert!(until(|| core
            .list_conversations()
            .unwrap()
            .activity
            .first()
            .is_some_and(|op| op.status == OperationStatus::Queued)));
        assert!(provider.writes().is_empty());
        assert!(until(|| core.account_status().unwrap().connection
            == mail_core::gmail::types::ConnectionState::AuthRequired));
        provider.clear_mutation_access_error();
        assert_eq!(
            core.account_status().unwrap().connection,
            mail_core::gmail::types::ConnectionState::AuthRequired
        );
        core.connect_account().unwrap();
        assert!(until(|| core
            .list_conversations()
            .unwrap()
            .activity
            .first()
            .is_some_and(|op| op.status == OperationStatus::Confirmed)));
        assert_eq!(provider.writes().len(), 1);
        core.stop();
        drop(core);
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn token_refresh_failures_keep_receipt_queued_and_retry_original_targets() {
    for (index, error) in [
        MailError::ProviderUnavailable,
        MailError::InvalidProviderResponse,
    ]
    .into_iter()
    .enumerate()
    {
        let dir = temp_profile(&format!("refresh-retry-{index}"));
        let provider = FakeProvider::new(true);
        let core = open_core(&dir, &provider);
        wait_ready(&core);
        provider.set_apply_plan(ApplyPlan::BeforeDispatchError(error.clone()));
        let request_id = format!("refresh-failure-{index}");
        let receipt = core.set_archived(&archived(true, &request_id)).unwrap();
        assert!(until(|| core
            .list_conversations()
            .unwrap()
            .activity
            .iter()
            .any(|op| op.id == receipt.operation_id
                && op.status == OperationStatus::Queued
                && op.last_error.as_ref() == Some(&error))));
        assert!(
            provider.writes().is_empty(),
            "a pre-dispatch refresh failure must not reach the fake setter"
        );
        assert!(until(|| core
            .account_status()
            .is_ok_and(
                |status| status.sync.state != mail_core::gmail::types::SyncState::Syncing
            )));

        provider.set_apply_plan(ApplyPlan::Success);
        core.request_sync().unwrap();
        assert!(until(|| core
            .list_conversations()
            .unwrap()
            .activity
            .iter()
            .any(
                |op| op.id == receipt.operation_id && op.status == OperationStatus::Confirmed
            )));
        let writes = provider.writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].2, vec!["m-1", "m-2"]);

        core.stop();
        drop(core);
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn predispatch_setter_network_failure_stays_queued_until_sync_retries() {
    let dir = temp_profile("setter-connect-failure");
    let provider = FakeProvider::new(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::Error(MailError::NetworkUnavailable));
    core.set_archived(&archived(true, "setter-connect-failure"))
        .unwrap();
    assert!(
        provider.wait_for_apply(1),
        "setter reached the fake provider"
    );
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .first()
        .is_some_and(|op| op.status == OperationStatus::Queued)));
    assert_eq!(provider.writes().len(), 1);
    assert!(until(|| core
        .account_status()
        .is_ok_and(
            |status| status.sync.state != mail_core::gmail::types::SyncState::Syncing
        )));

    provider.set_apply_plan(ApplyPlan::Success);
    core.request_sync().unwrap();
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .first()
        .is_some_and(|op| op.status == OperationStatus::Confirmed)));
    assert_eq!(provider.writes().len(), 2);
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn later_eligible_uncertain_operation_is_not_starved_by_oldest() {
    let dir = temp_profile("uncertain-drain");
    let provider = FakeProvider::new(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.set_thread_fetch_error(Some(MailError::NetworkUnavailable));
    provider.set_apply_plan(ApplyPlan::Error(MailError::OutcomeUnknown));
    let older = core
        .set_archived(&archived(true, "unknown-archive-oldest"))
        .unwrap();
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .iter()
        .any(
            |op| op.id == older.operation_id && op.status == OperationStatus::OutcomeUnknown
        )));
    let newer = core
        .set_read(&SetRead {
            conversation: conversation_ref(),
            read: true,
            request_id: "unknown-read-newer".to_string(),
        })
        .unwrap();
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .iter()
        .any(
            |op| op.id == newer.operation_id && op.status == OperationStatus::OutcomeUnknown
        )));
    // The durable operation status can become visible just before the worker
    // releases its pass barrier. Wait for that barrier before explicitly asking
    // for the next reconciliation pass, or request_sync may correctly return Busy.
    assert!(until(|| core.account_status().is_ok_and(|status| {
        status.sync.state != mail_core::gmail::types::SyncState::Syncing
    })));

    provider.set_thread_fetch_error(None);
    provider.set_external_read(true);
    core.request_sync().unwrap();
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .iter()
        .any(
            |op| op.id == newer.operation_id && op.status == OperationStatus::Confirmed
        )));
    let activity = core.list_conversations().unwrap().activity;
    assert!(activity
        .iter()
        .any(|op| op.id == older.operation_id && op.status == OperationStatus::OutcomeUnknown));

    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn apply_then_cancel_restart_reconciles_without_replay() {
    let dir = temp_profile("unknown-restart");
    let provider = FakeProvider::new(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::ApplyThenBlock);
    core.set_archived(&archived(true, "crash-archive")).unwrap();
    assert!(provider.wait_for_apply(1));
    // stop cancels the blocked response after the fake has applied remotely.
    core.stop();
    drop(core);
    assert_eq!(provider.writes().len(), 1);

    provider.release_apply();
    provider.set_apply_plan(ApplyPlan::Success);
    let restarted = open_core(&dir, &provider);
    assert!(until(|| restarted
        .list_conversations()
        .unwrap()
        .activity
        .first()
        .is_some_and(|op| op.status == OperationStatus::Confirmed)));
    assert_eq!(
        provider.writes().len(),
        1,
        "restart performed GET reconciliation, not a POST replay"
    );
    restarted.stop();
    drop(restarted);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn disconnect_cancels_blocked_setter_and_clears_durable_recovery_state() {
    let dir = temp_profile("disconnect-setter");
    let provider = FakeProvider::new(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::ApplyThenBlock);
    core.set_archived(&archived(true, "disconnect-archive"))
        .unwrap();
    assert!(provider.wait_for_apply(1));
    core.disconnect_account().unwrap();
    assert!(core.account_status().unwrap().account.is_none());
    let snapshot = core.list_conversations().unwrap();
    assert!(snapshot.conversations.is_empty());
    assert!(snapshot.activity.is_empty());
    assert_eq!(
        core.get_conversation(&conversation_ref()),
        Err(MailError::NotFound)
    );
    assert!(
        provider.writes().len() == 1,
        "disconnect did not issue a second setter"
    );
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn failed_disconnect_cleanup_recovers_surviving_applying_operation_without_replay() {
    let dir = temp_profile("disconnect-cleanup-failure");
    let provider = FakeProvider::new(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::ApplyThenBlock);
    let before_fetches = provider.state.lock().unwrap().thread_fetches;
    core.set_archived(&archived(true, "disconnect-failure-archive"))
        .unwrap();
    assert!(provider.wait_for_apply(1));
    provider.set_disconnect_error(Some(MailError::SecretsUnavailable));

    assert_eq!(
        core.disconnect_account(),
        Err(MailError::SecretsUnavailable)
    );
    assert!(
        until(|| {
            provider.state.lock().unwrap().thread_fetches > before_fetches
                && core.list_conversations().is_ok_and(|snapshot| {
                    snapshot
                        .activity
                        .first()
                        .is_some_and(|op| op.status == OperationStatus::Confirmed)
                })
        }),
        "surviving applying action is reconciled by GET after cleanup failure"
    );
    assert_eq!(
        provider.writes().len(),
        1,
        "disconnect recovery reconciles but never replays the setter"
    );

    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn retry_clones_failed_targets_and_new_key_and_upgrade_cancel_isolated() {
    let dir = temp_profile("retry-upgrade");
    let provider = FakeProvider::new(true);
    let core = open_core(&dir, &provider);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::Error(MailError::ProviderRejected));
    let failed = core
        .set_archived(&archived(true, "failed-archive"))
        .unwrap();
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .first()
        .is_some_and(|op| op.status == OperationStatus::Failed)));
    provider.set_apply_plan(ApplyPlan::Success);
    let retry = core
        .retry_operation(&RetryOperation {
            operation_id: failed.operation_id.clone(),
            request_id: "retry-archive".to_string(),
        })
        .unwrap();
    assert_ne!(failed.operation_id, retry.operation_id);
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .first()
        .is_some_and(|op| op.status == OperationStatus::Confirmed)));
    assert_eq!(provider.writes()[1].2, vec!["m-1", "m-2"]);
    core.stop();
    drop(core);

    // The separate grant-control case retains the connected account/cache.
    let upgrade_dir = temp_profile("upgrade-cancel");
    let readonly = FakeProvider::new(false);
    readonly.set_grant_blocked(true);
    let upgrading = open_core(&upgrade_dir, &readonly);
    wait_ready(&upgrading);
    assert_eq!(
        upgrading.account_status().unwrap().mutation_access,
        Some(mail_core::gmail::types::MutationAccess::ReadOnly)
    );
    // An unrelated active sync is not cancelled by a no-op upgrade cancel.
    readonly.set_history_blocked(true);
    upgrading.request_sync().unwrap();
    assert!(readonly.wait_for_history());
    upgrading.cancel_mutation_upgrade().unwrap();
    readonly.set_history_blocked(false);
    assert!(until(|| upgrading.account_status().unwrap().sync.state
        == mail_core::gmail::types::SyncState::Idle));
    upgrading.enable_mutations().unwrap();
    assert!(readonly.wait_for_grant());
    assert_eq!(
        upgrading.account_status().unwrap().mutation_access,
        Some(mail_core::gmail::types::MutationAccess::Upgrading)
    );
    upgrading.cancel_mutation_upgrade().unwrap();
    assert!(until(|| upgrading
        .account_status()
        .unwrap()
        .mutation_access
        == Some(mail_core::gmail::types::MutationAccess::ReadOnly)));
    assert_eq!(
        upgrading
            .account_status()
            .unwrap()
            .account
            .unwrap()
            .account_id,
        ACCOUNT
    );
    assert!(upgrading.get_conversation(&conversation_ref()).is_ok());
    assert!(readonly.writes().is_empty());
    readonly.set_grant_blocked(false);
    readonly.set_grant_error(Some(MailError::PermissionRequired));
    upgrading.enable_mutations().unwrap();
    assert!(until(
        || upgrading.account_status().unwrap().sync.error == Some(MailError::PermissionRequired)
    ));
    let status = upgrading.account_status().unwrap();
    assert_eq!(
        status.mutation_access,
        Some(mail_core::gmail::types::MutationAccess::ReadOnly)
    );
    assert_eq!(status.account.unwrap().account_id, ACCOUNT);
    assert!(upgrading.get_conversation(&conversation_ref()).is_ok());
    upgrading.stop();
    drop(upgrading);
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(upgrade_dir);
}
