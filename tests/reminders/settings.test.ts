import { loadReminderPreferences, saveReminderPreferences } from '../../src/lib/reminder-preferences';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReminderSettings from '../../src/components/ReminderSettings.vue';
import { getDeviceTimeZone } from '../../src/lib/reminder-timezone';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('saves reminder defaults and closes on Escape (UX-11)', () => {
  beforeEach(() => localStorage.clear());
  it('renders defaults, persists saved settings, and emits close on Escape', async () => {
    const wrapper = mount(ReminderSettings);
    expect(wrapper.text()).toContain(getDeviceTimeZone() ?? 'name unavailable');
    expect(wrapper.text()).toContain('does not move existing reminders');
    expect((wrapper.get('[aria-label="Default reminder hour"]').element as HTMLSelectElement).value).toBe('8');
    await wrapper.get('[aria-label="Default reminder hour"]').setValue('17');
    await wrapper.get('[aria-label="Default reminder minute"]').setValue('30');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('saved')?.[0]).toEqual([{ hour: 17, minute: 30 }]);
    expect(localStorage.getItem('email-os.reminder-preferences.v1')).toContain('"version":1');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
  });
});

describe('compact reminder settings', () => {
  beforeEach(() => localStorage.clear());

  it('saves one changed value immediately without closing', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const wrapper = mount(ReminderSettings, { props: { compact: true } });
    await wrapper.get('[aria-label="Default reminder hour"]').setValue('17');
    await flushPromises();

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(loadReminderPreferences()).toEqual({ hour: 17, minute: 0 });
    expect(wrapper.emitted('saved')).toEqual([[{ hour: 17, minute: 0 }]]);
    expect(wrapper.emitted('close')).toBeUndefined();
    expect(wrapper.text()).toContain('Saved');
    expect(wrapper.find('button[type="submit"]').exists()).toBe(false);
    expect(wrapper.find('button[type="button"]').exists()).toBe(false);
    expect(wrapper.get('.settings-note summary').text()).toBe('About changing the default');
    wrapper.unmount();
  });

  it('restores the confirmed value and reports a storage failure', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('storage unavailable');
      }),
    });
    const wrapper = mount(ReminderSettings, { props: { compact: true } });
    await wrapper.get('[aria-label="Default reminder minute"]').setValue('30');
    await flushPromises();

    expect((wrapper.get('[aria-label="Default reminder minute"]').element as HTMLSelectElement).value).toBe('0');
    expect(wrapper.get('[role="alert"]').text()).toBe('Could not save reminder settings.');
    expect(wrapper.emitted('saved')).toBeUndefined();
    expect(wrapper.emitted('close')).toBeUndefined();
    wrapper.unmount();
  });

  it('keeps Save and Cancel in regular mode', async () => {
    const wrapper = mount(ReminderSettings, { props: { compact: false } });
    expect(wrapper.find('.settings-note').exists()).toBe(false);
    expect(wrapper.text()).toContain('Changing defaults does not move existing reminders');
    await wrapper.get('[aria-label="Default reminder hour"]').setValue('17');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.find('button[type="submit"]').text()).toBe('Save');
    expect(wrapper.find('button[type="button"]').text()).toBe('Cancel');
    expect(wrapper.emitted('saved')).toEqual([[{ hour: 17, minute: 0 }]]);
    wrapper.unmount();
  });
});

describe('loads default reminder preferences and persists valid settings', () => {
  beforeEach(() => localStorage.clear());
  it('defaults to 08:00 and persists validated versioned settings', () => {
    expect(loadReminderPreferences()).toEqual({ hour: 8, minute: 0 });
    saveReminderPreferences({ hour: 17, minute: 30 });
    expect(loadReminderPreferences()).toEqual({ hour: 17, minute: 30 });
  });
  it('ignores malformed or out-of-range stored values', () => {
    localStorage.setItem('email-os.reminder-preferences.v1', '{');
    expect(loadReminderPreferences()).toEqual({ hour: 8, minute: 0 });
    localStorage.setItem('email-os.reminder-preferences.v1', '{"version":1,"hour":24,"minute":2}');
    expect(loadReminderPreferences()).toEqual({ hour: 8, minute: 0 });
  });
});
