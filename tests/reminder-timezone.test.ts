// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { formatReminderDateTime, getDeviceTimeZone } from '../src/lib/reminder-timezone';

describe('reminder timezone labels', () => {
  it('uses the resolved device zone and offset for the due instant', () => {
    const zone = getDeviceTimeZone();
    const winter = formatReminderDateTime('2030-01-15T15:00:00Z');
    const summer = formatReminderDateTime('2030-07-15T15:00:00Z');
    expect(winter).toContain(zone ?? 'device time zone name unavailable');
    expect(winter).toContain(new Intl.DateTimeFormat(undefined, { timeZoneName: 'longOffset' }).formatToParts(new Date('2030-01-15T15:00:00Z')).find(part => part.type === 'timeZoneName')!.value);
    expect(summer).toContain(new Intl.DateTimeFormat(undefined, { timeZoneName: 'longOffset' }).formatToParts(new Date('2030-07-15T15:00:00Z')).find(part => part.type === 'timeZoneName')!.value);
    if (zone === 'America/New_York') expect(winter).not.toContain('GMT-04:00');
    if (zone === 'America/New_York') expect(summer).toContain('GMT-04:00');
  });

  it('does not call an unknown timezone UTC and handles invalid dates', () => {
    const resolved = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => { throw new Error('unavailable'); });
    expect(getDeviceTimeZone()).toBeNull();
    expect(formatReminderDateTime('2030-01-15T15:00:00Z')).toContain('device time zone name unavailable');
    expect(formatReminderDateTime('not a date')).toBe('Unknown time');
    resolved.mockRestore();
  });
});
