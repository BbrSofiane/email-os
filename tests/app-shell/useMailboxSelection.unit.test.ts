/**
 * `useMailboxSelection` in isolation (no client, no mailbox): the loaded rows and
 * the saved-view membership fence are plain arguments, so pruning, the fence and
 * the bound are exercised directly. Synthetic refs only.
 */
import { describe, expect, it } from 'vitest';
import { effectScope, ref } from 'vue';
import { SELECTION_MAX, useMailboxSelection } from '../../src/composables/useMailboxSelection';
import type { ConversationRef } from '../../src/lib/ipc/client';

const row = (id: string): { ref: ConversationRef } => ({ ref: { accountId: 'acct', conversationId: id } });
const idsOf = (refs: ConversationRef[]): string[] => refs.map((entry) => entry.conversationId);

function setup(ids: string[], available: (target: ConversationRef) => boolean = () => true) {
  const rows = ref(ids.map(row));
  const scope = effectScope();
  const selection = scope.run(() => useMailboxSelection({ rows: () => rows.value, targetAvailable: available }))!;
  return { rows, selection, stop: () => scope.stop() };
}

describe('useMailboxSelection', () => {
  it('ignores a toggle for a target the saved-view fence refuses', () => {
    const { selection, stop } = setup(['a', 'b'], (target) => target.conversationId !== 'b');
    selection.toggleSelected(row('b').ref);
    expect(selection.selectedRefs.value).toEqual([]);
    expect(selection.rangeAnchorRef.value).toBeNull();
    selection.toggleSelected(row('a').ref);
    expect(idsOf(selection.selectedRefs.value)).toEqual(['a']);
    stop();
  });

  it('prunes refs and the anchor that left the loaded rows, keeping survivors in order', () => {
    const { rows, selection, stop } = setup(['a', 'b', 'c']);
    selection.toggleSelected(row('c').ref);
    selection.toggleSelected(row('a').ref); // anchor now at 'a'
    rows.value = [row('b'), row('c')];
    selection.intersectSelectionWithLoaded();
    expect(idsOf(selection.selectedRefs.value)).toEqual(['c']);
    expect(selection.rangeAnchorRef.value).toBeNull();
    stop();
  });

  it('keeps removed-but-selected refs in the frozen dispatch list after the loaded ones', () => {
    const { rows, selection, stop } = setup(['a', 'b', 'c']);
    selection.toggleSelected(row('c').ref);
    selection.toggleSelected(row('a').ref);
    rows.value = [row('b'), row('c')]; // 'a' is gone from the list but still selected
    expect(idsOf(selection.selectionInLoadedOrder())).toEqual(['c', 'a']);
    stop();
  });

  it('refuses additions beyond SELECTION_MAX without replacing the selection, and clears the wording', () => {
    const ids = Array.from({ length: SELECTION_MAX + 1 }, (_, index) => `c${index}`);
    const { selection, stop } = setup(ids);
    for (const id of ids.slice(0, SELECTION_MAX)) selection.toggleSelected(row(id).ref);
    selection.toggleSelected(row(ids[SELECTION_MAX]!).ref);
    expect(selection.selectedRefs.value).toHaveLength(SELECTION_MAX);
    expect(selection.isSelected(row(ids[SELECTION_MAX]!).ref)).toBe(false);
    expect(selection.selectionNotice.value).toContain(String(SELECTION_MAX));
    selection.clearSelection();
    expect(selection.selectedRefs.value).toEqual([]);
    expect(selection.selectionNotice.value).toBeNull();
    stop();
  });
});
