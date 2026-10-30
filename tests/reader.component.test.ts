import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ReaderView from '../src/components/ReaderView.vue';
import type { Conversation, ConversationRef, MailError } from '../src/lib/ipc/client';

const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';

function refOf(accountId: string, conversationId: string): ConversationRef {
  return { accountId, conversationId };
}

function message(
  id: string,
  bodyText = `Body of ${id}.`,
  from = { displayName: 'Ada Fixture', mailbox: 'ada@example.test' },
) {
  return {
    id,
    from,
    to: [{ displayName: 'You', mailbox: 'you@example.test' }],
    sentAt: '2026-02-02T09:00:00Z',
    bodyText,
  };
}

function conversationOf(accountId: string, messageIds: string[], extra: Partial<Conversation> = {}): Conversation {
  return {
    ref: refOf(accountId, 'read-01'),
    subject: 'Reader journey thread',
    messages: messageIds.map((id) => message(id)),
    isInInbox: true,
    pendingOperationId: null,
    ...extra,
  };
}

const NOT_FOUND: MailError = { kind: 'not_found' };

function mountReader(conversation: Conversation, state: 'ready' | 'loading' | 'error' = 'ready') {
  return mount(ReaderView, {
    props: {
      conversation: state === 'ready' ? conversation : null,
      state,
      error: null,
      commandInFlight: false,
      openRef: conversation.ref,
    },
    attachTo: document.body,
  });
}

function toggleFor(wrapper: VueWrapper, messageId: string) {
  return wrapper.find(`[data-test="message-toggle-${messageId}"]`);
}

async function settle(wrapper: VueWrapper): Promise<void> {
  await flushPromises();
  await nextTick();
  await flushPromises();
  void wrapper;
}

