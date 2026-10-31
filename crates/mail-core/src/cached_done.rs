//! Shared validation and keyset paging for local Done. Cursors are opaque to callers,
//! account-bound and versioned; they are positions, not authorization or snapshots.
use crate::dto::{CachedDoneCoverage, CachedDoneRequest, CachedDoneSnapshot, ConversationSummary};
use crate::MailError;

pub(crate) type Position = (String, String);

pub(crate) fn validate(
    request: &CachedDoneRequest,
    account: &str,
) -> Result<Option<Position>, MailError> {
    if request.account_id != account {
        return Err(MailError::NotFound);
    }
    if !(1..=100).contains(&request.limit) {
        return Err(invalid("limit"));
    }
    request
        .cursor
        .as_ref()
        .map(|cursor| {
            if cursor.len() > 8192 {
                return Err(invalid("cursor"));
            }
            let encoded = cursor
                .strip_prefix("cached-done-v1:")
                .ok_or_else(|| invalid("cursor"))?;
            let (owner, date, id): (String, String, String) =
                serde_json::from_str(encoded).map_err(|_| invalid("cursor"))?;
            if owner != account || date.len() > 128 || id.is_empty() || id.len() > 1024 {
                return Err(invalid("cursor"));
            }
            Ok((date, id))
        })
        .transpose()
}

fn invalid(field: &str) -> MailError {
    MailError::InvalidRequest {
        field: field.into(),
    }
}

pub(crate) fn finish(
    request: &CachedDoneRequest,
    candidates: &[Position],
    conversations: Vec<ConversationSummary>,
    last_synced_at: Option<String>,
) -> CachedDoneSnapshot {
    // Scan at most limit candidates, even if current membership filters every row.
    // A short/empty page may therefore still carry a continuation cursor.
    let next_cursor = if candidates.len() > request.limit as usize {
        let (date, id) = &candidates[request.limit as usize - 1];
        Some(format!(
            "cached-done-v1:{}",
            serde_json::json!([request.account_id, date, id])
        ))
    } else {
        None
    };
    CachedDoneSnapshot {
        conversations,
        next_cursor,
        coverage: CachedDoneCoverage::LocalCache,
        exact_total: None,
        last_synced_at,
    }
}
