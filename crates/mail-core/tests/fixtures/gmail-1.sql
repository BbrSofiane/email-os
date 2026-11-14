-- Schema copied from the committed read-only Gmail store (106b1b0).
-- Its marker does not include operation, fact, reminder, or destination tables.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE gmail_conversations (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, subject TEXT NOT NULL,
  context_complete INTEGER NOT NULL CHECK (context_complete IN (0, 1)),
  unsupported_reason TEXT, PRIMARY KEY (account_id, conversation_id)
);
CREATE TABLE gmail_messages (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
  from_display TEXT, from_mailbox TEXT NOT NULL, to_json TEXT NOT NULL,
  sent_at TEXT NOT NULL, body_text TEXT NOT NULL,
  in_inbox INTEGER NOT NULL CHECK (in_inbox IN (0, 1)),
  PRIMARY KEY (account_id, conversation_id, message_id)
);
CREATE TABLE gmail_discovery_seen (conversation_id TEXT PRIMARY KEY);
CREATE TABLE gmail_inbox_membership (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
  PRIMARY KEY (account_id, conversation_id, message_id)
);
INSERT INTO meta VALUES ('schema_version', 'gmail-1');
INSERT INTO meta VALUES ('account_id', 'account-historical');
INSERT INTO meta VALUES ('email_address', 'historical@example.test');
INSERT INTO meta VALUES ('history_id', 'h-77');
INSERT INTO meta VALUES ('generation', '4');
INSERT INTO meta VALUES ('discovery_state', 'done');
INSERT INTO gmail_conversations VALUES
  ('account-historical', 'thread-legacy', 'Legacy subject', 1, NULL);
INSERT INTO gmail_messages VALUES
  ('account-historical', 'thread-legacy', 'message-legacy', 'Sender', 'sender@example.test',
   '[{"display_name":"Reader","mailbox":"reader@example.test"}]',
   '2024-03-04T10:00:00Z', 'legacy body', 1);
INSERT INTO gmail_inbox_membership VALUES
  ('account-historical', 'thread-legacy', 'message-legacy');
INSERT INTO gmail_discovery_seen VALUES ('thread-legacy');
