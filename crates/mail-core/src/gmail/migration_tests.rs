//! Regression coverage for databases captured from committed Gmail store revisions.
//!
//! This module is included by `store.rs` so it can exercise the private store API.

use super::*;
use crate::clock::SystemClock;
use crate::testing::temp_profile;
use rusqlite::types::Value;
use rusqlite::Connection;

fn load_fixture(dir: &Path, fixture: &str) {
    let conn = Connection::open(dir.join("gmail.db")).expect("open fixture database");
    conn.execute_batch(fixture)
        .expect("load committed schema fixture");
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )
    .expect("check historical table")
}

fn insert_historical_row(conn: &Connection, table: &str, fields: &[(&str, Value)]) {
    if !table_exists(conn, table) {
        return;
    }
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .expect("prepare historical columns");
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query historical columns")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect historical columns");
    let selected = fields
        .iter()
        .filter(|(name, _)| columns.iter().any(|column| column == name))
        .collect::<Vec<_>>();
    let names = selected
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = std::iter::repeat("?")
        .take(selected.len())
        .collect::<Vec<_>>()
        .join(", ");
    // Fixtures already carry a schema_version row; the seed overrides meta values.
    let verb = if table == "meta" {
        "INSERT OR REPLACE"
    } else {
        "INSERT"
    };
    let sql = format!("{verb} INTO {table} ({names}) VALUES ({placeholders})");
    let values = selected
        .iter()
        .map(|(_, value)| (*value).clone())
        .collect::<Vec<_>>();
    conn.execute(&sql, rusqlite::params_from_iter(values))
        .unwrap_or_else(|error| panic!("seed historical {table}: {error}"));
}

fn text(value: &str) -> Value {
    Value::Text(value.to_string())
}

fn nullable_text(value: Option<&str>) -> Value {
    value.map_or(Value::Null, text)
}

fn integer(value: i64) -> Value {
    Value::Integer(value)
}

fn seeded_conversation() -> crate::dto::Conversation {
    let reference = crate::dto::ConversationRef {
        account_id: "account-historical".to_string(),
        conversation_id: "thread-seeded".to_string(),
    };
    crate::dto::Conversation {
        stars: None,
        conversation_ref: reference,
        subject: "Historical subject".to_string(),
        messages: vec![crate::dto::Message {
            id: "m-seeded".to_string(),
            from: crate::dto::Address {
                display_name: Some("Sender".to_string()),
                mailbox: "sender@example.test".to_string(),
            },
            to: vec![crate::dto::Address {
                display_name: Some("Reader".to_string()),
                mailbox: "reader@example.test".to_string(),
            }],
            sent_at: "2024-04-05T10:00:00Z".to_string(),
            body_text: "durable historical body".to_string(),
            has_attachment: None,
        }],
        is_in_inbox: true,
        is_read: None,
        context_complete: Some(true),
        unsupported_reason: None,
        retained_snapshot_at: Some("2024-04-05T10:00:00Z".to_string()),
        reply_context: Some(crate::drafts::types::ReplyContext {
            source_message_id: "m-seeded".to_string(),
            from_mailbox: "sender@example.test".to_string(),
            reply_to_mailboxes: Some(vec!["reply@example.test".to_string()]),
            message_id: "<m-seeded@example.test>".to_string(),
            references: vec!["<m-parent@example.test>".to_string()],
        }),
        pending_operation_id: None,
    }
}

fn serialized_conversation() -> String {
    serde_json::to_string(&seeded_conversation()).expect("serialize valid retained conversation")
}

fn serialized_reminder() -> String {
    serde_json::to_string(&crate::reminders::Reminder {
        conversation: crate::dto::ConversationRef {
            account_id: "account-historical".to_string(),
            conversation_id: "thread-seeded".to_string(),
        },
        subject: "Historical subject".to_string(),
        revision: 3,
        source_message_id: "m-seeded".to_string(),
        due_at: Some("2030-01-01T00:00:00Z".to_string()),
        condition: crate::reminders::ReminderCondition::IfNoReply,
        phase: crate::reminders::ReminderPhase::Pending,
    })
    .expect("serialize valid reminder")
}

