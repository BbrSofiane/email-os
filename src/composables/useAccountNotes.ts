/**
 * The account-driven header and empty-line facts, moved verbatim out of App.vue:
 * the one status note, the read-only hint, the empty inbox line and who owns its
 * action, the palette's account ranking and the empty list text. Everything is
 * a computed view over the mailbox and the account status; the owner passes the
 * few facts that live elsewhere (drawer, busy state, availability) as arguments.
 */
import { computed, type ComputedRef, type Ref } from 'vue';
import { INBOX_EMPTY_RECOVERABLE, accountNotice, drawerShowsSameFailure, emptyLineOwnsStatus, headerNoteAnnounces, headerNoticeAction, inboxEmptyState, readOnlyHintShown, splitNoticeText } from '../lib/account-status';
import type { ActionId } from '../lib/action-registry';
import type { AccountStatus } from '../lib/ipc/client';
import type { Mailbox } from './useMailbox';

export interface AccountNotesDeps {
  mailbox: Mailbox;
  accountStatus: ComputedRef<AccountStatus | null>;
  readerOpen: ComputedRef<boolean>;
  /** The open utility drawer (only `'account'` matters here). */
  drawer: Readonly<Ref<string | null>>;
  /** No account action or draft transition is in flight. */
  accountActionsIdle: ComputedRef<boolean>;
  actionAvailable: (id: ActionId) => boolean;
}

export function useAccountNotes({ mailbox, accountStatus, readerOpen, drawer, accountActionsIdle, actionAvailable }: AccountNotesDeps) {
  // Header status note: one fact about the connection or sync, null while connected and idle.
  const statusNotice = computed(() => accountNotice(accountStatus.value));
  // Any status note (connection or sync) replaces the older read-only hint: the Account drawer covers it
  // and the header has no room for both.
  const readOnlyHint = computed(() => readOnlyHintShown(accountStatus.value, statusNotice.value));
  // Only the plain Inbox says anything about the account; search, filters, saved and other contexts keep their own text.
  const inboxEmpty = computed(() => mailbox.context.value === 'inbox' && !mailbox.unreadOnly.value && !mailbox.starredOnly.value
    ? inboxEmptyState(accountStatus.value) : null);
  // The empty inbox line is on screen: a ready, zero-row plain Inbox with no reader open.
  const emptyLineShown = computed(() => mailbox.listState.value === 'ready' && mailbox.conversations.value.length === 0
    && !readerOpen.value && !!inboxEmpty.value);
  // One action, one place: while the empty inbox line carries it, the header note has no link.
  const emptyLineCarriesAction = computed(() => emptyLineShown.value && !!inboxEmpty.value?.action);
  const headerAction = computed(() => headerNoticeAction(statusNotice.value, emptyLineCarriesAction.value));
  // One sentence, one place: while the empty line carries the status sentence, the header note drops its visible
  // words (the Preview tag stays) and keeps only its one announcement, so the sentence and the ticking cached
  // count are never shown twice.
  // While the Account drawer shows the same sync failure as its alert (with its own Retry), the note drops its
  // words and link too, and stays silent: the failure and its fix are seen and announced once. The Preview tag stays.
  const drawerHasFailure = computed(() => drawerShowsSameFailure(accountStatus.value, drawer.value === 'account'));
  // One live action: while the Account drawer shows the same failure with its own Retry, the empty line behind it
  // keeps its sentence but not a second, inert-looking Retry. It returns when the drawer closes.
  const emptyActionShown = computed(() => !!inboxEmpty.value?.action
    && (inboxEmpty.value.action === 'account' || accountActionsIdle.value)
    && !drawerHasFailure.value);
  const noteWordsHidden = computed(() => emptyLineOwnsStatus(inboxEmpty.value, emptyLineShown.value) || drawerHasFailure.value);
  const noteAnnounces = computed(() => headerNoteAnnounces(accountStatus.value, drawer.value === 'account'));
  // The lead ("Sync failed") stays whole; the detail (cause, cached count) is what ellipsizes first.
  const noteParts = computed(() => splitNoticeText(statusNotice.value?.text ?? ''));
  // The contact pane says nothing about a missing correspondent when no row can be focused.
  const contactListEmpty = computed(() => !readerOpen.value && mailbox.conversations.value.length === 0);
  // Provider mail with no account: Connect (or Account when nothing can be connected), never an action of its own.
  const providerAccountAction = computed(() => {
    const empty = inboxEmptyState(accountStatus.value);
    return empty && (empty.action === 'connect' || empty.action === 'account') ? { action: empty.action, label: empty.actionLabel } : null;
  });
  // Palette: Connect, or a Sync now that can fix a failure, ranks above Go to.
  const syncFailureFixable = computed(() => actionAvailable('sync') && accountStatus.value?.sync.state === 'error');
  const accountCommandsFirst = computed(() => actionAvailable('connect') || syncFailureFixable.value);
  // A visible sync failure has one fix, so Sync now leads the palette (triage commands follow).
  const accountCommandsTop = computed(() => syncFailureFixable.value);
  const paletteHasRows = computed(() => !(mailbox.listState.value === 'ready' && mailbox.conversations.value.length === 0));
  const emptyListText = computed(() => {
    if (mailbox.context.value === 'search') return mailbox.nextCursor.value ? 'No matches on this candidate page. Continue scanning older mail below.' : 'No matching conversations in the searched content.';
    if (mailbox.unreadOnly.value && mailbox.context.value !== 'trash') return 'No known unread conversations in this view. Use Commands → Show all conversations to turn off the unread filter; unknown read states are not included.';
    if (mailbox.starredOnly.value) return 'No known starred conversations in this cached view; unknown facts and uncached mail are not included.';
    if (mailbox.context.value === 'trash') return 'No known cached Trash conversations. This does not mean your Gmail Trash is empty.';
    if (mailbox.context.value === 'saved') return 'No Inbox conversations match this saved split. Edit the sender or domain criteria, or return to Inbox.';
    if (mailbox.context.value === 'inbox') return inboxEmpty.value?.text ?? INBOX_EMPTY_RECOVERABLE;
    if (mailbox.nextCursor.value) return 'No conversations on this cache page; more cached candidates are available.';
    if (mailbox.context.value === 'starred') return 'No known starred conversations in this local cache; unknown and uncached mail is not included.';
    return 'No known archived conversations in this local cache.';
  });

  return { statusNotice, readOnlyHint, inboxEmpty, emptyLineShown, headerAction, emptyActionShown, noteWordsHidden, noteAnnounces, noteParts, contactListEmpty, providerAccountAction, accountCommandsFirst, accountCommandsTop, paletteHasRows, emptyListText };
}
