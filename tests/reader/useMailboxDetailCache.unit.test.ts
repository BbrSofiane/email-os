/**
 * `useMailboxDetailCache` in isolation: the reader state, the search flag and
 * the session are plain arguments. Covers the bound, the TTL, epoch invalidation
 * fencing an in-flight prefetch, detach, the single-slot request budget and the
 * held-conversation deadline with fake timers. Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import {
  DETAIL_CACHE_MAX, DETAIL_CACHE_TTL_MS, READER_LOADING_DELAY_MS, useMailboxDetailCache,
} from '../../src/composables/useMailboxDetailCache';
import type { DetailState } from '../../src/composables/useMailbox';
import { createBrowserFakeMailClient } from '../../src/lib/ipc/browser-fake';
import type { Conversation, ConversationRef, MailClient } from '../../src/lib/ipc/client';
import { deferred, fixtureRef } from '../helpers';

const fake = createBrowserFakeMailClient();
const conversationOf = (id: string): Promise<Conversation> => fake.getConversation(fixtureRef(id));

function setup(source: 'list' | 'activity' = 'list') {
  const reads: Array<{ id: string; search: boolean; gate: ReturnType<typeof deferred<Conversation>> }> = [];
  const client = {
    getConversation: (target: ConversationRef, search?: boolean) => {
      const entry = { id: target.conversationId, search: !!search, gate: deferred<Conversation>() };
      reads.push(entry);
      return entry.gate.promise;
    },
  } as unknown as MailClient;
  const session = { detached: false };
  const detailState = ref<DetailState>('ready');
  const openRef = ref<ConversationRef | null>(fixtureRef('conv-01'));
  const searching = { value: false };
  const scope = effectScope();
  const cache = scope.run(() => useMailboxDetailCache({
    client, session, searchContext: () => searching.value, detailState, openRef, readerSource: () => source,
  }))!;
  return { cache, reads, session, detailState, openRef, searching, stop: () => scope.stop() };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('useMailboxDetailCache', () => {
  it('keeps at most DETAIL_CACHE_MAX entries, evicting the oldest', async () => {
    const h = setup();
    const ids = ['conv-02', 'conv-03', 'conv-04', 'conv-05'];
    for (const id of ids) h.cache.cachePut(await conversationOf(id), h.cache.currentDetailEpoch());
    expect(DETAIL_CACHE_MAX).toBe(3);
    expect(h.cache.cacheGet(fixtureRef('conv-02'))).toBeNull();
    for (const id of ids.slice(1)) expect(h.cache.cacheGet(fixtureRef(id))?.ref.conversationId).toBe(id);
    h.stop();
  });

  it('does not serve an entry older than the TTL', async () => {
    const h = setup();
    h.cache.cachePut(await conversationOf('conv-02'), h.cache.currentDetailEpoch());
    vi.advanceTimersByTime(DETAIL_CACHE_TTL_MS - 1);
    expect(h.cache.cacheGet(fixtureRef('conv-02'))).not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(h.cache.cacheGet(fixtureRef('conv-02'))).toBeNull();
    h.stop();
  });

  it('refuses a put captured under an earlier epoch and drops entries on invalidation', async () => {
    const h = setup();
    const epoch = h.cache.currentDetailEpoch();
    h.cache.cachePut(await conversationOf('conv-02'), epoch);
    h.cache.invalidateDetailCache();
    expect(h.cache.cacheGet(fixtureRef('conv-02'))).toBeNull();
    h.cache.cachePut(await conversationOf('conv-03'), epoch); // stale response after invalidation
    expect(h.cache.cacheGet(fixtureRef('conv-03'))).toBeNull();
    h.stop();
  });

  it('drops a prefetch result that lands after invalidation, and after detach', async () => {
    const h = setup();
    h.cache.prefetchConversation(fixtureRef('conv-02'));
    expect(h.cache.adoptablePrefetch(fixtureRef('conv-02'))).not.toBeNull();
    h.cache.invalidateDetailCache();
    expect(h.cache.adoptablePrefetch(fixtureRef('conv-02'))).toBeNull(); // old flight is no longer adoptable
    h.reads[0]!.gate.resolve(await conversationOf('conv-02'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.cache.cacheGet(fixtureRef('conv-02'))).toBeNull();

    h.cache.prefetchConversation(fixtureRef('conv-03'));
    h.session.detached = true;
    h.reads[1]!.gate.resolve(await conversationOf('conv-03'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.cache.cacheGet(fixtureRef('conv-03'))).toBeNull();
    h.stop();
  });

  it('runs one prefetch at a time, keeps only the latest wanted target, and passes the search flag', async () => {
    const h = setup();
    h.searching.value = true;
    h.cache.prefetchConversation(fixtureRef('conv-02'));
    h.cache.prefetchConversation(fixtureRef('conv-03'));
    h.cache.prefetchConversation(fixtureRef('conv-04'));
    expect(h.reads.map((read) => read.id)).toEqual(['conv-02']);
    expect(h.reads[0]!.search).toBe(true);
    h.reads[0]!.gate.resolve(await conversationOf('conv-02'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reads.map((read) => read.id)).toEqual(['conv-02', 'conv-04']);
    h.stop();
  });

  it('never prefetches while the reader is not ready, for an Activity-origin reader, or for the open conversation', () => {
    const notReady = setup();
    notReady.detailState.value = 'loading';
    notReady.cache.prefetchConversation(fixtureRef('conv-02'));
    expect(notReady.reads).toHaveLength(0);
    notReady.stop();

    const activity = setup('activity');
    activity.cache.prefetchConversation(fixtureRef('conv-02'));
    expect(activity.reads).toHaveLength(0);
    activity.stop();

    const open = setup();
    open.cache.prefetchConversation(fixtureRef('conv-01'));
    expect(open.reads).toHaveLength(0);
    open.stop();
  });

  it('holds the previous conversation until the original deadline, and clears it early on demand', async () => {
    const h = setup();
    const shown = await conversationOf('conv-02');
    h.cache.beginHold(shown);
    expect(h.cache.heldConversation.value).toEqual(shown);
    vi.advanceTimersByTime(READER_LOADING_DELAY_MS - 20);
    h.cache.beginHold(await conversationOf('conv-03')); // repeated press keeps the first deadline
    vi.advanceTimersByTime(21);
    expect(h.cache.heldConversation.value).toBeNull();
    h.cache.beginHold(shown);
    h.cache.clearHold();
    expect(h.cache.heldConversation.value).toBeNull();
    h.stop();
  });
});