fn seed_historical_rows(dir: &Path, marker: &str) {
    let conn = Connection::open(dir.join("gmail.db")).expect("open historical database to seed");
    insert_historical_row(
        &conn,
        "meta",
        &[("key", text("schema_version")), ("value", text(marker))],
    );
    for (key, value) in [
        ("account_id", "account-historical"),
        ("email_address", "historical@example.test"),
        ("history_id", "h-900"),
        ("generation", "21"),
        ("discovery_state", "done"),
    ] {
        insert_historical_row(&conn, "meta", &[("key", text(key)), ("value", text(value))]);
    }
    let split = crate::splits::SavedSplit {
        name: "Clients".to_string(),
        criterion: crate::splits::SplitCriterion::Domain,
        value: "example.test".to_string(),
        enabled: true,
        hide_when_empty: true,
    };
    insert_historical_row(
        &conn,
        "meta",
        &[
            ("key", text("saved_split:account-historical")),
            (
                "value",
                text(&serde_json::to_string(&split).expect("serialize saved split")),
            ),
        ],
    );
    insert_historical_row(
        &conn,
        "gmail_conversations",
        &[
            ("account_id", text("account-historical")),
            ("conversation_id", text("thread-seeded")),
            ("subject", text("Historical subject")),
            ("context_complete", integer(1)),
            ("unsupported_reason", Value::Null),
            (
                "reply_context_json",
                nullable_text(Some(
                    &serde_json::to_string(
                        seeded_conversation()
                            .reply_context
                            .as_ref()
                            .expect("reply context"),
                    )
                    .expect("serialize reply context"),
                )),
            ),
            ("attachments_json", nullable_text(Some("[]"))),
            (
                "newest_sender_json",
                nullable_text(Some("{\"mailbox\":\"sender@example.test\"}")),
            ),
        ],
    );
    insert_historical_row(
        &conn,
        "gmail_messages",
        &[
            ("account_id", text("account-historical")),
            ("conversation_id", text("thread-seeded")),
            ("message_id", text("m-seeded")),
            ("from_display", nullable_text(Some("Sender"))),
            ("from_mailbox", text("sender@example.test")),
            (
                "to_json",
                text("[{\"displayName\":\"Reader\",\"mailbox\":\"reader@example.test\"}]"),
            ),
            ("sent_at", text("2024-04-05T10:00:00Z")),
            ("body_text", text("durable historical body")),
            ("in_inbox", integer(1)),
            ("has_attachment", nullable_text(None)),
        ],
    );
    insert_historical_row(
        &conn,
        "gmail_discovery_seen",
        &[("conversation_id", text("thread-seeded"))],
    );
    insert_historical_row(
        &conn,
        "gmail_inbox_membership",
        &[
            ("account_id", text("account-historical")),
            ("conversation_id", text("thread-seeded")),
            ("message_id", text("m-seeded")),
        ],
    );
    insert_historical_row(
        &conn,
        "gmail_message_facts",
        &[
            ("account_id", text("account-historical")),
            ("conversation_id", text("thread-seeded")),
            ("message_id", text("m-seeded")),
            ("in_inbox", integer(1)),
            ("is_unread", Value::Null),
            ("is_starred", Value::Null),
            ("in_trash", Value::Null),
            ("in_spam", Value::Null),
        ],
    );

    for (index, (id, status, failure, last_error)) in [
        ("op-queued", "queued", None, None),
        ("op-applying", "applying", None, Some("lost response")),
        ("op-confirmed", "confirmed", None, None),
        (
            "op-failed",
            "failed",
            Some("provider_error"),
            Some("retryable"),
        ),
        (
            "op-unknown",
            "outcome_unknown",
            None,
            Some("unknown response"),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        insert_historical_row(
            &conn,
            "gmail_operations",
            &[
                ("account_id", text("account-historical")),
                ("operation_id", text(id)),
                ("conversation_id", text("thread-seeded")),
                ("kind", text("archive")),
                ("requested_value", integer(1)),
                ("status", text(status)),
                ("failure", nullable_text(failure)),
                ("last_error", nullable_text(last_error)),
                ("accepted_seq", integer(index as i64 + 1)),
                ("accepted_at", text("2024-04-05T10:01:00Z")),
                ("request_id", text(&format!("request-{id}"))),
                ("undo_of", nullable_text(None)),
                ("action_id", nullable_text(None)),
                ("retry_of", nullable_text(None)),
            ],
        );
        insert_historical_row(
            &conn,
            "gmail_operation_targets",
            &[
                ("account_id", text("account-historical")),
                ("operation_id", text(id)),
                ("conversation_id", text("thread-seeded")),
                ("message_id", text("m-seeded")),
            ],
        );
        insert_historical_row(
            &conn,
            "gmail_operation_requests",
            &[
                ("account_id", text("account-historical")),
                ("request_id", text(&format!("request-{id}"))),
                ("payload", text("{\"action\":\"archive\"}")),
                ("operation_id", text(id)),
                ("accepted_at", nullable_text(None)),
            ],
        );
    }
    insert_historical_row(
        &conn,
        "gmail_operation_preimages",
        &[
            ("account_id", text("account-historical")),
            ("operation_id", text("op-queued")),
            ("message_id", text("m-seeded")),
            ("prior_value", integer(1)),
        ],
    );
    insert_historical_row(
        &conn,
        "gmail_operation_snapshots",
        &[
            ("account_id", text("account-historical")),
            ("conversation_id", text("thread-seeded")),
            ("snapshot_json", text(&serialized_conversation())),
            ("snapshot_saved_at", text("2024-04-05T10:00:00Z")),
            ("last_message_at", text("2024-04-05T10:00:00Z")),
        ],
    );
    insert_historical_row(
        &conn,
        "gmail_operation_groups",
        &[
            ("group_id", text("group-seeded")),
            ("account_id", text("account-historical")),
            ("request_id", text("group-request")),
            ("kind", text("archive")),
            ("requested_value", integer(1)),
            ("accepted_at", text("2024-04-05T10:01:00Z")),
            ("undone_at", nullable_text(None)),
            ("group_seq", integer(1)),
        ],
    );
    insert_historical_row(
        &conn,
        "gmail_operation_group_members",
        &[
            ("account_id", text("account-historical")),
            ("group_id", text("group-seeded")),
            ("ordinal", integer(0)),
            ("conversation_id", text("thread-seeded")),
            ("operation_id", nullable_text(Some("op-queued"))),
            ("rejection", nullable_text(None)),
            ("undo_decision", nullable_text(None)),
            ("undo_skip_reason", nullable_text(None)),
            ("undo_operation_ids", nullable_text(None)),
        ],
    );
    insert_historical_row(
        &conn,
        "gmail_destination_snapshots",
        &[
            ("account_id", text("account-historical")),
            ("destination_id", text("done")),
            (
                "snapshot_json",
                text(
                    &serde_json::to_string(&crate::gmail::browsing::DestinationPage {
                        account_id: "account-historical".to_string(),
                        destination_id: "done".to_string(),
                        conversations: vec![seeded_conversation()],
                        next_cursor: None,
                        fetched_at: "2024-04-05T10:00:00Z".to_string(),
                    })
                    .expect("serialize destination page"),
                ),
            ),
        ],
    );
    insert_historical_row(
        &conn,
        "gmail_reminders",
        &[
            ("account_id", text("account-historical")),
            ("conversation_id", text("thread-seeded")),
            ("data", text(&serialized_reminder())),
            ("baseline_ids", text("[\"m-seeded\"]")),
            ("snapshot_json", text(&serialized_conversation())),
        ],
    );
    insert_historical_row(
        &conn,
        "gmail_reminder_requests",
        &[
            ("account_id", text("account-historical")),
            ("request_id", text("reminder-request")),
            (
                "payload",
                text(
                    &serde_json::to_string(&crate::reminders::PutReminder {
                        conversation: crate::dto::ConversationRef {
                            account_id: "account-historical".to_string(),
                            conversation_id: "thread-seeded".to_string(),
                        },
                        source_message_id: "m-seeded".to_string(),
                        due_at: Some("2030-01-01T00:00:00Z".to_string()),
                        condition: crate::reminders::ReminderCondition::IfNoReply,
                        expected_revision: Some(2),
                        request_id: "reminder-request".to_string(),
                    })
                    .expect("serialize reminder request"),
                ),
            ),
            ("receipt", text(&serialized_reminder())),
        ],
    );
    insert_historical_row(
        &conn,
        "gmail_search_cache",
        &[
            ("account_id", text("account-historical")),
            ("conversation_id", text("thread-seeded")),
            ("seq", integer(7)),
        ],
    );
}

fn read_meta(conn: &Connection, key: &str) -> String {
    conn.query_row("SELECT value FROM meta WHERE key=?1", [key], |row| {
        row.get(0)
    })
    .expect("read metadata")
}

fn schema_rows(conn: &Connection) -> Vec<(String, String, String, String)> {
    let mut statement = conn
        .prepare(
            "SELECT type, name, tbl_name, COALESCE(sql, '') FROM sqlite_master ORDER BY type, name",
        )
        .expect("prepare schema query");
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .expect("query schema")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect schema")
}

fn split_table_clauses(sql: &str) -> Vec<String> {
    let start = sql.find('(').expect("table definition opening parenthesis");
    let mut depth = 0_i32;
    let mut clause_start = start + 1;
    let mut clauses = Vec::new();
    for (offset, ch) in sql
        .char_indices()
        .skip_while(|(offset, _)| *offset <= start)
    {
        match ch {
            '(' => depth += 1,
            ')' if depth == 0 => {
                let clause = sql[clause_start..offset]
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                if !clause.is_empty() {
                    clauses.push(clause);
                }
                break;
            }
            ')' => depth -= 1,
            ',' if depth == 0 => {
                let clause = sql[clause_start..offset]
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                clauses.push(clause);
                clause_start = offset + 1;
            }
            _ => {}
        }
    }
    clauses.sort();
    clauses
}

fn semantic_schema(conn: &Connection) -> Vec<(String, String, String, Vec<String>)> {
    schema_rows(conn)
        .into_iter()
        .map(|(kind, name, table, sql)| {
            let definition = if kind == "table" && !sql.is_empty() {
                split_table_clauses(&sql)
            } else {
                vec![sql.split_whitespace().collect::<Vec<_>>().join(" ")]
            };
            (kind, name, table, definition)
        })
        .collect()
}

fn columns_for(conn: &Connection, table: &str) -> Vec<String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .expect("prepare table columns");
    statement
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query table columns")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect table columns")
}

