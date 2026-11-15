//! Local-only draft persistence and editor contracts. No send/provider draft APIs.
pub mod service;
pub mod store;
pub mod types;

pub use service::{
    load_validated_reply_context, require_draft_account, validate_reply_conversation,
    DraftLifecycle, DraftService,
};
pub use store::DraftCore;
pub use types::{
    CreateDraft, DeleteDraft, Draft, DraftContent, DraftDeleteReceipt, DraftReceipt, DraftRef,
    DraftReplyLink, DraftSource, DraftSummary, ReplyContext, SaveDraft,
};
