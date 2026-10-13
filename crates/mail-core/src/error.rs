//! Wire-facing error type. Rust owns the DTO shape; the Tauri shell rejects
//! promises with this exact object (camelCase keys, snake_case discriminants).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Typed error surfaced across IPC. `kind` is the discriminant; payloads stay flat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum MailError {
    #[error("referenced account, conversation or operation was not found")]
    NotFound,
    #[error("invalid request field: {field}")]
    InvalidRequest {
        /// Name of the offending request field (camelCase DTO name).
        field: String,
    },
    #[error("request id was already used with a different command payload")]
    RequestIdConflict,
    #[error("local storage is unavailable; the operation was not accepted")]
    StorageUnavailable,
    #[error("another writer owns this profile; refusing concurrent access")]
    ProfileInUse,
}

/// Fake-provider outcome. `Cancelled` is not a failure: the operation stays
/// durably in `applying` and is requeued on the next launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderError {
    /// Definite provider-side unavailability; the operation is marked `failed`.
    Unavailable,
    /// Definite provider rejection; the operation is marked `failed`.
    Rejected,
    /// Shutdown cancellation; the operation stays durable for recovery.
    Cancelled,
}

impl ProviderError {
    /// Wire-facing failure discriminant for a definite failure. `Cancelled`
    /// never produces an `OperationFailure`; it is recovered instead.
    pub fn failure_kind(self) -> Option<&'static str> {
        match self {
            ProviderError::Unavailable => Some("provider_unavailable"),
            ProviderError::Rejected => Some("provider_rejected"),
            ProviderError::Cancelled => None,
        }
    }
}