type RowSnapshot = Vec<(String, Vec<String>, Vec<Vec<Value>>)>;

/// Snapshots durable rows. With `shape`, only the tables and columns that existed in that
/// earlier snapshot are read, so columns and tables added by migration do not count as changes.
fn historical_row_snapshot(conn: &Connection, shape: Option<&RowSnapshot>) -> RowSnapshot {
    let tables = schema_rows(conn)
        .into_iter()
        .filter(|(kind, name, _, _)| kind == "table" && !name.starts_with("sqlite_"))
        .map(|(_, name, _, _)| name)
        .filter(|name| shape.map_or(true, |shape| shape.iter().any(|(t, _, _)| t == name)))
        .collect::<Vec<_>>();
    let mut snapshot = Vec::new();
    for table in tables {
        let columns = columns_for(conn, &table)
            .into_iter()
            .filter(|column| {
                shape.map_or(true, |shape| {
                    shape
                        .iter()
                        .any(|(t, cols, _)| *t == table && cols.contains(column))
                })
            })
            .collect::<Vec<_>>();
        let selected = columns
            .iter()
            .filter(|column| {
                !(table == "meta" && *column == "value")
                    && !(table == "gmail_operations"
                        && matches!(column.as_str(), "status" | "last_error" | "action_id"))
            })
            .cloned()
            .collect::<Vec<_>>();
        let selected_sql = selected.join(", ");
        let mut statement = conn
            .prepare(&format!("SELECT {selected_sql} FROM {table}"))
            .expect("prepare legacy row snapshot");
        let mut rows = statement
            .query_map([], |row| {
                (0..selected.len())
                    .map(|index| row.get::<_, Value>(index))
                    .collect::<Result<Vec<_>, _>>()
            })
            .expect("query legacy rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect legacy rows");
        if table == "meta" {
            let value_index = selected.iter().position(|column| column == "key");
            if let Some(index) = value_index {
                rows.retain(|row| {
                    row.get(index) != Some(&Value::Text("schema_version".to_string()))
                });
            }
        }
        rows.sort_by_key(|row| format!("{row:?}"));
        snapshot.push((table, selected, rows));
    }
    snapshot
}

