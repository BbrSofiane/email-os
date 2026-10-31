/** UX-04 ActionNotice: status wording, undo window, and truncation. */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ActionNotice from '../src/components/ActionNotice.vue';
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
  subject: 'Fixture thread 1: weekly status',
  undoableUntil: new Date(NOW + 5_000).toISOString(),
};

describe('ActionNotice', () => {
  it('renders an empty polite live region with no slot', () => {
    const wrapper = mount(ActionNotice, { props: { notice: null, now: NOW } });
    expect(wrapper.find('[data-test="action-notice"]').attributes('role')).toBe('status');
    expect(wrapper.find('[data-test="action-notice"]').attributes('aria-live')).toBe('polite');
    expect(wrapper.text()).toBe('');
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

  it('hides the undo control and shows the recovery wording after the window passes', () => {
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
});
