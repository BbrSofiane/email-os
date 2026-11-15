import { afterEach, describe, expect, it } from 'vitest';
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
});
