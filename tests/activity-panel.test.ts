import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ActivityPanel from '../src/components/ActivityPanel.vue';
import type { OperationStatus, OperationSummary } from '../src/lib/ipc/client';

function operation(status: OperationStatus): OperationSummary {
  return {
    id: `operation-${status}`,
    conversation: { accountId: 'synthetic-account', conversationId: 'synthetic-thread' },
    requestedArchived: true,
    status,
    failure: null,
    lastError: { kind: 'provider_unavailable' },
  };
}

describe('ActivityPanel', () => {
  it.each(['queued', 'outcome_unknown'] as const)(
    'does not describe provider-unavailable %s operations as failed',
    (status) => {
      const wrapper = mount(ActivityPanel, {
        props: {
          activity: [operation(status)],
          actionsEnabled: true,
          gmailMode: true,
        },
      });

      expect(wrapper.find(`[data-test="activity-${status}"] .activity-status`).text())
        .toBe(status === 'queued' ? 'queued' : 'outcome unknown');
      expect(wrapper.find('[data-test="activity-error"]').text())
        .toBe('The provider was unavailable; this is not a confirmed result.');
      expect(wrapper.find('[data-test="activity-error"]').text()).not.toContain('failed');
      wrapper.unmount();
    },
  );

  it('renders cancelled operations as Cancelled by Undo without recovery controls', () => {
    // Backend invariant: a cancelled archive is the ORIGINAL row — the backend
    // never emits cancelled + undoOf together (compensating ops are never
    // undoable, so never cancelled). Fixture rows are modelled separately.
    const cancelled: OperationSummary = {
      ...operation('cancelled'),
      failure: null,
      lastError: undefined,
    };
    const wrapper = mount(ActivityPanel, {
      props: { activity: [cancelled], actionsEnabled: true, gmailMode: false },
    });
    expect(wrapper.get('[data-test="activity-cancelled"] .activity-status').text()).toBe('Cancelled by Undo');
    // A cancelled archive was never applied: Unarchive must not be offered.
    expect(wrapper.find('[data-test="activity-unarchive-operation-cancelled"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('renders compensating operations with the undoOf linkage', () => {
    const compensating: OperationSummary = {
      ...operation('confirmed'),
      id: 'operation-undo-1',
      requestedArchived: false,
      lastError: undefined,
      undoOf: 'op-0001',
    };
    const wrapper = mount(ActivityPanel, {
      props: { activity: [compensating], actionsEnabled: true, gmailMode: false },
    });
    expect(wrapper.get('[data-test="activity-undo-of-operation-undo-1"]').text()).toBe('Undo of op-0001');
    wrapper.unmount();
  });
});

// --- UX-05 review fixes: persisted undo record, retry lineage, pagination
// continuation, and surfaced read failures. ---
import type { GroupUndoRecord, MailError, OperationGroupStatus } from '../src/lib/ipc/client';

const statusBase: OperationGroupStatus = {
  group: {
    groupId: 'grp-0001',
    requestId: 'req-1',
    accountId: 'synthetic-account',
    kind: 'archive',
    requestedArchived: true,
    acceptedAt: '2026-01-01T00:00:00Z',
    members: [
      { ordinal: 0, conversation: { accountId: 'synthetic-account', conversationId: 'thread-a' }, operationId: 'op-a', rejection: null },
      { ordinal: 1, conversation: { accountId: 'synthetic-account', conversationId: 'thread-b' }, operationId: 'op-b', rejection: null },
    ],
  },
  members: [
    { ordinal: 0, conversation: { accountId: 'synthetic-account', conversationId: 'thread-a' }, operationId: 'op-a', status: 'confirmed', failure: null, rejection: null },
    { ordinal: 1, conversation: { accountId: 'synthetic-account', conversationId: 'thread-b' }, operationId: 'op-b', status: 'confirmed', failure: null, rejection: null },
  ],
  undo: { available: false, reason: 'already_undone', undoableUntil: null },
  undoReceipt: {
    requestId: 'undo-req-1',
    acceptedAt: '2026-01-01T00:00:02Z',
    members: [
      {
        ordinal: 0,
        decision: { kind: 'compensating' },
        compensations: [{ operationId: 'comp-1', status: 'failed', failure: { kind: 'provider_rejected' } }],
      },
      { ordinal: 1, decision: { kind: 'skipped', reason: 'unknown_prior' }, compensations: [] },
    ],
  } as GroupUndoRecord,
};

function mountGroupDetail(props: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(ActivityPanel, {
    props: {
      activity: [],
      actionsEnabled: true,
      gmailMode: true,
      groups: [{ groupId: 'grp-0001', requestId: 'req-1', kind: 'archive', requestedArchived: true, acceptedAt: '2026-01-01T00:00:00Z', members: statusBase.group.members.map((m) => m.conversation), undone: true }],
      groupDetail: statusBase,
      expandedRequestId: 'req-1',
      ...props,
    },
  });
}

describe('ActivityPanel group recovery (review fixes)', () => {
  it('renders persisted undo decisions and current compensation outcomes (review U10)', () => {
    const wrapper = mountGroupDetail();
    const decision0 = wrapper.get('[data-test="group-member-undo-decision-0"]').text();
    expect(decision0).toContain('restoring');
    expect(wrapper.get('[data-test="group-compensation-comp-1"]').text()).toContain('restore failed');
    const decision1 = wrapper.get('[data-test="group-member-undo-decision-1"]').text();
    expect(decision1).toContain('skipped — unknown prior state');
  });

  it('renders retry lineage for a failed member without rewriting history (review U11)', () => {
    const retryRow = { ...operation('confirmed'), id: 'retry-1', retryOf: 'op-b' };
    const wrapper = mountGroupDetail({
      activity: [retryRow],
      groupDetail: {
        ...statusBase,
        members: statusBase.members.map((m, i) => (i === 1 ? { ...m, status: 'failed' as const, failure: { kind: 'provider_rejected' } } : m)),
      },
    });
    const lineage = wrapper.get('[data-test="group-member-retry-lineage-1"]').text();
    expect(lineage).toContain('Retry retry-1');
  });

  it('offers bounded continuation for older groups (review U6)', async () => {
    const wrapper = mountGroupDetail({ groupsHasMore: true });
    expect(wrapper.find('[data-test="activity-groups-more"]').exists()).toBe(true);
    await wrapper.get('[data-test="activity-groups-more"]').trigger('click');
    expect(wrapper.emitted('loadMoreGroups')).toBeTruthy();
  });

  it('surfaces a failed group-history read instead of "No operations yet" (review U8)', async () => {
    const error: MailError = { kind: 'storage_unavailable' };
    const wrapper = mount(ActivityPanel, { props: { activity: [], groups: [], groupsError: error, actionsEnabled: true, gmailMode: true } });
    expect(wrapper.find('[data-test="activity-empty"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="groups-error"]').text()).toContain('Could not load the group history');
    await wrapper.get('[data-test="groups-retry"]').trigger('click');
    expect(wrapper.emitted('retryGroups')).toBeTruthy();
  });

  it('surfaces a failed group-detail read with retry (review U8)', async () => {
    const error: MailError = { kind: 'storage_unavailable' };
    const wrapper = mountGroupDetail({ groupDetail: null, groupDetailError: error });
    expect(wrapper.get('[data-test="group-detail-error"]').text()).toContain('Could not load');
    await wrapper.get('[data-test^="group-detail-retry-"]').trigger('click');
    expect(wrapper.emitted('retryGroupDetail')).toBeTruthy();
  });
});
