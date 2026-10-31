/**
 * Narrow Tauri 2 adapter (Slices 01–04).
 *
 * Only approved named commands and mailbox/draft/close events are used. The
 * shell (integration lane) resolves success payloads and rejects with the typed
 * MailError object; rejections are normalized through `toMailError` so the UI can
 * never mistake a transport fault for success.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  CANCEL_MAILBOX_ACTION_UPGRADE_COMMAND,
  CANCEL_APP_CLOSE_COMMAND,
  CONNECT_ACCOUNT_COMMAND,
  COMPLETE_APP_CLOSE_COMMAND,
  CREATE_DRAFT_COMMAND,
  DELETE_DRAFT_COMMAND,
  DRAFTS_CHANGED_EVENT,
  APP_CLOSE_REQUESTED_EVENT,
  DISCONNECT_ACCOUNT_COMMAND,
  GET_ACCOUNT_STATUS_COMMAND,
  GET_APP_CLOSE_REQUEST_COMMAND,
  GET_DRAFT_COMMAND,
  GET_CONVERSATION_COMMAND,
  LIST_CONVERSATIONS_COMMAND,
  LIST_CACHED_DONE_COMMAND,
  type CachedDoneRequest,
  type CachedDoneSnapshot,
  LIST_DRAFTS_COMMAND,
  MAILBOX_CHANGED_EVENT,
  REQUEST_SYNC_COMMAND,
  SET_ARCHIVED_COMMAND,
  ENABLE_MAILBOX_ACTIONS_COMMAND,
  SET_READ_COMMAND,
  SAVE_DRAFT_COMMAND,
  RETRY_OPERATION_COMMAND,
  UNDO_OPERATION_COMMAND,
  type AccountStatus,
  type AppCloseRequest,
  type CreateDraft,
  type DeleteDraft,
  type Draft,
  type DraftDeleteReceipt,
  type DraftReceipt,
  type DraftRef,
  type DraftSummary,
  type Conversation,
  type ConversationRef,
  type InboxSnapshot,
  type MailClient,
  type OperationReceipt,
  type RetryOperation,
  type UndoOperation,
  type UndoReceipt,
  type SaveDraft,
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
    listCachedDone(request: CachedDoneRequest): Promise<CachedDoneSnapshot> {
      return call<CachedDoneSnapshot>(LIST_CACHED_DONE_COMMAND, { request });
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
    undoOperation(command: UndoOperation): Promise<UndoReceipt> {
      return call<UndoReceipt>(UNDO_OPERATION_COMMAND, { command });
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
    listDrafts(): Promise<DraftSummary[]> {
      return call<DraftSummary[]>(LIST_DRAFTS_COMMAND);
    },
    getDraft(ref: DraftRef): Promise<Draft> {
      return call<Draft>(GET_DRAFT_COMMAND, { ref });
    },
    createDraft(command: CreateDraft): Promise<DraftReceipt> {
      return call<DraftReceipt>(CREATE_DRAFT_COMMAND, { command });
    },
    saveDraft(command: SaveDraft): Promise<DraftReceipt> {
      return call<DraftReceipt>(SAVE_DRAFT_COMMAND, { command });
    },
    deleteDraft(command: DeleteDraft): Promise<DraftDeleteReceipt> {
      return call<DraftDeleteReceipt>(DELETE_DRAFT_COMMAND, { command });
    },
    async subscribeDrafts(listener: () => void): Promise<() => void> {
      return listen(DRAFTS_CHANGED_EVENT, () => listener());
    },
    async subscribeAppClose(listener: (request: AppCloseRequest) => void): Promise<() => void> {
      const seen = new Set<string>();
      const deliver = (request: AppCloseRequest | null): void => {
        if (!request || !request.requestId || seen.has(request.requestId)) return;
        seen.add(request.requestId);
        listener(request);
      };
      const unlisten = await listen<AppCloseRequest>(APP_CLOSE_REQUESTED_EVENT, (event) => deliver(event.payload));
      try {
        const pending = await call<AppCloseRequest | null>(GET_APP_CLOSE_REQUEST_COMMAND);
        deliver(pending);
      } catch (error) {
        unlisten();
        throw error;
      }
      return unlisten;
    },
    completeAppClose(requestId: string): Promise<void> {
      return call<void>(COMPLETE_APP_CLOSE_COMMAND, { requestId });
    },
    cancelAppClose(requestId: string): Promise<void> {
      return call<void>(CANCEL_APP_CLOSE_COMMAND, { requestId });
    },
  };
}
