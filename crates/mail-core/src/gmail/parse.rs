use crate::drafts::types::{
    ReplyContext, MAX_REPLY_HEADER_BYTES, MAX_REPLY_REFERENCES, MAX_REPLY_TO_RECIPIENTS,
};
use crate::dto::{Address, Conversation, ConversationRef, Message};
use crate::error::MailError;
use crate::gmail::types::{GmailThread, HistoryPage};
use base64::Engine;
use serde_json::Value;
use std::collections::HashSet;

pub(super) const MAX_PART_BODY_BYTES: usize = 1024 * 1024;
pub(super) const MAX_MESSAGE_TEXT_CHARS: usize = 256 * 1024;
pub(super) const MAX_PAYLOAD_DEPTH: usize = 10;
pub(super) const MAX_HISTORY_RECORDS: usize = 10_000;
pub(super) const MAX_CHANGED_THREAD_IDS: usize = 1_000;
pub(super) const MAX_DELETED_MESSAGE_IDS: usize = 5_000;

pub(super) fn parse_json(body: &str) -> Result<Value, MailError> {
    let value: Value =
        serde_json::from_str(body).map_err(|_| MailError::InvalidProviderResponse)?;
    if !value.is_object() {
        return Err(MailError::InvalidProviderResponse);
    }
    Ok(value)
}

pub(super) fn str_field(json: &Value, key: &str) -> Result<String, MailError> {
    json.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or(MailError::InvalidProviderResponse)
}

pub(super) fn optional_string(json: &Value, key: &str) -> Result<Option<String>, MailError> {
    match json.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        Some(_) => Err(MailError::InvalidProviderResponse),
    }
}

pub(super) fn optional_array<'a>(
    json: &'a Value,
    key: &str,
) -> Result<Option<&'a [Value]>, MailError> {
    match json.get(key) {
        None => Ok(None),
        Some(Value::Array(values)) => Ok(Some(values)),
        Some(_) => Err(MailError::InvalidProviderResponse),
    }
}

fn optional_string_array<'a>(
    json: &'a Value,
    key: &str,
) -> Result<Option<Vec<&'a str>>, MailError> {
    optional_array(json, key)?
        .map(|values| {
            values
                .iter()
                .map(|value| value.as_str().ok_or(MailError::InvalidProviderResponse))
                .collect()
        })
        .transpose()
}

/// Decodes Gmail's base64url payload (with or without padding).
fn b64url_decode(input: &str) -> Result<Vec<u8>, MailError> {
    base64::engine::general_purpose::URL_SAFE
        .decode(input)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(input))
        .map_err(|_| MailError::InvalidProviderResponse)
}

