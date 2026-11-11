//! THROWAWAY NOT FOR MERGE: synthetic provider + real GmailCore/SQLite spike.
//!
//! Special cases and limitations:
//! - Imports the crate-private fixture seed by path and provides its mailbox
//!   shim locally; fixture IDs/content remain the repository's actual seed.
//! - After normal inbox discovery, the test explicitly calls
//!   `load_search_conversation` for the two seed-archived rows. This exercises
//!   GmailCore's existing explicit historical-load seam; it is not a claim that
//!   ordinary inbox sync imports arbitrary archived messages.
//! - `history` emits every seed conversation on each pass to force fake
//!   reconciliation. This does not model Gmail's incremental history cursor.
//! - Provider facts persist in a simple test JSON file and apply_archive
//!   mutates them; JSON writes are not atomic/crash-durable and the fake models
//!   archive as a conversation fact instead of Gmail's per-message labels.
//! - has_credentials/mutation_access are readiness shims only: no OAuth,
//!   credential, keychain, network, Google behavior, or platform integration
//!   is exercised. No feature-parity claim is made.
//! - The Gmail reminder test covers local-device timer state only. GmailCore
//!   reminders do not perform mailbox archive/restore operations; the fixture
//!   MailCore reminder path is different and is not under test here.
use mail_core::{
    ACCOUNT_ID, CancelToken, MailError,
    clock::{FakeClock, utc},
    dto::{Address, Conversation, ConversationRef, OperationStatus, SetArchived, UndoOperation},
    gmail::{
        sync::GmailCore,
        types::{
            GmailHistoryError, GmailProfile, GmailReadProvider, GmailThread, HistoryPage, InboxPage,
        },
    },
    groups::{SetArchivedGroup, UndoOperationGroup},
    reminders::{PutReminder, ReminderCondition, ReminderPhase},
};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const FIXTURE_MAILBOX: &str = mail_core::FIXTURE_MAILBOX;
#[path = "../src/seed.rs"]
mod seed;

