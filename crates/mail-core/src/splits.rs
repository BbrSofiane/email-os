//! UX-06: one account-scoped local view. No provider mutations or classification.
use crate::MailError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SplitCriterion {
    Sender,
    Domain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SavedSplit {
    pub name: String,
    pub criterion: SplitCriterion,
    pub value: String,
    pub enabled: bool,
    pub hide_when_empty: bool,
}

impl SavedSplit {
    pub fn normalized(&self) -> Result<Self, MailError> {
        let mut value = self.clone();
        value.name = value.name.trim().to_string();
        value.value = value.value.trim().to_ascii_lowercase();
        let domain_valid = |s: &str| {
            !s.is_empty()
                && s.len() <= 253
                && s.split('.').all(|part| {
                    !part.is_empty()
                        && part.len() <= 63
                        && !part.starts_with('-')
                        && !part.ends_with('-')
                        && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
        };
        let valid = match value.criterion {
            SplitCriterion::Domain => domain_valid(&value.value),
            SplitCriterion::Sender => value.value.split_once('@').is_some_and(|(local, domain)| {
                !local.is_empty()
                    && local.len() <= 64
                    && !local.contains('@')
                    && local
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".!#$%&'*+-/=?^_`{|}~".contains(&b))
                    && domain_valid(domain)
            }),
        };
        if value.name.is_empty()
            || value.name.chars().count() > 40
            || value.name.chars().any(char::is_control)
            || !valid
        {
            return Err(MailError::InvalidRequest {
                field: "savedSplit".into(),
            });
        }
        Ok(value)
    }
}

pub(crate) fn get(conn: &Connection, account: &str) -> Result<Option<SavedSplit>, MailError> {
    let json: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [format!("saved_split:{account}")],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| MailError::StorageUnavailable)?;
    json.map(|json| serde_json::from_str(&json).map_err(|_| MailError::StorageUnavailable))
        .transpose()
}

pub(crate) fn save(
    conn: &Connection,
    account: &str,
    split: &SavedSplit,
) -> Result<SavedSplit, MailError> {
    let split = split.normalized()?;
    let json = serde_json::to_string(&split).map_err(|_| MailError::StorageUnavailable)?;
    conn.execute("INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![format!("saved_split:{account}"), json]).map_err(|_| MailError::StorageUnavailable)?;
    Ok(split)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_normalizes_and_scopes_one_definition() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .unwrap();
        let mut split = SavedSplit {
            name: " Clients ".into(),
            criterion: SplitCriterion::Domain,
            value: " EXAMPLE.COM ".into(),
            enabled: true,
            hide_when_empty: true,
        };
        assert_eq!(save(&conn, "a", &split).unwrap().value, "example.com");
        assert_eq!(get(&conn, "a").unwrap().unwrap().name, "Clients");
        assert_eq!(get(&conn, "b").unwrap(), None);
        for invalid in [
            "@example.com",
            "example.com/path",
            "-example.com",
            "a..com",
            "a b.com",
        ] {
            split.value = invalid.into();
            assert!(split.normalized().is_err());
        }
        split.criterion = SplitCriterion::Sender;
        split.value = "Alice@Example.COM".into();
        assert_eq!(split.normalized().unwrap().value, "alice@example.com");
        split.value = "a@b@example.com".into();
        assert!(split.normalized().is_err());
    }
}
