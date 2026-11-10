/**
 * DraftsPanel (drawer): one column that swaps between the draft list and the
 * editor. Back goes through the editor's own protected close, rows are compact
 * drawer rows, and a revision shows as a word only while that draft conflicts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import DraftsPanel from '../src/components/DraftsPanel.vue';
import { compactDateLabel, fullDateLabel } from '../src/lib/browsing-dates';
import type { DraftContent, DraftRef, DraftSummary } from '../src/lib/ipc/client';
import { createBrowserFakeMailClient, fixtureRef, waitFor } from './helpers';

const CONTENT: DraftContent = { to: '', cc: '', subject: '', bodyText: '' };
const ref = (draftId: string): DraftRef => ({ accountId: 'acct-fixture', draftId });
const summary = (draftId: string, patch: Partial<DraftSummary> = {}): DraftSummary => ({
  ref: ref(draftId), revision: 3, updatedAt: '2026-01-02T03:04:00Z', subject: 'Plan', to: 'ada@example.test', source: { kind: 'new_message' }, ...patch,
});

function mountPanel(overrides: Record<string, unknown> = {}): VueWrapper {
  return mount(DraftsPanel, {
    props: {
      summaries: [summary('d1'), summary('d2', { subject: '', to: '', source: { kind: 'reply', conversation: fixtureRef('conv-01'), sourceMessageId: 'm1' } })],
      activeRef: null, source: null, content: CONTENT, status: '', visible: false, suspendedEditor: false,
      creating: false, saving: false, conflict: false, error: null, createError: null, deleting: false, closing: false,
      transitioning: false, deletePending: false, confirmDiscard: false, discardBusy: false, confirmReload: false,
      copyPending: false, recoveryRequired: false, canCancelReplyPreparation: false, listError: null,
      subscriptionError: null, closeError: null, closeRetryAvailable: false, closeSetupError: null,
      ...overrides,
    },
    attachTo: document.body,
  });
}

describe('DraftsPanel one-column swap', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('shows the list by default and no editor, no landmark and no panel heading', () => {
    wrapper = mountPanel();
    expect(wrapper.find('[data-test="draft-list-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="composer"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="back-to-drafts"]').exists()).toBe(false);
    expect(wrapper.element.tagName).toBe('DIV');
    expect(wrapper.find('section, aside, h1, h2').exists()).toBe(false);
  });

  it('replaces the list with the editor when a draft is visible, and Back emits the protected close', async () => {
    wrapper = mountPanel({ visible: true, activeRef: ref('d1'), source: { kind: 'new_message' } });
    expect(wrapper.find('[data-test="draft-list-view"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="new-draft"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="composer"]').exists()).toBe(true);
    expect(wrapper.get('.composer-heading h3').text()).toBe('New local draft');
    const back = wrapper.get('[data-test="back-to-drafts"]');
    expect(back.text()).toBe('Back to drafts');
    await back.trigger('click');
    expect(wrapper.emitted('closeEditor')).toHaveLength(1);
    // Back and the editor's own close are one path: the same event.
    await wrapper.get('[data-test="close-composer"]').trigger('click');
    expect(wrapper.emitted('closeEditor')).toHaveLength(2);
    expect(wrapper.emitted('newDraft')).toBeUndefined();
    expect(wrapper.emitted('openDraft')).toBeUndefined();
  });

  it('disables Back exactly while the editor close is disabled', () => {
    wrapper = mountPanel({ visible: true, activeRef: ref('d1'), source: { kind: 'new_message' }, closing: true });
    expect(wrapper.get('[data-test="back-to-drafts"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="close-composer"]').attributes('disabled')).toBeDefined();
  });

  it('keeps every recovery line visible in the editor view', () => {
    wrapper = mountPanel({
      visible: true, activeRef: ref('d1'), source: { kind: 'new_message' },
      closeSetupError: 'setup failed', closeRetryAvailable: true,
      listError: { kind: 'storage_unavailable' }, subscriptionError: { kind: 'storage_unavailable' }, closeError: 'close failed',
    });
    expect(wrapper.get('[data-test="draft-close-setup-error"]').attributes('role')).toBe('alert');
    expect(wrapper.find('[data-test="retry-close"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="retry-close-setup"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="draft-list-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="retry-draft-subscription"]').exists()).toBe(true);
    // The editor's own close error line is the one shown while it is visible.
    expect(wrapper.get('[data-test="draft-close-error"]').text()).toBe('close failed');
  });

  it('keeps the list-view alerts: suspended editor, close error and open error', () => {
    wrapper = mountPanel({ suspendedEditor: true, closeError: 'close failed', createError: { kind: 'storage_unavailable' } });
    expect(wrapper.get('[data-test="suspended-editor"]').text()).toContain('suspended in memory');
    expect(wrapper.get('[data-test="draft-close-error"]').text()).toBe('close failed');
    expect(wrapper.find('[data-test="draft-open-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="draft-list"]').exists()).toBe(false);
  });

  it('says "No local drafts." for an empty list and folds the local-only note into one line', () => {
    wrapper = mountPanel({ summaries: [] });
    expect(wrapper.get('[data-test="draft-list-empty"]').text()).toBe('No local drafts.');
    const note = wrapper.get('.draft-local-note');
    expect(note.text()).toContain('Local to this device · never sent');
    expect(note.attributes('title')).toContain('No drafts are sent to a mail provider');
    expect(note.get('.visually-hidden').text()).toContain('No drafts are sent to a mail provider');
  });
});

describe('DraftsPanel rows', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('renders recipient, subject and a compact updated time with its full-date title', () => {
    wrapper = mountPanel();
    const row = wrapper.get('[data-test="open-draft-d1"]');
    expect(row.get('.drawer-sender').text()).toBe('ada@example.test');
    expect(row.get('.drawer-subject').text()).toBe('Plan');
    const date = row.get('time.drawer-date');
    expect(date.text()).toBe(compactDateLabel('2026-01-02T03:04:00Z'));
    expect(date.attributes('title')).toBe(fullDateLabel('2026-01-02T03:04:00Z'));
  });

  it('uses Ash placeholders for an empty recipient and subject and marks a reply with one quiet word', () => {
    wrapper = mountPanel();
    const row = wrapper.get('[data-test="open-draft-d2"]');
    expect(row.get('.drawer-sender').text()).toBe('(no recipient)');
    expect(row.get('.drawer-sender').classes()).toContain('drawer-empty');
    expect(row.get('.drawer-subject').text()).toBe('(no subject)');
    expect(row.get('.drawer-subject').classes()).toContain('drawer-empty');
    expect(row.get('.drawer-flag').text()).toBe('Reply');
    expect(wrapper.get('[data-test="open-draft-d1"]').find('.drawer-flag').exists()).toBe(false);
  });

  it('keeps the revision in the row title and out of the text unless that draft conflicts', async () => {
    wrapper = mountPanel();
    const row = wrapper.get('[data-test="open-draft-d1"]');
    expect(row.attributes('title')).toBe('Revision 3 · New message');
    expect(wrapper.text()).not.toContain('Revision');
    expect(wrapper.text()).not.toContain('revision');
    // A conflict on ANOTHER draft never labels this row.
    await wrapper.setProps({ conflict: true, activeRef: ref('d2') });
    expect(wrapper.get('[data-test="open-draft-d1"]').find('[data-test="draft-row-conflict"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="open-draft-d2"]').get('[data-test="draft-row-conflict"]').text()).toBe('Conflict · revision 3');
    await wrapper.setProps({ conflict: false });
    expect(wrapper.find('[data-test="draft-row-conflict"]').exists()).toBe(false);
  });

  it('opens a draft from its row and moves between rows with J/K', async () => {
    wrapper = mountPanel();
    const [first, second] = wrapper.findAll('[data-drawer-row]');
    expect(first!.attributes('tabindex')).toBe('0');
    expect(second!.attributes('tabindex')).toBe('-1');
    (first!.element as HTMLElement).focus();
    await first!.trigger('keydown', { key: 'j' });
    expect(document.activeElement).toBe(second!.element);
    await second!.trigger('click');
    expect(wrapper.emitted('openDraft')).toEqual([[ref('d2')]]);
  });
});

describe('Drafts drawer in the app', () => {
  let app: VueWrapper | null = null;
  afterEach(() => { app?.unmount(); app = null; });

  it('swaps list and editor, and Back to drafts flushes the exact text through the protected close', async () => {
    const fake = createBrowserFakeMailClient();
    app = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
    await flushPromises();
    await app.get('[data-test="rail-drafts"]').trigger('click');
    await waitFor(() => app!.find('[data-test="drafts-pane"]').exists());
    expect(app.find('[data-test="draft-list-view"]').exists()).toBe(true);
    await app.get('[data-test="new-draft"]').trigger('click');
    await waitFor(() => app!.find('[data-test="composer"]').exists());
    await waitFor(() => app!.get('[data-test="draft-status"]').text().includes('preview memory'));
    expect(app.find('[data-test="draft-list-view"]').exists()).toBe(false);
    await app.get('[data-test="draft-body"]').setValue('typed before Back');
    await app.get('[data-test="back-to-drafts"]').trigger('click');
    await flushPromises();
    expect(app.find('[data-test="composer"]').exists()).toBe(false);
    expect(app.find('[data-test="draft-list-view"]').exists()).toBe(true);
    const saved = (await fake.listDrafts())[0]!;
    expect((await fake.getDraft(saved.ref)).content.bodyText).toBe('typed before Back');
    expect(app.find(`[data-test="open-draft-${saved.ref.draftId}"]`).exists()).toBe(true);
  });

  it('stays on the editor with its error when the flush behind Back fails', async () => {
    const fake = createBrowserFakeMailClient();
    app = mount(App, { props: { client: { ...fake, saveDraft: async () => { throw { kind: 'storage_unavailable' }; } }, mode: 'browser-preview' }, attachTo: document.body });
    await flushPromises();
    await app.get('[data-test="rail-drafts"]').trigger('click');
    await waitFor(() => app!.find('[data-test="drafts-pane"]').exists());
    await app.get('[data-test="new-draft"]').trigger('click');
    await waitFor(() => app!.find('[data-test="composer"]').exists());
    await app.get('[data-test="draft-body"]').setValue('must not be lost');
    await app.get('[data-test="back-to-drafts"]').trigger('click');
    await flushPromises();
    expect(app.find('[data-test="composer"]').exists()).toBe(true);
    expect(app.find('[data-test="draft-list-view"]').exists()).toBe(false);
    expect((app.get('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('must not be lost');
    expect(app.find('[data-test="draft-close-error"], [data-test="draft-error"]').exists()).toBe(true);
  });
});
