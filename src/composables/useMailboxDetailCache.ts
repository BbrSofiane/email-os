/**
 * Neighbor-detail cache, single-slot prefetch and the J/K reader loading delay.
 *
 * Invalidation is explicit. `invalidateDetailCache()` bumps an epoch that
 * fences every in-flight prefetch and drops every entry; the owner calls it on
 * every list/status refresh, on mutation start, when the reader closes (which
 * every account change and disconnect does), and on dispose. A prefetch result
 * is published only while its captured epoch is current and the owner's
 * `session` is not detached. The loaded reader state, the account/search view
 * and the session arrive as arguments; nothing is closed over from the parent
 * and there is no module-level mutable state.
 */
import { ref, type Ref } from 'vue';
import type { Conversation, ConversationRef, MailClient } from '../lib/ipc/client';
import { sameConversation } from './mailbox-refs';
import type { MailboxSession } from './mailbox-session';
import type { DetailState } from './useMailbox';

/**
 * J/K moves keep showing the previous conversation (never actionable) for this
 * long before the loading presentation replaces it, so a fast response never
 * produces an intermediate empty frame.
 */
export const READER_LOADING_DELAY_MS = 120;
/** Neighbor-detail cache bounds (read-only prefetch; see `prefetchConversation`). */
export const DETAIL_CACHE_MAX = 3;
export const DETAIL_CACHE_TTL_MS = 30_000;

export interface MailboxDetailCacheDeps {
  client: MailClient;
  session: Pick<MailboxSession, 'detached'>;
  /** True while the list context is Search (search reads are explicit). */
  searchContext: () => boolean;
  /** The reader state the prefetch gate reads; written only by the owner. */
  detailState: Ref<DetailState>;
  openRef: Ref<ConversationRef | null>;
  readerSource: () => 'list' | 'activity';
}

export function useMailboxDetailCache({ client, session, searchContext, detailState, openRef, readerSource }: MailboxDetailCacheDeps) {
  // Neighbor-detail cache and single-slot prefetch. `detailEpoch` is bumped by
  // every invalidation so older in-flight reads can never publish.
  interface CachedDetail { conversation: Conversation; fetchedAt: number }
  const detailCache = new Map<string, CachedDetail>();
  let detailEpoch = 0;
  let prefetchInFlight: { key: string; epoch: number; promise: Promise<Conversation> } | null = null;
  let prefetchWanted: ConversationRef | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  const heldConversation = ref<Conversation | null>(null);

  function detailKey(target: ConversationRef): string {
    return `${target.accountId}:${target.conversationId}`;
  }

  /** Drops every cached detail and fences in-flight prefetch results. */
  function invalidateDetailCache(): void {
    detailEpoch += 1;
    detailCache.clear();
    prefetchWanted = null;
  }

  function cachePut(conv: Conversation, epoch: number): void {
    if (epoch !== detailEpoch) return;
    const key = detailKey(conv.ref);
    detailCache.delete(key);
    detailCache.set(key, { conversation: conv, fetchedAt: Date.now() });
    while (detailCache.size > DETAIL_CACHE_MAX) detailCache.delete(detailCache.keys().next().value as string);
  }

  function cacheGet(target: ConversationRef): Conversation | null {
    const entry = detailCache.get(detailKey(target));
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > DETAIL_CACHE_TTL_MS) {
      detailCache.delete(detailKey(target));
      return null;
    }
    return entry.conversation;
  }

  function clearHold(): void {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
    heldConversation.value = null;
  }

  /** Keep `shown` on screen for the loading delay; an active hold keeps its original deadline. */
  function beginHold(shown: Conversation | null): void {
    if (!shown) { clearHold(); return; }
    heldConversation.value = shown;
    if (holdTimer !== null) return;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      heldConversation.value = null;
    }, READER_LOADING_DELAY_MS);
  }

  /** Starts the single wanted prefetch when none is in flight. Never writes, never surfaces errors. */
  function pumpPrefetch(): void {
    if (session.detached || prefetchInFlight || !prefetchWanted) return;
    const target = prefetchWanted;
    prefetchWanted = null;
    if (detailState.value !== 'ready' || readerSource() !== 'list' || sameConversation(openRef.value, target)
      || cacheGet(target) || target.accountId !== openRef.value?.accountId) return;
    const epoch = detailEpoch;
    const key = detailKey(target);
    const promise = client.getConversation(target, searchContext());
    const flight = { key, epoch, promise };
    prefetchInFlight = flight;
    const settle = (): void => {
      if (prefetchInFlight === flight) prefetchInFlight = null;
      pumpPrefetch();
    };
    promise.then((conv) => {
      if (!session.detached && epoch === detailEpoch) cachePut(conv, epoch);
      settle();
    }, () => { settle(); /* failure is silent: no cache entry */ });
  }

  function prefetchConversation(target: ConversationRef): void {
    if (session.detached || detailState.value !== 'ready' || readerSource() !== 'list') return;
    if (sameConversation(openRef.value, target) || cacheGet(target)) return;
    if (prefetchInFlight?.key === detailKey(target) && prefetchInFlight.epoch === detailEpoch) return;
    prefetchWanted = { accountId: target.accountId, conversationId: target.conversationId };
    pumpPrefetch();
  }

  /** The current invalidation epoch; an owner read captures it before awaiting. */
  function currentDetailEpoch(): number {
    return detailEpoch;
  }

  /** The in-flight prefetch for `target` when still current, so a J/K move can adopt it. */
  function adoptablePrefetch(target: ConversationRef): Promise<Conversation> | null {
    return prefetchInFlight?.key === detailKey(target) && prefetchInFlight.epoch === detailEpoch ? prefetchInFlight.promise : null;
  }

  return {
    heldConversation, currentDetailEpoch, adoptablePrefetch,
    invalidateDetailCache, cachePut, cacheGet, clearHold, beginHold, prefetchConversation,
  };
}
