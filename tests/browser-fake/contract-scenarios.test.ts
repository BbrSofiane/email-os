/**
 * Shared contract scenarios (ticket 17), browser-fake half.
 *
 * Runs every file under tests/fixtures/contract-scenarios/ against
 * `createBrowserFakeMailClient`, in both of the fake's modes: `fixture` (the
 * archive-only native fixture analogue) and `gmail` (Gmail core analogue). The
 * Rust core is the source of truth; the same files run against GmailCore and
 * the fixture MailCore in crates/mail-core/tests/contract_scenarios.rs. Format
 * and how to add a scenario: docs/development.md ("Contract scenarios").
 *
 * Time is the fake's injected clock; the asynchronous worker is observed by
 * yielding macrotasks until the expected state holds (bounded), never by
 * waiting on a clock.
 */
import { flushPromises } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createBrowserFakeMailClient, type BrowserFake, type FakeMailboxSeed } from '../../src/lib/ipc/browser-fake';
import {
  Bindings, CLOCK_START, MUTATING, expandSnapshot, match, normalizeArgs, restrictToDeclared, substitute,
  type Json, type MailboxJson, type Scenario,
} from '../support/contract-scenarios';
import mailboxes from '../fixtures/contract-scenarios/mailboxes.json';

const files = import.meta.glob('../fixtures/contract-scenarios/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const scenarios = Object.entries(files)
  .filter(([path]) => !path.endsWith('/mailboxes.json'))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, json]) => ({ file: path.split('/').pop() as string, scenario: json as Scenario }));

type Profile = 'gmail' | 'fixture';

/**
 * Named, VISIBLE divergences of the fake from the Rust core. Each entry is still
 * executed and must FAIL; when the divergence is fixed the run fails until the
 * entry is removed. Nothing is silently skipped.
 */
const KNOWN_DIVERGENCES: Array<{ scenario: string; profile: Profile; why: string }> = [
  {
    scenario: 'fixture-rejects-unsupported-commands',
    profile: 'fixture',
    why: 'KD-2: the native shell answers setRead/setReadGroup in fixture mode with invalid_request{field:mode}; the fake (and the client.ts contract comment) say read_only, and tests/browser-fake/groups.test.ts asserts read_only. Needs a decision on which is intended.',
  },
];

function mailboxOf(scenario: Scenario): MailboxJson {
  if (typeof scenario.mailbox === 'string') {
    const named = (mailboxes as Record<string, MailboxJson>)[scenario.mailbox];
    if (!named) throw new Error(`unknown mailbox ${scenario.mailbox}`);
    return named;
  }
  return scenario.mailbox;
}

function openFake(profile: Profile, mailbox: MailboxJson, clock: { ms: number }): BrowserFake {
  const fake = createBrowserFakeMailClient(() => new Date(clock.ms).toISOString(), undefined, mailbox as FakeMailboxSeed);
  if (profile === 'gmail') {
    fake.controls.setAccount({
      mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test',
      initialSyncComplete: true, mutationAccess: 'enabled',
    });
  }
  return fake;
}

function applyProvider(fake: BrowserFake, mode: string): void {
  const { behavior } = fake.controls;
  switch (mode) {
    case 'hold_queued': behavior.holdQueued = true; break;
    case 'hold_applying': behavior.hold = true; break;
    case 'reject_next': behavior.failureKind = 'provider_rejected'; behavior.failNext = 1; break;
    case 'release': behavior.hold = false; behavior.holdQueued = false; fake.controls.release(); break;
    default: throw new Error(`unknown provider mode ${mode}`);
  }
}

async function execute(fake: BrowserFake, command: string, args: Record<string, Json>): Promise<unknown> {
  const client = fake as unknown as Record<string, (arg: unknown) => Promise<unknown>>;
  const method = client[command];
  if (typeof method !== 'function') throw new Error(`unknown contract command ${command}`);
  return method.call(fake, args);
}

