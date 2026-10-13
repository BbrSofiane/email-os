/**
 * Narrow Tauri 2 adapter (Slices 01 + 02).
 *
 * Only the approved named commands and the `mailbox_changed` event are used. The
 * shell (integration lane) resolves success payloads and rejects with the typed
 * MailError object; rejections are normalized through `toMailError` so the UI can
 * never mistake a transport fault for success.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  CANCEL_MAILBOX_ACTION_UPGRADE_COMMAND,
  CONNECT_ACCOUNT_COMMAND,
  DISCONNECT_ACCOUNT_COMMAND,
  GET_ACCOUNT_STATUS_COMMAND,
  GET_CONVERSATION_COMMAND,
  LIST_CONVERSATIONS_COMMAND,
  MAILBOX_CHANGED_EVENT,
  REQUEST_SYNC_COMMAND,
  SET_ARCHIVED_COMMAND,
  ENABLE_MAILBOX_ACTIONS_COMMAND,
  SET_READ_COMMAND,
  RETRY_OPERATION_COMMAND,
  type AccountStatus,
  type Conversation,
  type ConversationRef,
  type InboxSnapshot,
  type MailClient,
  type OperationReceipt,
  type RetryOperation,
  type SetArchived,
  type SetRead,
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
    enableMailboxActions(): Promise<void> {
      return call<void>(ENABLE_MAILBOX_ACTIONS_COMMAND);
    },
    cancelMailboxActionUpgrade(): Promise<void> {
      return call<void>(CANCEL_MAILBOX_ACTION_UPGRADE_COMMAND);
    },
    setRead(command: SetRead): Promise<OperationReceipt> {
      return call<OperationReceipt>(SET_READ_COMMAND, { command });
    },
    retryOperation(command: RetryOperation): Promise<OperationReceipt> {
      return call<OperationReceipt>(RETRY_OPERATION_COMMAND, { command });
    },
    async subscribe(listener: () => void): Promise<() => void> {
      const unlisten = await listen(MAILBOX_CHANGED_EVENT, () => listener());
      return unlisten;
    },
    getAccountStatus(): Promise<AccountStatus> {
      return call<AccountStatus>(GET_ACCOUNT_STATUS_COMMAND);
    },
    connectAccount(): Promise<void> {
      return call<void>(CONNECT_ACCOUNT_COMMAND);
    },
    disconnectAccount(): Promise<void> {
      return call<void>(DISCONNECT_ACCOUNT_COMMAND);
    },
    requestSync(): Promise<void> {
      return call<void>(REQUEST_SYNC_COMMAND);
    },
  };
}