#[test]
fn authentic_gmail_1_profile_migrates_without_losing_cached_meaning() {
    let dir = temp_profile("gmail-1-migration");
    load_fixture(dir.path(), include_str!("../../tests/fixtures/gmail-1.sql"));

    let store = GmailStore::open(dir.path(), Arc::new(SystemClock)).expect("migrate gmail-1");
    let conn = store.lock_conn().expect("lock migrated store");
    assert_eq!(read_meta(&conn, "schema_version"), SCHEMA_VERSION);
    assert_eq!(read_meta(&conn, "account_id"), "account-historical");
    assert_eq!(read_meta(&conn, "email_address"), "historical@example.test");
    assert_eq!(read_meta(&conn, "history_id"), "h-77");
    assert_eq!(read_meta(&conn, "generation"), "4");
    assert_eq!(
        conn.query_row(
            "SELECT body_text FROM gmail_messages WHERE message_id='message-legacy'",
            [],
            |row| row.get::<_, String>(0),
        )
        .expect("cached body"),
        "legacy body"
    );
    let fact: (
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
    ) = conn
        .query_row(
            "SELECT in_inbox, is_unread, is_starred, in_trash, in_spam
             FROM gmail_message_facts WHERE message_id='message-legacy'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("backfilled facts");
    assert_eq!(fact, (Some(1), None, None, None, None));
    let attachment_fact: Option<i64> = conn
        .query_row(
            "SELECT has_attachment FROM gmail_messages WHERE message_id='message-legacy'",
            [],
            |row| row.get(0),
        )
        .expect("attachment fact");
    assert_eq!(attachment_fact, None, "legacy unknown stays unknown");
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM gmail_inbox_membership", [], |row| row
            .get::<_, i64>(0))
            .expect("membership count"),
        1
    );
}

