//! UX-09 synthetic provider + real SQLite only. No Google or credentials.
use mail_core::gmail::browsing::DestinationRequest;
use mail_core::gmail::sync::GmailCore;
use mail_core::testing::operations_fake::FakeProvider as Provider;
use mail_core::testing::temp_profile;
use mail_core::MailError;
use std::time::{Duration, Instant};

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
        self.0.release_destinations();
    }
}
#[test]
fn uncached_browse_paging_offline_restart_and_account_fencing() {
    let path = temp_profile("provider-destination");
    let provider = Provider::new_for_destinations();
    let core = GmailCore::open(path.path(), provider.clone()).unwrap();
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
    assert_eq!(provider.destination_calls()[1].1.as_deref(), Some("page-2"));
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
    provider.set_destination_fail(true);
    assert_eq!(
        core.browse_provider_destination(&request),
        Err(MailError::NetworkUnavailable)
    );
    drop(core);
    let core = GmailCore::open(path.path(), provider.clone()).unwrap();
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
    drop(path);
}

#[test]
fn foreign_reconnect_never_persists_or_returns_foreign_destination_data() {
    let path = temp_profile("provider-destination");
    let provider = Provider::new_for_destinations();
    let core = GmailCore::open(path.path(), provider.clone()).unwrap();
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
    provider.set_destination_account("b");

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
    drop(path);
}

#[test]
fn cached_destination_reads_stay_available_without_credentials() {
    let path = temp_profile("provider-destination");
    let provider = Provider::new_for_destinations();
    let core = GmailCore::open(path.path(), provider.clone()).unwrap();
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
    provider.set_destination_credentialless(true);
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
    drop(path);
}

#[test]
fn overlapping_live_destination_reads_are_bounded_and_busy_is_honest() {
    let path = temp_profile("provider-destination");
    let provider = Provider::new_for_destinations();
    let core = GmailCore::open(path.path(), provider.clone()).unwrap();
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
    provider.park_destinations();
    let _release_guard = ReleaseOnDrop(&provider);
    let baseline = provider.destination_admission_count();
    let parked_core = core.clone();
    let parked = std::thread::spawn(move || parked_core.list_provider_destinations("a", false));
    provider.wait_for_destination_admissions(baseline, 1);
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
        provider.destination_admission_count(),
        baseline + 1,
        "overlapping requests must not accumulate provider jobs"
    );

    // Release on success frees admission; further browsing proceeds.
    provider.release_destinations();
    assert!(parked.join().unwrap().is_ok());
    assert!(core.browse_provider_destination(&page_request).is_ok());

    // Release on provider error also frees admission.
    provider.park_destinations();
    let _error_guard = ReleaseOnDrop(&provider);
    provider.set_destination_fail(true);
    let baseline = provider.destination_admission_count();
    let failed_core = core.clone();
    let failed = std::thread::spawn(move || {
        failed_core.browse_provider_destination(&DestinationRequest {
            account_id: "a".into(),
            destination_id: "Label_1".into(),
            cursor: None,
            cached: false,
        })
    });
    provider.wait_for_destination_admissions(baseline, 1);
    assert_eq!(
        core.list_provider_destinations("a", false),
        Err(MailError::Busy)
    );
    provider.release_destinations();
    assert_eq!(failed.join().unwrap(), Err(MailError::NetworkUnavailable));
    provider.set_destination_fail(false);
    assert!(core.browse_provider_destination(&page_request).is_ok());
    drop(core);
    drop(path);
}

#[test]
fn disconnect_cancels_the_active_destination_read_and_frees_admission() {
    let path = temp_profile("provider-destination");
    let provider = Provider::new_for_destinations();
    let core = GmailCore::open(path.path(), provider.clone()).unwrap();
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
    let baseline = provider.destination_admission_count();
    provider.park_destinations();
    let _release_guard = ReleaseOnDrop(&provider);
    let parked_core = core.clone();
    let parked = std::thread::spawn(move || parked_core.browse_provider_destination(&request));
    provider.wait_for_destination_admissions(baseline, 1);
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
    drop(path);
}
