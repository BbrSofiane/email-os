import type { BrowsingActionId } from './browsing-actions';

/**
 * Presentation metadata for the command palette: which group an action sits in,
 * the words people reach for besides its label, and the bound keys that have no
 * command behind them. Labels and shortcuts stay in browsing-actions.ts.
 */
export type ActionGroup = 'conversation' | 'selection' | 'view' | 'goto';

export const actionGroups: ReadonlyArray<{ id: ActionGroup; label: string }> = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'selection', label: 'Selection' },
  { id: 'view', label: 'View' },
  { id: 'goto', label: 'Go to' },
];

export const actionGroupOf: Record<BrowsingActionId, ActionGroup> = {
  compose: 'conversation', reply: 'conversation',
  open: 'conversation', back: 'conversation', archive: 'conversation', unarchive: 'conversation',
  remind: 'conversation', undo: 'conversation', star: 'conversation', unstar: 'conversation',
  read: 'conversation', unread: 'conversation',
  'select-all-loaded': 'selection', 'clear-selection': 'selection',
  search: 'view', 'create-split': 'view', 'edit-split': 'view', 'toggle-unread-filter': 'view',
  inbox: 'goto', saved: 'goto', done: 'goto', starred: 'goto', destinations: 'goto', trash: 'goto', reminders: 'goto',
  drafts: 'goto', activity: 'goto', account: 'goto', 'switch-account': 'goto',
};

/** Extra search words per action; the label and the bound key are always searchable. */
export const actionAliases: Record<BrowsingActionId, readonly string[]> = {
  compose: ['new message', 'write', 'new draft', 'mail'],
  reply: ['respond', 'answer', 'write back', 'draft'],
  open: ['read', 'view', 'enter'],
  back: ['close', 'return', 'previous screen'],
  archive: ['archive', 'done', 'finish', 'clear'],
  unarchive: ['unarchive', 'restore', 'not done', 'move to inbox', 'undone'],
  remind: ['snooze', 'later', 'reminder'],
  undo: ['undo', 'revert', 'reverse', 'take back'],
  star: ['favorite', 'flag', 'important', 'pin'],
  unstar: ['unfavorite', 'unflag', 'remove star'],
  read: ['seen', 'opened'],
  unread: ['unseen', 'new'],
  'select-all-loaded': ['select all', 'every', 'bulk'],
  'clear-selection': ['deselect', 'unselect', 'none'],
  search: ['find', 'older', 'history'],
  'create-split': ['new split', 'new view', 'filter inbox'],
  'edit-split': ['change split', 'rename split', 'view'],
  'toggle-unread-filter': ['filter', 'unread only', 'all conversations'],
  inbox: ['home', 'mail'],
  saved: ['split', 'view'],
  done: ['finished', 'completed'],
  starred: ['favorites', 'flagged'],
  destinations: ['provider', 'labels', 'folders', 'all mail'],
  trash: ['bin', 'deleted', 'delete'],
  reminders: ['snoozed', 'later'],
  drafts: ['compose', 'draft', 'writing'],
  activity: ['operations', 'history', 'log', 'queue', 'pending'],
  account: ['settings', 'google', 'gmail', 'permissions', 'access'],
  'switch-account': ['change account', 'workspace', 'mailbox'],
};

/** Bound keys that move or select without being a command; shown, never executed. */
export interface KeyHint { id: string; label: string; keys: readonly string[]; aliases: readonly string[] }
export const keyHints: readonly KeyHint[] = [
  { id: 'move', label: 'Next and previous conversation', keys: ['J', 'K'], aliases: ['down', 'up', 'arrow', 'move', 'navigate'] },
  { id: 'select', label: 'Select conversation', keys: ['X'], aliases: ['check', 'toggle', 'mark'] },
  { id: 'extend', label: 'Extend selection', keys: ['Shift+J', 'Shift+K'], aliases: ['range', 'multiple', 'select'] },
  { id: 'destinations', label: 'Open destinations', keys: ['←'], aliases: ['navigator', 'left', 'go to'] },
];

/** "G then E (within 1 second)" → "G then E"; the timing stays in the tooltip. */
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
