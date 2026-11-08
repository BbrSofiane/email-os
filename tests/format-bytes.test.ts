import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMIT_BYTES, formatBytes } from '../src/lib/format-bytes';

describe('formatBytes', () => {
  it('prints exact bytes below 1 KiB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(27)).toBe('27 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('prints one decimal for KB and MB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(4812333)).toBe('4.6 MB');
    expect(formatBytes(ATTACHMENT_LIMIT_BYTES)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('never prints 1024 of a smaller unit', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB');
  });

  it('clamps negatives and refuses non-finite sizes', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('unknown size');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('unknown size');
  });
});
