//! UX-05 durable operation-group wire DTOs and shared acceptance/validation
//! rules (docs/ux-05-safe-bulk-processing.md §4). Naming and encoding follow
//! `crate::dto`: camelCase JSON fields, snake_case discriminants, ISO-8601 UTC
//! timestamps, `null`/absent optionals.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::dto::{ConversationRef, MailboxOperationKind, OperationFailure, UndoUnavailableReason};
use crate::error::MailError;
use std::collections::HashSet;

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

/// Committed group plus current member statuses, Undo availability, and the
/// persisted group Undo attempt (if any). `undoReceipt` is additive
/// (docs/ux-05-safe-bulk-processing.md §4.2/§5): a restart or a lost group-Undo
/// response must still expose the committed per-member decisions and the
/// current compensation outcomes without the frontend keeping any state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OperationGroupStatus {
    /// Immutable acceptance receipt, unchanged since commit.
    pub group: OperationGroupReceipt,
    /// One entry per receipt member, in persisted member order.
    pub members: Vec<GroupMemberStatusView>,
    pub undo: GroupUndoAvailability,
    /// The group's single persisted Undo attempt with CURRENT compensation
    /// outcomes; absent until a group Undo has been accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub undo_receipt: Option<GroupUndoRecord>,
}

/// Durable record of the one accepted group-Undo attempt, rebuilt from the
/// persisted member decisions plus the live compensation rows. Aggregate
/// counts stay derived from members; compensations are distinct from the
/// original execution statuses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GroupUndoRecord {
    /// Request id of the accepted `undo_operation_group` attempt.
    pub request_id: String,
    pub accepted_at: String,
    /// One entry per receipt member, in persisted member order.
    pub members: Vec<GroupMemberUndoStatus>,
}

/// Persisted Undo decision for one member plus the current outcome of each
/// compensation operation it staged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemberUndoStatus {
    pub ordinal: u32,
    pub decision: GroupMemberUndoDecision,
    /// Current status of each compensating operation in queue order; empty
    /// for `cancelled`/`skipped` members. Distinct from the original child
    /// execution status in `OperationGroupStatus.members`.
    pub compensations: Vec<GroupCompensationStatus>,
}

/// Live outcome of one compensation operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GroupCompensationStatus {
    pub operation_id: String,
    pub status: crate::dto::OperationStatus,
    pub failure: Option<OperationFailure>,
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
    /// Immutable member manifest in persisted ordinal order; rejected
    /// members keep their place in the group they were submitted with.
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

/// Structural validation shared by both stores (§4.1): 1–100 unique member
/// refs, every one carrying the command's owning account. Duplicates,
/// cross-account members and bound violations reject the whole request.
pub(crate) fn validate_group_members(
    account_id: &str,
    members: &[ConversationRef],
) -> Result<(), MailError> {
    if members.len() < OPERATION_GROUP_MIN_MEMBERS || members.len() > OPERATION_GROUP_MAX_MEMBERS {
        return Err(invalid_members());
    }
    let mut seen = HashSet::<&str>::new();
    for member in members {
        if member.account_id != account_id || member.conversation_id.trim().is_empty() {
            return Err(invalid_members());
        }
        if !seen.insert(member.conversation_id.as_str()) {
            return Err(invalid_members());
        }
    }
    Ok(())
}

/// Group request IDs follow the existing request-ID rules.
pub(crate) fn validate_group_request_id(request_id: &str) -> Result<(), MailError> {
    if request_id.trim().is_empty() || request_id.len() > 200 {
        return Err(MailError::InvalidRequest {
            field: "requestId".to_string(),
        });
    }
    Ok(())
}

/// Canonical fingerprint input (§4.1): the sorted member identities. Manifest
/// order is presentation, not identity, so a reordered replay of the same
/// request returns the original receipt and original persisted ordering.
pub(crate) fn canonical_member_ids(members: &[ConversationRef]) -> Vec<&str> {
    let mut ids: Vec<&str> = members.iter().map(|m| m.conversation_id.as_str()).collect();
    ids.sort_unstable();
    ids
}

