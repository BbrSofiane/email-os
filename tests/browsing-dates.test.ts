import { describe, expect, it } from 'vitest';
import {
  compactDateLabel,
  dateGroupCaption,
  dateGroupFor,
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

    expect(compactDateLabel('2026-01-15T09:05:00Z', base)).toBe('09:05');
    expect(compactDateLabel('2026-01-14T09:05:00Z', base)).toBe('14 Jan');
    expect(compactDateLabel('2026-01-02T09:05:00Z', base)).toBe('2 Jan');
    expect(compactDateLabel('2025-06-10T09:05:00Z', base)).toBe('10 Jun 2025');
    // A viewer-local zone shifts both the bucket and the rendered fields.
    const east = { ...base, timeZone: 'Pacific/Kiritimati' };
    expect(compactDateLabel('2026-01-15T13:30:00Z', east)).toBe('03:30');
    expect(compactDateLabel('2026-01-14T23:00:00Z', east)).toBe('15 Jan');
  });
});
