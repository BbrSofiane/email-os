/**
 * Preset reminder times for the Reminders picker.
 *
 * Each preset is a real RFC3339 string with seconds and a numeric UTC offset
 * (`2026-11-09T09:00:00-05:00`), which is exactly what the reminder transport
 * accepts. Presets only fill the same `dueAt` value the typed field fills; they
 * add no new backend behaviour.
 *
 * - Later today: now plus 3 hours, rounded up to the next quarter hour. When
 *   that lands on another local day the preset is withheld (`null`) so the UI
 *   never offers "today" for a time that is tomorrow.
 * - Tomorrow: 09:00 on the next local day.
 * - Next week: 09:00 on the next Monday (a Monday gives the Monday after).
 *
 * The zone is the viewer's by default. A fixed IANA zone can be passed for
 * tests; DST is whatever `Intl` reports for the target wall-clock time.
 */
export interface ReminderPresets {
  laterToday: string | null;
  tomorrow: string;
  nextWeek: string;
}

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function wallClockOf(instant: number, timeZone?: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant));
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    hour: Number(value('hour')),
    minute: Number(value('minute')),
    second: Number(value('second')),
    weekday: WEEKDAYS[value('weekday')] ?? 0,
  };
}

/** Offset of the zone from UTC at an instant, in minutes (east is positive). */
function offsetMinutes(instant: number, timeZone?: string): number {
  const at = wallClockOf(instant, timeZone);
  return (Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, at.second) - Math.floor(instant / 1000) * 1000) / 60000;
}

/** The instant of a local wall-clock time. A time inside a DST gap moves forward. */
function instantOf(year: number, month: number, day: number, hour: number, minute: number, timeZone?: string): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMinutes(asUtc, timeZone);
  let instant = asUtc - first * 60000;
  const second = offsetMinutes(instant, timeZone);
  if (second !== first) instant = asUtc - second * 60000;
  return instant;
}

const two = (value: number): string => String(value).padStart(2, '0');

function rfc3339(instant: number, timeZone?: string): string {
  const at = wallClockOf(instant, timeZone);
  const offset = offsetMinutes(instant, timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${at.year}-${two(at.month)}-${two(at.day)}T${two(at.hour)}:${two(at.minute)}:${two(at.second)}${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

/** Local calendar day `days` after the given one, at 09:00. */
function nineAm(from: WallClock, days: number, timeZone?: string): number {
  // Date.UTC normalizes day overflow across months and years.
  const day = new Date(Date.UTC(from.year, from.month - 1, from.day + days));
  return instantOf(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 9, 0, timeZone);
}

export function reminderPresets(now: Date, timeZone?: string): ReminderPresets {
  const today = wallClockOf(now.getTime(), timeZone);
  const quarter = 15 * 60000;
  const later = Math.ceil((now.getTime() + 3 * 3600000) / quarter) * quarter;
  const laterWall = wallClockOf(later, timeZone);
  const sameDay = laterWall.year === today.year && laterWall.month === today.month && laterWall.day === today.day;
  const untilMonday = ((8 - today.weekday) % 7) || 7;
  return {
    laterToday: sameDay ? rfc3339(later, timeZone) : null,
    tomorrow: rfc3339(nineAm(today, 1, timeZone), timeZone),
    nextWeek: rfc3339(nineAm(today, untilMonday, timeZone), timeZone),
  };
}
