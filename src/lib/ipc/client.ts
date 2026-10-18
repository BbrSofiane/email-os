/**
 * Frontend transport seam (Slices 01–04).
 *
 * The UI depends only on this interface. Two implementations exist:
 * - `tauri-client.ts`: narrow Tauri adapter over the approved named commands and the
 *   `mailbox_changed` event. Success values pass through; rejections are the typed
 *   MailError object emitted by the shell. The transport never invents success.
 * - `browser-fake.ts`: clearly labelled in-memory fake for browser preview and tests.
 *   It models core-like pending/failure behavior for demonstration only and discloses
 *   that nothing is durable. Core read models remain authoritative in the native path.
 *
 * Account lifecycle, mailbox actions, local drafts, and close requests cross only this
 * typed client seam; results never stand in for OAuth, sync, or provider-send success.
 */
import type {
  AccountStatus,
  AppCloseRequest,
  Conversation,
  ConversationRef,
  CreateDraft,
  DeleteDraft,
  Draft,
  DraftDeleteReceipt,
  DraftReceipt,
  DraftRef,
  DraftSummary,
  InboxSnapshot,
  MailError,
  OperationReceipt,
  RetryOperation,
  SaveDraft,
  SetArchived,
  SetRead,
} from './generated';

export type {
  AccountInfo,
  AccountStatus,
  AppCloseRequest,
  MailboxOperationKind,
  MutationAccess,
  Address,
  ConnectionState,
  Conversation,
  ConversationRef,
  ConversationSummary,
  CreateDraft,
  DeleteDraft,
  Draft,
  DraftContent,
  DraftDeleteReceipt,
  DraftReceipt,
  DraftRef,
  DraftSource,
  DraftReplyLink,
  DraftSummary,
  InboxSnapshot,
  MailError,
  MailMode,
  Message,
  OperationFailure,
  OperationReceipt,
  OperationStatus,
  RetryOperation,
  OperationSummary,
  SetArchived,
  SetRead,
  SaveDraft,
  ReplyContext,
  SyncInfo,
  SyncState,
} from './generated';

export {
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
  LIST_DRAFTS_COMMAND,
  GET_DRAFT_COMMAND,
  CREATE_DRAFT_COMMAND,
  SAVE_DRAFT_COMMAND,
  DELETE_DRAFT_COMMAND,
  DRAFTS_CHANGED_EVENT,
  APP_CLOSE_REQUESTED_EVENT,
  GET_APP_CLOSE_REQUEST_COMMAND,
  COMPLETE_APP_CLOSE_COMMAND,
  CANCEL_APP_CLOSE_COMMAND,
} from './generated';

export interface MailClient {
  listConversations(): Promise<InboxSnapshot>;
  getConversation(ref: ConversationRef): Promise<Conversation>;
  setArchived(command: SetArchived): Promise<OperationReceipt>;
  enableMailboxActions(): Promise<void>;
  cancelMailboxActionUpgrade(): Promise<void>;
  setRead(command: SetRead): Promise<OperationReceipt>;
  retryOperation(command: RetryOperation): Promise<OperationReceipt>;
  /** Registers a change listener; resolves with an unsubscribe function. */
  subscribe(listener: () => void): Promise<() => void>;
  /** Authoritative fixture-vs-Gmail mode and connection/sync state. */
  getAccountStatus(): Promise<AccountStatus>;
  /** Enqueues a connect (OAuth) attempt; resolves on acceptance, not on success. */
  connectAccount(): Promise<void>;
  /** Resolves only after credentials and local account/cache data are cleared. */
  disconnectAccount(): Promise<void>;
  /** Enqueues an incremental sync; resolves on acceptance, not on completion. */
  requestSync(): Promise<void>;
  listDrafts(): Promise<DraftSummary[]>;
  getDraft(ref: DraftRef): Promise<Draft>;
  createDraft(command: CreateDraft): Promise<DraftReceipt>;
  saveDraft(command: SaveDraft): Promise<DraftReceipt>;
  deleteDraft(command: DeleteDraft): Promise<DraftDeleteReceipt>;
  subscribeDrafts(listener: () => void): Promise<() => void>;
  subscribeAppClose(listener: (request: AppCloseRequest) => void): Promise<() => void>;
  completeAppClose(requestId: string): Promise<void>;
  cancelAppClose(requestId: string): Promise<void>;
}

export function isMailErrorShape(value: unknown): value is MailError {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  const kind = (value as { kind: unknown }).kind;
  if (typeof kind !== 'string') return false;
  switch (kind) {
    case 'not_found':
    case 'request_id_conflict':
    case 'storage_unavailable':
    case 'profile_in_use':
    case 'read_only':
    case 'not_configured':
    case 'auth_required':
    case 'auth_cancelled':
    case 'auth_failed':
    case 'secrets_unavailable':
    case 'network_unavailable':
    case 'rate_limited':
    case 'provider_unavailable':
    case 'invalid_provider_response':
    case 'busy':
    case 'permission_required':
    case 'provider_rejected':
    case 'outcome_unknown':
    case 'reply_unavailable':
      return true;
    case 'draft_conflict':
      return typeof (value as unknown as { currentRevision: unknown }).currentRevision === 'number';
    case 'invalid_request':
      return typeof (value as unknown as { field: unknown }).field === 'string';
    default:
      return false;
  }
}

/**
 * Normalizes a rejected command result into the MailError union. The native shell
 * rejects with the typed MailError object; anything else (native bug, serialization
 * gap) is conservatively surfaced as `storage_unavailable` rather than being
 * converted into a success or dropped.
 */
export function toMailError(raw: unknown): MailError {
  if (isMailErrorShape(raw)) return raw;
  return { kind: 'storage_unavailable' };
}
