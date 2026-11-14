//! Explicit session policy for `GmailCore` (ADR 0002, stage 2).
//!
//! One `GmailCore` serves two kinds of session. A **Gmail** session talks to
//! Google through an authenticated provider. A **synthetic** session runs the
//! same ledger, cache and worker on the built-in synthetic provider and
//! presents itself as the fixture account. Everything that differs lives
//! here, as named decisions, instead of scattered `if fixture` checks:
//!
//! | question                 | Gmail                            | Synthetic                                  |
//! |--------------------------|----------------------------------|--------------------------------------------|
//! | wire mode                | `gmail`                          | `fixture`                                  |
//! | status presentation      | observed (sync state, grant, …)  | connected/idle, no grant, no timestamp     |
//! | readiness at open        | provider credentials / restore   | local: bootstrap completes before `open`   |
//! | write admission          | provider's verified grant        | always (archive, read, star, retry, undo) |
//! | connect/disconnect/sync/ | provider flows                   | `InvalidRequest { field: "mode" }`         |
//! | permission upgrade       |                                  | (nothing is ever erased)                   |
//! | cached Trash             | observed cache                   | `InvalidRequest { field: "mode" }`         |
//! | provider destinations    | live catalog                     | `ReadOnly`                                 |
//! | search                   | cached, then provider candidates | cached only                                |
//! | periodic discovery       | every 60 s (backoff on error)    | never (facts change only through writes)   |
//!
//! `Gmail` is the existing behaviour, unchanged: every method below answers
//! for it exactly as the inlined code did before this module existed.

use crate::error::MailError;
use crate::gmail::types::{GmailProvider, MailMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionPolicy {
    Gmail,
    Synthetic,
}

impl SessionPolicy {
    pub(crate) fn is_synthetic(self) -> bool {
        self == Self::Synthetic
    }

    /// Wire mode reported in `AccountStatus`.
    pub(crate) fn mode(self) -> MailMode {
        match self {
            Self::Gmail => MailMode::Gmail,
            Self::Synthetic => MailMode::Fixture,
        }
    }

    /// Write admission: Gmail asks the provider's verified grant; a synthetic
    /// session always admits (its provider has nothing to withhold). The
    /// worker's own pre-dispatch check asks the provider directly, so a
    /// synthetic provider must answer `Ok(true)`; the built-in one does.
    pub(crate) fn mutation_access(self, provider: &dyn GmailProvider) -> Result<bool, MailError> {
        match self {
            Self::Gmail => provider.mutation_access(),
            Self::Synthetic => Ok(true),
        }
    }

    /// Periodic catch-up discovery. A synthetic mailbox changes only through
    /// its own writes, so there is nothing to poll for.
    pub(crate) fn periodic_sync(self) -> bool {
        self == Self::Gmail
    }

    /// Search never leaves the local cache in a synthetic session.
    pub(crate) fn cached_only_search(self) -> bool {
        self == Self::Synthetic
    }

    /// Connect, disconnect, permission upgrade and manual sync. A synthetic
    /// session rejects them all and never erases local state.
    pub(crate) fn admit_lifecycle(self) -> Result<(), MailError> {
        match self {
            Self::Gmail => Ok(()),
            Self::Synthetic => Err(invalid_mode()),
        }
    }

    /// The cached Trash list.
    pub(crate) fn admit_trash(self) -> Result<(), MailError> {
        match self {
            Self::Gmail => Ok(()),
            Self::Synthetic => Err(invalid_mode()),
        }
    }

    /// Provider destination catalog and pages.
    pub(crate) fn admit_destinations(self) -> Result<(), MailError> {
        match self {
            Self::Gmail => Ok(()),
            Self::Synthetic => Err(MailError::ReadOnly),
        }
    }
}

fn invalid_mode() -> MailError {
    MailError::InvalidRequest {
        field: "mode".to_string(),
    }
}
