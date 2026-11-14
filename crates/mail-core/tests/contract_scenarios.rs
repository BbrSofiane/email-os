//! Shared contract scenarios (ticket 17): the Rust half.
//!
//! Executes every file under `tests/fixtures/contract-scenarios/` against the
//! Rust backends and compares each step's observable result with the file's
//! expectations. The browser fake runs the SAME files from
//! `tests/browser-fake/contract-scenarios.test.ts`; the format is documented
//! in docs/development.md ("Contract scenarios").
//!
//! Backends under test (a parameter, see [`Backend`]):
//! * `gmail`   — `GmailCore` + the shared scripted `mail_core::testing` fake provider;
//! * `fixture` — the archive-only fixture `MailCore` + `FakeArchiveProvider`;
//! * `synthetic` — a synthetic session (ADR 0002): `GmailCore` + the built-in
//!   `SyntheticGmailProvider` under the synthetic session policy. EVERY
//!   scenario runs on it whatever profiles the file declares (the TypeScript
//!   runner only knows `gmail` and `fixture`). Scenarios whose mailbox is not
//!   a subset of the fixed 18 conversations get their extra threads from a
//!   test overlay on top of the synthetic provider.
//!
//! Time is each backend's `FakeClock`; nothing waits on wall-clock time. The
//! only polling is the shared bounded `until` used to observe an expected
//! state of the asynchronous worker.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use mail_core::clock::{utc, Clock, FakeClock};
use mail_core::dto::{RetryOperation, SetArchived, SetRead, UndoOperation};
use mail_core::error::MailError;
use mail_core::gmail::sync::GmailCore;
use mail_core::gmail::types::GmailThread;
use mail_core::groups::{
    GetOperationGroupRequest, ListOperationGroupsRequest, SetArchivedGroup, SetReadGroup,
    UndoOperationGroup,
};
use mail_core::stars::{SetStarred, SetStarredGroup};
use mail_core::testing::operations_fake::{ApplyPlan, FakeProvider};
use mail_core::testing::synthetic::Overlay;
use mail_core::testing::{open_core_with_clock, temp_profile, until};
use mail_core::{FakeArchiveProvider, MailCore};
use serde_json::{json, Value};

const CLOCK_START: &str = "2026-02-01T00:00:00Z";
const GMAIL_ACCOUNT: &str = "acct-contract";

/// Named, VISIBLE divergences: `(scenario, profile, why)`. The runner still
/// executes these and requires them to FAIL; when the divergence is fixed the
/// run fails until the entry is removed, so nothing is silently skipped.
const KNOWN_DIVERGENCES: &[(&str, &str, &str)] = &[
    (
    "group-member-failure-does-not-stop-siblings",
    "gmail",
    "KD-1: after a definite provider failure the Gmail worker ends its pass in sync-error backoff \
     (gmail/operations.rs run_one returns Err, sync.rs PassOutcome::SyncError), so queued siblings \
     stay `queued` until the next retry tick; the fixture worker keeps draining serially. \
     docs/ux-05 §4.1 only says children run serially and failures do not roll back siblings.",
    ),
    (
        "group-member-failure-does-not-stop-siblings",
        "synthetic",
        "KD-1: same cause as the gmail profile; the synthetic session runs the Gmail worker, so siblings \
         queued behind the failure drain at the next retry tick (which re-arms queued writes there), \
         not immediately.",
    ),
    (
        "fixture-rejects-unsupported-commands",
        "synthetic",
        "POLICY (ADR 0002 decision 2): the legacy fixture rejected read, star and retry; the unified \
         fixture admits them, so this scenario's legacy expectations no longer hold. The synthetic \
         rejections that DO remain are asserted in tests/synthetic_core_policy.rs. Retires with the \
         `fixture` profile at stage 4.",
    ),
];

// ------------------------------------------------------------------ backends

trait Backend {
    fn account_id(&self) -> String;
    fn execute(&self, command: &str, args: Value) -> Result<Value, MailError>;
    fn snapshot(&self) -> Value;
    fn advance(&self, seconds: i64);
    fn provider(&self, mode: &str) -> Result<(), String>;
    /// Called after a step's expectations settled (resets one-shot arming).
    fn after_step(&self, was_command: bool);
}

fn to_value<T: serde::Serialize>(result: Result<T, MailError>) -> Result<Value, MailError> {
    result.map(|value| serde_json::to_value(value).expect("serialize DTO"))
}

