//! Shared scripted provider for Gmail operation integration tests.
use crate::dto::{Address, MailboxOperationKind};
use crate::error::MailError;
use crate::gmail::types::{GmailHistoryError, GmailProfile, GmailThread, HistoryPage, InboxPage};
use crate::CancelToken;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

type ReadHook = Arc<dyn Fn() + Send + Sync>;
type CancelReadHook = Arc<dyn Fn(&CancelToken) + Send + Sync>;
type ReplyRead = (
    Option<ReadHook>,
    Option<CancelReadHook>,
    Option<MailError>,
    Option<GmailThread>,
);

pub const ACCOUNT: &str = "acct-operations";
pub const THREAD: &str = "thread-operations";
use super::TIMEOUT;

pub fn profile() -> GmailProfile {
    super::profile(ACCOUNT, "operations@example.test", "history-1")
}

fn profile_for(account_id: &str) -> GmailProfile {
    super::profile(
        account_id,
        &format!("{account_id}@example.test"),
        "history-1",
    )
}

pub fn sample_thread() -> GmailThread {
    let message = super::message(
        "m-1",
        "sender@example.test",
        "2026-01-01T00:00:00Z",
        "synthetic body",
    );
    let mut thread = super::thread(
        ACCOUNT,
        THREAD,
        vec![message],
        &["m-1", "m-2"],
        Some(vec!["m-2".into()]),
        "history-1",
    );
    // m-2 has no renderable body but remains part of immutable mutation targets.
    thread.message_ids = Some(vec!["m-1".into(), "m-2".into()]);
    thread.conversation.context_complete = Some(false);
    thread.conversation.unsupported_reason = Some("unsupported second body".into());
    thread
}

#[derive(Clone)]
pub enum ApplyPlan {
    Success,
    Error(MailError),
    BeforeDispatchError(MailError),
    BlockThenSuccess,
    ApplyThenBlock,
    UnknownAfterApply,
}

#[derive(Clone)]
pub enum ProfilePlan {
    Value(GmailProfile),
    Error(MailError),
}

pub struct FakeState {
    // Worker integration scenarios share these gates with the operation and
    // cache scripts, so the tests exercise one provider implementation.
    pub halt_mode: bool,
    pub block_history: bool,
    pub halt_history_started: bool,
    pub halt_writes: usize,
    pub mutation_granted: bool,
    pub auth_expired: bool,
    pub include_reply: bool,
    pub archived: bool,
    pub incomplete: bool,
    pub fail_history: bool,
    pub halt_history_calls: usize,
    pub block_thread: bool,
    pub thread_started: bool,
    pub search_reads: usize,
    pub enabled: bool,
    pub grant_blocked: bool,
    pub grant_started: bool,
    pub grant_error: Option<MailError>,
    pub apply_plan: ApplyPlan,
    pub apply_blocked: bool,
    pub profile_error: Option<MailError>,
    pub disconnect_error: Option<MailError>,
    pub mutation_access_error: Option<MailError>,
    pub mutation_access_error_after: Option<usize>,
    pub mutation_access_calls: usize,
    pub thread_fetch_error: Option<MailError>,
    pub thread_fetch_blocked: bool,
    pub history_blocked: bool,
    pub history_started: bool,
    pub changed_history: bool,
    pub thread_fetches: usize,
    pub thread: GmailThread,
    pub threads: Vec<GmailThread>,
    pub before_dispatch_errors: usize,
    pub writes: Vec<(MailboxOperationKind, bool, Vec<String>)>,
    pub profile_account: String,
    pub configured: bool,
    pub credentials: bool,
    pub connect_plan: ProfilePlan,
    pub profile_plan: ProfilePlan,
    pub inbox: HashMap<Option<String>, InboxPage>,
    pub history: HashMap<Option<String>, HistoryPage>,
    pub expired_starts: HashSet<String>,
    pub sticky_error: Option<MailError>,
    pub thread_errors: HashMap<String, MailError>,
    pub paused_method: Option<&'static str>,
    pub pause_thread_id: Option<String>,
    pub calls: Vec<String>,
    pub inflight: usize,
    pub disconnect_calls: usize,
    pub disconnect_paused: bool,
    pub cache_mode: bool,
    pub destination_fail: bool,
    pub destination_account: String,
    pub destination_credentialless: bool,
    pub destination_released: bool,
    pub destination_admissions: Vec<String>,
    pub destination_calls: Vec<(String, Option<String>)>,
    pub reply_error: Option<MailError>,
    pub reply_thread_calls: usize,
    pub active_provider_reads: usize,
    pub reply_configured: bool,
    pub reply_credentials: bool,
    pub reply_disconnect_calls: usize,
    pub premature_disconnect: bool,
    pub on_get_thread: Option<ReadHook>,
    pub on_get_thread_cancel: Option<CancelReadHook>,
    pub reply_mode: bool,
}

