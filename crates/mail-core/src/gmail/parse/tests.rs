use super::*;
use crate::gmail::provider::tests::{
    gmail_message, payload_headers, text_payload, thread_response,
};
use serde_json::json;

#[test]
fn encoded_address_display_names_do_not_change_address_grammar() {
    let payload = text_payload(
        "text/plain",
        &[
            ("From", "=?UTF-8?Q?Doe=2C_John?= <john@example.test>"),
            (
                "To",
                "=?UTF-8?Q?Ops=3A_Team?= <ops@example.test>, next@example.test",
            ),
            ("Subject", "encoded address punctuation"),
            ("Content-Type", "text/plain; charset=utf-8"),
        ],
        Some(b"safe body"),
    );
    let thread = parse_thread(
        "synthetic@example.test",
        "t-address-encoded",
        &thread_response(
            "t-address-encoded",
            "6",
            vec![gmail_message("m-address", &[], payload)],
        ),
    )
    .unwrap();
    let message = &thread.conversation.messages[0];
    assert_eq!(message.from.display_name.as_deref(), Some("Doe, John"));
    assert_eq!(message.from.mailbox, "john@example.test");
    assert_eq!(message.to[0].display_name.as_deref(), Some("Ops: Team"));
    assert_eq!(message.to[0].mailbox, "ops@example.test");
    assert_eq!(message.to[1].mailbox, "next@example.test");
}

#[test]
fn gmail_full_payload_does_not_reapply_base64_transfer_encoding() {
    let payload = text_payload(
        "text/plain",
        &[
            ("From", "sender@example.test"),
            ("Subject", "encoded transport"),
            ("Content-Type", "text/plain; charset=utf-8"),
            ("Content-Transfer-Encoding", "base64"),
        ],
        Some(b"Ordinary text is already decoded by Gmail."),
    );
    let body = thread_response(
        "t-b64",
        "9",
        vec![gmail_message("m-b64", &["INBOX"], payload)],
    );
    let thread = parse_thread("synthetic@example.test", "t-b64", &body).unwrap();
    assert_eq!(
        thread.conversation.messages[0].body_text,
        "Ordinary text is already decoded by Gmail."
    );
    assert_eq!(thread.conversation.context_complete, Some(true));
}

#[test]
fn history_parser_rejects_nested_record_and_unique_id_budget_overruns() {
    let changed = (0..=MAX_CHANGED_THREAD_IDS)
        .map(|index| json!({"message":{"threadId":format!("t{index}")}}))
        .collect::<Vec<_>>();
    let body = json!({"historyId":"200","history":[{"messagesAdded":changed}]}).to_string();
    assert!(matches!(
        parse_history(&body),
        Err(MailError::InvalidProviderResponse)
    ));

    let deleted = (0..=MAX_DELETED_MESSAGE_IDS)
        .map(|index| json!({"message":{"id":format!("m{index}"),"threadId":"same-thread"}}))
        .collect::<Vec<_>>();
    let body = json!({"historyId":"200","history":[{"messagesDeleted":deleted}]}).to_string();
    assert!(matches!(
        parse_history(&body),
        Err(MailError::InvalidProviderResponse)
    ));

    let too_many_records = vec![json!({}); MAX_HISTORY_RECORDS + 1];
    let body = json!({"historyId":"200","history":too_many_records}).to_string();
    assert!(matches!(
        parse_history(&body),
        Err(MailError::InvalidProviderResponse)
    ));
}

#[test]
fn parse_thread_records_per_message_attachment_presence() {
    let with_attachment = json!({
        "mimeType": "multipart/mixed",
        "headers": payload_headers(&[("From", "s@example.test"), ("Subject", "file")]),
        "parts": [
            text_payload("text/plain", &[], Some(b"see attached")),
            {"mimeType": "application/pdf", "filename": "report.pdf",
             "body": {"size": 9, "attachmentId": "handle-1"}}
        ]
    });
    let plain = text_payload(
        "text/plain",
        &[("From", "s@example.test"), ("Subject", "file")],
        Some(b"no attachment here"),
    );
    let body = thread_response(
        "t-att",
        "7",
        vec![
            gmail_message("m-att", &["INBOX"], with_attachment),
            gmail_message("m-plain", &["INBOX"], plain),
        ],
    );
    let thread = parse_thread("acct", "t-att", &body).unwrap();
    assert_eq!(thread.conversation.messages.len(), 2);
    assert_eq!(thread.conversation.messages[0].has_attachment, Some(true));
    assert_eq!(thread.conversation.messages[1].has_attachment, Some(false));
}

