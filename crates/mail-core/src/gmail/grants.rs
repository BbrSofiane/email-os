//! Gmail scope coverage and interactive grant outcomes.
use super::auth::{GMAIL_MODIFY_SCOPE, GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE};
use super::types::GmailProfile;

/// Gmail grants and their verified scope coverage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GmailGrant {
    Readonly,
    Modify,
    Send,
}

impl GmailGrant {
    pub fn requested_scope(self) -> &'static str {
        match self {
            Self::Readonly => GMAIL_READONLY_SCOPE,
            Self::Modify => GMAIL_MODIFY_SCOPE,
            Self::Send => GMAIL_SEND_SCOPE,
        }
    }

    pub fn covered_by(self, granted: &[String]) -> bool {
        granted.iter().any(|scope| {
            scope == self.requested_scope()
                || (matches!(self, Self::Readonly | Self::Send) && scope == GMAIL_MODIFY_SCOPE)
        })
    }
}

pub enum GrantOutcome {
    AlreadyCovered,
    Granted(GmailProfile),
}

pub(crate) fn parse_scopes(scope: &str) -> Vec<String> {
    scope.split_ascii_whitespace().map(str::to_string).collect()
}

pub(crate) fn merge_scopes(mut scopes: Vec<String>, additional: &[String]) -> Vec<String> {
    for scope in additional {
        if !scopes.contains(scope) {
            scopes.push(scope.clone());
        }
    }
    scopes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_is_covered_by_send_or_modify_only() {
        assert!(GmailGrant::Send.covered_by(&parse_scopes(GMAIL_SEND_SCOPE)));
        assert!(GmailGrant::Send.covered_by(&parse_scopes(GMAIL_MODIFY_SCOPE)));
        assert!(!GmailGrant::Send.covered_by(&parse_scopes(GMAIL_READONLY_SCOPE)));
    }

    #[test]
    fn legacy_bundle_effective_scopes() {
        let bundle: crate::gmail::secrets::TokenBundle = serde_json::from_str(
            r#"{"accessToken":"token","refreshToken":null,"expiresAtEpochMs":0,"accountId":null,"email":null,"gmailModifyGranted":true}"#,
        ).unwrap();
        let scopes = bundle.effective_scopes();
        assert!(GmailGrant::Readonly.covered_by(&scopes));
        assert!(GmailGrant::Modify.covered_by(&scopes));
    }

    #[test]
    fn scope_coverage_and_merge() {
        let scopes = merge_scopes(
            parse_scopes(GMAIL_READONLY_SCOPE),
            &parse_scopes(GMAIL_MODIFY_SCOPE),
        );
        assert!(GmailGrant::Readonly.covered_by(&scopes));
        assert!(GmailGrant::Modify.covered_by(&scopes));
        assert!(!GmailGrant::Modify.covered_by(&parse_scopes("unknown")));
    }
}
