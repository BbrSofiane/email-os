import { describe, expect, it } from 'vitest';
import {
  compactDateLabel,
  dateGroupCaption,
  dateGroupFor,
  fullDateLabel,
  machineDateTime,
} from '../src/lib/browsing-dates';

/** 2026-01-15 12:00 UTC under an explicit UTC calendar. */
const NOW = Date.parse('2026-01-15T12:00:00Z');
const base = { now: NOW, timeZone: 'UTC', locale: 'en-GB' };

describe('browsing dates (UX-01 viewer-local calendar groups)', () => {
  it('buckets Today, Yesterday, Earlier this month, and named month+year in precedence order', () => {
    expect(dateGroupFor('2026-01-15T00:00:01Z', base)).toBe('today');
    expect(dateGroupFor('2026-01-14T23:59:59Z', base)).toBe('yesterday');
    expect(dateGroupFor('2026-01-14T00:00:00Z', base)).toBe('yesterday');
    expect(dateGroupFor('2026-01-02T12:00:00Z', base)).toBe('earlier-this-month');
    expect(dateGroupFor('2025-06-10T12:00:00Z', base)).toBe('month-2025-06');
  });

  it('crosses month and year boundaries for Yesterday', () => {
    const newYear = { ...base, now: Date.parse('2026-01-01T12:00:00Z') };
    expect(dateGroupFor('2025-12-31T23:59:00Z', newYear)).toBe('yesterday');
    const monthTurn = { ...base, now: Date.parse('2026-02-01T12:00:00Z') };
    expect(dateGroupFor('2026-01-31T23:59:00Z', monthTurn)).toBe('yesterday');
    expect(dateGroupFor('2026-01-30T12:00:00Z', monthTurn)).toBe('month-2026-01');
  });

  it('respects an explicit viewer time zone at day boundaries', () => {
    // +14:00 zone: the same instant is already "tomorrow" there.
    const east = { ...base, timeZone: 'Pacific/Kiritimati' };
    expect(dateGroupFor('2026-01-15T12:00:00Z', east)).toBe('today');
    // -11:00 zone: an instant before local midnight there is still "yesterday".
    const west = { ...base, timeZone: 'Pacific/Midway' };
    expect(dateGroupFor('2026-01-14T23:00:00Z', west)).toBe('yesterday');
    // Late-UTC timestamps that share the west zone's local day are Today there.
    expect(dateGroupFor('2026-01-15T23:00:00Z', west)).toBe('today');
  });

  it('classifies across a DST transition using calendar days, not exact 24h instants', () => {
    // US spring-forward: 2026-03-08 is a 23-hour day in America/New_York.
    const ny = { now: Date.parse('2026-03-09T05:00:00Z'), timeZone: 'America/New_York' };
    expect(dateGroupFor('2026-03-08T09:00:00Z', ny)).toBe('yesterday');
    expect(dateGroupFor('2026-03-07T09:00:00Z', ny)).toBe('earlier-this-month');
  });

  it('maps missing and unparsable timestamps to the Unknown date bucket', () => {
    expect(dateGroupFor('', base)).toBe('unknown');
    expect(dateGroupFor('not-a-timestamp', base)).toBe('unknown');
    expect(dateGroupCaption('unknown')).toBe('Unknown date');
    expect(compactDateLabel('not-a-timestamp', base)).toBe('Unknown');
  });

  it('renders captions and compact labels deterministically for a fixed locale', () => {
    expect(dateGroupCaption('today')).toBe('Today');
    expect(dateGroupCaption('yesterday')).toBe('Yesterday');
    expect(dateGroupCaption('earlier-this-month')).toBe('Earlier this month');
    expect(dateGroupCaption('month-2025-12', 'en-GB')).toBe('December 2025');
    expect(dateGroupCaption('month-2025-12', 'de-DE')).toBe('Dezember 2025');
    expect(dateGroupCaption('month-bogus')).toBe('Unknown date');

    // Captions keep their locale; compact row labels never depend on it.
    expect(compactDateLabel('2026-01-14T09:05:00Z', { ...base, locale: 'de-DE' })).toBe('14 Jan');
  });

  it('formats compact row dates: time today, day+month this year, year added otherwise', () => {
    // Today: 12-hour clock without a leading zero, including the noon/midnight edges.
    expect(compactDateLabel('2026-01-15T08:00:00Z', base)).toBe('8:00 AM');
    expect(compactDateLabel('2026-01-15T09:05:00Z', base)).toBe('9:05 AM');
    expect(compactDateLabel('2026-01-15T00:30:00Z', base)).toBe('12:30 AM');
    expect(compactDateLabel('2026-01-15T12:00:00Z', base)).toBe('12:00 PM');
    expect(compactDateLabel('2026-01-15T23:59:00Z', base)).toBe('11:59 PM');
    // Yesterday and earlier this month are day+month (uppercased by CSS only).
    expect(compactDateLabel('2026-01-14T09:05:00Z', base)).toBe('14 Jan');
    expect(compactDateLabel('2026-01-02T09:05:00Z', base)).toBe('2 Jan');
    // Earlier months of the current year stay compact.
    const november = { ...base, now: Date.parse('2026-11-07T12:00:00Z') };
    expect(compactDateLabel('2026-11-06T18:00:00Z', november)).toBe('6 Nov');
    expect(compactDateLabel('2026-03-01T09:00:00Z', november)).toBe('1 Mar');
    // Any other year names it, including Yesterday across New Year and future dates.
    expect(compactDateLabel('2025-06-10T09:05:00Z', base)).toBe('10 Jun 2025');
    expect(compactDateLabel('2001-09-30T12:00:00Z', base)).toBe('30 Sep 2001');
    const newYear = { ...base, now: Date.parse('2026-01-01T12:00:00Z') };
    expect(compactDateLabel('2025-12-31T23:59:00Z', newYear)).toBe('31 Dec 2025');
    expect(compactDateLabel('2027-02-03T09:00:00Z', base)).toBe('3 Feb 2027');
    // Missing and unparsable timestamps stay explicit.
    expect(compactDateLabel('', base)).toBe('Unknown');
    expect(compactDateLabel('2026-13-45T99:00:00Z', base)).toBe('Unknown');
  });

  it('uses the viewer time zone for the day, the clock and the year', () => {
    // A viewer-local zone shifts both the bucket and the rendered fields.
    const east = { ...base, timeZone: 'Pacific/Kiritimati' };
    expect(compactDateLabel('2026-01-15T13:30:00Z', east)).toBe('3:30 AM');
    expect(compactDateLabel('2026-01-14T23:00:00Z', east)).toBe('15 Jan');
    // New Year's Eve in UTC is already the next year at +14:00 (now there: 16 Jan 2026).
    expect(compactDateLabel('2025-12-31T11:00:00Z', east)).toBe('1 Jan');
    // At -11:00 the same instant is still the previous year.
    const west = { ...base, timeZone: 'Pacific/Midway' };
    expect(compactDateLabel('2026-01-01T05:00:00Z', west)).toBe('31 Dec 2025');
    // DST: New York wall clock, not a fixed offset.
    const ny = { now: Date.parse('2026-07-04T16:00:00Z'), timeZone: 'America/New_York' };
    expect(compactDateLabel('2026-07-04T13:15:00Z', ny)).toBe('9:15 AM');
    expect(compactDateLabel('2026-01-04T13:15:00Z', ny)).toBe('4 Jan');
  });

  it('formats a full, precise date for the reader and date titles, independent of locale', () => {
    expect(fullDateLabel('2025-01-09T18:29:00.000Z', { timeZone: 'UTC' })).toBe('Thu 9 Jan 2025, 6:29 PM');
    expect(fullDateLabel('2026-02-02T09:00:00Z', { timeZone: 'UTC' })).toBe('Mon 2 Feb 2026, 9:00 AM');
    expect(fullDateLabel('2026-02-02T00:05:00Z', { timeZone: 'UTC' })).toBe('Mon 2 Feb 2026, 12:05 AM');
    // Viewer-local: the same instant is the previous evening in New York.
    expect(fullDateLabel('2026-02-02T00:05:00Z', { timeZone: 'America/New_York' })).toBe('Sun 1 Feb 2026, 7:05 PM');
    expect(fullDateLabel('', { timeZone: 'UTC' })).toBe('Unknown date');
    expect(fullDateLabel('not-a-timestamp')).toBe('Unknown date');
  });

  it('normalizes machine-readable datetime values and omits them when unparsable', () => {
    expect(machineDateTime('2025-01-09T18:29:00Z')).toBe('2025-01-09T18:29:00.000Z');
    expect(machineDateTime('2026-02-02T10:00:00+01:00')).toBe('2026-02-02T09:00:00.000Z');
    expect(machineDateTime('')).toBeUndefined();
    expect(machineDateTime('not-a-timestamp')).toBeUndefined();
  });
});
