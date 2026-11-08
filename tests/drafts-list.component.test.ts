/**
 * DraftsList (the Drafts list context): non-thread rows on ContextRowList, one
 * Ash coverage line with the quiet New draft action, the in-flow recovery and
 * error lines, and the keyboard model. It only lists drafts and reports which
 * one was chosen; opening is the app's decision (see drafts.context.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import DraftsList from '../src/components/DraftsList.vue';
import { compactDateLabel, fullDateLabel } from '../src/lib/browsing-dates';
import type { DraftRef, DraftSummary } from '../src/lib/ipc/client';
import { fixtureRef } from './helpers';

const ref = (draftId: string): DraftRef => ({ accountId: 'acct-fixture', draftId });
const summary = (draftId: string, patch: Partial<DraftSummary> = {}): DraftSummary => ({
  ref: ref(draftId), revision: 3, updatedAt: '2026-01-02T03:04:00Z', subject: 'Plan', to: 'ada@example.test', source: { kind: 'new_message' }, ...patch,
});
const REPLY = summary('d2', { subject: '', to: '', source: { kind: 'reply', conversation: fixtureRef('conv-01'), sourceMessageId: 'm1' } });

function mountList(overrides: Record<string, unknown> = {}): VueWrapper {
  return mount(DraftsList, {
    props: {
      summaries: [summary('d1'), REPLY],
      activeKey: null, activeRef: null, conflict: false, suspendedEditor: false, busy: false,
      createError: null, listError: null, subscriptionError: null,
      closeError: null, closeRetryAvailable: false, closeSetupError: null,
      ...overrides,
    },
    attachTo: document.body,
  });
}

describe('DraftsList coverage line and actions', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('states the local-only guarantee once: one Ash line, the sentence in its title and hidden text', () => {
    wrapper = mountList();
    const note = wrapper.get('[data-test="drafts-coverage"]');
    expect(note.attributes('role')).toBe('note');
    expect(note.element.firstChild?.textContent).toBe('Local to this device · never sent');
    expect(note.attributes('title')).toBe('Drafts are local to this device and account. No drafts are sent to a mail provider.');
    expect(note.get('.visually-hidden').text()).toContain('No drafts are sent to a mail provider');
    expect(wrapper.find('h1, h2, h3, section, aside').exists()).toBe(false);
  });

  it('puts a quiet New draft button on the line and disables it while the editor is busy', async () => {
    wrapper = mountList();
    const button = wrapper.get('[data-test="new-draft"]');
    expect(button.text()).toBe('New draft');
    expect(button.classes()).toContain('drawer-quiet');
    expect(wrapper.get('.context-coverage').element.contains(button.element)).toBe(true);
    await button.trigger('click');
    expect(wrapper.emitted('newDraft')).toHaveLength(1);
    await wrapper.setProps({ busy: true });
    expect(wrapper.get('[data-test="new-draft"]').attributes('disabled')).toBeDefined();
  });

  it('says "No local drafts." for an empty list and still offers New draft', () => {
    wrapper = mountList({ summaries: [] });
    expect(wrapper.get('[data-test="draft-list-empty"]').text()).toBe('No local drafts.');
    expect(wrapper.find('[data-test="draft-list"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="new-draft"]').exists()).toBe(true);
  });
});

describe('DraftsList rows', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('renders recipient (Title), subject and a compact updated time with its full-date title', () => {
    wrapper = mountList();
    const item = wrapper.get('[data-test="draft-list"] li');
    expect(item.get('.context-row-primary .context-subject').text()).toBe('ada@example.test');
    expect(item.get('.context-row-secondary .draft-subject').text()).toBe('Plan');
    const date = item.get('time.draft-date');
    expect(date.text()).toBe(compactDateLabel('2026-01-02T03:04:00Z'));
    expect(date.attributes('title')).toBe(fullDateLabel('2026-01-02T03:04:00Z'));
    expect(date.attributes('datetime')).toBeDefined();
    // The row's one button carries the hook the old drawer used.
    expect(item.get('[data-test="open-draft-d1"]').element.tagName).toBe('BUTTON');
    expect(wrapper.get('[data-test="draft-list"]').attributes('aria-label')).toBe('Local drafts');
  });

  it('uses Ash placeholders for an empty recipient and subject and marks a reply with one quiet word', () => {
    wrapper = mountList();
    const items = wrapper.findAll('[data-test="draft-list"] li');
    const reply = items[1]!;
    expect(reply.get('.context-subject').text()).toBe('(no recipient)');
    expect(reply.get('.context-subject').classes()).toContain('drawer-empty');
    expect(reply.get('.draft-subject').text()).toBe('(no subject)');
    expect(reply.get('.draft-subject').classes()).toContain('drawer-empty');
    expect(reply.get('.draft-reply').text()).toBe('Reply');
    expect(items[0]!.find('.draft-reply').exists()).toBe(false);
  });

  it('keeps the revision in the row title and out of the text unless that draft conflicts', async () => {
    wrapper = mountList();
    expect(wrapper.get('[data-test="open-draft-d1"]').attributes('title')).toBe('Revision 3 · New message');
    expect(wrapper.get('[data-test="open-draft-d2"]').attributes('title')).toBe('Revision 3 · Reply');
    expect(wrapper.text()).not.toContain('Revision');
    expect(wrapper.text()).not.toContain('revision');
    // A conflict on ANOTHER draft never labels this row.
    await wrapper.setProps({ conflict: true, activeRef: ref('d2') });
    const [first, second] = wrapper.findAll('[data-test="draft-list"] li');
    expect(first!.find('[data-test="draft-row-conflict"]').exists()).toBe(false);
    const word = second!.get('[data-test="draft-row-conflict"]');
    expect(word.text()).toBe('Conflict · revision 3');
    expect(word.classes()).toContain('tone-warn');
    await wrapper.setProps({ conflict: false });
    expect(wrapper.find('[data-test="draft-row-conflict"]').exists()).toBe(false);
  });

  it('opens a draft from its button or its row and reports the whole summary', async () => {
    wrapper = mountList();
    await wrapper.get('[data-test="open-draft-d1"]').trigger('click');
    expect(wrapper.emitted('open')).toEqual([[summary('d1')]]);
    // The row outside any control opens it too, like an Inbox row.
    await wrapper.findAll('.context-row')[1]!.trigger('click');
    expect(wrapper.emitted('open')![1]).toEqual([REPLY]);
    // Opening also makes the row the remembered one, so Back lands on it.
    expect(wrapper.emitted('update:activeKey')).toContainEqual(['acct-fixture:d1']);
    expect(wrapper.emitted('update:activeKey')!.at(-1)).toEqual(['acct-fixture:d2']);
  });

  it('moves between rows with J/K, arrows, Home and End on a roving tabindex, with aria-current on the current row', async () => {
    wrapper = mountList({ summaries: [summary('d1'), REPLY, summary('d3')] });
    const rows = wrapper.findAll('[data-drawer-row]');
    expect(rows.map((row) => row.attributes('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(wrapper.findAll('li').map((li) => li.attributes('aria-current'))).toEqual(['true', undefined, undefined]);
    (rows[0]!.element as HTMLElement).focus();
    await rows[0]!.trigger('keydown', { key: 'j' });
    expect(document.activeElement).toBe(rows[1]!.element);
    await rows[1]!.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[2]!.element);
    await rows[2]!.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[2]!.element);
    await rows[2]!.trigger('keydown', { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]!.element);
    await rows[0]!.trigger('keydown', { key: 'End' });
    expect(document.activeElement).toBe(rows[2]!.element);
    await rows[2]!.trigger('keydown', { key: 'k' });
    expect(document.activeElement).toBe(rows[1]!.element);
    expect(wrapper.findAll('li').map((li) => li.attributes('aria-current'))).toEqual([undefined, 'true', undefined]);
    expect(wrapper.emitted('open')).toBeUndefined();
  });

  it('restores the remembered current row and focuses it, or the pane when there is no row', async () => {
    wrapper = mountList({ activeKey: 'acct-fixture:d2' });
    expect(wrapper.findAll('[data-drawer-row]').map((row) => row.attributes('tabindex'))).toEqual(['-1', '0']);
    await (wrapper.vm as unknown as { focusRow(): Promise<void> }).focusRow();
    expect(document.activeElement).toBe(wrapper.get('[data-test="open-draft-d2"]').element);
    wrapper.unmount();
    wrapper = mountList({ summaries: [] });
    await (wrapper.vm as unknown as { focusRow(): Promise<void> }).focusRow();
    expect(document.activeElement).toBe(wrapper.get('[data-test="drafts-pane"]').element);
  });

  it('disables opening every row while the editor is closing or switching', async () => {
    wrapper = mountList({ busy: true });
    expect(wrapper.findAll('[data-drawer-row]').every((row) => row.attributes('disabled') !== undefined)).toBe(true);
    await wrapper.findAll('.context-row')[0]!.trigger('click');
    expect(wrapper.emitted('open')).toBeUndefined();
  });
});

describe('DraftsList in-flow alerts', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('shows no alert line without a problem', () => {
    wrapper = mountList();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="retry-close"]').exists()).toBe(false);
  });

  it('keeps every recovery and error line above the rows with the same hooks, texts and retry events', async () => {
    wrapper = mountList({
      suspendedEditor: true, closeError: 'close failed', closeSetupError: 'setup failed', closeRetryAvailable: true,
      listError: { kind: 'storage_unavailable' }, subscriptionError: { kind: 'storage_unavailable' },
    });
    expect(wrapper.get('[data-test="suspended-editor"]').attributes('role')).toBe('alert');
    expect(wrapper.get('[data-test="suspended-editor"]').text()).toContain('suspended in memory');
    expect(wrapper.get('[data-test="draft-close-error"]').text()).toBe('close failed');
    expect(wrapper.get('[data-test="draft-close-setup-error"]').text()).toContain('Close protection could not be initialized: setup failed');
    expect(wrapper.get('[data-test="draft-list-error"]').text()).toContain('Could not load drafts');
    expect(wrapper.get('[data-test="draft-subscription-error"]').text()).toContain('Draft change notifications are unavailable');
    // All of them sit above the coverage line and the rows.
    const html = wrapper.html();
    expect(html.indexOf('draft-subscription-error')).toBeLessThan(html.indexOf('drafts-coverage'));
    expect(html.indexOf('drafts-coverage')).toBeLessThan(html.indexOf('data-test="draft-list"'));
    await wrapper.get('[data-test="retry-close-setup"]').trigger('click');
    await wrapper.get('[data-test="retry-close"]').trigger('click');
    await wrapper.get('[data-test="retry-draft-subscription"]').trigger('click');
    expect(wrapper.emitted('retryCloseSetup')).toHaveLength(1);
    expect(wrapper.emitted('retryClose')).toHaveLength(1);
    expect(wrapper.emitted('retryDraftSubscription')).toHaveLength(1);
  });

  it('shows an open error above the rows and never hides the drafts behind it', () => {
    wrapper = mountList({ createError: { kind: 'storage_unavailable' } });
    expect(wrapper.get('[data-test="draft-open-error"]').attributes('role')).toBe('alert');
    expect(wrapper.findAll('[data-drawer-row]')).toHaveLength(2);
  });
});
