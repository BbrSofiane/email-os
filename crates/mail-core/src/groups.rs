//! UX-05 durable operation-group wire DTOs (docs/ux-05-safe-bulk-processing.md
//! §4.2). Frozen seam stage: types, bounds and command shapes only; both-store
//! acceptance/undo algorithms land in the next stage. Naming and encoding follow
//! `crate::dto`: camelCase JSON fields, snake_case discriminants, ISO-8601 UTC
//! timestamps, `null`/absent optionals.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::dto::{ConversationRef, MailboxOperationKind, OperationFailure, UndoUnavailableReason};

/// Product/safety bound (docs/ux-05-safe-bulk-processing.md §3.1): a group
/// carries 1–100 unique conversations. Not a provider limit.
pub const OPERATION_GROUP_MAX_MEMBERS: usize = 100;
pub const OPERATION_GROUP_MIN_MEMBERS: usize = 1;

/// Archive or unarchive a bounded set of conversations as one durable group,
/// idempotent under `requestId`. One setter kind/value for the whole group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SetArchivedGroup {
    /// Owning account; every member ref must carry this same account.
    pub account_id: String,
    /// Original persisted member ordering is the array order here.
    pub members: Vec<ConversationRef>,
    pub archived: bool,
    pub request_id: String,
}

/// Group read/unread setter; Gmail-only like the single `SetRead` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SetReadGroup {
    pub account_id: String,
    pub members: Vec<ConversationRef>,
    pub read: bool,
    pub request_id: String,
}

/// Why a member was rejected at group acceptance instead of receiving a child
/// operation. Persisted in the group receipt; never fabricated as a failed
/// provider operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum GroupMemberRejection {
    /// Conversation gone or otherwise unactionable (no immutable targets).
    ConversationMissing,
    /// Member would exceed the existing per-operation message target bound.
    TargetBoundExceeded,
}

/// Immutable per-member acceptance facts inside a committed group receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemberReceipt {
    /// Stable member ordinal; never renumbered by later list changes.
    pub ordinal: u32,
    pub conversation: ConversationRef,
    /// Accepted child operation id; `null` for rejected members.
    pub operation_id: Option<String>,
    /// Typed acceptance rejection; `null` for accepted members.
    pub rejection: Option<GroupMemberRejection>,
}

/// Durable acceptance proof for a committed operation group. Returned only
/// after the single acceptance transaction commits; replaying the same
/// request/payload returns this receipt unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OperationGroupReceipt {
    pub group_id: String,
    pub request_id: String,
    pub account_id: String,
    pub kind: MailboxOperationKind,
    /// Archive groups carry `Some(archived)`; read groups `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub requested_archived: Option<bool>,
    /// Read groups carry `Some(read)`; archive groups `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub requested_read: Option<bool>,
    pub accepted_at: String,
    /// Original persisted member ordering; never re-resolved or reordered.
    pub members: Vec<GroupMemberReceipt>,
}

/// Current status of one member. `rejected` is an acceptance outcome; the
/// remaining variants mirror the accepted child operation's execution status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum GroupMemberStatus {
    Rejected,
    Queued,
    Applying,
    Confirmed,
    Failed,
    OutcomeUnknown,
    Cancelled,
}

/// Query a group by its original acceptance request ID on the active account.
/// Resolves a lost acceptance response; replaying the exact original request —
/// never a fresh one — is the other recovery route.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GetOperationGroupRequest {
    pub account_id: String,
    pub request_id: String,
}

/// Rust-owned group Undo eligibility at query time. Group Undo is one action
/// for the whole group: expiry/supersession/already-undone reject the whole
/// attempt, while per-member ineligibility becomes a persisted skip instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GroupUndoAvailability {
    pub available: bool,
    /// Typed reason when `available` is false.
    pub reason: Option<UndoUnavailableReason>,
    /// ISO-8601 UTC deadline when the group is currently undoable.
    pub undoable_until: Option<String>,
}

/// Current member status view joined from the immutable receipt and the child
/// operation rows. Rejected members carry the typed rejection; accepted members
/// carry the child operation's execution status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemberStatusView {
    pub ordinal: u32,
    pub conversation: ConversationRef,
    /// Accepted child operation id; `null` for rejected members.
    pub operation_id: Option<String>,
    pub status: GroupMemberStatus,
    /// Definite failure of the child operation, if any.
    pub failure: Option<OperationFailure>,
    /// Typed acceptance rejection, if any.
    pub rejection: Option<GroupMemberRejection>,
}

