/** Frontend discovery only; execution still uses the named typed MailClient methods. */
export const browsingActions = [
  { id: 'open', label: 'Open conversation', shortcut: 'Enter' },
  { id: 'back', label: 'Back', shortcut: 'Escape' },
  { id: 'archive', label: 'Mark Done (Archive)', shortcut: 'E' },
  { id: 'unarchive', label: 'Mark Not Done (Restore to Inbox)', shortcut: 'Shift+E' },
  { id: 'read', label: 'Mark read', shortcut: '' },
  { id: 'unread', label: 'Mark unread', shortcut: 'Shift+U' },
  { id: 'inbox', label: 'Go to Inbox', shortcut: '' },
  { id: 'done', label: 'Go to cached Done', shortcut: 'G then E (within 1 second)' },
  { id: 'account', label: 'Go to Account', shortcut: '' },
  { id: 'activity', label: 'Go to Activity', shortcut: '' },
  { id: 'drafts', label: 'Go to local Drafts', shortcut: '' },
] as const;
export type BrowsingActionId = typeof browsingActions[number]['id'];
export interface AvailableAction { id: BrowsingActionId; label: string; shortcut: string }
export function actionLabel(id: BrowsingActionId): string {
  const action = browsingActions.find((item) => item.id === id)!;
  return `${action.label}${action.shortcut ? ` — ${action.shortcut}` : ''}`;
}
