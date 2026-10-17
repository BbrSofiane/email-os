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
});
