//! `SyntheticGmailProvider`: the built-in, credential-free provider.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use super::data::{fixture_reply_context, fixtures, SeedConversation};
use super::facts::{FactStore, MessageFacts};
use crate::attachments::{check_cancel, AttachmentDescriptor};
use crate::dto::{Address, Conversation, ConversationRef, MailboxOperationKind, Message};
use crate::error::MailError;
use crate::gmail::types::{
    GmailHistoryError, GmailProfile, GmailProvider, GmailThread, HistoryPage, InboxPage,
};
use crate::{CancelToken, ACCOUNT_ID, FIXTURE_MAILBOX};

/// File (inside the profile directory) that holds the durable synthetic
/// provider facts. It is distinct from the legacy fixture's `mail.db` and from
/// the Gmail core's own `gmail.db`.
pub const SYNTHETIC_DB_FILE: &str = "synthetic-provider.db";

/// The attachment id of the one deterministic synthetic attachment.
const ATTACHMENT_ID: &str = "fixture-text";
const ATTACHMENT_FILENAME: &str = "example.txt";
const ATTACHMENT_BYTES: &[u8] = b"Synthetic attachment only.\n";

/// How long a paused write sleeps between cancellation checks.
const PAUSE_POLL: Duration = Duration::from_millis(20);

/// Fake write controls, the same semantics `FakeArchiveProvider` had:
/// `paused` blocks every write (cancellation-aware), `fail_next` rejects the
/// next completing write once. They apply only to synthetic writes; reads and
/// bootstrap are never blocked, and nothing routes them to a live provider.
#[derive(Default)]
struct Controls {
    state: Mutex<ControlState>,
    gate: Condvar,
}

#[derive(Default)]
struct ControlState {
    paused: bool,
    fail_next: bool,
    calls: usize,
    inflight: usize,
}

pub struct SyntheticGmailProvider {
    facts: FactStore,
    conversations: Vec<SeedConversation>,
    controls: Controls,
}

impl SyntheticGmailProvider {
    /// Opens (creating and seeding once) the durable synthetic facts under
    /// `profile_dir`. Never touches `mail.db`, the Gmail profile, credentials
    /// or `local-drafts`.
    pub fn open(profile_dir: impl AsRef<Path>) -> Result<Self, MailError> {
        let facts = FactStore::open(&profile_dir.as_ref().join(SYNTHETIC_DB_FILE))?;
        Ok(Self {
            facts,
            conversations: fixtures(),
            controls: Controls::default(),
        })
    }

    /// Like [`Self::open`] and applies the launch-time fake control
    /// `EMAIL_OS_FAKE_PROVIDER=paused|reject|success` (fixture-only).
    pub fn open_from_env(profile_dir: impl AsRef<Path>) -> Result<Self, MailError> {
        let provider = Self::open(profile_dir)?;
        match std::env::var("EMAIL_OS_FAKE_PROVIDER").ok().as_deref() {
            Some("paused") => provider.set_paused(true),
            Some("reject") => provider.fail_next(),
            _ => {}
        }
        Ok(provider)
    }

    /// Pauses every subsequent write until [`Self::resume`] or cancellation.
    pub fn set_paused(&self, paused: bool) {
        self.controls
            .state
            .lock()
            .expect("synthetic controls poisoned")
            .paused = paused;
        self.controls.gate.notify_all();
    }

    pub fn resume(&self) {
        self.set_paused(false);
    }

    /// The next completing write is definitely rejected, once.
    pub fn fail_next(&self) {
        self.controls
            .state
            .lock()
            .expect("synthetic controls poisoned")
            .fail_next = true;
    }

    /// Writes that have arrived, including ones still paused.
    pub fn write_call_count(&self) -> usize {
        self.controls
            .state
            .lock()
            .expect("synthetic controls poisoned")
            .calls
    }

    /// Writes currently inside the provider (paused or completing).
    pub fn write_inflight_count(&self) -> usize {
        self.controls
            .state
            .lock()
            .expect("synthetic controls poisoned")
            .inflight
    }

    /// Barrier: resolves once `n` writes have arrived. No sleeping.
    pub fn wait_for_write_calls(&self, n: usize, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .controls
            .state
            .lock()
            .expect("synthetic controls poisoned");
        while state.calls < n {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            state = self
                .controls
                .gate
                .wait_timeout(state, remaining)
                .expect("synthetic controls poisoned")
                .0;
        }
        true
    }

    /// Every conversation id of the fixed mailbox, Inbox or not. A synthetic
    /// session loads all of them into its cache at bootstrap.
    pub fn conversation_ids(&self) -> Vec<String> {
        self.conversations
            .iter()
            .map(|c| c.id.to_string())
            .collect()
    }

    fn conversation(&self, id: &str) -> Option<&SeedConversation> {
        self.conversations.iter().find(|c| c.id == id)
    }

