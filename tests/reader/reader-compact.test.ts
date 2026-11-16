import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountReaderView } from '../support/reader.mount';
import type { Conversation } from '../../src/lib/ipc/client';

function conversationOf(): Conversation {
  const address = { displayName: 'Reader', mailbox: 'reader@example.test' };
  return {
    ref: { accountId: 'account-a', conversationId: 'compact-thread' },
    subject: 'Compact toolbar test',
    messages: [{ id: 'm1', from: address, to: [address], sentAt: '2026-02-02T09:00:00Z', bodyText: 'Body' }],
    isInInbox: true,
    isRead: true,
    pendingOperationId: null,
  };
}

describe('ReaderView compact toolbar', () => {
  let wrapper: ReturnType<typeof mountReaderView> | null = null;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('keeps the compact toolbar to the triage and navigation controls', () => {
    wrapper = mountReaderView(conversationOf(), {
      compact: true,
      reminderEnabled: true,
      canMovePrev: true,
      canMoveNext: true,
      showReadControls: true,
    });
    const buttons = wrapper.findAll('[data-test="reader-toolbar"] button');
    expect(buttons.map(button => button.attributes('data-test'))).toEqual([
      'reader-remind', 'reader-archive-toggle', 'reader-prev', 'reader-next', 'reader-more',
    ]);
    expect(wrapper.find('[data-test="reader-toggle-read"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="files-links"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="prepare-reply"]').exists()).toBe(false);
  });

  it('keeps the regular toolbar controls unchanged', () => {
    wrapper = mountReaderView(conversationOf(), {
      reminderEnabled: true,
      canMovePrev: true,
      canMoveNext: true,
      showReadControls: true,
    });
    expect(wrapper.findAll('[data-test="reader-toolbar"] button')).toHaveLength(7);
    expect(wrapper.find('[data-test="prepare-reply"]').exists()).toBe(true);
  });

  it('shows the current star state and emits the star action', async () => {
    wrapper = mountReaderView(conversationOf(), {
      compact: true,
      starShown: true,
      starEnabled: true,
      starred: true,
    });
    const star = wrapper.get('[data-test="reader-star"]');
    expect(star.attributes('aria-label')).toBe('Unstar');
    expect(star.find('svg path').attributes('fill')).toBe('currentColor');
    await star.trigger('click');
    expect(wrapper.emitted('star')).toHaveLength(1);
  });

  it('hides the star when the capability is absent', () => {
    wrapper = mountReaderView(conversationOf(), { compact: true, starShown: false });
    expect(wrapper.find('[data-test="reader-star"]').exists()).toBe(false);
  });

  it('teleports the reply bar to the context host and uses the shared reply path', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const conversation = conversationOf();
    wrapper = mountReaderView(conversation, { compact: true, contextHost: host });
    const reply = host.querySelector<HTMLButtonElement>('[data-test="mobile-reply-bar"]');
    expect(reply).not.toBeNull();
    expect(reply?.disabled).toBe(false);
    expect(reply?.getAttribute('aria-describedby')).toBeTruthy();
    reply?.click();
    expect(wrapper.emitted('prepareReply')?.[0]).toEqual([{
      kind: 'reply',
      conversation: conversation.ref,
      sourceMessageId: 'm1',
    }]);
    host.remove();
  });

  it('hides the reply bar without a host, while reply is docked, or in browsing-only mode', () => {
    const host = document.createElement('div');
    document.body.append(host);
    wrapper = mountReaderView(conversationOf(), { compact: true });
    expect(document.querySelector('[data-test="mobile-reply-bar"]')).toBeNull();
    wrapper.unmount();
    wrapper = mountReaderView(conversationOf(), { compact: true, contextHost: host, replyDocked: true });
    expect(host.querySelector('[data-test="mobile-reply-bar"]')).toBeNull();
    wrapper.unmount();
    wrapper = mountReaderView(conversationOf(), { compact: true, contextHost: host, browsingOnly: true });
    expect(host.querySelector('[data-test="mobile-reply-bar"]')).toBeNull();
    host.remove();
  });

  it('opens the expanded message menu and replies to that message', async () => {
    wrapper = mountReaderView(conversationOf(), { compact: true });
    expect(wrapper.find('[data-test="reader-more"] svg circle').exists()).toBe(true);
    await wrapper.get('[data-test="message-more"]').trigger('click');
    expect(wrapper.find('[data-test="message-more"] svg circle').exists()).toBe(true);
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('Reader');
    const collapse = wrapper.findAll('[role="dialog"] button').find(button => button.text().includes('Collapse'));
    const copy = wrapper.findAll('[role="dialog"] button').find(button => button.text().includes('Copy text'));
    expect(collapse?.find('svg').attributes('data-glyph')).toBe('collapse');
    expect(copy?.find('svg').attributes('data-glyph')).toBe('copy');
    await wrapper.get('[role="dialog"] button').trigger('click');
    expect(wrapper.emitted('prepareReply')?.[0]?.[0]).toMatchObject({ sourceMessageId: 'm1' });
  });

  it('copies plain text and leaves an honest disabled failure reason when clipboard rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    wrapper = mountReaderView(conversationOf(), { compact: true });
    await wrapper.get('[data-test="message-more"]').trigger('click');
    await wrapper.get('[role="dialog"] button:last-of-type').trigger('click');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(writeText).toHaveBeenCalledWith('Body');
    expect(wrapper.get('[role="dialog"] button:last-of-type').attributes('aria-label')).toContain('Copy unavailable');
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
  });
});