#[test]
fn skipped_inline_mixed_content_is_disclosed_but_alternatives_are_not() {
    let main = text_payload(
        "text/plain",
        &[("Content-Type", "text/plain; charset=utf-8")],
        Some(b"Main body"),
    );
    let additional = text_payload(
        "text/plain",
        &[("Content-Type", "text/plain; charset=utf-8")],
        Some(b"Additional content"),
    );
    let mixed = json!({
        "mimeType": "multipart/mixed",
        "headers": payload_headers(&[("From", "sender@example.test")]),
        "parts": [main.clone(), additional],
    });
    let mixed_thread = parse_thread(
        "synthetic@example.test",
        "t-mixed-inline",
        &thread_response(
            "t-mixed-inline",
            "6",
            vec![gmail_message("m-mixed-inline", &[], mixed)],
        ),
    )
    .unwrap();
    assert_eq!(mixed_thread.conversation.messages[0].body_text, "Main body");
    assert_eq!(mixed_thread.conversation.context_complete, Some(false));
    assert_eq!(
        mixed_thread.conversation.unsupported_reason.as_deref(),
        Some("additional inline MIME content is not displayed")
    );

    let alternative = json!({
        "mimeType": "multipart/alternative",
        "headers": payload_headers(&[("From", "sender@example.test")]),
        "parts": [
            main,
            text_payload("text/html", &[], Some(b"<p>alternative</p>")),
        ],
    });
    let alternative_thread = parse_thread(
        "synthetic@example.test",
        "t-alternative-inline",
        &thread_response(
            "t-alternative-inline",
            "6",
            vec![gmail_message("m-alternative-inline", &[], alternative)],
        ),
    )
    .unwrap();
    assert_eq!(alternative_thread.conversation.context_complete, Some(true));
    assert_eq!(alternative_thread.conversation.unsupported_reason, None);
}

#[test]
fn unselected_alternative_subtree_is_disclosed_as_omitted_inline_content() {
    let payload = json!({
        "mimeType": "multipart/mixed",
        "headers": payload_headers(&[("From", "sender@example.test")]),
        "parts": [
            text_payload("text/plain", &[("Content-Type", "text/plain; charset=utf-8")], Some(b"Main body")),
            {
                "mimeType": "multipart/alternative",
                "parts": [
                    text_payload("text/plain", &[], Some(b"Additional content")),
                    text_payload("text/html", &[], Some(b"<p>Additional content</p>")),
                ],
            },
        ],
    });
    let thread = parse_thread(
        "synthetic@example.test",
        "t-nested-alternative",
        &thread_response(
            "t-nested-alternative",
            "6",
            vec![gmail_message("m-nested-alternative", &["INBOX"], payload)],
        ),
    )
    .unwrap();
    assert_eq!(thread.conversation.messages[0].body_text, "Main body");
    assert_eq!(thread.conversation.context_complete, Some(false));
    assert_eq!(
        thread.conversation.unsupported_reason.as_deref(),
        Some("additional inline MIME content is not displayed")
    );
}

/// P5a: the parse records per-message attachment presence (known fact)
/// alongside the body, so summaries can report it without guessing.

#[test]
fn unsupported_and_lossy_charsets_are_disclosed_as_incomplete() {
    let unknown = text_payload(
        "text/plain",
        &[
            ("From", "sender@example.test"),
            ("Subject", "unknown charset"),
            ("Content-Type", "text/plain; charset=x-no-such-charset"),
        ],
        Some(b"not safely decodable"),
    );
    let invalid_utf8 = text_payload(
        "text/plain",
        &[
            ("From", "sender@example.test"),
            ("Subject", "invalid utf8"),
            ("Content-Type", "text/plain; charset=utf-8"),
        ],
        Some(b"invalid \xff utf8"),
    );
    let body = thread_response(
        "t-charsets",
        "10",
        vec![
            gmail_message("m-unknown", &["INBOX"], unknown),
            gmail_message("m-invalid", &["INBOX"], invalid_utf8),
        ],
    );
    let thread = parse_thread("synthetic@example.test", "t-charsets", &body).unwrap();
    assert!(thread.conversation.messages.is_empty());
    assert_eq!(thread.conversation.context_complete, Some(false));
    assert_eq!(
        thread.conversation.unsupported_reason.as_deref(),
        Some("2 of 2 messages had no displayable body")
    );
}

