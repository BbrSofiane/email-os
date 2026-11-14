/**
 * UX-05 selection state for the mailbox: account-scoped refs, additive ranges,
 * a hard bound, and pruning when rows leave the loaded list.
 *
 * Selection has no asynchronous work, so it carries no response fence of its
 * own. Invalidation is explicit: the owner clears it (`clearSelection`) on every
 * context, account, disconnect and reader-invalidating change, and prunes it
 * (`intersectSelectionWithLoaded`) after each successful authoritative list read.
 * Nothing here closes over the owner; the loaded rows and the saved-view
 * membership fence arrive as arguments.
 */
import { ref } from 'vue';
import type { ConversationRef } from '../lib/ipc/client';
import { OPERATION_GROUP_MAX_MEMBERS } from '../lib/ipc/client';
import { copyRef, sameConversation } from './mailbox-refs';

/**
 * UX-05 product/safety bound for selection and groups (docs/ux-05-safe-bulk-
 * processing.md §3.1). The UI rejects additions beyond this bound; the stores
 * re-validate and never truncate.
 */
export const SELECTION_MAX = OPERATION_GROUP_MAX_MEMBERS;

export interface MailboxSelectionDeps {
  /** The currently loaded rows, in display order. */
  rows: () => readonly { ref: ConversationRef }[];
  /** Saved-view membership fence: whether a row ref may be acted on right now. */
  targetAvailable: (target: ConversationRef) => boolean;
}

