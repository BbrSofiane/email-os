# Historical Gmail cache schemas

Each SQL file creates an effective SQLite schema from the named committed
revision of `crates/mail-core/src/gmail/store.rs`. The fixture includes the
revision's CREATE statements and additive migration columns. All revisions
following the read-only profile retain the `gmail-2` schema marker, so the
physical schema must be inferred from tables and columns. The files contain no
mailbox rows; migration tests can insert synthetic rows after loading them.

| Fixture | Source revision | Schema milestone |
| --- | --- | --- |
| `gmail-3.sql` | `410fce7` | Reply context and first operation schema |
| `gmail-4.sql` | `7cc2131` | Undo fields and retry metadata |
| `gmail-6.sql` | `5e54e45` | Durable operation groups |
| `gmail-8.sql` | `950f1aa` | Newest sender cache |
| `gmail-9.sql` | `051da89` | Star facts |
| `gmail-10.sql` | `873391a` | Search cache |
| `gmail-11.sql` | `4a40aef` | Subsequent search schema shape |
| `gmail-12.sql` | `7cc775d` | Provider destination snapshots |
| `gmail-13.sql` | `82785c0` | Triage facts |
| `gmail-14.sql` | `e43b10f` | Attachment descriptors |
| `gmail-15.sql` | `236dd4d` | Attachment presence flag |
| `gmail-16.sql` | `58c1082` | Local reminder tables |

The schema normalized from `333acf4` is identical to `7cc2131`, so it uses
`gmail-4.sql`. The schema normalized from `c8ed122` is identical to
`5e54e45`, so it uses `gmail-6.sql`. Equivalence was checked from SQLite table
and column metadata after executing each historical fixture.
