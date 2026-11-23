//! Scripted platform authorization for synthetic tests.
use crate::cancel::CancelToken;
use crate::gmail::platform_auth::{
    PlatformAuthError, PlatformAuthRequest, PlatformAuthorizer, PlatformGrant,
};
use std::collections::VecDeque;
use std::sync::Mutex;

/// Recorded request; debug output redacts the account.
#[derive(Clone)]
pub struct RecordedRequest {
    /// Requested scopes.
    pub scopes: Vec<String>,
    /// Requested account.
    pub account: Option<String>,
    /// Whether interaction was allowed.
    pub interactive: bool,
}
/// Queue-driven platform authorizer.
#[derive(Default)]
pub struct ScriptedAuthorizer {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    authorize: VecDeque<Result<PlatformGrant, PlatformAuthError>>,
    clear: VecDeque<Result<(), PlatformAuthError>>,
    requests: Vec<RecordedRequest>,
    cleared: Vec<String>,
}
impl ScriptedAuthorizer {
    /// Queues an authorization result.
    pub fn push_authorize(&self, result: Result<PlatformGrant, PlatformAuthError>) {
        self.state.lock().unwrap().authorize.push_back(result);
    }
    /// Queues a clear result.
    pub fn push_clear(&self, result: Result<(), PlatformAuthError>) {
        self.state.lock().unwrap().clear.push_back(result);
    }
    /// Returns recorded requests.
    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.state.lock().unwrap().requests.clone()
    }
    /// Returns tokens passed to clear.
    pub fn cleared_tokens(&self) -> Vec<String> {
        self.state.lock().unwrap().cleared.clone()
    }
}
impl PlatformAuthorizer for ScriptedAuthorizer {
    fn authorize(
        &self,
        request: &PlatformAuthRequest,
        cancel: &CancelToken,
    ) -> Result<PlatformGrant, PlatformAuthError> {
        if cancel.is_cancelled() {
            return Err(PlatformAuthError::Cancelled);
        }
        let mut state = self.state.lock().unwrap();
        state.requests.push(RecordedRequest {
            scopes: request.scopes.clone(),
            account: request.account.clone(),
            interactive: request.interactive,
        });
        state
            .authorize
            .pop_front()
            .unwrap_or(Err(PlatformAuthError::NeedsUserInteraction))
    }
    fn clear_token(&self, token: &str) -> Result<(), PlatformAuthError> {
        let mut state = self.state.lock().unwrap();
        state.cleared.push(token.to_owned());
        state.clear.pop_front().unwrap_or(Ok(()))
    }
}