/// Normalizes one `threads.get?format=full` response into a
/// [`GmailThread`]. Only literal `text/plain` parts become bodies; messages
/// without a safe plain-text body, oversized bodies, and undecodable content
/// are disclosed via `unsupported_reason` and `context_complete: false`.
/// Attachment presence is disclosed but never read.
pub(super) fn parse_thread(
    account_id: &str,
    thread_id: &str,
    body: &str,
) -> Result<GmailThread, MailError> {
    let json: Value = parse_json(body)?;
    let history_id = str_field(&json, "historyId")?;
    let messages = json
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(MailError::InvalidProviderResponse)?;
    if messages.is_empty() {
        return Err(MailError::InvalidProviderResponse);
    }
    let mut parsed: Vec<(Message, String)> = Vec::new();
    let mut inbox_message_ids = Vec::new();
    let mut message_ids = Vec::with_capacity(messages.len());
    let mut unread_message_ids = Vec::new();
    let mut star_facts = std::collections::HashMap::new();
    let mut trash_message_ids = Vec::new();
    let mut spam_message_ids = Vec::new();
    let mut no_plain_text = 0usize;
    let mut attachments = false;
    let mut attachment_descriptors = Vec::new();
    let mut omitted_inline_content = false;
    let mut latest_payload: Option<&Value> = None;
    let mut latest_key: Option<(String, String)> = None;
    for message in messages {
        let id = str_field(message, "id")?;
        let key = (message_sent_at(message), id.clone());
        if latest_key.as_ref().is_none_or(|current| key > *current) {
            latest_key = Some(key);
            latest_payload = Some(message);
        }
        let label_facts = optional_string_array(message, "labelIds")?;
        if let Some(labels) = &label_facts {
            star_facts.insert(id.clone(), labels.contains(&"STARRED"));
        }
        let labels = label_facts.unwrap_or_default();
        if labels.contains(&"INBOX") {
            inbox_message_ids.push(id.clone());
        }
        if labels.contains(&"UNREAD") {
            unread_message_ids.push(id.clone());
        }
        if labels.contains(&"TRASH") {
            trash_message_ids.push(id.clone());
        }
        if labels.contains(&"SPAM") {
            spam_message_ids.push(id.clone());
        }
        message_ids.push(id.clone());
        let payload = message
            .get("payload")
            .ok_or(MailError::InvalidProviderResponse)?;
        crate::attachments::descriptors(&id, payload, &mut attachment_descriptors, 0);
        if payload_has_attachment(payload, 0) {
            attachments = true;
        }
        if let Some(plain_part) = find_plain_part(payload, 0) {
            omitted_inline_content |= has_omitted_inline_content(payload, plain_part, 0);
        }
        match parse_message(&id, message) {
            Ok(pair) => parsed.push(pair),
            Err(_) => no_plain_text += 1,
        }
    }
    let subject = messages
        .iter()
        .rev()
        .filter_map(|message| {
            message
                .get("payload")
                .map(|payload| json_header_value(payload, "Subject"))
        })
        .map(|value| decoded_header(&value))
        .find(|value| !value.is_empty())
        .unwrap_or_else(|| pick_subject(&parsed));
    let mut reasons = Vec::new();
    if no_plain_text > 0 {
        reasons.push(format!(
            "{no_plain_text} of {} messages had no safe plain-text body",
            messages.len()
        ));
    }
    if attachments {
        reasons.push("attachments present are not displayed".to_string());
    }
    if omitted_inline_content {
        reasons.push("additional inline MIME content is not displayed".to_string());
    }
    let reply_context = latest_payload.and_then(|message| {
        let source_message_id = message.get("id")?.as_str()?;
        let payload = message.get("payload")?;
        parse_reply_context(payload, source_message_id)
    });
    let conversation = Conversation {
        stars: None,
        conversation_ref: ConversationRef {
            account_id: account_id.to_string(),
            conversation_id: thread_id.to_string(),
        },
        subject,
        messages: parsed.into_iter().map(|(message, _)| message).collect(),
        is_in_inbox: !inbox_message_ids.is_empty(),
        is_read: Some(unread_message_ids.is_empty()),
        context_complete: Some(no_plain_text == 0 && !attachments && !omitted_inline_content),
        unsupported_reason: (!reasons.is_empty()).then(|| reasons.join("; ")),
        retained_snapshot_at: None,
        reply_context,
        pending_operation_id: None,
    };
    let newest_sender = latest_payload
        .and_then(|message| message.get("payload"))
        .and_then(|payload| {
            // Reuse the bounded single-mailbox header parser, not reply eligibility.
            // Absent, malformed, duplicate, or ambiguous From is explicitly unknown.
            let mailbox = parse_single_mailbox_header(payload, "From")?;
            parse_addresses(&json_header_value(payload, "From"))
                .into_iter()
                .find(|address| address.mailbox == mailbox)
        });
    Ok(GmailThread {
        star_facts: Some(star_facts),
        attachments: attachment_descriptors,
        conversation,
        newest_sender,
        inbox_message_ids,
        message_ids: Some(message_ids),
        unread_message_ids: Some(unread_message_ids),
        trash_message_ids: Some(trash_message_ids),
        spam_message_ids: Some(spam_message_ids),
        history_id,
    })
}

fn message_sent_at(message: &Value) -> String {
    message
        .get("internalDate")
        .and_then(Value::as_str)
        .and_then(|ms| ms.parse::<i64>().ok())
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .or_else(|| {
            let date = message
                .get("payload")
                .map(|payload| json_header_value(payload, "Date"))
                .unwrap_or_default();
            (!date.is_empty())
                .then(|| mailparse::dateparse(&date).ok())
                .flatten()
                .and_then(|timestamp| chrono::DateTime::from_timestamp(timestamp, 0))
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        })
        .unwrap_or_default()
}

