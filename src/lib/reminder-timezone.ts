/** Current device timezone identifier, when the runtime exposes one. */
export function getDeviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.trim() ? zone : null;
  } catch {
    return null;
  }
}

/** Format a reminder instant with its offset at that instant, not today's offset. */
export function formatReminderDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown time';

  let formatted: string;
  try {
    formatted = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(date);
  } catch {
    formatted = date.toLocaleString();
  }

  const zone = getDeviceTimeZone();
  let offset: string | null = null;
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'longOffset' }).formatToParts(date);
    offset = parts.find(part => part.type === 'timeZoneName')?.value ?? null;
  } catch {
    // Use the instant's local offset if the runtime lacks longOffset support.
  }
  if (!offset) {
    const minutes = -date.getTimezoneOffset();
    const sign = minutes >= 0 ? '+' : '-';
    const absolute = Math.abs(minutes);
    offset = `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  }
  const annotation = zone ? `${zone}, ${offset}` : `device time zone name unavailable, ${offset}`;
  return `${formatted} (${annotation})`;
}
