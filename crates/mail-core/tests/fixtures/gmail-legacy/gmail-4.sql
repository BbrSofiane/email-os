-- Effective historical schema from 7cc2131, crates/mail-core/src/gmail/store.rs.
-- Synthetic schema only; no mailbox rows. Marker remains gmail-2.
CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
CREATE TABLE IF NOT EXISTS gmail_conversations (
                account_id         TEXT NOT NULL,
                conversation_id    TEXT NOT NULL,
                subject            TEXT NOT NULL,
                context_complete   INTEGER NOT NULL CHECK (context_complete IN (0, 1)),
                unsupported_reason TEXT,
                reply_context_json  TEXT,
                PRIMARY KEY (account_id, conversation_id)
            );
CREATE TABLE IF NOT EXISTS gmail_messages (
                account_id      TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                message_id      TEXT NOT NULL,
                from_display    TEXT,
                from_mailbox    TEXT NOT NULL,
                to_json         TEXT NOT NULL,
                sent_at         TEXT NOT NULL,
                body_text       TEXT NOT NULL,
                in_inbox        INTEGER NOT NULL CHECK (in_inbox IN (0, 1)),
                PRIMARY KEY (account_id, conversation_id, message_id)
            );
CREATE TABLE IF NOT EXISTS gmail_discovery_seen (
                conversation_id TEXT PRIMARY KEY
            );
CREATE TABLE IF NOT EXISTS gmail_inbox_membership (
                account_id      TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                message_id      TEXT NOT NULL,
                PRIMARY KEY (account_id, conversation_id, message_id)
            );
CREATE TABLE IF NOT EXISTS gmail_message_facts (
                account_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                in_inbox INTEGER,
                is_unread INTEGER,
                PRIMARY KEY (account_id, conversation_id, message_id)
            );
CREATE TABLE IF NOT EXISTS gmail_operations (
                account_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                requested_value INTEGER NOT NULL,
                status TEXT NOT NULL,
                failure TEXT,
                last_error TEXT,
                accepted_seq INTEGER NOT NULL,
                accepted_at TEXT NOT NULL,
                request_id TEXT NOT NULL,
                PRIMARY KEY (account_id, operation_id)
            );
CREATE TABLE IF NOT EXISTS gmail_operation_targets (
                account_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                PRIMARY KEY (account_id, operation_id, message_id)
            );
CREATE TABLE IF NOT EXISTS gmail_operation_requests (
                account_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                accepted_at TEXT,
                PRIMARY KEY (account_id, request_id)
            );
CREATE TABLE IF NOT EXISTS gmail_operation_preimages (
                account_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                prior_value INTEGER NULL CHECK (prior_value IN (0, 1)),
                PRIMARY KEY (account_id, operation_id, message_id)
            );
CREATE TABLE IF NOT EXISTS gmail_operation_snapshots (
                account_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                snapshot_saved_at TEXT NOT NULL,
                PRIMARY KEY (account_id, conversation_id)
            );
ALTER TABLE gmail_operation_snapshots ADD COLUMN last_message_at TEXT NOT NULL DEFAULT '';
ALTER TABLE gmail_operations ADD COLUMN undo_of TEXT;
INSERT INTO meta VALUES ('schema_version','gmail-2');
