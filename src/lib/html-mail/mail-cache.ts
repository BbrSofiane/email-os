/**
 * Sanitised messages kept in memory so moving between messages and reopening
 * a conversation does not sanitise again. Bounded, and cleared when an account
 * is disconnected or replaced, or its mailbox is closed.
 */
import type { MessageHtmlBody } from '../ipc/generated';
import type { SanitizedMail } from './sanitize';

export interface CachedMail {
  mail: SanitizedMail;
  body: MessageHtmlBody;
}

const MAX_ENTRIES = 20;
const entries = new Map<string, CachedMail>();
let epoch = 0;

/** Captured before a fetch; an entry from an older epoch is not stored. */
export function mailCacheEpoch(): number {
  return epoch;
}

/** Returns an entry and makes it the most recently used. */
export function cachedMail(key: string): CachedMail | undefined {
  const entry = entries.get(key);
  if (entry) {
    entries.delete(key);
    entries.set(key, entry);
  }
  return entry;
}

export function cacheMail(key: string, entry: CachedMail, fetchEpoch: number): void {
  if (fetchEpoch !== epoch) return;
  entries.set(key, entry);
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

/** Drops every entry and refuses results of reads already in flight. */
export function clearMailCache(): void {
  epoch += 1;
  entries.clear();
}
