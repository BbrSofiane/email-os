/**
 * UX-05 selection state (useMailbox): account-scoped refs, additive ranges,
 * the 100-conversation bound, authoritative-refresh intersection and
 * context/account clearing. Synthetic only.
 */
import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import { useMailbox } from '../src/composables/useMailbox';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import { fixtureRef, flushMacrotasks } from './helpers';
import { SELECTION_MAX } from '../src/composables/useMailbox';
import type { ConversationRef } from '../src/lib/ipc/client';

function scopeRun<T>(fn: () => T): { result: T; stop: () => void } {
  const scope = effectScope();
  const result = scope.run(fn) as T;
  return { result, stop: () => scope.stop() };
}

function selectedIds(refs: ConversationRef[]): string[] {
  return refs.map((ref) => ref.conversationId);
}

describe('useMailbox selection state', () => {
  it('toggles rows, sets the anchor, and keeps focus-independent identity', async () => {
    const fake = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(fake));
    await result.ready;
    const a = fixtureRef('conv-01');
    result.toggleSelected(a);
    expect(result.isSelected(a)).toBe(true);
    expect(result.selectedRefs.value).toHaveLength(1);
    // Anchor moves to the toggled row.
    expect(result.rangeAnchorRef.value).toEqual(a);
    result.toggleSelected(a);
    expect(result.isSelected(a)).toBe(false);
    stop();
  });

  it('extends additively from the anchor; reversal never subtracts', async () => {
    const fake = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(fake));
    await result.ready;
    await flushMacrotasks(2);
    const c01 = fixtureRef('conv-01');
    const c02 = fixtureRef('conv-02');
    const c04 = fixtureRef('conv-04');
    result.toggleSelected(c02);
    // Extend downward 02→04.
    result.extendSelectionTo(c04, null);
    expect(selectedIds(result.selectedRefs.value).sort()).toEqual(['conv-02', 'conv-03', 'conv-04']);
    // Extend upward beyond the anchor: additive, nothing subtracted.
    result.extendSelectionTo(c01, null);
    expect(selectedIds(result.selectedRefs.value).sort()).toEqual(['conv-01', 'conv-02', 'conv-03', 'conv-04']);
    stop();
  });

  it('uses the fallback anchor when none is set and selects the target alone with no focus', async () => {
    const fake = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(fake));
    await result.ready;
    const c02 = fixtureRef('conv-02');
    const c03 = fixtureRef('conv-03');
    // No anchor, no fallback: target alone.
    result.extendSelectionTo(c03, null);
    expect(selectedIds(result.selectedRefs.value)).toEqual(['conv-03']);
    // Clear, then use the fallback anchor for the range.
    result.clearSelection();
    result.extendSelectionTo(c03, c02);
    expect(selectedIds(result.selectedRefs.value).sort()).toEqual(['conv-02', 'conv-03']);
    stop();
  });

  it('rejects additions beyond the bound without replacing the existing selection', async () => {
    const fake = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(fake));
    await result.ready;
    // Fill the selection to the bound (via the same state the controls use).
    const full = Array.from({ length: SELECTION_MAX }, () => fixtureRef('conv-01'));
    result.selectedRefs.value = full;
    result.toggleSelected(fixtureRef('conv-02'));
    expect(result.selectedRefs.value).toEqual(full);
    expect(result.selectionNotice.value).toContain('limited to 100');
    stop();
  });

  it('select all loaded refuses beyond the bound with visible wording and selects nothing', async () => {
    const fake = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(fake));
    await result.ready;
    // Simulate more loaded rows than the bound.
    result.conversations.value = Array.from({ length: SELECTION_MAX + 1 }, (_, i) => ({
      ...result.conversations.value[i % 18]!,
      ref: fixtureRef(`extra-${i}`),
    }));
    result.selectAllLoaded();
    expect(result.selectedRefs.value).toEqual([]);
    expect(result.selectionNotice.value).toContain('Select all loaded is limited to 100');
    stop();
  });

  it('intersects selection with surviving refs on refresh and clears an absent anchor', async () => {
    const fake = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(fake));
    await result.ready;
    const c01 = fixtureRef('conv-01');
    result.toggleSelected(c01);
    result.toggleSelected(fixtureRef('conv-02'));
    // Archive conv-01 out of the inbox, then refresh.
    await result.setArchived(c01, true);
    await flushMacrotasks(3);
    const survivors = result.selectedRefs.value.map((ref) => ref.conversationId);
    expect(survivors).not.toContain('conv-01');
    expect(survivors).toContain('conv-02');
    stop();
  });

  it('clears selection and anchor on context change and does not restore it on Back', async () => {
    const fake = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(fake));
    await result.ready;
    result.toggleSelected(fixtureRef('conv-01'));
    await result.setContext('done');
    expect(result.selectedRefs.value).toEqual([]);
    expect(result.rangeAnchorRef.value).toBeNull();
    await result.setContext('inbox');
    expect(result.selectedRefs.value).toEqual([]);
    stop();
  });

  it('keeps selection across a reader open/close round trip within the same context', async () => {
    const fake = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(fake));
    await result.ready;
    result.toggleSelected(fixtureRef('conv-01'));
    await result.openConversationByRef(fixtureRef('conv-02'));
    await flushMacrotasks(2);
    expect(result.openRef.value).not.toBeNull();
    expect(result.isSelected(fixtureRef('conv-01'))).toBe(true);
    result.closeReader();
    expect(result.isSelected(fixtureRef('conv-01'))).toBe(true);
    stop();
  });

  it('freezes the selected references in current loaded order for dispatch', async () => {
    const fake = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(fake));
    await result.ready;
    result.toggleSelected(fixtureRef('conv-03'));
    result.toggleSelected(fixtureRef('conv-01'));
    // Loaded order (newest message first), not selection insertion order.
    const frozen = result.selectionInLoadedOrder();
    expect(frozen[0]!.conversationId).toBe('conv-01');
    expect(frozen[1]!.conversationId).toBe('conv-03');
    stop();
  });
});
