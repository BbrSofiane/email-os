/**
 * `useAccountNotes` in isolation: a stub mailbox of plain refs and a synthetic
 * account status. The wording of the notes themselves is pinned by
 * tests/account/*; this pins what the composable decides: which empty text a
 * context shows, when the palette ranks account commands first, and when the
 * empty line gives its action up.
 */
import { describe, expect, it } from 'vitest';
import { computed, effectScope, ref } from 'vue';
import { useAccountNotes } from '../../src/composables/useAccountNotes';
import type { Mailbox } from '../../src/composables/useMailbox';
import { INBOX_EMPTY_RECOVERABLE } from '../../src/lib/account-status';
import type { ActionId } from '../../src/lib/action-registry';
import type { AccountStatus } from '../../src/lib/ipc/client';

function setup(init: { context?: string; unreadOnly?: boolean; starredOnly?: boolean; nextCursor?: string | null; rows?: number; listState?: string; status?: unknown; drawer?: string | null; idle?: boolean; available?: ActionId[]; readerOpen?: boolean } = {}) {
  const mailbox = {
    context: ref(init.context ?? 'inbox'),
    unreadOnly: ref(init.unreadOnly ?? false),
    starredOnly: ref(init.starredOnly ?? false),
    nextCursor: ref(init.nextCursor ?? null),
    listState: ref(init.listState ?? 'ready'),
    conversations: ref(Array.from({ length: init.rows ?? 0 }, (_, i) => ({ id: i }))),
  };
  const status = ref(init.status ?? null);
  const drawer = ref<string | null>(init.drawer ?? null);
  const idle = ref(init.idle ?? true);
  const available = ref(new Set<ActionId>(init.available ?? []));
  const readerOpen = ref(init.readerOpen ?? false);
  const scope = effectScope();
  const notes = scope.run(() => useAccountNotes({
    mailbox: mailbox as unknown as Mailbox,
    accountStatus: computed(() => status.value as AccountStatus | null),
    readerOpen: computed(() => readerOpen.value),
    drawer,
    accountActionsIdle: computed(() => idle.value),
    actionAvailable: (id) => available.value.has(id),
  }))!;
  return { notes, mailbox, status, drawer, idle, available, readerOpen, stop: () => scope.stop() };
}

describe('useAccountNotes', () => {
  it('words the empty list per context, most specific first', () => {
    const cases: Array<[Parameters<typeof setup>[0], string]> = [
      [{ context: 'search', nextCursor: 'c' }, 'No matches on this candidate page. Continue scanning older mail below.'],
      [{ context: 'search' }, 'No matching conversations in the searched content.'],
      [{ unreadOnly: true }, 'No known unread conversations in this view. Use Commands → Show all conversations to turn off the unread filter; unknown read states are not included.'],
      [{ context: 'done', starredOnly: true }, 'No known starred conversations in this cached view; unknown facts and uncached mail are not included.'],
      [{ context: 'trash', unreadOnly: true }, 'No known cached Trash conversations. This does not mean your Gmail Trash is empty.'],
      [{ context: 'saved' }, 'No Inbox conversations match this saved split. Edit the sender or domain criteria, or return to Inbox.'],
      [{ context: 'done', nextCursor: 'c' }, 'No conversations on this cache page; more cached candidates are available.'],
      [{ context: 'starred' }, 'No known starred conversations in this local cache; unknown and uncached mail is not included.'],
      [{ context: 'done' }, 'No known archived conversations in this local cache.'],
    ];
    for (const [init, text] of cases) {
      const { notes, stop } = setup(init);
      expect(notes.emptyListText.value, JSON.stringify(init)).toBe(text);
      stop();
    }
  });

  it('falls back to the recoverable Inbox text when the account says nothing', () => {
    const { notes, stop } = setup();
    expect(notes.emptyListText.value).toBe(INBOX_EMPTY_RECOVERABLE);
    stop();
  });

  it('has palette rows unless the list is ready and empty', () => {
    const { notes, mailbox, stop } = setup({ rows: 0 });
    expect(notes.paletteHasRows.value).toBe(false);
    mailbox.listState.value = 'loading';
    expect(notes.paletteHasRows.value).toBe(true);
    mailbox.listState.value = 'ready';
    mailbox.conversations.value = [{ id: 1 }];
    expect(notes.paletteHasRows.value).toBe(true);
    stop();
  });

  it('says the contact list is empty only for a rowless list with no reader', () => {
    const { notes, mailbox, readerOpen, stop } = setup();
    expect(notes.contactListEmpty.value).toBe(true);
    readerOpen.value = true;
    expect(notes.contactListEmpty.value).toBe(false);
    readerOpen.value = false;
    mailbox.conversations.value = [{ id: 1 }];
    expect(notes.contactListEmpty.value).toBe(false);
    stop();
  });

  it('ranks account commands first for Connect or a fixable sync failure, and on top only for the failure', () => {
    const failing = { connection: 'connected', sync: { state: 'error' } };
    const { notes, available, status, stop } = setup({ status: failing });
    expect(notes.accountCommandsFirst.value).toBe(false);
    expect(notes.accountCommandsTop.value).toBe(false);
    available.value = new Set<ActionId>(['connect']);
    expect(notes.accountCommandsFirst.value).toBe(true);
    expect(notes.accountCommandsTop.value).toBe(false);
    available.value = new Set<ActionId>(['sync']);
    expect(notes.accountCommandsTop.value).toBe(true);
    expect(notes.accountCommandsFirst.value).toBe(true);
    status.value = { connection: 'connected', sync: { state: 'idle' } };
    expect(notes.accountCommandsTop.value).toBe(false);
    stop();
  });
});
