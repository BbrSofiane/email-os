//! Construction of a frozen, plain-text send payload.
use std::collections::HashSet;

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::DateTime;

use crate::{
    drafts::{
        store::{validate_content, validate_mailbox, validate_message_id},
        DraftContent, DraftReplyLink,
    },
    error::MailError,
};

pub struct SendMime {
    pub raw: String,
    pub thread_id: Option<String>,
}

fn invalid(field: &str) -> MailError {
    MailError::InvalidRequest {
        field: field.to_string(),
    }
}

fn header_safe(value: &str) -> bool {
    !value.chars().any(char::is_control)
}

fn recipients(
    value: &str,
    field: &str,
    seen: &mut HashSet<String>,
) -> Result<Vec<String>, MailError> {
    if value.trim().is_empty() {
        return Ok(Vec::new());
    }
    value
        .split(',')
        .map(|part| {
            let address = part.trim();
            let address = validate_mailbox(address).ok_or_else(|| invalid(field))?;
            if !seen.insert(address.to_ascii_lowercase()) || seen.len() > 20 {
                return Err(invalid(field));
            }
            Ok(address)
        })
        .collect()
}

fn append_list(out: &mut String, name: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }
    out.push_str(name);
    out.push(':');
    for (i, value) in values.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("\r\n ");
        out.push_str(value);
    }
    out.push_str("\r\n");
}

fn normalized_subject(subject: &str) -> &str {
    let subject = subject.trim();
    if subject
        .get(..3)
        .is_some_and(|p| p.eq_ignore_ascii_case("re:"))
    {
        subject[3..].trim()
    } else {
        subject
    }
}

/// The caller supplies an already verified primary mailbox and exact source subject.
/// `date` and `message_id` are fixed once for the lifetime of a send intent.
pub fn build_send_mime(
    content: &DraftContent,
    from: &str,
    reply: Option<(&DraftReplyLink, &str)>,
    message_id: &str,
    date: &str,
) -> Result<SendMime, MailError> {
    validate_content(content)?;
    let from = validate_mailbox(from).ok_or_else(|| invalid("from"))?;
    if !header_safe(&content.to) || !header_safe(&content.cc) || !header_safe(&content.subject) {
        return Err(invalid("headers"));
    }
    let mut seen = HashSet::new();
    let to = recipients(&content.to, "to", &mut seen)?;
    let cc = recipients(&content.cc, "cc", &mut seen)?;
    if to.is_empty() {
        return Err(invalid("to"));
    }
    if validate_message_id(message_id).is_none() || message_id.len() > 980 {
        return Err(invalid("messageId"));
    }
    if date.len() > 990 || !header_safe(date) || DateTime::parse_from_rfc2822(date).is_err() {
        return Err(invalid("date"));
    }
    let mut out = format!("From: {from}\r\n");
    append_list(&mut out, "To", &to);
    append_list(&mut out, "Cc", &cc);
    out.push_str("Subject:");
    // Encoded words are split on UTF-8 boundaries, each within RFC 2047's 75-octet limit.
    let mut chunk = String::new();
    let mut first = true;
    for ch in content.subject.chars() {
        if chunk.len() + ch.len_utf8() > 42 {
            out.push_str(&format!(
                "{}=?UTF-8?B?{}?=",
                if first { " " } else { "\r\n " },
                STANDARD.encode(chunk.as_bytes())
            ));
            first = false;
            chunk.clear();
        }
        chunk.push(ch);
    }
    if !chunk.is_empty() {
        out.push_str(&format!(
            "{}=?UTF-8?B?{}?=",
            if first { " " } else { "\r\n " },
            STANDARD.encode(chunk.as_bytes())
        ));
    }
    out.push_str(&format!("\r\nDate: {date}\r\nMessage-ID: {message_id}\r\n"));
    let mut thread_id = None;
    if let Some((link, source_subject)) = reply {
        if !header_safe(source_subject)
            || link.conversation.conversation_id.is_empty()
            || !header_safe(&link.conversation.conversation_id)
            || validate_message_id(&link.message_id).is_none()
            || link.message_id.len() > 980
            || link.references.is_empty()
            || link.references.len() > 100
            || link.references.iter().map(|r| r.len() + 1).sum::<usize>() > 16 * 1024
            || link.references.last() != Some(&link.message_id)
            || link
                .references
                .iter()
                .any(|r| validate_message_id(r).is_none() || r.len() > 980)
        {
            return Err(MailError::ReplyUnavailable);
        }
        out.push_str(&format!("In-Reply-To: {}\r\n", link.message_id));
        append_list_references(&mut out, &link.references);
        if normalized_subject(&content.subject) == normalized_subject(source_subject) {
            thread_id = Some(link.conversation.conversation_id.clone());
        }
    }
    out.push_str("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n");
    let body = content
        .body_text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\r\n");
    let encoded = STANDARD.encode(body.as_bytes());
    for line in encoded.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(line).expect("base64 is ASCII"));
        out.push_str("\r\n");
    }
    Ok(SendMime {
        raw: URL_SAFE_NO_PAD.encode(out.as_bytes()),
        thread_id,
    })
}

