//! Harness for tests that run `GmailCore` on the built-in synthetic provider
//! (ADR 0002). Test-only: it wraps the production provider, never the other
//! way around, and the production provider carries none of these hooks.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use crate::clock::{utc, Clock, FakeClock};
use crate::dto::{ConversationRef, MailboxOperationKind, Message};
use crate::gmail::sync::GmailCore;
use crate::gmail::types::{
    ConnectionState, GmailHistoryError, GmailProfile, GmailProvider, GmailThread, HistoryPage,
    InboxPage,
};
use crate::synthetic::SyntheticGmailProvider;
use crate::{CancelToken, MailError, ACCOUNT_ID};

use super::{temp_profile, until, TIMEOUT};

/// Start of the injected clock used by synthetic-core tests.
pub const CLOCK_START: &str = "2026-02-01T00:00:00Z";

/// A conversation reference in the synthetic account.
pub fn conversation(id: &str) -> ConversationRef {
    ConversationRef {
        account_id: ACCOUNT_ID.to_string(),
        conversation_id: id.to_string(),
    }
}

/// A core, the provider it runs on, its clock and its profile directory.
pub struct Synthetic<P: GmailProvider + 'static = SyntheticGmailProvider> {
    pub core: GmailCore,
    pub provider: Arc<P>,
    pub synthetic: Arc<SyntheticGmailProvider>,
    pub clock: Arc<FakeClock>,
    pub dir: tempfile::TempDir,
}

impl Synthetic {
    /// Fresh profile, first sync finished.
    pub fn open(tag: &str) -> Self {
        Self::open_with(tag, |_| {})
    }

    /// Fresh profile; `setup` runs on the provider before the core opens, so
    /// fake controls (pause/reject) are in force from the first write.
    pub fn open_with(tag: &str, setup: impl FnOnce(&SyntheticGmailProvider)) -> Self {
        let dir = temp_profile(tag);
        let clock = Arc::new(FakeClock::new(utc(CLOCK_START)));
        let provider = new_provider(dir.path());
        setup(&provider);
        let core = open_core_on(dir.path(), provider.clone(), &clock);
        Self {
            core,
            synthetic: provider.clone(),
            provider,
            clock,
            dir,
        }
    }

    /// Like [`Self::open`] with queued mutations held durable until
    /// `core.release_test_operations()`.
    pub fn open_operations_paused(tag: &str) -> Self {
        let dir = temp_profile(tag);
        let clock = Arc::new(FakeClock::new(utc(CLOCK_START)));
        let provider = new_provider(dir.path());
        let core = open_core_wrapping(dir.path(), provider.clone(), &provider, &clock, true);
        Self {
            core,
            synthetic: provider.clone(),
            provider,
            clock,
            dir,
        }
    }

    /// Stops and drops the core and provider, then reopens the SAME profile
    /// with a NEW provider object, proving provider facts are durable rather
    /// than held in memory.
    pub fn reopen(self) -> Self {
        let Synthetic {
            core, dir, clock, ..
        } = self;
        core.stop();
        drop(core);
        let provider = new_provider(dir.path());
        let core = open_core_on(dir.path(), provider.clone(), &clock);
        Self {
            core,
            synthetic: provider.clone(),
            provider,
            clock,
            dir,
        }
    }
}

impl<P: GmailProvider + 'static> Synthetic<P> {
    /// Fresh profile where the core runs on `wrap(synthetic)`.
    pub fn open_wrapped(
        tag: &str,
        wrap: impl FnOnce(Arc<SyntheticGmailProvider>) -> Arc<P>,
    ) -> Self {
        let dir = temp_profile(tag);
        let clock = Arc::new(FakeClock::new(utc(CLOCK_START)));
        let synthetic = new_provider(dir.path());
        let provider = wrap(synthetic.clone());
        let core = open_core_wrapping(dir.path(), provider.clone(), &synthetic, &clock, false);
        Self {
            core,
            provider,
            synthetic,
            clock,
            dir,
        }
    }
}

pub fn new_provider(dir: &std::path::Path) -> Arc<SyntheticGmailProvider> {
    Arc::new(SyntheticGmailProvider::open(dir).expect("open synthetic provider"))
}

/// Opens a synthetic session over `dir`. Bootstrap finishes before
/// `open_synthetic` returns, so no waiting is needed.
pub fn open_core_on(
    dir: &std::path::Path,
    provider: Arc<SyntheticGmailProvider>,
    clock: &Arc<FakeClock>,
) -> GmailCore {
    GmailCore::open_synthetic(dir, provider, Arc::clone(clock) as Arc<dyn Clock>)
        .expect("open synthetic core")
}