/// Newest non-empty subject wins; Gmail lists messages oldest first.
fn pick_subject(messages: &[(Message, String)]) -> String {
    messages
        .iter()
        .rev()
        .map(|(_, subject)| subject.as_str())
        .find(|subject| !subject.is_empty())
        .map_or_else(String::new, str::to_string)
}

/// Parses one `format=full` message into the wire DTO. Header facts
/// (From/To/Subject) come from the root payload headers (RFC2047-decoded);
/// the body is the first literal `text/plain` part in the payload tree.
/// Gmail's base64url wrapper is removed once, then its declared charset is decoded
/// strictly without replaying the original MIME transfer-encoding header.
fn parse_message(id: &str, message: &Value) -> Result<(Message, String), String> {
    let payload = message
        .get("payload")
        .ok_or_else(|| "message payload missing".to_string())?;
    let subject = decoded_header(&json_header_value(payload, "Subject"));
    let from = parse_addresses(&json_header_value(payload, "From"))
        .into_iter()
        .next()
        .ok_or_else(|| "missing From address".to_string())?;
    let to = parse_addresses(&json_header_value(payload, "To"));
    let sent_at = message_sent_at(message);
    let part = find_plain_part(payload, 0).ok_or_else(|| "no plain-text body".to_string())?;
    let data = part
        .get("body")
        .and_then(|body| body.get("data"))
        .and_then(Value::as_str)
        .ok_or_else(|| "missing body data".to_string())?;
    let bytes = b64url_decode(data).map_err(|_| "undecodable body data".to_string())?;
    if bytes.len() > MAX_PART_BODY_BYTES {
        return Err("body too large".to_string());
    }
    let raw = part_raw(part, &bytes);
    let parsed = mailparse::parse_mail(&raw).map_err(|_| "unparseable body".to_string())?;
    let decoded_bytes = parsed
        .get_body_raw()
        .map_err(|_| "undecodable body transfer wrapper".to_string())?;
    let charset = charset::Charset::for_label(parsed.ctype.charset.as_bytes())
        .ok_or_else(|| "unsupported body charset".to_string())?;
    let (decoded, _, had_errors) = charset.decode(&decoded_bytes);
    if had_errors {
        return Err("lossy body charset decoding".to_string());
    }
    let mut body_text = decoded.into_owned();
    // Normalize newlines; hostile markup stays literal data for the UI to escape.
    body_text = body_text.replace("\r\n", "\n").replace('\r', "\n");
    if body_text.chars().count() > MAX_MESSAGE_TEXT_CHARS {
        return Err("body too large".to_string());
    }
    Ok((
        Message {
            id: id.to_string(),
            from,
            to,
            sent_at,
            body_text,
            // P5a: the parse already knows per-message attachment presence;
            // persist it with the cached message instead of guessing later.
            has_attachment: Some(payload_has_attachment(payload, 0)),
        },
        subject,
    ))
}

/// Header values are left raw for strict metadata parsing; callers decide
/// whether malformed controls invalidate metadata or are flattened for display.
fn raw_header_values<'a>(payload: &'a Value, name: &str) -> Vec<Option<&'a str>> {
    payload
        .get("headers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|header| {
            header
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
        .map(|header| header.get("value").and_then(Value::as_str))
        .collect()
}

/// First header value with the given name on a Gmail payload, sanitized
/// against CR/LF (hostile header values become one line).
fn json_header_value(payload: &Value, name: &str) -> String {
    payload
        .get("headers")
        .and_then(Value::as_array)
        .and_then(|headers| {
            headers.iter().find_map(|header| {
                let matches = header
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|n| n.eq_ignore_ascii_case(name))
                    .unwrap_or(false);
                matches.then(|| {
                    header
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                })
            })
        })
        .unwrap_or_default()
        .replace(['\r', '\n'], " ")
}

