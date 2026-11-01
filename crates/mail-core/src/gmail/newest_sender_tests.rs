//! Real provider parser -> durable cache -> wire summary contract for saved splits.
use super::*;
use crate::clock::SystemClock;
use crate::gmail::provider::parse_thread;
use serde_json::{json, Value};

fn body(from: Option<&str>, reversed: bool) -> String {
    let mut headers = vec![json!({"name": "Subject", "value": "Sender metadata"})];
    if let Some(from) = from {
        headers.push(json!({"name": "From", "value": from}));
    }
    let mut messages = vec![
        json!({"id": "a", "internalDate": "1000", "labelIds": ["INBOX"],
            "payload": {"mimeType": "text/plain", "headers": [
                {"name": "Subject", "value": "Sender metadata"},
                {"name": "From", "value": "Alice <alice@old.test>"},
                {"name": "To", "value": "Bob <bob@new.test>"}],
                "body": {"data": "b2xkIHBsYWlu"}}}),
        // Equal timestamps select the greatest ID, just like the existing reply
        // source selection and the store's ascending timestamp/ID message stack.
        json!({"id": "m", "internalDate": "2000", "labelIds": ["INBOX"],
            "payload": {"mimeType": "text/html", "headers": [
                {"name": "From", "value": "Tie loser <tie@old.test>"}],
                "body": {"data": "PGI+dGllPC9iPg"}}}),
        json!({"id": "z", "internalDate": "2000", "labelIds": ["INBOX"],
            "payload": {"mimeType": "text/html", "headers": headers,
                "body": {"data": "PGI+bmV3PC9iPg"}}}),
    ];
    if reversed {
        messages.reverse();
    }
    json!({"id": "thread", "historyId": "h2", "messages": messages}).to_string()
}

fn parsed(from: Option<&str>, reversed: bool) -> GmailThread {
    parse_thread("acct", "thread", &body(from, reversed)).unwrap()
}

fn summary(store: &GmailStore) -> ConversationSummary {
    let rows = store.list_snapshot().unwrap().conversations;
    assert_eq!(rows.len(), 1);
    rows[0].clone()
}

fn refresh(store: &GmailStore, thread: GmailThread) {
    let page = HistoryPage {
        changed_thread_ids: vec!["thread".into()],
        deleted_message_ids: vec![],
        next_page_token: None,
        history_id: "h3".into(),
    };
    store
        .apply_history_page(
            &page,
            &[ThreadFetch::Cached(Box::new(thread))],
            "h2",
            store.generation().unwrap(),
        )
        .unwrap();
}