#[test]
fn authentic_gmail_2_operations_profile_preserves_durable_rows_and_recovers_applying() {
    let dir = temp_profile("gmail-2-operations-migration");
    load_fixture(
        dir.path(),
        include_str!("../../tests/fixtures/gmail-2-operations.sql"),
    );

    let store = GmailStore::open(dir.path(), Arc::new(SystemClock)).expect("migrate gmail-2");
    let conn = store.lock_conn().expect("lock migrated store");
    assert_eq!(read_meta(&conn, "schema_version"), SCHEMA_VERSION);
    assert_eq!(read_meta(&conn, "history_id"), "h-105");
    let mut statement = conn
        .prepare("SELECT operation_id, status, last_error, action_id FROM gmail_operations ORDER BY operation_id")
        .expect("prepare operation query");
    let operations = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .expect("query operations")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect operations");
    assert_eq!(operations.len(), 5);
    assert_eq!(
        operations[0],
        (
            "op-applying".into(),
            "outcome_unknown".into(),
            None,
            Some("op-applying".into())
        )
    );
    assert_eq!(
        operations[1],
        (
            "op-confirmed".into(),
            "confirmed".into(),
            None,
            Some("op-confirmed".into())
        )
    );
    assert_eq!(
        operations[2],
        (
            "op-failed".into(),
            "failed".into(),
            Some("retryable failure".into()),
            Some("op-failed".into())
        )
    );
    assert_eq!(
        operations[3],
        (
            "op-queued".into(),
            "queued".into(),
            None,
            Some("op-queued".into())
        )
    );
    assert_eq!(
        operations[4],
        (
            "op-unknown".into(),
            "outcome_unknown".into(),
            Some("provider response lost".into()),
            Some("op-unknown".into())
        )
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM gmail_operation_targets", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("operation targets"),
        5
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM gmail_operation_preimages",
            [],
            |row| row.get::<_, i64>(0)
        )
        .expect("operation preimages"),
        1
    );
    let last_message_at: String = conn
        .query_row(
            "SELECT last_message_at FROM gmail_operation_snapshots WHERE conversation_id='thread-ops'",
            [],
            |row| row.get(0),
        )
        .expect("retained operation snapshot");
    assert_eq!(last_message_at, "2024-03-05T10:00:00Z");
}