/// Derives safe, plain mailbox and RFC threading metadata from one full Gmail
/// payload. Any ambiguity or malformed header makes only reply preparation
/// unavailable; ordinary reading remains independent of this result.
fn parse_reply_context(payload: &Value, source_message_id: &str) -> Option<ReplyContext> {
    let from = parse_single_mailbox_header(payload, "From")?;
    let reply_to_headers = raw_header_values(payload, "Reply-To");
    let reply_to_mailboxes = match reply_to_headers.as_slice() {
        [] => None,
        [Some(value)] => Some(parse_mailbox_list(value, true)?),
        _ => return None,
    };
    let message_id = single_message_id(payload, "Message-ID")?;
    let reference_headers = raw_header_values(payload, "References");
    let mut references = match reference_headers.as_slice() {
        [Some(value)] => parse_message_id_list(value)?,
        [] => {
            let in_reply_to = raw_header_values(payload, "In-Reply-To");
            match in_reply_to.as_slice() {
                [] => Vec::new(),
                [Some(value)] => vec![parse_single_message_id(value)?],
                _ => return None,
            }
        }
        _ => return None,
    };
    references.retain(|id| id != &message_id);
    references.push(message_id.clone());
    let total_bytes = references.iter().try_fold(0usize, |total, id| {
        total
            .checked_add(id.len())?
            .checked_add(usize::from(total > 0))
    })?;
    if references.len() > MAX_REPLY_REFERENCES || total_bytes > MAX_REPLY_HEADER_BYTES {
        return None;
    }
    Some(ReplyContext {
        source_message_id: source_message_id.to_string(),
        from_mailbox: from,
        reply_to_mailboxes,
        message_id,
        references,
    })
}

fn parse_single_mailbox_header(payload: &Value, name: &str) -> Option<String> {
    let headers = raw_header_values(payload, name);
    let [Some(value)] = headers.as_slice() else {
        return None;
    };
    let mailboxes = parse_mailbox_list(value, false)?;
    (mailboxes.len() == 1).then(|| mailboxes.into_iter().next().unwrap())
}

/// Parses the original mailbox grammar before any RFC2047 display-name decode.
/// Groups are rejected for reply metadata even though reader display flattens them.
fn parse_mailbox_list(value: &str, allow_multiple: bool) -> Option<Vec<String>> {
    if value.len() > MAX_REPLY_HEADER_BYTES
        || value.chars().any(char::is_control)
        || value.trim_end().ends_with(',')
        || has_unquoted_semicolon(value)
        || has_addr_spec_in_unquoted_phrase(value)
    {
        return None;
    }
    let mut raw = String::from("From: ");
    raw.push_str(value);
    raw.push_str("\r\n");
    let (header, _) = mailparse::parse_header(raw.as_bytes()).ok()?;
    let list = mailparse::addrparse_header(&header).ok()?;
    let mut mailboxes = Vec::new();
    for address in list.iter() {
        let mailparse::MailAddr::Single(info) = address else {
            return None;
        };
        let mailbox = info.addr.as_str();
        if !valid_mailbox(mailbox) {
            return None;
        }
        mailboxes.push(mailbox.to_string());
        if mailboxes.len() > MAX_REPLY_TO_RECIPIENTS {
            return None;
        }
    }
    if mailboxes.is_empty() || (!allow_multiple && mailboxes.len() != 1) {
        return None;
    }
    Some(mailboxes)
}

fn has_addr_spec_in_unquoted_phrase(value: &str) -> bool {
    let mut quoted = false;
    let mut escaped = false;
    let mut comment_depth = 0usize;
    let mut in_angle_address = false;
    let mut phrase_has_at = false;

    for character in value.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && (quoted || comment_depth > 0) {
            escaped = true;
            continue;
        }
        if comment_depth > 0 {
            match character {
                '(' => comment_depth += 1,
                ')' => comment_depth -= 1,
                _ => {}
            }
            continue;
        }
        if quoted {
            if character == '"' {
                quoted = false;
            }
            continue;
        }
        match character {
            '"' => quoted = true,
            '(' => comment_depth = 1,
            '<' if !in_angle_address => {
                if phrase_has_at {
                    return true;
                }
                in_angle_address = true;
            }
            '>' if in_angle_address => in_angle_address = false,
            ',' if !in_angle_address => phrase_has_at = false,
            '@' if !in_angle_address => phrase_has_at = true,
            _ => {}
        }
    }
    false
}

fn has_unquoted_semicolon(value: &str) -> bool {
    let mut quoted = false;
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            ';' if !quoted => return true,
            _ => {}
        }
    }
    false
}

fn valid_mailbox(mailbox: &str) -> bool {
    if mailbox.is_empty()
        || mailbox.len() > 254
        || mailbox.chars().any(char::is_control)
        || mailbox.chars().any(char::is_whitespace)
    {
        return false;
    }
    let Some((local, domain)) = mailbox.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && !domain.contains('@')
        && local.is_ascii()
        && domain.is_ascii()
}

