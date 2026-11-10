import type { ConversationSummary } from '../../src/lib/ipc/client';
import summaries from '../fixtures/newest-sender-summaries.json';
import { afterEach, describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import { flushPromises, type VueWrapper } from '@vue/test-utils';

import { useMailbox } from '../../src/composables/useMailbox';
import { matchesSplit, normalizeSplit, splitBadge } from '../../src/lib/saved-split';
import type { SavedSplit } from '../../src/lib/ipc/client';
import { createBrowserFakeMailClient, useGmailMode, mountApp } from '../helpers';

const definition = (value: string): SavedSplit => ({ name: 'Clients', criterion: 'sender', value, enabled: true, hideWhenEmpty: false });
let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

it('renders only exact totals 1…999, including the 0/1/999/1000 boundaries', () => {
  expect([null, 0, 1, 999, 1000].map(splitBadge)).toEqual([null, null, '1', '999', null]);
});

it('matches exact latest senders/domains, never names, recipients, or subdomains', async () => {
  const fake = createBrowserFakeMailClient();
  const row = (await fake.listConversations()).conversations[0]!;
  const mailbox = row.primaryCorrespondent!.mailbox;
  const split = normalizeSplit(definition(`  ${mailbox.toUpperCase()}  `));
  expect(matchesSplit(row, split)).toBe(true);
  expect(matchesSplit({ ...row, primaryCorrespondent: undefined }, split)).toBe(false);
  expect(matchesSplit({ ...row, primaryCorrespondent: { displayName: mailbox, mailbox: `prefix${mailbox}` } }, split)).toBe(false);
  const domain = { ...split, criterion: 'domain' as const, value: mailbox.split('@')[1]! };
  expect(matchesSplit(row, domain)).toBe(true);
  expect(matchesSplit({ ...row, primaryCorrespondent: { displayName: null, mailbox: `a@sub.${domain.value}` } }, domain)).toBe(false);
  expect(() => normalizeSplit({ ...domain, value: '@example.com' })).toThrow();
});

describe('saved view over the authoritative Inbox snapshot', () => {
  it('reuses archive/undo and isolates selection without changing membership on disable', async () => {
    const fake = createBrowserFakeMailClient();
    const scope = effectScope();
    const box = scope.run(() => useMailbox(fake))!;
    try {
      await box.ready;
      const target = box.conversations.value[0]!;
      expect(await box.saveSplit(definition(target.primaryCorrespondent!.mailbox))).toBe(true);
      const inboxCount = box.inboxTotal.value!;
      const splitCount = box.savedTotal.value!;
      expect(splitCount).toBeGreaterThan(0);
      box.toggleSelected(target.ref);
      await box.setContext('saved');
      expect(box.selectedRefs.value).toEqual([]);
      expect(box.conversations.value.every((row) => matchesSplit(row, box.savedSplit.value!))).toBe(true);
      const receipt = await box.setArchived(target.ref, true);
      expect(receipt).not.toBeNull();
      expect(box.savedTotal.value).toBe(splitCount - 1);
      expect(box.inboxTotal.value).toBe(inboxCount - 1);
      await box.undoLastAction();
      await fake.controls.flush();
      await box.refresh();
      expect(box.savedTotal.value).toBe(splitCount);
      expect(box.inboxTotal.value).toBe(inboxCount);
      await box.saveSplit({ ...box.savedSplit.value!, enabled: false });
      expect(box.context.value).toBe('inbox');
      expect(box.conversations.value).toHaveLength(inboxCount);
      expect((await fake.getSavedSplit(target.ref.accountId))?.enabled).toBe(false);
    } finally { scope.stop(); }
  });

  it('unread filter excludes unknowns, clears selection and leaves total badges unchanged', async () => {
    const fake = createBrowserFakeMailClient();
    useGmailMode(fake);
    const scope = effectScope();
    const box = scope.run(() => useMailbox(fake))!;
    try {
      await box.ready;
      const target = box.conversations.value[0]!;
      fake.controls.markReadUnknown(target.ref.conversationId);
      await box.refresh();
      box.toggleSelected(target.ref);
      await box.setUnreadOnly(true);
      expect(box.selectedRefs.value).toEqual([]);
      expect(box.inboxTotal.value).toBe(18);
      expect(box.conversations.value.length).toBeGreaterThan(0);
      expect(box.conversations.value.every((row) => row.isRead === false)).toBe(true);
      expect(box.conversations.value.some((row) => row.ref.conversationId === target.ref.conversationId)).toBe(false);
    } finally { scope.stop(); }
  });

  it('dispatches bulk archive from the saved context against exactly the selected rows', async () => {
    const fake = createBrowserFakeMailClient();
    const scope = effectScope();
    const box = scope.run(() => useMailbox(fake))!;
    try {
      await box.ready;
      await box.saveSplit(definition(box.conversations.value[0]!.primaryCorrespondent!.mailbox));
      await box.setContext('saved');
      const before = box.savedTotal.value!;
      const targets = box.conversations.value.slice(0, 2).map((row) => row.ref);
      targets.forEach(box.toggleSelected);
      expect(await box.setArchivedGroup(box.selectionInLoadedOrder(), true)).toBe(true);
      await fake.controls.flush();
      await box.refresh();
      expect(box.savedTotal.value).toBe(before - 2);
      expect(box.lastGroup.value?.members).toEqual(targets);
    } finally { scope.stop(); }
  });

  it('keeps mail intact on a rejected save and shows split-read failures instead of empty success', async () => {
    const fake = createBrowserFakeMailClient();
    const scope = effectScope();
    let failRead = false;
    const client = { ...fake, getSavedSplit: async (accountId: string) => {
      if (failRead) throw { kind: 'storage_unavailable' };
      return fake.getSavedSplit(accountId);
    } };
    const box = scope.run(() => useMailbox(client))!;
    try {
      await box.ready;
      expect(await box.saveSplit(definition('not an address'))).toBe(false);
      expect(box.splitError.value?.kind).toBe('invalid_request');
      expect((await fake.listConversations()).conversations).toHaveLength(18);
      expect(await box.saveSplit(definition(box.conversations.value[0]!.primaryCorrespondent!.mailbox))).toBe(true);
      await box.setContext('saved');
      failRead = true;
      await box.refresh();
      expect(box.listState.value).toBe('error');
      expect(box.splitError.value?.kind).toBe('storage_unavailable');
      expect(box.savedTotal.value).toBeNull();
      failRead = false;
      await box.refresh();
      expect(box.listState.value).toBe('ready');
    } finally { scope.stop(); }
  });

  it('does not publish a stale split read after changing context', async () => {
    const fake = createBrowserFakeMailClient();
    const row = (await fake.listConversations()).conversations[0]!;
    await fake.saveSavedSplit(row.ref.accountId, definition(row.primaryCorrespondent!.mailbox));
    const scope = effectScope();
    const box = scope.run(() => useMailbox(fake))!;
    try {
      await box.ready;
      const toSplit = box.setContext('saved');
      const toInbox = box.setContext('inbox');
      await Promise.all([toSplit, toInbox]);
      expect(box.context.value).toBe('inbox');
      expect(box.conversations.value).toHaveLength(18);
    } finally { scope.stop(); }
  });
});

it('edits a split, switches by pointer and nonwrapping Tab, restores reader context, and reaches hidden splits in Commands', async () => {
  const fake = createBrowserFakeMailClient();
  const first = (await fake.listConversations()).conversations[0]!;
  wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  await wrapper.get('[data-test="palette-trigger"]').trigger('click');
  await wrapper.get('[data-test="action-query"]').setValue('Create split');
  await wrapper.get('[data-test="action-query"]').trigger('keydown', { key: 'Enter' });
  await flushPromises();
  await wrapper.get('[data-test="split-name"]').setValue('Clients');
  await wrapper.get('[data-test="split-value"]').setValue(first.primaryCorrespondent!.mailbox);
  await wrapper.get('[data-test="split-save"]').trigger('submit');
  await flushPromises();
  expect(wrapper.get('[data-test="split-saved"]').text()).toContain('Clients');
  const initialTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  document.body.dispatchEvent(initialTab);
  expect(initialTab.defaultPrevented).toBe(false);
  expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Inbox');
  (wrapper.get('.inbox-row').element as HTMLElement).focus();
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  await flushPromises();
  expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Clients');
  const boundaryTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(boundaryTab);
  expect(boundaryTab.defaultPrevented).toBe(false);
  await flushPromises();
  expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Clients');
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flushPromises();
  expect(wrapper.find('.reader-subject').exists()).toBe(true);
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flushPromises();
  expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Clients');
  await wrapper.get('[data-test="split-inbox"]').trigger('click');
  await flushPromises();
  await fake.saveSavedSplit(first.ref.accountId, { ...definition('nobody@absent.test'), hideWhenEmpty: true });
  await flushPromises();
  expect(wrapper.find('[data-test="split-saved"]').exists()).toBe(false);
  await wrapper.get('[data-test="palette-trigger"]').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('Go to Clients');
  await wrapper.get('#action-saved').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Clients');
  expect(wrapper.get('[data-test="inbox-empty"]').text()).toContain('No Inbox conversations match');
  expect(document.activeElement).toBe(wrapper.get('[data-test="inbox-empty"]').element);
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  await flushPromises();
  expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Inbox');
});

it('projects actual native provider/cache summaries, not the older renderable sender or recipients', () => {
  // Rust newest_sender_provider_storage_and_membership_wire_contract asserts
  // this exact wire fixture against provider parsing, storage and list results.
  const [bob, unknown] = summaries as ConversationSummary[];
  const rule = (criterion: SavedSplit['criterion'], value: string): SavedSplit => ({
    name: 'Clients', enabled: true, hideWhenEmpty: false, criterion, value,
  });
  for (const [criterion, newest, older] of [
    ['sender', 'bob@new.test', 'alice@old.test'],
    ['domain', 'new.test', 'old.test'],
  ] as const) {
    expect(matchesSplit(bob!, rule(criterion, newest))).toBe(true);
    expect(matchesSplit(bob!, rule(criterion, older))).toBe(false);
    expect(matchesSplit(unknown!, rule(criterion, newest))).toBe(false);
    expect(matchesSplit(unknown!, rule(criterion, older))).toBe(false);
  }
});