fn args_as<T: serde::de::DeserializeOwned>(args: Value) -> T {
    serde_json::from_value(args).expect("scenario args deserialize into the contract DTO")
}

struct GmailBackend {
    core: GmailCore,
    provider: Arc<FakeProvider>,
    clock: Arc<FakeClock>,
    armed_reject: std::sync::atomic::AtomicBool,
    _dir: tempfile::TempDir,
}

impl GmailBackend {
    fn open(mailbox: &Value) -> Self {
        let dir = temp_profile("contract-gmail");
        let clock = Arc::new(FakeClock::new(utc(CLOCK_START)));
        let threads = mailbox["conversations"]
            .as_array()
            .expect("mailbox conversations")
            .iter()
            .map(gmail_thread)
            .collect::<Vec<_>>();
        let provider = FakeProvider::with_threads(threads);
        let core = open_core_with_clock(dir.path(), &provider, &clock);
        assert!(
            until(|| core.account_status().is_ok_and(|status| {
                status.connection == mail_core::gmail::types::ConnectionState::Connected
                    && status.sync.initial_sync_complete
            })),
            "gmail core did not finish its first sync"
        );
        core.wait_for_test_idle(mail_core::testing::TIMEOUT)
            .expect("idle after first sync");
        Self {
            core,
            provider,
            clock,
            armed_reject: false.into(),
            _dir: dir,
        }
    }
}

fn gmail_thread(conversation: &Value) -> GmailThread {
    let id = conversation["id"].as_str().expect("conversation id");
    let messages_json = conversation["messages"].as_array().expect("messages");
    let messages: Vec<_> = messages_json
        .iter()
        .map(|m| {
            mail_core::testing::message(
                m["id"].as_str().unwrap(),
                "sender@example.test",
                m["sentAt"].as_str().unwrap(),
                "synthetic body",
            )
        })
        .collect();
    let flagged = |key: &str| -> Vec<String> {
        messages_json
            .iter()
            .filter(|m| m[key].as_bool() == Some(true))
            .map(|m| m["id"].as_str().unwrap().to_string())
            .collect()
    };
    let inbox = flagged("inInbox");
    let inbox_refs: Vec<&str> = inbox.iter().map(String::as_str).collect();
    let newest = messages
        .iter()
        .max_by(|a, b| (&a.sent_at, &a.id).cmp(&(&b.sent_at, &b.id)))
        .map(|m| m.from.clone());
    let mut thread = mail_core::testing::thread(
        GMAIL_ACCOUNT,
        id,
        messages,
        &inbox_refs,
        Some(flagged("unread")),
        "history-1",
    );
    thread.newest_sender = newest;
    thread.conversation.subject = format!("subject {id}");
    // Star facts are known only for messages that declare `starred`.
    let known: std::collections::HashMap<String, bool> = messages_json
        .iter()
        .filter_map(|m| Some((m["id"].as_str()?.to_string(), m["starred"].as_bool()?)))
        .collect();
    if !known.is_empty() {
        thread.star_facts = Some(known);
    }
    thread
}

/// Every mailbox command on a `GmailCore`, shared by the `gmail` and
/// `synthetic` profiles.
fn execute_on_gmail_core(core: &GmailCore, command: &str, args: Value) -> Result<Value, MailError> {
    match command {
        "setArchived" => to_value(core.set_archived(&args_as::<SetArchived>(args))),
        "setRead" => to_value(core.set_read(&args_as::<SetRead>(args))),
        "setStarred" => to_value(core.set_starred(&args_as::<SetStarred>(args))),
        "retryOperation" => to_value(core.retry_operation(&args_as::<RetryOperation>(args))),
        "undoOperation" => to_value(core.undo_operation(&args_as::<UndoOperation>(args))),
        "setArchivedGroup" => to_value(core.set_archived_group(&args_as::<SetArchivedGroup>(args))),
        "setReadGroup" => to_value(core.set_read_group(&args_as::<SetReadGroup>(args))),
        "setStarredGroup" => to_value(core.set_starred_group(&args_as::<SetStarredGroup>(args))),
        "getOperationGroup" => {
            to_value(core.get_operation_group(&args_as::<GetOperationGroupRequest>(args)))
        }
        "listOperationGroups" => {
            to_value(core.list_operation_groups(&args_as::<ListOperationGroupsRequest>(args)))
        }
        "undoOperationGroup" => {
            to_value(core.undo_operation_group(&args_as::<UndoOperationGroup>(args)))
        }
        other => panic!("unknown contract command {other}"),
    }
}