fn single_message_id(payload: &Value, name: &str) -> Option<String> {
    let headers = raw_header_values(payload, name);
    let [Some(value)] = headers.as_slice() else {
        return None;
    };
    parse_single_message_id(value)
}

fn parse_single_message_id(value: &str) -> Option<String> {
    if value.len() > MAX_REPLY_HEADER_BYTES
        || !value.is_ascii()
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
        || !value.starts_with('<')
        || !value.ends_with('>')
    {
        return None;
    }
    let inner = &value[1..value.len().checked_sub(1)?];
    let (left, right) = inner.split_once('@')?;
    if right.contains('@') || !valid_dot_atom(left, false) || !valid_dot_atom(right, true) {
        return None;
    }
    Some(value.to_string())
}

fn valid_dot_atom(value: &str, domain: bool) -> bool {
    if value.is_empty() {
        return false;
    }
    value.split('.').all(|atom| {
        !atom.is_empty()
            && atom.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || (domain && byte == b'-')
                    || (!domain && b"!#$%&'*+-/=?^_`{|}~".contains(&byte))
            })
            && (!domain
                || (atom
                    .as_bytes()
                    .first()
                    .is_some_and(|byte| byte.is_ascii_alphanumeric())
                    && atom
                        .as_bytes()
                        .last()
                        .is_some_and(|byte| byte.is_ascii_alphanumeric())))
    })
}

fn parse_message_id_list(value: &str) -> Option<Vec<String>> {
    if value.len() > MAX_REPLY_HEADER_BYTES
        || !value.is_ascii()
        || value.chars().any(char::is_control)
    {
        return None;
    }
    if value.trim().is_empty() {
        return None;
    }
    let mut ids = Vec::new();
    for token in value.split_ascii_whitespace() {
        ids.push(parse_single_message_id(token)?);
        if ids.len() > MAX_REPLY_REFERENCES {
            return None;
        }
    }
    Some(ids)
}

/// RFC2047-decodes one header value via `mailparse`; falls back to the raw
/// value when undecodable.
fn decoded_header(value: &str) -> String {
    let mut raw = String::from("X-Eos: ");
    raw.push_str(value);
    raw.push_str("\r\n");
    match mailparse::parse_header(raw.as_bytes()) {
        Ok((header, _)) => header.get_value(),
        Err(_) => value.to_string(),
    }
}

