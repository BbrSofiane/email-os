/**
 * Pure helpers for the command palette's search and shortcut text. What the
 * commands are (groups, aliases, keys, glyphs) is declared in action-registry.ts.
 */

/** Strips a trailing parenthetical from a shortcut hint, e.g. "G then E (note)" → "G then E". */
export function compactShortcut(shortcut: string): string {
  return shortcut.replace(/\s*\([^)]*\)\s*$/, '');
}

/**
 * Every whitespace-separated word must hit the label, an alias, or exactly the
 * bound key. "undo", "snooze", "z" and "go to cached done" all behave.
 */
export function matchesQuery(query: string, label: string, aliases: readonly string[], keys: readonly string[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = `${label} ${aliases.join(' ')}`.toLowerCase();
  const bound = keys.map((key) => compactShortcut(key).toLowerCase()).filter(Boolean);
  return words.every((word) => haystack.includes(word) || bound.includes(word));
}