#[test]
fn historical_gmail_2_shapes_preserve_their_durable_rows_and_reach_golden_schema() {
    let fixtures = [
        (
            "gmail-3",
            include_str!("../../tests/fixtures/gmail-legacy/gmail-3.sql"),
        ),
        (
            "gmail-4",
            include_str!("../../tests/fixtures/gmail-legacy/gmail-4.sql"),
        ),
        (
            "gmail-6",
            include_str!("../../tests/fixtures/gmail-legacy/gmail-6.sql"),
        ),
        (
            "gmail-8",
            include_str!("../../tests/fixtures/gmail-legacy/gmail-8.sql"),
        ),
        (
            "gmail-9",
            include_str!("../../tests/fixtures/gmail-legacy/gmail-9.sql"),
        ),
        (
            "gmail-10",
            include_str!("../../tests/fixtures/gmail-legacy/gmail-10.sql"),
        ),
        (
            "gmail-11",
            include_str!("../../tests/fixtures/gmail-legacy/gmail-11.sql"),
        ),
        (
            "gmail-12",
            include_str!("../../tests/fixtures/gmail-legacy/gmail-12.sql"),
        ),
        (
            "gmail-13",
            include_str!("../../tests/fixtures/gmail-legacy/gmail-13.sql"),
        ),
        (
            "gmail-14",
            include_str!("../../tests/fixtures/gmail-legacy/gmail-14.sql"),
        ),
        (
            "gmail-15",
            include_str!("../../tests/fixtures/gmail-legacy/gmail-15.sql"),
        ),
        (
            "gmail-16",
            include_str!("../../tests/fixtures/gmail-legacy/gmail-16.sql"),
        ),
    ];
    let golden = include_str!("../../tests/fixtures/gmail-current-schema.txt")
        .lines()
        .map(|line| {
            let mut fields = line.splitn(4, '|');
            (
                fields.next().expect("type").to_string(),
                fields.next().expect("name").to_string(),
                fields.next().expect("table name").to_string(),
                fields.next().expect("SQL").to_string(),
            )
        })
        .collect::<Vec<_>>();
    let golden_conn = Connection::open_in_memory().expect("open schema comparison db");
    for (_, _, _, sql) in &golden {
        if !sql.is_empty() {
            golden_conn
                .execute_batch(&format!("{sql};"))
                .expect("create golden schema");
        }
    }
    let golden_schema = semantic_schema(&golden_conn);

    for (tag, fixture) in fixtures {
        let dir = temp_profile(&format!("{tag}-migration"));
        load_fixture(dir.path(), fixture);
        seed_historical_rows(dir.path(), "gmail-2");
        let path = dir.path().join("gmail.db");
        let before = Connection::open(&path).expect("open seeded historical profile");
        let before_rows = historical_row_snapshot(&before, None);
        drop(before);

        let store = GmailStore::open(dir.path(), Arc::new(SystemClock))
            .unwrap_or_else(|error| panic!("{tag} failed to migrate: {error:?}"));
        let conn = store.lock_conn().expect("lock migrated historical profile");
        assert_eq!(read_meta(&conn, "schema_version"), SCHEMA_VERSION, "{tag}");
        assert_eq!(
            read_meta(&conn, "account_id"),
            "account-historical",
            "{tag}"
        );
        assert_eq!(read_meta(&conn, "history_id"), "h-900", "{tag}");
        assert_eq!(
            historical_row_snapshot(&conn, Some(&before_rows)),
            before_rows,
            "historical rows changed: {tag}"
        );
        let mut migrated_schema = semantic_schema(&conn);
        // Justified difference: revisions gmail-9..=12 added `is_starred` with a CHECK that
        // SQLite cannot drop with ALTER TABLE; main's probes never rebuilt the table either.
        if matches!(tag, "gmail-9" | "gmail-10" | "gmail-11" | "gmail-12") {
            for (_, name, _, clauses) in &mut migrated_schema {
                if name == "gmail_message_facts" {
                    for clause in clauses.iter_mut() {
                        if clause == "is_starred INTEGER CHECK (is_starred IN (0,1))" {
                            *clause = "is_starred INTEGER".to_string();
                        }
                    }
                }
            }
        }
        let only_migrated = migrated_schema
            .iter()
            .filter(|entry| !golden_schema.contains(entry))
            .collect::<Vec<_>>();
        let only_golden = golden_schema
            .iter()
            .filter(|entry| !migrated_schema.contains(entry))
            .collect::<Vec<_>>();
        assert!(
            only_migrated.is_empty() && only_golden.is_empty(),
            "schema differs from golden: {tag}\nonly migrated: {only_migrated:#?}\nonly golden: {only_golden:#?}"
        );

        let applying_status: String = conn
            .query_row(
                "SELECT status FROM gmail_operations WHERE operation_id='op-applying'",
                [],
                |row| row.get(0),
            )
            .expect("read applying status");
        assert_eq!(applying_status, "outcome_unknown", "{tag}");
        // action_id is a derived default the original probe-driven migration also backfilled.
        let unbackfilled: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM gmail_operations
                 WHERE undo_of IS NULL AND (action_id IS NULL OR action_id <> operation_id)",
                [],
                |row| row.get(0),
            )
            .expect("count unbackfilled action ids");
        assert_eq!(unbackfilled, 0, "action ids backfilled: {tag}");
        let operation_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM gmail_operations", [], |row| {
                row.get(0)
            })
            .expect("count retained operations");
        assert_eq!(operation_count, 5, "all operation statuses survive: {tag}");
        let group_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM gmail_operation_groups", [], |row| {
                row.get(0)
            })
            .expect("count retained groups");
        // Shapes older than the groups table cannot hold a group; the migration must not invent one.
        let expected_groups = before_rows
            .iter()
            .find(|(table, _, _)| table == "gmail_operation_groups")
            .map_or(0, |(_, _, rows)| rows.len());
        assert_eq!(group_count as usize, expected_groups, "groups: {tag}");
        drop(conn);
        let had_table = |name: &str| before_rows.iter().any(|(table, _, _)| table == name);
        let reminder = store.list_reminders().expect("decode retained reminder");
        if had_table("gmail_reminders") {
            assert_eq!(reminder.len(), 1, "{tag}");
            assert_eq!(
                reminder[0],
                serde_json::from_str(&serialized_reminder()).unwrap()
            );
        } else {
            assert!(reminder.is_empty(), "no reminder is invented: {tag}");
        }
        let conn = Connection::open(&path).expect("open migrated database for saved split");
        let split = crate::splits::get(&conn, "account-historical")
            .expect("decode saved split")
            .expect("saved split survives");
        assert_eq!(split.name, "Clients", "{tag}");
        drop(conn);
        let destination = store
            .destination_snapshot("account-historical", "done")
            .expect("read destination snapshot");
        if had_table("gmail_destination_snapshots") {
            let destination: crate::gmail::browsing::DestinationPage =
                serde_json::from_str(&destination.expect("destination snapshot survives"))
                    .expect("decode destination snapshot");
            assert_eq!(
                destination.conversations,
                vec![seeded_conversation()],
                "{tag}"
            );
        } else {
            assert!(destination.is_none(), "no snapshot is invented: {tag}");
        }
        let conversation = store
            .get_conversation(&crate::dto::ConversationRef {
                account_id: "account-historical".to_string(),
                conversation_id: "thread-seeded".to_string(),
            })
            .expect("read retained conversation and reply context");
        assert_eq!(
            conversation.reply_context,
            seeded_conversation().reply_context,
            "{tag}"
        );
        let conn = Connection::open(&path).expect("open migrated database for operation snapshot");
        let snapshot: String = conn
            .query_row(
                "SELECT snapshot_json FROM gmail_operation_snapshots WHERE conversation_id='thread-seeded'",
                [],
                |row| row.get(0),
            )
            .expect("read retained operation snapshot");
        let snapshot: crate::dto::Conversation =
            serde_json::from_str(&snapshot).expect("decode operation snapshot");
        assert_eq!(snapshot, seeded_conversation(), "{tag}");
    }
}