#[derive(Default)]
struct SyntheticProvider {
    facts_path: PathBuf,
    archived: Mutex<HashMap<String, bool>>,
}
impl SyntheticProvider {
    fn open(path: PathBuf) -> Self {
        let archived = fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            facts_path: path,
            archived: Mutex::new(archived),
        }
    }
    fn save(&self) -> Result<(), MailError> {
        let bytes = serde_json::to_vec(
            &*self
                .archived
                .lock()
                .map_err(|_| MailError::StorageUnavailable)?,
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        if let Some(parent) = self.facts_path.parent() {
            fs::create_dir_all(parent).map_err(|_| MailError::StorageUnavailable)?;
        }
        fs::write(&self.facts_path, bytes).map_err(|_| MailError::StorageUnavailable)
    }
    fn fact(&self, id: &str, seed_inbox: bool) -> bool {
        *self
            .archived
            .lock()
            .unwrap()
            .get(id)
            .unwrap_or(&!seed_inbox)
    }
}
impl GmailReadProvider for SyntheticProvider {
    fn is_configured(&self) -> bool {
        true
    }
    fn has_credentials(&self) -> Result<bool, MailError> {
        Ok(true)
    }
    fn connect(&self, c: &CancelToken) -> Result<GmailProfile, MailError> {
        self.profile(c)
    }
    fn disconnect(&self) -> Result<(), MailError> {
        Ok(())
    }
    fn profile(&self, _: &CancelToken) -> Result<GmailProfile, MailError> {
        Ok(GmailProfile {
            account_id: ACCOUNT_ID.into(),
            email_address: mail_core::FIXTURE_MAILBOX.into(),
            history_id: "1".into(),
        })
    }
    fn list_inbox(&self, _: Option<&str>, _: &CancelToken) -> Result<InboxPage, MailError> {
        Ok(InboxPage {
            thread_ids: seed::fixtures()
                .iter()
                .filter(|c| !self.fact(c.id, c.in_inbox))
                .map(|c| c.id.into())
                .collect(),
            next_page_token: None,
        })
    }
    fn get_thread(&self, id: &str, _: &CancelToken) -> Result<Option<GmailThread>, MailError> {
        let Some(row) = seed::fixtures().into_iter().find(|c| c.id == id) else {
            return Ok(None);
        };
        let messages: Vec<_> = row
            .messages
            .iter()
            .map(|m| mail_core::dto::Message {
                id: m.id.into(),
                from: Address {
                    display_name: (!m.from.0.is_empty()).then(|| m.from.0.into()),
                    mailbox: m.from.1.into(),
                },
                to: m
                    .to
                    .iter()
                    .map(|(n, a)| Address {
                        display_name: (!n.is_empty()).then(|| (*n).into()),
                        mailbox: (*a).into(),
                    })
                    .collect(),
                sent_at: m.sent_at.into(),
                body_text: m.body.into(),
                has_attachment: None,
            })
            .collect();
        let ids: Vec<_> = messages.iter().map(|m| m.id.clone()).collect();
        let archived = self.fact(id, row.in_inbox);
        Ok(Some(GmailThread {
            star_facts: None,
            newest_sender: messages.last().map(|m| m.from.clone()),
            attachments: vec![],
            conversation: Conversation {
                conversation_ref: ConversationRef {
                    account_id: ACCOUNT_ID.into(),
                    conversation_id: id.into(),
                },
                subject: row.subject.into(),
                messages,
                is_in_inbox: !archived,
                is_read: Some(false),
                pending_operation_id: None,
                context_complete: Some(true),
                unsupported_reason: None,
                retained_snapshot_at: None,
                reply_context: None,
                stars: None,
            },
            inbox_message_ids: if archived { vec![] } else { ids.clone() },
            unread_message_ids: Some(ids.clone()),
            trash_message_ids: None,
            spam_message_ids: None,
            message_ids: Some(ids),
            history_id: "1".into(),
        }))
    }
    fn history(
        &self,
        _: &str,
        _: Option<&str>,
        _: &CancelToken,
    ) -> Result<HistoryPage, GmailHistoryError> {
        Ok(HistoryPage {
            changed_thread_ids: seed::fixtures().iter().map(|c| c.id.into()).collect(),
            deleted_message_ids: vec![],
            next_page_token: None,
            history_id: "1".into(),
        })
    }
    fn mutation_access(&self) -> Result<bool, MailError> {
        Ok(true)
    }
    fn apply_archive(
        &self,
        ids: &[String],
        archived: bool,
        _: &CancelToken,
    ) -> Result<(), MailError> {
        let fixtures = seed::fixtures();
        let mut facts = self
            .archived
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        for message_id in ids {
            if let Some(conv) = fixtures
                .iter()
                .find(|c| c.messages.iter().any(|m| m.id == message_id))
            {
                facts.insert(conv.id.into(), archived);
            }
        }
        drop(facts);
        self.save()
    }
}

fn wait_for(mut predicate: impl FnMut() -> bool, why: &str) {
    let end = Instant::now() + Duration::from_secs(8);
    while !predicate() {
        assert!(Instant::now() < end, "timed out: {why}");
        thread::sleep(Duration::from_millis(10));
    }
}
fn ref_for(id: &str) -> ConversationRef {
    ConversationRef {
        account_id: ACCOUNT_ID.into(),
        conversation_id: id.into(),
    }
}

