import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AccountPanel from '../src/components/AccountPanel.vue';
import { createBrowserFakeMailClient } from './helpers';

describe('account mode switch', () => {
  it('shows the requested target and disables the action during transitions', async () => {
    const status = await createBrowserFakeMailClient().getAccountStatus();
    const wrapper = mount(AccountPanel, { props: { status, busy: null } });
    expect(wrapper.find('[data-test="account-switch-mode"]').exists()).toBe(false);
    await wrapper.setProps({ switchTarget: 'gmail' });
    expect(wrapper.text()).toContain('Sign in on this phone. The demo mailbox stays on this device.');
    const button = wrapper.get('[data-test="account-switch-mode-button"]');
    expect(button.text()).toBe('Use your own mail');
    await button.trigger('click');
    expect(wrapper.emitted('switchMode')).toEqual([['gmail']]);
    await wrapper.setProps({ switchTarget: 'fixture', transitioning: true });
    expect(button.text()).toBe('Switch to demo mailbox');
    expect(wrapper.text()).toContain('Your mail account stays signed in on this phone.');
    expect(button.attributes('disabled')).toBeDefined();
    await wrapper.setProps({ transitioning: false, busy: 'connect' });
    expect(button.attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});
