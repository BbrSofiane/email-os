use super::{parse_reply_context, parse_thread};
use serde_json::{json, Value};

fn payload(headers: &[(&str, &str)]) -> Value {
    json!({
        "headers": headers
            .iter()
            .map(|(name, value)| json!({"name": name, "value": value}))
            .collect::<Vec<_>>()
    })
}

fn valid_headers() -> Vec<(&'static str, &'static str)> {
    vec![
        ("From", "=?UTF-8?Q?Doe=2C_Jane?= <jane@example.test>"),
        ("Message-ID", "<current@example.test>"),
        ("References", "<first@example.test> <current@example.test>"),
    ]
}

#[test]
fn parsed_thread_carries_only_the_latest_payload_context() {
    let make_message = |id: &str, header_id: &str, body: &str| {
        json!({
            "id": id,
            "labelIds": ["INBOX"],
            "internalDate": if id == "m-latest" { "1760000001000" } else { "1760000000000" },
            "payload": {
                "mimeType": "text/plain",
                "headers": [
                    {"name": "From", "value": "sender@example.test"},
                    {"name": "Message-ID", "value": header_id},
                    {"name": "Content-Type", "value": "text/plain; charset=utf-8"}
                ],
                "body": {"data": body}
            }
        })
    };
    let body = json!({
        "historyId": "5",
        "messages": [
            make_message("m-latest", "<latest@example.test>", "bGF0ZXN0"),
            make_message("m-old", "<old@example.test>", "b2xk")
        ]
    });
    let parsed = parse_thread("acct", "thread", &body.to_string()).expect("thread parses");
    assert!(parsed
        .conversation
        .messages
        .iter()
        .any(|message| message.id == "m-latest"));
    let context = parsed.conversation.reply_context.expect("latest context");
    assert_eq!(context.source_message_id, "m-latest");
    assert_eq!(context.message_id, "<latest@example.test>");
    assert_eq!(context.references, vec!["<latest@example.test>"]);
}

#[test]
fn raw_address_grammar_precedes_encoded_word_decode_and_reply_to_absence_is_distinct() {
    let context = parse_reply_context(&payload(&valid_headers()), "m-current").expect("context");
    assert_eq!(context.source_message_id, "m-current");
    assert_eq!(context.from_mailbox, "jane@example.test");
    assert_eq!(context.reply_to_mailboxes, None);
    assert_eq!(context.message_id, "<current@example.test>");
    assert_eq!(
        context.references,
        vec!["<first@example.test>", "<current@example.test>"]
    );
}

#[test]
fn unquoted_addr_spec_is_not_accepted_as_a_display_name() {
    for (name, value) in [
        ("From", "first@example.test <second@example.test>"),
        ("Reply-To", "first@example.test <second@example.test>"),
    ] {
        let mut headers = valid_headers();
        headers.retain(|(header, _)| !header.eq_ignore_ascii_case(name));
        headers.push((name, value));
        assert!(
            parse_reply_context(&payload(&headers), "m-current").is_none(),
            "{name}"
        );
    }

    let mut quoted = valid_headers();
    quoted.retain(|(name, _)| !name.eq_ignore_ascii_case("From"));
    quoted.push(("From", "\"Jane first@example.test\" <jane@example.test>"));
    quoted.push((
        "Reply-To",
        "\"Reply first@example.test\" <reply@example.test>",
    ));
    let context =
        parse_reply_context(&payload(&quoted), "m-current").expect("quoted names remain valid");
    assert_eq!(context.from_mailbox, "jane@example.test");
    assert_eq!(
        context.reply_to_mailboxes,
        Some(vec!["reply@example.test".to_string()])
    );

    let mut encoded = valid_headers();
    encoded.push(("Reply-To", "=?UTF-8?Q?Reply_Name?= <reply@example.test>"));
    let context =
        parse_reply_context(&payload(&encoded), "m-current").expect("encoded name remains valid");
    assert_eq!(
        context.reply_to_mailboxes,
        Some(vec!["reply@example.test".to_string()])
    );
}

