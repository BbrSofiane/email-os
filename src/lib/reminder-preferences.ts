export interface ReminderPreferences {
  hour: number;
  minute: number;
}

const STORAGE_KEY = 'email-os.reminder-preferences.v1';
const DEFAULTS: ReminderPreferences = { hour: 8, minute: 0 };

function valid(value: unknown): value is ReminderPreferences {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ReminderPreferences>;
  return Number.isInteger(candidate.hour) && candidate.hour! >= 0 && candidate.hour! <= 23 &&
    Number.isInteger(candidate.minute) && candidate.minute! >= 0 && candidate.minute! <= 59;
}

export function loadReminderPreferences(): ReminderPreferences {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) && (parsed as ReminderPreferences & { version?: number }).version === 1
      ? { hour: parsed.hour, minute: parsed.minute }
      : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveReminderPreferences(value: ReminderPreferences): void {
  if (!valid(value)) return;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...value }));
  } catch {
    // Settings remain usable when storage is unavailable.
  }
}