/// Recursively finds the first literal `text/plain` part in a Gmail payload
/// tree, skipping attachments. HTML-only payloads yield `None`.
fn find_plain_part(payload: &Value, depth: usize) -> Option<&Value> {
    if depth > MAX_PAYLOAD_DEPTH || is_attachment_part(payload) {
        return None;
    }
    let mime = payload
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if mime.eq_ignore_ascii_case("text/plain") {
        return Some(payload);
    }
    if mime.starts_with("multipart/") {
        let parts = payload.get("parts").and_then(Value::as_array)?;
        for part in parts {
            if is_attachment_part(part) {
                continue;
            }
            let part_mime = part
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if part_mime.eq_ignore_ascii_case("text/plain") {
                return Some(part);
            }
            if part_mime.starts_with("multipart/") {
                if let Some(found) = find_plain_part(part, depth + 1) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// Whether a MIME tree contains inline content that the single-body reader
/// skipped. `multipart/alternative` branches are alternatives, so inspect only
/// the branch that supplied the selected plain-text body.
fn has_omitted_inline_content(payload: &Value, selected: &Value, depth: usize) -> bool {
    if depth > MAX_PAYLOAD_DEPTH {
        return true;
    }
    if std::ptr::eq(payload, selected) || is_attachment_part(payload) {
        return false;
    }
    let mime = payload
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if mime.starts_with("multipart/") {
        let Some(parts) = payload.get("parts").and_then(Value::as_array) else {
            return false;
        };
        if mime.eq_ignore_ascii_case("multipart/alternative") {
            if let Some(part) = parts
                .iter()
                .find(|part| contains_part(part, selected, depth + 1))
            {
                return has_omitted_inline_content(part, selected, depth + 1);
            }
            // An alternative subtree outside the selected body is additional
            // omitted content, not another representation of that body.
        }
        return parts
            .iter()
            .any(|part| has_omitted_inline_content(part, selected, depth + 1));
    }
    payload
        .get("body")
        .and_then(|body| body.get("data"))
        .is_some()
}

fn contains_part(payload: &Value, selected: &Value, depth: usize) -> bool {
    if depth > MAX_PAYLOAD_DEPTH {
        return false;
    }
    if std::ptr::eq(payload, selected) {
        return true;
    }
    payload
        .get("parts")
        .and_then(Value::as_array)
        .is_some_and(|parts| {
            parts
                .iter()
                .any(|part| contains_part(part, selected, depth + 1))
        })
}

/// True when any payload/part in the tree carries a `Content-Disposition:
/// attachment` header (attachment presence is disclosed, never read).
fn payload_has_attachment(payload: &Value, depth: usize) -> bool {
    if depth > MAX_PAYLOAD_DEPTH {
        return false;
    }
    if is_attachment_part(payload) {
        return true;
    }
    payload
        .get("parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .any(|part| payload_has_attachment(part, depth + 1))
        })
        .unwrap_or(false)
}

fn is_attachment_part(part: &Value) -> bool {
    let has_filename = part
        .get("filename")
        .and_then(Value::as_str)
        .is_some_and(|filename| !filename.is_empty());
    let has_attachment_body = part
        .get("body")
        .and_then(|body| body.get("attachmentId"))
        .and_then(Value::as_str)
        .is_some();
    let has_attachment_disposition = part
        .get("headers")
        .and_then(Value::as_array)
        .map(|headers| {
            headers.iter().any(|header| {
                let named_disposition = header
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|n| n.eq_ignore_ascii_case("content-disposition"))
                    .unwrap_or(false);
                let is_attachment = header
                    .get("value")
                    .and_then(Value::as_str)
                    .map(|v| v.to_ascii_lowercase().starts_with("attachment"))
                    .unwrap_or(false);
                named_disposition && is_attachment
            })
        })
        .unwrap_or(false);
    has_filename || has_attachment_body || has_attachment_disposition
}

/// Reconstructs a raw RFC822 part (headers + body bytes) for `mailparse`.
/// Header values are sanitized against CR/LF injection.
fn part_raw(part: &Value, body: &[u8]) -> Vec<u8> {
    let mut raw = Vec::new();
    if let Some(headers) = part.get("headers").and_then(Value::as_array) {
        for header in headers {
            let name = header
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let value = header
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .replace(['\r', '\n'], " ");
            // Gmail has already unwrapped its base64url body.data value. The
            // original MIME transfer-encoding header no longer describes the
            // returned bytes and must not be applied a second time.
            if name.eq_ignore_ascii_case("content-transfer-encoding") {
                continue;
            }
            raw.extend_from_slice(name.as_bytes());
            raw.extend_from_slice(b": ");
            raw.extend_from_slice(value.as_bytes());
            raw.extend_from_slice(b"\r\n");
        }
    }
    raw.extend_from_slice(b"\r\n");
    raw.extend_from_slice(body);
    raw
}

/// Flattens a sanitized original address header into wire DTOs; groups are
/// flattened, entries with empty mailboxes are dropped, malformed headers
/// yield an empty list. Parse the address grammar before RFC2047 decoding so
/// encoded commas/colons remain display-name data rather than separators.
fn parse_addresses(value: &str) -> Vec<Address> {
    let mut raw = String::from("From: ");
    raw.push_str(value);
    raw.push_str("\r\n");
    let Ok((header, _)) = mailparse::parse_header(raw.as_bytes()) else {
        return Vec::new();
    };
    let Ok(list) = mailparse::addrparse_header(&header) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for addr in list.iter() {
        match addr {
            mailparse::MailAddr::Single(info) => push_address(&mut out, info),
            mailparse::MailAddr::Group(group) => {
                for info in &group.addrs {
                    push_address(&mut out, info);
                }
            }
        }
    }
    out
}

fn push_address(out: &mut Vec<Address>, info: &mailparse::SingleInfo) {
    if info.addr.is_empty() {
        return;
    }
    out.push(Address {
        display_name: info.display_name.clone(),
        mailbox: info.addr.clone(),
    })
}

/// Normalizes one history page. Semantics kept mechanical for the sync lane:
///
/// - `messagesAdded` / `labelsAdded` -> thread id in `changed_thread_ids`
/// - `messagesDeleted` -> message id in `deleted_message_ids` + thread changed
/// - `labelsRemoved` -> thread id in `changed_thread_ids` (current thread
///   facts reconcile inbox membership; only actual deletions remove messages)
///
/// Adds nested-record work to the per-response parsing budget.
fn count_history_records(count: &mut usize, amount: usize) -> Result<(), MailError> {
    *count = count
        .checked_add(amount)
        .filter(|count| *count <= MAX_HISTORY_RECORDS)
        .ok_or(MailError::InvalidProviderResponse)?;
    Ok(())
}

fn push_unique_limited(
    values: &mut Vec<String>,
    seen: &mut HashSet<String>,
    value: String,
    limit: usize,
) -> Result<(), MailError> {
    if seen.contains(&value) {
        return Ok(());
    }
    if values.len() >= limit {
        return Err(MailError::InvalidProviderResponse);
    }
    seen.insert(value.clone());
    values.push(value);
    Ok(())
}

/// Repeated ids are deduped; nested records and retained unique ids are
/// explicitly bounded, and malformed records are typed errors.
pub(super) fn parse_history(body: &str) -> Result<HistoryPage, MailError> {
    let json: Value = parse_json(body)?;
    let history_id = str_field(&json, "historyId")?;
    let entries = optional_array(&json, "history")?.unwrap_or(&[]);
    let mut record_count = 0;
    count_history_records(&mut record_count, entries.len())?;
    let mut changed_thread_ids = Vec::new();
    let mut deleted_message_ids = Vec::new();
    let mut changed_ids = HashSet::new();
    let mut deleted_ids = HashSet::new();
    for entry in entries {
        if !entry.is_object() {
            return Err(MailError::InvalidProviderResponse);
        }
        if let Some(records) = optional_array(entry, "messagesAdded")? {
            count_history_records(&mut record_count, records.len())?;
            for record in records {
                let message = record
                    .get("message")
                    .ok_or(MailError::InvalidProviderResponse)?;
                push_unique_limited(
                    &mut changed_thread_ids,
                    &mut changed_ids,
                    str_field(message, "threadId")?,
                    MAX_CHANGED_THREAD_IDS,
                )?;
            }
        }
        if let Some(records) = optional_array(entry, "messagesDeleted")? {
            count_history_records(&mut record_count, records.len())?;
            for record in records {
                let message = record
                    .get("message")
                    .ok_or(MailError::InvalidProviderResponse)?;
                push_unique_limited(
                    &mut deleted_message_ids,
                    &mut deleted_ids,
                    str_field(message, "id")?,
                    MAX_DELETED_MESSAGE_IDS,
                )?;
                push_unique_limited(
                    &mut changed_thread_ids,
                    &mut changed_ids,
                    str_field(message, "threadId")?,
                    MAX_CHANGED_THREAD_IDS,
                )?;
            }
        }
        if let Some(records) = optional_array(entry, "labelsAdded")? {
            count_history_records(&mut record_count, records.len())?;
            for record in records {
                let message = record
                    .get("message")
                    .ok_or(MailError::InvalidProviderResponse)?;
                let _added_labels = optional_string_array(record, "labelIds")?;
                push_unique_limited(
                    &mut changed_thread_ids,
                    &mut changed_ids,
                    str_field(message, "threadId")?,
                    MAX_CHANGED_THREAD_IDS,
                )?;
            }
        }
        if let Some(records) = optional_array(entry, "labelsRemoved")? {
            count_history_records(&mut record_count, records.len())?;
            for record in records {
                let message = record
                    .get("message")
                    .ok_or(MailError::InvalidProviderResponse)?;
                let _removed_labels = optional_string_array(record, "labelIds")?;
                push_unique_limited(
                    &mut changed_thread_ids,
                    &mut changed_ids,
                    str_field(message, "threadId")?,
                    MAX_CHANGED_THREAD_IDS,
                )?;
            }
        }
    }
    let next_page_token = optional_string(&json, "nextPageToken")?;
    Ok(HistoryPage {
        changed_thread_ids,
        deleted_message_ids,
        next_page_token,
        history_id,
    })
}

#[cfg(test)]
#[path = "reply_context_tests.rs"]
mod reply_context_tests;
