/**
 * Cached Trash as a browse context (useMailbox): the same paged, replayable,
 * fenced list read as Cached Done. Synthetic only; read-only by construction.
 */
import { describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useMailbox } from '../src/composables/useMailbox';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import type { CachedTrashSnapshot, ConversationSummary } from '../src/lib/ipc/client';
import { deferred, flushMacrotasks, useGmailMode } from './helpers';

function scopeRun<T>(fn: () => T): { result: T; stop: () => void } {
  const scope = effectScope();
  const result = scope.run(fn) as T;
  return { result, stop: () => scope.stop() };
}
const ids = (rows: { ref: { conversationId: string } }[]) => rows.map((row) => row.ref.conversationId);
function snapshot(over: Partial<CachedTrashSnapshot> = {}): CachedTrashSnapshot {
  return { conversations: [], nextCursor: null, coverage: 'local_cache', exactTotal: null, lastSyncedAt: null, ...over };
}

async function setup() {
  const fake = createBrowserFakeMailClient();
  useGmailMode(fake, { mutationAccess: 'enabled' });
  for (const id of ['conv-04', 'conv-05', 'conv-06']) fake.controls.markTriage(id, 'trash');
  const { result: box, stop } = scopeRun(() => useMailbox(fake));
  await box.ready;
  await flushMacrotasks(2);
  const rows = (await fake.listCachedTrash({ accountId: 'gmail-account', limit: 100, cursor: null })).conversations;
  return { fake, box, stop, rows };
}

