//! Local-only draft persistence and editor contracts. No send/provider draft APIs.
pub mod store;
pub mod types;

pub use store::DraftCore;
pub use types::{
    CreateDraft, DeleteDraft, Draft, DraftContent, DraftDeleteReceipt, DraftReceipt, DraftRef,
    DraftReplyLink, DraftSource, DraftSummary, ReplyContext, SaveDraft,
};
