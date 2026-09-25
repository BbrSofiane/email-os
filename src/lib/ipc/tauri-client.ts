/**
 * Narrow Tauri 2 adapter (Slice 01).
 *
 * Only the three approved commands and one event are used. The shell (integration
 * lane) resolves success payloads and rejects with the typed MailError object;
 * rejections are normalized through `toMailError` so the UI can never mistake a
 * transport fault for success.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  GET_CONVERSATION_COMMAND,
  LIST_CONVERSATIONS_COMMAND,
  MAILBOX_CHANGED_EVENT,
  SET_ARCHIVED_COMMAND,
  type Conversation,
  type ConversationRef,
  type InboxSnapshot,
  type MailClient,
  type OperationReceipt,
  type SetArchived,
} from './client';
import { toMailError } from './client';

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((raw: unknown) => Promise.reject(toMailError(raw)));
}

export function createTauriMailClient(): MailClient {
  return {
    listConversations(): Promise<InboxSnapshot> {
      return call<InboxSnapshot>(LIST_CONVERSATIONS_COMMAND);
    },
    getConversation(ref: ConversationRef): Promise<Conversation> {
      return call<Conversation>(GET_CONVERSATION_COMMAND, { ref });
    },
    setArchived(command: SetArchived): Promise<OperationReceipt> {
      return call<OperationReceipt>(SET_ARCHIVED_COMMAND, { command });
    },
    async subscribe(listener: () => void): Promise<() => void> {
      const unlisten = await listen(MAILBOX_CHANGED_EVENT, () => listener());
      return unlisten;
    },
  };
}
