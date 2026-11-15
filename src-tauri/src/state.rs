use crate::close_gate::CloseGate;
use mail_core::attachments::AttachmentTransfers;
use mail_core::drafts::{DraftCore, DraftService};
use mail_core::gmail::sync::{GmailCore, GmailUnsubscribe};
use std::sync::{Arc, Mutex};

/// Managed app state retains its change-listener guard for the full app life.
pub(crate) struct AppState {
    pub(crate) core: GmailCore,
    pub(crate) drafts: DraftService,
    pub(crate) attachment_transfers: AttachmentTransfers,
    pub(crate) close_gate: Arc<Mutex<CloseGate>>,
    _subscription: GmailUnsubscribe,
}

impl AppState {
    pub(crate) fn new(
        core: GmailCore,
        drafts: DraftCore,
        on_change: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        let subscription = core.subscribe(on_change);
        Self {
            drafts: DraftService::new(core.clone(), drafts),
            core,
            attachment_transfers: AttachmentTransfers::default(),
            close_gate: Arc::new(Mutex::new(CloseGate::default())),
            _subscription: subscription,
        }
    }
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
    fn state_keeps_forwarding_after_command_acceptance() {
        let dir = temp_profile("synthetic-events");
        let core = open(dir.path(), WriteControls::default());
        let (tx, rx) = mpsc::channel();
        let drafts = DraftCore::open(dir.path().join("local-drafts")).unwrap();
        let state = AppState::new(core, drafts, move || {
            let _ = tx.send(());
        });
        let receipt = state
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
            state.core.list_cached_done(&CachedDoneRequest {
                account_id: "foreign".into(),
                limit: 10,
                cursor: None,
            }),
            Err(MailError::NotFound)
        );
        state.core.stop();
    }
}