/// Committed group plus current member statuses and Undo availability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OperationGroupStatus {
    /// Immutable acceptance receipt, unchanged since commit.
    pub group: OperationGroupReceipt,
    /// One entry per receipt member, in persisted member order.
    pub members: Vec<GroupMemberStatusView>,
    pub undo: GroupUndoAvailability,
}

/// Bounded, account-scoped recent group summaries with cursor, independent of
/// Inbox/Done rows. A group absent from a recent page stays addressable by its
/// request ID through `get_operation_group`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ListOperationGroupsRequest {
    pub account_id: String,
    pub limit: u32,
    pub cursor: Option<String>,
}

/// One recent group for the Activity list surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OperationGroupSummary {
    pub group_id: String,
    pub request_id: String,
    pub kind: MailboxOperationKind,
    /// Archive groups carry `Some(archived)`; read groups `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub requested_archived: Option<bool>,
    /// Read groups carry `Some(read)`; archive groups `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub requested_read: Option<bool>,
    pub accepted_at: String,
    /// Immutable accepted member manifest in persisted ordinal order.
    pub members: Vec<ConversationRef>,
    /// True once this group's single group-Undo attempt has been accepted.
    pub undone: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OperationGroupPage {
    pub groups: Vec<OperationGroupSummary>,
    pub next_cursor: Option<String>,
}

/// One group Undo attempt for the whole group, idempotent under `requestId`.
/// The same request returns the same decisions; a second, different request
/// rejects with `undo_unavailable` (one attempt per group).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UndoOperationGroup {
    pub group_id: String,
    pub request_id: String,
}

/// Why a member was skipped by a group Undo attempt. Persisted so skipped
/// members stay visible in Activity and are not silently retried.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum GroupUndoSkipReason {
    /// Rejected at acceptance; no child operation existed to undo.
    AcceptanceRejected,
    /// Child definitively failed; nothing to compensate.
    Failed,
    /// Child outcome unknown; verify state before any retry.
    OutcomeUnknown,
    /// Child's prior values were unknown; compensation cannot be derived.
    UnknownPrior,
    /// Child was already undone (e.g. by an earlier superseding path).
    AlreadyUndone,
}

/// Durable per-member Undo decision. Cancelling queued intent is immediately
/// local; compensating intent stays pending until the child confirms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GroupMemberUndoDecision {
    /// Queued child was cancelled in place.
    Cancelled,
    /// Compensating operation(s) were queued for this member.
    Compensating,
    /// Member was not undoable; typed reason.
    Skipped { reason: GroupUndoSkipReason },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemberUndoResult {
    pub ordinal: u32,
    pub conversation: ConversationRef,
    pub decision: GroupMemberUndoDecision,
    /// Compensating operation ids in queue order; empty for
    /// `cancelled`/`skipped` members.
    pub operation_ids: Vec<String>,
}

