import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import ModeChoiceGate from '../../src/components/ModeChoiceGate.vue';
import StartupRoot from '../../src/StartupRoot.vue';
import { createBrowserFakeMailClient } from '../../src/lib/ipc/browser-fake';
import { CONNECT_AFTER_SWITCH_KEY, takeConnectAfterSwitch } from '../../src/composables/useModeChoice';
import { reloadPage } from '../../src/lib/reload';
vi.mock('../../src/lib/reload', () => ({ reloadPage: vi.fn() }));
let wrapper: VueWrapper | undefined;
afterEach(() => { wrapper?.unmount(); wrapper = undefined; sessionStorage.clear(); vi.restoreAllMocks(); });
const fake = (chosen = false) => createBrowserFakeMailClient(undefined, undefined, undefined, { modeChoiceChosen: chosen });
describe('mode choice', () => {
  it('clears an existing choice', async () => {
    wrapper = mount(ModeChoiceGate, { props: { client: fake(true) } }); await flushPromises();
    expect(wrapper.emitted('cleared')).toBeTruthy(); expect(wrapper.find('[data-test="mode-choice-gate"]').exists()).toBe(false);
  });
  it('focuses the heading and opens the demo', async () => {
    const client = fake(); const switchMode = vi.spyOn(client, 'switchMode');
    wrapper = mount(ModeChoiceGate, { props: { client }, attachTo: document.body }); await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('h1').element); expect(wrapper.get('h1').text()).toBe('Choose a mailbox');
    expect(wrapper.find('[data-test="mode-choice-own"]').exists()).toBe(true);
    await wrapper.get('[data-test="mode-choice-demo"]').trigger('click'); await flushPromises();
    expect(switchMode).toHaveBeenCalledWith('fixture'); expect(wrapper.emitted('cleared')).toBeTruthy(); expect(reloadPage).not.toHaveBeenCalled();
  });
  it('records the connect flag and reloads for own mail', async () => {
    const client = fake(); const switchMode = vi.spyOn(client, 'switchMode');
    wrapper = mount(ModeChoiceGate, { props: { client } }); await flushPromises();
    await wrapper.get('[data-test="mode-choice-own"]').trigger('click'); await flushPromises();
    expect(switchMode).toHaveBeenCalledWith('gmail'); expect(sessionStorage.getItem(CONNECT_AFTER_SWITCH_KEY)).toBe('true'); expect(reloadPage).toHaveBeenCalled(); expect(wrapper.emitted('cleared')).toBeFalsy();
  });
  it('recovers from a failed switch', async () => {
    const client = fake(); vi.spyOn(client, 'switchMode').mockRejectedValue({ kind: 'storage_unavailable' });
    wrapper = mount(ModeChoiceGate, { props: { client } }); await flushPromises();
    await wrapper.get('[data-test="mode-choice-own"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('storage unavailable'); expect(wrapper.get('button').attributes('disabled')).toBeUndefined(); expect(sessionStorage.getItem(CONNECT_AFTER_SWITCH_KEY)).toBeNull();
  });
  it('takes the flag once and tolerates unavailable storage', () => {
    sessionStorage.setItem(CONNECT_AFTER_SWITCH_KEY, 'true'); expect(takeConnectAfterSwitch()).toBe(true); expect(takeConnectAfterSwitch()).toBe(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); }); expect(takeConnectAfterSwitch()).toBe(false);
  });
  it('holds the app until demo is chosen', async () => {
    wrapper = mount(StartupRoot, { props: { client: fake(), mode: 'browser-preview' }, global: { stubs: { App: { template: '<div data-test="app-stub" />' } } } }); await flushPromises();
    expect(wrapper.find('[data-test="app-stub"]').exists()).toBe(false);
    await wrapper.get('[data-test="mode-choice-demo"]').trigger('click'); await flushPromises(); expect(wrapper.find('[data-test="app-stub"]').exists()).toBe(true);
  });
});
