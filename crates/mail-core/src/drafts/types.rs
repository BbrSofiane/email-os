//! Slice 04 local draft contracts. These are editor records, never send payloads.
use crate::dto::ConversationRef;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const MAX_RECIPIENT_BYTES: usize = 16 * 1024;
pub const MAX_SUBJECT_BYTES: usize = 4 * 1024;
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_REPLY_REFERENCES: usize = 100;
pub const MAX_REPLY_HEADER_BYTES: usize = 16 * 1024;
pub const MAX_REPLY_TO_RECIPIENTS: usize = 20;

/// Validated header facts for the explicitly displayed source message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReplyContext {
    pub source_message_id: String,
    pub from_mailbox: String,
    /// None means Reply-To was absent; malformed/present-empty is unavailable.
    pub reply_to_mailboxes: Option<Vec<String>>,
    pub message_id: String,
    pub references: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DraftRef {
    pub account_id: String,
    pub draft_id: String,
}

/// Raw, possibly incomplete editor text. No send-readiness claim or normalization.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DraftContent {
    pub to: String,
    pub cc: String,
    pub subject: String,
    pub body_text: String,
}

impl std::fmt::Debug for DraftContent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DraftContent")
            .field("to_bytes", &self.to.len())
            .field("cc_bytes", &self.cc.len())
            .field("subject_bytes", &self.subject.len())
            .field("body_bytes", &self.body_text.len())
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DraftSource {
    NewMessage,
    Reply {
        conversation: ConversationRef,
        #[serde(rename = "sourceMessageId")]
        source_message_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DraftReplyLink {
    pub conversation: ConversationRef,
    pub source_message_id: String,
    pub message_id: String,
    pub references: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    #[serde(rename = "ref")]
    pub draft_ref: DraftRef,
    pub revision: u32,
    pub created_at: String,
    pub updated_at: String,
    pub content: DraftContent,
    pub source: DraftSource,
    pub reply_link: Option<DraftReplyLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    #[serde(rename = "ref")]
    pub draft_ref: DraftRef,
    pub revision: u32,
    pub updated_at: String,
    pub subject: String,
    pub to: String,
    pub source: DraftSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DraftReceipt {
    #[serde(rename = "ref")]
    pub draft_ref: DraftRef,
    pub revision: u32,
    pub saved_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DraftDeleteReceipt {
    #[serde(rename = "ref")]
    pub draft_ref: DraftRef,
    pub deleted_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateDraft {
    pub request_id: String,
    pub source: DraftSource,
    pub initial_content: Option<DraftContent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SaveDraft {
    #[serde(rename = "ref")]
    pub draft_ref: DraftRef,
    pub expected_revision: u32,
    pub request_id: String,
    pub content: DraftContent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDraft {
    #[serde(rename = "ref")]
    pub draft_ref: DraftRef,
    pub expected_revision: u32,
    pub request_id: String,
}

/// Volatile native close intent. A stale ID cannot authorize a later close.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppCloseRequest {
    pub request_id: String,
}
