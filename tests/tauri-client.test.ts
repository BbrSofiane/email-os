import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_CLOSE_REQUESTED_EVENT,
  CANCEL_APP_CLOSE_COMMAND,
  COMPLETE_APP_CLOSE_COMMAND,
  CREATE_DRAFT_COMMAND,
  DELETE_DRAFT_COMMAND,
  DRAFTS_CHANGED_EVENT,
  GET_APP_CLOSE_REQUEST_COMMAND,
  GET_DRAFT_COMMAND,
  LIST_CONVERSATIONS_COMMAND,
  LIST_CACHED_DONE_COMMAND,
  LIST_DRAFTS_COMMAND,
  LIST_OPERATION_GROUPS_COMMAND,
  GET_OPERATION_GROUP_COMMAND,
  SAVE_DRAFT_COMMAND,
  SET_ARCHIVED_GROUP_COMMAND,
  SET_READ_GROUP_COMMAND,
  UNDO_OPERATION_COMMAND,
  UNDO_OPERATION_GROUP_COMMAND,
  isMailErrorShape,
} from '../src/lib/ipc/client';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  order: [] as string[],
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));

import { createTauriMailClient } from '../src/lib/ipc/tauri-client';

describe('Tauri draft and close protocol adapter', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.unlisten.mockReset();
    mocks.order.length = 0;
    mocks.handlers.clear();
    mocks.listen.mockImplementation(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
      mocks.order.push(`listen:${eventName}`);
      mocks.handlers.set(eventName, handler);
      return mocks.unlisten;
    });
  });

  it('transports cached Done using only the named read query and exact request envelope', async () => {
    const client = createTauriMailClient();
    const request = { accountId: 'account', limit: 25, cursor: 'opaque-cursor' };
    const snapshot = {
      conversations: [{ ref: { accountId: 'account', conversationId: 'archived' },
        subject: 'Archived', participants: [], preview: 'local recovery', lastMessageAt: '', pendingOperationId: 'pending' }],
      nextCursor: 'next', coverage: 'local_cache', exactTotal: null, lastSyncedAt: null,
    };
    mocks.invoke.mockResolvedValue(snapshot);
    const result = await client.listCachedDone(request);
    expect(result).toBe(snapshot);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(LIST_CACHED_DONE_COMMAND, { request });
    expect(mocks.listen).not.toHaveBeenCalled();
  });

  it('does not turn cached Done validation/storage failures into an empty result', async () => {
    const client = createTauriMailClient();
    const request = { accountId: 'account', limit: 0, cursor: null };
    mocks.invoke.mockRejectedValue({ kind: 'invalid_request', field: 'limit' });
    await expect(client.listCachedDone(request)).rejects.toEqual({ kind: 'invalid_request', field: 'limit' });
    mocks.invoke.mockRejectedValue(new Error('native bridge fault'));
    await expect(client.listCachedDone(request)).rejects.toEqual({ kind: 'storage_unavailable' });
  });

  it('transports listConversations summaries unchanged, including primaryCorrespondent', async () => {
    const client = createTauriMailClient();
    const snapshot = {
      conversations: [{
        ref: { accountId: 'fixture-account', conversationId: 'conv-01' },
        subject: 's',
        participants: [{ displayName: null, mailbox: 'anon@example.test' }],
        primaryCorrespondent: { displayName: null, mailbox: 'anon@example.test' },
        preview: 'p',
        lastMessageAt: '2026-01-12T08:19:00Z',
        pendingOperationId: null,
      }],
      activity: [],
    };
    mocks.invoke.mockResolvedValue(snapshot);
    await expect(client.listConversations()).resolves.toEqual(snapshot);
    expect(mocks.invoke).toHaveBeenLastCalledWith(LIST_CONVERSATIONS_COMMAND, undefined);
  });

  it('maps the five draft commands to exact generated command names and argument objects', async () => {
    const client = createTauriMailClient();
    const ref = { accountId: 'fixture-account', draftId: 'draft-1' };
    const source = { kind: 'new_message' as const };
    const content = { to: ' raw ', cc: '', subject: 'x', bodyText: '✓' };
    mocks.invoke.mockResolvedValue([]);
    await client.listDrafts();
    expect(mocks.invoke).toHaveBeenLastCalledWith(LIST_DRAFTS_COMMAND, undefined);
    mocks.invoke.mockResolvedValue({ ref, revision: 1, createdAt: '', updatedAt: '', content, source, replyLink: null });
    await client.getDraft(ref);
    expect(mocks.invoke).toHaveBeenLastCalledWith(GET_DRAFT_COMMAND, { ref });
    const create = { requestId: 'create-1', source, initialContent: content };
    mocks.invoke.mockResolvedValue({ ref, revision: 1, savedAt: '' });
    await client.createDraft(create);
    expect(mocks.invoke).toHaveBeenLastCalledWith(CREATE_DRAFT_COMMAND, { command: create });
    const save = { ref, expectedRevision: 1, requestId: 'save-1', content };
    await client.saveDraft(save);
    expect(mocks.invoke).toHaveBeenLastCalledWith(SAVE_DRAFT_COMMAND, { command: save });
    const deletion = { ref, expectedRevision: 1, requestId: 'delete-1' };
    await client.deleteDraft(deletion);
    expect(mocks.invoke).toHaveBeenLastCalledWith(DELETE_DRAFT_COMMAND, { command: deletion });
  });

  it('transports undoOperation on the named command and preserves the typed receipt', async () => {
    const client = createTauriMailClient();
    const command = { operationId: 'op-1', requestId: 'undo-req-1' };
    const receipt = {
      undoneOperationId: 'op-1',
      outcome: 'compensating',
      operationIds: ['op-2', 'op-3'],
      acceptedAt: '2026-01-01T00:00:00Z',
    };
    mocks.invoke.mockResolvedValue(receipt);
    const result = await client.undoOperation(command);
    expect(result).toBe(receipt);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(UNDO_OPERATION_COMMAND, { command });
    mocks.invoke.mockRejectedValue({ kind: 'undo_unavailable', reason: 'expired' });
    await expect(client.undoOperation(command)).rejects.toEqual({
      kind: 'undo_unavailable',
      reason: 'expired',
    });
  });

  it('maps the five UX-05 group commands to exact generated names and argument envelopes', async () => {
    const client = createTauriMailClient();
    const refs = [
      { accountId: 'fixture-account', conversationId: 'conv-01' },
      { accountId: 'fixture-account', conversationId: 'conv-03' },
    ];
    const groupCommand = { accountId: 'fixture-account', members: refs, archived: true, requestId: 'group-req-1' };
    const groupReceipt = {
      groupId: 'group-1',
      requestId: 'group-req-1',
      accountId: 'fixture-account',
      kind: 'archive',
      requestedArchived: true,
      acceptedAt: '2026-01-01T00:00:00Z',
      members: [
        { ordinal: 0, conversation: refs[0], operationId: 'op-1', rejection: null },
        { ordinal: 1, conversation: refs[1], operationId: null, rejection: 'conversation_missing' },
      ],
    };
    mocks.invoke.mockResolvedValue(groupReceipt);
    const accepted = await client.setArchivedGroup(groupCommand);
    expect(accepted).toBe(groupReceipt);
    expect(mocks.invoke).toHaveBeenLastCalledWith(SET_ARCHIVED_GROUP_COMMAND, { command: groupCommand });

    const readCommand = { accountId: 'fixture-account', members: refs, read: true, requestId: 'group-req-2' };
    mocks.invoke.mockResolvedValue({ ...groupReceipt, kind: 'read', requestedArchived: undefined, requestedRead: true });
    await client.setReadGroup(readCommand);
    expect(mocks.invoke).toHaveBeenLastCalledWith(SET_READ_GROUP_COMMAND, { command: readCommand });

    const listRequest = { accountId: 'fixture-account', limit: 25, cursor: null };
    const page = { groups: [], nextCursor: 'next' };
    mocks.invoke.mockResolvedValue(page);
    await expect(client.listOperationGroups(listRequest)).resolves.toBe(page);
    expect(mocks.invoke).toHaveBeenLastCalledWith(LIST_OPERATION_GROUPS_COMMAND, { request: listRequest });
  });

  it('resolves a lost group acceptance as null without inventing a fresh request', async () => {
    const client = createTauriMailClient();
    const lookup = { accountId: 'fixture-account', requestId: 'lost-req-1' };
    mocks.invoke.mockResolvedValue(null);
    await expect(client.getOperationGroup(lookup)).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(GET_OPERATION_GROUP_COMMAND, { request: lookup });
    // Transport faults and validation errors stay typed rejections, never nulls.
    mocks.invoke.mockRejectedValue(new Error('native bridge fault'));
    await expect(client.getOperationGroup(lookup)).rejects.toEqual({ kind: 'storage_unavailable' });
    mocks.invoke.mockRejectedValue({ kind: 'invalid_request', field: 'accountId' });
    await expect(client.getOperationGroup(lookup)).rejects.toEqual({ kind: 'invalid_request', field: 'accountId' });
  });

  it('transports undoOperationGroup with durable per-member decisions and typed unavailability', async () => {
    const client = createTauriMailClient();
    const command = { groupId: 'group-1', requestId: 'undo-group-req-1' };
    const receipt = {
      groupId: 'group-1',
      requestId: 'undo-group-req-1',
      acceptedAt: '2026-01-01T00:00:00Z',
      members: [
        {
          ordinal: 0,
          conversation: { accountId: 'fixture-account', conversationId: 'conv-01' },
          decision: { kind: 'cancelled' },
          operationIds: [],
        },
        {
          ordinal: 1,
          conversation: { accountId: 'fixture-account', conversationId: 'conv-02' },
          decision: { kind: 'compensating' },
          operationIds: ['op-9'],
        },
        {
          ordinal: 2,
          conversation: { accountId: 'fixture-account', conversationId: 'conv-03' },
          decision: { kind: 'skipped', reason: 'outcome_unknown' },
          operationIds: [],
        },
      ],
    };
    mocks.invoke.mockResolvedValue(receipt);
    const result = await client.undoOperationGroup(command);
    expect(result).toBe(receipt);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(UNDO_OPERATION_GROUP_COMMAND, { command });
    mocks.invoke.mockRejectedValue({ kind: 'undo_unavailable', reason: 'superseded' });
    await expect(client.undoOperationGroup(command)).rejects.toEqual({
      kind: 'undo_unavailable',
      reason: 'superseded',
    });
  });

  it('accepts undo_unavailable errors only with a valid eligibility reason', () => {
    for (const reason of [
      'expired',
      'superseded',
      'already_undone',
      'not_applicable',
      'uncertain',
      'unknown_prior',
    ]) {
      expect(isMailErrorShape({ kind: 'undo_unavailable', reason })).toBe(true);
    }
    expect(isMailErrorShape({ kind: 'undo_unavailable', reason: 'someday' })).toBe(false);
    expect(isMailErrorShape({ kind: 'undo_unavailable' })).toBe(false);
    expect(isMailErrorShape({ kind: 'not_found' })).toBe(true);
    expect(isMailErrorShape({ kind: 'something_else' })).toBe(false);
  });

  it('subscribes to change hints and listens before querying and deduplicates pending close requests', async () => {
    const client = createTauriMailClient();
    const draftListener = vi.fn();
    const unsubscribeDrafts = await client.subscribeDrafts(draftListener);
    expect(mocks.order).toEqual([`listen:${DRAFTS_CHANGED_EVENT}`]);
    mocks.handlers.get(DRAFTS_CHANGED_EVENT)?.({ payload: {} });
    expect(draftListener).toHaveBeenCalledOnce();
    unsubscribeDrafts();

    const request = { requestId: 'close-1' };
    const received: string[] = [];
    mocks.invoke.mockImplementation(async (command: string) => {
      mocks.order.push(`invoke:${command}`);
      if (command === GET_APP_CLOSE_REQUEST_COMMAND) return request;
      return undefined;
    });
    const unsubscribeClose = await client.subscribeAppClose((value) => received.push(value.requestId));
    expect(mocks.order.slice(-2)).toEqual([`listen:${APP_CLOSE_REQUESTED_EVENT}`, `invoke:${GET_APP_CLOSE_REQUEST_COMMAND}`]);
    expect(received).toEqual(['close-1']);
    mocks.handlers.get(APP_CLOSE_REQUESTED_EVENT)?.({ payload: request });
    expect(received).toEqual(['close-1']);
    mocks.invoke.mockResolvedValue(undefined);
    await client.completeAppClose('close-1');
    expect(mocks.invoke).toHaveBeenLastCalledWith(COMPLETE_APP_CLOSE_COMMAND, { requestId: 'close-1' });
    await client.cancelAppClose('close-2');
    expect(mocks.invoke).toHaveBeenLastCalledWith(CANCEL_APP_CLOSE_COMMAND, { requestId: 'close-2' });
    unsubscribeClose();
  });
});
