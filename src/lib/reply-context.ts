import type { Conversation } from './ipc/client';

/**
 * The one rule for whether a reply can be prepared from, or a reply draft can
 * be docked in, a loaded conversation. `null` means it can. ReaderView uses it
 * for the Prepare reply controls and the R key; App uses it to decide whether
 * a reply draft opened from the Drafts list docks in the reader.
 */
export function replyBlockedReason(conversation: Conversation | null | undefined): string | null {
  const latest = conversation?.messages.at(-1);
  if (!conversation || !latest) return 'No displayed latest message is available as a reply source.';
  if (conversation.retainedSnapshotAt) return 'Reply preparation is blocked for a retained snapshot; current message headers cannot be verified.';
  if (conversation.contextComplete === false) return 'Reply preparation is blocked because this cached conversation is incomplete.';
  if (conversation.replyContext && conversation.replyContext.sourceMessageId !== latest.id) return 'Reply preparation is blocked because cached reply headers do not match the displayed latest message.';
  return null;
}