#[test]
fn triage_membership_includes_ids_without_safe_bodies() {
    let body = serde_json::json!({"historyId":"h1", "messages":[
            {"id":"trash-id", "labelIds":["TRASH","UNREAD"], "payload":{"mimeType":"text/html","body":{"data":"PGI-aGk8L2I-"}}},
            {"id":"spam-id", "labelIds":["SPAM"], "payload":{"mimeType":"application/octet-stream","body":{}}},
            {"id":"independent", "labelIds":["INBOX"], "payload":{"mimeType":"text/plain","body":{"data":"aGVsbG8"}}}
        ]}).to_string();
    let parsed = parse_thread("acct", "thread", &body).unwrap();
    assert_eq!(parsed.trash_message_ids, Some(vec!["trash-id".into()]));
    assert_eq!(parsed.spam_message_ids, Some(vec!["spam-id".into()]));
    assert_eq!(parsed.message_ids.unwrap().len(), 3);
    assert_eq!(parsed.inbox_message_ids, vec!["independent"]);
}

/// Build a message around a MIME payload for HTML reader cases.
fn html_test_thread(payload: Value) -> GmailThread {
    let body = thread_response("t-html", "1", vec![gmail_message("m-html", &[], payload)]);
    parse_thread("account", "t-html", &body).unwrap()
}

fn html_root(bytes: &[u8], content_type: &str) -> Value {
    text_payload(
        "text/html",
        &[("From", "s@example.test"), ("Content-Type", content_type)],
        Some(bytes),
    )
}

#[test]
fn html_only_is_retained_and_supplies_text() {
    let thread = html_test_thread(html_root(b"<p>a</p><script>x()</script><style>p{}</style><a href=\"https://example.test/y\">link</a>", "text/html; charset=utf-8"));
    let text = &thread.conversation.messages[0].body_text;
    assert!(text.contains("https://example.test/y"));
    assert!(!text.contains("x()") && !text.contains("p{}") && !text.contains("<p>"));
    assert!(matches!(
        thread.message_html.get("m-html"),
        Some(MessageHtml::Present(_))
    ));
}

#[test]
fn alternative_retains_plain_and_html() {
    let thread = html_test_thread(
        json!({"mimeType":"multipart/alternative", "headers":payload_headers(&[("From", "s@example.test")]), "parts":[
            text_payload("text/plain", &[], Some(b"plain")),
            text_payload("text/html", &[("Content-Type", "text/html; charset=utf-8")], Some(b"<p>html</p>"))
        ]}),
    );
    assert_eq!(thread.conversation.messages[0].body_text, "plain");
    assert!(matches!(
        thread.message_html.get("m-html"),
        Some(MessageHtml::Present(_))
    ));
}

#[test]
fn related_image_is_fetchable_and_not_an_omission() {
    let thread = html_test_thread(
        json!({"mimeType":"multipart/related", "headers":payload_headers(&[("From", "s@example.test")]), "parts":[
            text_payload("text/html", &[], Some(b"<img src=\"cid:logo@x\">")),
            {"mimeType":"image/png", "headers":payload_headers(&[("Content-ID", "<logo@x>")]), "body":{"attachmentId":"image1", "size":12}}
        ]}),
    );
    assert_eq!(thread.inline_parts[0].content_id, "logo@x");
    assert_eq!(thread.attachments.len(), 1);
    assert_eq!(thread.conversation.unsupported_reason, None);
}

#[test]
fn html_charset_and_size_limits() {
    let utf8 = html_test_thread(html_root("<p>é</p>".as_bytes(), "text/html"));
    assert!(
        matches!(utf8.message_html.get("m-html"), Some(MessageHtml::Present(s)) if s.contains('é'))
    );
    let latin = html_test_thread(html_root(
        b"<meta charset=iso-8859-1><p>\xe9</p>",
        "text/html",
    ));
    assert!(
        matches!(latin.message_html.get("m-html"), Some(MessageHtml::Present(s)) if s.contains('é'))
    );
    let large = html_test_thread(html_root(&vec![b'a'; 512 * 1024 + 1], "text/html"));
    assert!(matches!(
        large.message_html.get("m-html"),
        Some(MessageHtml::TooLarge)
    ));
    assert!(!large.conversation.messages.is_empty());
}