impl Backend for GmailBackend {
    fn account_id(&self) -> String {
        GMAIL_ACCOUNT.to_string()
    }
    fn execute(&self, command: &str, args: Value) -> Result<Value, MailError> {
        execute_on_gmail_core(&self.core, command, args)
    }
    fn snapshot(&self) -> Value {
        serde_json::to_value(self.core.list_conversations().expect("list_conversations"))
            .expect("serialize snapshot")
    }
    fn advance(&self, seconds: i64) {
        self.clock.advance_seconds(seconds);
    }
    fn provider(&self, mode: &str) -> Result<(), String> {
        match mode {
            "hold_queued" => self
                .core
                .pause_test_operations(mail_core::testing::TIMEOUT)
                .map_err(|e| format!("pause: {e:?}")),
            "hold_applying" => {
                self.provider.set_apply_plan(ApplyPlan::BlockThenSuccess);
                Ok(())
            }
            "reject_next" => {
                self.provider
                    .set_apply_plan(ApplyPlan::Error(MailError::ProviderRejected));
                self.armed_reject
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            }
            "release" => {
                self.provider.set_apply_plan(ApplyPlan::Success);
                self.provider.release_apply();
                self.core.release_test_operations();
                Ok(())
            }
            other => Err(format!("unknown provider mode {other}")),
        }
    }
    fn after_step(&self, was_command: bool) {
        if was_command
            && self
                .armed_reject
                .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            self.provider.set_apply_plan(ApplyPlan::Success);
        }
    }
}

/// The fixture backend mirrors the native shell's `Backend::Fixture` dispatch
/// (src-tauri/src/main.rs): archive, undo and archive groups are forwarded to
/// `MailCore`; every other mailbox command is rejected exactly as the shell
/// rejects it today. The worker starts lazily so a scenario can hold work
/// queued by declaring `hold_queued` first.
struct FixtureBackend {
    core: MailCore,
    provider: Arc<FakeArchiveProvider>,
    clock: Arc<FakeClock>,
    state: std::sync::Mutex<FixtureState>,
    _dir: tempfile::TempDir,
}

#[derive(Default)]
struct FixtureState {
    worker_started: bool,
    hold_queued: bool,
}

impl FixtureBackend {
    fn open(mailbox: &Value) -> Self {
        let dir = temp_profile("contract-fixture");
        let clock = Arc::new(FakeClock::new(utc(CLOCK_START)));
        let core = MailCore::open_with_clock(dir.path(), Arc::clone(&clock) as Arc<dyn Clock>)
            .expect("open fixture core");
        let backend = Self {
            core,
            provider: Arc::new(FakeArchiveProvider::new()),
            clock,
            state: Default::default(),
            _dir: dir,
        };
        backend.check_mailbox_matches_seed(mailbox);
        backend
    }

