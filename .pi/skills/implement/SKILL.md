---
name: implement
description: Implement an Email OS feature, bug fix, or approved plan from a task description or repository document. Use when asked to implement a scoped change in this repo. Delegates implementation to the local persona-feature-engineer agent.
---

# Implement

Implement the requested change in Email OS. The request can be a task description, an approved plan, or a path to a repository document with a specific item to implement. No ticket service is required.

Usage: `/skill:implement <task description or document path and item>`

All repository paths below are relative to the repository root. The local persona definition is `../../agents/persona-feature-engineer.md` relative to this skill directory.

## 1. Establish the task

- Read the request and referenced documents. Identify the goal, acceptance criteria, non-goals, and affected code.
- If the request names a broad document, ask which item to implement. Do not treat every proposed feature in that document as approved work.
- Ask for clarification if a product, architecture, data migration, or scope decision is missing. Do not invent requirements.
- Inspect the working-tree status. Preserve pre-existing edits and keep one writer per checkout.

## 2. Gather repository context

Use local code and documentation, not external wiki or code-graph services:

- `README.md` for the project entry points and document map.
- `docs/development.md` for setup, commands, profile isolation, and validation gates.
- `docs/adr/0001-single-account-desktop-email-client.md` for accepted first-build scope.
- The relevant slice or UX contract under `docs/`, and the relevant section of `docs/superhuman-browsing-implementation-plan.md` or `superhuman-email-browsing-ux-spec.md` for browsing work.
- `ARCHITECTURE.md` only as a proposal, not as an inventory of implemented behavior. The PRD and older research do not authorize scope expansion.
- Current code and tests to confirm actual behavior. Escalate material conflicts between the task, accepted contracts, and implementation.

Find the affected seam:

- `crates/mail-core/`: Rust mail core, DTOs, SQLite, Gmail auth/provider/cache/sync/actions.
- `src/` and `tests/`: Vue 3/TypeScript UI, IPC adapter, and frontend tests.
- `src-tauri/`: thin Tauri 2 native shell and command/event bridge.
- `src/lib/ipc/generated.ts`: generated wire contract. Never edit it by hand; change the Rust DTOs and run `mise run gen:ts`.

Follow existing conventions and any applicable project instructions. Do not invent a separate coding-standard source.

## 3. Delegate implementation

Using this skill authorizes one implementation subagent. Do not ask the user to request delegation again.

- Read the `pi-subagents` skill and the local persona definition before launch.
- Start `persona-feature-engineer` through the `subagent` tool. Inherit the parent model unless the user specifies another one.
- Give the child a self-contained brief: explicit repository cwd, goal, acceptance criteria, non-goals, relevant files and contracts, pre-existing edits, edit boundary, required checks, verification method, and expected evidence.
- Tell the child to execute directly. It must not use this skill to delegate again or start other agents.
- Leave implementation to the child. Do not edit the same checkout while it works. Follow native async completion notifications; do not poll or sleep.
- Route blocking decisions to the user when the task and project instructions do not already answer them. Do not approve new scope on the user's behalf.

If subagent tooling is unavailable before launch, read the persona definition and do the work directly under its rules. State that fallback. If a launch or runtime fails, stop and report the failure and partial work state. Do not silently switch execution methods.

If you are already the delegated implementation child, follow the persona and execute the task directly. Do not launch another agent.

## 4. Test and verify

Use `mise.toml` and `docs/development.md` as the command source. Select the checks that cover the changed seam:

| Change | Checks |
| --- | --- |
| Rust mail core | `mise run test:core`, `mise run lint:core` |
| Rust DTOs or IPC | Regenerate with `mise run gen:ts`; run `mise run check:contract`, core tests, and affected UI/native checks |
| Vue/TypeScript UI | `mise run test:ui`, `mise run typecheck`, `mise run build:web` |
| Tauri shell or bridge | `mise run check:native`, `mise run test:native`, plus affected core/UI checks |
| Cross-cutting work | `mise run check` plus web build and native checks where affected |

Add focused regression tests. Capture before-and-after behavior as required by the persona. Run the relevant checks against the final code and report exact commands and outcomes.

- Use `mise run dev:web` for the synthetic, in-memory browser preview. Use `mise run dev:native` for native fixture verification. Use a background terminal for long-running dev processes.
- Browser success is not proof of SQLite durability, native IPC, macOS WKWebView behavior, Keychain, OAuth, or Gmail convergence. Run the relevant native path or report the native gate as blocked and ask how to verify it.
- Default to synthetic fixtures and fake-provider tests. Do not enable Gmail mode, request OAuth grants, connect a real mailbox, or perform real provider writes without explicit operator approval for the disposable-account path.
- Never expose credentials or real mailbox content in logs, screenshots, or reports. Preserve profile isolation and existing permission boundaries.
- Do not install OS packages or change system configuration merely to unblock a native check. Report missing prerequisites.

## Rust dependency documentation

Check `Cargo.lock` for the exact resolved crate version before looking up its API. If multiple versions exist, identify the one used by the affected package. Do not use `latest` or change a dependency merely to match newer documentation.

- Item index: `https://docs.rs/{crate}/{version}/{crate_underscored}/all.html`
- Specific item: `https://docs.rs/{crate}/{version}/{crate_underscored}/struct.Foo.html` (or `trait.`, `enum.`, `fn.`)
- Source browser: `https://docs.rs/crate/{crate}/{version}/source/`

Use the same version-specific approach for frontend and Tauri documentation, based on `package.json`, `pnpm-lock.yaml`, and `Cargo.lock`.

## 5. Return the result

Review the child's final diff and evidence against the task. Do not equate a successful agent exit with a verified feature. Report:

- What changed and which acceptance criteria it meets.
- Changed file paths.
- Exact checks and results, including failures or skipped gates.
- Before-and-after verification evidence and artifact paths.
- Remaining risks, blockers, and decisions needed.

Do not claim completion when required verification is missing. Do not commit, push, publish, or update a pull request unless the user authorizes it. Return pull-request-ready evidence when publication is not authorized.
