import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ActivityPanel from '../../src/components/ActivityPanel.vue';
import { fullDateLabel } from '../../src/lib/browsing-dates';
import type { OperationStatus, OperationSummary } from '../../src/lib/ipc/client';

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
        .toBe(status === 'queued' ? 'Queued' : 'Unknown');
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
    // One word on screen; the Undo cause is in its title.
    const word = wrapper.get('[data-test="activity-cancelled"] .activity-status');
    expect(word.text()).toBe('Cancelled');
    expect(word.attributes('title')).toContain('Cancelled by Undo');
    // A cancelled archive was never applied: Mark not done must not be offered.
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
import type { GroupUndoRecord, MailError, OperationGroupStatus } from '../../src/lib/ipc/client';

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

describe('ActivityPanel drawer rows (subject, status word, keyboard)', () => {
  const known = { accountId: 'synthetic-account', conversationId: 'synthetic-thread' };
  const subjectFor = (ref: { conversationId: string }) => (ref.conversationId === 'synthetic-thread' ? 'Quarterly plan' : null);

  it('names mail by its cached subject and keeps the raw id in a title only', () => {
    const unseen: OperationSummary = { ...operation('confirmed'), id: 'operation-unseen', conversation: { accountId: 'synthetic-account', conversationId: 'opaque-id-9' }, lastError: undefined };
    const wrapper = mount(ActivityPanel, { props: { activity: [{ ...operation('confirmed'), lastError: undefined }, unseen], actionsEnabled: true, gmailMode: false, subjectFor } });
    const seen = wrapper.get('[data-test="activity-open-operation-confirmed"]');
    expect(seen.text()).toContain('Quarterly plan');
    expect(seen.text()).toContain('Mark done');
    const missing = wrapper.get('[data-test="activity-open-operation-unseen"]');
    expect(missing.text()).toContain('Unknown conversation');
    // The id is evidence, never row text.
    expect(wrapper.text()).not.toContain('synthetic-thread');
    expect(wrapper.text()).not.toContain('opaque-id-9');
    expect(missing.attributes('title')).toContain('opaque-id-9');
    expect(seen.attributes('title')).toContain('synthetic-thread');
    wrapper.unmount();
  });

  it('shows a seen empty subject as "(No subject)", not as unknown', () => {
    const wrapper = mount(ActivityPanel, { props: { activity: [{ ...operation('confirmed'), lastError: undefined }], subjectFor: () => '' } });
    expect(wrapper.get('[data-test="activity-open-operation-confirmed"]').text()).toContain('(No subject)');
    wrapper.unmount();
  });

  it('puts colour on the status word only, with a word for every state', () => {
    const states: Array<[OperationStatus, string, string]> = [
      ['queued', 'Queued', 'tone-warn'],
      ['applying', 'Applying…', 'tone-warn'],
      ['outcome_unknown', 'Unknown', 'tone-warn'],
      ['failed', 'Failed', 'tone-fault'],
      ['confirmed', 'Confirmed', 'tone-calm'],
      ['cancelled', 'Cancelled', 'tone-calm'],
    ];
    const wrapper = mount(ActivityPanel, {
      props: { activity: states.map(([status]) => ({ ...operation(status), lastError: undefined, failure: status === 'failed' ? { kind: 'provider_rejected' as const } : null })), subjectFor },
    });
    for (const [status, word, tone] of states) {
      const row = wrapper.get(`[data-test="activity-${status}"]`);
      const status$ = row.get('.activity-status');
      expect(status$.text()).toBe(word);
      expect(status$.classes()).toEqual(expect.arrayContaining([`status-${status}`, tone]));
      // The row itself carries no tint class.
      expect(row.classes().some((name) => name.startsWith('status-') || name.startsWith('tone-'))).toBe(false);
    }
    expect(wrapper.get('[data-test="activity-failed"] .activity-status').attributes('title')).toContain('provider_rejected');
    // A failed row says why, in words, without needing the title.
    expect(wrapper.get('[data-test="activity-failed"] [data-test="activity-error"]').text()).toBe('The provider rejected the requested state.');
    wrapper.unmount();
  });

  it('shows no date on a single operation (the DTO has none)', () => {
    const wrapper = mount(ActivityPanel, { props: { activity: [{ ...operation('confirmed'), lastError: undefined }], subjectFor } });
    expect(wrapper.find('time').exists()).toBe(false);
    wrapper.unmount();
  });

  it('labels the retry button "Retry" and keeps the new-request-ID explanation in its title', async () => {
    const wrapper = mount(ActivityPanel, { props: { activity: [{ ...operation('failed'), failure: { kind: 'provider_rejected' } }], actionsEnabled: true, gmailMode: true, subjectFor } });
    const retry = wrapper.get('[data-test="activity-retry-operation-failed"]');
    expect(retry.text()).toBe('Retry');
    expect(retry.attributes('title')).toBe('Retry with a new request ID. The original result is not rewritten.');
    await retry.trigger('click');
    expect(wrapper.emitted('retry')).toEqual([['operation-failed']]);
    // Retry is still gated by Gmail mode, the capability and the status.
    await wrapper.setProps({ gmailMode: false });
    expect(wrapper.find('[data-test="activity-retry-operation-failed"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps Open and Mark not done emits unchanged', async () => {
    const wrapper = mount(ActivityPanel, { props: { activity: [{ ...operation('confirmed'), lastError: undefined }], actionsEnabled: true, subjectFor } });
    await wrapper.get('[data-test="activity-open-operation-confirmed"]').trigger('click');
    await wrapper.get('[data-test="activity-unarchive-operation-confirmed"]').trigger('click');
    expect(wrapper.emitted('open')).toEqual([[known]]);
    expect(wrapper.emitted('unarchive')).toEqual([[known]]);
    expect(wrapper.get('[data-test="activity-unarchive-operation-confirmed"]').text()).toBe('Mark not done');
    wrapper.unmount();
  });

  it('is a plain div with no landmark and no heading that repeats the drawer title', () => {
    const wrapper = mount(ActivityPanel, { props: { activity: [{ ...operation('confirmed'), lastError: undefined }], subjectFor } });
    expect(wrapper.element.tagName).toBe('DIV');
    expect(wrapper.find('aside, section, h1, h2').exists()).toBe(false);
    expect(wrapper.find('[aria-label]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('moves between rows with J/K/arrows, leaves trailing buttons alone and has one Tab stop', async () => {
    const rows = [operation('confirmed'), { ...operation('queued'), id: 'operation-two' }].map((op) => ({ ...op, lastError: undefined }));
    const wrapper = mount(ActivityPanel, { props: { activity: rows, actionsEnabled: true, subjectFor }, attachTo: document.body });
    const [first, second] = wrapper.findAll('[data-drawer-row]');
    expect(first!.attributes('tabindex')).toBe('0');
    expect(second!.attributes('tabindex')).toBe('-1');
    (first!.element as HTMLElement).focus();
    await first!.trigger('keydown', { key: 'j' });
    expect(document.activeElement).toBe(second!.element);
    expect(second!.attributes('tabindex')).toBe('0');
    expect(first!.attributes('tabindex')).toBe('-1');
    // A trailing action button is not a row: its keys stay native.
    const trailing = wrapper.get('[data-test="activity-unarchive-operation-confirmed"]');
    (trailing.element as HTMLElement).focus();
    const event = new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true });
    trailing.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(trailing.element);
    wrapper.unmount();
  });
});

describe('ActivityPanel group recovery (review fixes)', () => {
  it('titles the section "Bulk actions", labels a group by action and count, and keeps the request id in a title', () => {
    const w = mountGroupDetail();
    expect(w.get('[data-test="activity-groups"] h3').text()).toBe('Bulk actions');
    const toggle = w.get('[data-test="activity-group-toggle-grp-0001"]');
    expect(toggle.text()).toContain('Mark done · 2 conversations');
    expect(toggle.text()).toContain('undo accepted');
    expect(toggle.attributes('title')).toBe('Request req-1');
    // The group date is the trailing slot of the toggle.
    expect(toggle.get('time.drawer-date').text()).toBe(fullDateLabel('2026-01-01T00:00:00Z'));
    expect(w.text()).not.toContain('Request req-1');
    expect(w.find('[data-test="group-detail-request"]').exists()).toBe(false);
  });

  it('uses the singular for a one-conversation group and "Show older" for continuation', () => {
    const w = mountGroupDetail({
      groups: [{ groupId: 'grp-0001', requestId: 'req-1', kind: 'archive', requestedArchived: true, acceptedAt: '2026-01-01T00:00:00Z', members: [statusBase.group.members[0]!.conversation], undone: false }],
      groupsHasMore: true,
    });
    expect(w.get('[data-test="activity-group-toggle-grp-0001"]').text()).toContain('Mark done · 1 conversation');
    expect(w.get('[data-test="activity-group-toggle-grp-0001"]').text()).not.toContain('1 conversations');
    expect(w.get('[data-test="activity-groups-more"]').text()).toBe('Show older');
  });

  it('lists group members by subject with ids in titles and a status word', () => {
    const subjectFor = (ref: { conversationId: string }) => (ref.conversationId === 'thread-a' ? 'Invoice 42' : null);
    const w = mountGroupDetail({ subjectFor });
    const a = w.get('[data-test="group-member-open-0"]');
    const b = w.get('[data-test="group-member-open-1"]');
    expect(a.text()).toContain('Invoice 42');
    expect(b.text()).toContain('Unknown conversation');
    expect(a.attributes('title')).toContain('thread-a');
    expect(w.text()).not.toContain('thread-b');
    expect(w.get('[data-test="group-member-status-confirmed"]').text()).toBe('Confirmed');
  });

  it('marks a rejected member in Coral with the reason in its title', () => {
    const w = mountGroupDetail({
      groupDetail: { ...statusBase, members: statusBase.members.map((m, i) => (i === 0 ? { ...m, status: 'failed' as const, rejection: 'conversation_missing' as const } : m)) },
    });
    const status = w.get('[data-test="group-member-status-failed"]');
    expect(status.text()).toBe('Rejected');
    expect(status.classes()).toContain('tone-fault');
    expect(status.attributes('title')).toBe('Rejected — conversation unavailable');
  });


  it('dates a group in the full viewer-local form with a machine-readable datetime, never raw UTC', () => {
    const w = mountGroupDetail();
    const time = w.get('time[datetime="2026-01-01T00:00:00.000Z"]');
    expect(time.text()).toBe(fullDateLabel('2026-01-01T00:00:00Z'));
    expect(w.text()).not.toContain('UTC');
    expect(w.text()).not.toContain('2026-01-01');
  });

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