/// Opens a synthetic session whose provider is `wrapped` (a decorator over
/// `synthetic`), optionally holding queued mutations durable.
pub fn open_core_wrapping(
    dir: &std::path::Path,
    wrapped: Arc<dyn GmailProvider>,
    synthetic: &SyntheticGmailProvider,
    clock: &Arc<FakeClock>,
    operations_paused: bool,
) -> GmailCore {
    GmailCore::open_synthetic_wrapping(
        dir,
        wrapped,
        Arc::clone(clock) as Arc<dyn Clock>,
        &synthetic.conversation_ids(),
        operations_paused,
    )
    .expect("open synthetic core")
}

pub fn wait_until_synced(core: &GmailCore) {
    assert!(
        until(|| core.account_status().is_ok_and(|status| {
            status.connection == ConnectionState::Connected && status.sync.initial_sync_complete
        })),
        "synthetic core did not finish its first sync: {:?}",
        core.account_status()
            .map(|s| (s.connection, s.sync.error, s.sync.initial_sync_complete))
    );
    core.wait_for_test_idle(TIMEOUT).expect("idle after sync");
}

/// Loads the two initially archived seed conversations into the cache.
pub fn load_archived_seeds(core: &GmailCore) -> Result<(), MailError> {
    for id in ["conv-06", "conv-15"] {
        core.load_search_conversation(&conversation(id))?;
    }
    Ok(())
}

/// Counts change notifications and lets tests await events without sleeping.
pub struct ChangeCounter {
    count: Mutex<u32>,
    notified: Condvar,
}

impl ChangeCounter {
    pub fn subscribe(core: &GmailCore) -> (Arc<Self>, crate::gmail::sync::GmailUnsubscribe) {
        let counter = Arc::new(Self {
            count: Mutex::new(0),
            notified: Condvar::new(),
        });
        let seen = Arc::clone(&counter);
        let subscription = core.subscribe(move || {
            *seen.count.lock().expect("counter poisoned") += 1;
            seen.notified.notify_all();
        });
        (counter, subscription)
    }

    pub fn get(&self) -> u32 {
        *self.count.lock().expect("counter poisoned")
    }

    /// Waits until `f` holds or the bounded timeout elapses; woken by events.
    pub fn until(&self, mut f: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if f() {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let count = self.count.lock().expect("counter poisoned");
            let (guard, _) = self
                .notified
                .wait_timeout(count, remaining)
                .expect("counter poisoned");
            drop(guard);
        }
    }
}

/// One recorded provider write.
pub type WriteRecord = (MailboxOperationKind, bool, Vec<String>);

/// Test decorator over the synthetic provider: records writes in order, can
/// serve extra threads (to exceed the 18 fixed conversations) and can make
/// new messages "arrive" in an existing conversation. Everything else is
/// delegated unchanged.
pub struct Overlay {
    inner: Arc<SyntheticGmailProvider>,
    state: Mutex<OverlayState>,
}

#[derive(Default)]
struct OverlayState {
    writes: Vec<WriteRecord>,
    extra: Vec<GmailThread>,
    arrivals: HashMap<String, Vec<Message>>,
    changed: Vec<String>,
    history_bump: u64,
    hang_after_next_write: bool,
    hung: bool,
    reads: Vec<&'static str>,
}

impl Overlay {
    pub fn wrap(inner: Arc<SyntheticGmailProvider>) -> Arc<Self> {
        Arc::new(Self {
            inner,
            state: Mutex::new(OverlayState::default()),
        })
    }

    /// How many times the core called the named provider read
    /// (`profile`, `list_inbox`, `get_thread`, `history`, `search_threads`).
    pub fn read_calls(&self, name: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .reads
            .iter()
            .filter(|n| **n == name)
            .count()
    }

    fn note_read(&self, name: &'static str) {
        self.state.lock().unwrap().reads.push(name);
    }

    pub fn writes(&self) -> Vec<WriteRecord> {
        self.state.lock().unwrap().writes.clone()
    }

    /// Adds threads that are listed in the Inbox and served by `get_thread`.
    pub fn add_extra_threads(&self, threads: Vec<GmailThread>) {
        self.state.lock().unwrap().extra.extend(threads);
    }

    /// A new incoming (Inbox, unread) message in `conversation_id`; the next
    /// history page reports the conversation as changed.
    pub fn deliver(&self, conversation_id: &str, message: Message) {
        let mut state = self.state.lock().unwrap();
        state
            .arrivals
            .entry(conversation_id.to_string())
            .or_default()
            .push(message);
        state.changed.push(conversation_id.to_string());
        state.history_bump += 1;
    }

