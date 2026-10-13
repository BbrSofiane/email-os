//! Seed-once synthetic inbox: 18 conversations with fixed IDs, timestamps and
//! literal text. Hostile markup is ordinary data — never interpreted, never
//! logged. Seeding is guarded by a meta marker so restarts never re-seed,
//! reset provider facts, or reset operation history.

pub(crate) type Participant = (&'static str, &'static str);

pub(crate) struct SeedMessage {
    pub id: &'static str,
    pub from: Participant,
    pub to: &'static [Participant],
    pub sent_at: &'static str,
    pub body: &'static str,
}

pub(crate) struct SeedConversation {
    pub id: &'static str,
    pub subject: &'static str,
    /// Cached provider INBOX fact applied to every message of the conversation.
    pub in_inbox: bool,
    pub messages: &'static [SeedMessage],
}

const ME: Participant = ("You", "you@fixture.emailos");

const INBOX_ANA: Participant = ("Ana Ridpath", "ana@ridpath.example");
const INBOX_BORIS: Participant = ("Boris Chen", "boris@plumbing.example");
const NOREPLY: Participant = ("Fixture Billing", "noreply@billing.example");
const NO_NAME: Participant = ("", "anon@example.org");

const TO_ME: &[Participant] = &[ME];
const TO_ANA: &[Participant] = &[INBOX_ANA];
const TO_BORIS: &[Participant] = &[INBOX_BORIS];

pub(crate) const SEED_VERSION: &str = "1";
pub(crate) fn fixtures() -> Vec<SeedConversation> {
    vec![
        SeedConversation {
            id: "conv-01",
            subject: "Standup notes for Monday",
            in_inbox: true,
            messages: &[
                SeedMessage {
                    id: "m-01-1",
                    from: INBOX_ANA,
                    to: TO_ME,
                    sent_at: "2026-01-12T08:05:00Z",
                    body: "Morning! Standing agenda: release checklist, then the fixture inbox demo.\nI attached nothing, everything is inline below.",
                },
                SeedMessage {
                    id: "m-01-2",
                    from: ME,
                    to: TO_ANA,
                    sent_at: "2026-01-12T08:11:00Z",
                    body: "Works for me. I'll bring the archive/unarchive walkthrough.",
                },
                SeedMessage {
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
                    id: "m-02-1",
                    from: INBOX_BORIS,
                    to: TO_ME,
                    sent_at: "2026-01-12T09:40:00Z",
                    body: "Reminder: numbers are due Thursday.\n\n<div style=\"display:none\">hidden template junk stays literal</div>\n&amp; should render as &amp; — a literal ampersand, not an entity.",
                },
                SeedMessage {
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
                    id: "m-04-1",
                    from: INBOX_ANA,
                    to: TO_ME,
                    sent_at: "2026-01-12T11:15:00Z",
                    body: "j/k navigation feels right. Enter opens, Escape returns. 🚀",
                },
                SeedMessage {
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
                    id: "m-07-1",
                    from: INBOX_ANA,
                    to: TO_ME,
                    sent_at: "2026-01-12T14:05:00Z",
                    body: "Plain text only for the slice. No remote fonts, no automatic loading.",
                },
                SeedMessage {
                    id: "m-07-2",
                    from: ME,
                    to: TO_ANA,
                    sent_at: "2026-01-12T14:18:00Z",
                    body: "Monospace for hostile markup previews, regular face for ordinary bodies.",
                },
                SeedMessage {
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
                    id: "m-16-1",
                    from: INBOX_BORIS,
                    to: TO_ME,
                    sent_at: "2026-01-13T13:10:00Z",
                    body: "Ramen place near the office, 12:30?",
                },
                SeedMessage {
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
                    id: "m-18-1",
                    from: ME,
                    to: TO_ANA,
                    sent_at: "2026-01-13T16:20:00Z",
                    body: "Pending archive operations survive restart and resume in acceptance order.",
                },
                SeedMessage {
                    id: "m-18-2",
                    from: INBOX_ANA,
                    to: TO_ME,
                    sent_at: "2026-01-13T16:31:00Z",
                    body: "And interrupted 'applying' rows return to 'queued' at next launch.",
                },
            ],
        },
    ]
}
