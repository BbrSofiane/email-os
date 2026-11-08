/**
 * Session-scoped subject index for conversation refs.
 *
 * Operation DTOs carry only a `ConversationRef`, never a subject. Activity
 * needs a human label, so the UI remembers the subject of every conversation it
 * has already seen (list rows, Cached Trash rows, the open conversation) and
 * looks it up by ref. Nothing here is persisted or fetched: a ref that was
 * never seen resolves to `null`, which the caller shows as "Unknown
 * conversation". A raw id is never returned as a subject.
 *
 * The map is shallow-reactive so a panel that reads `subjectFor` re-renders
 * when a row is remembered later.
 */
import { shallowReactive } from 'vue';
import type { ConversationRef } from './ipc/client';

export interface SubjectIndex {
  /** Remember one subject. A later sighting replaces an earlier one. */
  remember: (ref: ConversationRef, subject: string) => void;
  /** Remember many rows (anything with a ref and a subject). */
  rememberRows: (rows: ReadonlyArray<{ ref: ConversationRef; subject: string }>) => void;
  /** The remembered subject (may be the empty string), or null when never seen. */
  subjectFor: (ref: ConversationRef) => string | null;
  readonly size: number;
}

function keyOf(ref: ConversationRef): string {
  return `${ref.accountId}:${ref.conversationId}`;
}

export function createSubjectIndex(): SubjectIndex {
  const subjects = shallowReactive(new Map<string, string>());
  function remember(ref: ConversationRef, subject: string): void {
    const key = keyOf(ref);
    if (subjects.get(key) !== subject) subjects.set(key, subject);
  }
  return {
    remember,
    rememberRows(rows) {
      for (const row of rows) remember(row.ref, row.subject);
    },
    subjectFor(ref) {
      return subjects.get(keyOf(ref)) ?? null;
    },
    get size() { return subjects.size; },
  };
}
