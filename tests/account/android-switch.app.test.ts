import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createBrowserFakeMailClient, mountApp, openUtilityDrawer } from '../helpers';
import { flushFakeClientWithMacrotasks } from '../support/ui-settle';
import { CONNECT_AFTER_SWITCH_KEY } from '../../src/composables/useModeChoice';

const state = vi.hoisted(() => ({ android: true, reload: vi.fn() }));
vi.mock('../../src/lib/ipc', async (orig) => ({ ...(await orig<typeof import('../../src/lib/ipc')>()), isAndroidShell: () => state.android }));
vi.mock('../../src/lib/reload', () => ({ reloadPage: state.reload }));

afterEach(() => { sessionStorage.clear(); state.android = true; state.reload.mockReset(); });

describe('Android account switching', () => {
  it.each([['gmail', true, 'Switch to demo mailbox'], ['fixture', true, 'Use your own mail'], ['gmail', false, '']] as const)('shows the switch for %s on Android=%s', async (mode, android, label) => {
    state.android = android;
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode });
    const w = mountApp({ ...fake, getModeChoice: async () => ({ chosen: true, mode }) }, 'browser-preview', { attachTo: document.body });
    await flushFakeClientWithMacrotasks(fake, 3);
    await openUtilityDrawer(w, 'account');
    const button = w.find('[data-test="account-switch-mode-button"]');
    expect(button.exists()).toBe(android);
    if (android) expect(button.text()).toBe(label);
    w.unmount();
  });
  it('clears the reconnect flag and displays a switch error', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'disconnected' });
    const switchMode = vi.fn().mockRejectedValue({ kind: 'storage_unavailable' });
    const w = mountApp({ ...fake, switchMode, getModeChoice: async () => ({ chosen: true, mode: 'fixture' }) }, 'browser-preview', { attachTo: document.body });
    await flushFakeClientWithMacrotasks(fake, 3);
    await openUtilityDrawer(w, 'account');
    await w.get('[data-test="account-switch-mode-button"]').trigger('click');
    await flushPromises();
    expect(switchMode).toHaveBeenCalledOnce();
    expect(w.find('[data-test="account-action-error"]').exists()).toBe(true);
    expect(sessionStorage.getItem(CONNECT_AFTER_SWITCH_KEY)).toBeNull();
    expect(state.reload).not.toHaveBeenCalled();
    w.unmount();
  });
  it.each(['gmail', 'fixture'] as const)('reconnects once only for disconnected %s', async (mode) => {
    sessionStorage.setItem(CONNECT_AFTER_SWITCH_KEY, 'true');
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode, connection: 'disconnected' });
    const connectAccount = vi.fn(() => fake.connectAccount());
    const w = mountApp({ ...fake, connectAccount }, 'browser-preview', { attachTo: document.body });
    await flushPromises();
    expect(connectAccount).toHaveBeenCalledTimes(mode === 'gmail' ? 1 : 0);
    if (mode === 'gmail') expect(sessionStorage.getItem(CONNECT_AFTER_SWITCH_KEY)).toBeNull();
    w.unmount();
  });
});
