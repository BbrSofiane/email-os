import { createBrowserFakeMailClient } from './ipc/browser-fake';
import type { MailClient } from './ipc/client';

/** Browser-only ownership descriptor. Not a native account/profile selector. */
export interface FixtureWorkspace {
  readonly accountId: string;
  readonly emailAddress: string;
  readonly client: MailClient;
}

/**
 * The browser preview's two synthetic workspaces. The primary one also carries
 * the ADR 0006 HTML samples (conv-19..conv-24), as the native fixture does.
 */
export function createFixtureWorkspaces(): readonly FixtureWorkspace[] {
  return [
    { accountId: 'fixture-account', emailAddress: 'you@fixture.emailos', htmlSamples: true },
    { accountId: 'fixture-account-two', emailAddress: 'you@second.example.test', htmlSamples: false },
  ].map(({ htmlSamples, ...identity }) => Object.freeze({
    ...identity,
    client: createBrowserFakeMailClient(undefined, identity, undefined, { htmlSamples }),
  }));
}