describe('useMailbox Cached Trash context', () => {
  it('loads the trash membership through listCachedTrash with the shared 100-row page', async () => {
    const { fake, box, stop, rows } = await setup();
    const read = vi.spyOn(fake, 'listCachedTrash');
    await box.setContext('trash');
    expect(box.context.value).toBe('trash');
    expect(box.listState.value).toBe('ready');
    expect(read).toHaveBeenCalledWith({ accountId: 'gmail-account', limit: 100, cursor: null });
    expect(ids(box.conversations.value)).toEqual(ids(rows));
    expect(ids(box.conversations.value).sort()).toEqual(['conv-04', 'conv-05', 'conv-06']);
    // The focused row is the first row, and the total stays unknown.
    expect(box.focusedRef.value).toEqual(rows[0]!.ref);
    expect(box.exactTotal.value).toBeNull();
    expect(box.nextCursor.value).toBeNull();
    // Done and Inbox are separate reads: leaving Trash drops its rows.
    await box.setContext('inbox');
    expect(ids(box.conversations.value)).not.toContain('conv-04');
    stop();
  });

  it('pages with loadMore: appends without duplicates, advances the cursor and the page count', async () => {
    const { fake, box, stop, rows } = await setup();
    const [a, b, c] = rows as [ConversationSummary, ConversationSummary, ConversationSummary];
    const read = vi.spyOn(fake, 'listCachedTrash')
      .mockResolvedValueOnce(snapshot({ conversations: [a, b], nextCursor: 'page-2', lastSyncedAt: '2026-01-02T03:04:00Z' }))
      .mockResolvedValueOnce(snapshot({ conversations: [b, c], nextCursor: null, lastSyncedAt: '2026-01-02T03:05:00Z' }));
    await box.setContext('trash');
    expect(ids(box.conversations.value)).toEqual([a, b].map((row) => row.ref.conversationId));
    expect(box.nextCursor.value).toBe('page-2');
    expect(box.lastSyncedAt.value).toBe('2026-01-02T03:04:00Z');
    expect(box.loadedDonePages.value).toBe(1);
    await box.loadMore();
    expect(read).toHaveBeenLastCalledWith({ accountId: 'gmail-account', limit: 100, cursor: 'page-2' });
    expect(ids(box.conversations.value)).toEqual([a, b, c].map((row) => row.ref.conversationId));
    expect(box.nextCursor.value).toBeNull();
    expect(box.loadedDonePages.value).toBe(2);
    expect(box.lastSyncedAt.value).toBe('2026-01-02T03:05:00Z');
    expect(box.listState.value).toBe('ready');
    // No cursor left: loadMore is a no-op.
    await box.loadMore();
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it('replays the loaded page range when the list refreshes, keeping the loaded rows', async () => {
    const { fake, box, stop, rows } = await setup();
    const [a, b, c] = rows as [ConversationSummary, ConversationSummary, ConversationSummary];
    const pages: Record<string, CachedTrashSnapshot> = {
      first: snapshot({ conversations: [a], nextCursor: 'p2' }),
      p2: snapshot({ conversations: [b], nextCursor: 'p3' }),
      p3: snapshot({ conversations: [c], nextCursor: null }),
    };
    const read = vi.spyOn(fake, 'listCachedTrash').mockImplementation(async ({ cursor }) => pages[cursor ?? 'first']!);
    await box.setContext('trash');
    await box.loadMore();
    expect(ids(box.conversations.value)).toHaveLength(2);
    read.mockClear();
    await box.refresh();
    expect(read.mock.calls.map(([request]) => request.cursor)).toEqual([null, 'p2']);
    expect(ids(box.conversations.value)).toEqual([a, b].map((row) => row.ref.conversationId));
    expect(box.nextCursor.value).toBe('p3');
    stop();
  });

  it('fails visibly on a first-page error and recovers on retry; a load-more error keeps the loaded rows reachable', async () => {
    const { fake, box, stop, rows } = await setup();
    const read = vi.spyOn(fake, 'listCachedTrash').mockRejectedValueOnce({ kind: 'storage_unavailable' });
    await box.setContext('trash');
    expect(box.listState.value).toBe('error');
    expect(box.listError.value).toEqual({ kind: 'storage_unavailable' });
    expect(box.conversations.value).toEqual([]);
    await box.refresh();
    expect(box.listState.value).toBe('ready');
    expect(box.listError.value).toBeNull();
    expect(ids(box.conversations.value)).toEqual(ids(rows));
    read.mockReset();
    read.mockResolvedValueOnce(snapshot({ conversations: [rows[0]!], nextCursor: 'p2' }))
      .mockRejectedValueOnce({ kind: 'network_unavailable' });
    await box.refresh();
    await box.loadMore();
    expect(box.listState.value).toBe('error');
    expect(box.listError.value).toEqual({ kind: 'network_unavailable' });
    expect(box.loadingMore.value).toBe(false);
    stop();
  });

  it('drops a delayed first page when the user leaves the context before it arrives', async () => {
    const { fake, box, stop, rows } = await setup();
    const late = deferred<CachedTrashSnapshot>();
    vi.spyOn(fake, 'listCachedTrash').mockReturnValue(late.promise);
    const pending = box.setContext('trash');
    await flushMacrotasks(1);
    expect(box.listState.value).toBe('loading');
    await box.setContext('done');
    late.resolve(snapshot({ conversations: [rows[0]!], nextCursor: 'stale' }));
    await pending;
    await flushMacrotasks(2);
    expect(box.context.value).toBe('done');
    expect(ids(box.conversations.value)).not.toContain(rows[0]!.ref.conversationId);
    expect(box.nextCursor.value).not.toBe('stale');
    stop();
  });

  it('drops a delayed load-more page after leaving the context', async () => {
    const { fake, box, stop, rows } = await setup();
    const late = deferred<CachedTrashSnapshot>();
    vi.spyOn(fake, 'listCachedTrash')
      .mockResolvedValueOnce(snapshot({ conversations: [rows[0]!], nextCursor: 'p2' }))
      .mockReturnValueOnce(late.promise);
    await box.setContext('trash');
    const more = box.loadMore();
    await flushMacrotasks(1);
    expect(box.loadingMore.value).toBe(true);
    await box.setContext('inbox');
    late.resolve(snapshot({ conversations: [rows[1]!], nextCursor: 'stale' }));
    await more;
    expect(box.context.value).toBe('inbox');
    expect(ids(box.conversations.value)).not.toContain(rows[1]!.ref.conversationId);
    expect(box.nextCursor.value).toBeNull();
    stop();
  });

  it('drops a delayed page after account departure and returns to a clean Inbox', async () => {
    const { fake, box, stop, rows } = await setup();
    const late = deferred<CachedTrashSnapshot>();
    vi.spyOn(fake, 'listCachedTrash').mockReturnValue(late.promise);
    const pending = box.setContext('trash');
    await flushMacrotasks(1);
    const oldStatus = await fake.getAccountStatus();
    vi.spyOn(fake, 'getAccountStatus').mockResolvedValue({ ...oldStatus, account: { ...oldStatus.account!, accountId: 'another-account' } });
    vi.spyOn(fake, 'listConversations').mockResolvedValue({ conversations: [], activity: [] });
    // The status refresh (and the Trash read it queued) is held by the late page.
    const refreshing = box.refresh();
    await flushMacrotasks(3);
    expect(box.accountStatus.value?.account?.accountId).toBe('another-account');
    expect(box.context.value).toBe('inbox');
    late.resolve(snapshot({ conversations: [rows[0]!], nextCursor: 'stale' }));
    await Promise.all([pending, refreshing]);
    await flushMacrotasks(2);
    expect(box.conversations.value).toEqual([]);
    expect(box.nextCursor.value).toBeNull();
    expect(box.lastSyncedAt.value).toBeNull();
    stop();
  });

  it('clears the selection on entering Trash and cannot be selected into a bulk set by navigation', async () => {
    const { box, stop } = await setup();
    await flushMacrotasks(2);
    const first = box.conversations.value[0]!.ref;
    box.toggleSelected(first);
    expect(box.selectedRefs.value).toHaveLength(1);
    await box.setContext('trash');
    expect(box.selectedRefs.value).toEqual([]);
    stop();
  });
});