/// List pages use the shared bounded-limit convention (1–100).
pub(crate) fn validate_group_page_limit(limit: u32) -> Result<(), MailError> {
    if !(1..=100).contains(&limit) {
        return Err(MailError::InvalidRequest {
            field: "limit".to_string(),
        });
    }
    Ok(())
}

/// Opaque, account-bound, versioned group-page cursor.
pub(crate) fn encode_group_cursor(account_id: &str, group_seq: i64) -> String {
    format!(
        "op-groups-v1:{}",
        serde_json::json!([account_id, group_seq])
    )
}

pub(crate) fn decode_group_cursor(account_id: &str, cursor: &str) -> Result<i64, MailError> {
    if cursor.len() > 8192 {
        return Err(invalid_cursor());
    }
    let encoded = cursor
        .strip_prefix("op-groups-v1:")
        .ok_or_else(invalid_cursor)?;
    let (owner, seq): (String, i64) =
        serde_json::from_str(encoded).map_err(|_| invalid_cursor())?;
    if owner != account_id {
        return Err(invalid_cursor());
    }
    Ok(seq)
}

fn invalid_cursor() -> MailError {
    MailError::InvalidRequest {
        field: "cursor".to_string(),
    }
}

fn invalid_members() -> MailError {
    MailError::InvalidRequest {
        field: "members".to_string(),
    }
}

pub(crate) fn rejection_name(rejection: GroupMemberRejection) -> &'static str {
    match rejection {
        GroupMemberRejection::ConversationMissing => "conversation_missing",
        GroupMemberRejection::TargetBoundExceeded => "target_bound_exceeded",
    }
}

pub(crate) fn rejection_from_name(name: &str) -> Option<GroupMemberRejection> {
    match name {
        "conversation_missing" => Some(GroupMemberRejection::ConversationMissing),
        "target_bound_exceeded" => Some(GroupMemberRejection::TargetBoundExceeded),
        _ => None,
    }
}

pub(crate) fn skip_reason_name(reason: GroupUndoSkipReason) -> &'static str {
    match reason {
        GroupUndoSkipReason::AcceptanceRejected => "acceptance_rejected",
        GroupUndoSkipReason::Failed => "failed",
        GroupUndoSkipReason::OutcomeUnknown => "outcome_unknown",
        GroupUndoSkipReason::UnknownPrior => "unknown_prior",
        GroupUndoSkipReason::AlreadyUndone => "already_undone",
    }
}

pub(crate) fn skip_reason_from_name(name: &str) -> Option<GroupUndoSkipReason> {
    match name {
        "acceptance_rejected" => Some(GroupUndoSkipReason::AcceptanceRejected),
        "failed" => Some(GroupUndoSkipReason::Failed),
        "outcome_unknown" => Some(GroupUndoSkipReason::OutcomeUnknown),
        "unknown_prior" => Some(GroupUndoSkipReason::UnknownPrior),
        "already_undone" => Some(GroupUndoSkipReason::AlreadyUndone),
        _ => None,
    }
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
            undo_receipt: Some(GroupUndoRecord {
                request_id: "undo-req-1".to_string(),
                accepted_at: "2026-01-01T00:00:02Z".to_string(),
                members: vec![GroupMemberUndoStatus {
                    ordinal: 0,
                    decision: GroupMemberUndoDecision::Compensating,
                    compensations: vec![GroupCompensationStatus {
                        operation_id: "op-9".to_string(),
                        status: crate::dto::OperationStatus::Confirmed,
                        failure: None,
                    }],
                }],
            }),
        };
        let status_json = serde_json::to_value(&status).unwrap();
        assert_eq!(status_json["undo"]["available"], serde_json::json!(true));
        assert_eq!(
            status_json["undo"]["undoableUntil"],
            serde_json::json!("2026-01-01T00:00:10Z")
        );
        assert_eq!(
            status_json["undoReceipt"]["members"][0]["compensations"][0]["status"],
            serde_json::json!("confirmed")
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
