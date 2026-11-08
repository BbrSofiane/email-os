import { beforeEach, describe, expect, it } from 'vitest';
import { loadReminderPreferences, saveReminderPreferences } from '../src/lib/reminder-preferences';

describe('reminder preferences', () => {
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