#[test]
fn reply_to_is_preserved_separately_and_invalid_present_values_do_not_fall_back() {
    let mut headers = valid_headers();
    headers.push((
        "Reply-To",
        "Support <reply@example.test>, Other <other@example.test>",
    ));
    let context = parse_reply_context(&payload(&headers), "m-current").expect("context");
    assert_eq!(
        context.reply_to_mailboxes,
        Some(vec![
            "reply@example.test".to_string(),
            "other@example.test".to_string()
        ])
    );

    for invalid in [
        "",
        "Undisclosed:;",
        "broken address",
        "a@example.test,",
        "a@example.test\r\nbcc:x@y",
    ] {
        let mut headers = valid_headers();
        headers.push(("Reply-To", invalid));
        assert!(
            parse_reply_context(&payload(&headers), "m-current").is_none(),
            "{invalid:?}"
        );
    }
    let mut malformed_reply_to = valid_headers();
    malformed_reply_to.push(("Reply-To", "intended@example.test; other@example.test"));
    assert!(parse_reply_context(&payload(&malformed_reply_to), "m-current").is_none());

    let twenty = (0..20)
        .map(|index| format!("r{index}@example.test"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut at_limit = valid_headers();
    at_limit.push(("Reply-To", Box::leak(twenty.into_boxed_str())));
    assert!(parse_reply_context(&payload(&at_limit), "m-current").is_some());
    let twenty_one = (0..21)
        .map(|index| format!("r{index}@example.test"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut over_limit = valid_headers();
    over_limit.push(("Reply-To", Box::leak(twenty_one.into_boxed_str())));
    assert!(parse_reply_context(&payload(&over_limit), "m-current").is_none());

    let mut duplicate = valid_headers();
    duplicate.push(("Reply-To", "one@example.test"));
    duplicate.push(("Reply-To", "two@example.test"));
    assert!(parse_reply_context(&payload(&duplicate), "m-current").is_none());
}

#[test]
fn missing_duplicate_group_and_malformed_from_make_only_reply_metadata_unavailable() {
    let base = valid_headers();
    for from_headers in [
        vec![],
        vec![("From", "one@example.test"), ("From", "two@example.test")],
        vec![("From", "Team: one@example.test;")],
        vec![("From", "one@example.test;")],
        vec![("From", "not an address")],
        vec![("From", "one@example.test, two@example.test")],
    ] {
        let mut headers: Vec<_> = base
            .iter()
            .copied()
            .filter(|(name, _)| !name.eq_ignore_ascii_case("From"))
            .collect();
        headers.extend(from_headers);
        assert!(parse_reply_context(&payload(&headers), "m-current").is_none());
    }

    // Header failures are deliberately not fatal to ordinary message reading.
    let malformed = json!({
        "id": "m1",
        "labelIds": ["INBOX"],
        "payload": {
            "mimeType": "text/plain",
            "headers": [{"name": "From", "value": "Group: x@example.test;"}],
            "body": {"data": ""}
        },
        "internalDate": "1760000000000"
    });
    let thread_body = json!({
        "historyId": "1",
        "messages": [malformed]
    });
    let thread =
        parse_thread("acct", "thread", &thread_body.to_string()).expect("reader remains valid");
    assert_eq!(thread.conversation.reply_context, None);
}

#[test]
fn strict_message_id_references_and_in_reply_to_fallback_are_bounded() {
    let mut headers = valid_headers();
    headers.retain(|(name, _)| !name.eq_ignore_ascii_case("References"));
    headers.push(("In-Reply-To", "<parent@example.test>"));
    let fallback = parse_reply_context(&payload(&headers), "m-current").expect("fallback");
    assert_eq!(
        fallback.references,
        vec!["<parent@example.test>", "<current@example.test>"]
    );

    let mut missing_id = valid_headers();
    missing_id.retain(|(name, _)| !name.eq_ignore_ascii_case("Message-ID"));
    assert!(parse_reply_context(&payload(&missing_id), "m-current").is_none());
    let mut duplicate_id = valid_headers();
    duplicate_id.push(("Message-ID", "<duplicate@example.test>"));
    assert!(parse_reply_context(&payload(&duplicate_id), "m-current").is_none());

    for invalid_id in [
        "",
        "current@example.test",
        "<a@b> extra",
        "<a b@c>",
        "<a@@b>",
        "<a@bad_domain>",
    ] {
        let mut headers = valid_headers();
        headers.retain(|(name, _)| !name.eq_ignore_ascii_case("Message-ID"));
        headers.push(("Message-ID", invalid_id));
        assert!(
            parse_reply_context(&payload(&headers), "m-current").is_none(),
            "{invalid_id:?}"
        );
    }

    let ids_at_limit = (0..99)
        .map(|index| format!("<r{index}@example.test>"))
        .chain(std::iter::once("<current@example.test>".to_string()))
        .collect::<Vec<_>>()
        .join(" ");
    let mut at_limit = valid_headers();
    at_limit.retain(|(name, _)| !name.eq_ignore_ascii_case("References"));
    at_limit.push(("References", Box::leak(ids_at_limit.into_boxed_str())));
    let context = parse_reply_context(&payload(&at_limit), "m-current").expect("100 IDs accepted");
    assert_eq!(context.references.len(), 100);
    assert_eq!(
        context.references.last().map(String::as_str),
        Some("<current@example.test>")
    );

    let ids_over_limit = (0..100)
        .map(|index| format!("<r{index}@example.test>"))
        .collect::<Vec<_>>()
        .join(" ");
    let mut over_limit = valid_headers();
    over_limit.retain(|(name, _)| !name.eq_ignore_ascii_case("References"));
    over_limit.push(("References", Box::leak(ids_over_limit.into_boxed_str())));
    assert!(parse_reply_context(&payload(&over_limit), "m-current").is_none());

    let oversized_total = format!("<{}@x.test>", "a".repeat(16_360));
    let mut large = valid_headers();
    large.retain(|(name, _)| !name.eq_ignore_ascii_case("References"));
    large.push(("References", Box::leak(oversized_total.into_boxed_str())));
    assert!(parse_reply_context(&payload(&large), "m-current").is_none());
}

#[test]
fn references_header_presence_blocks_in_reply_to_fallback_when_invalid() {
    for references in ["<bad@>", "", "   "] {
        let mut headers = valid_headers();
        headers.retain(|(name, _)| !name.eq_ignore_ascii_case("References"));
        headers.push(("References", references));
        headers.push(("In-Reply-To", "<parent@example.test>"));
        assert!(
            parse_reply_context(&payload(&headers), "m-current").is_none(),
            "References={references:?}"
        );
    }
}
