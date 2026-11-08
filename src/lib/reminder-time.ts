import type { ReminderPreferences } from './reminder-preferences';

export interface ReminderTimeOption { id: string; label: string; dueAt: string | null }
export type ReminderTimeResult =
  | { ok: true; dueAt: string | null; label: string }
  | { ok: false; error: string };

function localDate(date: Date, hour: number, minute: number): Date | null {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
  if (result.getFullYear() !== date.getFullYear() || result.getMonth() !== date.getMonth() ||
      result.getDate() !== date.getDate() || result.getHours() !== hour || result.getMinutes() !== minute) return null;
  // A second instant with the same wall time means a DST fold. Do not choose one silently.
  for (const delta of [-120, -90, -60, -30, 30, 60, 90, 120]) {
    const alternate = new Date(result.getTime() + delta * 60_000);
    if (alternate.getFullYear() === date.getFullYear() && alternate.getMonth() === date.getMonth() &&
        alternate.getDate() === date.getDate() && alternate.getHours() === hour && alternate.getMinutes() === minute) return null;
  }
  return result;
}

function option(id: string, label: string, date: Date, prefs: ReminderPreferences, now: Date): ReminderTimeOption {
  const at = localDate(date, prefs.hour, prefs.minute);
  return { id, label: at && at.getTime() > now.getTime() ? label : `${label} (unavailable)`, dueAt: at && at.getTime() > now.getTime() ? at.toISOString() : null };
}

export function getReminderPresets(now: Date, preferences: ReminderPreferences): ReminderTimeOption[] {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilMonday);
  const daysUntilSaturday = (6 - now.getDay() + 7) % 7 || 7;
  const saturday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilSaturday);
  const suggestions = [option('tomorrow', 'Tomorrow', tomorrow, preferences, now), option('next-week', 'Next Monday', monday, preferences, now), option('next-weekend', 'Next weekend', saturday, preferences, now)];
  // On Sunday, Tomorrow and Next Monday can be the same available instant.
  // Keep the explicit weekday choice and retain unavailable options.
  const tomorrowOption = suggestions[0]!;
  const mondayOption = suggestions[1]!;
  const distinctSuggestions = tomorrowOption.dueAt && tomorrowOption.dueAt === mondayOption.dueAt
    ? suggestions.filter(suggestion => suggestion.id !== 'tomorrow')
    : suggestions;
  return [...distinctSuggestions, { id: 'someday', label: 'Someday', dueAt: null }];
}

function readable(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

// New reminder inputs use whole-second RFC3339 instants, as both native stores require.
// Validate before Date parsing: Date silently normalizes invalid calendar days and 24:00.
export function isReminderTimestamp(value: string): boolean {
  if (value.length > 40) return false;
  const parts = value.match(/^(\d{4}-\d\d-\d\d)[Tt ]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(0+))?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
  if (!parts) return false;
  const calendar = new Date(`${parts[1]}T00:00:00Z`);
  return Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === parts[1]
    && Number.isFinite(Date.parse(value));
}

export function parseReminderTime(input: string, now: Date, preferences: ReminderPreferences): ReminderTimeResult {
  const text = input.trim().toLowerCase();
  if (text === 'someday') return { ok: true, dueAt: null, label: 'Someday' };
  const iso = input.trim();
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i.test(iso)) {
    if (iso.length > 40) return { ok: false, error: 'Enter an ISO time of at most 40 characters.' };
    if (/\.\d*[1-9]\d*(?:Z|[+-]\d\d:\d\d)$/i.test(iso)) return { ok: false, error: 'Choose a whole-second time. Fractional seconds must be zero.' };
    // Minute-only text is convenient to type, but native admission requires seconds.
    const normalized = iso.replace(/([Tt]\d\d:\d\d)(Z|[+-]\d\d:\d\d)$/i, '$1:00$2');
    if (!isReminderTimestamp(normalized)) return { ok: false, error: 'Enter a valid date and time.' };
    const date = new Date(normalized);
    if (date <= now) return { ok: false, error: 'Choose a time in the future.' };
    return { ok: true, dueAt: /z$/i.test(normalized) ? date.toISOString() : normalized, label: readable(date) };
  }
  let target: Date | null = null;
  let label = '';
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const clockTime = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  const relative = text.match(/^(\d+)\s+days?$/);
  if (relative) {
    const count = Number(relative[1]);
    if (count < 1 || count > 36500) return { ok: false, error: 'Enter a number of days from 1 to 36500.' };
    target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + count);
    label = `${count} day${count === 1 ? '' : 's'}`;
  } else if (text === 'tomorrow') { target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1); label = 'Tomorrow'; }
  else if (text === 'next monday' || text === 'next week') { const add = (8 - now.getDay()) % 7 || 7; target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + add); label = 'Next Monday'; }
  else if (text === 'next weekend') { const add = (6 - now.getDay() + 7) % 7 || 7; target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + add); label = 'Next weekend'; }
  else if (clockTime) {
    const clockHour = Number(clockTime[1]);
    const clockMinute = Number(clockTime[2] ?? 0);
    if (clockHour < 1 || clockHour > 12 || clockMinute > 59) return { ok: false, error: 'Enter a valid clock time, such as “9:30 am”.' };
    const hour = clockHour % 12 + (clockTime[3] === 'pm' ? 12 : 0);
    target = new Date(base);
    label = `${clockHour}:${String(clockMinute).padStart(2, '0')} ${clockTime[3]!.toUpperCase()}`;
    let at = localDate(target, hour, clockMinute);
    if (at && at <= now) {
      target.setDate(target.getDate() + 1);
      at = localDate(target, hour, clockMinute);
    }
    if (!at) return { ok: false, error: 'That local time is ambiguous or does not exist because of a clock change.' };
    return at > now ? { ok: true, dueAt: at.toISOString(), label: `${label} · ${readable(at)}` } : { ok: false, error: 'Choose a time in the future.' };
  } else {
    const monthDay = text.match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})$/);
    if (!monthDay) return { ok: false, error: 'Try “8 am”, “3 days”, “Aug 7”, “tomorrow”, “next Monday”, “next weekend”, “someday”, or an ISO time with an offset.' };
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const monthText = monthDay[1]!.slice(0, 3);
    const month = months.indexOf(monthText); const day = Number(monthDay[2]);
    let year = now.getFullYear();
    target = new Date(year, month, day);
    if (target.getMonth() !== month || target.getDate() !== day) return { ok: false, error: 'Enter a valid calendar date.' };
    let at = localDate(target, preferences.hour, preferences.minute);
    if (!at) return { ok: false, error: 'That local time is ambiguous or does not exist because of a clock change.' };
    if (at <= now) {
      do { year++; target = new Date(year, month, day); } while (target.getMonth() !== month || target.getDate() !== day);
      at = localDate(target, preferences.hour, preferences.minute);
    }
    if (!at) return { ok: false, error: 'That local time is ambiguous or does not exist because of a clock change.' };
    label = `${monthText[0]!.toUpperCase()}${monthText.slice(1)} ${day}`;
  }
  const at = target && localDate(target, preferences.hour, preferences.minute);
  if (!at) return { ok: false, error: 'That local time is ambiguous or does not exist because of a clock change.' };
  if (at <= now) return { ok: false, error: 'Choose a time in the future.' };
  return { ok: true, dueAt: at.toISOString(), label: `${label} · ${readable(at)}` };
}
