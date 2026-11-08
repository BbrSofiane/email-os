/**
 * Recipient affordance tests (TASK C): the drafts-drawer composer shows a
 * human-readable "Draft to {recipient}" label for reply drafts, and the
 * contact pane shows a "Composing to …" context line while a reply editor is
 * active. Both are plain-text interpolation; no raw IDs replace the label, and
 * the fixed reply source is exposed as data attributes only (never as text).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import DraftsPanel from '../src/components/DraftsPanel.vue';
import ContactPane, { type ContactInfo } from '../src/components/ContactPane.vue';
import type { DraftContent, DraftSource, MailClient } from '../src/lib/ipc/client';
import {
  closeUtilityDrawer,
  createBrowserFakeMailClient,
  fixtureRef,
  waitFor,
  type BrowserFake,
} from './helpers';

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

  it('renders "Draft to <name>" with an accent flag for a reply source with recipientLabel, exposing the reply source only as data attributes', () => {
    wrapper = mountPanel({ recipientLabel: 'Ada Fixture' });
    const label = wrapper.get('[data-test="draft-recipient-label"]');
    expect(label.classes()).toContain('draft-recipient');
    expect(label.text()).toContain('Draft');
    expect(label.text()).toContain('to Ada Fixture');
    const flag = label.get('strong.draft-flag');
    expect(flag.text()).toBe('Draft');
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
    expect(wrapper.find('[data-test="draft-recipient-label"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="reply-source"]').exists()).toBe(true);
  });

  it('renders no recipient label for a non-reply source even when recipientLabel is set', () => {
    wrapper = mountPanel({ source: { kind: 'new_message' }, recipientLabel: 'Ada Fixture' });
    expect(wrapper.find('[data-test="draft-recipient-label"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="reply-source"]').exists()).toBe(false);
  });
});

describe('ContactPane compose target context', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('renders "Composing to <name> <mailbox>" at the top of the pane when composeTarget is set', () => {
    wrapper = mount(ContactPane, { props: { contact: ADA, context: 'open', composeTarget: ADA } });
    const line = wrapper.get('[data-test="compose-target"]');
    expect(line.classes()).toContain('compose-target');
    expect(line.text()).toContain('Composing to Ada Fixture');
    expect(line.get('.compose-target-mail').text()).toBe('ada@example.test');
    // The rest of the pane is unchanged.
    expect(wrapper.find('[data-test="contact-identity"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="contact-mailbox"]').text()).toBe('ada@example.test');
  });

  it('falls back to the bare mailbox as the name when no display name is known', () => {
    const target: ContactInfo = { displayName: null, mailbox: 'anon@example.test' };
    wrapper = mount(ContactPane, { props: { contact: ADA, context: 'focused', composeTarget: target } });
    const line = wrapper.get('[data-test="compose-target"]');
    expect(line.text()).toContain('Composing to anon@example.test');
    expect(line.get('.compose-target-mail').text()).toBe('anon@example.test');
  });

  it('renders nothing new when composeTarget is null', () => {
    wrapper = mount(ContactPane, { props: { contact: ADA, context: 'open' } });
    expect(wrapper.find('[data-test="compose-target"]').exists()).toBe(false);
    expect(wrapper.find('.compose-target').exists()).toBe(false);
    expect(wrapper.find('[data-test="contact-identity"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="contact-unknown"]').exists()).toBe(false);
  });
});

describe('App wiring: drawer label and contact-pane compose context for an active reply editor', () => {
  let wrapper: VueWrapper | null = null;

  async function mountApp(fake: BrowserFake, client: MailClient = fake): Promise<VueWrapper> {
    const mounted = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = mounted;
    await flushPromises();
    await mounted.find('[data-test="rail-drafts"]').trigger('click');
    await waitFor(() => mounted.find('[data-test="drafts-pane"]').exists());
    await flushPromises();
    return mounted;
  }

  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('shows "Draft to <sender>" in the inline reply composer and "Composing to" in the contact pane after preparing a reply (reader stays open)', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
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
    const compose = w.get('[data-test="compose-target"]');
    expect(compose.text()).toContain('Composing to Ada Fixture');
    expect(compose.get('.compose-target-mail').text()).toBe('ada@example.test');
  });

  it('prefers the open source conversation latest sender ("Ada Fixture") while the reader is open on the reply source', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
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
    const compose = w.get('[data-test="compose-target"]');
    expect(compose.text()).toContain('Composing to Ada Fixture');
    expect(compose.get('.compose-target-mail').text()).toBe('ada@example.test');
  });

  it('shows no compose-target line in the contact pane when no reply editor is active', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
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
