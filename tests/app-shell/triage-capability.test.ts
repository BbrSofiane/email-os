/**
 * ADR 0002 decision 2: read state, read/star controls, the Starred view and
 * Retry are shown by the backend's explicit capability (`capabilities.
 * triageSurfaces`), not by the mode name. A status that does not state it
 * (Gmail today, or an older backend) keeps the previous mode-based behaviour.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import ActivityPanel from '../../src/components/ActivityPanel.vue';
import type { AccountStatus, MailClient, OperationSummary } from '../../src/lib/ipc/client';
import { createBrowserFakeMailClient } from '../../src/lib/ipc/browser-fake';
import { useMailbox } from '../../src/composables/useMailbox';
import { effectScope } from 'vue';
import { flushFakeClientAndVueUpdates, mountApp, useGmailMode } from '../helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

/** The fake with its status rewritten, as another backend generation would send it. */
function withStatus(fake: ReturnType<typeof createBrowserFakeMailClient>, patch: (status: AccountStatus) => AccountStatus): MailClient {
  return { ...fake, getAccountStatus: async () => patch(await fake.getAccountStatus()) } as MailClient;
}

describe('status states the capability explicitly', () => {
  it('a fixture session sends the capability and no Google grant; Gmail sends the grant and no capability', async () => {
    const fake = createBrowserFakeMailClient();
    const fixture = await fake.getAccountStatus();
    expect(fixture.mode).toBe('fixture');
    expect(fixture.capabilities).toEqual({ triageSurfaces: true });
    expect(fixture.mutationAccess).toBeUndefined();
    useGmailMode(fake, { mutationAccess: 'enabled' });
    const gmail = await fake.getAccountStatus();
    expect(gmail.capabilities).toBeUndefined();
    expect(gmail.mutationAccess).toBe('enabled');
  });

  it('useMailbox resolves triageSurfaces from the field, falling back to the mode for a status without it', async () => {
    const run = async (client: MailClient): Promise<boolean> => {
      const scope = effectScope();
      const mailbox = scope.run(() => useMailbox(client))!;
      await mailbox.ready;
      const value = mailbox.triageSurfaces.value;
      scope.stop();
      return value;
    };
    const fake = createBrowserFakeMailClient();
    expect(await run(fake)).toBe(true); // explicit
    expect(await run(withStatus(fake, (s) => ({ ...s, capabilities: { triageSurfaces: false } })))).toBe(false); // explicit off wins
    expect(await run(withStatus(fake, ({ capabilities: _omit, ...rest }) => rest as AccountStatus))).toBe(false); // legacy fixture status
    const gmail = createBrowserFakeMailClient();
    useGmailMode(gmail, { mutationAccess: 'enabled' });
    expect(await run(gmail)).toBe(true); // Gmail without the field keeps its behaviour
  });
});

describe('fixture mode shows the triage surfaces when the backend says so', () => {
  it('shows the Starred rail and read state, and hides Gmail-only Trash', async () => {
    const fake = createBrowserFakeMailClient();
    wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="rail-starred"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="rail-trash"]').exists()).toBe(false);
    // Read state is part of each row's accessible name.
    expect(wrapper.text() + wrapper.html()).toMatch(/Unread/);
  });

  it('without the capability (an older backend) the same fixture mode hides them', async () => {
    const fake = createBrowserFakeMailClient();
    const client = withStatus(fake, ({ capabilities: _omit, ...rest }) => rest as AccountStatus);
    wrapper = mountApp(client, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="rail-starred"]').exists()).toBe(false);
  });

  it('Gmail mode is unchanged: Starred and Trash are shown without the field', async () => {
    const fake = createBrowserFakeMailClient();
    useGmailMode(fake, { mutationAccess: 'enabled' });
    wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="rail-starred"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="rail-trash"]').exists()).toBe(true);
  });
});

describe('Activity copy says what is true for the session', () => {
  const op = (status: OperationSummary['status'], kind: string): OperationSummary => ({
    id: `op-${status}`,
    conversation: { accountId: 'a', conversationId: 'c' },
    kind: 'archive',
    status,
    failure: status === 'failed' ? { kind: kind as never } : null,
    lastError: status === 'outcome_unknown' ? { kind: kind as never } : undefined,
    undoOf: null,
    undoableUntil: null,
    requestedArchived: true,
  } as unknown as OperationSummary);

  it.each([
    ['failed', 'provider_rejected', 'The mailbox rejected the requested change.', 'The provider rejected the requested state.'],
    ['outcome_unknown', 'outcome_unknown', 'The change was interrupted and its result could not be confirmed.', 'The request may have reached Google, but its result could not be confirmed.'],
    ['outcome_unknown', 'rate_limited', 'Too many requests; it can be retried.', 'Google rate limited this action; it can be retried.'],
  ] as const)('%s / %s', (status, kind, local, google) => {
    const render = (localSession: boolean) => {
      const w = mount(ActivityPanel, { props: { activity: [op(status, kind)], actionsEnabled: true, gmailMode: true, localSession } });
      const text = w.get('[data-test="activity-error"]').text();
      w.unmount();
      return text;
    };
    expect(render(true)).toBe(local);
    expect(render(true)).not.toMatch(/Google/);
    expect(render(false)).toBe(google);
  });
});
