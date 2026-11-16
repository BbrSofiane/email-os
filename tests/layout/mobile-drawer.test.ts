import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MobileDrawer from '../../src/components/mobile/MobileDrawer.vue';
import type { AvailableAction } from '../../src/lib/action-registry';

const actions: AvailableAction[] = [
  { id: 'inbox', label: 'Go to Inbox', shortcut: '' },
  { id: 'saved', label: 'Go to Clients', shortcut: '' },
  { id: 'starred', label: 'Go to cached Starred', shortcut: '' },
  { id: 'drafts', label: 'Go to local Drafts', shortcut: '' },
  { id: 'done', label: 'Go to cached Done', shortcut: '', disabledReason: 'Unavailable offline' },
  { id: 'reminders', label: 'Go to local Reminders', shortcut: '' },
  { id: 'trash', label: 'Go to cached Trash (read only)', shortcut: '' },
  { id: 'destinations', label: 'Go to Provider mail (read only)', shortcut: '' },
  { id: 'activity', label: 'Go to Activity', shortcut: '' },
  { id: 'account', label: 'Go to Account', shortcut: '' },
  { id: 'reminder-settings', label: 'Reminder Settings', shortcut: '' },
];

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MobileDrawer', () => {
  it('renders only available destinations and describes qualified labels', () => {
    const wrapper = mount(MobileDrawer, {
      attachTo: document.body,
      props: { open: true, email: 'mail@example.test', current: 'inbox', actions },
    });
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('Destinations');
    expect(wrapper.get('.mobile-drawer-account').text()).toBe('mail@example.test');
    expect(wrapper.find('[aria-current="page"]').text()).toContain('Inbox');
    expect(wrapper.find('[data-test="compose"]').exists()).toBe(false);
    expect(wrapper.get('button[title="Unavailable offline"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('button[aria-description="Go to cached Trash (read only)"]').exists()).toBe(true);
    expect(wrapper.findAll('.mobile-drawer-row').map((row) => row.text())).toContain('Commands');
    const settings = wrapper.findAll('.mobile-drawer-row').find((row) => row.text() === 'Reminder settings');
    const commands = wrapper.findAll('.mobile-drawer-row').find((row) => row.text() === 'Commands');
    expect(settings?.find('svg').attributes('data-glyph')).toBe('settings');
    expect(commands?.find('svg').attributes('data-glyph')).toBe('prompt');
    wrapper.unmount();
  });

  it('emits the selected action, closes, and closes from the scrim', async () => {
    const wrapper = mount(MobileDrawer, {
      props: { open: true, email: '', current: 'inbox', actions },
    });
    await wrapper.get('button[aria-current="page"]').trigger('click');
    expect(wrapper.emitted('execute')?.[0]).toEqual(['inbox']);
    expect(wrapper.emitted('close')).toHaveLength(1);
    await wrapper.get('[data-test="mobile-drawer-scrim"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(2);
  });

  it('moves focus into the current destination and restores it after close', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const wrapper = mount(MobileDrawer, {
      attachTo: document.body,
      props: { open: false, email: '', current: 'drafts', actions },
    });
    await wrapper.setProps({ open: true });
    await wrapper.vm.$nextTick();
    expect(document.activeElement?.getAttribute('aria-current')).toBe('page');
    await wrapper.setProps({ open: false });
    await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(opener);
    wrapper.unmount();
  });
});
