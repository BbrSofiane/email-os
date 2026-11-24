import { describe, expect, it, vi } from 'vitest';
import { createBrowserFakeMailClient, mountApp, useGmailMode } from '../helpers';
import { flushFakeClientWithMacrotasks } from '../support/ui-settle';

describe('online sync', () => {
  it.each(['connected', 'disconnected', 'fixture'] as const)('handles %s', async (mode) => {
    const fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
    if (mode !== 'fixture') useGmailMode(fake, { connection: mode });
    const requestSync = vi.spyOn(fake, 'requestSync');
    const app = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientWithMacrotasks(fake, 3);
    window.dispatchEvent(new Event('online'));
    await flushFakeClientWithMacrotasks(fake, 3);
    expect(requestSync).toHaveBeenCalledTimes(mode === 'connected' ? 1 : 0);
    app.unmount();
  });
});
