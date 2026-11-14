/** Plain conversation-reference helpers shared by the mailbox composables. */
import type { ConversationRef } from '../lib/ipc/client';

export function sameConversation(a: ConversationRef | null, b: ConversationRef | null): boolean {
  return a !== null && b !== null && a.accountId === b.accountId && a.conversationId === b.conversationId;
}

export function copyRef(target: ConversationRef): ConversationRef {
  return { accountId: target.accountId, conversationId: target.conversationId };
}