#[test]
fn invalid_inline_resources_are_not_retained() {
    for image in [
        json!({"mimeType":"image/png", "headers":payload_headers(&[("Content-ID", "<logo@x>")]), "body":{"data":"YWJj", "size":3}}),
        json!({"mimeType":"image/svg+xml", "headers":payload_headers(&[("Content-ID", "<logo@x>")]), "body":{"attachmentId":"image1", "size":3}}),
    ] {
        let thread = html_test_thread(
            json!({"mimeType":"multipart/related", "headers":payload_headers(&[("From", "s@example.test")]), "parts":[text_payload("text/html", &[], Some(b"<p>hello</p>")), image]}),
        );
        assert!(thread.inline_parts.is_empty());
    }
}

#[test]
fn undecodable_html_leaves_plain_body() {
    let thread = html_test_thread(
        json!({"mimeType":"multipart/alternative", "headers":payload_headers(&[("From", "s@example.test")]), "parts":[
            text_payload("text/plain", &[], Some(b"plain")),
            text_payload("text/html", &[("Content-Type", "text/html; charset=utf-8")], Some(b"\xff"))
        ]}),
    );
    assert_eq!(thread.conversation.messages[0].body_text, "plain");
    assert!(thread.message_html.is_empty());
}

#[test]
fn html_beyond_depth_is_not_selected() {
    let mut payload = text_payload("text/html", &[], Some(b"deep"));
    for _ in 0..=MAX_PAYLOAD_DEPTH {
        payload = json!({"mimeType":"multipart/mixed", "parts":[payload]});
    }
    payload["headers"] = Value::Array(payload_headers(&[("From", "s@example.test")]));
    let thread = html_test_thread(payload);
    assert!(thread.message_html.is_empty());
    assert!(thread
        .conversation
        .unsupported_reason
        .unwrap()
        .contains("had no displayable body"));
}

#[test]
fn thread_html_budget_marks_later_messages() {
    let messages = (0..5)
        .map(|i| {
            gmail_message(
                &format!("m{i}"),
                &[],
                html_root(&vec![b'a'; 512 * 1024], "text/html"),
            )
        })
        .collect();
    let body = thread_response("t", "1", messages);
    let thread = parse_thread("account", "t", &body).unwrap();
    assert!(matches!(
        thread.message_html.get("m4"),
        Some(MessageHtml::TooLarge)
    ));
}

#[test]
fn thread_html_budget_keeps_earlier_messages() {
    let messages = (0..5)
        .map(|i| {
            gmail_message(
                &format!("m{i}"),
                &[],
                html_root(&vec![b'a'; 512 * 1024], "text/html"),
            )
        })
        .collect();
    let body = thread_response("t", "1", messages);
    let thread = parse_thread("account", "t", &body).unwrap();
    for id in ["m0", "m1", "m2", "m3"] {
        assert!(matches!(
            thread.message_html.get(id),
            Some(MessageHtml::Present(_))
        ));
    }
    assert_eq!(thread.conversation.messages.len(), 5);
}

#[test]
fn html_outside_the_chosen_body_is_additional_content() {
    let thread = html_test_thread(json!({
        "mimeType": "multipart/mixed",
        "headers": payload_headers(&[("From", "s@example.test")]),
        "parts": [
            text_payload("text/plain", &[], Some(b"Main body")),
            text_payload("text/html", &[], Some(b"<p>Something else</p>")),
        ],
    }));
    assert_eq!(thread.conversation.messages[0].body_text, "Main body");
    assert!(thread.message_html.is_empty());
    assert_eq!(
        thread.conversation.unsupported_reason.as_deref(),
        Some("additional inline MIME content is not displayed")
    );
}

#[test]
fn alternative_with_related_html_keeps_both_and_the_inline_image() {
    let thread = html_test_thread(json!({
        "mimeType": "multipart/alternative",
        "headers": payload_headers(&[("From", "s@example.test")]),
        "parts": [
            text_payload("text/plain", &[], Some(b"plain")),
            {
                "mimeType": "multipart/related",
                "parts": [
                    text_payload("text/html", &[], Some(b"<img src=\"cid:logo@x\">")),
                    {
                        "mimeType": "image/png",
                        "headers": payload_headers(&[("Content-ID", "<logo@x>")]),
                        "body": {"attachmentId": "image1", "size": 12},
                    },
                ],
            },
        ],
    }));
    assert_eq!(thread.conversation.messages[0].body_text, "plain");
    assert!(matches!(
        thread.message_html.get("m-html"),
        Some(MessageHtml::Present(_))
    ));
    assert_eq!(thread.inline_parts.len(), 1);
    assert_eq!(thread.conversation.unsupported_reason, None);
}
