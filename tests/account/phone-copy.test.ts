import { describe, expect, it, vi } from 'vitest';
import { createBrowserFakeMailClient } from '../helpers';
import { accountNotice, inboxEmptyState } from '../../src/lib/account-status';

const platform = vi.hoisted(() => ({ android: true }));
vi.mock('../../src/lib/ipc', async (orig) => ({ ...(await orig<typeof import('../../src/lib/ipc')>()), isAndroidShell: () => platform.android }));

describe('account wording by platform', () => {
  it.each([true, false])('uses platform wording (android=%s)', async (android) => {
    platform.android = android;
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'authenticating' });
    const authenticating = await fake.getAccountStatus();
    expect(accountNotice(authenticating)?.text).toBe(android ? 'Finish sign-in on the next screen' : 'Finish sign-in in your browser');
    expect(accountNotice(authenticating)?.title).toBe(android ? 'Sign-in is waiting on the next screen. Cancel stops it.' : 'Gmail sign-in is waiting for your browser. Cancel stops it.');
    expect(inboxEmptyState(authenticating)?.text).toContain(android ? 'next screen' : 'your browser');
    fake.controls.setAccount({ mode: 'gmail', connection: 'disconnected' });
    expect(inboxEmptyState(await fake.getAccountStatus())?.hint).toContain(android ? 'Opens sign-in on this phone.' : 'Opens Google sign-in in your browser.');
    fake.controls.setAccount({ mode: 'gmail', connection: 'not_configured' });
    expect(inboxEmptyState(await fake.getAccountStatus())?.hint).toBe(android ? 'This build is not registered for sign-in.' : 'Add a Google client ID to the launch environment, then restart.');
  });
});
