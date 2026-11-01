//! UX-08 observed star facts. Unknown labels never imply an unstarred message.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StarState {
    pub starred_messages: u32,
    pub known_messages: u32,
    pub total_messages: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SetStarred {
    pub conversation: crate::dto::ConversationRef,
    pub starred: bool,
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SetStarredGroup {
    pub account_id: String,
    pub members: Vec<crate::dto::ConversationRef>,
    pub starred: bool,
    pub request_id: String,
}

impl StarState {
    pub fn from_facts(facts: impl IntoIterator<Item = Option<bool>>) -> Self {
        let mut state = Self {
            starred_messages: 0,
            known_messages: 0,
            total_messages: 0,
        };
        for fact in facts {
            state.total_messages += 1;
            if let Some(starred) = fact {
                state.known_messages += 1;
                state.starred_messages += u32::from(starred);
            }
        }
        state
    }

    /// Existential membership: a known star suffices even with partial coverage.
    /// Empty/unknown inventory cannot prove absence.
    pub fn is_starred(&self) -> Option<bool> {
        if self.starred_messages > 0 {
            Some(true)
        } else if self.total_messages > 0 && self.known_messages == self.total_messages {
            Some(false)
        } else {
            None
        }
    }
}
