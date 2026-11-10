/**
 * Recipient affordance tests (TASK C): the drafts-drawer composer shows a
 * human-readable "Reply draft to {recipient}" heading for reply drafts, and the
 * contact pane stays exactly as it is while a reply editor is active (no
 * "Composing to …" line: it pushed the pinned name and email off their lines,
 * and the reply heading already names the recipient). Plain-text
 * interpolation; no raw IDs replace the label, and
 * the fixed reply source is exposed as data attributes only (never as text).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

import DraftsPanel from '../../src/components/DraftsPanel.vue';
import ContactPane, { type ContactInfo } from '../../src/components/ContactPane.vue';
import type { DraftContent, DraftSource, MailClient } from '../../src/lib/ipc/client';
import { closeUtilityDrawer, createBrowserFakeMailClient, fixtureRef, waitFor, type BrowserFake, mountApp as sharedMountApp } from '../helpers';

const REPLY_SOURCE: DraftSource = { kind: 'reply', conversation: fixtureRef('conv-01'), sourceMessageId: 'conv-01-m3' };
const CONTENT: DraftContent = { to: 'ada@example.test', cc: '', subject: 'Re: Fixture thread 1: weekly status', bodyText: '' };
const ADA: ContactInfo = { displayName: 'Ada Fixture', mailbox: 'ada@example.test' };

function mountPanel(overrides: Record<string, unknown> = {}): VueWrapper {
  return mount(DraftsPanel, {
    props: {
      summaries: [],
      activeRef: { accountId: 'acct-fixture', draftId: 'draft-1' },
      source: REPLY_SOURCE,
      content: CONTENT,
      status: '',
      visible: true,
      suspendedEditor: false,
      creating: false,
      saving: false,
      conflict: false,
      error: null,
      createError: null,
      deleting: false,
      closing: false,
      transitioning: false,
      deletePending: false,
      confirmDiscard: false,
      discardBusy: false,
      confirmReload: false,
      copyPending: false,
      recoveryRequired: false,
      canCancelReplyPreparation: false,
      listError: null,
      subscriptionError: null,
      closeError: null,
      closeRetryAvailable: false,
      closeSetupError: null,
      ...overrides,
    },
  });
}

describe('DraftsPanel reply recipient label', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('names the reply target once, in the editor heading, exposing the reply source only as data attributes', () => {
    wrapper = mountPanel({ recipientLabel: 'Ada Fixture' });
    const label = wrapper.get('[data-test="draft-recipient-label"]');
    expect(label.text()).toBe('Ada Fixture');
    // The separate "Draft to" flag line duplicated the heading and is gone.
    expect(wrapper.find('strong.draft-flag').exists()).toBe(false);
    expect(wrapper.find('.draft-recipient').exists()).toBe(false);
    const heading = wrapper.get('.composer-heading h3');
    expect(heading.text()).toBe('Reply draft to Ada Fixture');
    expect(heading.element.contains(label.element)).toBe(true);
    // The drawer owns the one h2; the editor heading is a sub-section.
    expect(wrapper.find('h2').exists()).toBe(false);
    // Raw provider IDs are attributes for tools and tests; they are never visible text.
    const source = wrapper.get('[data-test="reply-source"]');
    expect(source.attributes('data-source-conversation')).toBe('conv-01');
    expect(source.attributes('data-source-message')).toBe('conv-01-m3');
    expect(source.text()).toBe('');
    expect(wrapper.text()).not.toContain('conv-01');
    expect(wrapper.html()).not.toMatch(/(?:title|aria-[a-z]+)="[^"]*conv-01/);
  });

  it('renders no recipient label without recipientLabel, keeping the reply-source attributes', () => {
    wrapper = mountPanel();
    expect(wrapper.get('.composer-heading h3').text()).toBe('Reply draft');
    expect(wrapper.find('[data-test="draft-recipient-label"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="reply-source"]').exists()).toBe(true);
  });

  it('renders no recipient label for a non-reply source even when recipientLabel is set', () => {
    wrapper = mountPanel({ source: { kind: 'new_message' }, recipientLabel: 'Ada Fixture' });
    expect(wrapper.find('[data-test="draft-recipient-label"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="reply-source"]').exists()).toBe(false);
  });
});

describe('ContactPane while a reply editor is active', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('has no compose line: the identity block is the first thing after the hidden heading, so the pinned lines never move', () => {
    wrapper = mount(ContactPane, { props: { contact: ADA, context: 'open' } });
    expect(wrapper.find('[data-test="compose-target"]').exists()).toBe(false);
    expect(wrapper.find('.compose-target').exists()).toBe(false);
    const children = [...wrapper.get('[data-test="contact-pane"]').element.children];
    expect(children[0]?.tagName).toBe('H2');
    expect(children[0]?.classList.contains('visually-hidden')).toBe(true);
    expect(children[1]?.getAttribute('data-test')).toBe('contact-identity');
    expect(wrapper.get('[data-test="contact-mailbox"]').text()).toBe('ada@example.test');
    expect(wrapper.find('[data-test="contact-unknown"]').exists()).toBe(false);
  });
});

describe('App wiring: drawer label and contact-pane compose context for an active reply editor', () => {
  let wrapper: VueWrapper | null = null;

  async function mountDraftsDrawer(fake: BrowserFake, client: MailClient = fake): Promise<VueWrapper> {
    const mounted = sharedMountApp(client, 'browser-preview', { attachTo: document.body });
    wrapper = mounted;
    await flushPromises();
    await mounted.find('[data-test="rail-drafts"]').trigger('click');
    await waitFor(() => mounted.find('[data-test="drafts-pane"]').exists());
    await flushPromises();
    return mounted;
  }

  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('shows "Draft to <sender>" in the inline reply composer and leaves the contact pane unchanged after preparing a reply (reader stays open)', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountDraftsDrawer(fake);
    if (w.find('[data-test="drawer-close"]').exists()) await closeUtilityDrawer(w);
    await w.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="prepare-reply"]').trigger('click');
    await flushPromises();
    await waitFor(() => w.find('[data-test="reply-composer"]').exists());
    await flushPromises();
    // The reader stays open on the reply source, so the latest sender names the target.
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(false);
    // The compact heading replaces the old "Draft" flag; the status line says it is not sent.
    expect(w.find('[data-test="reply-composer"] [data-test="draft-flag"]').exists()).toBe(false);
    expect(w.get('[data-test="draft-recipient-label"]').text()).toBe('Ada Fixture');
    expect(w.get('[data-test="reply-source"]').attributes('data-source-message')).toBe('conv-01-m3');
    // The contact pane keeps its pinned lines: no "Composing to" line is inserted above them.
    expect(w.find('[data-test="compose-target"]').exists()).toBe(false);
    expect(w.get('[data-test="contact-pane"]').text()).not.toContain('Composing to');
    expect(w.get('[data-test="contact-name"]').text()).toBe('Ada Fixture');
  });

  it('prefers the open source conversation latest sender ("Ada Fixture") while the reader is open on the reply source', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountDraftsDrawer(fake);
    if (w.find('[data-test="drawer-close"]').exists()) await closeUtilityDrawer(w);
    await w.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    // Seed a reply draft for the open conversation, then reopen the drafts surface.
    await fake.createDraft({
      requestId: 'seed-recipient-label',
      source: REPLY_SOURCE,
      initialContent: null,
    });
    await flushPromises();
    await w.find('[data-test="rail-drafts"]').trigger('click');
    await waitFor(() => w.find('[data-test="drafts-pane"]').exists());
    await flushPromises();
    const summary = (await fake.listDrafts())[0]!;
    await w.find(`[data-test="open-draft-${summary.ref.draftId}"]`).trigger('click');
    await flushPromises();
    // Reader is open on conv-01, so the reply editor docks in the reader and the
    // drawer closes; the latest message sender wins over the raw To text.
    await waitFor(() => w.find('[data-test="reply-composer"]').exists());
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(false);
    const latest = (await fake.getConversation(fixtureRef('conv-01'))).messages.at(-1)!;
    expect(latest.from.displayName).toBe('Ada Fixture');
    const label = w.get('[data-test="draft-recipient-label"]');
    expect(label.text()).toBe('Ada Fixture');
    expect(w.find('[data-test="compose-target"]').exists()).toBe(false);
  });

  it('shows no compose-target line in the contact pane when no reply editor is active', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountDraftsDrawer(fake);
    expect(w.find('[data-test="compose-target"]').exists()).toBe(false);
    expect(w.find('[data-test="draft-recipient-label"]').exists()).toBe(false);
    await w.find('[data-test="new-draft"]').trigger('click');
    await flushPromises();
    await waitFor(() => w.find('[data-test="composer"]').exists());
    // A new-message editor is not a reply: no recipient label, no compose context.
    expect(w.find('[data-test="draft-recipient-label"]').exists()).toBe(false);
    expect(w.find('[data-test="compose-target"]').exists()).toBe(false);
  });
});