    fn build_thread(&self, seed: &SeedConversation) -> Result<GmailThread, MailError> {
        let (facts, history) = self.facts.conversation_facts(seed.id)?;
        let reference = ConversationRef {
            account_id: ACCOUNT_ID.to_string(),
            conversation_id: seed.id.to_string(),
        };
        let mut ordered: Vec<(&super::data::SeedMessage, MessageFacts)> =
            seed.messages
                .iter()
                .map(|message| {
                    facts.get(message.id).map(|f| (message, *f)).ok_or_else(|| {
                        crate::storage_log::storage_fault("synthetic_facts_incomplete")
                    })
                })
                .collect::<Result<_, _>>()?;
        ordered.sort_by(|a, b| (a.0.sent_at, a.0.id).cmp(&(b.0.sent_at, b.0.id)));
        let messages: Vec<Message> = ordered
            .iter()
            .enumerate()
            .map(|(index, (message, _))| Message {
                id: message.id.to_string(),
                from: address(message.from),
                to: message.to.iter().map(|p| address(*p)).collect(),
                sent_at: message.sent_at.to_string(),
                body_text: message.body.to_string(),
                // Exactly one synthetic attachment on the first message; no
                // other message carries an attachment fact.
                has_attachment: (index == 0).then_some(true),
            })
            .collect();
        let ids_where = |predicate: fn(&MessageFacts) -> bool| -> Vec<String> {
            ordered
                .iter()
                .filter(|(_, f)| predicate(f))
                .map(|(m, _)| m.id.to_string())
                .collect()
        };
        let inbox_message_ids = ids_where(|f| f.in_inbox);
        let unread_message_ids = ids_where(|f| f.unread);
        let attachments = messages
            .first()
            .map(|first| AttachmentDescriptor {
                message_id: first.id.clone(),
                attachment_id: ATTACHMENT_ID.to_string(),
                filename: ATTACHMENT_FILENAME.to_string(),
                mime_type: "text/plain".to_string(),
                size: ATTACHMENT_BYTES.len() as u32,
            })
            .into_iter()
            .collect();
        let newest_sender = messages.last().map(|m| m.from.clone());
        let reply_context = fixture_reply_context(&reference, &messages);
        let conversation = Conversation {
            stars: None,
            conversation_ref: reference,
            subject: seed.subject.to_string(),
            messages,
            is_in_inbox: !inbox_message_ids.is_empty(),
            is_read: Some(unread_message_ids.is_empty()),
            context_complete: Some(true),
            unsupported_reason: None,
            retained_snapshot_at: None,
            reply_context,
            pending_operation_id: None,
        };
        Ok(GmailThread {
            star_facts: Some(
                ordered
                    .iter()
                    .map(|(m, f)| (m.id.to_string(), f.starred))
                    .collect::<HashMap<_, _>>(),
            ),
            attachments,
            conversation,
            newest_sender,
            inbox_message_ids,
            message_ids: Some(ordered.iter().map(|(m, _)| m.id.to_string()).collect()),
            unread_message_ids: Some(unread_message_ids),
            trash_message_ids: Some(Vec::new()),
            spam_message_ids: Some(Vec::new()),
            history_id: history.to_string(),
        })
    }

    /// Pause gate, one-shot rejection, then the transactional write.
    fn write(
        &self,
        kind: MailboxOperationKind,
        message_ids: &[String],
        value: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        {
            let mut state = self
                .controls
                .state
                .lock()
                .expect("synthetic controls poisoned");
            state.calls += 1;
            state.inflight += 1;
            self.controls.gate.notify_all();
            let verdict = loop {
                if cancel.is_cancelled() {
                    break Err(MailError::AuthCancelled);
                }
                if !state.paused {
                    break if state.fail_next {
                        state.fail_next = false;
                        Err(MailError::ProviderRejected)
                    } else {
                        Ok(())
                    };
                }
                // Wake periodically to observe cancellation; nothing else is
                // held while paused.
                state = self
                    .controls
                    .gate
                    .wait_timeout(state, PAUSE_POLL)
                    .expect("synthetic controls poisoned")
                    .0;
            };
            state.inflight -= 1;
            self.controls.gate.notify_all();
            verdict?;
        }
        self.facts.apply(kind, message_ids, value).map(|_| ())
    }
}

fn address((display, mailbox): (&str, &str)) -> Address {
    Address {
        display_name: (!display.is_empty()).then(|| display.to_string()),
        mailbox: mailbox.to_string(),
    }
}

