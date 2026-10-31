/** UX-04 ActionNotice: status wording, undo window, and truncation. */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ActionNotice from '../src/components/ActionNotice.vue';
import type { LastActionId } from '../src/composables/useMailbox';
import type { OperationStatus, OperationSummary } from '../src/lib/ipc/client';

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
  label: 'Mark Done (Archive)',
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
      .toBe('Undo expired — Mark Not Done restores the whole conversation to Inbox');
  });

  it('derives the expired recovery clause from the action (unarchive, read)', () => {
    const unarchive = mount(ActionNotice, {
      props: {
        notice: { ...base, actionId: 'unarchive', operation: operation('confirmed'), undoableUntil: new Date(NOW - 1).toISOString() },
        now: NOW,
      },
    });
    expect(unarchive.get('[data-test="action-notice-expired"]').text())
      .toBe('Undo expired — Mark Done archives the whole conversation');
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
    expect(label.startsWith('Mark Done (Archive) · ')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThan('Mark Done (Archive) · '.length + 62);
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
    expect(label).toBe('Mark Done (Archive)');
    expect(label).not.toContain('·');
  });
});

describe('ActionNotice group undo wording (review fixes)', () => {
  // --- UX-05 group notices: partial undo wording tracks CURRENT compensation
  // outcomes instead of a permanent "restoring…" (review U9). ---
  const groupBase = {
    label: 'Mark Done (Archive)',
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
    expect(wrapper.get('[data-test="action-notice-status"]').text())
      .toContain('Undo accepted for 1 of 2; 1 skipped — unknown prior state; restoring…');
  });

  it('shows restore-failed wording instead of permanent restoring (review U9)', () => {
    const wrapper = mount(ActionNotice, {
      props: { notice: { ...groupBase, group: { ...groupBase.group!, undone: { ...groupBase.group!.undone!, compensationOutcomes: { confirmed: 0, failed: 1, unknown: 0, pending: 0 } } } }, now: NOW },
    });
    expect(wrapper.get('[data-test="action-notice-status"]').text())
      .toContain('restore failed for 1 — see Activity');
    expect(wrapper.get('[data-test="action-notice-status"]').text()).not.toContain('restoring');
  });

  it('shows restored wording when every compensation confirmed', () => {
    const wrapper = mount(ActionNotice, {
      props: { notice: { ...groupBase, group: { ...groupBase.group!, undone: { ...groupBase.group!.undone!, compensationOutcomes: { confirmed: 1, failed: 0, unknown: 0, pending: 0 } } } }, now: NOW },
    });
    expect(wrapper.get('[data-test="action-notice-status"]').text()).toContain('restored');
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
