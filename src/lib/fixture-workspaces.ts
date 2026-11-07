import { createBrowserFakeMailClient } from './ipc/browser-fake';
import type { MailClient } from './ipc/client';

/** Browser-only ownership descriptor. Not a native account/profile selector. */
export interface FixtureWorkspace {
  readonly accountId: string;
  readonly emailAddress: string;
  readonly client: MailClient;
}

export function createFixtureWorkspaces(): readonly FixtureWorkspace[] {
  return [
    { accountId: 'fixture-account', emailAddress: 'you@fixture.emailos' },
    { accountId: 'fixture-account-two', emailAddress: 'you@second.example.test' },
  ].map((identity) => Object.freeze({
    ...identity,
    client: createBrowserFakeMailClient(undefined, identity),
  }));
}