/// The synthetic provider has no OAuth client, token or Keychain. The trait's
/// session methods answer for the local profile: it is always configured and
/// always "has credentials" in the sense that it is ready to open. The core's
/// synthetic session policy (stage 2) reads local readiness itself; these
/// answers only make direct provider use coherent.
impl GmailProvider for SyntheticGmailProvider {
    fn fetch_attachment(
        &self,
        account_id: &str,
        message_id: &str,
        attachment_id: &str,
        cancel: &CancelToken,
    ) -> Result<Vec<u8>, MailError> {
        check_cancel(cancel)?;
        if account_id != ACCOUNT_ID || attachment_id != ATTACHMENT_ID {
            return Err(MailError::NotFound);
        }
        let carries = self.conversations.iter().any(|conversation| {
            first_message_id(conversation).is_some_and(|first| first == message_id)
        });
        if !carries {
            return Err(MailError::NotFound);
        }
        Ok(ATTACHMENT_BYTES.to_vec())
    }

    fn get_thread_for_account(
        &self,
        expected_account_id: &str,
        thread_id: &str,
        cancel: &CancelToken,
    ) -> Result<Option<GmailThread>, MailError> {
        if expected_account_id != ACCOUNT_ID {
            return Err(MailError::AuthFailed);
        }
        self.get_thread(thread_id, cancel)
    }

    /// The synthetic provider has no grant to withhold: it always accepts
    /// writes. Which dimensions a session admits is session policy.
    fn mutation_access(&self) -> Result<bool, MailError> {
        Ok(true)
    }

    fn enable_mutations(&self, _cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        Err(invalid_mode())
    }

    fn apply_archive(
        &self,
        message_ids: &[String],
        archived: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        self.write(MailboxOperationKind::Archive, message_ids, archived, cancel)
    }

    fn apply_star(
        &self,
        message_ids: &[String],
        starred: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        self.write(MailboxOperationKind::Star, message_ids, starred, cancel)
    }

    fn apply_read(
        &self,
        message_ids: &[String],
        read: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        self.write(MailboxOperationKind::Read, message_ids, read, cancel)
    }

    fn is_configured(&self) -> bool {
        true
    }

    fn has_credentials(&self) -> Result<bool, MailError> {
        Ok(true)
    }

    fn connect(&self, _cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        Err(invalid_mode())
    }

    /// Never erases anything: a synthetic mailbox cannot be disconnected.
    fn disconnect(&self) -> Result<(), MailError> {
        Err(invalid_mode())
    }

    fn profile(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        check_cancel(cancel)?;
        Ok(GmailProfile {
            account_id: ACCOUNT_ID.to_string(),
            email_address: FIXTURE_MAILBOX.to_string(),
            history_id: self.facts.history_id()?.to_string(),
        })
    }

    fn list_inbox(
        &self,
        page_token: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<InboxPage, MailError> {
        check_cancel(cancel)?;
        if page_token.is_some() {
            return Err(MailError::InvalidProviderResponse);
        }
        let inbox: HashSet<String> = self.facts.inbox_conversation_ids()?.into_iter().collect();
        let mut listed: Vec<(&str, &str)> = self
            .conversations
            .iter()
            .filter(|c| inbox.contains(c.id))
            .map(|c| {
                let newest = c.messages.iter().map(|m| m.sent_at).max().unwrap_or("");
                (newest, c.id)
            })
            .collect();
        // Newest first, like Gmail's list; ids break ties deterministically.
        listed.sort_by(|a, b| b.0.cmp(a.0).then(a.1.cmp(b.1)));
        Ok(InboxPage {
            thread_ids: listed.into_iter().map(|(_, id)| id.to_string()).collect(),
            next_page_token: None,
        })
    }

    fn get_thread(
        &self,
        thread_id: &str,
        cancel: &CancelToken,
    ) -> Result<Option<GmailThread>, MailError> {
        check_cancel(cancel)?;
        match self.conversation(thread_id) {
            Some(seed) => self.build_thread(seed).map(Some),
            None => Ok(None),
        }
    }

    fn history(
        &self,
        start_history_id: &str,
        page_token: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<HistoryPage, GmailHistoryError> {
        check_cancel(cancel)?;
        if page_token.is_some() {
            return Err(GmailHistoryError::Mail(MailError::InvalidProviderResponse));
        }
        match self.facts.changes_since(start_history_id)? {
            Some((changed, current)) => Ok(HistoryPage {
                changed_thread_ids: changed,
                deleted_message_ids: Vec::new(),
                next_page_token: None,
                history_id: current.to_string(),
            }),
            None => Err(GmailHistoryError::Expired),
        }
    }
}

fn first_message_id(conversation: &SeedConversation) -> Option<&'static str> {
    conversation
        .messages
        .iter()
        .min_by(|a, b| (a.sent_at, a.id).cmp(&(b.sent_at, b.id)))
        .map(|m| m.id)
}

fn invalid_mode() -> MailError {
    MailError::InvalidRequest {
        field: "mode".to_string(),
    }
}

/// The fixed bytes of the synthetic attachment (shared with the shell's
/// legacy path so the two can never disagree).
pub const SYNTHETIC_ATTACHMENT_BYTES: &[u8] = ATTACHMENT_BYTES;
