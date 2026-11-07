//! UX-07: one deliberately small grammar and evaluator for every search mode.
use crate::{
    dto::{Conversation, ConversationSummary},
    MailError,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub account_id: String,
    pub query: String,
    pub cursor: Option<String>,
    /// Explicit cached search; network failures never silently become empty results.
    pub cached_only: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SearchCoverage {
    CachedIncomplete,
    ProviderCandidates,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub conversations: Vec<ConversationSummary>,
    pub next_cursor: Option<String>,
    pub coverage: SearchCoverage,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Term {
    pub field: String,
    pub value: String,
    pub excluded: bool,
}
/// OR of AND groups; adjacent terms mean AND. No hidden provider operators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query(pub Vec<Vec<Term>>);
fn invalid() -> MailError {
    MailError::InvalidRequest {
        field: "searchQuery".into(),
    }
}
pub fn parse(input: &str) -> Result<Query, MailError> {
    if input.trim().is_empty() || input.len() > 512 {
        return Err(invalid());
    }
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quoted = false;
    for c in input.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                token.push(c);
            }
            '(' | ')' | '{' | '}' | '\\' if !quoted => return Err(invalid()),
            c if c.is_control() => return Err(invalid()),
            c if c.is_whitespace() && !quoted => {
                if !token.is_empty() {
                    tokens.push(std::mem::take(&mut token));
                }
            }
            _ => token.push(c),
        }
    }
    if quoted {
        return Err(invalid());
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    let mut groups = vec![vec![]];
    let mut needs_term = true;
    for raw in tokens {
        if raw == "OR" || raw == "AND" {
            if needs_term {
                return Err(invalid());
            }
            if raw == "OR" {
                groups.push(vec![]);
            }
            needs_term = true;
            continue;
        }
        let excluded = raw.starts_with('-');
        let raw = raw.strip_prefix('-').unwrap_or(&raw);
        let (field, value) = if raw.starts_with('"') {
            ("text", raw)
        } else {
            raw.split_once(':').unwrap_or(("text", raw))
        };
        if !["text", "from", "to", "subject"].contains(&field) {
            return Err(invalid());
        }
        let value = if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
            &value[1..value.len() - 1]
        } else if value.contains('"') {
            return Err(invalid());
        } else {
            value
        };
        if value.is_empty() {
            return Err(invalid());
        }
        groups.last_mut().unwrap().push(Term {
            field: field.into(),
            value: value.to_lowercase(),
            excluded,
        });
        needs_term = false;
    }
    if needs_term {
        return Err(invalid());
    }
    Ok(Query(groups))
}
impl Query {
    pub fn matches(&self, c: &Conversation) -> bool {
        let address = |a: &crate::dto::Address| {
            format!("{} {}", a.display_name.as_deref().unwrap_or(""), a.mailbox)
        };
        let from = c
            .messages
            .iter()
            .map(|m| address(&m.from))
            .collect::<Vec<_>>()
            .join("\n")
            .to_lowercase();
        let to = c
            .messages
            .iter()
            .flat_map(|m| m.to.iter().map(&address))
            .collect::<Vec<_>>()
            .join("\n")
            .to_lowercase();
        let subject = c.subject.to_lowercase();
        let text = format!(
            "{}\n{}\n{}\n{}",
            subject,
            from,
            to,
            c.messages
                .iter()
                .map(|m| m.body_text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        )
        .to_lowercase();
        self.0.iter().any(|group| {
            group.iter().all(|term| {
                let hay = match term.field.as_str() {
                    "from" => &from,
                    "to" => &to,
                    "subject" => &subject,
                    _ => &text,
                };
                hay.contains(&term.value) != term.excluded
            })
        })
    }
}
pub fn summary(c: Conversation) -> ConversationSummary {
    ConversationSummary {
        stars: c.stars,
        conversation_ref: c.conversation_ref,
        subject: c.subject,
        participants: c.messages.iter().map(|m| m.from.clone()).collect(),
        primary_correspondent: c.messages.last().map(|m| m.from.clone()),
        preview: c
            .messages
            .last()
            .map(|m| m.body_text.chars().take(180).collect())
            .unwrap_or_default(),
        last_message_at: c
            .messages
            .last()
            .map(|m| m.sent_at.clone())
            .unwrap_or_default(),
        is_read: c.is_read,
        pending_operation_id: c.pending_operation_id,
    }
}
pub fn cached_page(
    request: &SearchRequest,
    rows: Vec<Conversation>,
) -> Result<SearchPage, MailError> {
    let query = parse(&request.query)?;
    if request.cursor.as_ref().is_some_and(|c| c.len() > 8192) {
        return Err(MailError::InvalidRequest {
            field: "searchCursor".into(),
        });
    }
    let offset = match &request.cursor {
        None => 0,
        Some(c) => serde_json::from_str::<(String, String, usize)>(c)
            .ok()
            .filter(|(a, q, _)| a == &request.account_id && q == &request.query)
            .map(|(_, _, n)| n)
            .ok_or_else(|| MailError::InvalidRequest {
                field: "searchCursor".into(),
            })?,
    };
    let mut rows: Vec<_> = rows
        .into_iter()
        .filter(|c| query.matches(c))
        .map(summary)
        .collect();
    rows.sort_by(|a, b| {
        b.last_message_at.cmp(&a.last_message_at).then(
            a.conversation_ref
                .conversation_id
                .cmp(&b.conversation_ref.conversation_id),
        )
    });
    let more = rows.len() > offset.saturating_add(20);
    Ok(SearchPage {
        conversations: rows.into_iter().skip(offset).take(20).collect(),
        next_cursor: more.then(|| {
            serde_json::to_string(&(&request.account_id, &request.query, offset + 20)).unwrap()
        }),
        coverage: SearchCoverage::CachedIncomplete,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grammar() {
        assert_eq!(
            parse("from:alice subject:\"old mail\" OR to:bob -invoice")
                .unwrap()
                .0
                .len(),
            2
        );
        for q in [
            "",
            "OR a",
            "a OR",
            "a AND OR b",
            "label:work",
            "cc:x",
            "after:2020",
            "(a)",
            "\"oops",
            "subject:",
        ] {
            assert!(parse(q).is_err(), "{q}");
        }
    }
}
