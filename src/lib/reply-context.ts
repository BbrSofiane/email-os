import type { Conversation } from './ipc/client';

/**
 * Why a reply cannot be prepared from, or a reply draft cannot be docked in, a
 * conversation. `text` is the full sentence (Prepare reply tooltip, the compose
 * card's title); `label` is the terse phrase the compose card shows as visible
 * text. One table, so the sentence and the phrase cannot drift apart.
 */
export const REPLY_REASONS = {
  noLatestMessage: { text: 'No displayed latest message is available as a reply source.', label: 'no latest message' },
  retainedSnapshot: { text: 'Reply preparation is blocked for a retained snapshot; current message headers cannot be verified.', label: 'retained snapshot' },
  incomplete: { text: 'Reply preparation is blocked because this cached conversation is incomplete.', label: 'incomplete cached conversation' },
  headerMismatch: { text: 'Reply preparation is blocked because cached reply headers do not match the displayed latest message.', label: 'reply headers do not match the latest message' },
  otherAccount: { text: 'The source conversation belongs to another account.', label: 'belongs to another account' },
  notOpen: { text: 'The source conversation is not open.', label: 'not open' },
  stillLoading: { text: 'The source conversation is still loading.', label: 'still loading' },
} as const;

const LOAD_ERROR_PREFIX = 'The source conversation could not be loaded';

/** The reason when the source conversation failed to load; `detail` is the error word ("not found"). */
export function sourceLoadErrorReason(detail?: string | null): string {
  return detail ? `${LOAD_ERROR_PREFIX}: ${detail}.` : `${LOAD_ERROR_PREFIX}.`;
}

/**
 * The terse visible phrase for a reason sentence ("retained snapshot"). A
 * sentence that is not in the table is shown as written, never replaced by a
 * vague word.
 */
export function replyReasonLabel(reason: string): string {
  for (const entry of Object.values(REPLY_REASONS)) if (entry.text === reason) return entry.label;
  if (reason.startsWith(LOAD_ERROR_PREFIX)) {
    const detail = reason.slice(LOAD_ERROR_PREFIX.length).replace(/^:\s*/, '').replace(/\.$/, '');
    return detail ? `could not be loaded: ${detail}` : 'could not be loaded';
  }
  return reason.replace(/\.$/, '');
}

/**
 * The one rule for whether a reply can be prepared from, or a reply draft can
 * be docked in, a loaded conversation. `null` means it can. ReaderView uses it
 * for the Prepare reply controls and the R key; App uses it to decide whether
 * a reply draft opened from the Drafts list docks in the reader.
 */
export function replyBlockedReason(conversation: Conversation | null | undefined): string | null {
  const latest = conversation?.messages.at(-1);
  if (!conversation || !latest) return REPLY_REASONS.noLatestMessage.text;
  if (conversation.retainedSnapshotAt) return REPLY_REASONS.retainedSnapshot.text;
  if (conversation.contextComplete === false) return REPLY_REASONS.incomplete.text;
  if (conversation.replyContext && conversation.replyContext.sourceMessageId !== latest.id) return REPLY_REASONS.headerMismatch.text;
  return null;
}
