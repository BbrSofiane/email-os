export type SwipePreference = 'remind' | 'done' | 'none';
export interface SwipePreferences { right: SwipePreference; left: SwipePreference }

const STORAGE_KEY = 'email-os.swipe-preferences.v1';
const DEFAULTS: SwipePreferences = { right: 'remind', left: 'done' };
const choices: SwipePreference[] = ['remind', 'done', 'none'];

function valid(value: unknown): value is SwipePreferences {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SwipePreferences> & { version?: number };
  return candidate.version === 1 && choices.includes(candidate.right as SwipePreference) && choices.includes(candidate.left as SwipePreference);
}

export function loadSwipePreferences(): SwipePreferences {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? { right: parsed.right, left: parsed.left } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSwipePreferences(value: SwipePreferences): void {
  if (!choices.includes(value.right) || !choices.includes(value.left)) return;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...value }));
  } catch {
    // Inbox gestures keep their safe defaults when storage is unavailable.
  }
}