pub struct FakeProvider {
    pub state: Arc<Mutex<FakeState>>,
    pub mutation_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    pub search_error: Mutex<Option<MailError>>,
    pub search_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    pub search_reads: AtomicUsize,
    gate: Arc<Condvar>,
}

struct GateGuard {
    state: Arc<Mutex<FakeState>>,
    gate: Arc<Condvar>,
}
impl Drop for GateGuard {
    fn drop(&mut self) {
        let mut state = self.state.lock().expect("fake provider poisoned");
        state.inflight -= 1;
        drop(state);
        self.gate.notify_all();
    }
}

impl FakeProvider {
    pub fn new(enabled: bool) -> Arc<Self> {
        Arc::new(Self {
            state: Arc::new(Mutex::new(FakeState {
                halt_mode: false,
                block_history: false,
                halt_history_started: false,
                halt_writes: 0,
                mutation_granted: true,
                auth_expired: false,
                include_reply: false,
                archived: false,
                incomplete: false,
                fail_history: false,
                halt_history_calls: 0,
                block_thread: false,
                thread_started: false,
                search_reads: 0,
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
                threads: vec![sample_thread()],
                before_dispatch_errors: 0,
                writes: Vec::new(),
                profile_account: ACCOUNT.to_string(),
                configured: true,
                credentials: true,
                connect_plan: ProfilePlan::Value(profile()),
                profile_plan: ProfilePlan::Value(profile()),
                inbox: HashMap::new(),
                history: HashMap::new(),
                expired_starts: HashSet::new(),
                sticky_error: None,
                thread_errors: HashMap::new(),
                paused_method: None,
                pause_thread_id: None,
                calls: Vec::new(),
                inflight: 0,
                disconnect_calls: 0,
                disconnect_paused: false,
                cache_mode: false,
                destination_fail: false,
                destination_account: "a".into(),
                destination_credentialless: false,
                destination_released: true,
                destination_admissions: Vec::new(),
                destination_calls: Vec::new(),
                reply_error: None,
                reply_thread_calls: 0,
                active_provider_reads: 0,
                reply_configured: true,
                reply_credentials: true,
                reply_disconnect_calls: 0,
                premature_disconnect: false,
                on_get_thread: None,
                on_get_thread_cancel: None,
                reply_mode: false,
            })),
            mutation_hook: Mutex::new(None),
            search_error: Mutex::new(None),
            search_hook: Mutex::new(None),
            search_reads: AtomicUsize::new(0),
            gate: Arc::new(Condvar::new()),
        })
    }

    pub fn with_threads(threads: Vec<GmailThread>) -> Arc<Self> {
        let provider = Self::new(true);
        {
            let mut state = provider.state.lock().unwrap();
            if let Some(first) = threads.first() {
                state.profile_account = first.conversation.conversation_ref.account_id.clone();
                state.thread = first.clone();
                let profile = profile_for(&state.profile_account);
                state.connect_plan = ProfilePlan::Value(profile.clone());
                state.profile_plan = ProfilePlan::Value(profile);
            }
            state.threads = threads;
        }
        provider
    }

    pub fn new_for_cache() -> (Arc<Self>, GmailProfile) {
        let profile = GmailProfile {
            account_id: "acct-alpha-9f3".into(),
            email_address: "alpha@example.test".into(),
            history_id: "hist-1000".into(),
        };
        let provider = Self::new(true);
        {
            let mut state = provider.state.lock().unwrap();
            state.cache_mode = true;
            state.profile_account = profile.account_id.clone();
            state.connect_plan = ProfilePlan::Value(profile.clone());
            state.profile_plan = ProfilePlan::Value(profile.clone());
            state.inbox.clear();
            state.history.clear();
            state.threads.clear();
        }
        (provider, profile)
    }

    pub fn new_for_destinations() -> Arc<Self> {
        let provider = Self::new(true);
        {
            let mut state = provider.state.lock().unwrap();
            state.profile_account = "a".into();
            let profile = profile_for("a");
            state.connect_plan = ProfilePlan::Value(profile.clone());
            state.profile_plan = ProfilePlan::Value(profile);
            state.threads.clear();
            state.thread.conversation.conversation_ref.account_id = "a".into();
            state.thread.conversation.conversation_ref.conversation_id = "uncached".into();
            state.destination_account = "a".into();
        }
        provider
    }

    pub fn with_thread(thread: GmailThread) -> Arc<Self> {
        let provider = Self::new(false);
        {
            let mut state = provider.state.lock().unwrap();
            state.thread = thread.clone();
            state.threads = vec![thread];
            state.profile_account = state
                .thread
                .conversation
                .conversation_ref
                .account_id
                .clone();
            state.reply_configured = false;
            state.reply_credentials = false;
            state.reply_mode = true;
            state.cache_mode = false;
            let profile = profile_for(&state.profile_account);
            state.connect_plan = ProfilePlan::Value(profile.clone());
            state.profile_plan = ProfilePlan::Value(profile);
        }
        provider
    }

