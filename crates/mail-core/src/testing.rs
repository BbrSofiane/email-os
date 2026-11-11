//! Shared synthetic helpers for unit and integration tests.
//!
//! This module is absent from normal builds. Integration tests can enable it
//! with the `test-support` feature.

use std::time::{Duration, Instant};

use crate::dto::{Address, Conversation, ConversationRef, Message};
use crate::gmail::types::{GmailProfile, GmailThread};

pub const TIMEOUT: Duration = Duration::from_secs(5);

pub mod operations_fake;

pub fn temp_profile(tag: &str) -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix(&format!("mail-core-{tag}-"))
        .tempdir()
        .expect("create isolated test profile")
}

pub fn until(predicate: impl FnMut() -> bool) -> bool {
    until_for(TIMEOUT, predicate)
}

pub fn until_for(timeout: Duration, mut predicate: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if predicate() {
            return true;
        }
        if Instant::now() >= deadline {
            return predicate();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub fn profile(account_id: &str, email: &str, history_id: &str) -> GmailProfile {
    GmailProfile {
        account_id: account_id.to_string(),
        email_address: email.to_string(),
        history_id: history_id.to_string(),
    }
}

pub fn message(id: &str, from: &str, sent_at: &str, body_text: &str) -> Message {
    Message {
        id: id.to_string(),
        from: Address {
            display_name: None,
            mailbox: from.to_string(),
        },
        to: Vec::new(),
        sent_at: sent_at.to_string(),
        body_text: body_text.to_string(),
        has_attachment: None,
    }
}

/// Build a minimal observed synthetic thread. Tests that exercise partial
/// label facts or reply metadata should start from this value and set those
/// facts explicitly.
pub fn thread(
    account_id: &str,
    thread_id: &str,
    messages: Vec<Message>,
    inbox_message_ids: &[&str],
    unread_message_ids: Option<Vec<String>>,
    history_id: &str,
) -> GmailThread {
    let conversation = Conversation {
        stars: None,
        conversation_ref: ConversationRef {
            account_id: account_id.to_string(),
            conversation_id: thread_id.to_string(),
        },
        subject: "synthetic subject".to_string(),
        messages,
        is_in_inbox: !inbox_message_ids.is_empty(),
        is_read: None,
        context_complete: Some(true),
        unsupported_reason: None,
        retained_snapshot_at: None,
        reply_context: None,
        pending_operation_id: None,
    };
    let message_ids = conversation.messages.iter().map(|m| m.id.clone()).collect();
    GmailThread {
        star_facts: None,
        newest_sender: None,
        attachments: Vec::new(),
        conversation,
        inbox_message_ids: inbox_message_ids.iter().map(|s| (*s).to_string()).collect(),
        message_ids: Some(message_ids),
        unread_message_ids,
        trash_message_ids: None,
        spam_message_ids: None,
        history_id: history_id.to_string(),
    }
}

/// Open the real Gmail core with a synthetic provider.
pub fn open_core<P: crate::gmail::types::GmailReadProvider + 'static>(
    dir: impl AsRef<std::path::Path>,
    provider: &std::sync::Arc<P>,
) -> crate::gmail::sync::GmailCore {
    crate::gmail::sync::GmailCore::open(dir, provider.clone()).expect("open Gmail test core")
}

pub fn open_core_with_clock<
    P: crate::gmail::types::GmailReadProvider + 'static,
    C: crate::clock::Clock + 'static,
>(
    dir: impl AsRef<std::path::Path>,
    provider: &std::sync::Arc<P>,
    clock: &std::sync::Arc<C>,
) -> crate::gmail::sync::GmailCore {
    crate::gmail::sync::GmailCore::open_with_clock(dir, provider.clone(), clock.clone())
        .expect("open Gmail test core")
}

pub fn open_profile<P: crate::gmail::types::GmailReadProvider + 'static>(
    tag: &str,
    provider: &std::sync::Arc<P>,
) -> (crate::gmail::sync::GmailCore, tempfile::TempDir) {
    let dir = temp_profile(tag);
    let core = open_core(dir.path(), provider);
    (core, dir)
}
