use mail_core::dto::ConversationRef;
use mail_core::gmail::sync::GmailCore;
use mail_core::synthetic::WriteControls;
use mail_core::ACCOUNT_ID;
use std::sync::Arc;

pub(crate) fn open(app_data: &std::path::Path, controls: WriteControls) -> GmailCore {
    let profile_dir = app_data.join("fixture-profile");
    GmailCore::open_synthetic_profile(
        profile_dir,
        controls,
        Arc::new(mail_core::clock::SystemClock),
    )
    .unwrap()
}

pub(crate) fn conv(id: &str) -> ConversationRef {
    ConversationRef {
        account_id: ACCOUNT_ID.into(),
        conversation_id: id.into(),
    }
}

pub(crate) const LEGACY_MAIL_DB: &[u8] =
    include_bytes!("../../crates/mail-core/tests/fixtures/legacy-fixture-profile/mail.db");