    /// The next write lands in the provider and then never returns until the
    /// pass is cancelled, as if the process died right after the provider
    /// committed and before the ledger recorded the confirmation.
    pub fn hang_after_next_write(&self) {
        self.state.lock().unwrap().hang_after_next_write = true;
    }

    /// Whether a hanging write has landed and is now waiting for cancellation.
    pub fn is_hung(&self) -> bool {
        self.state.lock().unwrap().hung
    }

    /// Message ids owned by the extra threads.
    fn extra_message_ids(&self) -> Vec<String> {
        self.state
            .lock()
            .unwrap()
            .extra
            .iter()
            .flat_map(|t| t.conversation.messages.iter().map(|m| m.id.clone()))
            .collect()
    }

    fn apply(
        &self,
        kind: MailboxOperationKind,
        ids: &[String],
        value: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        self.state
            .lock()
            .unwrap()
            .writes
            .push((kind, value, ids.to_vec()));
        let extras = self.extra_message_ids();
        let (own, rest): (Vec<String>, Vec<String>) =
            ids.iter().cloned().partition(|id| extras.contains(id));
        {
            let mut state = self.state.lock().unwrap();
            for thread in state.extra.iter_mut() {
                for id in own
                    .iter()
                    .filter(|id| thread.conversation.messages.iter().any(|m| &m.id == *id))
                {
                    match kind {
                        MailboxOperationKind::Archive => {
                            thread.inbox_message_ids.retain(|m| m != id);
                            if !value {
                                thread.inbox_message_ids.push(id.clone());
                            }
                            thread.conversation.is_in_inbox = !thread.inbox_message_ids.is_empty();
                        }
                        MailboxOperationKind::Read => {
                            let unread = thread.unread_message_ids.get_or_insert_with(Vec::new);
                            unread.retain(|m| m != id);
                            if !value {
                                unread.push(id.clone());
                            }
                        }
                        MailboxOperationKind::Star => {
                            if let Some(stars) = thread.star_facts.as_mut() {
                                stars.insert(id.clone(), value);
                            }
                        }
                    }
                }
            }
        }
        if !rest.is_empty() {
            match kind {
                MailboxOperationKind::Archive => self.inner.apply_archive(&rest, value, cancel),
                MailboxOperationKind::Read => self.inner.apply_read(&rest, value, cancel),
                MailboxOperationKind::Star => self.inner.apply_star(&rest, value, cancel),
            }?;
        }
        let hang = std::mem::take(&mut self.state.lock().unwrap().hang_after_next_write);
        if hang {
            self.state.lock().unwrap().hung = true;
            cancel.wait_until_cancelled(std::time::Duration::from_secs(60));
            return Err(MailError::AuthCancelled);
        }
        Ok(())
    }
}