    pub fn with_halt_thread(thread: GmailThread) -> Arc<Self> {
        let provider = Self::with_threads(vec![thread]);
        {
            let mut state = provider.state.lock().unwrap();
            state.halt_mode = true;
            state.enabled = true;
            state.configured = true;
            state.credentials = true;
            state.reply_mode = false;
        }
        provider
    }

    pub fn block_history(&self) {
        let mut s = self.state.lock().unwrap();
        s.block_history = true;
        s.history_started = false;
    }
    pub fn release_history(&self) {
        self.state.lock().unwrap().block_history = false;
        self.gate.notify_all();
    }
    pub fn set_mutation_access(&self, granted: bool) {
        let mut s = self.state.lock().unwrap();
        s.mutation_granted = granted;
        s.enabled = granted;
    }
    pub fn halt_writes(&self) -> usize {
        self.state.lock().unwrap().halt_writes
    }

    pub fn set_reply_error(&self, error: Option<MailError>) {
        self.state.lock().unwrap().reply_error = error;
    }
    pub fn set_reply_configured(&self, value: bool) {
        self.state.lock().unwrap().reply_configured = value;
    }
    pub fn set_reply_credentials(&self, value: bool) {
        self.state.lock().unwrap().reply_credentials = value;
    }
    pub fn reply_credentials(&self) -> bool {
        self.state.lock().unwrap().reply_credentials
    }
    pub fn reply_thread_calls(&self) -> usize {
        self.state.lock().unwrap().reply_thread_calls
    }
    pub fn reply_disconnect_calls(&self) -> usize {
        self.state.lock().unwrap().reply_disconnect_calls
    }
    pub fn premature_disconnect(&self) -> bool {
        self.state.lock().unwrap().premature_disconnect
    }
    pub fn set_reply_get_thread_hook(&self, hook: Option<ReadHook>) {
        self.state.lock().unwrap().on_get_thread = hook;
    }
    pub fn set_reply_get_thread_cancel_hook(&self, hook: Option<CancelReadHook>) {
        self.state.lock().unwrap().on_get_thread_cancel = hook;
    }

