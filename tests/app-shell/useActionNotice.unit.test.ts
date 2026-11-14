/**
 * `useActionNotice` in isolation: the mailbox slots are plain refs holding
 * synthetic shapes, and the clock is the shared fake UI clock. Covers the
 * single-slot view, the group view and the advisory Undo window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, type Ref } from 'vue';
import { useActionNotice } from '../../src/composables/useActionNotice';
import type { LastAction, Mailbox } from '../../src/composables/useMailbox';
import { useUiTestClock } from '../support/timers';

const target = { accountId: 'acct', conversationId: 'c1' };
const NOW = Date.parse('2026-01-15T12:00:00Z');

function single(over: Partial<LastAction> = {}): LastAction {
  return { receipt: { operationId: 'op-1' }, actionId: 'archive', target, subject: 'Synthetic subject', undoableUntil: '2026-01-15T12:00:10Z', hadWindow: true, undone: null, ...over };
}

function setup(initial: { lastAction?: LastAction | null; activity?: unknown[]; lastGroup?: unknown } = {}) {
  const lastAction = ref<LastAction | null>(initial.lastAction ?? null);
  const lastGroup = ref<unknown>(initial.lastGroup ?? null);
  const activity = ref<unknown[]>(initial.activity ?? []);
  const scope = effectScope();
  const notice = scope.run(() => useActionNotice({ mailbox: { lastAction, lastGroup, activity } as unknown as Pick<Mailbox, 'lastGroup' | 'lastAction' | 'activity'> }))!;
  return { notice, lastAction, lastGroup: lastGroup as Ref<unknown>, activity, stop: () => scope.stop() };
}

beforeEach(useUiTestClock);
afterEach(() => { vi.useRealTimers(); });

describe('useActionNotice', () => {
  it('has no notice and no Undo window while the mailbox has no slot', () => {
    const { notice, stop } = setup();
    expect(notice.actionNotice.value).toBeNull();
    expect(notice.undoWindowOpen.value).toBe(false);
    stop();
  });

  it('labels a single action from the registry and carries its own deadline when no row has one', () => {
    const { notice, stop } = setup({ lastAction: single() });
    expect(notice.actionNotice.value).toMatchObject({ label: 'Mark done', actionId: 'archive', subject: 'Synthetic subject', undoableUntil: '2026-01-15T12:00:10Z', hadWindow: true, undone: null, operation: null });
    stop();
  });

  it('takes the deadline from the refreshed activity row, never from the slot', () => {
    const row = { id: 'op-1', undoableUntil: '2026-01-15T12:00:30Z' };
    const { notice, stop } = setup({ lastAction: single(), activity: [row] });
    expect(notice.actionNotice.value?.operation).toEqual(row);
    expect(notice.actionNotice.value?.undoableUntil).toBe('2026-01-15T12:00:30Z');
    stop();
  });

  it('closes the window outright once the action is undone, whatever a stale row says', () => {
    const row = { id: 'op-1', undoableUntil: '2026-01-15T12:59:00Z' };
    const undone = { outcome: 'accepted', operationIds: ['op-9'] };
    const { notice, stop } = setup({ lastAction: single({ undone: undone as never }), activity: [row, { id: 'op-9' }, { id: 'op-8' }] });
    expect(notice.actionNotice.value?.undoableUntil).toBeNull();
    expect(notice.actionNotice.value?.undone).toEqual({ outcome: 'accepted', compensations: [{ id: 'op-9' }] });
    expect(notice.undoWindowOpen.value).toBe(false);
    stop();
  });

  it('follows the clock: open until the deadline, closed after, ticking every 250 ms once mounted', () => {
    const { notice, stop } = setup({ lastAction: single({ undoableUntil: '2026-01-15T12:00:01Z' }) });
    expect(notice.nowMs.value).toBe(NOW);
    expect(notice.undoWindowOpen.value).toBe(true);
    // Not mounted (no component instance), so the interval is not running: advancing time alone changes nothing.
    vi.advanceTimersByTime(5_000);
    expect(notice.nowMs.value).toBe(NOW);
    notice.nowMs.value = Date.now();
    expect(notice.undoWindowOpen.value).toBe(false);
    stop();
  });

  it('shows a group notice with its counts and group label, and no single-action detail', () => {
    const group = {
      kind: 'read', requestedRead: false, members: [target, { ...target, conversationId: 'c2' }, { ...target, conversationId: 'c3' }],
      state: 'accepted', statusError: false, hadWindow: true, undone: null,
      status: {
        members: [{ status: 'confirmed' }, { status: 'queued' }, { status: 'rejected' }],
        undo: { undoableUntil: '2026-01-15T12:00:20Z' }, undoReceipt: null,
      },
    };
    const { notice, stop } = setup({ lastGroup: group, lastAction: single() });
    const view = notice.actionNotice.value!;
    expect(view).toMatchObject({ label: 'Mark unread', actionId: 'unread', subject: null, operation: null, undoableUntil: null, undone: null });
    expect(view.group).toMatchObject({ count: 3, counts: { pending: 1, confirmed: 1, failed: 0, rejected: 1, unknown: 0, cancelled: 0 }, acceptanceUnknown: false, statusKnown: true, undoableUntil: '2026-01-15T12:00:20Z' });
    expect(notice.undoWindowOpen.value).toBe(true);
    stop();
  });

  it('reads group undo outcomes from the persisted record and counts skip reasons', () => {
    const group = {
      kind: 'archive', requestedArchived: true, members: [target], state: 'accepted', statusError: false, hadWindow: true,
      undone: null,
      status: {
        members: [{ status: 'confirmed' }], undo: { undoableUntil: null },
        undoReceipt: {
          members: [
            { decision: { kind: 'compensating' }, compensations: [{ status: 'confirmed' }, { status: 'failed' }, { status: 'queued' }] },
            { decision: { kind: 'skipped', reason: 'failed' }, compensations: [] },
            { decision: { kind: 'cancelled' }, compensations: [] },
          ],
        },
      },
    };
    const { notice, stop } = setup({ lastGroup: group });
    expect(notice.actionNotice.value?.group?.undone).toEqual({
      cancelled: 1, compensating: 1, skipped: 1, skipReasons: { failed: 1 },
      compensationOutcomes: { confirmed: 1, failed: 1, unknown: 0, pending: 1 },
    });
    expect(notice.undoWindowOpen.value).toBe(false);
    stop();
  });
});
