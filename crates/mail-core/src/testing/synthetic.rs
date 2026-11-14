//! Harness for tests that run `GmailCore` on the built-in synthetic provider
//! (ADR 0002). Test-only: it wraps the production provider, never the other
//! way around.

use std::sync::Arc;

use crate::clock::{utc, Clock, FakeClock};
use crate::dto::ConversationRef;
use crate::gmail::sync::GmailCore;
use crate::gmail::types::ConnectionState;
use crate::synthetic::SyntheticGmailProvider;
use crate::{ACCOUNT_ID, MailError};

use super::{temp_profile, until, TIMEOUT};

/// Start of the injected clock used by synthetic-core tests.
pub const CLOCK_START: &str = "2026-02-01T00:00:00Z";

pub struct Synthetic {
    pub core: GmailCore,
    pub provider: Arc<SyntheticGmailProvider>,
    pub clock: Arc<FakeClock>,
    pub dir: tempfile::TempDir,
}

/// A conversation reference in the synthetic account.
pub fn conversation(id: &str) -> ConversationRef {
    ConversationRef {
        account_id: ACCOUNT_ID.to_string(),
        conversation_id: id.to_string(),
    }
}

impl Synthetic {
    /// Opens a fresh profile: provider, core on an injected clock, first
    /// sync finished.
    pub fn open(tag: &str) -> Self {
        let dir = temp_profile(tag);
        let clock = Arc::new(FakeClock::new(utc(CLOCK_START)));
        let (core, provider) = open_in(dir.path(), &clock);
        Self {
            core,
            provider,
            clock,
            dir,
        }
    }

    /// Stops the core and reopens the SAME profile with a NEW provider object,
    /// proving provider facts are durable rather than held in memory.
    pub fn reopen(&mut self) {
        self.core.stop();
        let (core, provider) = open_in(self.dir.path(), &self.clock);
        // Replace last: the old core's drop must not outlive the new lock.
        self.core = core;
        self.provider = provider;
    }
}

/// Opens core + provider over `dir` and waits until the first sync finished.
pub fn open_in(
    dir: &std::path::Path,
    clock: &Arc<FakeClock>,
) -> (GmailCore, Arc<SyntheticGmailProvider>) {
    let provider = Arc::new(SyntheticGmailProvider::open(dir).expect("open synthetic provider"));
    let core = GmailCore::open_with_clock(
        dir,
        provider.clone(),
        Arc::clone(clock) as Arc<dyn Clock>,
    )
    .expect("open synthetic core");
    wait_until_synced(&core);
    (core, provider)
}

pub fn wait_until_synced(core: &GmailCore) {
    assert!(
        until(|| core.account_status().is_ok_and(|status| {
            status.connection == ConnectionState::Connected && status.sync.initial_sync_complete
        })),
        "synthetic core did not finish its first sync"
    );
    core.wait_for_test_idle(TIMEOUT).expect("idle after sync");
}

/// Loads the two initially archived seed conversations into the cache.
pub fn load_archived_seeds(core: &GmailCore) -> Result<(), MailError> {
    for id in ["conv-06", "conv-15"] {
        core.load_search_conversation(&conversation(id))?;
    }
    Ok(())
}