impl GmailProvider for Overlay {
    fn fetch_attachment(
        &self,
        account_id: &str,
        message_id: &str,
        attachment_id: &str,
        cancel: &CancelToken,
    ) -> Result<Vec<u8>, MailError> {
        self.inner
            .fetch_attachment(account_id, message_id, attachment_id, cancel)
    }
    fn mutation_access(&self) -> Result<bool, MailError> {
        self.inner.mutation_access()
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
        self.inner.is_configured()
    }
    fn has_credentials(&self) -> Result<bool, MailError> {
        self.inner.has_credentials()
    }
    fn connect(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        self.inner.connect(cancel)
    }
    fn disconnect(&self) -> Result<(), MailError> {
        self.inner.disconnect()
    }
    fn profile(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        self.note_read("profile");
        let mut profile = self.inner.profile(cancel)?;
        let bump = self.state.lock().unwrap().history_bump;
        profile.history_id = (profile.history_id.parse::<u64>().unwrap_or(0) + bump).to_string();
        Ok(profile)
    }
    fn list_inbox(
        &self,
        page_token: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<InboxPage, MailError> {
        self.note_read("list_inbox");
        // Offset-style tokens over inner + extra ids, 100 per page like the
        // discovery contract allows.
        let offset: usize = page_token.map_or(Ok(0), |t| {
            t.parse().map_err(|_| MailError::InvalidProviderResponse)
        })?;
        let mut all = self.inner.list_inbox(None, cancel)?.thread_ids;
        let state = self.state.lock().unwrap();
        for thread in &state.extra {
            if !thread.inbox_message_ids.is_empty() {
                all.push(thread.conversation.conversation_ref.conversation_id.clone());
            }
        }
        let end = (offset + 100).min(all.len());
        Ok(InboxPage {
            thread_ids: all[offset.min(end)..end].to_vec(),
            next_page_token: (end < all.len()).then(|| end.to_string()),
        })
    }
    fn search_threads(
        &self,
        page_token: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<InboxPage, MailError> {
        self.note_read("search_threads");
        self.inner.search_threads(page_token, cancel)
    }
    fn get_thread(
        &self,
        thread_id: &str,
        cancel: &CancelToken,
    ) -> Result<Option<GmailThread>, MailError> {
        self.note_read("get_thread");
        let state = self.state.lock().unwrap();
        if let Some(extra) = state
            .extra
            .iter()
            .find(|t| t.conversation.conversation_ref.conversation_id == thread_id)
        {
            return Ok(Some(extra.clone()));
        }
        let arrivals = state.arrivals.get(thread_id).cloned().unwrap_or_default();
        drop(state);
        let Some(mut thread) = self.inner.get_thread(thread_id, cancel)? else {
            return Ok(None);
        };
        for message in arrivals {
            thread.inbox_message_ids.push(message.id.clone());
            thread
                .unread_message_ids
                .get_or_insert_with(Vec::new)
                .push(message.id.clone());
            thread
                .message_ids
                .get_or_insert_with(Vec::new)
                .push(message.id.clone());
            if let Some(stars) = thread.star_facts.as_mut() {
                stars.insert(message.id.clone(), false);
            }
            thread.newest_sender = Some(message.from.clone());
            thread.conversation.messages.push(message);
            thread.conversation.is_in_inbox = true;
        }
        Ok(Some(thread))
    }
    fn history(
        &self,
        start_history_id: &str,
        page_token: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<HistoryPage, GmailHistoryError> {
        self.note_read("history");
        // The overlay's own history ids are the inner id plus the number of
        // deliveries; translate back for the inner call.
        let (bump, changed) = {
            let state = self.state.lock().unwrap();
            (state.history_bump, state.changed.clone())
        };
        let start: u64 = start_history_id.parse().unwrap_or(0);
        let inner_start = start.saturating_sub(bump);
        let mut page = self
            .inner
            .history(&inner_start.to_string(), page_token, cancel)?;
        page.history_id = (page.history_id.parse::<u64>().unwrap_or(0) + bump).to_string();
        if start < page.history_id.parse::<u64>().unwrap_or(0) {
            for id in changed {
                if !page.changed_thread_ids.contains(&id) {
                    page.changed_thread_ids.push(id);
                }
            }
        }
        Ok(page)
    }
}

// ------------------------------------------------------------------ helpers

pub fn set_archived(id: &str, archived: bool, request_id: &str) -> crate::dto::SetArchived {
    crate::dto::SetArchived {
        conversation: conversation(id),
        archived,
        request_id: request_id.to_string(),
    }
}

pub fn archive_group(
    request_id: &str,
    ids: &[&str],
    archived: bool,
) -> crate::groups::SetArchivedGroup {
    crate::groups::SetArchivedGroup {
        account_id: ACCOUNT_ID.to_string(),
        members: ids.iter().map(|id| conversation(id)).collect(),
        archived,
        request_id: request_id.to_string(),
    }
}

pub fn status_of(core: &GmailCore, operation_id: &str) -> Option<crate::dto::OperationStatus> {
    core.list_conversations()
        .expect("snapshot")
        .activity
        .iter()
        .find(|op| op.id == operation_id)
        .map(|op| op.status)
}

pub fn in_inbox(core: &GmailCore, conversation_id: &str) -> bool {
    core.list_conversations()
        .expect("snapshot")
        .conversations
        .iter()
        .any(|c| c.conversation_ref.conversation_id == conversation_id)
}

/// Waits (bounded) until every listed operation reached `status`.
pub fn wait_for_status(
    core: &GmailCore,
    operation_ids: &[String],
    status: crate::dto::OperationStatus,
) -> bool {
    until(|| {
        operation_ids
            .iter()
            .all(|id| status_of(core, id) == Some(status))
    })
}

/// A read-only second connection to the core's `gmail.db`, for assertions
/// about durable rows and for injecting storage faults with SQL triggers.
pub fn gmail_db(dir: &std::path::Path) -> rusqlite::Connection {
    rusqlite::Connection::open(dir.join("gmail.db")).expect("open gmail.db")
}

/// Runs one catch-up pass on a synthetic session once earlier accepted work
/// drained (users cannot request sync there; tests can).
pub fn sync_when_idle(core: &GmailCore) {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        core.wait_for_test_idle(deadline.saturating_duration_since(Instant::now()))
            .expect("worker did not become idle");
        match core.request_test_sync() {
            Ok(()) => break,
            Err(MailError::Busy) if Instant::now() < deadline => {}
            result => panic!("sync admission failed: {result:?}"),
        }
    }
    core.wait_for_test_idle(TIMEOUT).expect("idle after sync");
}