    /// The fixture's data is its fixed seed. A scenario may run here only if
    /// its declared mailbox is a faithful subset of that seed.
    fn check_mailbox_matches_seed(&self, mailbox: &Value) {
        let snapshot = serde_json::to_value(self.core.list_conversations().unwrap()).unwrap();
        let declared: Vec<&Value> = mailbox["conversations"]
            .as_array()
            .unwrap()
            .iter()
            .collect();
        let in_inbox_ids: Vec<String> = snapshot["conversations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["ref"]["conversationId"].as_str().unwrap().to_string())
            .collect();
        let mut expected_inbox: Vec<(&str, &str)> = Vec::new();
        for conv in &declared {
            let id = conv["id"].as_str().unwrap();
            let messages = conv["messages"].as_array().unwrap();
            let any_inbox = messages.iter().any(|m| m["inInbox"] == json!(true));
            assert_eq!(
                in_inbox_ids.iter().any(|x| x == id),
                any_inbox,
                "mailbox conversation {id} disagrees with the fixture seed about Inbox membership"
            );
            if any_inbox {
                let last = messages
                    .iter()
                    .map(|m| m["sentAt"].as_str().unwrap())
                    .max()
                    .unwrap();
                expected_inbox.push((id, last));
            }
        }
        expected_inbox.sort_by(|a, b| b.1.cmp(a.1));
        let declared_ids: Vec<&str> = declared.iter().map(|c| c["id"].as_str().unwrap()).collect();
        let actual_order: Vec<&String> = in_inbox_ids
            .iter()
            .filter(|id| declared_ids.contains(&id.as_str()))
            .collect();
        let expected_order: Vec<&str> = expected_inbox.iter().map(|e| e.0).collect();
        assert_eq!(
            actual_order.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            expected_order,
            "mailbox Inbox order disagrees with the fixture seed"
        );
    }

    fn ensure_worker(&self) {
        let mut state = self.state.lock().unwrap();
        if !state.worker_started && !state.hold_queued {
            self.core
                .start_worker(self.provider.clone())
                .expect("start fixture worker");
            state.worker_started = true;
        }
    }
}

impl Backend for FixtureBackend {
    fn account_id(&self) -> String {
        self.core.account_id().to_string()
    }
    fn execute(&self, command: &str, args: Value) -> Result<Value, MailError> {
        self.ensure_worker();
        let core = &self.core;
        let invalid_mode = || {
            Err(MailError::InvalidRequest {
                field: "mode".to_string(),
            })
        };
        match command {
            "setArchived" => to_value(core.set_archived(&args_as::<SetArchived>(args))),
            "undoOperation" => to_value(core.undo_operation(&args_as::<UndoOperation>(args))),
            "setArchivedGroup" => {
                to_value(core.set_archived_group(&args_as::<SetArchivedGroup>(args)))
            }
            "getOperationGroup" => {
                to_value(core.get_operation_group(&args_as::<GetOperationGroupRequest>(args)))
            }
            "listOperationGroups" => {
                to_value(core.list_operation_groups(&args_as::<ListOperationGroupsRequest>(args)))
            }
            "undoOperationGroup" => {
                to_value(core.undo_operation_group(&args_as::<UndoOperationGroup>(args)))
            }
            // Shell: Backend::Fixture => Err(ReadOnly)
            "setStarred" | "setStarredGroup" => Err(MailError::ReadOnly),
            // Shell: Backend::Fixture => Err(InvalidRequest { field: "mode" })
            "setRead" | "setReadGroup" | "retryOperation" => invalid_mode(),
            other => panic!("unknown contract command {other}"),
        }
    }
    fn snapshot(&self) -> Value {
        serde_json::to_value(self.core.list_conversations().expect("list_conversations"))
            .expect("serialize snapshot")
    }
    fn advance(&self, seconds: i64) {
        self.clock.advance_seconds(seconds);
    }
    fn provider(&self, mode: &str) -> Result<(), String> {
        match mode {
            "hold_queued" => {
                let mut state = self.state.lock().unwrap();
                if state.worker_started {
                    return Err("fixture can only hold queued work before its worker starts".into());
                }
                state.hold_queued = true;
                Ok(())
            }
            "hold_applying" => {
                self.ensure_worker();
                self.provider.set_paused(true);
                Ok(())
            }
            "reject_next" => {
                self.ensure_worker();
                self.provider.fail_next();
                Ok(())
            }
            "release" => {
                self.provider.set_paused(false);
                let mut state = self.state.lock().unwrap();
                state.hold_queued = false;
                drop(state);
                self.ensure_worker();
                Ok(())
            }
            other => Err(format!("unknown provider mode {other}")),
        }
    }
    fn after_step(&self, _was_command: bool) {}
}

/// A synthetic session: `GmailCore` + the built-in provider under the synthetic
/// policy. Mailboxes that are not a subset of the fixed 18 conversations get
/// their extra threads from a test overlay (same account, same policy).
struct SyntheticBackend {
    core: GmailCore,
    synthetic: Arc<mail_core::synthetic::SyntheticGmailProvider>,
    clock: Arc<FakeClock>,
    _dir: tempfile::TempDir,
}

impl SyntheticBackend {
    fn open(mailbox: &Value) -> Self {
        let dir = temp_profile("contract-synthetic");
        let clock = Arc::new(FakeClock::new(utc(CLOCK_START)));
        let synthetic = mail_core::testing::synthetic::new_provider(dir.path());
        let declared = mailbox["conversations"].as_array().expect("conversations");
        let known = synthetic.conversation_ids();
        let in_seed = declared
            .iter()
            .all(|c| known.iter().any(|k| k == c["id"].as_str().unwrap()));
        let wrapped: Arc<dyn mail_core::gmail::types::GmailProvider> = if in_seed {
            Self::check_mailbox_matches_seed(&synthetic, declared);
            synthetic.clone()
        } else {
            let overlay = Overlay::wrap(synthetic.clone());
            overlay.add_extra_threads(
                declared
                    .iter()
                    .map(|c| {
                        let mut thread = gmail_thread(c);
                        thread.conversation.conversation_ref.account_id =
                            mail_core::ACCOUNT_ID.to_string();
                        thread
                    })
                    .collect(),
            );
            overlay
        };
        let core = mail_core::testing::synthetic::open_core_wrapping(
            dir.path(),
            wrapped,
            &synthetic,
            &clock,
            false,
        );
        Self {
            core,
            synthetic,
            clock,
            _dir: dir,
        }
    }

