//! Seed-once synthetic inbox: 24 conversations with HTML samples (ADR 0006) with fixed IDs, timestamps and
//! literal text. Hostile markup is ordinary data — never interpreted, never
//! logged. Seeding is guarded by a meta marker so restarts never re-seed,
//! reset provider facts, or reset operation history.

use crate::drafts::types::ReplyContext;
use crate::dto::{ConversationRef, Message};

pub(crate) type Participant = (&'static str, &'static str);

/// Source of a synthetic HTML body.
#[derive(Clone)]
pub(crate) enum HtmlSource {
    Static(&'static str),
    Oversized,
}
/// Metadata for the fixture PNG.
#[derive(Clone)]
pub(crate) struct SeedInlineImage {
    pub content_id: &'static str,
    pub attachment_id: &'static str,
}
pub(crate) struct SeedMessage {
    pub html: Option<HtmlSource>,
    pub inline_image: Option<SeedInlineImage>,
    pub id: &'static str,
    pub from: Participant,
    pub to: &'static [Participant],
    pub sent_at: &'static str,
    pub body: &'static str,
}

#[derive(Clone)]
pub(crate) struct SeedConversation {
    pub id: &'static str,
    pub subject: &'static str,
    /// Cached provider INBOX fact applied to every message of the conversation.
    pub in_inbox: bool,
    pub messages: &'static [SeedMessage],
}

const ME: Participant = ("You", crate::FIXTURE_MAILBOX);

const INBOX_ANA: Participant = ("Ana Ridpath", "ana@ridpath.example");
const INBOX_BORIS: Participant = ("Boris Chen", "boris@plumbing.example");
const NOREPLY: Participant = ("Fixture Billing", "noreply@billing.example");
const NO_NAME: Participant = ("", "anon@example.org");

const TO_ME: &[Participant] = &[ME];
const TO_ANA: &[Participant] = &[INBOX_ANA];
const TO_BORIS: &[Participant] = &[INBOX_BORIS];

pub(crate) const SEED_VERSION: &str = "2";

/// Seeded read state (ADR 0002 decision 2). The Inbox arrives as a realistic
/// mix rather than uniformly unread:
/// * mail the user sent is read;
/// * a conversation whose newest message the user wrote is read (conv-02,
///   conv-04, conv-14, conv-16), as is a thread the user already dealt with;
/// * a few others are read (the invoice conv-03 and the digest conv-10);
/// * everything else in the Inbox is unread (16 of the 22 conversations), and
///   the two initially archived conversations are read.
pub(crate) const SEEDED_READ_CONVERSATIONS: &[&str] = &[
    "conv-02", "conv-03", "conv-04", "conv-10", "conv-14", "conv-16",
];

/// Whether a seeded message starts unread.
pub(crate) fn seeded_unread(conversation: &SeedConversation, message: &SeedMessage) -> bool {
    conversation.in_inbox
        && !SEEDED_READ_CONVERSATIONS.contains(&conversation.id)
        && message.from.1 != crate::FIXTURE_MAILBOX
}
pub(crate) fn fixtures() -> Vec<SeedConversation> {
    let mut result = vec![
        SeedConversation {
            id: "conv-01",
            subject: "Standup notes for Monday",
            in_inbox: true,
            messages: &[
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-01-1",
                    from: INBOX_ANA,
                    to: TO_ME,
                    sent_at: "2026-01-12T08:05:00Z",
                    body: "Morning! Standing agenda: release checklist, then the fixture inbox demo.\nI attached nothing, everything is inline below.",
                },
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-01-2",
                    from: ME,
                    to: TO_ANA,
                    sent_at: "2026-01-12T08:11:00Z",
                    body: "Works for me. I'll bring the archive/unarchive walkthrough.",
                },
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-01-3",
                    from: INBOX_ANA,
                    to: TO_ME,
                    sent_at: "2026-01-12T08:19:00Z",
                    body: "Perfect. Let's keep the demo to the frozen slice, no scope creep.",
                },
            ],
        },
        SeedConversation {
            id: "conv-02",
            subject: "Q3 budget review <script>alert(\"xss\")</script>",
            in_inbox: true,
            messages: &[
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-02-1",
                    from: INBOX_BORIS,
                    to: TO_ME,
                    sent_at: "2026-01-12T09:40:00Z",
                    body: "Reminder: numbers are due Thursday.\n\n<div style=\"display:none\">hidden template junk stays literal</div>\n&amp; should render as &amp; — a literal ampersand, not an entity.",
                },
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-02-2",
                    from: ME,
                    to: TO_BORIS,
                    sent_at: "2026-01-12T09:52:00Z",
                    body: "Noted. I'll double-check the plumbing line items.",
                },
            ],
        },
        SeedConversation {
            id: "conv-03",
            subject: "Invoice 4471 — due 2026-02-01",
            in_inbox: true,
            messages: &[SeedMessage {
                html: None, inline_image: None,
                id: "m-03-1",
                from: NOREPLY,
                to: TO_ME,
                sent_at: "2026-01-12T10:02:00Z",
                body: "Your invoice is attached to no one, because this fixture has no attachments.\nAmount: 42.00 EUR. Reference: INV-4471-🧾.",
            }],
        },
        SeedConversation {
            id: "conv-04",
            subject: "🚀 Ship it: keyboard-first review pass 🎹",
            in_inbox: true,
            messages: &[
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-04-1",
                    from: INBOX_ANA,
                    to: TO_ME,
                    sent_at: "2026-01-12T11:15:00Z",
                    body: "j/k navigation feels right. Enter opens, Escape returns. 🚀",
                },
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-04-2",
                    from: ME,
                    to: TO_ANA,
                    sent_at: "2026-01-12T11:21:00Z",
                    body: "Agreed. e archives, unarchive stays explicit in the reader.",
                },
            ],
        },
        SeedConversation {
            id: "conv-05",
            subject: "Long thread: offsite logistics",
            in_inbox: true,
            messages: &[SeedMessage {
                html: None, inline_image: None,
                id: "m-05-1",
                from: INBOX_BORIS,
                to: TO_ME,
                sent_at: "2026-01-12T13:00:00Z",
                body: "Here is the long version. First line is the preview.\nThe rest of this body is filler that exists to make sure previews truncate at a bounded length and never run off the end of the line like an unbounded buffer of characters that would keep going forever and ever without any natural stopping point whatsoever.",
            }],
        },
        SeedConversation {
            id: "conv-06",
            subject: "Old announcement: office move",
            in_inbox: false,
            messages: &[SeedMessage {
                html: None, inline_image: None,
                id: "m-06-1",
                from: NOREPLY,
                to: TO_ME,
                sent_at: "2026-01-12T07:30:00Z",
                body: "The office moved last quarter. This conversation is already archived at the provider, but stays recoverable from activity.",
            }],
        },
        SeedConversation {
            id: "conv-07",
            subject: "Design review: reader typography",
            in_inbox: true,
            messages: &[
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-07-1",
                    from: INBOX_ANA,
                    to: TO_ME,
                    sent_at: "2026-01-12T14:05:00Z",
                    body: "Plain text only for the slice. No remote fonts, no automatic loading.",
                },
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-07-2",
                    from: ME,
                    to: TO_ANA,
                    sent_at: "2026-01-12T14:18:00Z",
                    body: "Monospace for hostile markup previews, regular face for ordinary bodies.",
                },
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-07-3",
                    from: INBOX_ANA,
                    to: TO_ME,
                    sent_at: "2026-01-12T14:30:00Z",
                    body: "Approved with that caveat.",
                },
            ],
        },
        SeedConversation {
            id: "conv-08",
            subject: "Plumbing: valve replacement quote",
            in_inbox: true,
            messages: &[SeedMessage {
                html: None, inline_image: None,
                id: "m-08-1",
                from: INBOX_BORIS,
                to: TO_ME,
                sent_at: "2026-01-12T15:12:00Z",
                body: "Quote attached below as plain text:\n  valve x2 ....... 180 EUR\n  labor ......... 220 EUR\nReply by Friday please.",
            }],
        },
        SeedConversation {
            id: "conv-09",
            subject: "Re: domain migration checklist",
            in_inbox: true,
            messages: &[
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-09-1",
                    from: NO_NAME,
                    to: TO_ME,
                    sent_at: "2026-01-12T16:00:00Z",
                    body: "Sender has no display name; the UI must show the bare mailbox address.",
                },
            ],
        },
        SeedConversation {
            id: "conv-10",
            subject: "Weekly digest #14",
            in_inbox: true,
            messages: &[SeedMessage {
                html: None, inline_image: None,
                id: "m-10-1",
                from: NOREPLY,
                to: TO_ME,
                sent_at: "2026-01-12T17:45:00Z",
                body: "Digest content. Nothing to act on.",
            }],
        },
        SeedConversation {
            id: "conv-11",
            subject: "Terminal escape \\u001b[31m in subject? No. In body yes:",
            in_inbox: true,
            messages: &[SeedMessage {
                html: None, inline_image: None,
                id: "m-11-1",
                from: INBOX_ANA,
                to: TO_ME,
                sent_at: "2026-01-12T18:02:00Z",
                body: "Body contains a literal backslash sequence: \\u001b[31mred\\u001b[0m\nIt must appear as typed characters, never interpreted.",
            }],
        },
        SeedConversation {
            id: "conv-12",
            subject: "Photography club: winter shoot",
            in_inbox: true,
            messages: &[
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-12-1",
                    from: INBOX_BORIS,
                    to: TO_ME,
                    sent_at: "2026-01-13T09:00:00Z",
                    body: "Saturday 07:00 at the reservoir. Bring the wide lens. 📷",
                },
            ],
        },
        SeedConversation {
            id: "conv-13",
            subject: "Quote with \"double\" and 'single' quotes \u{202E}reversed\u{202C}",
            in_inbox: true,
            messages: &[SeedMessage {
                html: None, inline_image: None,
                id: "m-13-1",
                from: INBOX_ANA,
                to: TO_ME,
                sent_at: "2026-01-13T10:30:00Z",
                body: "Subject mixes quotes and bidi controls; render both literally.",
            }],
        },
        SeedConversation {
            id: "conv-14",
            subject: "Perf notes: serial worker, no locks during provider calls",
            in_inbox: true,
            messages: &[SeedMessage {
                html: None, inline_image: None,
                id: "m-14-1",
                from: ME,
                to: TO_ANA,
                sent_at: "2026-01-13T11:40:00Z",
                body: "While the provider is paused, reads and new commands must still commit.",
            }],
        },
        SeedConversation {
            id: "conv-15",
            subject: "Receipt template v2",
            in_inbox: false,
            messages: &[SeedMessage {
                html: None, inline_image: None,
                id: "m-15-1",
                from: NOREPLY,
                to: TO_ME,
                sent_at: "2026-01-13T12:25:00Z",
                body: "Archived long ago at the provider; facts persist across restarts.",
            }],
        },
        SeedConversation {
            id: "conv-16",
            subject: "Lunch Thursday?",
            in_inbox: true,
            messages: &[
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-16-1",
                    from: INBOX_BORIS,
                    to: TO_ME,
                    sent_at: "2026-01-13T13:10:00Z",
                    body: "Ramen place near the office, 12:30?",
                },
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-16-2",
                    from: ME,
                    to: TO_BORIS,
                    sent_at: "2026-01-13T13:15:00Z",
                    body: "Yes. I'll book it.",
                },
            ],
        },
        SeedConversation {
            id: "conv-17",
            subject: "HTML entity storm &lt;b&gt;bold&lt;/b&gt; &#65; &copy;",
            in_inbox: true,
            messages: &[SeedMessage {
                html: None, inline_image: None,
                id: "m-17-1",
                from: INBOX_ANA,
                to: TO_ME,
                sent_at: "2026-01-13T15:05:00Z",
                body: "Body too: &lt;i&gt;italic&lt;/i&gt; &#38; &quot;quotes&quot;. Literal everywhere.",
            }],
        },
        SeedConversation {
            id: "conv-18",
            subject: "Fixture notes: restart recovery",
            in_inbox: true,
            messages: &[
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-18-1",
                    from: ME,
                    to: TO_ANA,
                    sent_at: "2026-01-13T16:20:00Z",
                    body: "Pending archive operations survive restart and resume in acceptance order.",
                },
                SeedMessage {
                    html: None, inline_image: None,
                    id: "m-18-2",
                    from: INBOX_ANA,
                    to: TO_ME,
                    sent_at: "2026-01-13T16:31:00Z",
                    body: "And interrupted 'applying' rows return to 'queued' at next launch.",
                },
            ],
        },
    ];
    use std::sync::OnceLock;
    static EXTRA: OnceLock<Vec<SeedConversation>> = OnceLock::new();
    let extra_fixtures = EXTRA.get_or_init(|| {
        let mut result = Vec::new();
        fn derived(html: &'static str) -> &'static str {
            Box::leak(
                crate::gmail::parse::html_to_text(html)
                    .unwrap_or_default()
                    .into_boxed_str(),
            )
        }
        fn extra(
            id: &'static str,
            subject: &'static str,
            sender: Participant,
            body: &'static str,
            html: HtmlSource,
            image: Option<SeedInlineImage>,
            older: bool,
        ) -> SeedConversation {
            let mut messages = Vec::new();
            if older {
                messages.push(SeedMessage {
                    id: "m-22-1",
                    from: INBOX_ANA,
                    to: TO_ME,
                    sent_at: "2026-01-14T09:00:00Z",
                    body: "Here are the venue options.",
                    html: None,
                    inline_image: None,
                });
            }
            let message_id = match id {
                "conv-19" => "m-19-1",
                "conv-20" => "m-20-1",
                "conv-21" => "m-21-1",
                "conv-22" => "m-22-2",
                "conv-23" => "m-23-1",
                _ => "m-24-1",
            };
            messages.push(SeedMessage {
                id: message_id,
                from: sender,
                to: TO_ME,
                sent_at: "2026-01-15T09:00:00Z",
                body,
                html: Some(html),
                inline_image: image,
            });
            SeedConversation {
                id,
                subject,
                in_inbox: true,
                messages: Box::leak(messages.into_boxed_slice()),
            }
        }
        const PERSON: &str = include_str!("html/person.html");
        const CID: &str = include_str!("html/cid.html");
        const HOSTILE: &str = include_str!("html/hostile.html");
        result.push(extra(
            "conv-19",
            "Fixture Weekly: issue 12",
            ("Fixture Weekly", "digest@newsletter.example"),
            include_str!("html/newsletter.txt"),
            HtmlSource::Static(include_str!("html/newsletter.html")),
            None,
            false,
        ));
        result.push(extra(
            "conv-20",
            "Plan for next week",
            INBOX_ANA,
            derived(PERSON),
            HtmlSource::Static(PERSON),
            None,
            false,
        ));
        result.push(extra(
            "conv-21",
            "Logo proof",
            ("Lee", "lee@fixture.example"),
            derived(CID),
            HtmlSource::Static(CID),
            Some(SeedInlineImage {
                content_id: "logo@fixture.example",
                attachment_id: "fixture-logo",
            }),
            false,
        ));
        result.push(extra(
            "conv-22",
            "Re: Venue options",
            INBOX_ANA,
            include_str!("html/reply-chain.txt"),
            HtmlSource::Static(include_str!("html/reply-chain.html")),
            None,
            true,
        ));
        result.push(extra(
            "conv-23",
            "Hostile HTML sample",
            ("Sample", "sample@fixture.example"),
            derived(HOSTILE),
            HtmlSource::Static(HOSTILE),
            None,
            false,
        ));
        result.push(extra(
            "conv-24",
            "Oversized HTML sample",
            ("Archive", "archive@fixture.example"),
            derived("<p>This message's formatted version is larger than the reader keeps.</p>"),
            HtmlSource::Oversized,
            None,
            false,
        ));
        result
    });
    result.extend(extra_fixtures.iter().cloned());
    result
}

// Deterministic reply headers for the synthetic mailbox. Shared by the legacy
// fixture store and the synthetic provider so the two cannot drift apart.

pub(crate) fn fixture_reply_context(
    conversation: &ConversationRef,
    messages: &[Message],
) -> Option<ReplyContext> {
    let latest = messages.last()?;
    let message_id = fixture_rfc_message_id(&conversation.conversation_id, &latest.id);
    let references = messages[..messages.len().saturating_sub(1)]
        .iter()
        .map(|message| fixture_rfc_message_id(&conversation.conversation_id, &message.id))
        .collect();
    Some(ReplyContext {
        source_message_id: latest.id.clone(),
        from_mailbox: latest.from.mailbox.clone(),
        reply_to_mailboxes: None,
        message_id,
        references,
    })
}

/// Produces deterministic RFC Message-IDs for the synthetic fixture's explicit
/// From, absent Reply-To, Message-ID, and References header facts.
fn fixture_rfc_message_id(conversation_id: &str, message_id: &str) -> String {
    let local = conversation_id
        .chars()
        .chain(std::iter::once('.'))
        .chain(message_id.chars())
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '.' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!("<{local}@fixture.emailos>")
}
