-- Intermediate gmail-2 schema copied from commit b53f3c8.
-- Later gmail-2 commits add columns and tables while retaining this marker.
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
CREATE TABLE gmail_message_facts (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
  in_inbox INTEGER, is_unread INTEGER,
  PRIMARY KEY (account_id, conversation_id, message_id)
);
CREATE TABLE gmail_operations (
  account_id TEXT NOT NULL, operation_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL, requested_value INTEGER NOT NULL, status TEXT NOT NULL,
  failure TEXT, last_error TEXT, accepted_seq INTEGER NOT NULL, accepted_at TEXT NOT NULL,
  request_id TEXT NOT NULL, PRIMARY KEY (account_id, operation_id)
);
CREATE TABLE gmail_operation_targets (
  account_id TEXT NOT NULL, operation_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL, PRIMARY KEY (account_id, operation_id, message_id)
);
CREATE TABLE gmail_operation_requests (
  account_id TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL,
  operation_id TEXT NOT NULL, PRIMARY KEY (account_id, request_id)
);
CREATE TABLE gmail_operation_preimages (
  account_id TEXT NOT NULL, operation_id TEXT NOT NULL, message_id TEXT NOT NULL,
  prior_value INTEGER NULL CHECK (prior_value IN (0, 1)),
  PRIMARY KEY (account_id, operation_id, message_id)
);
CREATE TABLE gmail_operation_snapshots (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, snapshot_json TEXT NOT NULL,
  snapshot_saved_at TEXT NOT NULL, PRIMARY KEY (account_id, conversation_id)
);
INSERT INTO meta VALUES ('schema_version', 'gmail-2');
INSERT INTO meta VALUES ('account_id', 'account-historical');
INSERT INTO meta VALUES ('email_address', 'historical@example.test');
INSERT INTO meta VALUES ('history_id', 'h-105');
INSERT INTO meta VALUES ('generation', '7');
INSERT INTO gmail_conversations VALUES
  ('account-historical', 'thread-ops', 'Operations subject', 1, NULL);
INSERT INTO gmail_messages VALUES
  ('account-historical', 'thread-ops', 'message-ops', 'Sender', 'sender@example.test',
   '[]', '2024-03-05T10:00:00Z', 'operation body', 1);
INSERT INTO gmail_inbox_membership VALUES
  ('account-historical', 'thread-ops', 'message-ops');
INSERT INTO gmail_message_facts VALUES
  ('account-historical', 'thread-ops', 'message-ops', 1, 0);
INSERT INTO gmail_operations VALUES
  ('account-historical', 'op-queued', 'thread-ops', 'archive', 1, 'queued', NULL, NULL, 1, '2024-03-05T10:01:00Z', 'req-q'),
  ('account-historical', 'op-applying', 'thread-ops', 'read', 1, 'applying', NULL, NULL, 2, '2024-03-05T10:02:00Z', 'req-a'),
  ('account-historical', 'op-confirmed', 'thread-ops', 'star', 1, 'confirmed', NULL, NULL, 3, '2024-03-05T10:03:00Z', 'req-c'),
  ('account-historical', 'op-failed', 'thread-ops', 'archive', 0, 'failed', 'provider_error', 'retryable failure', 4, '2024-03-05T10:04:00Z', 'req-f'),
  ('account-historical', 'op-unknown', 'thread-ops', 'read', 0, 'outcome_unknown', NULL, 'provider response lost', 5, '2024-03-05T10:05:00Z', 'req-u');
INSERT INTO gmail_operation_targets VALUES
  ('account-historical', 'op-queued', 'thread-ops', 'message-ops'),
  ('account-historical', 'op-applying', 'thread-ops', 'message-ops'),
  ('account-historical', 'op-confirmed', 'thread-ops', 'message-ops'),
  ('account-historical', 'op-failed', 'thread-ops', 'message-ops'),
  ('account-historical', 'op-unknown', 'thread-ops', 'message-ops');
INSERT INTO gmail_operation_requests VALUES
  ('account-historical', 'req-q', '{"kind":"archive"}', 'op-queued'),
  ('account-historical', 'req-a', '{"kind":"read"}', 'op-applying'),
  ('account-historical', 'req-c', '{"kind":"star"}', 'op-confirmed'),
  ('account-historical', 'req-f', '{"kind":"archive"}', 'op-failed'),
  ('account-historical', 'req-u', '{"kind":"read"}', 'op-unknown');
INSERT INTO gmail_operation_preimages VALUES
  ('account-historical', 'op-queued', 'message-ops', 1);
INSERT INTO gmail_operation_snapshots VALUES
  ('account-historical', 'thread-ops', '{"messages":[{"id":"message-ops","sentAt":"2024-03-05T10:00:00Z"}]}', '2024-03-05T10:00:00Z');