async function observe(fake: BrowserFake, ready: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await flushPromises();
    await fake.controls.flush();
    if (await ready()) return;
  }
}

async function runScenario(scenario: Scenario, profile: Profile): Promise<string | null> {
  const mailbox = mailboxOf(scenario);
  const declared = mailbox.conversations.map((conversation) => conversation.id);
  const clock = { ms: Date.parse(CLOCK_START) };
  const fake = openFake(profile, mailbox, clock);
  const account = (await fake.getAccountStatus()).account?.accountId ?? '';
  const bindings = new Bindings();
  const snapshotOf = async () => restrictToDeclared(await fake.listConversations(), declared);

  for (const [index, step] of scenario.steps.entries()) {
    const label = `step ${index + 1} (${step.name ?? 'unnamed'})`;
    const { cmd, advance, provider } = step.do;
    if (typeof advance === 'number') {
      clock.ms += advance * 1000;
    } else if (typeof provider === 'string') {
      applyProvider(fake, provider);
    } else if (cmd) {
      const args = normalizeArgs(cmd, substitute((step.do.args ?? {}) as Json, bindings) as Record<string, Json>, account);
      let outcome: { ok: unknown } | { error: unknown };
      try {
        outcome = { ok: await execute(fake, cmd, args) };
      } catch (error) {
        if (error instanceof Error) return `${label}: unexpected exception ${error.stack ?? error.message}`;
        outcome = { error };
      }
      const { ok, error } = step.expect;
      if ('ok' in outcome && step.expect.ok !== undefined && error === undefined) {
        const problem = match(ok as Json, outcome.ok, 'ok', bindings);
        if (problem) return `${label}: ${problem}`;
      } else if ('error' in outcome && error !== undefined && ok === undefined) {
        const problem = match(error, outcome.error, 'error', bindings);
        if (problem) return `${label}: ${problem}\n  actual: ${JSON.stringify(outcome.error)}`;
      } else if ('ok' in outcome) {
        return `${label}: expected ${error !== undefined ? `error ${JSON.stringify(error)}` : 'ok or error in expect'}, got success ${JSON.stringify(outcome.ok)?.slice(0, 300)}`;
      } else {
        return `${label}: expected ${ok !== undefined ? 'success' : 'ok or error in expect'}, got error ${JSON.stringify(outcome.error)}`;
      }
      if (MUTATING.includes(cmd) && error === undefined && step.expect.snapshot === undefined) {
        return `${label}: a successful mutating step must declare expect.snapshot`;
      }
    } else {
      return `${label}: step has no cmd/advance/provider`;
    }

    if (step.expect.snapshot) {
      const want = expandSnapshot(step.expect.snapshot);
      await observe(fake, async () => match(want, await snapshotOf(), 'snapshot', bindings.clone()) === null);
      const actual = await snapshotOf();
      const problem = match(want, actual, 'snapshot', bindings);
      if (problem) {
        const inbox = actual.conversations.map((row) => row.ref.conversationId);
        return `${label}: ${problem}\n  actual inbox ${JSON.stringify(inbox)} activity ${JSON.stringify(actual.activity)}`;
      }
    }
  }
  return null;
}

describe('shared contract scenarios on the browser fake', () => {
  it('finds the scenario files', () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const { file, scenario } of scenarios) {
    for (const profile of scenario.profiles) {
      const known = KNOWN_DIVERGENCES.find((entry) => entry.scenario === scenario.scenario && entry.profile === profile);
      it(`${scenario.scenario} @ fake-${profile}${known ? ' [KNOWN DIVERGENCE]' : ''} (${file})`, async () => {
        const problem = await runScenario(scenario, profile);
        if (known) {
          expect(problem, `now passes: remove its KNOWN_DIVERGENCES entry (${known.why})`).not.toBeNull();
          return;
        }
        expect(problem).toBeNull();
      });
    }
  }
});
