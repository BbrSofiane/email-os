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
  LIST_DRAFTS_COMMAND,
  SAVE_DRAFT_COMMAND,
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