export function useMailboxSelection({ rows: loadedRows, targetAvailable }: MailboxSelectionDeps) {
  const selectedRefs = ref<ConversationRef[]>([]);
  const rangeAnchorRef = ref<ConversationRef | null>(null);
  const selectionNotice = ref<string | null>(null);

  function indexOfSelected(target: ConversationRef): number {
    return selectedRefs.value.findIndex((entry) => sameConversation(entry, target));
  }

  function isSelected(target: ConversationRef): boolean {
    return indexOfSelected(target) >= 0;
  }

  function loadedContains(target: ConversationRef): boolean {
    return loadedRows().some((row) => sameConversation(row.ref, target));
  }

  function rejectSelectionBound(): void {
    selectionNotice.value = `Selection is limited to ${SELECTION_MAX} conversations. Clear selection to choose different conversations; nothing was replaced.`;
  }

  /** X / checkbox / Cmd-click: toggle one row; the anchor moves there. */
  function toggleSelected(target: ConversationRef): void {
    if (!targetAvailable(target)) return;
    const existing = indexOfSelected(target);
    if (existing >= 0) {
      selectedRefs.value = selectedRefs.value.filter((entry) => !sameConversation(entry, target));
      selectionNotice.value = null;
    } else {
      if (selectedRefs.value.length >= SELECTION_MAX) {
        rejectSelectionBound();
        return;
      }
      selectedRefs.value = [...selectedRefs.value, copyRef(target)];
      selectionNotice.value = null;
    }
    rangeAnchorRef.value = copyRef(target);
  }

  /**
   * Additive inclusive anchor→target range over the CURRENT loaded order.
   * Reversing direction never subtracts already selected rows. The anchor is
   * retained (never moved here) so repeated Shift+J/K keep growing one range;
   * when no valid anchor exists the fallback (pre-move focus) is used, else the
   * target alone. Additions beyond the bound are rejected without replacing the
   * existing selection.
   */
  function extendSelectionTo(target: ConversationRef, fallbackAnchor: ConversationRef | null): void {
    const rows = loadedRows();
    const targetIndex = rows.findIndex((row) => sameConversation(row.ref, target));
    if (targetIndex < 0) return;
    const explicitAnchor = rangeAnchorRef.value && loadedContains(rangeAnchorRef.value)
      ? rangeAnchorRef.value
      : null;
    const fallback = fallbackAnchor && !explicitAnchor && loadedContains(fallbackAnchor) ? fallbackAnchor : null;
    const anchor = explicitAnchor ?? fallback;
    if (!anchor) {
      if (isSelected(target)) {
        // Target-only range still establishes the initial anchor (§3.1).
        rangeAnchorRef.value = copyRef(target);
        return;
      }
      if (selectedRefs.value.length + 1 > SELECTION_MAX) {
        rejectSelectionBound();
        return;
      }
      selectedRefs.value = [...selectedRefs.value, copyRef(target)];
      selectionNotice.value = null;
      // First accepted range establishes the persistent anchor at the target;
      // later ranges extend from here even after independent focus moves.
      rangeAnchorRef.value = copyRef(target);
      return;
    }
    const anchorIndex = rows.findIndex((row) => sameConversation(row.ref, anchor));
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const addition = rows.slice(start, end + 1)
      .map((row) => row.ref)
      .filter((ref) => !isSelected(ref));
    if (addition.length === 0) {
      // The first accepted range still anchors even when nothing was added.
      if (!explicitAnchor) rangeAnchorRef.value = copyRef(anchor);
      return;
    }
    if (selectedRefs.value.length + addition.length > SELECTION_MAX) {
      rejectSelectionBound();
      return;
    }
    selectedRefs.value = [...selectedRefs.value, ...addition.map(copyRef)];
    selectionNotice.value = null;
    // A fallback anchor used for the first range becomes THE anchor; the
    // explicit anchor is retained untouched (never moved by range extension).
    if (!explicitAnchor) rangeAnchorRef.value = copyRef(anchor);
  }

  /** Select all loaded rows; beyond the bound this refuses with visible wording. */
  function selectAllLoaded(): void {
    const rows = loadedRows();
    if (rows.length > SELECTION_MAX) {
      selectionNotice.value = `${rows.length} rows are loaded — Select all loaded is limited to ${SELECTION_MAX}. Load fewer rows or narrow the list first.`;
      return;
    }
    selectedRefs.value = rows.map((row) => copyRef(row.ref));
    const last = rows[rows.length - 1];
    rangeAnchorRef.value = last ? copyRef(last.ref) : null;
    selectionNotice.value = null;
  }

  /** Clear set, anchor and bound wording; navigation state is untouched. */
  function clearSelection(): void {
    selectedRefs.value = [];
    rangeAnchorRef.value = null;
    selectionNotice.value = null;
  }

  /**
    * A successful authoritative list refresh intersects selection with surviving
    * loaded refs and clears an absent anchor. Failures never reach this (they
    * are not an authoritative empty result).
    */
  function intersectSelectionWithLoaded(): void {
    if (selectedRefs.value.length === 0 && !rangeAnchorRef.value) return;
    selectedRefs.value = selectedRefs.value.filter((entry) => loadedContains(entry));
    if (rangeAnchorRef.value && !loadedContains(rangeAnchorRef.value)) rangeAnchorRef.value = null;
  }

  /** Exact selected references frozen in current loaded order, for dispatch. */
  function selectionInLoadedOrder(): ConversationRef[] {
    const loaded = loadedRows()
      .map((row) => row.ref)
      .filter((ref) => isSelected(ref))
      .map(copyRef);
    // Selected refs already removed from the loaded list (pending overlay) stay
    // in the frozen member list; they must not vanish from the group result.
    const loadedKeys = new Set(loaded.map((ref) => `${ref.accountId}:${ref.conversationId}`));
    const remaining = selectedRefs.value.filter((ref) => !loadedKeys.has(`${ref.accountId}:${ref.conversationId}`));
    return [...loaded, ...remaining.map(copyRef)];
  }

  return {
    selectedRefs, rangeAnchorRef, selectionNotice,
    isSelected, toggleSelected, extendSelectionTo, selectAllLoaded, clearSelection,
    intersectSelectionWithLoaded, selectionInLoadedOrder,
  };
}
