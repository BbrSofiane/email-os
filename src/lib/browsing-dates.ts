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
  /** BCP-47 locale for captions and labels; defaults to the environment locale. */
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

/** Compact trailing date for a row: time today, short date this month, dated otherwise. */
export function compactDateLabel(timestamp: string, options: BrowsingDateOptions = {}): string {
  const instant = Date.parse(timestamp);
  if (!Number.isFinite(instant)) return 'Unknown';
  const { locale, timeZone } = options;
  const key = dateGroupFor(timestamp, options);
  if (key === 'today') {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).format(new Date(instant));
  }
  if (key === 'yesterday' || key === 'earlier-this-month') {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      timeZone,
    }).format(new Date(instant));
  }
  if (key === 'unknown') return 'Unknown';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(new Date(instant));
}
