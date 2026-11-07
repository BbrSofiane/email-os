//! UX-09 increment A: bounded, explicitly read-only destination snapshots.
use crate::dto::Conversation;
use crate::MailError;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDestination {
    pub id: String,
    pub name: String,
    pub user_label: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DestinationCatalog {
    pub account_id: String,
    pub destinations: Vec<ProviderDestination>,
    pub fetched_at: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DestinationRequest {
    pub account_id: String,
    pub destination_id: String,
    pub cursor: Option<String>,
    pub cached: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DestinationPage {
    pub account_id: String,
    pub destination_id: String,
    pub conversations: Vec<Conversation>,
    pub next_cursor: Option<String>,
    pub fetched_at: String,
}

pub(crate) fn invalid() -> MailError {
    MailError::InvalidRequest {
        field: "destination".into(),
    }
}
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}
pub(crate) fn validate_catalog(labels: &[ProviderDestination]) -> Result<(), MailError> {
    let mut ids = std::collections::HashSet::new();
    if labels.len() > 10_000
        || labels.iter().any(|l| {
            !valid_id(&l.id)
                || l.name.is_empty()
                || l.name.len() > 1024
                || !ids.insert(&l.id)
                || (!l.user_label
                    && !matches!(
                        l.id.as_str(),
                        "SENT" | "DRAFT" | "ALL_MAIL" | "SPAM" | "TRASH"
                    ))
        })
    {
        return Err(MailError::InvalidProviderResponse);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::store::GmailStore;
    use crate::gmail::types::GmailProfile;
    use std::sync::Arc;

    #[test]
    fn catalog_duplicates_bounds_and_unsupported_systems_fail_closed() {
        let label = ProviderDestination {
            id: "Label_1".into(),
            name: "Research".into(),
            user_label: true,
        };
        assert!(validate_catalog(std::slice::from_ref(&label)).is_ok());
        assert!(validate_catalog(&[label.clone(), label.clone()]).is_err());
        assert!(validate_catalog(&vec![label.clone(); 10_001]).is_err());
        assert!(validate_catalog(&[ProviderDestination {
            name: "x".repeat(1025),
            ..label.clone()
        }])
        .is_err());
        assert!(validate_catalog(&[ProviderDestination {
            id: "INBOX".into(),
            user_label: false,
            ..label
        }])
        .is_err());
        assert!(!valid_id(""));
        assert!(!valid_id("bad\nlabel"));
    }

    #[test]
    fn destination_storage_is_bounded_and_generation_fenced_without_touching_checkpoints() {
        let path = std::env::temp_dir().join(format!(
            "ux09-store-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let store = GmailStore::open(&path, Arc::new(crate::clock::SystemClock)).unwrap();
        let generation = store.generation().unwrap();
        let profile = GmailProfile {
            account_id: "a".into(),
            email_address: "a@example.test".into(),
            history_id: "baseline".into(),
        };
        store.begin_account(&profile, generation).unwrap();
        let discovery = store.discovery().unwrap();
        store
            .save_destination_snapshot("a", "", "catalog", generation)
            .unwrap();
        for n in 0..25 {
            store
                .save_destination_snapshot("a", &format!("Label_{n}"), "page", generation)
                .unwrap();
        }
        assert_eq!(store.destination_snapshot("a", "Label_0").unwrap(), None);
        assert_eq!(
            store
                .destination_snapshot("a", "Label_24")
                .unwrap()
                .as_deref(),
            Some("page")
        );
        assert_eq!(
            store.destination_snapshot("a", "").unwrap().as_deref(),
            Some("catalog")
        );
        assert_eq!(store.discovery().unwrap(), discovery);
        store.advance_generation().unwrap();
        assert_eq!(
            store.save_destination_snapshot("a", "Label_24", "late", generation),
            Err(MailError::NotFound)
        );
        assert_eq!(
            store
                .destination_snapshot("a", "Label_24")
                .unwrap()
                .as_deref(),
            Some("page")
        );
        store.clear_account().unwrap();
        store
            .begin_account(&profile, store.generation().unwrap())
            .unwrap();
        assert_eq!(store.destination_snapshot("a", "Label_24").unwrap(), None);
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }
}
