import { loadReminderPreferences, saveReminderPreferences } from '../../src/lib/reminder-preferences';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import ReminderSettings from '../../src/components/ReminderSettings.vue';
import { getDeviceTimeZone } from '../../src/lib/reminder-timezone';

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
