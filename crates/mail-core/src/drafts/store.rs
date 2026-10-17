//! Concrete local-only draft persistence. Drafts live in their own locked SQLite
//! profile and never pass through a mail provider or mutation worker.
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::drafts::types::{
    CreateDraft, DeleteDraft, Draft, DraftContent, DraftDeleteReceipt, DraftReceipt, DraftRef,
    DraftReplyLink, DraftSource, DraftSummary, SaveDraft, MAX_BODY_BYTES, MAX_RECIPIENT_BYTES,
    MAX_REPLY_HEADER_BYTES, MAX_REPLY_REFERENCES, MAX_REPLY_TO_RECIPIENTS, MAX_SUBJECT_BYTES,
};
use crate::dto::{Conversation, ConversationRef};
use crate::error::MailError;
use crate::gmail::types::AccountInfo;
use crate::lock::ProfileGuard;

#[derive(Clone)]
pub struct DraftCore {
    inner: Arc<DraftCoreInner>,
}

struct DraftCoreInner {
    _profile: ProfileGuard,
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for DraftCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DraftCore").finish_non_exhaustive()
    }
}

impl DraftCore {
    /// Opens the dedicated `<selected-profile>/local-drafts` subprofile.
    pub fn open(profile_dir: impl AsRef<Path>) -> Result<Self, MailError> {
        let profile_dir = profile_dir.as_ref();
        let profile = ProfileGuard::acquire(profile_dir)?;
        let conn = Connection::open(profile_dir.join("drafts.db"))
            .map_err(|_| MailError::StorageUnavailable)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| MailError::StorageUnavailable)?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(|_| MailError::StorageUnavailable)?;
        conn.busy_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| MailError::StorageUnavailable)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS drafts (
                account_id TEXT NOT NULL,
                draft_id TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK (revision > 0),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                content_json TEXT NOT NULL,
                source_json TEXT NOT NULL,
                reply_link_json TEXT,
                PRIMARY KEY (account_id, draft_id)
            );
            CREATE TABLE IF NOT EXISTS request_receipts (
                account_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                receipt_json TEXT NOT NULL,
                PRIMARY KEY (account_id, request_id)
            );",
        )
        .map_err(|_| MailError::StorageUnavailable)?;
        Ok(Self {
            inner: Arc::new(DraftCoreInner {
                _profile: profile,
                conn: Mutex::new(conn),
            }),
        })
    }

    pub fn list_drafts(&self, account: &AccountInfo) -> Result<Vec<DraftSummary>, MailError> {
        validate_account(account)?;
        let conn = self.lock_conn()?;
        let mut statement = conn
            .prepare(
                "SELECT draft_id, revision, updated_at, content_json, source_json
             FROM drafts WHERE account_id = ?1 ORDER BY updated_at DESC, draft_id ASC",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map([&account.account_id], |row| {
                let id: String = row.get(0)?;
                let revision = decode_revision(row.get(1)?)?;
                let updated_at: String = row.get(2)?;
                let content: String = row.get(3)?;
                let source: String = row.get(4)?;
                Ok((id, revision, updated_at, content, source))
            })
            .map_err(storage)?;
        let mut result = Vec::new();
        for row in rows {
            let (id, revision, updated_at, content, source) = row.map_err(storage)?;
            let content: DraftContent = serde_json::from_str(&content).map_err(storage)?;
            let source: DraftSource = serde_json::from_str(&source).map_err(storage)?;
            result.push(DraftSummary {
                draft_ref: DraftRef {
                    account_id: account.account_id.clone(),
                    draft_id: id,
                },
                revision,
                updated_at,
                subject: content.subject,
                to: content.to,
                source,
            });
        }
        Ok(result)
    }

    pub fn get_draft(
        &self,
        account: &AccountInfo,
        draft_ref: &DraftRef,
    ) -> Result<Draft, MailError> {
        validate_ref(account, draft_ref)?;
        let conn = self.lock_conn()?;
        read_draft(&conn, draft_ref)?.ok_or(MailError::NotFound)
    }

    /// Checks an idempotency key before the shell does any reply metadata read.
    pub fn lookup_create_receipt(
        &self,
        account: &AccountInfo,
        command: &CreateDraft,
    ) -> Result<Option<DraftReceipt>, MailError> {
        validate_account(account)?;
        validate_request_id(&command.request_id)?;
        validate_create_shape(command)?;
        let fingerprint = fingerprint(command)?;
        let conn = self.lock_conn()?;
        lookup_receipt(
            &conn,
            &account.account_id,
            &command.request_id,
            "create",
            &fingerprint,
        )
    }

    pub fn create_draft(
        &self,
        account: &AccountInfo,
        command: &CreateDraft,
        conversation: Option<&Conversation>,
    ) -> Result<DraftReceipt, MailError> {
        validate_account(account)?;
        validate_request_id(&command.request_id)?;
        validate_create_shape(command)?;
        if let Some(content) = &command.initial_content {
            validate_content(content)?;
        }
        let fingerprint = fingerprint(command)?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if let Some(receipt) = lookup_receipt_tx(
            &tx,
            &account.account_id,
            &command.request_id,
            "create",
            &fingerprint,
        )? {
            tx.commit().map_err(storage)?;
            return Ok(receipt);
        }
        let (content, reply_link) = match &command.source {
            DraftSource::NewMessage => (
                command
                    .initial_content
                    .clone()
                    .unwrap_or_else(empty_content),
                None,
            ),
            DraftSource::Reply {
                conversation: requested_ref,
                source_message_id,
            } => {
                let cached = conversation.ok_or(MailError::ReplyUnavailable)?;
                let (content, link) =
                    prepare_reply(account, requested_ref, source_message_id, cached)?;
                (content, Some(link))
            }
        };
        validate_content(&content)?;
        let now = now_iso();
        let draft_ref = DraftRef {
            account_id: account.account_id.clone(),
            draft_id: Uuid::new_v4().to_string(),
        };
        let source_json = serde_json::to_string(&command.source).map_err(storage)?;
        let content_json = serde_json::to_string(&content).map_err(storage)?;
        let reply_json = reply_link
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(storage)?;
        tx.execute(
            "INSERT INTO drafts(account_id,draft_id,revision,created_at,updated_at,content_json,source_json,reply_link_json)
             VALUES (?1,?2,1,?3,?3,?4,?5,?6)",
            params![draft_ref.account_id, draft_ref.draft_id, now, content_json, source_json, reply_json],
        ).map_err(storage)?;
        let receipt = DraftReceipt {
            draft_ref,
            revision: 1,
            saved_at: now,
        };
        insert_receipt(
            &tx,
            account,
            &command.request_id,
            "create",
            &fingerprint,
            &receipt,
        )?;
        tx.commit().map_err(storage)?;
        Ok(receipt)
    }

    pub fn save_draft(
        &self,
        account: &AccountInfo,
        command: &SaveDraft,
    ) -> Result<DraftReceipt, MailError> {
        validate_account(account)?;
        validate_ref(account, &command.draft_ref)?;
        validate_request_id(&command.request_id)?;
        validate_content(&command.content)?;
        let fingerprint = fingerprint(command)?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if let Some(receipt) = lookup_receipt_tx(
            &tx,
            &account.account_id,
            &command.request_id,
            "save",
            &fingerprint,
        )? {
            tx.commit().map_err(storage)?;
            return Ok(receipt);
        }
        let current = current_revision(&tx, &command.draft_ref)?.ok_or(MailError::NotFound)?;
        if current != command.expected_revision {
            return Err(MailError::DraftConflict {
                current_revision: current,
            });
        }
        let next = current
            .checked_add(1)
            .ok_or(MailError::StorageUnavailable)?;
        let now = now_iso();
        let content_json = serde_json::to_string(&command.content).map_err(storage)?;
        let changed = tx
            .execute(
                "UPDATE drafts SET revision=?3, updated_at=?4, content_json=?5
             WHERE account_id=?1 AND draft_id=?2 AND revision=?6",
                params![
                    command.draft_ref.account_id,
                    command.draft_ref.draft_id,
                    next,
                    now,
                    content_json,
                    current
                ],
            )
            .map_err(storage)?;
        if changed != 1 {
            return Err(MailError::StorageUnavailable);
        }
        let receipt = DraftReceipt {
            draft_ref: command.draft_ref.clone(),
            revision: next,
            saved_at: now,
        };
        insert_receipt(
            &tx,
            account,
            &command.request_id,
            "save",
            &fingerprint,
            &receipt,
        )?;
        tx.commit().map_err(storage)?;
        Ok(receipt)
    }

    pub fn delete_draft(
        &self,
        account: &AccountInfo,
        command: &DeleteDraft,
    ) -> Result<DraftDeleteReceipt, MailError> {
        validate_account(account)?;
        validate_ref(account, &command.draft_ref)?;
        validate_request_id(&command.request_id)?;
        let fingerprint = fingerprint(command)?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if let Some(receipt) = lookup_receipt_tx::<DraftDeleteReceipt>(
            &tx,
            &account.account_id,
            &command.request_id,
            "delete",
            &fingerprint,
        )? {
            tx.commit().map_err(storage)?;
            return Ok(receipt);
        }
        let current = current_revision(&tx, &command.draft_ref)?.ok_or(MailError::NotFound)?;
        if current != command.expected_revision {
            return Err(MailError::DraftConflict {
                current_revision: current,
            });
        }
        let now = now_iso();
        let deleted = tx
            .execute(
                "DELETE FROM drafts WHERE account_id=?1 AND draft_id=?2 AND revision=?3",
                params![
                    command.draft_ref.account_id,
                    command.draft_ref.draft_id,
                    current
                ],
            )
            .map_err(storage)?;
        if deleted != 1 {
            return Err(MailError::StorageUnavailable);
        }
        let receipt = DraftDeleteReceipt {
            draft_ref: command.draft_ref.clone(),
            deleted_at: now,
        };
        insert_receipt(
            &tx,
            account,
            &command.request_id,
            "delete",
            &fingerprint,
            &receipt,
        )?;
        tx.commit().map_err(storage)?;
        Ok(receipt)
    }

    fn lock_conn(&self) -> Result<MutexGuard<'_, Connection>, MailError> {
        self.inner
            .conn
            .lock()
            .map_err(|_| MailError::StorageUnavailable)
    }
}