#[test]
fn newest_sender_provider_storage_and_membership_wire_contract() {
    let dir = std::env::temp_dir().join(format!("newest-sender-{}", uuid::Uuid::new_v4()));
    let store = GmailStore::open(&dir, Arc::new(SystemClock)).unwrap();
    store
        .begin_account(
            &GmailProfile {
                account_id: "acct".into(),
                email_address: "me@example.test".into(),
                history_id: "h1".into(),
            },
            0,
        )
        .unwrap();
    let forward = parsed(Some("Bob <bob@new.test>"), false);
    let reverse = parsed(Some("Bob <bob@new.test>"), true);
    assert_eq!(forward.newest_sender, reverse.newest_sender);
    assert_eq!(
        forward.newest_sender.as_ref().unwrap().mailbox,
        "bob@new.test"
    );
    assert_eq!(forward.conversation.messages.len(), 1);
    assert_eq!(
        forward.conversation.messages[0].from.mailbox,
        "alice@old.test"
    );
    assert_eq!(forward.conversation.context_complete, Some(false));
    assert!(forward
        .conversation
        .unsupported_reason
        .as_ref()
        .unwrap()
        .contains("2 of 3"));
    store
        .apply_discovery_page(
            &[ThreadFetch::Cached(Box::new(forward))],
            None,
            true,
            false,
            store.generation().unwrap(),
        )
        .unwrap();
    let bob_summary = summary(&store);
    refresh(&store, reverse);
    assert_eq!(summary(&store), bob_summary);
    drop(store);
    let store = GmailStore::open(&dir, Arc::new(SystemClock)).unwrap();
    assert_eq!(summary(&store), bob_summary, "metadata survives reopen");
    let detail = store
        .get_conversation(&bob_summary.conversation_ref)
        .unwrap();
    assert_eq!(
        detail.reply_context, None,
        "sender metadata does not require reply eligibility"
    );
    assert_eq!(detail.messages.len(), 1, "HTML remains omitted");
    assert_eq!(detail.messages[0].body_text, "old plain");
    assert_eq!(detail.context_complete, Some(false));

    // Same newest message ID/body, changed From: history reconciliation must
    // replace the cached fact, including replacement with explicit unknown.
    refresh(&store, parsed(Some("Carol <carol@changed.test>"), false));
    assert_eq!(
        summary(&store).primary_correspondent.unwrap().mailbox,
        "carol@changed.test"
    );
    // A genuinely newer message wins even with a lexically smaller ID.
    let mut arrival: Value = serde_json::from_str(&body(Some("Bob <bob@new.test>"), true)).unwrap();
    arrival["messages"].as_array_mut().unwrap().push(json!({
        "id": "0", "internalDate": "3000", "labelIds": ["INBOX"],
        "payload": {"mimeType": "text/html", "headers": [
            {"name": "From", "value": "Dan <dan@arrival.test>"}],
            "body": {"data": "PGI+bmV3PC9iPg"}}
    }));
    refresh(
        &store,
        parse_thread("acct", "thread", &arrival.to_string()).unwrap(),
    );
    assert_eq!(
        summary(&store).primary_correspondent.unwrap().mailbox,
        "dan@arrival.test"
    );
    let mut duplicate: Value =
        serde_json::from_str(&body(Some("Bob <bob@new.test>"), false)).unwrap();
    duplicate["messages"][2]["payload"]["headers"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name": "From", "value": "Alice <alice@old.test>"}));
    let duplicate = parse_thread("acct", "thread", &duplicate.to_string()).unwrap();
    assert_eq!(duplicate.newest_sender, None);
    refresh(&store, duplicate);
    assert_eq!(summary(&store).primary_correspondent, None);
    for from in [
        None,
        Some("not a mailbox"),
        Some("Alice <alice@old.test>, Bob <bob@new.test>"),
        Some("Group: bob@new.test;"),
        Some("<@new.test>"),
    ] {
        let thread = parsed(from, true);
        assert_eq!(thread.newest_sender, None, "unusable From: {from:?}");
        refresh(&store, thread);
        assert_eq!(summary(&store).primary_correspondent, None);
    }
    let unknown_summary = summary(&store);
    drop(store);
    let store = GmailStore::open(&dir, Arc::new(SystemClock)).unwrap();
    assert_eq!(summary(&store), unknown_summary, "unknown survives reopen");

    // This checked-in wire fixture is also consumed by the TS membership test;
    // it is asserted against real parsed/stored native results, not display fakes.
    let actual = json!([bob_summary, unknown_summary]);
    let expected: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/newest-sender-summaries.json"
    ))
    .unwrap();
    assert_eq!(actual, expected);

    // Simulate an actual pre-metadata cache (no column), not a fake current row.
    refresh(&store, parsed(Some("Bob <bob@new.test>"), false));
    store
        .lock_conn()
        .unwrap()
        .execute_batch("ALTER TABLE gmail_conversations DROP COLUMN newest_sender_json")
        .unwrap();
    drop(store);
    let store = GmailStore::open(&dir, Arc::new(SystemClock)).unwrap();
    assert_eq!(
        summary(&store).primary_correspondent,
        None,
        "migration must not promote Alice"
    );
    refresh(&store, parsed(Some("Bob <bob@new.test>"), true));
    assert_eq!(
        summary(&store).primary_correspondent.unwrap().mailbox,
        "bob@new.test"
    );
    let mut foreign = parsed(Some("Other <other@foreign.test>"), false);
    foreign.conversation.conversation_ref.account_id = "foreign".into();
    assert_eq!(
        store.apply_history_page(
            &HistoryPage {
                changed_thread_ids: vec!["thread".into()],
                deleted_message_ids: vec![],
                next_page_token: None,
                history_id: "h4".into(),
            },
            &[ThreadFetch::Cached(Box::new(foreign))],
            "h3",
            store.generation().unwrap()
        ),
        Err(MailError::InvalidProviderResponse)
    );
    assert_eq!(
        summary(&store).primary_correspondent.unwrap().mailbox,
        "bob@new.test"
    );
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
