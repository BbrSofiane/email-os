/**
 * Viewer-local calendar grouping and compact dates for the compact inbox (UX-01).
 *
 * Bucket precedence: Today, Yesterday, Earlier this month, then one named
 * month+year bucket per calendar month, plus an explicit Unknown date bucket
 * for missing or unparsable timestamps. Bucketing happens in the viewer's
 * calendar — an optional explicit IANA `timeZone`, otherwise the environment's
 * local zone — never in UTC, so Yesterday correctly crosses month and year
 * boundaries (and DST transitions, because calendar arithmetic is done on
 * wall-clock components rather than by subtracting exact instants).
 *
 * This module never reorders rows; the backend's newest-first order is
 * preserved and group headings are derived from consecutive-row changes only.
 */

export interface BrowsingDateOptions {
  /** Reference "now" in epoch milliseconds; defaults to `Date.now()`. */
  now?: number;
  /** IANA time zone for calendar-day computation; defaults to the viewer's zone. */
  timeZone?: string;
  /**
   * BCP-47 locale for named month+year group captions; defaults to the
   * environment locale. Row and reader dates use a fixed format (see below).
   */
  locale?: string;
}

/**
 * `'month-YYYY-MM'` is the named month+year bucket; the remaining keys are the
 * fixed buckets in precedence order.
 */
export type DateGroupKey =
  | 'today'
  | 'yesterday'
  | 'earlier-this-month'
  | 'unknown'
  | `month-${string}`;

const DAY_MS = 86_400_000;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Offset between the target zone's wall clock and UTC at the given instant. */
function zoneOffsetMs(instant: number, timeZone: string | undefined): number {
  if (!timeZone) return -new Date(instant).getTimezoneOffset() * 60_000;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const value = (type: string): number => {
    const found = parts.find((part) => part.type === type)?.value ?? '0';
    return Number(found);
  };
  const asUtc = Date.UTC(
    value('year'), value('month') - 1, value('day'),
    value('hour'), value('minute'), value('second'),
  );
  return asUtc - instant;
}

/** Calendar `YYYY-MM-DD` from a naive wall-clock millisecond value. */
function ymdOfWall(naiveWallMs: number): string {
  const naive = new Date(naiveWallMs);
  return `${naive.getUTCFullYear()}-${pad(naive.getUTCMonth() + 1)}-${pad(naive.getUTCDate())}`;
}

/** Wall-clock `YYYY-MM-DD` for an instant in the target zone. */
function ymdOf(instant: number, timeZone: string | undefined): string {
  return ymdOfWall(instant + zoneOffsetMs(instant, timeZone));
}

export function dateGroupFor(timestamp: string, options: BrowsingDateOptions = {}): DateGroupKey {
  const instant = Date.parse(timestamp);
  if (!Number.isFinite(instant)) return 'unknown';
  const now = options.now ?? Date.now();
  const timeZone = options.timeZone;
  const todayYmd = ymdOf(now, timeZone);
  const timestampYmd = ymdOf(instant, timeZone);
  if (timestampYmd === todayYmd) return 'today';
  // Naive wall-clock subtraction is always the previous calendar day, even
  // across DST transitions and month/year boundaries.
  const yesterdayYmd = ymdOfWall(now + zoneOffsetMs(now, timeZone) - DAY_MS);
  if (timestampYmd === yesterdayYmd) return 'yesterday';
  if (timestampYmd.slice(0, 7) === todayYmd.slice(0, 7)) return 'earlier-this-month';
  return `month-${timestampYmd.slice(0, 7)}`;
}

export function dateGroupCaption(key: DateGroupKey, locale?: string): string {
  switch (key) {
    case 'today':
      return 'Today';
    case 'yesterday':
      return 'Yesterday';
    case 'earlier-this-month':
      return 'Earlier this month';
    case 'unknown':
      return 'Unknown date';
    default: {
      const month = key.slice('month-'.length);
      const [year, monthNumber] = month.split('-').map(Number);
      if (!year || !monthNumber || monthNumber < 1 || monthNumber > 12) return 'Unknown date';
      return new Intl.DateTimeFormat(locale, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
    }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

interface WallClock {
  year: number;
  /** 0-based month index. */
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

/** Wall-clock fields for an instant in the viewer's (or an explicit) zone. */
function wallClockOf(instant: number, timeZone: string | undefined): WallClock {
  const naive = new Date(instant + zoneOffsetMs(instant, timeZone));
  return {
    year: naive.getUTCFullYear(),
    month: naive.getUTCMonth(),
    day: naive.getUTCDate(),
    weekday: naive.getUTCDay(),
    hour: naive.getUTCHours(),
    minute: naive.getUTCMinutes(),
  };
}

/** `8:00 AM`, `12:05 PM`, `12:30 AM`: 12-hour clock, no leading zero. */
function clockLabel({ hour, minute }: WallClock): string {
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}

/*
 * Row and reader dates are a fixed product format (DESIGN.md "Label"), not a
 * locale format: the output depends only on the instant, "now" and the viewer
 * time zone, so the default runtime locale never changes a row's width or
 * text. Month and weekday names are English abbreviations; the row date is
 * rendered uppercase by CSS (`.row-time`), so assistive technology reads the
 * month as a word ("6 Nov"), not as letters.
 */

/**
 * Compact trailing date for a row, in the viewer's calendar:
 * - today: the time (`8:00 AM`);
 * - earlier this calendar year: day and month (`6 Nov`);
 * - any other year, past or future: day, month and year (`9 Jan 2025`);
 * - missing or unparsable: `Unknown`.
 * The `locale` option is ignored here (it only affects month captions).
 */
export function compactDateLabel(timestamp: string, options: BrowsingDateOptions = {}): string {
  const instant = Date.parse(timestamp);
  if (!Number.isFinite(instant)) return 'Unknown';
  const { timeZone } = options;
  const at = wallClockOf(instant, timeZone);
  if (dateGroupFor(timestamp, options) === 'today') return clockLabel(at);
  const dayMonth = `${at.day} ${MONTHS[at.month]}`;
  const nowYear = wallClockOf(options.now ?? Date.now(), timeZone).year;
  return at.year === nowYear ? dayMonth : `${dayMonth} ${at.year}`;
}

/**
 * Full, precise viewer-local date and time (`Thu 9 Jan 2025, 6:29 PM`) for the
 * reader and for row date titles; `Unknown date` when missing or unparsable.
 */
export function fullDateLabel(timestamp: string, options: Pick<BrowsingDateOptions, 'timeZone'> = {}): string {
  const instant = Date.parse(timestamp);
  if (!Number.isFinite(instant)) return 'Unknown date';
  const at = wallClockOf(instant, options.timeZone);
  return `${WEEKDAYS[at.weekday]} ${at.day} ${MONTHS[at.month]} ${at.year}, ${clockLabel(at)}`;
}

/** Normalized machine-readable value for `<time datetime>`, or undefined when unparsable. */
export function machineDateTime(timestamp: string): string | undefined {
  const instant = Date.parse(timestamp);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}