/// Durable result of a committed `undo_operation_group`. Aggregate counts are
/// derived from `members`; accepted is not succeeded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GroupUndoReceipt {
    pub group_id: String,
    pub request_id: String,
    pub accepted_at: String,
    /// One entry per receipt member, in persisted member order.
    pub members: Vec<GroupMemberUndoResult>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(account: &str, id: &str) -> ConversationRef {
        ConversationRef {
            account_id: account.to_string(),
            conversation_id: id.to_string(),
        }
    }

    /// The wire contract is camelCase fields and snake_case discriminants; the
    /// generated TS and the shell both depend on this exact encoding.
    #[test]
    fn set_archived_group_serializes_camel_case() {
        let command = SetArchivedGroup {
            account_id: "fixture-account".to_string(),
            members: vec![member("fixture-account", "conv-01")],
            archived: true,
            request_id: "group-req-1".to_string(),
        };
        let json = serde_json::to_value(&command).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "accountId": "fixture-account",
                "members": [
                    { "accountId": "fixture-account", "conversationId": "conv-01" }
                ],
                "archived": true,
                "requestId": "group-req-1"
            })
        );
        let roundtrip: SetArchivedGroup = serde_json::from_value(json).unwrap();
        assert_eq!(roundtrip, command);
    }

    #[test]
    fn member_status_and_rejection_discriminants_are_snake_case() {
        for (status, discriminant) in [
            (GroupMemberStatus::Rejected, "rejected"),
            (GroupMemberStatus::Queued, "queued"),
            (GroupMemberStatus::Applying, "applying"),
            (GroupMemberStatus::Confirmed, "confirmed"),
            (GroupMemberStatus::Failed, "failed"),
            (GroupMemberStatus::OutcomeUnknown, "outcome_unknown"),
            (GroupMemberStatus::Cancelled, "cancelled"),
        ] {
            assert_eq!(
                serde_json::to_value(status).unwrap(),
                serde_json::json!(discriminant)
            );
        }
        assert_eq!(
            serde_json::to_value(GroupMemberRejection::TargetBoundExceeded).unwrap(),
            serde_json::json!("target_bound_exceeded")
        );
        assert_eq!(
            serde_json::to_value(GroupUndoSkipReason::AcceptanceRejected).unwrap(),
            serde_json::json!("acceptance_rejected")
        );
    }

    #[test]
    fn undo_decision_is_kind_tagged_and_receipt_roundtrips() {
        let receipt = GroupUndoReceipt {
            group_id: "group-1".to_string(),
            request_id: "undo-req-1".to_string(),
            accepted_at: "2026-01-01T00:00:00Z".to_string(),
            members: vec![
                GroupMemberUndoResult {
                    ordinal: 0,
                    conversation: member("fixture-account", "conv-01"),
                    decision: GroupMemberUndoDecision::Cancelled,
                    operation_ids: vec![],
                },
                GroupMemberUndoResult {
                    ordinal: 1,
                    conversation: member("fixture-account", "conv-02"),
                    decision: GroupMemberUndoDecision::Skipped {
                        reason: GroupUndoSkipReason::OutcomeUnknown,
                    },
                    operation_ids: vec![],
                },
                GroupMemberUndoResult {
                    ordinal: 2,
                    conversation: member("fixture-account", "conv-03"),
                    decision: GroupMemberUndoDecision::Compensating,
                    operation_ids: vec!["op-9".to_string()],
                },
            ],
        };
        let json = serde_json::to_value(&receipt).unwrap();
        assert_eq!(
            json["members"][1]["decision"],
            serde_json::json!({ "kind": "skipped", "reason": "outcome_unknown" })
        );
        assert_eq!(
            json["members"][0]["decision"],
            serde_json::json!({ "kind": "cancelled" })
        );
        assert_eq!(
            json["members"][2]["operationIds"],
            serde_json::json!(["op-9"])
        );
        let roundtrip: GroupUndoReceipt = serde_json::from_value(json).unwrap();
        assert_eq!(roundtrip, receipt);
    }

    #[test]
    fn receipt_omits_absent_requested_values_and_group_status_roundtrips() {
        let receipt = OperationGroupReceipt {
            group_id: "group-1".to_string(),
            request_id: "group-req-1".to_string(),
            account_id: "fixture-account".to_string(),
            kind: MailboxOperationKind::Archive,
            requested_archived: Some(true),
            requested_read: None,
            accepted_at: "2026-01-01T00:00:00Z".to_string(),
            members: vec![GroupMemberReceipt {
                ordinal: 0,
                conversation: member("fixture-account", "conv-01"),
                operation_id: Some("op-1".to_string()),
                rejection: None,
            }],
        };
        let json = serde_json::to_value(&receipt).unwrap();
        assert!(json.get("requestedArchived").is_some());
        assert!(json.get("requestedRead").is_none());
        let status = OperationGroupStatus {
            group: receipt,
            members: vec![GroupMemberStatusView {
                ordinal: 0,
                conversation: member("fixture-account", "conv-01"),
                operation_id: Some("op-1".to_string()),
                status: GroupMemberStatus::Queued,
                failure: None,
                rejection: None,
            }],
            undo: GroupUndoAvailability {
                available: true,
                reason: None,
                undoable_until: Some("2026-01-01T00:00:10Z".to_string()),
            },
        };
        let status_json = serde_json::to_value(&status).unwrap();
        assert_eq!(status_json["undo"]["available"], serde_json::json!(true));
        assert_eq!(
            status_json["undo"]["undoableUntil"],
            serde_json::json!("2026-01-01T00:00:10Z")
        );
        let roundtrip: OperationGroupStatus = serde_json::from_value(status_json).unwrap();
        assert_eq!(roundtrip, status);
    }

    #[test]
    fn group_member_bound_is_the_approved_product_bound() {
        assert_eq!(OPERATION_GROUP_MIN_MEMBERS, 1);
        assert_eq!(OPERATION_GROUP_MAX_MEMBERS, 100);
    }
}
