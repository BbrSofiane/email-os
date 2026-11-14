//! Local reminder wire DTOs. Reminders are local to this app (ADR 0002
//! decision 3): scheduling hides a conversation, the deadline shows it again,
//! and no provider write is ever made. Never infer Gmail evidence from cached rows.
use crate::dto::ConversationRef;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReminderCondition {
    IfNoReply,
    Regardless,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReminderPhase {
    Removing,
    Pending,
    Returning,
    Returned,
    Suppressed,
    Cancelling,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub conversation: ConversationRef,
    pub subject: String,
    pub revision: u32,
    pub source_message_id: String,
    pub due_at: Option<String>,
    pub condition: ReminderCondition,
    pub phase: ReminderPhase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PutReminder {
    pub conversation: ConversationRef,
    pub source_message_id: String,
    pub due_at: Option<String>,
    pub condition: ReminderCondition,
    pub expected_revision: Option<u32>,
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CancelReminder {
    pub conversation: ConversationRef,
    pub expected_revision: u32,
    pub request_id: String,
}
