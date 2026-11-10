// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getReminderPresets, parseReminderTime } from '../src/lib/reminder-time';

const prefs = { hour: 8, minute: 0 };
const now = new Date(2026, 7, 6, 10, 0);

describe('reminder time parsing', () => {
  it.each(['8 am', '5 pm', '9:30 am', '12 am', '12 pm', '3 days', 'aug 7', 'tomorrow', 'next week', 'next monday', 'NeXt MoNdAy', 'next weekend'])('parses %s to a future instant', input => {
    const result = parseReminderTime(input, now, prefs);
    expect(result.ok).toBe(true);
    if (result.ok && result.dueAt) expect(new Date(result.dueAt).getTime()).toBeGreaterThan(now.getTime());
  });
  it('keeps someday untimed and rejects past, invalid, and offset-free ISO input', () => {
    expect(parseReminderTime('someday', now, prefs)).toMatchObject({ ok: true, dueAt: null });
    expect(parseReminderTime('2020-01-01T10:00', now, prefs).ok).toBe(false);
    expect(parseReminderTime('2020-01-01T10:00Z', now, prefs)).toMatchObject({ ok: false, error: 'Choose a time in the future.' });
    expect(parseReminderTime('nonsense', now, prefs).ok).toBe(false);
  });
  it('preserves an explicit offset instant', () => {
    const result = parseReminderTime('2026-08-08T10:00:00+02:00', now, prefs);
    expect(result).toMatchObject({ ok: true, dueAt: '2026-08-08T10:00:00+02:00' });
    if (result.ok && result.dueAt) expect(new Date(result.dueAt).toISOString()).toBe('2026-08-08T08:00:00.000Z');
  });
  it('uses future Monday and Saturday presets and keeps the default hour', () => {
    const presets = getReminderPresets(now, prefs);
    expect(presets.map(x => x.id)).toEqual(['tomorrow', 'next-week', 'next-weekend', 'someday']);
    expect(new Date(presets[1]!.dueAt!).getHours()).toBe(8);
    expect(new Date(presets[1]!.dueAt!).getDay()).toBe(1);
    expect(presets[1]!.label).toBe('Next Monday');
    expect(new Date(presets[1]!.dueAt!).getMinutes()).toBe(0);
    expect(new Date(presets[2]!.dueAt!).getDay()).toBe(6);
  });
  it('means the strictly next Monday, including seven days from Monday, across year boundaries', () => {
    const monday = new Date(2026, 11, 28, 7, 0);
    const result = parseReminderTime('next monday', monday, { hour: 8, minute: 45 });
    expect(result).toMatchObject({ ok: true, label: expect.stringContaining('Next Monday') });
    if (result.ok && result.dueAt) {
      const due = new Date(result.dueAt);
      expect([due.getFullYear(), due.getMonth(), due.getDate(), due.getDay(), due.getHours(), due.getMinutes()]).toEqual([2027, 0, 4, 1, 8, 45]);
    }
    const sunday = new Date(2026, 10, 8, 10, 0);
    expect(parseReminderTime('next week', sunday, prefs)).toMatchObject({ ok: true, label: expect.stringContaining('Next Monday') });
  });
  it('deduplicates Sunday Tomorrow only when both valid suggestions resolve to the same instant', () => {
    const sunday = new Date(2026, 10, 8, 7, 0);
    const presets = getReminderPresets(sunday, { hour: 8, minute: 30 });
    expect(presets.map(item => item.id)).toEqual(['next-week', 'next-weekend', 'someday']);
    expect(presets[0]).toMatchObject({ label: 'Next Monday' });
    expect(new Date(presets[0]!.dueAt!).getHours()).toBe(8);
    expect(new Date(presets[0]!.dueAt!).getMinutes()).toBe(30);
    expect(presets.at(-1)).toMatchObject({ id: 'someday', label: 'Someday', dueAt: null });
  });
  it('keeps wall-clock defaults across the spring DST transition', () => {
    const before = new Date(2026, 2, 7, 12, 0);
    const result = parseReminderTime('next monday', before, { hour: 8, minute: 30 });
    expect(result.ok).toBe(true);
    if (result.ok && result.dueAt) {
      const due = new Date(result.dueAt);
      expect([due.getDay(), due.getHours(), due.getMinutes()]).toEqual([1, 8, 30]);
    }
  });
});

it('resolves clock times and rejects invalid dates rather than normalizing them', () => {
  const afternoon = parseReminderTime('5:30 pm', now, prefs);
  expect(afternoon.ok).toBe(true);
  if (afternoon.ok && afternoon.dueAt) {
    expect(new Date(afternoon.dueAt).getHours()).toBe(17);
    expect(new Date(afternoon.dueAt).getMinutes()).toBe(30);
    expect(new Date(afternoon.dueAt).getDate()).toBe(now.getDate());
  }
  for (const input of ['13 am', '8:60 pm', 'augustgarbage 7', '2027-02-30T08:00:00Z']) {
    expect(parseReminderTime(input, now, prefs).ok).toBe(false);
  }
});