    /// A scenario may run on the fixed mailbox only if its declared mailbox
    /// is a faithful subset: Inbox membership and read facts must agree.
    fn check_mailbox_matches_seed(
        synthetic: &mail_core::synthetic::SyntheticGmailProvider,
        declared: &[Value],
    ) {
        use mail_core::gmail::types::GmailProvider;
        for conv in declared {
            let id = conv["id"].as_str().unwrap();
            let thread = synthetic
                .get_thread(id, &mail_core::CancelToken::default())
                .unwrap()
                .unwrap();
            for message in conv["messages"].as_array().unwrap() {
                let mid = message["id"].as_str().unwrap();
                assert_eq!(
                    thread.inbox_message_ids.iter().any(|m| m == mid),
                    message["inInbox"] == json!(true),
                    "{mid}: scenario mailbox disagrees with the synthetic seed about INBOX"
                );
                assert_eq!(
                    thread
                        .unread_message_ids
                        .as_ref()
                        .unwrap()
                        .iter()
                        .any(|m| m == mid),
                    message["unread"] == json!(true),
                    "{mid}: scenario mailbox disagrees with the synthetic seed about UNREAD"
                );
            }
        }
    }
}

impl Backend for SyntheticBackend {
    fn account_id(&self) -> String {
        mail_core::ACCOUNT_ID.to_string()
    }
    fn execute(&self, command: &str, args: Value) -> Result<Value, MailError> {
        execute_on_gmail_core(&self.core, command, args)
    }
    fn snapshot(&self) -> Value {
        serde_json::to_value(self.core.list_conversations().expect("list_conversations"))
            .expect("serialize snapshot")
    }
    fn advance(&self, seconds: i64) {
        self.clock.advance_seconds(seconds);
    }
    fn provider(&self, mode: &str) -> Result<(), String> {
        match mode {
            "hold_queued" => self
                .core
                .pause_test_operations(mail_core::testing::TIMEOUT)
                .map_err(|e| format!("pause: {e:?}")),
            "hold_applying" => {
                self.synthetic.set_paused(true);
                Ok(())
            }
            "reject_next" => {
                self.synthetic.fail_next();
                Ok(())
            }
            "release" => {
                self.synthetic.resume();
                self.core.release_test_operations();
                Ok(())
            }
            other => Err(format!("unknown provider mode {other}")),
        }
    }
    fn after_step(&self, _was_command: bool) {}
}

// --------------------------------------------------------- symbols & matching

/// Symbolic ids: `$name` binds on first appearance in an expectation and must
/// then be equal everywhere; distinct names must bind distinct values.
#[derive(Clone, Default)]
struct Bindings {
    forward: HashMap<String, String>,
    reverse: HashMap<String, String>,
}

impl Bindings {
    fn bind(&mut self, name: &str, actual: &str) -> Result<(), String> {
        match self.forward.get(name) {
            Some(bound) if bound == actual => Ok(()),
            Some(bound) => Err(format!("${name} was {bound:?} but is now {actual:?}")),
            None => {
                if let Some(other) = self.reverse.get(actual) {
                    return Err(format!(
                        "${name} and ${other} are the same value {actual:?}"
                    ));
                }
                self.forward.insert(name.to_string(), actual.to_string());
                self.reverse.insert(actual.to_string(), name.to_string());
                Ok(())
            }
        }
    }
}

fn offset_seconds(iso: &str) -> Option<i64> {
    let start = utc(CLOCK_START);
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|t| (t.with_timezone(&chrono::Utc) - start).num_seconds())
}