#[test]
fn unsupported_schema_marker_fails_without_mutation() {
    let dir = temp_profile("future-schema");
    load_fixture(dir.path(), include_str!("../../tests/fixtures/gmail-1.sql"));
    let path = dir.path().join("gmail.db");
    let before = schema_rows(&Connection::open(&path).expect("open fixture"));
    Connection::open(&path)
        .expect("open fixture to set future marker")
        .execute(
            "UPDATE meta SET value='gmail-migrations-999' WHERE key='schema_version'",
            [],
        )
        .expect("write unsupported marker");
    let before_failure = schema_rows(&Connection::open(&path).expect("reopen fixture"));

    assert!(GmailStore::open(dir.path(), Arc::new(SystemClock)).is_err());
    let after = schema_rows(&Connection::open(&path).expect("reopen after failure"));
    assert_eq!(after, before_failure);
    assert_eq!(
        before, before_failure,
        "the version marker does not alter sqlite_master"
    );
    assert_eq!(
        read_meta(
            &Connection::open(&path).expect("open future fixture"),
            "schema_version"
        ),
        "gmail-migrations-999"
    );
}

#[test]
fn failed_migration_stage_rolls_back_and_reentry_completes_once() {
    let dir = temp_profile("migration-stage-rollback");
    load_fixture(
        dir.path(),
        include_str!("../../tests/fixtures/gmail-2-operations.sql"),
    );
    let path = dir.path().join("gmail.db");
    let mut conn = Connection::open(&path).expect("open historical database");
    let error = schema::migrate_with_hook(&mut conn, |version| {
        if version == 5 {
            Err(MailError::StorageUnavailable)
        } else {
            Ok(())
        }
    });
    assert!(error.is_err(), "injected stage failure is surfaced");
    assert_eq!(read_meta(&conn, "schema_version"), "gmail-migrations-4");
    let after_rollback = schema_rows(&conn);
    drop(conn);

    let mut conn = Connection::open(&path).expect("reopen historical database");
    schema::migrate(&mut conn).expect("resume migrations");
    assert_eq!(read_meta(&conn, "schema_version"), SCHEMA_VERSION);
    assert_eq!(
        conn.query_row(
            "SELECT status FROM gmail_operations WHERE operation_id='op-applying'",
            [],
            |row| row.get::<_, String>(0),
        )
        .expect("migration does not perform startup recovery"),
        "applying"
    );
    assert_ne!(schema_rows(&conn), after_rollback);
    drop(conn);

    let store = GmailStore::open(dir.path(), Arc::new(SystemClock)).expect("startup recovery");
    let conn = store.lock_conn().expect("lock recovered store");
    let applying_status: String = conn
        .query_row(
            "SELECT status FROM gmail_operations WHERE operation_id='op-applying'",
            [],
            |row| row.get(0),
        )
        .expect("read recovered status");
    assert_eq!(applying_status, "outcome_unknown");
}

