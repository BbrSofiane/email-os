/** UX-04 ActionNotice: status wording, undo window, and truncation. */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ActionNotice from '../../src/components/ActionNotice.vue';
import type { LastActionId } from '../../src/composables/useMailbox';
import type { OperationStatus, OperationSummary } from '../../src/lib/ipc/client';

function operation(status: OperationStatus): OperationSummary {
  return {
    id: 'op-0001',
    conversation: { accountId: 'synthetic-account', conversationId: 'synthetic-thread' },
    requestedArchived: true,
    status,
    failure: status === 'failed' ? { kind: 'provider_rejected' } : null,
  };
}

const NOW = Date.now();
const base = {
  label: 'Mark done',
  actionId: 'archive' as LastActionId,
  subject: 'Fixture thread 1: weekly status',
  undoableUntil: new Date(NOW + 5_000).toISOString(),
  hadWindow: true,
  undone: null,
};

describe('ActionNotice', () => {
  it('renders an empty polite live region with no slot', () => {
    const wrapper = mount(ActionNotice, { props: { notice: null, now: NOW } });
    expect(wrapper.find('[data-test="action-notice"]').attributes('role')).toBe('status');
    expect(wrapper.find('[data-test="action-notice"]').attributes('aria-live')).toBe('polite');
    expect(wrapper.text()).toBe('');
    // The empty region stays rendered (never display:none) so announcements are not dropped.
    expect(wrapper.get('[data-test="action-notice"]').classes()).toContain('action-notice-empty');
  });

  it.each(['queued', 'applying'] as const)('shows acceptance wording for %s with the undo control', (status) => {
    const wrapper = mount(ActionNotice, { props: { notice: { ...base, operation: operation(status) }, now: NOW } });
    expect(wrapper.get('[data-test="action-notice-status"]').text()).toBe('Accepted locally, not yet confirmed');
    expect(wrapper.find('[data-test="action-notice-undo"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="action-notice-hint"]').text()).toBe('Z');
  });

  it('shows confirmed wording while undoable', () => {
    const wrapper = mount(ActionNotice, { props: { notice: { ...base, operation: operation('confirmed') }, now: NOW } });
    expect(wrapper.get('[data-test="action-notice-status"]').text()).toBe('Confirmed');
    expect(wrapper.find('[data-test="action-notice-undo"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="action-notice-expired"]').exists()).toBe(false);
  });

  it.each([
    ['failed', 'Failed — restored, see Activity'],
    ['outcome_unknown', 'Outcome unknown — see Activity'],
    ['cancelled', 'Cancelled'],
  ] as const)('shows %s wording without an undo control', (status, expected) => {
    // Non-undoable outcomes never carry a window in the slot.
    const wrapper = mount(ActionNotice, { props: { notice: { ...base, undoableUntil: null, operation: operation(status) }, now: NOW } });
    expect(wrapper.get('[data-test="action-notice-status"]').text()).toBe(expected);
    expect(wrapper.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="action-notice-expired"]').exists()).toBe(false);
  });

  it('hides the undo control and shows the archive recovery wording after the window passes', () => {
    const wrapper = mount(ActionNotice, {
      props: {
        notice: { ...base, operation: operation('confirmed'), undoableUntil: new Date(NOW - 1).toISOString() },
        now: NOW,
      },
    });
    expect(wrapper.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="action-notice-expired"]').text())
      .toBe('Undo expired — Mark not done restores the whole conversation to Inbox');
  });

  it('derives the expired recovery clause from the action (unarchive, read)', () => {
    const unarchive = mount(ActionNotice, {
      props: {
        notice: { ...base, actionId: 'unarchive', operation: operation('confirmed'), undoableUntil: new Date(NOW - 1).toISOString() },
        now: NOW,
      },
    });
    expect(unarchive.get('[data-test="action-notice-expired"]').text())
      .toBe('Undo expired — Mark done archives the whole conversation');
    unarchive.unmount();
    const read = mount(ActionNotice, {
      props: {
        notice: { ...base, actionId: 'read', operation: operation('confirmed'), undoableUntil: new Date(NOW - 1).toISOString() },
        now: NOW,
      },
    });
    expect(read.get('[data-test="action-notice-expired"]').text())
      .toBe('Undo expired — use the opposite read control');
    read.unmount();
  });

  it('never shows the expired wording for an action that never had a window', () => {
    // unknown_prior / activity-read-failure slots carry undoableUntil null and
    // hadWindow false from the start: no undo control and no expiry claim.
    const wrapper = mount(ActionNotice, {
      props: {
        notice: { ...base, undoableUntil: null, hadWindow: false, operation: operation('confirmed') },
        now: NOW,
      },
    });
    expect(wrapper.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="action-notice-expired"]').exists()).toBe(false);
  });

  it.each([
    ['cancelled', [], 'Cancelled'],
    ['compensating', ['confirmed'], 'Restored'],
    ['compensating', ['failed'], 'Restore failed — see Activity'],
    ['compensating', ['outcome_unknown'], 'Restore outcome unknown — see Activity'],
    ['compensating', ['queued'], 'Restoring…'],
    ['compensating', ['confirmed', 'failed'], 'Restore failed — see Activity'],
    ['compensating', [], 'Restoring…'],
  ] as const)('reports the undo outcome (%s, compensations %s) as %s', (outcome, statuses, expected) => {
    const wrapper = mount(ActionNotice, {
      props: {
        notice: {
          ...base,
          undoableUntil: null,
          operation: operation('cancelled'),
          undone: { outcome, compensations: statuses.map((status) => ({ ...operation(status), id: `comp-${status}` })) },
        },
        now: NOW,
      },
    });
    expect(wrapper.get('[data-test="action-notice-status"]').text()).toBe(expected);
    expect(wrapper.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="action-notice-expired"]').exists()).toBe(false);
  });

  it('truncates long subjects and shows the action label', () => {
    const wrapper = mount(ActionNotice, {
      props: {
        notice: { ...base, subject: 'x'.repeat(80), operation: operation('confirmed') },
        now: NOW,
      },
    });
    const label = wrapper.get('[data-test="action-notice-label"]').text();
    expect(label.startsWith('Mark done · ')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThan('Mark done · '.length + 62);
  });

  it('shows acceptance wording before the activity row lands, without an undo control', () => {
    const wrapper = mount(ActionNotice, { props: { notice: { ...base, operation: null, undoableUntil: null }, now: NOW } });
    expect(wrapper.get('[data-test="action-notice-status"]').text()).toBe('Accepted locally, not yet confirmed');
    expect(wrapper.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="action-notice-expired"]').exists()).toBe(false);
  });

  it('omits an unknown subject instead of rendering a placeholder', () => {
    const wrapper = mount(ActionNotice, { props: { notice: { ...base, subject: null, operation: operation('confirmed') }, now: NOW } });
    const label = wrapper.get('[data-test="action-notice-label"]').text();
    expect(label).toBe('Mark done');
    expect(label).not.toContain('·');
  });
});

describe('ActionNotice group undo wording (review fixes)', () => {
  // --- UX-05 group notices: partial undo wording tracks CURRENT compensation
  // outcomes instead of a permanent "restoring…" (review U9). ---
  const groupBase = {
    label: 'Mark done',
    actionId: 'archive' as LastActionId,
    subject: null,
    operation: null,
    undoableUntil: null,
    hadWindow: true,
    undone: null,
    group: {
      count: 2,
      counts: { pending: 0, confirmed: 2, failed: 0, rejected: 0, unknown: 0, cancelled: 0 },
      acceptanceUnknown: false,
      statusKnown: true,
      statusError: false,
      undoableUntil: null,
      hadWindow: true,
      undone: {
        cancelled: 0,
        compensating: 1,
        skipped: 1,
        skipReasons: { unknown_prior: 1 },
        compensationOutcomes: { confirmed: 0, failed: 0, unknown: 0, pending: 0 },
      },
    },
  };

  it('shows restoring wording while a compensation is still pending', () => {
    const wrapper = mount(ActionNotice, {
      props: { notice: { ...groupBase, group: { ...groupBase.group!, undone: { ...groupBase.group!.undone!, compensationOutcomes: { confirmed: 0, failed: 0, unknown: 0, pending: 1 } } } }, now: NOW },
    });
    const status = wrapper.get('[data-test="action-notice-status"]');
    expect(status.text()).toBe('Restoring 1… · 1 skipped — unknown prior state');
    // Coverage stays precise in the title and accessible description.
    expect(status.attributes('title')).toContain('Undo accepted for 1 of 2');
    expect(status.attributes('title')).toContain('1 skipped (1 unknown prior state)');
    expect(status.attributes('aria-description')).toBe(status.attributes('title'));
  });

  it('names no skips and no coverage fraction when nothing was skipped', () => {
    const wrapper = mount(ActionNotice, {
      props: { notice: { ...groupBase, group: { ...groupBase.group!, count: 2, undone: {
        cancelled: 0, compensating: 2, skipped: 0, skipReasons: {},
        compensationOutcomes: { confirmed: 2, failed: 0, unknown: 0, pending: 0 },
      } } }, now: NOW },
    });
    const status = wrapper.get('[data-test="action-notice-status"]');
    expect(status.text()).toBe('Restored 2');
    expect(status.text()).not.toContain('skipped');
    expect(status.attributes('title')).toContain('Undo accepted for 2 of 2; 0 skipped');
  });

  it('shows restore-failed wording instead of permanent restoring (review U9)', () => {
    const wrapper = mount(ActionNotice, {
      props: { notice: { ...groupBase, group: { ...groupBase.group!, undone: { ...groupBase.group!.undone!, compensationOutcomes: { confirmed: 0, failed: 1, unknown: 0, pending: 0 } } } }, now: NOW },
    });
    expect(wrapper.get('[data-test="action-notice-status"]').text())
      .toContain('Restore failed for 1 — see Activity');
    expect(wrapper.get('[data-test="action-notice-status"]').text()).not.toContain('Restoring');
  });

  it('reports every mixed compensation category without hiding pending or uncertain siblings', () => {
    const wrapper = mount(ActionNotice, {
      props: { notice: { ...groupBase, group: { ...groupBase.group!, undone: {
        ...groupBase.group!.undone!, compensationOutcomes: { confirmed: 1, failed: 1, unknown: 1, pending: 1 },
      } } }, now: NOW },
    });
    const text = wrapper.get('[data-test="action-notice-status"]').text();
    expect(text).toContain('Restore failed for 1');
    expect(text).toContain('Restore outcome unknown for 1');
    expect(text).toContain('Restoring 1…');
    expect(text).toContain('Restored 1');
    expect(wrapper.get('[data-test="action-notice-status"]').attributes('title'))
      .toContain('restored 1, restoring 1, restore failed 1, restore outcome unknown 1');
  });

  it('shows restored wording when every compensation confirmed', () => {
    const wrapper = mount(ActionNotice, {
      props: { notice: { ...groupBase, group: { ...groupBase.group!, undone: { ...groupBase.group!.undone!, compensationOutcomes: { confirmed: 1, failed: 0, unknown: 0, pending: 0 } } } }, now: NOW },
    });
    expect(wrapper.get('[data-test="action-notice-status"]').text()).toContain('Restored 1');
  });

  it('shows a failed status check instead of pretending acceptance is pending (review U8)', () => {
    const wrapper = mount(ActionNotice, {
      props: {
        notice: {
          ...groupBase,
          group: { ...groupBase.group!, statusKnown: false, statusError: true, undone: null },
        },
        now: NOW,
      },
    });
    expect(wrapper.get('[data-test="action-notice-status"]').text()).toContain('Status check failed');
    expect(wrapper.get('[data-test="action-notice-status"]').text()).not.toContain('Accepting');
  });

  it('offers no Dismiss while acceptance is unresolved (review P1-1)', () => {
    const wrapper = mount(ActionNotice, {
      props: {
        notice: {
          ...groupBase,
          group: { ...groupBase.group!, acceptanceUnknown: true, statusKnown: false, undone: null },
        },
        now: NOW,
      },
    });
    expect(wrapper.find('[data-test="action-notice-recover-acceptance"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="action-notice-dismiss-group"]').exists()).toBe(false);
  });
});

describe('ActionNotice status tone (data-status → Amber / Coral / Ash)', () => {
  const tone = (wrapper: ReturnType<typeof mount>) => wrapper.get('[data-test="action-notice-status"]').attributes('data-status');
  const single = (status: OperationStatus | null) => mount(ActionNotice, {
    props: { notice: { ...base, undoableUntil: null, operation: status ? operation(status) : null }, now: NOW },
  });

  it.each([
    ['queued', 'pending'],
    ['applying', 'pending'],
    ['confirmed', 'settled'],
    ['failed', 'failed'],
    ['outcome_unknown', 'unknown'],
    ['cancelled', 'settled'],
    [null, 'pending'],
  ] as const)('marks the %s single-action status as %s', (status, expected) => {
    expect(tone(single(status))).toBe(expected);
  });

  const comp = (status: OperationStatus): OperationSummary => ({ ...operation(status), id: `comp-${status}` });
  const undone = (outcome: 'cancelled' | 'compensating', statuses: OperationStatus[]) => mount(ActionNotice, {
    props: {
      notice: { ...base, undoableUntil: null, operation: operation('confirmed'), undone: { outcome: outcome as never, compensations: statuses.map(comp) } },
      now: NOW,
    },
  });

  it.each([
    ['cancelled', [], 'settled'],
    ['compensating', ['confirmed'], 'settled'],
    ['compensating', [], 'pending'],
    ['compensating', ['applying'], 'pending'],
    ['compensating', ['confirmed', 'outcome_unknown'], 'unknown'],
    ['compensating', ['outcome_unknown', 'failed'], 'failed'],
  ] as const)('marks a %s undo with %j compensations as %s', (outcome, statuses, expected) => {
    expect(tone(undone(outcome, [...statuses]))).toBe(expected);
  });

  const counts = (over: Partial<Record<'pending' | 'confirmed' | 'failed' | 'rejected' | 'unknown' | 'cancelled', number>>) => ({
    pending: 0, confirmed: 0, failed: 0, rejected: 0, unknown: 0, cancelled: 0, ...over,
  });
  const group = (over: Record<string, unknown>, undoneOver: Record<string, unknown> | null = null) => mount(ActionNotice, {
    props: {
      notice: {
        ...base, subject: null, operation: null, undoableUntil: null,
        group: {
          count: 3, counts: counts({ confirmed: 3 }), acceptanceUnknown: false, statusKnown: true, statusError: false,
          undoableUntil: null, hadWindow: true,
          undone: undoneOver && {
            cancelled: 0, compensating: 2, skipped: 0, skipReasons: {},
            compensationOutcomes: { confirmed: 2, failed: 0, unknown: 0, pending: 0 }, ...undoneOver,
          },
          ...over,
        },
      },
      now: NOW,
    },
  });

  it.each([
    ['acceptance unknown', { acceptanceUnknown: true, statusKnown: false }, null, 'unknown'],
    ['status check failed', { statusKnown: false, statusError: true }, null, 'unknown'],
    ['accepting', { statusKnown: false }, null, 'pending'],
    ['all confirmed', {}, null, 'settled'],
    ['confirmed + cancelled', { counts: counts({ confirmed: 2, cancelled: 1 }) }, null, 'settled'],
    ['some pending', { counts: counts({ confirmed: 2, pending: 1 }) }, null, 'pending'],
    ['some unknown', { counts: counts({ confirmed: 2, unknown: 1 }) }, null, 'unknown'],
    ['unknown outranks pending', { counts: counts({ pending: 1, unknown: 1 }) }, null, 'unknown'],
    ['some failed', { counts: counts({ confirmed: 2, failed: 1 }) }, null, 'failed'],
    ['some rejected', { counts: counts({ confirmed: 2, rejected: 1 }) }, null, 'failed'],
    ['failed outranks unknown', { counts: counts({ failed: 1, unknown: 1, confirmed: 1 }) }, null, 'failed'],
    ['undo fully restored', {}, {}, 'settled'],
    ['undo with skipped members', {}, { skipped: 1, skipReasons: { unknown_prior: 1 } }, 'partial'],
    ['undo restoring', {}, { compensationOutcomes: { confirmed: 1, failed: 0, unknown: 0, pending: 1 } }, 'pending'],
    ['undo restore unknown', {}, { compensationOutcomes: { confirmed: 1, failed: 0, unknown: 1, pending: 0 } }, 'unknown'],
    ['undo restore failed', {}, { compensationOutcomes: { confirmed: 0, failed: 1, unknown: 1, pending: 0 } }, 'failed'],
  ] as const)('marks the group status "%s" as %s', (_name, over, undoneOver, expected) => {
    expect(tone(group({ ...over }, undoneOver && { ...undoneOver }))).toBe(expected);
  });

  it('keeps the words alongside the tone (never colour alone)', () => {
    const wrapper = single('failed');
    expect(wrapper.get('[data-test="action-notice-status"]').text()).toBe('Failed — restored, see Activity');
  });
});
