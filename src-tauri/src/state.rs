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