    pub fn park_destinations(&self) {
        self.state.lock().unwrap().destination_released = false;
    }
    pub fn release_destinations(&self) {
        self.state.lock().unwrap().destination_released = true;
        self.gate.notify_all();
    }
    pub fn set_destination_fail(&self, value: bool) {
        self.state.lock().unwrap().destination_fail = value;
    }
    pub fn set_destination_account(&self, account: &str) {
        self.state.lock().unwrap().destination_account = account.into();
    }
    pub fn set_destination_credentialless(&self, value: bool) {
        self.state.lock().unwrap().destination_credentialless = value;
    }
    pub fn destination_calls(&self) -> Vec<(String, Option<String>)> {
        self.state.lock().unwrap().destination_calls.clone()
    }
    pub fn destination_admission_count(&self) -> usize {
        self.state.lock().unwrap().destination_admissions.len()
    }
    pub fn wait_for_destination_admissions(&self, baseline: usize, count: usize) {
        let deadline = Instant::now() + TIMEOUT;
        while self.destination_admission_count() < baseline + count {
            assert!(Instant::now() < deadline, "provider call never admitted");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    pub fn set_configured(&self, value: bool) {
        self.state.lock().unwrap().configured = value;
    }
    pub fn set_credentials(&self, value: bool) {
        self.state.lock().unwrap().credentials = value;
    }
    pub fn set_connect_plan(&self, value: ProfilePlan) {
        self.state.lock().unwrap().connect_plan = value;
    }
    pub fn set_profile_plan(&self, value: ProfilePlan) {
        self.state.lock().unwrap().profile_plan = value;
    }
    pub fn set_inbox(&self, value: HashMap<Option<String>, InboxPage>) {
        self.state.lock().unwrap().inbox = value;
    }
    pub fn set_history(&self, value: HashMap<Option<String>, HistoryPage>) {
        self.state.lock().unwrap().history = value;
    }
    pub fn set_threads(&self, value: HashMap<String, GmailThread>) {
        let mut state = self.state.lock().unwrap();
        state.threads = value.values().cloned().collect();
        state.thread = state.threads.first().cloned().unwrap_or_else(sample_thread);
        state.cache_mode = true;
    }
    pub fn expire_history_start(&self, start: &str) {
        self.state
            .lock()
            .unwrap()
            .expired_starts
            .insert(start.into());
    }
    pub fn fail_thread(&self, id: &str, error: Option<MailError>) {
        let mut state = self.state.lock().unwrap();
        if let Some(error) = error {
            state.thread_errors.insert(id.into(), error);
        } else {
            state.thread_errors.remove(id);
        }
    }
    pub fn set_sticky_error(&self, error: Option<MailError>) {
        self.state.lock().unwrap().sticky_error = error;
    }
    pub fn set_disconnect_paused(&self, value: bool) {
        self.state.lock().unwrap().disconnect_paused = value;
        self.gate.notify_all();
    }
    pub fn set_paused_method(&self, method: Option<&'static str>) {
        self.state.lock().unwrap().paused_method = method;
        self.gate.notify_all();
    }
    pub fn pause_thread(&self, id: Option<&str>) {
        self.state.lock().unwrap().pause_thread_id = id.map(str::to_string);
        self.gate.notify_all();
    }
    pub fn calls_matching(&self, prefix: &str) -> Vec<String> {
        self.state
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|c| c.starts_with(prefix))
            .cloned()
            .collect()
    }
    pub fn disconnect_calls(&self) -> usize {
        self.state.lock().unwrap().disconnect_calls
    }
    pub fn has_credentials(&self) -> bool {
        self.state.lock().unwrap().credentials
    }
    pub fn wait_for_calls(&self, prefix: &str, count: usize) -> bool {
        let deadline = Instant::now() + TIMEOUT;
        let mut state = self.state.lock().unwrap();
        loop {
            if state.calls.iter().filter(|c| c.starts_with(prefix)).count() >= count {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            state = self.gate.wait_timeout(state, remaining).unwrap().0;
        }
    }
    pub fn wait_for_inflight(&self, count: usize) -> bool {
        let deadline = Instant::now() + TIMEOUT;
        let mut state = self.state.lock().unwrap();
        while state.inflight < count {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            state = self.gate.wait_timeout(state, remaining).unwrap().0;
        }
        true
    }
    pub fn wait_until_idle(&self) -> bool {
        let deadline = Instant::now() + TIMEOUT;
        let mut state = self.state.lock().unwrap();
        while state.inflight > 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            state = self.gate.wait_timeout(state, remaining).unwrap().0;
        }
        true
    }
    fn enter(
        &self,
        method: &'static str,
        key: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<GateGuard, MailError> {
        let mut state = self.state.lock().unwrap();
        state.inflight += 1;
        self.gate.notify_all();
        let paused = |s: &FakeState| {
            s.paused_method == Some(method)
                && match (&s.pause_thread_id, key) {
                    (Some(a), Some(b)) => a == b,
                    (Some(_), None) => false,
                    (None, _) => true,
                }
        };
        while paused(&state) && !cancel.is_cancelled() {
            state = self
                .gate
                .wait_timeout(state, Duration::from_millis(10))
                .unwrap()
                .0;
        }
        if cancel.is_cancelled() {
            state.inflight -= 1;
            drop(state);
            self.gate.notify_all();
            return Err(MailError::AuthCancelled);
        }
        if let Some(error) = state.sticky_error.clone() {
            state.inflight -= 1;
            drop(state);
            self.gate.notify_all();
            return Err(error);
        }
        Ok(GateGuard {
            state: self.state.clone(),
            gate: self.gate.clone(),
        })
    }

    fn admit_destination(&self, expected: &str, cancel: &CancelToken) -> Result<(), MailError> {
        self.state
            .lock()
            .unwrap()
            .destination_admissions
            .push(expected.to_string());
        loop {
            if cancel.is_cancelled() {
                return Err(MailError::AuthCancelled);
            }
            if self.state.lock().unwrap().destination_released {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let state = self.state.lock().unwrap();
        if state.destination_credentialless {
            return Err(MailError::AuthRequired);
        }
        if state.destination_account != expected {
            return Err(MailError::AuthFailed);
        }
        Ok(())
    }

    fn synthetic_destination_thread(id: &str, account: &str) -> GmailThread {
        let message_id = format!("m-{id}");
        let message = super::message(
            &message_id,
            "sender@example.test",
            "2025-01-01T00:00:00Z",
            "<script>literal</script>",
        );
        let mut thread = super::thread(
            account,
            id,
            vec![message],
            &[&message_id],
            Some(vec![message_id.clone()]),
            "1",
        );
        thread.conversation.subject = "Uncached".into();
        thread.conversation.is_read = Some(false);
        thread
    }

    fn begin_reply_read(&self, thread_read: bool) -> ReplyRead {
        let mut state = self.state.lock().unwrap();
        state.active_provider_reads += 1;
        if thread_read {
            state.reply_thread_calls += 1;
        }
        (
            state.on_get_thread.clone(),
            state.on_get_thread_cancel.clone(),
            state.reply_error.clone(),
            Some(state.thread.clone()),
        )
    }

    fn finish_reply_read(&self) {
        let mut state = self.state.lock().unwrap();
        state.active_provider_reads = state.active_provider_reads.saturating_sub(1);
        drop(state);
        self.gate.notify_all();
    }

    pub fn set_apply_plan(&self, plan: ApplyPlan) {
        self.state.lock().unwrap().apply_plan = plan;
        self.gate.notify_all();
    }

    pub fn set_profile_error(&self, error: Option<MailError>) {
        self.state.lock().unwrap().profile_error = error;
        self.gate.notify_all();
    }

    pub fn set_disconnect_error(&self, error: Option<MailError>) {
        self.state.lock().unwrap().disconnect_error = error;
    }

    pub fn fail_mutation_access_after(&self, additional_calls: usize, error: MailError) {
        let mut state = self.state.lock().unwrap();
        state.mutation_access_error_after = Some(state.mutation_access_calls + additional_calls);
        state.mutation_access_error = Some(error);
        drop(state);
        self.gate.notify_all();
    }

    pub fn clear_mutation_access_error(&self) {
        let mut state = self.state.lock().unwrap();
        state.mutation_access_error_after = None;
        state.mutation_access_error = None;
        drop(state);
        self.gate.notify_all();
    }

    pub fn set_thread_fetch_error(&self, error: Option<MailError>) {
        self.state.lock().unwrap().thread_fetch_error = error;
        self.gate.notify_all();
    }

    pub fn set_thread_fetch_blocked(&self, blocked: bool) {
        let mut state = self.state.lock().unwrap();
        state.thread_fetch_blocked = blocked;
        drop(state);
        self.gate.notify_all();
    }

    pub fn set_external_read(&self, read: bool) {
        let mut state = self.state.lock().unwrap();
        let unread = state.thread.unread_message_ids.as_mut().unwrap();
        if read {
            unread.clear();
        } else if !unread.contains(&"m-2".to_string()) {
            unread.push("m-2".to_string());
        }
        state.thread.conversation.is_read = Some(unread.is_empty());
        let primary = state.thread.clone();
        if let Some(first) = state.threads.first_mut() {
            *first = primary;
        }
        drop(state);
        self.gate.notify_all();
    }

    pub fn set_grant_blocked(&self, blocked: bool) {
        self.state.lock().unwrap().grant_blocked = blocked;
        self.gate.notify_all();
    }

    pub fn set_grant_error(&self, error: Option<MailError>) {
        self.state.lock().unwrap().grant_error = error;
    }

    pub fn set_profile_account(&self, account: &str) {
        let mut state = self.state.lock().unwrap();
        state.profile_account = account.to_string();
        if let ProfilePlan::Value(profile) = &mut state.profile_plan {
            profile.account_id = account.to_string();
        }
    }

    pub fn set_history_blocked(&self, blocked: bool) {
        let mut state = self.state.lock().unwrap();
        state.history_blocked = blocked;
        state.history_started = false;
        drop(state);
        self.gate.notify_all();
    }

    pub fn set_changed_history(&self, changed: bool) {
        self.state.lock().unwrap().changed_history = changed;
    }

    pub fn wait_for_history(&self) -> bool {
        self.wait_for(|state| state.history_started)
    }

    pub fn wait_for_thread_fetches(&self, count: usize) -> bool {
        self.wait_for(|state| state.thread_fetches >= count)
    }

    pub fn wait_for_grant(&self) -> bool {
        self.wait_for(|state| state.grant_started)
    }

    pub fn wait_for_apply(&self, count: usize) -> bool {
        self.wait_for(|state| state.writes.len() >= count)
    }

    pub fn wait_for(&self, mut predicate: impl FnMut(&FakeState) -> bool) -> bool {
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

    pub fn writes(&self) -> Vec<(MailboxOperationKind, bool, Vec<String>)> {
        self.state.lock().unwrap().writes.clone()
    }

    pub fn set_new_incoming_message(&self) {
        let mut state = self.state.lock().unwrap();
        let thread = &mut state.thread;
        thread.message_ids.as_mut().unwrap().push("m-3".to_string());
        thread.inbox_message_ids.push("m-3".to_string());
        thread.conversation.messages.push(crate::dto::Message {
            id: "m-3".to_string(),
            from: Address {
                display_name: None,
                mailbox: "sender@example.test".to_string(),
            },
            to: vec![],
            sent_at: "2026-02-01T00:00:00Z".to_string(),
            body_text: "new incoming".to_string(),
            has_attachment: None,
        });
        let primary = state.thread.clone();
        if let Some(first) = state.threads.first_mut() {
            *first = primary;
        }
    }

    fn apply(
        &self,
        kind: MailboxOperationKind,
        ids: &[String],
        value: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        if self.state.lock().unwrap().halt_mode {
            let mut state = self.state.lock().unwrap();
            if let Some(hook) = self.mutation_hook.lock().unwrap().take() {
                drop(state);
                hook();
                state = self.state.lock().unwrap();
            }
            state.halt_writes += 1;
            self.gate.notify_all();
            return Ok(());
        }
        let plan = {
            let mut state = self.state.lock().unwrap();
            let plan = state.apply_plan.clone();
            if let ApplyPlan::BeforeDispatchError(error) = &plan {
                state.before_dispatch_errors += 1;
                return Err(error.clone());
            }
            // Publish the gate before advertising the call. Otherwise a test
            // could release after wait_for_apply but before the gate is armed.
            if matches!(
                plan,
                ApplyPlan::BlockThenSuccess | ApplyPlan::ApplyThenBlock
            ) {
                state.apply_blocked = true;
            }
            state.writes.push((kind, value, ids.to_vec()));
            self.gate.notify_all();
            plan
        };
        match plan {
            ApplyPlan::BlockThenSuccess => {
                let mut state = self.state.lock().unwrap();
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
        let primary = state.thread.clone();
        if let Some(first) = state.threads.first_mut() {
            *first = primary;
        }
        for thread in &mut state.threads {
            let relevant = ids.iter().any(|id| {
                thread
                    .message_ids
                    .as_ref()
                    .is_some_and(|all| all.contains(id))
                    || thread.inbox_message_ids.contains(id)
                    || thread.conversation.messages.iter().any(|m| m.id == *id)
            });
            if !relevant {
                continue;
            }
            match kind {
                MailboxOperationKind::Star => {
                    let stars = thread.star_facts.get_or_insert_with(Default::default);
                    for id in ids {
                        stars.insert(id.clone(), value);
                    }
                }
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
            thread.conversation.is_read = thread.unread_message_ids.as_ref().map(|u| u.is_empty());
        }
        if let Some(first) = state.threads.first() {
            state.thread = first.clone();
        }
    }

    pub fn release_apply(&self) {
        let mut state = self.state.lock().unwrap();
        state.apply_blocked = false;
        drop(state);
        self.gate.notify_all();
    }
}

impl crate::gmail::types::GmailReadProvider for FakeProvider {
    fn fetch_attachment(
        &self,
        _account: &str,
        _message: &str,
        _attachment: &str,
        cancel: &CancelToken,
    ) -> Result<Vec<u8>, MailError> {
        let (_hook, cancel_hook, error, _) = self.begin_reply_read(false);
        if let Some(hook) = cancel_hook {
            hook(cancel);
        }
        let result = crate::attachments::check_cancel(cancel)
            .and_then(|()| error.map_or(Ok(b"%PDF-1.7\n".to_vec()), Err));
        self.finish_reply_read();
        result
    }
    fn list_destinations_for_account(
        &self,
        expected: &str,
        cancel: &CancelToken,
    ) -> Result<Vec<crate::gmail::browsing::ProviderDestination>, MailError> {
        self.admit_destination(expected, cancel)?;
        Ok(vec![crate::gmail::browsing::ProviderDestination {
            id: "Label_1".into(),
            name: "<img src=x>".into(),
            user_label: true,
        }])
    }
    fn list_destination_for_account(
        &self,
        expected: &str,
        id: &str,
        cursor: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<InboxPage, MailError> {
        self.admit_destination(expected, cancel)?;
        let mut state = self.state.lock().unwrap();
        state
            .destination_calls
            .push((id.to_string(), cursor.map(str::to_string)));
        if state.destination_fail {
            return Err(MailError::NetworkUnavailable);
        }
        Ok(InboxPage {
            thread_ids: vec![if cursor.is_some() {
                "older"
            } else {
                "uncached"
            }
            .into()],
            next_page_token: cursor.is_none().then(|| "page-2".into()),
        })
    }
    fn get_thread_for_account(
        &self,
        expected: &str,
        id: &str,
        cancel: &CancelToken,
    ) -> Result<Option<GmailThread>, MailError> {
        if self.state.lock().unwrap().halt_mode {
            if expected != self.state.lock().unwrap().profile_account {
                return Err(MailError::NotFound);
            }
            let mut state = self.state.lock().unwrap();
            if state.block_thread {
                state.thread_started = true;
                self.gate.notify_all();
                while state.block_thread && !cancel.is_cancelled() {
                    state = self
                        .gate
                        .wait_timeout(state, Duration::from_millis(10))
                        .unwrap()
                        .0;
                }
                if cancel.is_cancelled() {
                    return Err(MailError::AuthCancelled);
                }
            }
            drop(state);
            return self.get_thread(id, cancel);
        }
        self.admit_destination(expected, cancel)?;
        Ok(Some(Self::synthetic_destination_thread(id, expected)))
    }
    fn mutation_access(&self) -> Result<bool, MailError> {
        if let Some(hook) = self.mutation_hook.lock().unwrap().take() {
            hook();
        }
        let mut state = self.state.lock().unwrap();
        if state.halt_mode {
            return Ok(state.mutation_granted);
        }
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
        let account = state.profile_account.clone();
        drop(state);
        Ok(profile_for(&account))
    }

    fn apply_archive(
        &self,
        ids: &[String],
        archived: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        self.apply(MailboxOperationKind::Archive, ids, archived, cancel)
    }

    fn apply_star(
        &self,
        ids: &[String],
        starred: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        self.apply(MailboxOperationKind::Star, ids, starred, cancel)
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
        let state = self.state.lock().unwrap();
        if state.reply_mode {
            state.reply_configured
        } else {
            state.configured
        }
    }
    fn has_credentials(&self) -> Result<bool, MailError> {
        let state = self.state.lock().unwrap();
        Ok(if state.reply_mode {
            state.reply_credentials
        } else {
            state.credentials && !state.destination_credentialless
        })
    }
    fn connect(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        if self.state.lock().unwrap().reply_mode {
            return Err(MailError::AuthRequired);
        }
        self.state.lock().unwrap().calls.push("connect".into());
        let _guard = self.enter("connect", None, cancel)?;
        let plan = self.state.lock().unwrap().connect_plan.clone();
        match plan {
            ProfilePlan::Value(profile) => Ok(profile),
            ProfilePlan::Error(error) => Err(error),
        }
    }
    fn disconnect(&self) -> Result<(), MailError> {
        let mut state = self.state.lock().unwrap();
        state.disconnect_calls += 1;
        state.calls.push("disconnect".into());
        self.gate.notify_all();
        while state.disconnect_paused {
            state = self.gate.wait(state).unwrap();
        }
        if let Some(error) = state.disconnect_error.clone() {
            return Err(error);
        }
        state.enabled = false;
        state.credentials = false;
        state.reply_disconnect_calls += 1;
        if state.active_provider_reads != 0 {
            state.premature_disconnect = true;
        }
        state.reply_credentials = false;
        Ok(())
    }
    fn profile(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        if self.state.lock().unwrap().reply_mode {
            return Err(MailError::AuthRequired);
        }
        self.state.lock().unwrap().calls.push("profile".into());
        let _guard = self.enter("profile", None, cancel)?;
        let state = self.state.lock().unwrap();
        if let Some(error) = &state.profile_error {
            return Err(error.clone());
        }
        if let ProfilePlan::Value(profile) = &state.profile_plan {
            return Ok(profile.clone());
        }
        if let ProfilePlan::Error(error) = &state.profile_plan {
            return Err(error.clone());
        }
        let mut value = profile_for(&state.profile_account);
        value.account_id = state.profile_account.clone();
        Ok(value)
    }
    fn list_inbox(&self, page: Option<&str>, cancel: &CancelToken) -> Result<InboxPage, MailError> {
        self.state
            .lock()
            .unwrap()
            .calls
            .push(format!("list_inbox|{}", page.unwrap_or("-")));
        let _guard = self.enter("list_inbox", None, cancel)?;
        let key = page.map(str::to_string);
        let state = self.state.lock().unwrap();
        if state.halt_mode {
            return Ok(InboxPage {
                thread_ids: state
                    .threads
                    .iter()
                    .map(|t| t.conversation.conversation_ref.conversation_id.clone())
                    .collect(),
                next_page_token: None,
            });
        }
        if state.cache_mode {
            return Ok(state.inbox.get(&key).cloned().unwrap_or(InboxPage {
                thread_ids: vec![],
                next_page_token: None,
            }));
        }
        Ok(InboxPage {
            thread_ids: state
                .threads
                .iter()
                .map(|t| t.conversation.conversation_ref.conversation_id.clone())
                .collect(),
            next_page_token: None,
        })
    }
    fn search_threads(
        &self,
        page: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<InboxPage, MailError> {
        if !self.state.lock().unwrap().halt_mode {
            return Err(MailError::ProviderUnavailable);
        }
        crate::attachments::check_cancel(cancel)?;
        let page: usize = page.unwrap_or("0").parse().unwrap();
        Ok(InboxPage {
            thread_ids: (page * 20..page * 20 + 20)
                .map(|n| format!("search-{n:03}"))
                .collect(),
            next_page_token: (page < 5).then(|| (page + 1).to_string()),
        })
    }
    fn get_thread(&self, id: &str, cancel: &CancelToken) -> Result<Option<GmailThread>, MailError> {
        if self.state.lock().unwrap().halt_mode {
            let state = self.state.lock().unwrap();
            if id == state.thread.conversation.conversation_ref.conversation_id {
                let mut thread = state.thread.clone();
                if state.archived {
                    thread.inbox_message_ids.clear();
                    thread.conversation.is_in_inbox = false;
                }
                if state.incomplete {
                    thread.conversation.context_complete = Some(false);
                }
                if state.include_reply {
                    thread.conversation.messages.push(crate::dto::Message {
                        id: "reply-1".into(),
                        from: Address {
                            display_name: None,
                            mailbox: "other@example.test".into(),
                        },
                        to: vec![],
                        sent_at: "2026-01-01T00:02:00Z".into(),
                        body_text: "synthetic reply".into(),
                        has_attachment: None,
                    });
                    thread.message_ids = Some(vec!["message-1".into(), "reply-1".into()]);
                }
                return Ok(Some(thread));
            }
            self.search_reads
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Some(error) = self.search_error.lock().unwrap().clone() {
                return Err(error);
            }
            let mut result = None;
            if id.starts_with("search-") {
                let mut thread = state.thread.clone();
                let message = format!("message-{id}");
                thread.conversation.conversation_ref.conversation_id = id.into();
                thread.conversation.subject = format!("synthetic {id}");
                if let Some(first) = thread.conversation.messages.first_mut() {
                    first.id = message.clone();
                }
                thread.conversation.is_in_inbox = false;
                thread.conversation.is_read = Some(false);
                thread.inbox_message_ids.clear();
                thread.message_ids = Some(vec![message.clone()]);
                thread.unread_message_ids = Some(vec![message]);
                result = Some(thread);
            }
            drop(state);
            let hook = self.search_hook.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
            return Ok(result);
        }
        if self.state.lock().unwrap().reply_mode {
            let (hook, cancel_hook, error, thread) = self.begin_reply_read(true);
            let result = (|| {
                if let Some(hook) = cancel_hook {
                    hook(cancel);
                }
                if let Some(hook) = hook {
                    hook();
                }
                if let Some(error) = error {
                    return Err(error);
                }
                Ok(thread)
            })();
            self.finish_reply_read();
            return result;
        }
        self.state
            .lock()
            .unwrap()
            .calls
            .push(format!("get_thread|{id}"));
        if let Some(error) = self.state.lock().unwrap().thread_errors.get(id).cloned() {
            return Err(error);
        }
        let _guard = self.enter("get_thread", Some(id), cancel)?;
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
        let thread = if state.cache_mode {
            state
                .threads
                .iter()
                .find(|t| t.conversation.conversation_ref.conversation_id == id)
                .cloned()
        } else if state.thread.conversation.conversation_ref.conversation_id == id {
            let primary = state.thread.clone();
            if let Some(first) = state.threads.first_mut() {
                if first.conversation.conversation_ref.conversation_id == id {
                    *first = primary.clone();
                }
            }
            Some(primary)
        } else {
            state
                .threads
                .iter()
                .find(|thread| thread.conversation.conversation_ref.conversation_id == id)
                .cloned()
        };
        drop(state);
        Ok(thread)
    }
    fn history(
        &self,
        start: &str,
        page: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<HistoryPage, GmailHistoryError> {
        if self.state.lock().unwrap().halt_mode {
            let mut state = self.state.lock().unwrap();
            state.halt_history_calls += 1;
            if state.fail_history {
                return Err(GmailHistoryError::Mail(MailError::NetworkUnavailable));
            }
            if state.auth_expired {
                return Err(GmailHistoryError::Mail(MailError::AuthRequired));
            }
            if state.block_history {
                state.halt_history_started = true;
                state.history_started = true;
                self.gate.notify_all();
                while state.block_history && !cancel.is_cancelled() {
                    state = self
                        .gate
                        .wait_timeout(state, Duration::from_millis(10))
                        .unwrap()
                        .0;
                }
            }
            if cancel.is_cancelled() {
                return Err(GmailHistoryError::Mail(MailError::AuthCancelled));
            }
            return Ok(HistoryPage {
                changed_thread_ids: vec![],
                deleted_message_ids: vec![],
                next_page_token: None,
                history_id: start.to_string(),
            });
        }
        self.state
            .lock()
            .unwrap()
            .calls
            .push(format!("history|{start}|{}", page.unwrap_or("-")));
        let _guard = self
            .enter("history", None, cancel)
            .map_err(GmailHistoryError::Mail)?;
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
        if state.expired_starts.contains(start) {
            return Err(GmailHistoryError::Expired);
        }
        let key = page.map(str::to_string);
        if state.cache_mode {
            return Ok(state.history.get(&key).cloned().unwrap_or(HistoryPage {
                changed_thread_ids: vec![],
                deleted_message_ids: vec![],
                next_page_token: None,
                history_id: start.to_string(),
            }));
        }
        let changed = state.changed_history;
        let changed_thread_ids = state
            .threads
            .iter()
            .map(|t| t.conversation.conversation_ref.conversation_id.clone())
            .collect();
        drop(state);
        Ok(HistoryPage {
            changed_thread_ids: if changed { changed_thread_ids } else { vec![] },
            deleted_message_ids: vec![],
            next_page_token: None,
            history_id: start.to_string(),
        })
    }
}