describe('ReaderView visit-scoped message state (UX-02)', () => {
  let wrapper: VueWrapper | null = null;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('opens focused on the newest message toggle with only the newest message expanded', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m3');
    expect(toggleFor(wrapper!, 'read-m3').attributes('aria-expanded')).toBe('true');
    expect(toggleFor(wrapper!, 'read-m1').attributes('aria-expanded')).toBe('false');
    expect(toggleFor(wrapper!, 'read-m1').attributes('tabindex')).toBe('-1');
    expect(toggleFor(wrapper!, 'read-m3').attributes('tabindex')).toBe('0');
    // Collapsed bodies stay out of sight but keep their aria-controls target.
    const bodies = wrapper!.findAll('[data-test="message-body"]');
    expect(bodies).toHaveLength(3);
    expect((bodies[0]!.element as HTMLElement).hidden).toBe(true);
    expect((bodies[2]!.element as HTMLElement).hidden).toBe(false);
  });

  it('moves message focus with N/P without implicitly expanding', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    const vm = wrapper!.vm as unknown as { moveMessage: (delta: number) => void };
    vm.moveMessage(-1); // P: to the middle message
    await nextTick();
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m2');
    expect(toggleFor(wrapper!, 'read-m2').attributes('aria-expanded')).toBe('false');
    expect(toggleFor(wrapper!, 'read-m2').attributes('tabindex')).toBe('0');
    expect((wrapper!.findAll('[data-test="message-body"]')[1]!.element as HTMLElement).hidden).toBe(true);
    vm.moveMessage(-1); // P again: to the oldest message
    await nextTick();
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m1');
    vm.moveMessage(1); // N: forward without expanding
    await nextTick();
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m2');
    expect(toggleFor(wrapper!, 'read-m2').attributes('aria-expanded')).toBe('false');
    // Edges clamp: N at the end does not wrap.
    vm.moveMessage(1);
    vm.moveMessage(1);
    await nextTick();
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m3');
  });

  it('expands/collapses the focused message with O and expands all idempotently with Shift+O', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    const vm = wrapper!.vm as unknown as {
      moveMessage: (delta: number) => void;
      toggleActiveMessage: () => void;
      expandAllMessages: () => void;
    };
    vm.moveMessage(-1);
    await nextTick();
    vm.toggleActiveMessage(); // O
    await nextTick();
    expect(toggleFor(wrapper!, 'read-m2').attributes('aria-expanded')).toBe('true');
    vm.toggleActiveMessage(); // O again collapses
    await nextTick();
    expect(toggleFor(wrapper!, 'read-m2').attributes('aria-expanded')).toBe('false');
    vm.expandAllMessages(); // Shift+O
    await nextTick();
    expect(wrapper!.findAll('.message-toggle').map((t) => t.attributes('aria-expanded')))
      .toEqual(['true', 'true', 'true']);
    vm.expandAllMessages(); // idempotent: no collapse, no change
    await nextTick();
    expect(wrapper!.findAll('.message-toggle').map((t) => t.attributes('aria-expanded')))
      .toEqual(['true', 'true', 'true']);
  });

  it('updates message identity when any message control receives focus', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    (toggleFor(wrapper!, 'read-m1').element as HTMLElement).focus();
    await nextTick();
    expect(wrapper!.find('[data-test="message-read-m1"]').classes()).toContain('message-active');
    expect(wrapper!.emitted('activeMessage')?.at(-1)).toEqual(['read-m1']);
    // Focusing a participant control inside the details also carries identity.
    const details = wrapper!.find('[data-test="message-details-read-m1"]');
    (details.element as HTMLDetailsElement).open = true;
    details.element.dispatchEvent(new Event('toggle'));
    await nextTick();
    const participant = wrapper!.find('[data-test="participant-from-read-m1"]');
    participant.element.dispatchEvent(new FocusEvent('focus'));
    await nextTick();
    expect(wrapper!.find('[data-test="message-read-m1"]').classes()).toContain('message-active');
    participant.element.dispatchEvent(new FocusEvent('blur'));
    await nextTick();
    expect(wrapper!.emitted('contactOverride')?.at(-1)).toEqual([null]);
  });

  it('dismisses an open details disclosure and reports it to Escape handling', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    const vm = wrapper!.vm as unknown as {
      hasOpenDetails: () => boolean;
      dismissMessageDetails: () => boolean;
    };
    expect(vm.hasOpenDetails()).toBe(false);
    expect(vm.dismissMessageDetails()).toBe(false);
    const details = wrapper!.find('[data-test="message-details-read-m3"]');
    (details.element as HTMLDetailsElement).open = true;
    details.element.dispatchEvent(new Event('toggle'));
    await nextTick();
    expect(vm.hasOpenDetails()).toBe(true);
    expect(vm.dismissMessageDetails()).toBe(true);
    await nextTick();
    expect(vm.hasOpenDetails()).toBe(false);
    expect((wrapper!.find('[data-test="message-details-read-m3"]').element as HTMLDetailsElement).open).toBe(false);
    // Focus returned to that message's toggle for continued N/P movement.
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m3');
  });

  it('preserves per-conversation state across J/K round trips and same-reference replacements', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    const vm = wrapper!.vm as unknown as {
      moveMessage: (delta: number) => void;
      toggleActiveMessage: () => void;
    };
    vm.moveMessage(-1); // focus m2
    vm.toggleActiveMessage(); // expand m2
    await nextTick();
    // J/K round trip: the visit leaves and comes back through prop changes.
    const neighbor = { ...conversation, ref: refOf(ACCOUNT_A, 'read-02'), subject: 'Neighbor', messages: [message('read-02-m1')] };
    await wrapper!.setProps({ conversation: neighbor, openRef: neighbor.ref });
    await settle(wrapper!);
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-02-m1');
    await wrapper!.setProps({ conversation, openRef: conversation.ref });
    await settle(wrapper!);
    // State survived the round trip: m2 still active AND still expanded.
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m2');
    expect(toggleFor(wrapper!, 'read-m2').attributes('aria-expanded')).toBe('true');

    // Same-reference background replacement: expansion preserved, focus not stolen.
    (wrapper!.find('[data-test="reader-close"]').element as HTMLElement).focus();
    const replacement = { ...conversation, messages: conversation.messages.map((m) => ({ ...m })) };
    await wrapper!.setProps({ conversation: replacement, openRef: conversation.ref });
    await settle(wrapper!);
    expect(document.activeElement?.getAttribute('data-test')).toBe('reader-close');
    expect(toggleFor(wrapper!, 'read-m2').attributes('aria-expanded')).toBe('true');
    expect(wrapper!.find('.message.message-active .message-toggle').attributes('data-test')).toBe('message-toggle-read-m2');
  });

  it('prunes removed message IDs and resolves a removed active ID to a surviving old neighbor', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    const vm = wrapper!.vm as unknown as { moveMessage: (delta: number) => void; toggleActiveMessage: () => void };
    vm.moveMessage(-1); // focus m2, expand it
    const toggle = toggleFor(wrapper!, 'read-m2');
    (toggle.element as HTMLElement).focus();
    vm.toggleActiveMessage();
    await nextTick();
    // m2 is removed remotely: active moves to the next surviving old neighbor (m3).
    const replacement = conversationOf(ACCOUNT_A, ['read-m1', 'read-m3']);
    await wrapper!.setProps({ conversation: replacement, openRef: replacement.ref });
    await settle(wrapper!);
    expect(wrapper!.findAll('[data-test="message-body"]')).toHaveLength(2);
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m3');
    expect(wrapper!.find('[data-test="message-read-m3"]').classes()).toContain('message-active');
  });

  it('publishes the resolved active ID to App when pruning removes the focused message', async () => {
    // Distinct senders: the fallback neighbor (Grace) differs from the removed
    // message (Ravi), so the emitted identity proves real resolution.
    const ravi = { displayName: 'Ravi Fixture', mailbox: 'ravi@example.test' };
    const grace = { displayName: 'Grace Fixture', mailbox: 'grace@example.test' };
    const conversation: Conversation = {
      ...conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']),
      messages: [message('read-m1'), message('read-m2', `Body of read-m2.`, ravi), message('read-m3', `Body of read-m3.`, grace)],
    };
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    const vm = wrapper!.vm as unknown as { moveMessage: (delta: number) => void };
    vm.moveMessage(-1); // focus m2 (Ravi)
    await nextTick();
    expect(wrapper!.emitted('activeMessage')?.at(-1)).toEqual(['read-m2']);
    const emissionsBefore = wrapper!.emitted('activeMessage')?.length ?? 0;
    // m2 is removed remotely: active resolves to the next surviving old neighbor.
    const replacement: Conversation = {
      ...conversation,
      messages: [message('read-m1'), message('read-m3', `Body of read-m3.`, grace)],
    };
    await wrapper!.setProps({ conversation: replacement, openRef: replacement.ref });
    await settle(wrapper!);
    // The resolved identity must be published to App, not just shown in DOM.
    const emissions = wrapper!.emitted('activeMessage') ?? [];
    expect(emissions.length).toBeGreaterThan(emissionsBefore);
    expect(emissions.at(-1)).toEqual(['read-m3']);
    // DOM focus and highlight agree with the published identity.
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m3');
    expect(wrapper!.find('[data-test="message-read-m3"]').classes()).toContain('message-active');
  });

  it('keeps reader-owned focus on the reader article when loading removes the focused message', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    (toggleFor(wrapper!, 'read-m2').element as HTMLElement).focus();
    await nextTick();
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    expect(wrapper!.find('[data-test="reader-loading"]').exists()).toBe(true);
    // Not <body>: the persistent reader article keeps reader-owned focus.
    expect(document.activeElement).toBe(wrapper!.find('[data-test="reader"]').element);
  });

  it('does not steal toolbar or outside focus during loading or reversal restoration', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    // Persistent toolbar focus survives loading untouched.
    (wrapper!.find('[data-test="reader-close"]').element as HTMLElement).focus();
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    expect(document.activeElement?.getAttribute('data-test')).toBe('reader-close');
    // Focus moved outside the reader (rail/overlay surface) while loading:
    // the returning snapshot must not yank it back either.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    await wrapper!.setProps({ conversation, state: 'ready' as const, openRef: conversation.ref });
    await settle(wrapper!);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('does not steal focus from an outside button focused before the loading transition', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    // Rail/overlay/outside focus exists BEFORE the loading transition: the
    // reader never owned focus, so loading must not schedule the article over it.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    await nextTick();
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    expect(wrapper!.find('[data-test="reader-loading"]').exists()).toBe(true);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('does not override a user who moves outside before delayed loading focus executes', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    (toggleFor(wrapper!, 'read-m2').element as HTMLElement).focus();
    await nextTick();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const loading = wrapper!.setProps({ conversation: null, state: 'loading' as const });
    // The user moves while the loading transition's delayed focus work is in
    // flight; the delayed park must not yank focus back to the article.
    void Promise.resolve().then(() => outside.focus());
    await loading;
    await settle(wrapper!);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('respects inert ancestors when parking loading focus', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    (toggleFor(wrapper!, 'read-m2').element as HTMLElement).focus();
    await nextTick();
    wrapper!.element.setAttribute('inert', '');
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    // The article could not take focus (inert subtree); focus stays on <body>
    // instead of being forced inside the inert reader.
    expect(document.activeElement).toBe(document.body);
    wrapper!.element.removeAttribute('inert');
  });

  it('restores message focus on an immediate ready -> loading -> same-visit reversal', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    const vm = wrapper!.vm as unknown as { moveMessage: (delta: number) => void };
    vm.moveMessage(-1); // focus m2
    await nextTick();
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    expect(document.activeElement?.getAttribute('data-test')).toBe('reader');
    // Reversal: the last successful data key is still A, yet the visit's
    // message focus must be restored, independent of that key.
    await wrapper!.setProps({ conversation, state: 'ready' as const, openRef: conversation.ref });
    await settle(wrapper!);
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m2');
    expect(wrapper!.find('[data-test="message-read-m2"]').classes()).toContain('message-active');
    // Saved expansion state survived untouched: m3 still expanded, m2 not
    // implicitly expanded by the restoration.
    expect(toggleFor(wrapper!, 'read-m3').attributes('aria-expanded')).toBe('true');
    expect(toggleFor(wrapper!, 'read-m2').attributes('aria-expanded')).toBe('false');
  });

  it('keeps toolbar or outside ownership on an empty same-key return after loading', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    (toggleFor(wrapper!, 'read-m2').element as HTMLElement).focus();
    await nextTick();
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    // The user moves while loading; the returning visit is now EMPTY.
    (wrapper!.find('[data-test="reader-close"]').element as HTMLElement).focus();
    const emptyReturn: Conversation = { ...conversation, messages: [] };
    await wrapper!.setProps({ conversation: emptyReturn, state: 'ready' as const, openRef: conversation.ref });
    await settle(wrapper!);
    // The empty-visit article fallback must not bypass the ownership guard.
    expect(document.activeElement?.getAttribute('data-test')).toBe('reader-close');
    expect(wrapper!.findAll('[data-test="message-body"]')).toHaveLength(0);

    // Same journey with focus moved OUTSIDE the reader instead.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    await wrapper!.setProps({ conversation, state: 'ready' as const, openRef: conversation.ref });
    await settle(wrapper!);
    (toggleFor(wrapper!, 'read-m2').element as HTMLElement).focus();
    await nextTick();
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    outside.focus();
    await wrapper!.setProps({ conversation: emptyReturn, state: 'ready' as const, openRef: conversation.ref });
    await settle(wrapper!);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('keeps the owned article fallback on an empty same-key return after loading', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    (toggleFor(wrapper!, 'read-m2').element as HTMLElement).focus();
    await nextTick();
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    // Reader-owned focus fell to the parked article and stays there: the
    // empty return promotes it to the empty-visit article fallback.
    await wrapper!.setProps({ conversation: { ...conversation, messages: [] }, state: 'ready' as const, openRef: conversation.ref });
    await settle(wrapper!);
    expect(wrapper!.findAll('[data-test="message-body"]')).toHaveLength(0);
    expect(document.activeElement).toBe(wrapper!.find('[data-test="reader"]').element);
  });

  it('does not force reversal focus back over a surface the user moved to', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    (toggleFor(wrapper!, 'read-m2').element as HTMLElement).focus();
    await nextTick();
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    // The user moves to the reader toolbar while loading.
    (wrapper!.find('[data-test="reader-close"]').element as HTMLElement).focus();
    await wrapper!.setProps({ conversation, state: 'ready' as const, openRef: conversation.ref });
    await settle(wrapper!);
    expect(document.activeElement?.getAttribute('data-test')).toBe('reader-close');
  });

  it('ignores O/Shift+O/N during loading instead of mutating the outgoing visit', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    const vm = wrapper!.vm as unknown as {
      moveMessage: (delta: number) => void;
      toggleActiveMessage: () => void;
      expandAllMessages: () => void;
    };
    vm.moveMessage(-1); // focus m2
    vm.toggleActiveMessage(); // expand m2
    await nextTick();
    expect(toggleFor(wrapper!, 'read-m2').attributes('aria-expanded')).toBe('true');
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    // O during loading: must not modify the outgoing visit's saved expansion.
    vm.toggleActiveMessage();
    // Shift+O during loading: must not expand the outgoing visit either.
    vm.expandAllMessages();
    // N during loading: no message target exists.
    vm.moveMessage(1);
    await wrapper!.setProps({ conversation, state: 'ready' as const, openRef: conversation.ref });
    await settle(wrapper!);
    expect(toggleFor(wrapper!, 'read-m2').attributes('aria-expanded')).toBe('true');
    expect(toggleFor(wrapper!, 'read-m1').attributes('aria-expanded')).toBe('false');
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m2');
  });

  it('gates details commands on a ready displayed visit but retains saved details state', async () => {
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    const vm = wrapper!.vm as unknown as { hasOpenDetails: () => boolean; dismissMessageDetails: () => boolean };
    const details = wrapper!.find('[data-test="message-details-read-m3"]');
    (details.element as HTMLDetailsElement).open = true;
    details.element.dispatchEvent(new Event('toggle'));
    await nextTick();
    expect(vm.hasOpenDetails()).toBe(true);
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    // Stale hidden details must not become a loading command target.
    expect(vm.hasOpenDetails()).toBe(false);
    expect(vm.dismissMessageDetails()).toBe(false);
    await wrapper!.setProps({ conversation, state: 'ready' as const, openRef: conversation.ref });
    await settle(wrapper!);
    // Saved details state survived loading for restoration.
    expect(vm.hasOpenDetails()).toBe(true);
    expect((wrapper!.find('[data-test="message-details-read-m3"]').element as HTMLDetailsElement).open).toBe(true);
    expect(vm.dismissMessageDetails()).toBe(true);
    await nextTick();
    expect(vm.hasOpenDetails()).toBe(false);
  });

  it('falls back to the article for empty and error states', async () => {
    const conversation = conversationOf(ACCOUNT_A, []);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    expect(document.activeElement).toBe(wrapper!.find('[data-test="reader"]').element);

    await wrapper!.setProps({ conversation: null, state: 'error', error: NOT_FOUND });
    await settle(wrapper!);
    expect(wrapper!.find('[data-test="reader-error"]').exists()).toBe(true);
    expect(document.activeElement).toBe(wrapper!.find('[data-test="reader"]').element);
  });

  it('keeps equal message IDs from different accounts isolated', async () => {
    const accountA = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(accountA);
    await settle(wrapper!);
    const vm = wrapper!.vm as unknown as { moveMessage: (delta: number) => void; toggleActiveMessage: () => void };
    vm.moveMessage(-1);
    vm.toggleActiveMessage(); // account A: m2 focused and expanded
    await nextTick();
    // Account switch with identical conversation/message IDs: state starts fresh.
    const accountB = conversationOf(ACCOUNT_B, ['read-m1', 'read-m2', 'read-m3']);
    await wrapper!.setProps({ conversation: accountB, openRef: accountB.ref });
    await settle(wrapper!);
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m3');
    expect(toggleFor(wrapper!, 'read-m3').attributes('aria-expanded')).toBe('true');
    expect(toggleFor(wrapper!, 'read-m2').attributes('aria-expanded')).toBe('false');
  });
});

