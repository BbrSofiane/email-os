import type { ConversationSummary, MailError } from './ipc/client';
/** Account-owned local browsing state; never stores a mutation target by index. */
export interface CachedTrashState {
  rows: ConversationSummary[];
  cursor: string | null;
  loaded: boolean;
  error: MailError | null;
  focusedId: string | null;
  scrollTop: number;
}
export function emptyCachedTrash(): CachedTrashState {
  return { rows: [], cursor: null, loaded: false, error: null, focusedId: null, scrollTop: 0 };
}
