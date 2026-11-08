import { describe, expect, it } from 'vitest';
import { reminderPresets } from '../src/lib/reminder-presets';

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

describe('reminder presets (RFC3339 with a numeric offset)', () => {
  it('computes Later today, Tomorrow and Next week in a non-UTC zone', () => {
    // Fri 6 Nov 2026 10:07 in New York (UTC-5 after the 1 Nov fall-back).
    const now = new Date('2026-11-06T15:07:00Z');
    const presets = reminderPresets(now, 'America/New_York');
    // 10:07 + 3h = 13:07, rounded up to the next quarter hour.
    expect(presets.laterToday).toBe('2026-11-06T13:15:00-05:00');
    expect(presets.tomorrow).toBe('2026-11-07T09:00:00-05:00');
    // Next Monday is 9 Nov.
    expect(presets.nextWeek).toBe('2026-11-09T09:00:00-05:00');
    for (const value of [presets.laterToday!, presets.tomorrow, presets.nextWeek]) {
      expect(value).toMatch(RFC3339);
      expect(Number.isFinite(Date.parse(value))).toBe(true);
    }
  });

  it('keeps an exact quarter hour and uses fractional-hour offsets', () => {
    // 09:00 in Kolkata (UTC+05:30) = 03:30Z; + 3h = 12:00 exactly.
    const presets = reminderPresets(new Date('2026-11-06T03:30:00Z'), 'Asia/Kolkata');
    expect(presets.laterToday).toBe('2026-11-06T12:00:00+05:30');
    expect(presets.tomorrow).toBe('2026-11-07T09:00:00+05:30');
  });

  it('withholds Later today when three hours later is another local day', () => {
    // 22:30 on Thu 5 Nov in New York: +3h crosses midnight.
    const presets = reminderPresets(new Date('2026-11-06T03:30:00Z'), 'America/New_York');
    expect(presets.laterToday).toBeNull();
    // Tomorrow is still the next local calendar day.
    expect(presets.tomorrow).toBe('2026-11-06T09:00:00-05:00');
  });

  it('rolls Tomorrow across month and year ends', () => {
    const presets = reminderPresets(new Date('2026-12-31T17:00:00Z'), 'UTC');
    expect(presets.tomorrow).toBe('2027-01-01T09:00:00+00:00');
    // 31 Dec 2026 is a Thursday: next Monday is 4 Jan 2027.
    expect(presets.nextWeek).toBe('2027-01-04T09:00:00+00:00');
  });

  it('gives the following Monday when today is Monday, and Monday when today is Sunday', () => {
    expect(reminderPresets(new Date('2026-11-09T12:00:00Z'), 'UTC').nextWeek).toBe('2026-11-16T09:00:00+00:00');
    expect(reminderPresets(new Date('2026-11-08T12:00:00Z'), 'UTC').nextWeek).toBe('2026-11-09T09:00:00+00:00');
  });

  it('follows the DST change in the target zone', () => {
    // Sat 7 Mar 2026 12:00 in New York (EST). DST starts at 2am on 8 Mar, so
    // Tomorrow's 09:00 already carries the summer offset.
    const presets = reminderPresets(new Date('2026-03-07T17:00:00Z'), 'America/New_York');
    expect(presets.tomorrow).toBe('2026-03-08T09:00:00-04:00');
    expect(presets.nextWeek).toBe('2026-03-09T09:00:00-04:00');
  });
});