describe('ReaderView scroll anchoring with controlled geometry (UX-02)', () => {
  let wrapper: VueWrapper | null = null;
  const originalGetBCR = HTMLElement.prototype.getBoundingClientRect;
  const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
  const scrollTopStore = new WeakMap<HTMLElement, number>();

  function domRect(top: number, bottom: number): DOMRect {
    return { top, bottom, left: 0, right: 320, width: 320, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  }

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) { return scrollTopStore.get(this) ?? 0; },
      set(this: HTMLElement, value: number) { scrollTopStore.set(this, value); },
    });
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      if (this.classList.contains('reader-scroll')) return domRect(0, 300);
      const testId = this.getAttribute?.('data-test');
      if (testId?.startsWith('message-') && !testId.startsWith('message-toggle') && !testId.startsWith('message-body') && !testId.startsWith('message-details') && this.parentElement?.classList.contains('messages')) {
        // Realistic layout: each message stacks 90px below the previous one, so
        // removing a message shifts everything after it up by exactly 90px.
        const index = Array.prototype.indexOf.call(this.parentElement.children, this);
        const top = index * 90;
        const height = index === 2 ? 320 : 90;
        const scroller = this.closest('.reader-scroll');
        const scroll = scroller instanceof HTMLElement ? (scrollTopStore.get(scroller) ?? 0) : 0;
        return domRect(top - scroll, top - scroll + height);
      }
      return originalGetBCR.call(this);
    };
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    HTMLElement.prototype.getBoundingClientRect = originalGetBCR;
    if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', originalScrollTop);
    else delete (HTMLElement.prototype as { scrollTop?: unknown }).scrollTop;
  });

  it('restores the viewport-relative message anchor after a background replacement', async () => {
    // Layout: each message stacks 90px below the previous (m1 0–90, m2 90–180,
    // m3 180–500); the scroller viewport is 0–300.
    const conversation = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversation);
    await settle(wrapper!);
    const scroller = wrapper!.find('[data-test="reader-scroll"]').element as HTMLElement;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    scroller.scrollTop = 100; // m3 sits at viewport offset 80
    const offsetBefore = 180 - 100;
    expect(offsetBefore).toBe(80);

    // Background replacement that removes m1: everything after it shifts up by 90px.
    const replacement = conversationOf(ACCOUNT_A, ['read-m2', 'read-m3']);
    await wrapper!.setProps({ conversation: replacement, openRef: replacement.ref });
    await settle(wrapper!);
    // The anchor (m3 at viewport offset 80) must be restored relative to the
    // shifted layout, keeping m3's viewport position unchanged.
    expect(scroller.scrollTop).toBe(10);
    const rect = wrapper!.find('[data-test="message-read-m3"]').element.getBoundingClientRect();
    expect(rect.top).toBe(80);
  });

  it('keeps the saved anchor through null/loading transitions and restores it on J/K revisit', async () => {
    const conversationA = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    const conversationB = conversationOf(ACCOUNT_B, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversationA);
    await settle(wrapper!);
    const vm = wrapper!.vm as unknown as { moveMessage: (delta: number) => void };
    vm.moveMessage(-1); // focus m2 without expanding it; m3 stays expanded
    await nextTick();
    const scroller = wrapper!.find('[data-test="reader-scroll"]').element as HTMLElement;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    scroller.scrollTop = 120; // reading progress: m3 top sits at viewport offset 60
    expect(wrapper!.find('[data-test="message-read-m3"]').element.getBoundingClientRect().top).toBe(60);
    expect(toggleFor(wrapper!, 'read-m3').attributes('aria-expanded')).toBe('true');
    expect(toggleFor(wrapper!, 'read-m2').attributes('aria-expanded')).toBe('false');

    // Foreground J: useMailbox clears the conversation (null) while loading.
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    expect(wrapper!.find('[data-test="reader-loading"]').exists()).toBe(true);
    // A real browser clamps scrollTop to 0 once the content collapses; the
    // saved anchor must survive that teardown untouched.
    scroller.scrollTop = 0;

    // Neighbor ready.
    await wrapper!.setProps({ conversation: conversationB, state: 'ready' as const, openRef: conversationB.ref });
    await settle(wrapper!);
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m3');

    // Foreground K through loading again, back to the original visit.
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    scroller.scrollTop = 0;
    await wrapper!.setProps({ conversation: conversationA, state: 'ready' as const, openRef: conversationA.ref });
    await settle(wrapper!);

    // Reading progress is restored exactly: same scrollTop and same
    // viewport-relative message geometry, focus back on the visit's active
    // message without reveal-scrolling, and per-visit expansion state intact.
    expect(scroller.scrollTop).toBe(120);
    expect(wrapper!.find('[data-test="message-read-m3"]').element.getBoundingClientRect().top).toBe(60);
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-m2');
    expect(toggleFor(wrapper!, 'read-m3').attributes('aria-expanded')).toBe('true');
    expect(toggleFor(wrapper!, 'read-m2').attributes('aria-expanded')).toBe('false');
  });

  it('does not overwrite the saved anchor while the loading DOM replaces the messages', async () => {
    const conversationA = conversationOf(ACCOUNT_A, ['read-m1', 'read-m2', 'read-m3']);
    wrapper = mountReader(conversationA);
    await settle(wrapper!);
    const scroller = wrapper!.find('[data-test="reader-scroll"]').element as HTMLElement;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    scroller.scrollTop = 150; // m2 at offset 60 (90 - 150 clamped into view)
    await wrapper!.setProps({ conversation: null, state: 'loading' as const });
    await settle(wrapper!);
    scroller.scrollTop = 0;
    // Same-reference reload after the loading teardown: the anchor captured
    // before the teardown must still govern the restore.
    await wrapper!.setProps({ conversation: conversationA, state: 'ready' as const, openRef: conversationA.ref });
    await settle(wrapper!);
    expect(scroller.scrollTop).toBe(150);
    expect(wrapper!.find('[data-test="message-read-m2"]').element.getBoundingClientRect().top).toBe(-60);
  });
});
