use mail_core::testing::synthetic::*;

#[test]
fn smoke() {
    let s = Synthetic::open("smoke");
    let snap = s.core.list_conversations().unwrap();
    assert_eq!(snap.conversations.len(), 16);
    load_archived_seeds(&s.core).unwrap();
    let status = s.core.account_status().unwrap();
    println!("{status:?}");
    assert_eq!(status.sync.cached_conversations, 18);
}
