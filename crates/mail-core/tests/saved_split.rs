use mail_core::dto::{SetArchived, UndoOperation};
use mail_core::splits::{SavedSplit, SplitCriterion};
use mail_core::{MailCore, MailError, ACCOUNT_ID};

#[test]
fn split_survives_restart_and_never_moves_mail_or_supersedes_undo() {
    let dir = std::env::temp_dir().join(format!("saved-split-{}", uuid::Uuid::new_v4()));
    let core = MailCore::open(&dir).unwrap();
    let inbox = core.list_conversations().unwrap();
    let target = inbox.conversations[0].conversation_ref.clone();
    let split = SavedSplit {
        name: " Clients ".into(),
        criterion: SplitCriterion::Domain,
        value: " EXAMPLE.COM ".into(),
        enabled: true,
        hide_when_empty: true,
    };
    assert_eq!(core.get_saved_split(ACCOUNT_ID).unwrap(), None);
    assert_eq!(
        core.save_saved_split("foreign", &split),
        Err(MailError::NotFound)
    );
    let saved = core.save_saved_split(ACCOUNT_ID, &split).unwrap();
    assert_eq!(saved.value, "example.com");
    assert_eq!(core.list_conversations().unwrap(), inbox);
    drop(core);
    let core = MailCore::open(&dir).unwrap();
    assert_eq!(
        core.get_saved_split(ACCOUNT_ID).unwrap(),
        Some(saved.clone())
    );
    let receipt = core
        .set_archived(&SetArchived {
            conversation: target.clone(),
            archived: true,
            request_id: "archive".into(),
        })
        .unwrap();
    core.save_saved_split(
        ACCOUNT_ID,
        &SavedSplit {
            enabled: false,
            ..saved.clone()
        },
    )
    .unwrap();
    assert!(!core.get_conversation(&target).unwrap().is_in_inbox);
    core.undo_operation(&UndoOperation {
        operation_id: receipt.operation_id,
        request_id: "undo".into(),
    })
    .unwrap();
    assert!(core.get_conversation(&target).unwrap().is_in_inbox);
    let invalid = SavedSplit {
        value: "not a domain".into(),
        ..saved
    };
    assert!(matches!(
        core.save_saved_split(ACCOUNT_ID, &invalid),
        Err(MailError::InvalidRequest { .. })
    ));
    assert!(!core.get_saved_split(ACCOUNT_ID).unwrap().unwrap().enabled);
    drop(core);
    std::fs::remove_dir_all(dir).unwrap();
}