#[test]
fn opening_a_current_profile_again_does_not_change_its_schema_or_rows() {
    let dir = temp_profile("current-schema-reopen");
    load_fixture(
        dir.path(),
        include_str!("../../tests/fixtures/gmail-2-operations.sql"),
    );
    let first = GmailStore::open(dir.path(), Arc::new(SystemClock)).expect("initial migration");
    drop(first);
    let path = dir.path().join("gmail.db");
    let before = Connection::open(&path).expect("open migrated db");
    let before_schema = schema_rows(&before);
    let before_messages = before
        .query_row("SELECT COUNT(*) FROM gmail_messages", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("count messages");
    drop(before);

    let reopened =
        GmailStore::open(dir.path(), Arc::new(SystemClock)).expect("reopen current profile");
    assert_eq!(
        reopened
            .lock_conn()
            .expect("lock reopened profile")
            .total_changes(),
        0,
        "current-profile open must not write schema or row data"
    );
    drop(reopened);
    let after = Connection::open(&path).expect("open reopened db");
    assert_eq!(schema_rows(&after), before_schema);
    assert_eq!(
        after
            .query_row("SELECT COUNT(*) FROM gmail_messages", [], |row| row
                .get::<_, i64>(0))
            .expect("count messages after reopen"),
        before_messages
    );
}
