use crate::close_gate::CloseGate;
use mail_core::attachments::AttachmentTransfers;
use mail_core::drafts::{DraftCore, DraftService};
use mail_core::gmail::sync::{GmailCore, GmailUnsubscribe};
use std::sync::{Arc, Mutex};

/// Profile-specific state and its change listener.
pub(crate) struct Session {
    pub(crate) core: GmailCore,
    pub(crate) drafts: DraftService,
    _subscription: GmailUnsubscribe,
}

impl Session {
    pub(crate) fn new(
        core: GmailCore,
        drafts: DraftCore,
        on_change: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        let subscription = core.subscribe(on_change);
        Self {
            drafts: DraftService::new(core.clone(), drafts),
            core,
            _subscription: subscription,
        }
    }
}

/// Managed state shared by all profile sessions.
pub(crate) struct AppState {
    session: std::sync::RwLock<Arc<Session>>,
    pub(crate) attachment_transfers: AttachmentTransfers,
    pub(crate) close_gate: Arc<Mutex<CloseGate>>,
}

impl AppState {
    pub(crate) fn new(
        core: GmailCore,
        drafts: DraftCore,
        on_change: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        Self {
            session: std::sync::RwLock::new(Arc::new(Session::new(core, drafts, on_change))),
            attachment_transfers: AttachmentTransfers::default(),
            close_gate: Arc::new(Mutex::new(CloseGate::default())),
        }
    }

    pub(crate) fn session(&self) -> Result<Arc<Session>, mail_core::error::MailError> {
        self.session
            .read()
            .map(|session| Arc::clone(&session))
            .map_err(|_| {
                crate::diagnostics::storage_failure(crate::diagnostics::cause::LOCK_POISONED)
            })
    }

    pub(crate) fn replace_session(
        &self,
        next: Session,
    ) -> Result<Arc<Session>, mail_core::error::MailError> {
        let mut session = self.session.write().map_err(|_| {
            crate::diagnostics::storage_failure(crate::diagnostics::cause::LOCK_POISONED)
        })?;
        Ok(std::mem::replace(&mut *session, Arc::new(next)))
    }
}

/// Retire drafts before releasing the profile's core.
pub(crate) fn retire_session(old: &Session) {
    let _ = old.drafts.retire();
    old.core.stop();
}

#[cfg(test)]
mod tests {
    use crate::state::AppState;
    use crate::test_support::{conv, open};
    use mail_core::drafts::DraftCore;
    use mail_core::dto::{CachedDoneRequest, SetArchived};
    use mail_core::error::MailError;
    use mail_core::synthetic::WriteControls;
    use mail_core::testing::{temp_profile, until};
    use mail_core::ACCOUNT_ID;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn replacing_session_retires_old_drafts_and_releases_profile() {
        use super::{retire_session, Session};
        use mail_core::drafts::{CreateDraft, DraftContent, DraftSource, SaveDraft};
        let a = temp_profile("session-a");
        let b = temp_profile("session-b");
        let (core_a, profile_a) = crate::setup::open_fixture_core(a.path()).unwrap();
        let state = AppState::new(
            core_a,
            DraftCore::open(profile_a.join("local-drafts")).unwrap(),
            || {},
        );
        let old_drafts = state.session().unwrap().drafts.clone();
        let create = CreateDraft {
            request_id: "create".into(),
            source: DraftSource::NewMessage,
            initial_content: None,
        };
        let receipt = old_drafts.create_draft(&create).unwrap();
        let (core_b, profile_b) = crate::setup::open_fixture_core(b.path()).unwrap();
        let next = Session::new(
            core_b,
            DraftCore::open(profile_b.join("local-drafts")).unwrap(),
            || {},
        );
        let old = state.replace_session(next).unwrap();
        retire_session(&old);
        assert!(state.session().unwrap().core.list_conversations().is_ok());
        let error = MailError::InvalidRequest {
            field: "mode".into(),
        };
        assert_eq!(old_drafts.create_draft(&create), Err(error.clone()));
        let save = SaveDraft {
            draft_ref: receipt.draft_ref,
            expected_revision: receipt.revision,
            request_id: "save".into(),
            content: DraftContent {
                to: String::new(),
                cc: String::new(),
                subject: String::new(),
                body_text: String::new(),
            },
        };
        assert_eq!(old_drafts.save_draft(&save), Err(error));
        // The profile lock belongs to the core and is released when the last
        // handle to the retired session goes: drop the test's handles first.
        drop(old_drafts);
        drop(old);
        let (reopened, _) = crate::setup::open_fixture_core(a.path()).unwrap();
        let reopened_drafts = mail_core::drafts::DraftService::new(
            reopened.clone(),
            DraftCore::open(profile_a.join("local-drafts")).unwrap(),
        );
        assert_eq!(reopened_drafts.list_drafts().unwrap().len(), 1);
        assert!(state
            .session()
            .unwrap()
            .drafts
            .list_drafts()
            .unwrap()
            .is_empty());
        reopened.stop();
        state.session().unwrap().core.stop();
    }

    #[test]
    fn state_keeps_forwarding_after_command_acceptance() {
        let dir = temp_profile("synthetic-events");
        let core = open(dir.path(), WriteControls::default());
        let (tx, rx) = mpsc::channel();
        let drafts = DraftCore::open(dir.path().join("local-drafts")).unwrap();
        let state = AppState::new(core, drafts, move || {
            let _ = tx.send(());
        });
        let receipt = state
            .session()
            .unwrap()
            .core
            .set_archived(&SetArchived {
                conversation: conv("conv-01"),
                archived: true,
                request_id: "bridge-test".into(),
            })
            .unwrap();
        rx.recv_timeout(Duration::from_secs(2))
            .expect("acceptance event");
        assert!(until(|| {
            state
                .session()
                .unwrap()
                .core
                .list_conversations()
                .unwrap()
                .activity
                .iter()
                .any(|op| {
                    op.id == receipt.operation_id
                        && op.status == mail_core::dto::OperationStatus::Confirmed
                })
        }));
        // Completion also notified (drain until quiet, never sleeping).
        assert!(rx.try_iter().count() >= 1 || rx.recv_timeout(Duration::from_secs(2)).is_ok());
        let done = state
            .session()
            .unwrap()
            .core
            .list_cached_done(&CachedDoneRequest {
                account_id: ACCOUNT_ID.into(),
                limit: 10,
                cursor: None,
            })
            .unwrap();
        assert!(done
            .conversations
            .iter()
            .any(|row| row.conversation_ref.conversation_id == "conv-01"));
        assert_eq!(done.exact_total, None);
        assert_eq!(
            state
                .session()
                .unwrap()
                .core
                .list_cached_done(&CachedDoneRequest {
                    account_id: "foreign".into(),
                    limit: 10,
                    cursor: None,
                }),
            Err(MailError::NotFound)
        );
        state.session().unwrap().core.stop();
    }
}
