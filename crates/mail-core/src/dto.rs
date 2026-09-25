//! Rust-owned wire DTOs. CamelCase JSON fields, snake_case enum
//! discriminants, strings for IDs and ISO-8601 UTC timestamps, `null` for
//! absent optionals. The generated TypeScript contract lives in
//! `src/bin/generate-types.rs`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Stable reference to one conversation on one account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRef {
    pub account_id: String,
    pub conversation_id: String,
}

/// One mail participant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Address {
    /// Absent display name serializes as `null`.
    pub display_name: Option<String>,
    pub mailbox: String,
}

/// Lifecycle of a queued archive command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Queued,
    Applying,
    Confirmed,
    Failed,
}

/// Definite failure kinds. Cancelled work is not a failure; it is recovered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum OperationFailure {
    ProviderUnavailable,
    ProviderRejected,
}

/// Durable acceptance proof for a command. Returned only after commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OperationReceipt {
    pub operation_id: String,
    pub accepted_at: String,
}

/// Archive or unarchive one conversation, idempotent under `requestId`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SetArchived {
    pub conversation: ConversationRef,
    pub archived: bool,
    pub request_id: String,
}

/// One cached plain-text message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub from: Address,
    pub to: Vec<Address>,
    pub sent_at: String,
    /// Literal fixture text; hostile markup is data, never rendered.
    pub body_text: String,
}

/// Full conversation for the reader.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    #[serde(rename = "ref")]
    pub conversation_ref: ConversationRef,
    pub subject: String,
    pub messages: Vec<Message>,
    /// Effective inbox membership (cached provider facts + pending overlay).
    pub is_in_inbox: bool,
    /// Newest queued/applying operation id, if any.
    pub pending_operation_id: Option<String>,
}

/// One row of the conversation list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    #[serde(rename = "ref")]
    pub conversation_ref: ConversationRef,
    pub subject: String,
    pub participants: Vec<Address>,
    /// Plain-text preview derived from the newest message body.
    pub preview: String,
    pub last_message_at: String,
    pub pending_operation_id: Option<String>,
}

/// One persisted operation row for the activity surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OperationSummary {
    pub id: String,
    pub conversation: ConversationRef,
    pub requested_archived: bool,
    pub status: OperationStatus,
    /// `null` unless the operation failed definitely.
    pub failure: Option<OperationFailure>,
}

/// Inbox list plus full operation history for this fixture slice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InboxSnapshot {
    /// Conversations in the effective inbox, newest message first.
    pub conversations: Vec<ConversationSummary>,
    /// Persisted operations, newest acceptance first.
    pub activity: Vec<OperationSummary>,
}
