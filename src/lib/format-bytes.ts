/** Largest attachment the client will fetch: 5 MiB, shown to people as "5 MB". */
export const ATTACHMENT_LIMIT_BYTES = 5 * 1024 * 1024;

const UNITS = ['KB', 'MB', 'GB'] as const;

/**
 * Human file size in the style mail clients use: binary steps (1024) with the
 * short unit names. Bytes are exact ("27 B"); larger sizes keep one decimal
 * ("1.0 KB", "4.6 MB"). A negative size reads as 0 B; a size that is not a
 * finite number reads "unknown size" instead of inventing a value.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown size';
  const size = Math.max(0, Math.floor(bytes));
  if (size < 1024) return `${size} B`;
  let value = size / 1024;
  let unit = 0;
  // Rounding must not print "1024.0 KB": step up when the display would reach 1024.
  while (unit < UNITS.length - 1 && Math.round(value * 10) / 10 >= 1024) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}