/// Subset match: every key in `expected` must match; `null` also matches an
/// absent key; arrays match element-for-element and length-for-length.
fn matches(
    expected: &Value,
    actual: &Value,
    path: &str,
    bindings: &mut Bindings,
) -> Result<(), String> {
    match expected {
        Value::String(text) if text.starts_with('$') => {
            let Some(actual) = actual.as_str() else {
                return Err(format!(
                    "{path}: expected a string for {text}, got {actual}"
                ));
            };
            bindings
                .bind(&text[1..], actual)
                .map_err(|e| format!("{path}: {e}"))
        }
        Value::String(text) if text.starts_with("@+") => {
            let offset: i64 = text[2..].parse().expect("@+N offset");
            match actual.as_str().and_then(offset_seconds) {
                Some(actual_offset) if actual_offset == offset => Ok(()),
                other => Err(format!(
                    "{path}: expected clock offset +{offset}s, got {actual} ({other:?})"
                )),
            }
        }
        Value::Null => {
            if actual.is_null() {
                Ok(())
            } else {
                Err(format!("{path}: expected null/absent, got {actual}"))
            }
        }
        Value::Object(map) if map.contains_key("$each") || map.contains_key("$length") => {
            let Some(got) = actual.as_array() else {
                return Err(format!("{path}: expected an array, got {actual}"));
            };
            if let Some(length) = map.get("$length").and_then(Value::as_u64) {
                if got.len() as u64 != length {
                    return Err(format!(
                        "{path}: expected {length} items, got {}",
                        got.len()
                    ));
                }
            }
            if let Some(each) = map.get("$each") {
                for (index, have) in got.iter().enumerate() {
                    matches(each, have, &format!("{path}[{index}]"), bindings)?;
                }
            }
            Ok(())
        }
        Value::Object(map) => {
            if !actual.is_object() {
                return Err(format!("{path}: expected an object, got {actual}"));
            }
            for (key, want) in map {
                matches(
                    want,
                    actual.get(key).unwrap_or(&Value::Null),
                    &format!("{path}.{key}"),
                    bindings,
                )?;
            }
            Ok(())
        }
        Value::Array(items) => {
            let Some(got) = actual.as_array() else {
                return Err(format!("{path}: expected an array, got {actual}"));
            };
            if items.len() != got.len() {
                return Err(format!(
                    "{path}: expected {} items, got {}: {}",
                    items.len(),
                    got.len(),
                    short(actual)
                ));
            }
            for (index, (want, have)) in items.iter().zip(got).enumerate() {
                matches(want, have, &format!("{path}[{index}]"), bindings)?;
            }
            Ok(())
        }
        other => {
            if other == actual {
                Ok(())
            } else {
                Err(format!("{path}: expected {other}, got {actual}"))
            }
        }
    }
}