#[test]
fn synthetic_provider_catalog_archive_undo_restart_and_local_reminder() {
    let dir = std::env::temp_dir().join(format!(
        "synthetic-spike-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    let db = dir.join("gmail-profile");
    let facts = dir.join("provider-facts.json");
    let clock = Arc::new(FakeClock::new(utc("2030-01-01T00:00:00Z")));
    let open = || {
        GmailCore::open_with_clock(
            &db,
            Arc::new(SyntheticProvider::open(facts.clone())),
            clock.clone(),
        )
        .unwrap()
    };
    let core = open();
    wait_for(
        || {
            let s = core.account_status().unwrap();
            s.connection == mail_core::gmail::types::ConnectionState::Connected
                && s.sync.initial_sync_complete
                && s.sync.state == mail_core::gmail::types::SyncState::Idle
        },
        "initial sync idle",
    );
    let rows = core.list_conversations().unwrap();
    assert_eq!(
        rows.conversations.len(),
        16,
        "only 16 provider INBOX conversations visible"
    );
    for fixture in seed::fixtures().into_iter().filter(|c| !c.in_inbox) {
        let loaded = core.load_search_conversation(&ref_for(fixture.id)).unwrap();
        assert_eq!(loaded.subject, fixture.subject);
        assert!(!loaded.is_in_inbox);
    }
    let all = core
        .search_mail(&mail_core::search::SearchRequest {
            account_id: ACCOUNT_ID.into(),
            query: "-subject:zzzz_nonexistent".into(),
            cursor: None,
            cached_only: true,
        })
        .unwrap();
    assert_eq!(
        all.conversations.len(),
        18,
        "cached search lists all 18, including archived fixtures"
    );
    for fixture in seed::fixtures() {
        let conversation = core.get_conversation(&ref_for(fixture.id)).unwrap();
        assert_eq!(conversation.subject, fixture.subject);
        assert_eq!(conversation.messages.len(), fixture.messages.len());
        assert_eq!(conversation.is_in_inbox, fixture.in_inbox);
    }

    let single = core
        .set_archived(&SetArchived {
            conversation: ref_for("conv-01"),
            archived: true,
            request_id: "spike-single-archive".into(),
        })
        .unwrap();
    wait_for(
        || {
            fs::read(&facts)
                .ok()
                .and_then(|b| serde_json::from_slice::<HashMap<String, bool>>(&b).ok())
                .is_some_and(|m| m.get("conv-01") == Some(&true))
        },
        "single provider archive",
    );
    wait_for(
        || {
            core.list_conversations()
                .unwrap()
                .activity
                .iter()
                .any(|a| a.id == single.operation_id && a.status == OperationStatus::Confirmed)
        },
        "single operation confirmed",
    );
    let undo = core
        .undo_operation(&UndoOperation {
            operation_id: single.operation_id,
            request_id: "spike-single-undo".into(),
        })
        .unwrap();
    wait_for(
        || {
            fs::read(&facts)
                .ok()
                .and_then(|b| serde_json::from_slice::<HashMap<String, bool>>(&b).ok())
                .is_some_and(|m| m.get("conv-01") == Some(&false))
        },
        "single provider undo",
    );
    wait_for(
        || {
            undo.operation_ids.iter().all(|id| {
                core.list_conversations()
                    .unwrap()
                    .activity
                    .iter()
                    .any(|a| &a.id == id && a.status == OperationStatus::Confirmed)
            })
        },
        "single undo operation confirmed",
    );

    let group = core
        .set_archived_group(&SetArchivedGroup {
            account_id: ACCOUNT_ID.into(),
            members: vec![ref_for("conv-02"), ref_for("conv-03")],
            archived: true,
            request_id: "spike-group-archive".into(),
        })
        .unwrap();
    wait_for(
        || {
            fs::read(&facts)
                .ok()
                .and_then(|b| serde_json::from_slice::<HashMap<String, bool>>(&b).ok())
                .is_some_and(|m| m.get("conv-02") == Some(&true) && m.get("conv-03") == Some(&true))
        },
        "group provider archive",
    );
    wait_for(
        || {
            group
                .members
                .iter()
                .filter_map(|m| m.operation_id.as_ref())
                .all(|id| {
                    core.list_conversations()
                        .unwrap()
                        .activity
                        .iter()
                        .any(|a| &a.id == id && a.status == OperationStatus::Confirmed)
                })
        },
        "group operations confirmed",
    );
    let group_undo = core
        .undo_operation_group(&UndoOperationGroup {
            group_id: group.group_id,
            request_id: "spike-group-undo".into(),
        })
        .unwrap();
    wait_for(
        || {
            fs::read(&facts)
                .ok()
                .and_then(|b| serde_json::from_slice::<HashMap<String, bool>>(&b).ok())
                .is_some_and(|m| {
                    m.get("conv-02") == Some(&false) && m.get("conv-03") == Some(&false)
                })
        },
        "group provider undo",
    );
    wait_for(
        || {
            group_undo
                .members
                .iter()
                .flat_map(|m| &m.operation_ids)
                .all(|id| {
                    core.list_conversations()
                        .unwrap()
                        .activity
                        .iter()
                        .any(|a| &a.id == id && a.status == OperationStatus::Confirmed)
                })
        },
        "group undo operations confirmed",
    );

    let persistent = core
        .set_archived(&SetArchived {
            conversation: ref_for("conv-04"),
            archived: true,
            request_id: "spike-persistent-archive".into(),
        })
        .unwrap();
    wait_for(
        || {
            fs::read(&facts)
                .ok()
                .and_then(|b| serde_json::from_slice::<HashMap<String, bool>>(&b).ok())
                .is_some_and(|m| m.get("conv-04") == Some(&true))
        },
        "persistent provider archive",
    );
    wait_for(
        || {
            core.list_conversations()
                .unwrap()
                .activity
                .iter()
                .any(|a| a.id == persistent.operation_id && a.status == OperationStatus::Confirmed)
        },
        "persistent operation confirmed",
    );
    core.stop();
    drop(core);
    let restarted = open();
    wait_for(
        || {
            let s = restarted.account_status().unwrap();
            s.connection == mail_core::gmail::types::ConnectionState::Connected
                && s.sync.initial_sync_complete
                && s.sync.state == mail_core::gmail::types::SyncState::Idle
        },
        "restart sync idle",
    );
    for fixture in seed::fixtures().into_iter().filter(|c| !c.in_inbox) {
        restarted
            .load_search_conversation(&ref_for(fixture.id))
            .unwrap();
    }
    assert!(
        !restarted
            .get_conversation(&ref_for("conv-04"))
            .unwrap()
            .is_in_inbox
    );
    for fixture in seed::fixtures() {
        assert!(restarted.get_conversation(&ref_for(fixture.id)).is_ok());
    }
    assert_eq!(
        restarted
            .set_archived(&SetArchived {
                conversation: ref_for("conv-04"),
                archived: true,
                request_id: "spike-persistent-archive".into()
            })
            .unwrap(),
        persistent,
        "acceptance receipt replays from SQLite after restart"
    );
    let source = restarted
        .get_conversation(&ref_for("conv-05"))
        .unwrap()
        .messages
        .last()
        .unwrap()
        .id
        .clone();
    restarted
        .put_reminder(&PutReminder {
            conversation: ref_for("conv-05"),
            source_message_id: source,
            due_at: Some("2030-01-01T00:01:00Z".into()),
            condition: ReminderCondition::Regardless,
            expected_revision: None,
            request_id: "spike-reminder".into(),
        })
        .unwrap();
    wait_for(
        || {
            restarted
                .list_reminders()
                .unwrap()
                .first()
                .is_some_and(|r| r.phase == ReminderPhase::Pending)
        },
        "reminder scheduled",
    );
    assert!(
        !restarted
            .get_conversation(&ref_for("conv-05"))
            .unwrap()
            .is_in_inbox,
        "reminder hides the Gmail conversation locally"
    );
    clock.advance_seconds(61);
    restarted.request_sync().unwrap();
    wait_for(
        || {
            restarted
                .list_reminders()
                .unwrap()
                .first()
                .is_some_and(|r| r.phase == ReminderPhase::Returned)
        },
        "local Gmail reminder due transition",
    );
    assert!(
        restarted
            .get_conversation(&ref_for("conv-05"))
            .unwrap()
            .is_in_inbox,
        "returned reminder makes the conversation visible again"
    );
    assert!(
        !fs::read(&facts)
            .ok()
            .and_then(|b| serde_json::from_slice::<HashMap<String, bool>>(&b).ok())
            .is_some_and(|m| m.get("conv-05") == Some(&true)),
        "local reminder did not mutate provider archive facts"
    );
    restarted.stop();
    drop(restarted);
    let _ = fs::remove_dir_all(Path::new(&dir));
}