fn validate_account(account: &AccountInfo) -> Result<(), MailError> {
    if account.account_id.is_empty() || account.account_id.len() > 512 {
        return invalid("accountId");
    }
    Ok(())
}
fn validate_ref(account: &AccountInfo, draft_ref: &DraftRef) -> Result<(), MailError> {
    if draft_ref.account_id != account.account_id {
        return Err(MailError::NotFound);
    }
    if draft_ref.draft_id.is_empty() || draft_ref.draft_id.len() > 512 {
        return invalid("ref");
    }
    Ok(())
}
fn validate_request_id(request_id: &str) -> Result<(), MailError> {
    if request_id.is_empty() || request_id.len() > 128 {
        return invalid("requestId");
    }
    Ok(())
}
fn validate_create_shape(command: &CreateDraft) -> Result<(), MailError> {
    if matches!(command.source, DraftSource::Reply { .. }) && command.initial_content.is_some() {
        return invalid("initialContent");
    }
    if let DraftSource::Reply {
        conversation,
        source_message_id,
    } = &command.source
    {
        if conversation.account_id.is_empty()
            || conversation.conversation_id.is_empty()
            || source_message_id.is_empty()
        {
            return invalid("source");
        }
    }
    Ok(())
}
fn validate_content(content: &DraftContent) -> Result<(), MailError> {
    if content.to.len() > MAX_RECIPIENT_BYTES {
        return invalid("to");
    }
    if content.cc.len() > MAX_RECIPIENT_BYTES {
        return invalid("cc");
    }
    if content.subject.len() > MAX_SUBJECT_BYTES {
        return invalid("subject");
    }
    if content.body_text.len() > MAX_BODY_BYTES {
        return invalid("bodyText");
    }
    Ok(())
}
fn empty_content() -> DraftContent {
    DraftContent {
        to: String::new(),
        cc: String::new(),
        subject: String::new(),
        body_text: String::new(),
    }
}
fn invalid(field: &str) -> Result<(), MailError> {
    Err(MailError::InvalidRequest {
        field: field.to_string(),
    })
}
fn storage(_: impl std::fmt::Debug) -> MailError {
    MailError::StorageUnavailable
}
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn fingerprint<T: serde::Serialize>(value: &T) -> Result<String, MailError> {
    let bytes = serde_json::to_vec(value).map_err(storage)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn decode_revision(value: i64) -> rusqlite::Result<u32> {
    Ok(u32::try_from(value).map_err(|_| rusqlite::types::FromSqlError::OutOfRange(value))?)
}
fn read_draft(conn: &Connection, draft_ref: &DraftRef) -> Result<Option<Draft>, MailError> {
    conn.query_row(
        "SELECT revision,created_at,updated_at,content_json,source_json,reply_link_json
         FROM drafts WHERE account_id=?1 AND draft_id=?2",
        params![draft_ref.account_id, draft_ref.draft_id],
        |row| {
            let revision = decode_revision(row.get(0)?)?;
            let created_at: String = row.get(1)?;
            let updated_at: String = row.get(2)?;
            let content: String = row.get(3)?;
            let source: String = row.get(4)?;
            let reply_link: Option<String> = row.get(5)?;
            Ok((
                revision, created_at, updated_at, content, source, reply_link,
            ))
        },
    )
    .optional()
    .map_err(storage)?
    .map(
        |(revision, created_at, updated_at, content, source, reply_link)| {
            Ok(Draft {
                draft_ref: draft_ref.clone(),
                revision,
                created_at,
                updated_at,
                content: serde_json::from_str(&content).map_err(storage)?,
                source: serde_json::from_str(&source).map_err(storage)?,
                reply_link: reply_link
                    .map(|value| serde_json::from_str(&value).map_err(storage))
                    .transpose()?,
            })
        },
    )
    .transpose()
}
fn current_revision(tx: &Transaction<'_>, draft_ref: &DraftRef) -> Result<Option<u32>, MailError> {
    tx.query_row(
        "SELECT revision FROM drafts WHERE account_id=?1 AND draft_id=?2",
        params![draft_ref.account_id, draft_ref.draft_id],
        |row| decode_revision(row.get(0)?),
    )
    .optional()
    .map_err(storage)
}
fn lookup_receipt<T: serde::de::DeserializeOwned>(
    conn: &Connection,
    account_id: &str,
    request_id: &str,
    operation: &str,
    fingerprint: &str,
) -> Result<Option<T>, MailError> {
    let row: Option<(String, String, String)> = conn.query_row(
        "SELECT operation,fingerprint,receipt_json FROM request_receipts WHERE account_id=?1 AND request_id=?2",
        params![account_id, request_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(storage)?;
    parse_receipt(row, operation, fingerprint)
}
fn lookup_receipt_tx<T: serde::de::DeserializeOwned>(
    tx: &Transaction<'_>,
    account_id: &str,
    request_id: &str,
    operation: &str,
    fingerprint: &str,
) -> Result<Option<T>, MailError> {
    let row: Option<(String, String, String)> = tx.query_row(
        "SELECT operation,fingerprint,receipt_json FROM request_receipts WHERE account_id=?1 AND request_id=?2",
        params![account_id, request_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(storage)?;
    parse_receipt(row, operation, fingerprint)
}
fn parse_receipt<T: serde::de::DeserializeOwned>(
    row: Option<(String, String, String)>,
    operation: &str,
    fingerprint: &str,
) -> Result<Option<T>, MailError> {
    match row {
        None => Ok(None),
        Some((stored_operation, stored_fingerprint, receipt))
            if stored_operation == operation && stored_fingerprint == fingerprint =>
        {
            serde_json::from_str(&receipt).map(Some).map_err(storage)
        }
        Some(_) => Err(MailError::RequestIdConflict),
    }
}
fn insert_receipt<T: serde::Serialize>(
    tx: &Transaction<'_>,
    account: &AccountInfo,
    request_id: &str,
    operation: &str,
    fingerprint: &str,
    receipt: &T,
) -> Result<(), MailError> {
    let json = serde_json::to_string(receipt).map_err(storage)?;
    tx.execute("INSERT INTO request_receipts(account_id,request_id,operation,fingerprint,receipt_json) VALUES (?1,?2,?3,?4,?5)",
        params![account.account_id, request_id, operation, fingerprint, json]).map_err(storage)?;
    Ok(())
}

fn prepare_reply(
    account: &AccountInfo,
    requested_ref: &ConversationRef,
    source_id: &str,
    conversation: &Conversation,
) -> Result<(DraftContent, DraftReplyLink), MailError> {
    if requested_ref.account_id != account.account_id
        || conversation.conversation_ref != *requested_ref
        || conversation.context_complete != Some(true)
        || conversation.retained_snapshot_at.is_some()
        || conversation
            .messages
            .last()
            .is_none_or(|message| message.id != source_id)
    {
        return Err(MailError::ReplyUnavailable);
    }
    let latest = conversation
        .messages
        .last()
        .ok_or(MailError::ReplyUnavailable)?;
    if latest
        .from
        .mailbox
        .eq_ignore_ascii_case(&account.email_address)
    {
        return Err(MailError::ReplyUnavailable);
    }
    let context = conversation
        .reply_context
        .as_ref()
        .ok_or(MailError::ReplyUnavailable)?;
    if context.source_message_id != source_id {
        return Err(MailError::ReplyUnavailable);
    }
    let from = validate_mailbox(&context.from_mailbox).ok_or(MailError::ReplyUnavailable)?;
    let raw_targets = match &context.reply_to_mailboxes {
        None => vec![from],
        Some(targets) if !targets.is_empty() && targets.len() <= MAX_REPLY_TO_RECIPIENTS => targets
            .iter()
            .map(|value| validate_mailbox(value).ok_or(MailError::ReplyUnavailable))
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err(MailError::ReplyUnavailable),
    };
    let self_mailbox =
        validate_mailbox(&account.email_address).ok_or(MailError::ReplyUnavailable)?;
    let mut targets: Vec<String> = Vec::new();
    for mailbox in raw_targets {
        if mailbox.eq_ignore_ascii_case(&self_mailbox) {
            continue;
        }
        if !targets
            .iter()
            .any(|prior| prior.eq_ignore_ascii_case(&mailbox))
        {
            targets.push(mailbox);
        }
    }
    if targets.is_empty() {
        return Err(MailError::ReplyUnavailable);
    }
    let message_id = validate_message_id(&context.message_id).ok_or(MailError::ReplyUnavailable)?;
    if context.references.len() > MAX_REPLY_REFERENCES {
        return Err(MailError::ReplyUnavailable);
    }
    let mut references = Vec::with_capacity(context.references.len() + 1);
    let mut input_bytes = 0usize;
    for (index, reference) in context.references.iter().enumerate() {
        let reference = validate_message_id(reference).ok_or(MailError::ReplyUnavailable)?;
        input_bytes = input_bytes.saturating_add(reference.len() + usize::from(index > 0));
        if reference != message_id {
            references.push(reference);
        }
    }
    if input_bytes > MAX_REPLY_HEADER_BYTES {
        return Err(MailError::ReplyUnavailable);
    }
    references.push(message_id.clone());
    let output_bytes = references
        .iter()
        .enumerate()
        .fold(0usize, |total, (index, value)| {
            total.saturating_add(value.len() + usize::from(index > 0))
        });
    if references.len() > MAX_REPLY_REFERENCES || output_bytes > MAX_REPLY_HEADER_BYTES {
        return Err(MailError::ReplyUnavailable);
    }
    let subject = if conversation
        .subject
        .get(..3)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("re:"))
    {
        conversation.subject.clone()
    } else {
        format!("Re: {}", conversation.subject)
    };
    let content = DraftContent {
        to: targets.join(", "),
        cc: String::new(),
        subject,
        body_text: String::new(),
    };
    validate_content(&content).map_err(|_| MailError::ReplyUnavailable)?;
    Ok((
        content,
        DraftReplyLink {
            conversation: requested_ref.clone(),
            source_message_id: source_id.to_string(),
            message_id,
            references,
        },
    ))
}

fn validate_mailbox(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 254
        || !value.is_ascii()
        || value
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
    {
        return None;
    }
    let (local, domain) = value.split_once('@')?;
    if local.is_empty() || domain.is_empty() || domain.contains('@') || !valid_domain(domain) {
        return None;
    }
    let valid_local = if local.starts_with('"') && local.ends_with('"') && local.len() >= 2 {
        let inner = &local[1..local.len() - 1];
        let mut escaped = false;
        for b in inner.bytes() {
            if escaped {
                if !(32..=126).contains(&b) {
                    return None;
                }
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' || !(32..=126).contains(&b) {
                return None;
            }
        }
        !escaped
    } else {
        valid_dot_atom(local)
    };
    if !valid_local {
        return None;
    }
    Some(value.to_string())
}
fn valid_domain(value: &str) -> bool {
    if let Some(literal) = value
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    {
        if literal
            .get(..5)
            .is_some_and(|tag| tag.eq_ignore_ascii_case("IPv6:"))
        {
            return literal[5..].parse::<std::net::Ipv6Addr>().is_ok();
        }
        return literal.parse::<std::net::Ipv4Addr>().is_ok();
    }
    let labels: Vec<&str> = value.split('.').collect();
    !labels.is_empty()
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}
fn valid_dot_atom(value: &str) -> bool {
    if value.is_empty() || value.starts_with('.') || value.ends_with('.') || value.contains("..") {
        return false;
    }
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-/=?^_`{|}~.".contains(&b))
}
fn validate_message_id(value: &str) -> Option<String> {
    if value.len() < 5 || value.len() > 998 || !value.starts_with('<') || !value.ends_with('>') {
        return None;
    }
    let inner = &value[1..value.len() - 1];
    if !inner.is_ascii()
        || inner
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace() || b == b'<' || b == b'>')
    {
        return None;
    }
    let (left, domain) = inner.split_once('@')?;
    if domain.contains('@') || !valid_dot_atom(left) {
        return None;
    }
    if !valid_domain(domain) {
        return None;
    }
    Some(value.to_string())
}