/// Replaces `$name` strings with their bound values (command arguments).
fn substitute(value: &Value, bindings: &Bindings) -> Value {
    match value {
        Value::String(text) if text.starts_with('$') => Value::String(
            bindings
                .forward
                .get(&text[1..])
                .unwrap_or_else(|| panic!("argument refers to unbound symbol {text}"))
                .clone(),
        ),
        Value::Array(items) => {
            Value::Array(items.iter().map(|v| substitute(v, bindings)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), substitute(v, bindings)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Argument shorthand shared with the TypeScript runner (docs/development.md):
/// a string `conversation`/member is a ref in the backend's own account, an
/// object `{account, id}` names another account, `{generate: {prefix, count}}`
/// expands to `prefix + 1-based zero-padded(3) index`, and `accountId` defaults
/// to the backend's account.
fn normalize_args(command: &str, args: &Value, account: &str) -> Value {
    let mut args = args.clone();
    let object = args.as_object_mut().expect("args are an object");
    let reference = |value: &Value| -> Value {
        match value {
            Value::String(id) => json!({"accountId": account, "conversationId": id}),
            Value::Object(map) if map.contains_key("id") => json!({
                "accountId": map.get("account").and_then(Value::as_str).unwrap_or(account),
                "conversationId": map["id"],
            }),
            other => other.clone(),
        }
    };
    if let Some(conversation) = object.get("conversation").cloned() {
        object.insert("conversation".into(), reference(&conversation));
    }
    if let Some(members) = object.get("members").cloned() {
        let expanded: Vec<Value> = match &members {
            Value::Object(map) if map.contains_key("generate") => {
                let spec = &map["generate"];
                let prefix = spec["prefix"].as_str().unwrap();
                (1..=spec["count"].as_u64().unwrap())
                    .map(|i| Value::String(format!("{prefix}{i:03}")))
                    .collect()
            }
            Value::Array(items) => items.clone(),
            other => panic!("members must be an array or a generate spec, got {other}"),
        };
        object.insert(
            "members".into(),
            Value::Array(expanded.iter().map(reference).collect()),
        );
    }
    let group_command = matches!(
        command,
        "setArchivedGroup"
            | "setReadGroup"
            | "setStarredGroup"
            | "getOperationGroup"
            | "listOperationGroups"
    );
    if group_command && !object.contains_key("accountId") {
        object.insert("accountId".into(), Value::String(account.to_string()));
    }
    if command == "listOperationGroups" && !object.contains_key("cursor") {
        object.insert("cursor".into(), Value::Null);
    }
    args
}

/// `snapshot.inbox: [ids]` is shorthand for the matching `conversations` list.
fn expand_snapshot(want: &Value) -> Value {
    let mut want = want.clone();
    if let Some(inbox) = want.as_object_mut().and_then(|o| o.remove("inbox")) {
        let rows: Vec<Value> = inbox
            .as_array()
            .expect("inbox is an array of conversation ids")
            .iter()
            .map(|id| json!({"ref": {"conversationId": id}}))
            .collect();
        want["conversations"] = Value::Array(rows);
    }
    want
}

/// Restricts the Inbox listing to the scenario's declared conversations (the
/// fixture seed holds extra mail the scenario never mentions).
fn restrict_to_declared(mut snapshot: Value, declared: &[String]) -> Value {
    if let Some(rows) = snapshot["conversations"].as_array_mut() {
        rows.retain(|row| {
            row["ref"]["conversationId"]
                .as_str()
                .is_some_and(|id| declared.iter().any(|d| d == id))
        });
    }
    if let Some(rows) = snapshot["activity"].as_array_mut() {
        rows.retain(|row| {
            row["conversation"]["conversationId"]
                .as_str()
                .is_some_and(|id| declared.iter().any(|d| d == id))
        });
    }
    snapshot
}

// -------------------------------------------------------------------- runner

struct Scenario {
    file: String,
    json: Value,
}

fn scenario_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/contract-scenarios")
}

fn load_scenarios() -> Vec<Scenario> {
    let mut found: BTreeMap<String, Scenario> = BTreeMap::new();
    for entry in std::fs::read_dir(scenario_dir()).expect("scenario dir") {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !name.ends_with(".json") || name == "mailboxes.json" {
            continue;
        }
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        found.insert(name.clone(), Scenario { file: name, json });
    }
    found.into_values().collect()
}

fn mailbox_for(scenario: &Scenario) -> Value {
    match &scenario.json["mailbox"] {
        Value::String(name) => {
            let all: Value = serde_json::from_str(
                &std::fs::read_to_string(scenario_dir().join("mailboxes.json")).unwrap(),
            )
            .unwrap();
            all.get(name)
                .unwrap_or_else(|| panic!("unknown mailbox {name}"))
                .clone()
        }
        inline @ Value::Object(_) => inline.clone(),
        other => panic!("{}: bad mailbox {other}", scenario.file),
    }
}

const MUTATING: &[&str] = &[
    "setArchived",
    "setRead",
    "setStarred",
    "retryOperation",
    "undoOperation",
    "setArchivedGroup",
    "setReadGroup",
    "setStarredGroup",
    "undoOperationGroup",
];

fn run_scenario(scenario: &Scenario, backend: &dyn Backend) -> Result<(), String> {
    let mailbox = mailbox_for(scenario);
    let declared: Vec<String> = mailbox["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_string())
        .collect();
    let account = backend.account_id();
    let mut bindings = Bindings::default();
    let steps = scenario.json["steps"].as_array().expect("steps");
    for (index, step) in steps.iter().enumerate() {
        let label = format!(
            "step {} ({})",
            index + 1,
            step["name"].as_str().unwrap_or("unnamed")
        );
        let action = &step["do"];
        let expect = &step["expect"];
        let mut was_command = false;
        if let Some(seconds) = action["advance"].as_i64() {
            backend.advance(seconds);
        } else if let Some(mode) = action["provider"].as_str() {
            backend
                .provider(mode)
                .map_err(|e| format!("{label}: {e}"))?;
        } else if let Some(command) = action["cmd"].as_str() {
            was_command = true;
            let args = normalize_args(command, &substitute(&action["args"], &bindings), &account);
            let result = backend.execute(command, args);
            check_result(&label, expect, result, &mut bindings)?;
            if MUTATING.contains(&command)
                && expect.get("error").is_none()
                && expect.get("snapshot").is_none()
            {
                return Err(format!(
                    "{label}: a successful mutating step must declare expect.snapshot"
                ));
            }
        } else {
            return Err(format!("{label}: step has no cmd/advance/provider"));
        }
        if let Some(want) = expect.get("snapshot").map(expand_snapshot) {
            let want = &want;
            // The worker is asynchronous: observe until the expected state
            // holds (bounded), then re-run the match on the final state so a
            // failure reports what was actually observed.
            let observed = || restrict_to_declared(backend.snapshot(), &declared);
            let settled =
                until(|| matches(want, &observed(), "snapshot", &mut bindings.clone()).is_ok());
            let _ = settled;
            matches(want, &observed(), "snapshot", &mut bindings).map_err(|e| {
                format!("{label}: {e}\n  actual snapshot: {}", compact(&observed()))
            })?;
        }
        backend.after_step(was_command);
    }
    Ok(())
}

fn short(value: &Value) -> String {
    let text = value.to_string();
    match text.char_indices().nth(400) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text,
    }
}

/// Failure output: Inbox ids plus the full activity, not every summary field.
fn compact(value: &Value) -> String {
    if value.get("activity").is_some() && value.get("conversations").is_some() {
        let inbox: Vec<&str> = value["conversations"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["ref"]["conversationId"].as_str())
            .collect();
        return format!("inbox {inbox:?} activity {}", value["activity"]);
    }
    short(value)
}

fn check_result(
    label: &str,
    expect: &Value,
    result: Result<Value, MailError>,
    bindings: &mut Bindings,
) -> Result<(), String> {
    match (expect.get("ok"), expect.get("error"), result) {
        (Some(want), None, Ok(actual)) => matches(want, &actual, "ok", bindings)
            .map_err(|e| format!("{label}: {e}\n  actual: {}", compact(&actual))),
        (None, Some(want), Err(error)) => {
            let actual = serde_json::to_value(&error).unwrap();
            matches(want, &actual, "error", bindings)
                .map_err(|e| format!("{label}: {e}\n  actual: {actual}"))
        }
        (Some(_), None, Err(error)) => Err(format!("{label}: expected success, got {error:?}")),
        (None, Some(want), Ok(actual)) => Err(format!(
            "{label}: expected error {want}, got success {}",
            compact(&actual)
        )),
        (None, None, _) => Err(format!(
            "{label}: expect needs ok or error for a command step"
        )),
        _ => Err(format!("{label}: expect has both ok and error")),
    }
}

fn open_backend(profile: &str, scenario: &Scenario) -> Box<dyn Backend> {
    let mailbox = mailbox_for(scenario);
    match profile {
        "gmail" => Box::new(GmailBackend::open(&mailbox)),
        "fixture" => Box::new(FixtureBackend::open(&mailbox)),
        "synthetic" => Box::new(SyntheticBackend::open(&mailbox)),
        other => panic!("unknown profile {other}"),
    }
}

#[test]
fn contract_scenarios_pass_on_every_rust_backend_they_declare() {
    let scenarios = load_scenarios();
    assert!(!scenarios.is_empty(), "no scenarios found");
    let mut failures = Vec::new();
    let mut ran = Vec::new();
    for scenario in &scenarios {
        let name = scenario.json["scenario"]
            .as_str()
            .expect("scenario name")
            .to_string();
        // Every scenario also runs on the synthetic profile, which the shared
        // files do not declare (the TypeScript runner would not know it).
        let mut profiles: Vec<&str> = scenario.json["profiles"]
            .as_array()
            .expect("profiles")
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        profiles.push("synthetic");
        for profile in profiles {
            let backend = open_backend(profile, scenario);
            let outcome = run_scenario(scenario, backend.as_ref());
            drop(backend);
            let known = KNOWN_DIVERGENCES
                .iter()
                .find(|(s, p, _)| *s == name && *p == profile);
            match (outcome, known) {
                (Ok(()), None) => ran.push(format!("{name} @ {profile}")),
                (Err(error), None) => failures.push(format!("{name} @ {profile}:\n  {error}")),
                (Err(error), Some((_, _, why))) => {
                    println!("KNOWN DIVERGENCE {name} @ {profile}: {why}\n  {error}");
                }
                (Ok(()), Some((_, _, why))) => failures.push(format!(
                    "{name} @ {profile} now passes; remove its KNOWN_DIVERGENCES entry ({why})"
                )),
            }
        }
    }
    println!("passed: {}", ran.join(", "));
    assert!(
        failures.is_empty(),
        "contract scenario failures:\n{}",
        failures.join("\n")
    );
}
