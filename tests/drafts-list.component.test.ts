/**
 * DraftsList (the Drafts list context): non-thread rows on ContextRowList, one
 * Ash coverage line with the quiet New draft action, the in-flow recovery and
 * error lines, and the keyboard model. It only lists drafts and reports which
 * one was chosen; opening is the app's decision (see drafts.context.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import DraftsList from '../src/components/DraftsList.vue';
import { compactDateLabel, fullDateLabel } from '../src/lib/browsing-dates';
import type { DraftRef, DraftSummary, MailError } from '../src/lib/ipc/client';
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

describe('DraftsList body preview', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });
  const bodies: Record<string, string> = {};
  const loadBody = (draftRef: DraftRef) => Promise.resolve(bodies[draftRef.draftId] ?? '');
  const previews = () => wrapper!.findAll('[data-test="draft-preview"]');

  it('shows nothing invented: no preview without a body loader, and none for a body that could not be read', async () => {
    wrapper = mountList();
    await flushPromises();
    expect(previews()).toHaveLength(0);
    wrapper.unmount();
    wrapper = mountList({ loadBody: () => Promise.reject(new Error('read failed')) });
    await flushPromises();
    expect(previews()).toHaveLength(0);
    expect(wrapper.findAll('.draft-subject')).toHaveLength(2);
  });

  it('puts the body after the subject as one Ash line of plain text with whitespace collapsed', async () => {
    bodies.d1 = '  Hello\n\n   Ada,\t\tship it  ';
    wrapper = mountList({ summaries: [summary('d1')], loadBody });
    await flushPromises();
    const preview = wrapper.get('.context-row-secondary [data-test="draft-preview"]');
    expect(preview.text()).toBe('Hello Ada, ship it');
    expect(preview.classes()).not.toContain('drawer-empty');
    expect(preview.element.previousElementSibling?.classList.contains('draft-subject')).toBe(true);
  });

  it('keeps text that looks like HTML literal: no element is created and no attribute runs', async () => {
    bodies.d1 = '<img src=x onerror="alert(1)"> <b>bold</b> &amp; <script>alert(2)</script>';
    wrapper = mountList({ summaries: [summary('d1')], loadBody });
    await flushPromises();
    const preview = wrapper.get('[data-test="draft-preview"]');
    expect(preview.text()).toBe('<img src=x onerror="alert(1)"> <b>bold</b> &amp; <script>alert(2)</script>');
    expect(preview.element.children).toHaveLength(0);
    expect(wrapper.find('.context-row img, .context-row b, .context-row script').exists()).toBe(false);
  });

  it('caps a very long body in memory and leaves the one-line clip to CSS', async () => {
    bodies.d1 = 'word '.repeat(2000);
    wrapper = mountList({ summaries: [summary('d1')], loadBody });
    await flushPromises();
    const text = wrapper.get('[data-test="draft-preview"]').text();
    expect(text.length).toBeLessThanOrEqual(240);
    expect(text.startsWith('word word')).toBe(true);
  });

  it('says "No text yet" in Ash for an empty or whitespace-only body', async () => {
    bodies.d1 = ' \n\t ';
    bodies.d2 = '';
    wrapper = mountList({ loadBody });
    await flushPromises();
    expect(previews().map((preview) => preview.text())).toEqual(['No text yet', 'No text yet']);
    expect(previews().every((preview) => preview.classes().includes('drawer-empty'))).toBe(true);
  });

  it('reads each body once per revision: an unchanged list is not read again, a new revision is', async () => {
    bodies.d1 = 'first';
    let reads = 0;
    const counting = (draftRef: DraftRef) => { reads += 1; return loadBody(draftRef); };
    wrapper = mountList({ summaries: [summary('d1')], loadBody: counting });
    await flushPromises();
    expect(reads).toBe(1);
    await wrapper.setProps({ summaries: [summary('d1')] });
    await flushPromises();
    expect(reads).toBe(1);
    bodies.d1 = 'second';
    await wrapper.setProps({ summaries: [summary('d1', { revision: 4 })] });
    await flushPromises();
    expect(reads).toBe(2);
    expect(wrapper.get('[data-test="draft-preview"]').text()).toBe('second');
  });
});

describe('DraftsList Discard', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });
  const three = [summary('d1'), summary('d2', { subject: 'Two' }), summary('d3', { subject: 'Three' })];
  const discardBtn = (id: string) => wrapper!.get(`[data-test="draft-row-${id}"] [data-test="discard-draft"]`);
  const rowButton = (id: string) => wrapper!.get(`[data-test="open-draft-${id}"]`).element;
  const status = () => wrapper!.get('[data-test="draft-discard-status"]');

  /** A discard that, like the app, deletes the draft and lets the list refresh before it resolves. */
  function deleting(result: MailError | null = null) {
    const calls: Array<{ draftId: string; revision: number; requestId: string }> = [];
    const discardDraft = async (draft: DraftSummary, requestId: string): Promise<MailError | null> => {
      calls.push({ draftId: draft.ref.draftId, revision: draft.revision, requestId });
      if (result) return result;
      await wrapper!.setProps({ summaries: (wrapper!.props() as { summaries: DraftSummary[] }).summaries.filter((item) => item.ref.draftId !== draft.ref.draftId) });
      return null;
    };
    return { calls, discardDraft };
  }

  it('offers no Discard without a discard handler', () => {
    wrapper = mountList();
    expect(wrapper.find('[data-test="discard-draft"]').exists()).toBe(false);
  });

  it('is a quiet inline ghost on every row, named for its draft, in the Tab order and revealed on the current row', () => {
    wrapper = mountList({ summaries: three, discardDraft: deleting().discardDraft });
    expect(wrapper.findAll('[data-test="discard-draft"]')).toHaveLength(3);
    const button = discardBtn('d1');
    expect(button.text()).toBe('Discard');
    expect(button.classes()).toContain('drawer-quiet');
    expect(button.attributes('aria-label')).toBe('Discard draft ada@example.test');
    expect(button.attributes('tabindex')).toBeUndefined();
    expect(button.element.closest('.context-row-actions')).not.toBeNull();
    expect(wrapper.get('[data-test="draft-row-d1"] .context-row').classes()).toContain('focused');
    // A draft with neither recipient nor subject is still named.
    wrapper.unmount();
    wrapper = mountList({ summaries: [REPLY], discardDraft: deleting().discardDraft });
    expect(discardBtn('d2').attributes('aria-label')).toBe('Discard draft with no recipient or subject');
  });

  it('asks first: nothing is deleted until the confirmation is confirmed, and focus enters it', async () => {
    const { calls, discardDraft } = deleting();
    wrapper = mountList({ summaries: three, discardDraft });
    await discardBtn('d2').trigger('click');
    await flushPromises();
    const confirm = wrapper.get('[data-test="draft-discard-confirm"]');
    expect(confirm.attributes('role')).toBe('alertdialog');
    expect(confirm.text()).toContain('Discard this local draft? This cannot be undone.');
    expect(confirm.element.closest('[data-test="draft-row-d2"]')).not.toBeNull();
    expect(document.activeElement).toBe(wrapper.get('[data-test="confirm-discard-draft"]').element);
    expect(calls).toHaveLength(0);
    expect(wrapper.findAll('[data-drawer-row]')).toHaveLength(3);
  });

  it('cancels with Keep draft or Escape, deletes nothing, returns focus to Discard, and keeps Escape from also running Back', async () => {
    const { calls, discardDraft } = deleting();
    wrapper = mountList({ summaries: three, discardDraft });
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    await discardBtn('d2').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="cancel-discard-draft"]').trigger('click'); await flushPromises();
    expect(wrapper.find('[data-test="draft-discard-confirm"]').exists()).toBe(false);
    expect(document.activeElement).toBe(discardBtn('d2').element);
    await discardBtn('d2').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('keydown', { key: 'Escape' }); await flushPromises();
    expect(wrapper.find('[data-test="draft-discard-confirm"]').exists()).toBe(false);
    expect(document.activeElement).toBe(discardBtn('d2').element);
    expect(outside).not.toHaveBeenCalled();
    window.removeEventListener('keydown', outside);
    expect(calls).toHaveLength(0);
    expect(wrapper.findAll('[data-drawer-row]')).toHaveLength(3);
    expect(status().text()).toBe('');
  });

  it('discards the confirmed draft, announces "Local draft deleted" and moves focus to the next row', async () => {
    const { calls, discardDraft } = deleting();
    wrapper = mountList({ summaries: three, discardDraft });
    await discardBtn('d2').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.draftId).toBe('d2');
    expect(calls[0]!.requestId).toMatch(/\S/);
    expect(wrapper.findAll('[data-drawer-row]').map((row) => row.attributes('data-drawer-row'))).toEqual(['acct-fixture:d1', 'acct-fixture:d3']);
    expect(status().attributes('role')).toBe('status');
    expect(status().attributes('aria-live')).toBe('polite');
    expect(status().text()).toBe('Local draft deleted');
    expect(document.activeElement).toBe(rowButton('d3'));
    expect(wrapper.emitted('update:activeKey')!.at(-1)).toEqual(['acct-fixture:d3']);
  });

  it('moves focus to the previous row when the last row is discarded, and to the pane when none is left', async () => {
    const { discardDraft } = deleting();
    wrapper = mountList({ summaries: [summary('d1'), summary('d2')], discardDraft });
    await discardBtn('d2').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    expect(document.activeElement).toBe(rowButton('d1'));
    await discardBtn('d1').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-test="draft-list-empty"]').text()).toBe('No local drafts.');
    expect(document.activeElement).toBe(wrapper.get('[data-test="drafts-pane"]').element);
    expect(status().text()).toBe('Local draft deleted');
  });

  it('keeps the draft and the failure visible when the delete is not confirmed, and retries with the same request id', async () => {
    const { calls, discardDraft } = deleting({ kind: 'storage_unavailable' });
    wrapper = mountList({ summaries: three, discardDraft });
    await discardBtn('d2').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-test="draft-discard-error"]').attributes('role')).toBe('alert');
    expect(wrapper.get('[data-test="draft-discard-error"]').text()).toBe('Draft not discarded: local storage did not confirm the delete. Retry is safe.');
    expect(wrapper.findAll('[data-drawer-row]')).toHaveLength(3);
    expect(status().text()).toBe('');
    // The confirmation stays so Retry is one press; the same request is repeated.
    expect(wrapper.find('[data-test="draft-discard-confirm"]').exists()).toBe(true);
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.requestId).toBe(calls[0]!.requestId);
  });

  it('closes the confirmation on a definite rejection, keeps the draft, says why and returns focus to Discard', async () => {
    const { discardDraft } = deleting({ kind: 'draft_conflict', currentRevision: 7 });
    wrapper = mountList({ summaries: three, discardDraft });
    await discardBtn('d2').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-test="draft-discard-error"]').text()).toBe('Draft not discarded: it changed to revision 7. Open it to review.');
    expect(wrapper.find('[data-test="draft-discard-confirm"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-drawer-row]')).toHaveLength(3);
    expect(document.activeElement).toBe(discardBtn('d2').element);
  });

  it('cannot discard a draft that is open in the editor, and not while the editor is busy', async () => {
    wrapper = mountList({ summaries: three, discardDraft: deleting().discardDraft, activeRef: ref('d2') });
    expect(discardBtn('d2').attributes('disabled')).toBeDefined();
    expect(discardBtn('d2').attributes('title')).toBe('This draft is open in an editor');
    expect(discardBtn('d1').attributes('disabled')).toBeUndefined();
    await wrapper.setProps({ busy: true });
    expect(discardBtn('d1').attributes('disabled')).toBeDefined();
  });

  it('titles Discard with both of its keys, matching aria-keyshortcuts', () => {
    wrapper = mountList({ summaries: three, discardDraft: deleting().discardDraft });
    expect(discardBtn('d1').attributes('title')).toBe('Discard this local draft — Delete or Backspace');
    expect(discardBtn('d1').attributes('aria-keyshortcuts')).toBe('Delete Backspace');
  });

  it('cannot discard a draft that is being opened, by button or by key, and says so', async () => {
    const { calls, discardDraft } = deleting();
    wrapper = mountList({ summaries: three, discardDraft, openingRefs: [ref('d2')] });
    expect(discardBtn('d2').attributes('disabled')).toBeDefined();
    expect(discardBtn('d2').attributes('title')).toBe('This draft is being opened');
    expect(discardBtn('d1').attributes('disabled')).toBeUndefined();
    expect((wrapper.vm as unknown as { discardRow(key: string): boolean }).discardRow('acct-fixture:d2')).toBe(false);
    expect(wrapper.find('[data-test="draft-discard-confirm"]').exists()).toBe(false);
    await wrapper.setProps({ openingRefs: [] });
    expect(discardBtn('d2').attributes('disabled')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('does not open the row whose delete is running, keeps it focusable, and opens it again once the delete fails', async () => {
    let finish: (value: MailError | null) => void = () => {};
    const discardDraft = vi.fn(() => new Promise<MailError | null>((resolve) => { finish = resolve; }));
    wrapper = mountList({ summaries: three, discardDraft });
    await discardBtn('d2').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    const open = wrapper.get('[data-test="open-draft-d2"]');
    expect(open.attributes('aria-disabled')).toBe('true');
    expect(open.attributes('disabled')).toBeUndefined();
    await open.trigger('click');
    await wrapper.get('[data-test="draft-row-d2"] .context-row').trigger('click');
    expect(wrapper.emitted('open')).toBeUndefined();
    // Another row is not affected.
    await wrapper.get('[data-test="open-draft-d1"]').trigger('click');
    expect(wrapper.emitted('open')).toHaveLength(1);
    finish({ kind: 'storage_unavailable' }); await flushPromises();
    expect(wrapper.get('[data-test="open-draft-d2"]').attributes('aria-disabled')).toBeUndefined();
    await wrapper.get('[data-test="open-draft-d2"]').trigger('click');
    expect(wrapper.emitted('open')).toHaveLength(2);
  });

  describe('failure wording', () => {
    async function failWith(error: MailError, props: Record<string, unknown> = {}): Promise<string> {
      wrapper = mountList({ summaries: three, discardDraft: deleting(error).discardDraft, ...props });
      await discardBtn('d2').trigger('click'); await flushPromises();
      // Props can change while the request runs (the editor starts opening or closing meanwhile).
      await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
      return wrapper.get('[data-test="draft-discard-error"]').text();
    }

    it('says something specific, and closes the confirmation, for invalid_request and request_id_conflict', async () => {
      expect(await failWith({ kind: 'invalid_request', field: 'ref' })).toBe('Draft not discarded: the delete request was invalid.');
      expect(wrapper!.find('[data-test="draft-discard-confirm"]').exists()).toBe(false);
      wrapper!.unmount();
      expect(await failWith({ kind: 'request_id_conflict' })).toBe('Draft not discarded: the delete request conflicted with an earlier one. Discard again to retry.');
      expect(wrapper!.find('[data-test="draft-discard-confirm"]').exists()).toBe(false);
    });

    it('keeps the retry wording only for failures that are retryable', async () => {
      expect(await failWith({ kind: 'outcome_unknown' })).toBe('Draft not discarded: the local delete was not confirmed. Retry is safe.');
      expect(wrapper!.find('[data-test="draft-discard-confirm"]').exists()).toBe(true);
    });

    it('gives busy an honest reason: opening, switching, window closing', async () => {
      const busy: MailError = { kind: 'busy' };
      let finish: (value: MailError | null) => void = () => {};
      const discardDraft = () => new Promise<MailError | null>((resolve) => { finish = resolve; });
      wrapper = mountList({ summaries: three, discardDraft });
      const text = async (patch: Record<string, unknown>): Promise<string> => {
        await discardBtn('d2').trigger('click'); await flushPromises();
        await wrapper!.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
        await wrapper!.setProps(patch);
        finish(busy); await flushPromises();
        const message = wrapper!.get('[data-test="draft-discard-error"]').text();
        await wrapper!.setProps({ busy: false, closingForWindow: false, openingRefs: [], activeRef: null });
        return message;
      };
      expect(await text({ activeRef: ref('d2') })).toBe('Draft not discarded: it is open in an editor. Close the editor first.');
      expect(await text({ openingRefs: [ref('d2')] })).toBe('Draft not discarded: it is being opened. Close the editor once it has opened.');
      expect(await text({ busy: true })).toBe('Draft not discarded: the editor is switching drafts. Try again in a moment.');
      expect(await text({ busy: true, closingForWindow: true })).toBe('Draft not discarded: the window is closing.');
    });
  });

  it('disables a pending confirmation when its draft opens in the editor', async () => {
    const { calls, discardDraft } = deleting();
    wrapper = mountList({ summaries: three, discardDraft });
    await discardBtn('d2').trigger('click'); await flushPromises();
    await wrapper.setProps({ activeRef: ref('d2') });
    expect(wrapper.get('[data-test="confirm-discard-draft"]').attributes('aria-disabled')).toBe('true');
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click');
    expect(calls).toHaveLength(0);
  });

  it('sends the draft and revision the confirmation was opened for, not a newer refresh of the row', async () => {
    const { calls, discardDraft } = deleting({ kind: 'draft_conflict', currentRevision: 4 });
    wrapper = mountList({ summaries: three, discardDraft });
    await discardBtn('d2').trigger('click'); await flushPromises();
    // The row refreshes to revision 4 while the revision-3 confirmation is open.
    await wrapper.setProps({ summaries: [three[0]!, summary('d2', { subject: 'Two', revision: 4 }), three[2]!] });
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    expect(calls).toEqual([{ draftId: 'd2', revision: 3, requestId: expect.any(String) }]);
  });

  it('repeats the frozen envelope on retry: same revision and same request id', async () => {
    const { calls, discardDraft } = deleting({ kind: 'storage_unavailable' });
    wrapper = mountList({ summaries: three, discardDraft });
    await discardBtn('d2').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    await wrapper.setProps({ summaries: [three[0]!, summary('d2', { subject: 'Two', revision: 4 }), three[2]!] });
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1]!.revision).toBe(3);
  });

  it('keeps the confirmation buttons focusable (aria-disabled, not disabled) while the request runs', async () => {
    let finish: (value: MailError | null) => void = () => {};
    const discardDraft = vi.fn(() => new Promise<MailError | null>((resolve) => { finish = resolve; }));
    wrapper = mountList({ summaries: three, discardDraft });
    await discardBtn('d2').trigger('click'); await flushPromises();
    const confirm = wrapper.get('[data-test="confirm-discard-draft"]');
    const cancel = wrapper.get('[data-test="cancel-discard-draft"]');
    (confirm.element as HTMLElement).focus();
    await confirm.trigger('click'); await flushPromises();
    for (const button of [confirm, cancel]) {
      expect(button.attributes('aria-disabled')).toBe('true');
      expect(button.attributes('disabled')).toBeUndefined();
    }
    expect(document.activeElement).toBe(confirm.element);
    // A second press and Keep draft do nothing while the request runs.
    await confirm.trigger('click'); await cancel.trigger('click'); await flushPromises();
    expect(wrapper.find('[data-test="draft-discard-confirm"]').exists()).toBe(true);
    expect(discardDraft).toHaveBeenCalledTimes(1);
    finish({ kind: 'storage_unavailable' }); await flushPromises();
    expect(confirm.attributes('aria-disabled')).toBeUndefined();
  });

  it('keeps focus in the confirmation after a retryable failure, so Escape closes it and does not run Back', async () => {
    const { discardDraft } = deleting({ kind: 'storage_unavailable' });
    wrapper = mountList({ summaries: three, discardDraft });
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    await discardBtn('d2').trigger('click'); await flushPromises();
    const confirm = wrapper.get('[data-test="confirm-discard-draft"]');
    await confirm.trigger('click'); await flushPromises();
    expect(wrapper.find('[data-test="draft-discard-confirm"]').exists()).toBe(true);
    expect(document.activeElement).toBe(confirm.element);
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(wrapper.find('[data-test="draft-discard-confirm"]').exists()).toBe(false);
    expect(document.activeElement).toBe(discardBtn('d2').element);
    expect(outside).not.toHaveBeenCalled();
    window.removeEventListener('keydown', outside);
  });

  it('restores focus to the confirmation after a retryable failure even when the button lost it', async () => {
    const { discardDraft } = deleting({ kind: 'storage_unavailable' });
    wrapper = mountList({ summaries: three, discardDraft });
    await discardBtn('d2').trigger('click'); await flushPromises();
    const confirm = wrapper.get('[data-test="confirm-discard-draft"]');
    (document.activeElement as HTMLElement).blur();
    await confirm.trigger('click'); await flushPromises();
    expect(document.activeElement).toBe(confirm.element);
  });

  it('returns focus to Discard after Keep draft pressed as a button, with the focus on that button', async () => {
    wrapper = mountList({ summaries: three, discardDraft: deleting().discardDraft });
    await discardBtn('d2').trigger('click'); await flushPromises();
    const keep = wrapper.get('[data-test="cancel-discard-draft"]');
    (keep.element as HTMLElement).focus();
    await keep.trigger('click'); await flushPromises();
    expect(document.activeElement).toBe(discardBtn('d2').element);
  });

  it('does not take focus back from elsewhere in the page once the result arrives', async () => {
    let finish: (value: MailError | null) => void = () => {};
    const discardDraft = () => new Promise<MailError | null>((resolve) => { finish = resolve; });
    wrapper = mountList({ summaries: three, discardDraft });
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    await discardBtn('d2').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click');
    elsewhere.focus();
    finish({ kind: 'storage_unavailable' }); await flushPromises();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('leaves focus on another row inside the pane when a retryable failure arrives', async () => {
    let finish: (value: MailError | null) => void = () => {};
    const discardDraft = () => new Promise<MailError | null>((resolve) => { finish = resolve; });
    wrapper = mountList({ summaries: three, discardDraft });
    await discardBtn('d2').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click');
    (rowButton('d3') as HTMLElement).focus();
    expect(document.activeElement).toBe(rowButton('d3'));
    finish({ kind: 'storage_unavailable' }); await flushPromises();
    expect(wrapper.find('[data-test="draft-discard-confirm"]').exists()).toBe(true);
    expect(document.activeElement).toBe(rowButton('d3'));
  });

  it('keeps the outcome line as a live region that is visually hidden, so it never pushes rows down', async () => {
    const { discardDraft } = deleting();
    wrapper = mountList({ summaries: three, discardDraft });
    expect(status().classes()).toContain('visually-hidden');
    expect(status().attributes('aria-live')).toBe('polite');
    await discardBtn('d2').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    expect(status().classes()).toContain('visually-hidden');
    expect(status().text()).toBe('Local draft deleted');
  });
});

describe('DraftsList row description', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });
  const describedBy = (id: string) => wrapper!.get(`[data-test="open-draft-${id}"]`).attributes('aria-describedby')!.split(' ');
  const text = (ids: string[]) => ids.map((id) => document.getElementById(id)!.textContent?.trim());

  it('describes the row button by subject, preview and the Reply word, with unique ids', async () => {
    wrapper = mountList({ loadBody: async (r: DraftRef) => r.draftId === 'd1' ? 'Hello Ada' : '' });
    await flushPromises();
    expect(text(describedBy('d1'))).toEqual(['Plan', 'Hello Ada']);
    expect(text(describedBy('d2'))).toEqual(['(no subject)', 'No text yet', 'Reply']);
    const all = [...describedBy('d1'), ...describedBy('d2')];
    expect(new Set(all).size).toBe(all.length);
    expect(wrapper.get('[data-test="open-draft-d1"]').text()).toBe('Open ada@example.test');
  });

  it('omits the preview while the body is unknown and adds the Conflict word only for the draft in conflict', async () => {
    wrapper = mountList({ summaries: [summary('d1'), summary('d3')] });
    await flushPromises();
    expect(text(describedBy('d1'))).toEqual(['Plan']);
    await wrapper.setProps({ conflict: true, activeRef: ref('d3') });
    expect(text(describedBy('d3'))).toEqual(['Plan', 'Conflict · revision 3']);
    expect(text(describedBy('d1'))).toEqual(['Plan']);
  });
});
