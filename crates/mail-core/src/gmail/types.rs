//! Shared Slice 02 wire and provider contracts. No credentials cross this boundary.
use crate::dto::Conversation;
use crate::{CancelToken, MailError};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MailMode {
    Fixture,
    Gmail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    NotConfigured,
    Disconnected,
    Authenticating,
    Connected,
    AuthRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    Idle,
    Syncing,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub account_id: String,
    pub email_address: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    pub state: SyncState,
    pub last_synced_at: Option<String>,
    pub error: Option<MailError>,
    pub cached_conversations: usize,
    pub initial_sync_complete: bool,
    pub coverage_limit: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MutationAccess {
    ReadOnly,
    Upgrading,
    Enabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub mode: MailMode,
    pub connection: ConnectionState,
    pub account: Option<AccountInfo>,
    pub sync: SyncInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mutation_access: Option<MutationAccess>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct GmailProfile {
    pub account_id: String,
    pub email_address: String,
    pub history_id: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct InboxPage {
    pub thread_ids: Vec<String>,
    pub next_page_token: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct GmailThread {
    pub conversation: Conversation,
    pub inbox_message_ids: Vec<String>,
    /// Full observed inventory, including unsupported bodies. None for legacy fakes.
    pub message_ids: Option<Vec<String>>,
    /// IDs with UNREAD. None means the read facts are unknown.
    pub unread_message_ids: Option<Vec<String>>,
    pub history_id: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct HistoryPage {
    pub changed_thread_ids: Vec<String>,
    pub deleted_message_ids: Vec<String>,
    pub next_page_token: Option<String>,
    pub history_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GmailHistoryError {
    Expired,
    Mail(MailError),
}

impl From<MailError> for GmailHistoryError {
    fn from(value: MailError) -> Self {
        Self::Mail(value)
    }
}

/// Synchronous calls run exclusively on background/blocking threads, outside DB locks.
pub trait GmailReadProvider: Send + Sync {
    fn mutation_access(&self) -> Result<bool, MailError> {
        Ok(false)
    }
    fn enable_mutations(&self, _cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        Err(MailError::PermissionRequired)
    }
    fn apply_archive(
        &self,
        _message_ids: &[String],
        _archived: bool,
        _cancel: &CancelToken,
    ) -> Result<(), MailError> {
        Err(MailError::PermissionRequired)
    }
    fn apply_read(
        &self,
        _message_ids: &[String],
        _read: bool,
        _cancel: &CancelToken,
    ) -> Result<(), MailError> {
        Err(MailError::PermissionRequired)
    }
    fn is_configured(&self) -> bool;
    fn has_credentials(&self) -> Result<bool, MailError>;
    fn connect(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError>;
    fn disconnect(&self) -> Result<(), MailError>;
    fn profile(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError>;
    fn list_inbox(
        &self,
        page_token: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<InboxPage, MailError>;
    fn get_thread(
        &self,
        thread_id: &str,
        cancel: &CancelToken,
    ) -> Result<Option<GmailThread>, MailError>;
    fn history(
        &self,
        start_history_id: &str,
        page_token: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<HistoryPage, GmailHistoryError>;
}
