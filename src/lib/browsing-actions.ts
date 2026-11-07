/** Frontend discovery only; execution still uses the named typed MailClient methods. */
export const browsingActions = [
  { id: 'open', label: 'Open conversation', shortcut: 'Enter' },
  { id: 'back', label: 'Back', shortcut: 'Escape' },
  { id: 'archive', label: 'Mark Done (Archive)', shortcut: 'E' },
  { id: 'unarchive', label: 'Mark Not Done (Restore to Inbox)', shortcut: 'Shift+E' },
  { id: 'remind', label: 'Remind me (this device)', shortcut: 'H' },
  { id: 'reminders', label: 'Go to local Reminders', shortcut: 'G then H (within 1 second)' },
  { id: 'undo', label: 'Undo last action', shortcut: 'Z' },
  { id: 'star', label: 'Star', shortcut: 'S' },
  { id: 'unstar', label: 'Unstar', shortcut: 'S' },
  { id: 'read', label: 'Mark read', shortcut: '' },
  { id: 'unread', label: 'Mark unread', shortcut: 'Shift+U' },
  { id: 'select-all-loaded', label: 'Select all loaded', shortcut: '' },
  { id: 'clear-selection', label: 'Clear selection', shortcut: 'Escape' },
  { id: 'search', label: 'Find older mail', shortcut: '/' },
  { id: 'inbox', label: 'Go to Inbox', shortcut: '' },
  { id: 'saved', label: 'Go to saved split', shortcut: '' },
  { id: 'create-split', label: 'Create Split', shortcut: '' },
  { id: 'edit-split', label: 'Edit Split', shortcut: '' },
  { id: 'toggle-unread-filter', label: 'Show Unread Only', shortcut: '' },
  { id: 'done', label: 'Go to cached Done', shortcut: 'G then E (within 1 second)' },
  { id: 'starred', label: 'Go to cached Starred', shortcut: '' },
  { id: 'trash', label: 'Go to cached Trash (read only)', shortcut: '' },
  { id: 'account', label: 'Go to Account', shortcut: '' },
  { id: 'activity', label: 'Go to Activity', shortcut: '' },
  { id: 'drafts', label: 'Go to local Drafts', shortcut: '' },
  { id: 'switch-account', label: 'Switch account', shortcut: '' },
] as const;
export type BrowsingActionId = typeof browsingActions[number]['id'];
export interface AvailableAction { id: BrowsingActionId; label: string; shortcut: string; disabledReason?: string }
export function actionLabel(id: BrowsingActionId): string {
  const action = browsingActions.find((item) => item.id === id)!;
  return `${action.label}${action.shortcut ? ` — ${action.shortcut}` : ''}`;
}
