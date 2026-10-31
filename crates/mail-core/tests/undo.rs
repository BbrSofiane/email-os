//! Undo integration tests (docs/ux-04-trustworthy-undo.md §5, items 1–12).
//! Gmail cases run against `GmailCore` with a `FakeClock` and a paused fake
//! provider; fixture cases run against `MailCore`. Every test name states the
//! rule it proves. No real mail, credentials, or network is involved.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use mail_core::clock::{utc, FakeClock};
use mail_core::dto::{
    Address, Conversation, ConversationRef, MailboxOperationKind, Message, OperationStatus,
    RetryOperation, SetArchived, SetRead, UndoOperation, UndoOutcome, UndoUnavailableReason,
};
use mail_core::error::MailError;
use mail_core::gmail::sync::GmailCore;
use mail_core::gmail::types::{
    GmailHistoryError, GmailProfile, GmailReadProvider, GmailThread, HistoryPage, InboxPage,
};
use mail_core::CancelToken;
use mail_core::{FakeArchiveProvider, MailCore};

const TIMEOUT: Duration = Duration::from_secs(5);
const ACCOUNT: &str = "acct-undo";
const THREAD: &str = "thread-undo";

fn temp_profile(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "mail-core-undo-{tag}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
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

fn undo(operation_id: &str, request_id: &str) -> UndoOperation {
    UndoOperation {
        operation_id: operation_id.to_string(),
        request_id: request_id.to_string(),
    }
}

fn undo_reason(error: &MailError) -> Option<UndoUnavailableReason> {
    match error {
        MailError::UndoUnavailable { reason } => Some(*reason),
        _ => None,
    }
}

// ------------------------------------------------------------------ Gmail fake

#[derive(Clone)]
enum ApplyPlan {
    Success,
    Error(MailError),
    BeforeDispatchError(MailError),
    BlockThenSuccess,
}

struct FakeState {
    threads: Vec<GmailThread>,
    apply_plan: ApplyPlan,
    apply_blocked: bool,
    writes: Vec<(MailboxOperationKind, bool, Vec<String>)>,
    thread_fetches: usize,
    changed_history: bool,
}

struct FakeProvider {
    state: Mutex<FakeState>,
    gate: Condvar,
}

impl FakeProvider {
    fn new(threads: Vec<GmailThread>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(FakeState {
                threads,
                apply_plan: ApplyPlan::Success,
                apply_blocked: false,
                writes: Vec::new(),
                thread_fetches: 0,
                changed_history: false,
            }),
            gate: Condvar::new(),
        })
    }

    fn set_apply_plan(&self, plan: ApplyPlan) {
        self.state.lock().unwrap().apply_plan = plan;
        self.gate.notify_all();
    }

    fn set_changed_history(&self, changed: bool) {
        self.state.lock().unwrap().changed_history = changed;
    }

    fn wait_for_thread_fetches(&self, count: usize) -> bool {
        self.wait_for(|state| state.thread_fetches >= count)
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

    /// A message that arrives after the original operation was accepted must
    /// never enter its compensation targets (§3.3 explicit targets).
    fn set_new_incoming_message(&self) {
        let mut state = self.state.lock().unwrap();
        let thread = &mut state.threads[0];
        thread.inbox_message_ids.push("m-3".to_string());
        if let Some(ids) = thread.message_ids.as_mut() {
            ids.push("m-3".to_string());
        }
        thread.conversation.messages.push(Message {
            id: "m-3".to_string(),
            from: Address {
                display_name: None,
                mailbox: "sender@example.test".to_string(),
            },
            to: vec![],
            sent_at: "2026-02-01T00:00:00Z".to_string(),
            body_text: "new incoming".to_string(),
        });
        drop(state);
        self.gate.notify_all();
    }

    fn release_apply(&self) {
        let mut state = self.state.lock().unwrap();
        state.apply_blocked = false;
        drop(state);
        self.gate.notify_all();
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
            if let ApplyPlan::BeforeDispatchError(error) = &state.apply_plan {
                return Err(error.clone());
            }
            state.writes.push((kind, value, ids.to_vec()));
            self.gate.notify_all();
            state.apply_plan.clone()
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
            ApplyPlan::Error(error) => return Err(error),
            ApplyPlan::BeforeDispatchError(_) => unreachable!("handled before dispatch"),
            ApplyPlan::Success => {}
        }
        self.apply_remote(kind, ids, value);
        Ok(())
    }

    fn apply_remote(&self, kind: MailboxOperationKind, ids: &[String], value: bool) {
        let mut state = self.state.lock().unwrap();
        for thread in &mut state.threads {
            let relevant = ids.iter().any(|id| {
                thread
                    .message_ids
                    .as_ref()
                    .map(|all| all.contains(id))
                    .unwrap_or_else(|| thread.inbox_message_ids.contains(id))
                    || thread.conversation.messages.iter().any(|m| m.id == *id)
            });
            if !relevant {
                continue;
            }
            match kind {
                MailboxOperationKind::Archive => {
                    thread.inbox_message_ids.retain(|id| !ids.contains(id));
                    if !value {
                        for id in ids {
                            if !thread.inbox_message_ids.contains(id) {
                                thread.inbox_message_ids.push(id.clone());
                            }
                        }
                    }
                }
                MailboxOperationKind::Read => {
                    if let Some(unread) = thread.unread_message_ids.as_mut() {
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
            }
            thread.conversation.is_in_inbox = !thread.inbox_message_ids.is_empty();
            thread.conversation.is_read = thread
                .unread_message_ids
                .as_ref()
                .map(|unread| unread.is_empty());
        }
    }
}

impl GmailReadProvider for FakeProvider {
    fn mutation_access(&self) -> Result<bool, MailError> {
        Ok(true)
    }

    fn enable_mutations(&self, _cancel: &CancelToken) -> Result<GmailProfile, MailError> {
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
        Ok(())
    }
    fn profile(&self, _cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        Ok(profile())
    }
    fn list_inbox(
        &self,
        _page: Option<&str>,
        _cancel: &CancelToken,
    ) -> Result<InboxPage, MailError> {
        let state = self.state.lock().unwrap();
        Ok(InboxPage {
            thread_ids: state
                .threads
                .iter()
                .map(|t| t.conversation.conversation_ref.conversation_id.clone())
                .collect(),
            next_page_token: None,
        })
    }
    fn get_thread(
        &self,
        id: &str,
        _cancel: &CancelToken,
    ) -> Result<Option<GmailThread>, MailError> {
        let mut state = self.state.lock().unwrap();
        state.thread_fetches += 1;
        self.gate.notify_all();
        Ok(state
            .threads
            .iter()
            .find(|t| t.conversation.conversation_ref.conversation_id == id)
            .cloned())
    }
    fn history(
        &self,
        start: &str,
        _page: Option<&str>,
        _cancel: &CancelToken,
    ) -> Result<HistoryPage, GmailHistoryError> {
        let state = self.state.lock().unwrap();
        Ok(HistoryPage {
            changed_thread_ids: if state.changed_history {
                state
                    .threads
                    .iter()
                    .map(|t| t.conversation.conversation_ref.conversation_id.clone())
                    .collect()
            } else {
                vec![]
            },
            deleted_message_ids: vec![],
            next_page_token: None,
            history_id: start.to_string(),
        })
    }
}

fn profile() -> GmailProfile {
    GmailProfile {
        account_id: ACCOUNT.to_string(),
        email_address: "undo@example.test".to_string(),
        history_id: "history-1".to_string(),
    }
}

fn conversation_ref(conversation_id: &str) -> ConversationRef {
    ConversationRef {
        account_id: ACCOUNT.to_string(),
        conversation_id: conversation_id.to_string(),
    }
}

fn message(id: &str, sent_at: &str) -> Message {
    Message {
        id: id.to_string(),
        from: Address {
            display_name: None,
            mailbox: "sender@example.test".to_string(),
        },
        to: vec![],
        sent_at: sent_at.to_string(),
        body_text: "synthetic body".to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
fn thread(id: &str, msgs: Vec<Message>, inbox: &[&str], unread: &[&str]) -> GmailThread {
    let is_in_inbox = !inbox.is_empty();
    let message_ids: Vec<String> = msgs.iter().map(|m| m.id.clone()).collect();
    GmailThread {
        conversation: Conversation {
            conversation_ref: conversation_ref(id),
            subject: format!("subject {id}"),
            messages: msgs,
            is_in_inbox,
            is_read: None,
            context_complete: Some(true),
            unsupported_reason: None,
            retained_snapshot_at: None,
            reply_context: None,
            pending_operation_id: None,
        },
        inbox_message_ids: inbox.iter().map(|s| s.to_string()).collect(),
        message_ids: Some(message_ids),
        unread_message_ids: Some(unread.iter().map(|s| s.to_string()).collect()),
        history_id: "history-1".to_string(),
    }
}

fn open_core(dir: &Path, provider: &Arc<FakeProvider>, clock: &Arc<FakeClock>) -> GmailCore {
    GmailCore::open_with_clock(
        dir,
        Arc::clone(provider) as Arc<dyn GmailReadProvider>,
        Arc::clone(clock) as Arc<dyn mail_core::clock::Clock>,
    )
    .unwrap()
}

fn wait_ready(core: &GmailCore) {
    assert!(
        until(|| {
            core.account_status().is_ok_and(|status| {
                status.connection == mail_core::gmail::types::ConnectionState::Connected
                    && status.sync.initial_sync_complete
            })
        }),
        "startup/sync did not complete: {:?}",
        core.account_status()
    );
}

fn wait_status(core: &GmailCore, operation_id: &str, status: OperationStatus) -> bool {
    until(|| {
        core.list_conversations()
            .unwrap()
            .activity
            .iter()
            .any(|op| op.id == operation_id && op.status == status)
    })
}

// --------------------------------------------------------------- Gmail §5.1–11

fn archived(value: bool, request_id: &str) -> SetArchived {
    SetArchived {
        conversation: conversation_ref(THREAD),
        archived: value,
        request_id: request_id.to_string(),
    }
}

/// §5 item 1: undoing an archive within the window restores exactly the
/// originally-INBOX message ids; a non-INBOX sent reply stays out. The
/// compensation uses explicit targets derived from the preimage, never from
/// current facts.
#[test]
fn undoing_an_archive_within_the_window_restores_only_originally_inbox_messages() {
    let dir = temp_profile("gmail-restore-preimage");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let provider = FakeProvider::new(vec![thread(
        THREAD,
        vec![
            message("m-1", "2026-01-01T00:00:00Z"),
            message("m-2", "2026-01-01T00:01:00Z"),
        ],
        &["m-1"],
        &["m-1", "m-2"],
    )]);
    let core = open_core(&dir, &provider, &clock);
    wait_ready(&core);

    let archive = core.set_archived(&archived(true, "archive-1")).unwrap();
    assert!(wait_status(
        &core,
        &archive.operation_id,
        OperationStatus::Confirmed
    ));

    let receipt = core
        .undo_operation(&undo(&archive.operation_id, "undo-1"))
        .unwrap();
    assert_eq!(receipt.undone_operation_id, archive.operation_id);
    assert_eq!(receipt.outcome, UndoOutcome::Compensating);
    assert_eq!(
        receipt.operation_ids.len(),
        2,
        "one compensating op per distinct prior value"
    );

    assert!(until(|| {
        receipt.operation_ids.iter().all(|id| {
            core.list_conversations()
                .unwrap()
                .activity
                .iter()
                .any(|op| op.id == *id && op.status == OperationStatus::Confirmed)
        })
    }));
    let writes = provider.writes();
    assert_eq!(
        writes[0],
        (
            MailboxOperationKind::Archive,
            true,
            vec!["m-1".into(), "m-2".into()]
        )
    );
    // Explicit targets: m-1 (prior in INBOX) is restored; m-2 (the sent reply,
    // never in INBOX) is re-applied archived and stays out.
    assert_eq!(
        writes[1],
        (MailboxOperationKind::Archive, false, vec!["m-1".into()])
    );
    assert_eq!(
        writes[2],
        (MailboxOperationKind::Archive, true, vec!["m-2".into()])
    );
    assert!(
        core.get_conversation(&conversation_ref(THREAD))
            .unwrap()
            .is_in_inbox
    );
    // The undone operation loses its undo window as soon as it is undone.
    let activity = core.list_conversations().unwrap().activity;
    let undone_row = activity
        .iter()
        .find(|op| op.id == archive.operation_id)
        .unwrap();
    assert_eq!(undone_row.status, OperationStatus::Confirmed);
    assert_eq!(
        undone_row.undoable_until, None,
        "undone op is no longer undoable"
    );
    for compensation in &receipt.operation_ids {
        let row = activity.iter().find(|op| op.id == *compensation).unwrap();
        assert_eq!(row.undo_of.as_deref(), Some(archive.operation_id.as_str()));
        assert_eq!(
            row.undoable_until, None,
            "compensating ops are never undoable"
        );
    }
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

/// §5 item 2: at 10 s + 1 ms (here: the deadline second itself, `now ==
/// accepted_at + 10 s`) undo is rejected `expired` and nothing is enqueued.
#[test]
fn undo_after_the_ten_second_window_is_rejected_as_expired_and_enqueues_nothing() {
    let dir = temp_profile("gmail-expired");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let provider = FakeProvider::new(vec![thread(
        THREAD,
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
        &["m-1"],
    )]);
    let core = open_core(&dir, &provider, &clock);
    wait_ready(&core);
    let archive = core.set_archived(&archived(true, "archive-1")).unwrap();
    assert!(wait_status(
        &core,
        &archive.operation_id,
        OperationStatus::Confirmed
    ));

    clock.advance_seconds(10);
    let activity_before = core.list_conversations().unwrap().activity.len();
    let error = core
        .undo_operation(&undo(&archive.operation_id, "undo-1"))
        .unwrap_err();
    assert_eq!(undo_reason(&error), Some(UndoUnavailableReason::Expired));
    assert_eq!(
        core.list_conversations().unwrap().activity.len(),
        activity_before,
        "expired undo enqueues nothing"
    );
    // The expired operation discloses no undoable_until in Activity either.
    let activity = core.list_conversations().unwrap().activity;
    let row = activity
        .iter()
        .find(|op| op.id == archive.operation_id)
        .unwrap();
    assert_eq!(row.undoable_until, None);
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

/// §5 item 3: a still-queued operation is cancelled in place with zero
/// provider calls; the overlay disappears and Activity shows `cancelled`.
#[test]
fn undo_of_a_still_queued_operation_cancels_in_place_with_zero_provider_calls() {
    let dir = temp_profile("gmail-cancel-in-place");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let provider = FakeProvider::new(vec![thread(
        THREAD,
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
        &["m-1"],
    )]);
    let core = open_core(&dir, &provider, &clock);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::BeforeDispatchError(
        MailError::NetworkUnavailable,
    ));
    let archive = core.set_archived(&archived(true, "archive-1")).unwrap();
    assert!(wait_status(
        &core,
        &archive.operation_id,
        OperationStatus::Queued
    ));

    let receipt = core
        .undo_operation(&undo(&archive.operation_id, "undo-1"))
        .unwrap();
    assert_eq!(receipt.undone_operation_id, archive.operation_id);
    assert_eq!(receipt.outcome, UndoOutcome::Cancelled);
    assert!(receipt.operation_ids.is_empty());
    assert!(
        provider.writes().is_empty(),
        "cancelled in place, zero provider calls"
    );

    let snapshot = core.list_conversations().unwrap();
    assert_eq!(
        snapshot.conversations.len(),
        1,
        "overlay gone, row is back in the inbox"
    );
    let row = snapshot
        .activity
        .iter()
        .find(|op| op.id == archive.operation_id)
        .unwrap();
    assert_eq!(row.status, OperationStatus::Cancelled);
    assert_eq!(
        row.undoable_until, None,
        "a cancelled op is no longer undoable"
    );
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

/// §5 item 4: an operation claimed by the worker (`applying`) is compensated;
/// a cancel attempt that loses to the claim falls through to compensation,
/// and the compensation runs after the original and restores it.
#[test]
fn undo_of_a_claimed_operation_falls_through_to_compensation_which_runs_after_it() {
    let dir = temp_profile("gmail-compensate-applying");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let provider = FakeProvider::new(vec![thread(
        THREAD,
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
        &["m-1"],
    )]);
    let core = open_core(&dir, &provider, &clock);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::BlockThenSuccess);
    let archive = core.set_archived(&archived(true, "archive-1")).unwrap();
    assert!(
        provider.wait_for_apply(1),
        "worker claimed the op (race window)"
    );

    let receipt = core
        .undo_operation(&undo(&archive.operation_id, "undo-1"))
        .unwrap();
    assert_eq!(
        receipt.outcome,
        UndoOutcome::Compensating,
        "cancel lost to the claim"
    );
    assert_eq!(receipt.operation_ids.len(), 1);

    provider.set_apply_plan(ApplyPlan::Success);
    provider.release_apply();
    assert!(until(|| {
        let writes = provider.writes();
        writes.len() == 2 && writes[1] == (MailboxOperationKind::Archive, false, vec!["m-1".into()])
    }));
    assert!(
        wait_status(&core, &receipt.operation_ids[0], OperationStatus::Confirmed),
        "activity: {:?}",
        core.list_conversations().unwrap().activity
    );
    assert!(wait_status(
        &core,
        &archive.operation_id,
        OperationStatus::Confirmed
    ));
    assert!(until(|| {
        core.get_conversation(&conversation_ref(THREAD))
            .unwrap()
            .is_in_inbox
    }));
    let activity = core.list_conversations().unwrap().activity;
    let original = activity
        .iter()
        .find(|op| op.id == archive.operation_id)
        .unwrap();
    let compensation = activity
        .iter()
        .find(|op| op.id == receipt.operation_ids[0])
        .unwrap();
    assert_eq!(
        compensation.undo_of.as_deref(),
        Some(archive.operation_id.as_str())
    );
    assert_eq!(original.status, OperationStatus::Confirmed);
    assert_eq!(compensation.status, OperationStatus::Confirmed);
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

/// §5 item 5: a message that arrives between archive and undo is excluded
/// from the compensation's explicit targets.
#[test]
fn compensation_targets_exclude_messages_that_arrived_after_the_original() {
    let dir = temp_profile("gmail-new-arrival");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let provider = FakeProvider::new(vec![thread(
        THREAD,
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
        &["m-1"],
    )]);
    let core = open_core(&dir, &provider, &clock);
    wait_ready(&core);
    let archive = core.set_archived(&archived(true, "archive-1")).unwrap();
    assert!(wait_status(
        &core,
        &archive.operation_id,
        OperationStatus::Confirmed
    ));

    provider.set_new_incoming_message();
    provider.set_changed_history(true);
    let fetches = provider.state.lock().unwrap().thread_fetches;
    core.request_sync().unwrap();
    assert!(provider.wait_for_thread_fetches(fetches + 1));
    assert!(until(|| {
        core.account_status().unwrap().sync.state == mail_core::gmail::types::SyncState::Idle
    }));

    let receipt = core
        .undo_operation(&undo(&archive.operation_id, "undo-1"))
        .unwrap();
    assert!(until(|| provider.writes().len() == 2));
    let writes = provider.writes();
    assert_eq!(
        writes[1],
        (MailboxOperationKind::Archive, false, vec!["m-1".into()]),
        "explicit targets from the preimage; m-3 is untouched"
    );
    assert_eq!(receipt.operation_ids.len(), 1);
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

/// §5 item 6: a read op over mixed read/unread facts stages one compensating
/// op per distinct prior value; an unknown prior fact fails `unknown_prior`.
#[test]
fn undo_of_a_read_operation_stages_one_compensation_per_distinct_prior_value() {
    // Mixed facts: m-1 was read, m-2 was unread.
    let dir = temp_profile("gmail-read-groups");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let provider = FakeProvider::new(vec![thread(
        THREAD,
        vec![
            message("m-1", "2026-01-01T00:00:00Z"),
            message("m-2", "2026-01-01T00:01:00Z"),
        ],
        &["m-1", "m-2"],
        &["m-2"],
    )]);
    let core = open_core(&dir, &provider, &clock);
    wait_ready(&core);
    let read = core
        .set_read(&SetRead {
            conversation: conversation_ref(THREAD),
            read: true,
            request_id: "read-1".to_string(),
        })
        .unwrap();
    assert!(wait_status(
        &core,
        &read.operation_id,
        OperationStatus::Confirmed
    ));
    let receipt = core
        .undo_operation(&undo(&read.operation_id, "undo-read"))
        .unwrap();
    assert_eq!(receipt.outcome, UndoOutcome::Compensating);
    assert!(until(|| provider.writes().len() == 3));
    let writes = provider.writes();
    assert_eq!(
        writes[1],
        (MailboxOperationKind::Read, false, vec!["m-2".into()])
    );
    assert_eq!(
        writes[2],
        (MailboxOperationKind::Read, true, vec!["m-1".into()])
    );
    core.stop();
    drop(core);

    // Unknown prior: a target whose unread fact is unobserved cannot be
    // exactly undone.
    let dir2 = temp_profile("gmail-unknown-prior");
    let provider2 = FakeProvider::new(vec![thread(
        THREAD,
        vec![
            message("m-1", "2026-01-01T00:00:00Z"),
            message("m-2", "2026-01-01T00:01:00Z"),
        ],
        &["m-1", "m-2"],
        &["m-2"],
    )]);
    let core2 = open_core(&dir2, &provider2, &clock);
    wait_ready(&core2);
    {
        let conn = rusqlite::Connection::open(dir2.join("gmail.db")).unwrap();
        conn.execute(
            "UPDATE gmail_message_facts SET is_unread = NULL
             WHERE account_id = ?1 AND conversation_id = ?2 AND message_id = 'm-1'",
            rusqlite::params![ACCOUNT, THREAD],
        )
        .unwrap();
    }
    let read = core2
        .set_read(&SetRead {
            conversation: conversation_ref(THREAD),
            read: true,
            request_id: "read-unknown".to_string(),
        })
        .unwrap();
    assert!(wait_status(
        &core2,
        &read.operation_id,
        OperationStatus::Confirmed
    ));
    let error = core2
        .undo_operation(&undo(&read.operation_id, "undo-unknown"))
        .unwrap_err();
    assert_eq!(
        undo_reason(&error),
        Some(UndoUnavailableReason::UnknownPrior)
    );
    assert_eq!(provider2.writes().len(), 1, "nothing enqueued");
    core2.stop();
    drop(core2);
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(dir2);
}

/// §5 item 7: a newer operation on the account supersedes the undo target
/// (rule 4, single-level history); undoing the newer one works; a retry
/// counts as a newer operation.
#[test]
fn a_newer_operation_supersedes_the_undo_target_and_a_retry_counts_as_newer() {
    let dir = temp_profile("gmail-superseded");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let provider = FakeProvider::new(vec![thread(
        THREAD,
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
        &["m-1"],
    )]);
    let core = open_core(&dir, &provider, &clock);
    wait_ready(&core);
    let older = core.set_archived(&archived(true, "older-archive")).unwrap();
    assert!(wait_status(
        &core,
        &older.operation_id,
        OperationStatus::Confirmed
    ));
    let newer = core
        .set_read(&SetRead {
            conversation: conversation_ref(THREAD),
            read: true,
            request_id: "newer-read".to_string(),
        })
        .unwrap();
    assert!(wait_status(
        &core,
        &newer.operation_id,
        OperationStatus::Confirmed
    ));

    let error = core
        .undo_operation(&undo(&older.operation_id, "undo-older"))
        .unwrap_err();
    assert_eq!(undo_reason(&error), Some(UndoUnavailableReason::Superseded));
    let receipt = core
        .undo_operation(&undo(&newer.operation_id, "undo-newer"))
        .unwrap();
    assert_eq!(receipt.outcome, UndoOutcome::Compensating);
    assert!(until(|| provider.writes().len() == 3));
    core.stop();
    drop(core);

    // Retry counts as a newer operation: after retrying an uncertain op, the
    // uncertain original is superseded by the retry.
    let provider = FakeProvider::new(vec![thread(
        THREAD,
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
        &["m-1"],
    )]);
    let clock2 = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let core = open_core(&dir, &provider, &clock2);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::Error(MailError::OutcomeUnknown));
    let uncertain = core
        .set_archived(&archived(true, "uncertain-archive"))
        .unwrap();
    assert!(wait_status(
        &core,
        &uncertain.operation_id,
        OperationStatus::OutcomeUnknown
    ));
    provider.set_apply_plan(ApplyPlan::Success);
    let retry = core
        .retry_operation(&RetryOperation {
            operation_id: uncertain.operation_id.clone(),
            request_id: "retry-uncertain".to_string(),
        })
        .unwrap();
    assert!(wait_status(
        &core,
        &retry.operation_id,
        OperationStatus::Confirmed
    ));
    let error = core
        .undo_operation(&undo(&uncertain.operation_id, "undo-uncertain"))
        .unwrap_err();
    assert_eq!(undo_reason(&error), Some(UndoUnavailableReason::Superseded));
    let receipt = core
        .undo_operation(&undo(&retry.operation_id, "undo-retry"))
        .unwrap();
    assert_eq!(receipt.outcome, UndoOutcome::Compensating);
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

/// §5 item 8: the same requestId returns the exact committed receipt; the
/// same undo with a different requestId is `already_undone`.
#[test]
fn undo_is_idempotent_per_request_id_and_a_new_request_is_already_undone() {
    let dir = temp_profile("gmail-idempotent");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let provider = FakeProvider::new(vec![thread(
        THREAD,
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
        &["m-1"],
    )]);
    let core = open_core(&dir, &provider, &clock);
    wait_ready(&core);
    let archive = core.set_archived(&archived(true, "archive-1")).unwrap();
    assert!(wait_status(
        &core,
        &archive.operation_id,
        OperationStatus::Confirmed
    ));

    let first = core
        .undo_operation(&undo(&archive.operation_id, "undo-1"))
        .unwrap();
    let replay = core
        .undo_operation(&undo(&archive.operation_id, "undo-1"))
        .unwrap();
    assert_eq!(first, replay, "same requestId returns the same receipt");
    let error = core
        .undo_operation(&undo(&archive.operation_id, "undo-2"))
        .unwrap_err();
    assert_eq!(
        undo_reason(&error),
        Some(UndoUnavailableReason::AlreadyUndone)
    );
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

/// §5 item 9: `outcome_unknown` is `uncertain`; `failed` and compensating
/// operations are `not_applicable`.
#[test]
fn uncertain_failed_and_compensating_operations_are_not_undoable() {
    let dir = temp_profile("gmail-not-undoable");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let provider = FakeProvider::new(vec![thread(
        THREAD,
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
        &["m-1"],
    )]);
    let core = open_core(&dir, &provider, &clock);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::Error(MailError::ProviderRejected));
    let failed = core.set_archived(&archived(true, "failed")).unwrap();
    assert!(wait_status(
        &core,
        &failed.operation_id,
        OperationStatus::Failed
    ));
    let error = core
        .undo_operation(&undo(&failed.operation_id, "undo-failed"))
        .unwrap_err();
    assert_eq!(
        undo_reason(&error),
        Some(UndoUnavailableReason::NotApplicable)
    );

    provider.set_apply_plan(ApplyPlan::Error(MailError::OutcomeUnknown));
    let uncertain = core.set_archived(&archived(true, "uncertain")).unwrap();
    assert!(wait_status(
        &core,
        &uncertain.operation_id,
        OperationStatus::OutcomeUnknown
    ));
    let error = core
        .undo_operation(&undo(&uncertain.operation_id, "undo-uncertain"))
        .unwrap_err();
    assert_eq!(undo_reason(&error), Some(UndoUnavailableReason::Uncertain));

    // A compensating operation is never itself undoable (rule 2).
    provider.set_apply_plan(ApplyPlan::Success);
    let target = core.set_archived(&archived(true, "target")).unwrap();
    assert!(wait_status(
        &core,
        &target.operation_id,
        OperationStatus::Confirmed
    ));
    let receipt = core
        .undo_operation(&undo(&target.operation_id, "undo-target"))
        .unwrap();
    assert!(until(|| {
        receipt.operation_ids.iter().all(|id| {
            core.list_conversations()
                .unwrap()
                .activity
                .iter()
                .any(|op| op.id == *id && op.status == OperationStatus::Confirmed)
        })
    }));
    let compensation = receipt.operation_ids[0].clone();
    let error = core
        .undo_operation(&undo(&compensation, "undo-compensation"))
        .unwrap_err();
    assert_eq!(
        undo_reason(&error),
        Some(UndoUnavailableReason::NotApplicable)
    );
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

/// §5 item 10: `undoable_until` survives a restart within the window and Z
/// still works; after the window it is gone and undo is `expired`. An
/// interrupted compensation recovers like any operation.
#[test]
fn undoable_until_survives_a_restart_within_the_window_and_expires_after_it() {
    let dir = temp_profile("gmail-restart-window");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let provider = FakeProvider::new(vec![thread(
        THREAD,
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
        &["m-1"],
    )]);
    let core = open_core(&dir, &provider, &clock);
    wait_ready(&core);
    provider.set_apply_plan(ApplyPlan::BeforeDispatchError(
        MailError::NetworkUnavailable,
    ));
    let archive = core
        .set_archived(&archived(true, "offline-archive"))
        .unwrap();
    assert!(
        until(|| core
            .list_conversations()
            .unwrap()
            .activity
            .iter()
            .any(|op| op.id == archive.operation_id
                && op.status == OperationStatus::Queued
                && op.last_error.as_ref() == Some(&MailError::NetworkUnavailable))),
        "first dispatch cycle completed and requeued"
    );
    let until_before = core
        .list_conversations()
        .unwrap()
        .activity
        .iter()
        .find(|op| op.id == archive.operation_id)
        .unwrap()
        .undoable_until
        .clone();
    assert!(
        until_before.is_some(),
        "undoable_until disclosed while queued"
    );

    core.stop();
    drop(core);
    let restarted = open_core(&dir, &provider, &clock);
    assert!(
        until(|| restarted
            .list_conversations()
            .unwrap()
            .activity
            .iter()
            .any(|op| op.id == archive.operation_id
                && op.status == OperationStatus::Queued
                && op.last_error.as_ref() == Some(&MailError::NetworkUnavailable))),
        "restart completed and requeued the queued operation"
    );
    let activity_after = restarted.list_conversations().unwrap().activity;
    let until_after = activity_after
        .iter()
        .find(|op| op.id == archive.operation_id)
        .unwrap()
        .undoable_until
        .clone();
    assert_eq!(
        until_after, until_before,
        "undoable_until survives the restart"
    );
    let receipt = restarted
        .undo_operation(&undo(&archive.operation_id, "undo-restart"))
        .unwrap();
    assert_eq!(receipt.outcome, UndoOutcome::Cancelled);
    restarted.stop();
    drop(restarted);

    // After the window (restart included) the same undo is expired.
    let dir2 = temp_profile("gmail-restart-expired");
    let provider2 = FakeProvider::new(vec![thread(
        THREAD,
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
        &["m-1"],
    )]);
    let core = open_core(&dir2, &provider2, &clock);
    wait_ready(&core);
    provider2.set_apply_plan(ApplyPlan::BeforeDispatchError(
        MailError::NetworkUnavailable,
    ));
    let archive = core
        .set_archived(&archived(true, "offline-archive-2"))
        .unwrap();
    assert!(until(|| core
        .list_conversations()
        .unwrap()
        .activity
        .iter()
        .any(|op| op.id == archive.operation_id
            && op.status == OperationStatus::Queued
            && op.last_error.as_ref()
                == Some(&MailError::NetworkUnavailable))));
    core.stop();
    drop(core);
    clock.advance_seconds(11);
    let restarted = open_core(&dir2, &provider2, &clock);
    wait_ready(&restarted);
    let error = restarted
        .undo_operation(&undo(&archive.operation_id, "undo-expired"))
        .unwrap_err();
    assert_eq!(undo_reason(&error), Some(UndoUnavailableReason::Expired));
    restarted.stop();
    drop(restarted);

    // An interrupted compensation recovers like any operation across restart.
    let dir3 = temp_profile("gmail-interrupted-compensation");
    let provider3 = FakeProvider::new(vec![thread(
        THREAD,
        vec![message("m-1", "2026-01-01T00:00:00Z")],
        &["m-1"],
        &["m-1"],
    )]);
    let core = open_core(&dir3, &provider3, &clock);
    wait_ready(&core);
    provider3.set_apply_plan(ApplyPlan::BlockThenSuccess);
    let archive = core.set_archived(&archived(true, "archive-comp")).unwrap();
    assert!(provider3.wait_for_apply(1));
    let receipt = core
        .undo_operation(&undo(&archive.operation_id, "undo-comp"))
        .unwrap();
    assert_eq!(receipt.outcome, UndoOutcome::Compensating);
    core.stop();
    drop(core);
    provider3.set_apply_plan(ApplyPlan::Success);
    provider3.release_apply();
    let restarted = open_core(&dir3, &provider3, &clock);
    assert!(until(|| {
        restarted
            .get_conversation(&conversation_ref(THREAD))
            .map(|c| c.is_in_inbox)
            .unwrap_or(false)
    }));
    assert!(until(|| {
        restarted
            .list_conversations()
            .unwrap()
            .activity
            .iter()
            .any(|op| op.id == receipt.operation_ids[0] && op.status == OperationStatus::Confirmed)
    }));
    restarted.stop();
    drop(restarted);
    for dir in [dir, dir2, dir3] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// §5 item 11: cached Done evidence — a cancelled archive, and a confirmed
/// archive followed by a confirmed compensation, do not qualify; an archive
/// with a failed compensation still does.
#[test]
fn cached_done_excludes_cancelled_and_undone_archives_but_keeps_failed_compensation() {
    use mail_core::dto::CachedDoneRequest;
    let dir = temp_profile("gmail-cached-done-undo");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let threads = ["cancelled", "undone", "failed-comp"]
        .iter()
        .map(|id| {
            thread(
                id,
                vec![message(&format!("m-{id}"), "2026-01-01T00:00:00Z")],
                &[&format!("m-{id}")],
                &[&format!("m-{id}")],
            )
        })
        .collect();
    let provider = FakeProvider::new(threads);
    let core = open_core(&dir, &provider, &clock);
    wait_ready(&core);

    // A cancelled archive: accepted while the provider is unreachable, then
    // undone before dispatch.
    provider.set_apply_plan(ApplyPlan::BeforeDispatchError(
        MailError::NetworkUnavailable,
    ));
    let cancelled_archive = core
        .set_archived(&SetArchived {
            conversation: conversation_ref("cancelled"),
            archived: true,
            request_id: "archive-cancelled".to_string(),
        })
        .unwrap();
    assert!(wait_status(
        &core,
        &cancelled_archive.operation_id,
        OperationStatus::Queued
    ));
    let receipt = core
        .undo_operation(&undo(&cancelled_archive.operation_id, "undo-cancelled"))
        .unwrap();
    assert_eq!(receipt.outcome, UndoOutcome::Cancelled);

    provider.set_apply_plan(ApplyPlan::Success);
    let failed_comp_archive = core
        .set_archived(&SetArchived {
            conversation: conversation_ref("failed-comp"),
            archived: true,
            request_id: "archive-failed-comp".to_string(),
        })
        .unwrap();
    assert!(wait_status(
        &core,
        &failed_comp_archive.operation_id,
        OperationStatus::Confirmed
    ));

    // Undo while it is the newest operation; its compensation fails definitely.
    provider.set_apply_plan(ApplyPlan::Error(MailError::ProviderRejected));
    let failed_receipt = core
        .undo_operation(&undo(&failed_comp_archive.operation_id, "undo-failed-comp"))
        .unwrap();
    assert_eq!(failed_receipt.outcome, UndoOutcome::Compensating);
    assert!(until(|| {
        failed_receipt.operation_ids.iter().all(|id| {
            core.list_conversations()
                .unwrap()
                .activity
                .iter()
                .any(|op| op.id == *id && op.status == OperationStatus::Failed)
        })
    }));

    // A second archive, confirmed and then undone by a confirmed compensation.
    provider.set_apply_plan(ApplyPlan::Success);
    let undone_archive = core
        .set_archived(&SetArchived {
            conversation: conversation_ref("undone"),
            archived: true,
            request_id: "archive-undone".to_string(),
        })
        .unwrap();
    assert!(wait_status(
        &core,
        &undone_archive.operation_id,
        OperationStatus::Confirmed
    ));
    let undone_receipt = core
        .undo_operation(&undo(&undone_archive.operation_id, "undo-undone"))
        .unwrap();
    assert!(until(|| {
        undone_receipt.operation_ids.iter().all(|id| {
            core.list_conversations()
                .unwrap()
                .activity
                .iter()
                .any(|op| op.id == *id && op.status == OperationStatus::Confirmed)
        })
    }));

    let request = CachedDoneRequest {
        account_id: ACCOUNT.to_string(),
        limit: 100,
        cursor: None,
    };
    let page = core.list_cached_done(&request).unwrap();
    let ids: Vec<String> = page
        .conversations
        .iter()
        .map(|c| c.conversation_ref.conversation_id.clone())
        .collect();
    assert_eq!(
        ids,
        vec!["failed-comp".to_string()],
        "only the archive with a failed compensation qualifies"
    );
    core.stop();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

// ------------------------------------------------------------ Fixture §5.1–3, 12

fn fixture_ref(conversation_id: &str) -> ConversationRef {
    ConversationRef {
        account_id: mail_core::ACCOUNT_ID.to_string(),
        conversation_id: conversation_id.to_string(),
    }
}

/// §5 item 1 (fixture): undoing an archive within the window restores exactly
/// the originally-INBOX messages; a message that was already out of the inbox
/// stays out. Uses the seeded conv-01 with one message marked non-INBOX.
#[test]
fn fixture_undo_within_the_window_restores_only_originally_inbox_messages() {
    let dir = temp_profile("fixture-restore-preimage");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let core =
        MailCore::open_with_clock(&dir, Arc::clone(&clock) as Arc<dyn mail_core::clock::Clock>)
            .unwrap();
    let provider = Arc::new(FakeArchiveProvider::new());
    core.start_worker(provider.clone()).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.join("mail.db")).unwrap();
        conn.execute(
            "UPDATE messages SET provider_inbox = 0
             WHERE account_id = ?1 AND conversation_id = 'conv-01' AND message_id = 'm-01-2'",
            rusqlite::params![mail_core::ACCOUNT_ID],
        )
        .unwrap();
    }
    let conversation = fixture_ref("conv-01");
    let archive = core
        .set_archived(&SetArchived {
            conversation: conversation.clone(),
            archived: true,
            request_id: "fixture-archive-1".to_string(),
        })
        .unwrap();
    assert!(until(|| {
        core.list_conversations()
            .unwrap()
            .activity
            .iter()
            .any(|op| op.id == archive.operation_id && op.status == OperationStatus::Confirmed)
    }));

    let receipt = core
        .undo_operation(&undo(&archive.operation_id, "fixture-undo-1"))
        .unwrap();
    assert_eq!(receipt.undone_operation_id, archive.operation_id);
    assert_eq!(receipt.outcome, UndoOutcome::Compensating);
    assert_eq!(
        receipt.operation_ids.len(),
        2,
        "one compensating op per distinct prior value"
    );
    assert!(until(|| {
        receipt.operation_ids.iter().all(|id| {
            core.list_conversations()
                .unwrap()
                .activity
                .iter()
                .any(|op| op.id == *id && op.status == OperationStatus::Confirmed)
        })
    }));
    // The originally-INBOX messages are back; the non-INBOX message stays out.
    {
        let conn = rusqlite::Connection::open(dir.join("mail.db")).unwrap();
        let inbox_of = |message_id: &str| -> bool {
            conn.query_row(
                "SELECT provider_inbox FROM messages
                 WHERE account_id = ?1 AND conversation_id = 'conv-01' AND message_id = ?2",
                rusqlite::params![mail_core::ACCOUNT_ID, message_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
                != 0
        };
        assert!(inbox_of("m-01-1"));
        assert!(!inbox_of("m-01-2"), "the non-INBOX message stays out");
        assert!(inbox_of("m-01-3"));
    }
    assert!(core
        .list_conversations()
        .unwrap()
        .conversations
        .iter()
        .any(|c| c.conversation_ref == conversation));
    core.stop_worker();
    drop(core);
    let _ = std::fs::remove_dir_all(dir);
}

/// §5 item 2 (fixture): at the 10 s deadline undo is rejected `expired` and
/// nothing is enqueued.
#[test]
fn fixture_undo_after_the_window_is_rejected_as_expired_and_enqueues_nothing() {
    let dir = temp_profile("fixture-expired");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let core =
        MailCore::open_with_clock(&dir, Arc::clone(&clock) as Arc<dyn mail_core::clock::Clock>)
            .unwrap();
    let archive = core
        .set_archived(&SetArchived {
            conversation: fixture_ref("conv-01"),
            archived: true,
            request_id: "fixture-archive-2".to_string(),
        })
        .unwrap();
    let activity_before = core.list_conversations().unwrap().activity.len();
    clock.advance_seconds(10);
    let error = core
        .undo_operation(&undo(&archive.operation_id, "fixture-undo-2"))
        .unwrap_err();
    assert_eq!(undo_reason(&error), Some(UndoUnavailableReason::Expired));
    assert_eq!(
        core.list_conversations().unwrap().activity.len(),
        activity_before
    );
    let activity = core.list_conversations().unwrap().activity;
    let row = activity
        .iter()
        .find(|op| op.id == archive.operation_id)
        .unwrap();
    assert_eq!(row.status, OperationStatus::Queued);
    assert_eq!(
        row.undoable_until, None,
        "expired op discloses no undo window"
    );
    core.stop_worker();
    let _ = std::fs::remove_dir_all(dir);
}

/// §5 item 3 (fixture): a still-queued archive is cancelled in place with
/// zero provider calls; the overlay disappears, Activity shows `cancelled`,
/// and the cancelled archive is not cached-Done evidence.
#[test]
fn fixture_undo_of_a_queued_operation_cancels_in_place_with_zero_provider_calls() {
    use mail_core::dto::CachedDoneRequest;
    let dir = temp_profile("fixture-cancel-in-place");
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:00Z")));
    let core =
        MailCore::open_with_clock(&dir, Arc::clone(&clock) as Arc<dyn mail_core::clock::Clock>)
            .unwrap();
    let provider = Arc::new(FakeArchiveProvider::new());
    provider.set_paused(true);
    // No worker started: the accepted archive stays durably queued.
    let archive = core
        .set_archived(&SetArchived {
            conversation: fixture_ref("conv-01"),
            archived: true,
            request_id: "fixture-archive-3".to_string(),
        })
        .unwrap();
    assert!(core
        .list_conversations()
        .unwrap()
        .activity
        .iter()
        .any(|op| op.id == archive.operation_id && op.status == OperationStatus::Queued));
    assert!(
        core.list_conversations()
            .unwrap()
            .conversations
            .iter()
            .all(|c| c.conversation_ref.conversation_id != "conv-01"),
        "the queued archive overlays the row out of the inbox"
    );

    let receipt = core
        .undo_operation(&undo(&archive.operation_id, "fixture-undo-3"))
        .unwrap();
    assert_eq!(receipt.undone_operation_id, archive.operation_id);
    assert_eq!(receipt.outcome, UndoOutcome::Cancelled);
    assert!(receipt.operation_ids.is_empty());
    assert_eq!(
        provider.call_count(),
        0,
        "cancelled in place, zero provider calls"
    );

    let snapshot = core.list_conversations().unwrap();
    let row = snapshot
        .activity
        .iter()
        .find(|op| op.id == archive.operation_id)
        .unwrap();
    assert_eq!(row.status, OperationStatus::Cancelled);
    assert_eq!(row.undoable_until, None);
    assert!(
        snapshot
            .conversations
            .iter()
            .any(|c| c.conversation_ref.conversation_id == "conv-01"),
        "overlay gone, row is back in the inbox"
    );
    let page = core
        .list_cached_done(&CachedDoneRequest {
            account_id: mail_core::ACCOUNT_ID.to_string(),
            limit: 100,
            cursor: None,
        })
        .unwrap();
    assert!(
        page.conversations.is_empty(),
        "a cancelled archive is not cached-Done evidence"
    );
    core.stop_worker();
    let _ = std::fs::remove_dir_all(dir);
}

/// §5 item 12 (fixture): the schema_version 1 → 2 migration preserves every
/// operation row and request key, admits 'cancelled' in the rebuilt CHECK,
/// and unknown versions still fail closed.
#[test]
fn fixture_migration_one_to_two_preserves_rows_and_request_keys_and_fails_closed() {
    let dir = temp_profile("fixture-migration-1-2");
    std::fs::create_dir_all(&dir).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.join("mail.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO meta VALUES ('schema_version', '1');
             CREATE TABLE operations (
                 seq                INTEGER PRIMARY KEY AUTOINCREMENT,
                 operation_id       TEXT NOT NULL UNIQUE,
                 account_id         TEXT NOT NULL,
                 conversation_id    TEXT NOT NULL,
                 requested_archived INTEGER NOT NULL CHECK (requested_archived IN (0, 1)),
                 status             TEXT NOT NULL
                     CHECK (status IN ('queued', 'applying', 'confirmed', 'failed')),
                 failure_kind       TEXT,
                 accepted_at        TEXT NOT NULL,
                 confirmed_at       TEXT,
                 message_ids        TEXT NOT NULL,
                 request_id         TEXT NOT NULL
             );
             INSERT INTO operations
                 (operation_id, account_id, conversation_id, requested_archived, status,
                  failure_kind, accepted_at, confirmed_at, message_ids, request_id)
             VALUES
                 ('op-v1', 'fixture-account', 'conv-01', 1, 'confirmed', NULL,
                  '2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z', '[\"m-01-1\",\"m-01-2\"]',
                  'req-v1'),
                 ('op-v1-queued', 'fixture-account', 'conv-02', 1, 'queued', NULL,
                  '2026-01-01T00:00:00Z', NULL, '[\"m-02-1\"]', 'req-v1-queued');
             CREATE TABLE request_keys (
                 account_id      TEXT NOT NULL,
                 request_id      TEXT NOT NULL,
                 operation_id    TEXT NOT NULL,
                 fingerprint     TEXT NOT NULL,
                 accepted_at     TEXT NOT NULL,
                 PRIMARY KEY (account_id, request_id)
             );
             INSERT INTO request_keys VALUES
                 ('fixture-account', 'req-v1', 'op-v1',
                  'set_archived|v1|account=fixture-account|conversation=conv-01|archived=true',
                  '2026-01-01T00:00:00Z');",
        )
        .unwrap();
    }
    let clock = Arc::new(FakeClock::new(utc("2026-01-01T00:00:05Z")));
    let core =
        MailCore::open_with_clock(&dir, Arc::clone(&clock) as Arc<dyn mail_core::clock::Clock>)
            .unwrap();
    // Rows and their seq order are preserved.
    let activity = core.list_conversations().unwrap().activity;
    let migrated = activity.iter().find(|op| op.id == "op-v1").unwrap();
    assert_eq!(migrated.status, OperationStatus::Confirmed);
    assert_eq!(migrated.conversation.conversation_id, "conv-01");
    assert_eq!(migrated.undo_of, None);
    assert_eq!(
        migrated.undoable_until, None,
        "a migrated row has no preimage and is not undoable"
    );
    // Request keys are preserved: the original receipt replays exactly.
    let replayed = core
        .set_archived(&SetArchived {
            conversation: fixture_ref("conv-01"),
            archived: true,
            request_id: "req-v1".to_string(),
        })
        .unwrap();
    assert_eq!(replayed.operation_id, "op-v1");
    // The migrated rows have no persisted preimage: undo fails closed. The
    // queued row is the newest non-compensating operation, so the failure is
    // its unknown preimage, not supersession.
    let error = core
        .undo_operation(&undo("op-v1-queued", "undo-migrated"))
        .unwrap_err();
    assert_eq!(
        undo_reason(&error),
        Some(UndoUnavailableReason::UnknownPrior)
    );
    {
        let conn = rusqlite::Connection::open(dir.join("mail.db")).unwrap();
        let version: String = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, "2");
    }
    core.stop_worker();
    drop(core);

    // Unknown schema versions still fail closed.
    let dir2 = temp_profile("fixture-migration-unknown");
    std::fs::create_dir_all(&dir2).unwrap();
    {
        let conn = rusqlite::Connection::open(dir2.join("mail.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO meta VALUES ('schema_version', '9');",
        )
        .unwrap();
    }
    assert!(matches!(
        MailCore::open(&dir2),
        Err(MailError::StorageUnavailable)
    ));
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(dir2);
}