fn append_list_references(out: &mut String, values: &[String]) {
    out.push_str("References:");
    for value in values {
        out.push_str("\r\n ");
        out.push_str(value);
    }
    out.push_str("\r\n");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::ConversationRef;
    use mailparse::MailHeaderMap;

    fn content() -> DraftContent {
        DraftContent {
            to: "reply@example.org".into(),
            cc: "cc@example.org".into(),
            subject: "Re: こんにちは ".repeat(30),
            body_text: "héllo\n世界\rnext".into(),
        }
    }
    fn build(
        c: &DraftContent,
        reply: Option<(&DraftReplyLink, &str)>,
    ) -> Result<SendMime, MailError> {
        build_send_mime(
            c,
            "sender@example.org",
            reply,
            "<generated@example.org>",
            "Sat, 21 Nov 2026 12:00:00 +0000",
        )
    }
    #[test]
    fn send_mime_round_trip_and_folding() {
        let c = content();
        let result = build(&c, None).unwrap();
        let bytes = URL_SAFE_NO_PAD.decode(result.raw).unwrap();
        assert!(bytes.split(|b| *b == b'\n').all(|line| line.len() <= 999));
        let parsed = mailparse::parse_mail(&bytes).unwrap();
        assert_eq!(
            parsed.headers.get_first_value("Subject").unwrap(),
            c.subject
        );
        assert!(parsed
            .headers
            .get_first_value("Cc")
            .unwrap()
            .contains("cc@example.org"));
        assert_eq!(parsed.get_body().unwrap(), "héllo\r\n世界\r\nnext");
    }
    #[test]
    fn send_mime_reply_and_changed_subject() {
        let link = DraftReplyLink {
            conversation: ConversationRef {
                account_id: "account".into(),
                conversation_id: "thread".into(),
            },
            source_message_id: "source".into(),
            message_id: "<source@example.org>".into(),
            references: vec!["<source@example.org>".into()],
            source_subject: None,
        };
        let mut c = content();
        c.subject = "Re: Hello".into();
        assert_eq!(
            build(&c, Some((&link, "Hello")))
                .unwrap()
                .thread_id
                .as_deref(),
            Some("thread")
        );
        c.subject = "Changed".into();
        let result = build(&c, Some((&link, "Hello"))).unwrap();
        assert!(result.thread_id.is_none());
        let bytes = URL_SAFE_NO_PAD.decode(result.raw).unwrap();
        let parsed = mailparse::parse_mail(&bytes).unwrap();
        assert_eq!(
            parsed.headers.get_first_value("In-Reply-To").unwrap(),
            link.message_id
        );
        assert!(parsed
            .headers
            .get_first_value("References")
            .unwrap()
            .contains(&link.message_id));
    }
    #[test]
    fn send_mime_rejects_invalid_inputs() {
        let mut c = content();
        c.to = "a@example.org\r\nBcc: evil@example.org".into();
        assert!(build(&c, None).is_err());
        c.to = "cc@example.org".into();
        assert!(build(&c, None).is_err());
        c.to.clear();
        assert!(build(&c, None).is_err());
        c.to = "a@example.org".into();
        c.body_text = "x".repeat(crate::drafts::types::MAX_BODY_BYTES + 1);
        assert!(build(&c, None).is_err());
    }
}
