# ADR 0003: Compact phone layout

- Status: Accepted
- Date: 2026-11-15

## Context

ADR 0001 established a desktop-only first build, and PRODUCT.md excluded new mobile UI. The Android fixture build now needs a usable phone shell while remaining over the existing mail capabilities.

## Decision

Add a viewport-driven compact layout at widths up to 719 CSS px for the Android fixture target and browser preview. Keep regular desktop layout unchanged. The shell is a single pane with a context top bar, notice dock, context slot and bottom navigation/action host. Android retains padded content insets; native status/navigation bars are colored to the app surface with light system icons.

Excluded from the mobile effort: calendar, AI and voice buttons, send, HTML message bodies, label chips, multiple splits, trash/spam/move actions, reply-all and forward. Inbox zero remains a plain empty state. Later phases own list rows, drawer, reader menus/actions, compose and remaining surfaces.
