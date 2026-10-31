//! Synthetic fixture SQLite persistence and bounded local Done transport model.
use mail_core::dto::{CachedDoneRequest, ConversationRef, SetArchived};
use mail_core::{MailCore, MailError, ACCOUNT_ID};

#[test]
fn list_cached_done_fixture_persists_pending_archive_and_restores_after_restart() {
    let dir = std::env::temp_dir().join(format!("cached-done-fixture-{}", uuid::Uuid::new_v4()));
    let core = MailCore::open(&dir).unwrap();
    let mut request = CachedDoneRequest {
        account_id: ACCOUNT_ID.into(),
        limit: 1,
        cursor: None,
    };
    assert!(core
        .list_cached_done(&request)
        .unwrap()
        .conversations
        .is_empty());
    let inbox = core.list_conversations().unwrap();
    let first = inbox.conversations[0].conversation_ref.clone();
    let second = inbox.conversations[1].conversation_ref.clone();
    for (index, target) in [first.clone(), second.clone()].into_iter().enumerate() {
        core.set_archived(&SetArchived {
            conversation: target,
            archived: true,
            request_id: format!("archive-{index}"),
        })
        .unwrap();
    }
    drop(core);
    let core = MailCore::open(&dir).unwrap();
    let page = core.list_cached_done(&request).unwrap();
    assert_eq!(page.conversations.len(), 1);
    assert_eq!(page.conversations[0].conversation_ref, first);
    assert_eq!(page.exact_total, None);
    assert_eq!(page.last_synced_at, None);
    request.cursor = page.next_cursor;
    let page = core.list_cached_done(&request).unwrap();
    assert_eq!(page.conversations[0].conversation_ref, second);
    assert_eq!(page.next_cursor, None);
    assert!(!core.get_conversation(&first).unwrap().is_in_inbox);
    core.set_archived(&SetArchived {
        conversation: first.clone(),
        archived: false,
        request_id: "restore".into(),
    })
    .unwrap();
    request.cursor = None;
    let page = core.list_cached_done(&request).unwrap();
    assert!(page.conversations.is_empty());
    assert!(
        page.next_cursor.is_some(),
        "bounded candidate page can be empty"
    );
    request.limit = 100;
    assert_eq!(
        core.list_cached_done(&request).unwrap().conversations.len(),
        1
    );
    request.account_id = "foreign".into();
    assert_eq!(core.list_cached_done(&request), Err(MailError::NotFound));
    assert_eq!(
        core.get_conversation(&ConversationRef {
            account_id: "foreign".into(),
            ..first
        }),
        Err(MailError::NotFound)
    );
    request.account_id = ACCOUNT_ID.into();
    for limit in [0, 101] {
        request.limit = limit;
        assert!(
            matches!(core.list_cached_done(&request), Err(MailError::InvalidRequest { field }) if field == "limit")
        );
    }
    request.limit = 1;
    request.cursor = Some("malformed".into());
    assert!(
        matches!(core.list_cached_done(&request), Err(MailError::InvalidRequest { field }) if field == "cursor")
    );
    drop(core);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn list_cached_done_caps_large_sqlite_result_and_pages_equal_dates_by_id() {
    let dir = std::env::temp_dir().join(format!("cached-done-bounds-{}", uuid::Uuid::new_v4()));
    let core = MailCore::open(&dir).unwrap();
    let conn = rusqlite::Connection::open(dir.join("mail.db")).unwrap();
    for index in (0..137).rev() {
        let id = format!("bounded-{index:03}");
        conn.execute(
            "INSERT INTO conversations VALUES (?1, ?2, 'synthetic bounded')",
            rusqlite::params![ACCOUNT_ID, id],
        )
        .unwrap();
        conn.execute("INSERT INTO messages SELECT account_id, ?1, ?1, from_display, from_mailbox, to_json, '2026-04-01T00:00:00Z', body_text, 1 FROM messages WHERE account_id = ?2 LIMIT 1", rusqlite::params![id, ACCOUNT_ID]).unwrap();
        core.set_archived(&SetArchived {
            conversation: ConversationRef {
                account_id: ACCOUNT_ID.into(),
                conversation_id: id.clone(),
            },
            archived: true,
            request_id: id,
        })
        .unwrap();
    }
    let mut request = CachedDoneRequest {
        account_id: ACCOUNT_ID.into(),
        limit: 100,
        cursor: None,
    };
    let first = core.list_cached_done(&request).unwrap();
    assert_eq!(first.conversations.len(), 100);
    assert_eq!(
        first.conversations[0].conversation_ref.conversation_id,
        "bounded-000"
    );
    assert_eq!(
        first.conversations[99].conversation_ref.conversation_id,
        "bounded-099"
    );
    request.cursor = first.next_cursor;
    let second = core.list_cached_done(&request).unwrap();
    assert_eq!(second.conversations.len(), 37);
    assert_eq!(
        second.conversations[0].conversation_ref.conversation_id,
        "bounded-100"
    );
    assert_eq!(second.next_cursor, None);
    drop(conn);
    drop(core);
    std::fs::remove_dir_all(dir).unwrap();
}
