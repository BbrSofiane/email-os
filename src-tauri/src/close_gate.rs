use mail_core::drafts::types::AppCloseRequest;

/// Small in-memory gate for one native close intent at a time.
#[derive(Default)]
pub(crate) struct CloseGate {
    pending_request_id: Option<String>,
    authorized_exit: bool,
}

impl CloseGate {
    pub(crate) fn request(&mut self, fresh_request_id: impl FnOnce() -> String) -> AppCloseRequest {
        let request_id = self
            .pending_request_id
            .get_or_insert_with(fresh_request_id)
            .clone();
        AppCloseRequest { request_id }
    }

    pub(crate) fn pending(&self) -> Option<AppCloseRequest> {
        self.pending_request_id
            .as_ref()
            .map(|request_id| AppCloseRequest {
                request_id: request_id.clone(),
            })
    }

    pub(crate) fn complete(&mut self, request_id: &str) -> bool {
        if self.pending_request_id.as_deref() != Some(request_id) {
            return false;
        }
        self.pending_request_id = None;
        self.authorized_exit = true;
        true
    }

    pub(crate) fn cancel(&mut self, request_id: &str) -> bool {
        if self.pending_request_id.as_deref() != Some(request_id) {
            return false;
        }
        self.pending_request_id = None;
        true
    }

    pub(crate) fn take_exit_authorization(&mut self) -> bool {
        std::mem::take(&mut self.authorized_exit)
    }
}

#[cfg(test)]
mod tests {
    use super::CloseGate;

    #[test]
    fn requests_coalesce_until_the_active_intent_is_cancelled_or_completed() {
        let mut gate = CloseGate::default();
        let first = gate.request(|| "first".to_owned());
        let repeated = gate.request(|| "must-not-be-used".to_owned());
        assert_eq!(first, repeated);
        assert_eq!(gate.pending(), Some(first.clone()));
        assert!(gate.cancel(&first.request_id));

        let next = gate.request(|| "second".to_owned());
        assert_eq!(next.request_id, "second");
        assert_ne!(next, first);
    }

    #[test]
    fn stale_completion_and_cancellation_cannot_affect_a_later_intent() {
        let mut gate = CloseGate::default();
        let first = gate.request(|| "first".to_owned());
        assert!(gate.cancel(&first.request_id));
        let second = gate.request(|| "second".to_owned());

        assert!(!gate.complete(&first.request_id));
        assert!(!gate.cancel(&first.request_id));
        assert_eq!(gate.pending(), Some(second.clone()));
        assert!(!gate.take_exit_authorization());
    }

    #[test]
    fn completion_requires_the_current_native_request_and_authorizes_only_one_exit() {
        let mut gate = CloseGate::default();
        assert!(!gate.complete("no-request"));
        let request = gate.request(|| "current".to_owned());
        assert!(gate.complete(&request.request_id));
        assert_eq!(gate.pending(), None);
        assert!(gate.take_exit_authorization());
        assert!(!gate.take_exit_authorization());
        assert!(!gate.cancel(&request.request_id));
    }
}
