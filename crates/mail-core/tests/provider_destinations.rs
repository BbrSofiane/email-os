//! UX-09 synthetic provider + real SQLite only. No Google or credentials.
use mail_core::dto::{Address, Conversation, ConversationRef, Message};
use mail_core::gmail::browsing::{DestinationRequest, ProviderDestination};
use mail_core::gmail::sync::GmailCore;
use mail_core::gmail::types::*;
use mail_core::{CancelToken, MailError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Provider {
    calls: Mutex<Vec<(String, Option<String>)>>,
    fail: Mutex<bool>,
    /// Currently published credential identity. Switching it models the
    /// supported failure: cached account A survives missing credentials and a
    /// reconnect publishes account B.
    credential_account: Mutex<String>,
    /// When set, every live provider read behaves as if credentials are
    /// missing (`auth_required`); saved reads are unaffected.
    credentialless: Mutex<bool>,
    /// Parked live destination reads wait here until released, so tests can
    /// hold one admitted job open. Defaults to released.
    released: Mutex<bool>,
    /// Every admitted live destination/catalog provider call, in order.
    admissions: Mutex<Vec<String>>,
}
impl Default for Provider {
    fn default() -> Self {
        Self {
            calls: Mutex::default(),
            fail: Mutex::default(),
            credential_account: Mutex::new("a".to_string()),
            credentialless: Mutex::default(),
            released: Mutex::new(true),
            admissions: Mutex::default(),
        }
    }
}
impl Provider {
    fn park(&self) {
        *self.released.lock().unwrap() = false;
    }
    fn release(&self) {
        *self.released.lock().unwrap() = true;
    }
    /// Bounded wait until `count` additional admissions beyond `baseline`
    /// occurred, so the parked invocation itself is observed (absolute counts
    /// are already nonzero after priming reads).
    fn wait_admitted_beyond(&self, baseline: usize, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.admissions.lock().unwrap().len() < baseline + count {
            assert!(Instant::now() < deadline, "provider call never admitted");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    /// Mirrors the production admission seam (GmailProvider's
    /// `destination_admission_token`): a live destination read is admitted
    /// only while the published credential identity equals the expected
    /// account, cancellation is honored while parked, and missing
    /// credentials are typed `auth_required`.
    fn admit(&self, expected_account_id: &str, cancel: &CancelToken) -> Result<(), MailError> {
        self.admissions
            .lock()
            .unwrap()
            .push(expected_account_id.to_owned());
        loop {
            if cancel.is_cancelled() {
                return Err(MailError::AuthCancelled);
            }
            if *self.released.lock().unwrap() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        if *self.credentialless.lock().unwrap() {
            return Err(MailError::AuthRequired);
        }
        if *self.credential_account.lock().unwrap() != expected_account_id {
            return Err(MailError::AuthFailed);
        }
        Ok(())
    }
}
impl GmailReadProvider for Provider {
    fn is_configured(&self) -> bool {
        true
    }
    fn has_credentials(&self) -> Result<bool, MailError> {
        Ok(!*self.credentialless.lock().unwrap())
    }
    fn connect(&self, c: &CancelToken) -> Result<GmailProfile, MailError> {
        self.profile(c)
    }
    fn disconnect(&self) -> Result<(), MailError> {
        Ok(())
    }
    fn profile(&self, _: &CancelToken) -> Result<GmailProfile, MailError> {
        Ok(GmailProfile {
            account_id: "a".into(),
            email_address: "a@example.test".into(),
            history_id: "1".into(),
        })
    }
    fn list_inbox(&self, _: Option<&str>, _: &CancelToken) -> Result<InboxPage, MailError> {
        Ok(InboxPage {
            thread_ids: vec![],
            next_page_token: None,
        })
    }
    fn history(
        &self,
        _: &str,
        _: Option<&str>,
        _: &CancelToken,
    ) -> Result<HistoryPage, GmailHistoryError> {
        Ok(HistoryPage {
            changed_thread_ids: vec![],
            deleted_message_ids: vec![],
            next_page_token: None,
            history_id: "1".into(),
        })
    }
    fn list_destinations_for_account(
        &self,
        expected_account_id: &str,
        cancel: &CancelToken,
    ) -> Result<Vec<ProviderDestination>, MailError> {
        self.admit(expected_account_id, cancel)?;
        Ok(vec![ProviderDestination {
            id: "Label_1".into(),
            name: "<img src=x>".into(),
            user_label: true,
        }])
    }
    fn list_destination_for_account(
        &self,
        expected_account_id: &str,
        id: &str,
        cursor: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<InboxPage, MailError> {
        self.admit(expected_account_id, cancel)?;
        self.calls
            .lock()
            .unwrap()
            .push((id.into(), cursor.map(str::to_owned)));
        if *self.fail.lock().unwrap() {
            return Err(MailError::NetworkUnavailable);
        }
        Ok(InboxPage {
            thread_ids: vec![if cursor.is_some() {
                "older"
            } else {
                "uncached"
            }
            .into()],
            next_page_token: cursor.is_none().then(|| "page-2".into()),
        })
    }
    /// Mirrors the production stamping: thread contents come from whatever
    /// account the current credentials can read and carry that identity.
    fn get_thread(&self, id: &str, _: &CancelToken) -> Result<Option<GmailThread>, MailError> {
        if *self.credentialless.lock().unwrap() {
            return Err(MailError::AuthRequired);
        }
        let account = self.credential_account.lock().unwrap().clone();
        Ok(Some(Self::synthetic_thread(id, &account)))
    }
    /// Account-bound destination thread GET, mirroring the production seam:
    /// admission precedes dispatch and content is stamped with the admitted
    /// (validated) identity.
    fn get_thread_for_account(
        &self,
        expected_account_id: &str,
        thread_id: &str,
        cancel: &CancelToken,
    ) -> Result<Option<GmailThread>, MailError> {
        self.admit(expected_account_id, cancel)?;
        Ok(Some(Self::synthetic_thread(thread_id, expected_account_id)))
    }
}

impl Provider {
    fn synthetic_thread(id: &str, account: &str) -> GmailThread {
        GmailThread {
            star_facts: None,
            newest_sender: None,
            attachments: Vec::new(),
            conversation: Conversation {
                stars: None,
                conversation_ref: ConversationRef {
                    account_id: account.to_string(),
                    conversation_id: id.to_string(),
                },
                subject: "Uncached".into(),
                messages: vec![Message {
                    id: format!("m-{id}"),
                    from: Address {
                        display_name: None,
                        mailbox: "sender@example.test".into(),
                    },
                    to: vec![],
                    sent_at: "2025-01-01T00:00:00Z".into(),
                    body_text: "<script>literal</script>".into(),
                }],
                is_in_inbox: true,
                is_read: Some(false),
                pending_operation_id: None,
                context_complete: Some(true),
                unsupported_reason: None,
                retained_snapshot_at: None,
                reply_context: None,
            },
            inbox_message_ids: vec![format!("m-{id}")],
            unread_message_ids: Some(vec![format!("m-{id}")]),
            trash_message_ids: None,
            spam_message_ids: None,
            message_ids: Some(vec![format!("m-{id}")]),
            history_id: "1".into(),
        }
    }
}
fn ready(core: &GmailCore) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !core.account_status().unwrap().sync.initial_sync_complete {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Test hygiene: any parked fake call is released even when an assertion
/// fails, so cancellation (not an unreleased gate) unwinds pending jobs.
struct ReleaseOnDrop<'a>(&'a Provider);
impl Drop for ReleaseOnDrop<'_> {
    fn drop(&mut self) {
        self.0.release();
    }
}
#[test]
fn uncached_browse_paging_offline_restart_and_account_fencing() {
    let path = std::env::temp_dir().join(format!(
        "ux09-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    ));
    let provider = Arc::new(Provider::default());
    let core = GmailCore::open(&path, provider.clone()).unwrap();
    ready(&core);
    assert!(core.list_conversations().unwrap().conversations.is_empty());
    let catalog = core.list_provider_destinations("a", false).unwrap();
    assert_eq!(catalog.destinations[0].name, "<img src=x>");
    let mut request = DestinationRequest {
        account_id: "a".into(),
        destination_id: "Label_1".into(),
        cursor: None,
        cached: false,
    };
    let page = core.browse_provider_destination(&request).unwrap();
    assert_eq!(
        page.conversations[0].conversation_ref.conversation_id,
        "uncached"
    );
    assert!(page.conversations[0].is_in_inbox);
    assert_eq!(page.conversations[0].is_read, Some(false));
    assert!(core.list_conversations().unwrap().conversations.is_empty());
    request.cursor = page.next_cursor;
    assert_eq!(
        core.browse_provider_destination(&request)
            .unwrap()
            .conversations[0]
            .conversation_ref
            .conversation_id,
        "older"
    );
    assert_eq!(
        provider.calls.lock().unwrap()[1].1.as_deref(),
        Some("page-2")
    );
    request.destination_id = "other".into();
    assert!(core.browse_provider_destination(&request).is_err());
    request.destination_id = "Label_1".into();
    request.account_id = "foreign".into();
    assert_eq!(
        core.browse_provider_destination(&request),
        Err(MailError::NotFound)
    );
    request.account_id = "a".into();
    request.cursor = Some("bad".into());
    assert!(core.browse_provider_destination(&request).is_err());
    request.cursor = None;
    *provider.fail.lock().unwrap() = true;
    assert_eq!(
        core.browse_provider_destination(&request),
        Err(MailError::NetworkUnavailable)
    );
    drop(core);
    let core = GmailCore::open(&path, provider.clone()).unwrap();
    ready(&core);
    request.cached = true;
    let saved = core.browse_provider_destination(&request).unwrap();
    assert_eq!(
        saved.conversations[0].conversation_ref.conversation_id,
        "older"
    );
    assert_eq!(core.list_provider_destinations("a", true).unwrap(), catalog);
    core.disconnect_account().unwrap();
    assert_eq!(
        core.browse_provider_destination(&request),
        Err(MailError::NotFound)
    );
    drop(core);
    let _ = std::fs::remove_dir_all(path);
}

#[test]
fn foreign_reconnect_never_persists_or_returns_foreign_destination_data() {
    let path = std::env::temp_dir().join(format!(
        "ux09-foreign-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    ));
    let provider = Arc::new(Provider::default());
    let core = GmailCore::open(&path, provider.clone()).unwrap();
    ready(&core);
    let catalog = core.list_provider_destinations("a", false).unwrap();
    let mut request = DestinationRequest {
        account_id: "a".into(),
        destination_id: "Label_1".into(),
        cursor: None,
        cached: false,
    };
    let page = core.browse_provider_destination(&request).unwrap();
    assert_eq!(
        page.conversations[0].conversation_ref.conversation_id,
        "uncached"
    );

    // Supported failure: account A's credentials disappear and a reconnect
    // publishes account B, while the SQLite account binding still says A.
    *provider.credential_account.lock().unwrap() = "b".into();

    // A live catalog read for A fails closed; B's labels are neither fetched
    // under A's name nor persisted.
    assert_eq!(
        core.list_provider_destinations("a", false),
        Err(MailError::AuthFailed)
    );
    // The saved A catalog is untouched and still explicitly readable offline.
    assert_eq!(core.list_provider_destinations("a", true).unwrap(), catalog);
    // A live page read for A fails closed as well; the fake would otherwise
    // serve B's (empty) page whose absence of thread stamps cannot expose the
    // account switch.
    assert_eq!(
        core.browse_provider_destination(&request),
        Err(MailError::AuthFailed)
    );
    // The retained A page was not overwritten by a B-derived empty page.
    request.cached = true;
    let saved = core.browse_provider_destination(&request).unwrap();
    assert_eq!(
        saved.conversations[0].conversation_ref.conversation_id,
        "uncached"
    );
    drop(core);
    let _ = std::fs::remove_dir_all(path);
}

#[test]
fn cached_destination_reads_stay_available_without_credentials() {
    let path = std::env::temp_dir().join(format!(
        "ux09-offline-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    ));
    let provider = Arc::new(Provider::default());
    let core = GmailCore::open(&path, provider.clone()).unwrap();
    ready(&core);
    let catalog = core.list_provider_destinations("a", false).unwrap();
    let request = DestinationRequest {
        account_id: "a".into(),
        destination_id: "Label_1".into(),
        cursor: None,
        cached: false,
    };
    assert!(core.browse_provider_destination(&request).is_ok());

    // Credentials disappear: explicit saved reads remain available and live
    // reads honestly report the missing credentials.
    *provider.credentialless.lock().unwrap() = true;
    assert_eq!(core.list_provider_destinations("a", true).unwrap(), catalog);
    let mut cached = request.clone();
    cached.cached = true;
    assert_eq!(
        core.browse_provider_destination(&cached)
            .unwrap()
            .conversations[0]
            .conversation_ref
            .conversation_id,
        "uncached"
    );
    assert_eq!(
        core.list_provider_destinations("a", false),
        Err(MailError::AuthRequired)
    );
    assert_eq!(
        core.browse_provider_destination(&request),
        Err(MailError::AuthRequired)
    );
    drop(core);
    let _ = std::fs::remove_dir_all(path);
}

#[test]
fn overlapping_live_destination_reads_are_bounded_and_busy_is_honest() {
    let path = std::env::temp_dir().join(format!(
        "ux09-busy-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    ));
    let provider = Arc::new(Provider::default());
    let core = GmailCore::open(&path, provider.clone()).unwrap();
    ready(&core);
    assert!(core.list_provider_destinations("a", false).is_ok());
    let page_request = DestinationRequest {
        account_id: "a".into(),
        destination_id: "Label_1".into(),
        cursor: None,
        cached: false,
    };
    // Prime a saved page so the cached-read assertion below has data.
    assert!(core.browse_provider_destination(&page_request).is_ok());

    // One live job is admitted; overlapping catalog/page requests are typed
    // `busy` and never reach the provider, so abandoned navigation cannot
    // accumulate provider reads. Saved reads stay available meanwhile.
    provider.park();
    let _release_guard = ReleaseOnDrop(&provider);
    let baseline = provider.admissions.lock().unwrap().len();
    let parked_core = core.clone();
    let parked = std::thread::spawn(move || parked_core.list_provider_destinations("a", false));
    provider.wait_admitted_beyond(baseline, 1);
    assert_eq!(
        core.list_provider_destinations("a", false),
        Err(MailError::Busy)
    );
    assert_eq!(
        core.browse_provider_destination(&page_request),
        Err(MailError::Busy)
    );
    let mut cached = page_request.clone();
    cached.cached = true;
    assert!(core.browse_provider_destination(&cached).is_ok());
    assert_eq!(
        provider.admissions.lock().unwrap().len(),
        baseline + 1,
        "overlapping requests must not accumulate provider jobs"
    );

    // Release on success frees admission; further browsing proceeds.
    provider.release();
    assert!(parked.join().unwrap().is_ok());
    assert!(core.browse_provider_destination(&page_request).is_ok());

    // Release on provider error also frees admission.
    provider.park();
    let _error_guard = ReleaseOnDrop(&provider);
    *provider.fail.lock().unwrap() = true;
    let baseline = provider.admissions.lock().unwrap().len();
    let failed_core = core.clone();
    let failed = std::thread::spawn(move || {
        failed_core.browse_provider_destination(&DestinationRequest {
            account_id: "a".into(),
            destination_id: "Label_1".into(),
            cursor: None,
            cached: false,
        })
    });
    provider.wait_admitted_beyond(baseline, 1);
    assert_eq!(
        core.list_provider_destinations("a", false),
        Err(MailError::Busy)
    );
    provider.release();
    assert_eq!(failed.join().unwrap(), Err(MailError::NetworkUnavailable));
    *provider.fail.lock().unwrap() = false;
    assert!(core.browse_provider_destination(&page_request).is_ok());
    drop(core);
    let _ = std::fs::remove_dir_all(path);
}

#[test]
fn disconnect_cancels_the_active_destination_read_and_frees_admission() {
    let path = std::env::temp_dir().join(format!(
        "ux09-disconnect-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    ));
    let provider = Arc::new(Provider::default());
    let core = GmailCore::open(&path, provider.clone()).unwrap();
    ready(&core);
    assert!(core.list_provider_destinations("a", false).is_ok());
    let request = DestinationRequest {
        account_id: "a".into(),
        destination_id: "Label_1".into(),
        cursor: None,
        cached: false,
    };

    // Prime one successful live read so the admission baseline is real.
    assert!(core.list_provider_destinations("a", false).is_ok());
    let baseline = provider.admissions.lock().unwrap().len();
    provider.park();
    let _release_guard = ReleaseOnDrop(&provider);
    let parked_core = core.clone();
    let parked = std::thread::spawn(move || parked_core.browse_provider_destination(&request));
    provider.wait_admitted_beyond(baseline, 1);
    // Disconnect cancels the parked read and waits for it to unwind before
    // clearing credentials and cache; the job observes cancellation.
    core.disconnect_account().unwrap();
    assert_eq!(parked.join().unwrap(), Err(MailError::AuthCancelled));
    // Snapshots were cleared with the account; a later live read is admitted
    // again (the guard was released, not stuck) and fails as not-found.
    assert_eq!(
        core.list_provider_destinations("a", false),
        Err(MailError::NotFound)
    );
    drop(core);
    let _ = std::fs::remove_dir_all(path);
}
