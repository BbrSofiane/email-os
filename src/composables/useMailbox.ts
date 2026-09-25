/** Core read models are authoritative; events only request another snapshot. */
import { computed, onScopeDispose, ref, type Ref } from 'vue';
import type { Conversation, ConversationRef, InboxSnapshot, MailClient, MailError, OperationReceipt, SetArchived } from '../lib/ipc/client';
import { toMailError } from '../lib/ipc/client';

export type ListState = 'loading' | 'ready' | 'error';
export type DetailState = 'idle' | 'loading' | 'ready' | 'error';
export type ConversationSummaryLike = InboxSnapshot['conversations'][number];
export type OperationSummaryLike = InboxSnapshot['activity'][number];

export function sameConversation(a: ConversationRef | null, b: ConversationRef | null): boolean {
  return a !== null && b !== null && a.accountId === b.accountId && a.conversationId === b.conversationId;
}

export interface Mailbox {
  conversations: Ref<ConversationSummaryLike[]>;
  activity: Ref<OperationSummaryLike[]>;
  listState: Ref<ListState>;
  listError: Ref<MailError | null>;
  selectedIndex: Ref<number>;
  selectedSummary: Ref<ConversationSummaryLike | null>;
  openRef: Ref<ConversationRef | null>;
  conversation: Ref<Conversation | null>;
  detailState: Ref<DetailState>;
  detailError: Ref<MailError | null>;
  lastCommandError: Ref<MailError | null>;
  inFlightCommandRef: Ref<ConversationRef | null>;
  ready: Promise<void>;
  refresh(): Promise<void>;
  moveSelection(delta: number): void;
  selectIndex(index: number): void;
  openConversationByRef(ref: ConversationRef): Promise<void>;
  openSelected(): Promise<void>;
  closeReader(): void;
  setArchived(target: ConversationRef, archived: boolean): Promise<OperationReceipt | null>;
  archiveSelected(): Promise<void>;
}

export function useMailbox(client: MailClient): Mailbox {
  const conversations = ref<ConversationSummaryLike[]>([]);
  const activity = ref<OperationSummaryLike[]>([]);
  const listState = ref<ListState>('loading');
  const listError = ref<MailError | null>(null);
  const selectedIndex = ref(0);
  const openRef = ref<ConversationRef | null>(null);
  const conversation = ref<Conversation | null>(null);
  const detailState = ref<DetailState>('idle');
  const detailError = ref<MailError | null>(null);
  const lastCommandError = ref<MailError | null>(null);
  const inFlightCommandRef = ref<ConversationRef | null>(null);

  let listToken = 0;
  let detailToken = 0;
  let commandToken = 0;
  let detached = false;
  let unsubscribe: (() => void) | null = null;
  let subscriptionAttempt: Promise<void> | null = null;

  async function ensureSubscribed(): Promise<void> {
    if (unsubscribe || detached) return;
    if (!subscriptionAttempt) {
      // Share an in-flight attempt; a failed attempt is retried on Retry/focus/online.
      subscriptionAttempt = Promise.resolve()
        .then(() => client.subscribe(() => { void refresh(); }))
        .then((unsub) => {
          if (detached) unsub();
          else unsubscribe = unsub;
        })
        .finally(() => { subscriptionAttempt = null; });
    }
    await subscriptionAttempt;
  }

  async function refreshList(token: number): Promise<void> {
    const snap = await client.listConversations();
    if (detached || token !== listToken) return;
    // Preserve identity, not position, when a failed archive restores an earlier row.
    const selected = conversations.value[selectedIndex.value]?.ref ?? null;
    const retainedIndex = snap.conversations.findIndex((row) => sameConversation(row.ref, selected));
    conversations.value = snap.conversations;
    activity.value = snap.activity;
    selectedIndex.value = retainedIndex >= 0
      ? retainedIndex
      : Math.min(selectedIndex.value, Math.max(0, snap.conversations.length - 1));
    listError.value = null;
    listState.value = 'ready';
  }

  async function refresh(): Promise<void> {
    if (detached) return;
    const token = ++listToken;
    try {
      // A successful list alone must not hide a broken change subscription.
      await ensureSubscribed();
      if (detached) return;
      await Promise.all([
        refreshList(token),
        openRef.value ? loadDetail(openRef.value, true) : Promise.resolve(),
      ]);
    } catch (raw) {
      if (detached || token !== listToken) return;
      listError.value = toMailError(raw);
      listState.value = 'error';
    }
  }

  async function loadDetail(target: ConversationRef, background = false): Promise<void> {
    if (detached) return;
    const token = ++detailToken;
    if (!background) {
      // New object records explicit navigation independently of background refreshes.
      openRef.value = { ...target };
      conversation.value = null;
      detailState.value = 'loading';
      detailError.value = null;
    }
    try {
      const conv = await client.getConversation(target);
      if (detached || token !== detailToken || !sameConversation(openRef.value, target)) return;
      conversation.value = conv;
      detailState.value = 'ready';
      detailError.value = null;
    } catch (raw) {
      if (detached || token !== detailToken || !sameConversation(openRef.value, target)) return;
      detailError.value = toMailError(raw);
      detailState.value = 'error';
      conversation.value = null;
    }
  }

  function moveSelection(delta: number): void {
    if (conversations.value.length === 0) return;
    selectedIndex.value = Math.min(conversations.value.length - 1, Math.max(0, selectedIndex.value + delta));
  }

  function selectIndex(index: number): void {
    if (index >= 0 && index < conversations.value.length) selectedIndex.value = index;
  }

  async function openConversationByRef(target: ConversationRef): Promise<void> {
    await loadDetail(target);
  }

  async function openSelected(): Promise<void> {
    const summary = conversations.value[selectedIndex.value];
    if (summary) await loadDetail(summary.ref);
  }

  function closeReader(): void {
    detailToken += 1;
    openRef.value = null;
    conversation.value = null;
    detailState.value = 'idle';
    detailError.value = null;
  }

  async function setArchived(target: ConversationRef, archived: boolean): Promise<OperationReceipt | null> {
    const token = ++commandToken;
    const command: SetArchived = {
      conversation: { ...target },
      archived,
      requestId: crypto.randomUUID(),
    };
    inFlightCommandRef.value = command.conversation;
    try {
      const receipt = await client.setArchived(command);
      if (detached) return receipt;
      if (token === commandToken) lastCommandError.value = null;
      // Refetch both surfaces even if an event was delayed or missed.
      await refresh();
      return receipt;
    } catch (raw) {
      if (!detached && token === commandToken) lastCommandError.value = toMailError(raw);
      return null;
    } finally {
      if (!detached && token === commandToken) inFlightCommandRef.value = null;
    }
  }

  async function archiveSelected(): Promise<void> {
    const summary = conversations.value[selectedIndex.value];
    if (summary) await setArchived(summary.ref, true);
  }

  const ready = refresh();
  const onWindowFocus = (): void => { void refresh(); };
  const onReconnect = (): void => { void refresh(); };
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('online', onReconnect);

  onScopeDispose(() => {
    detached = true;
    listToken += 1;
    detailToken += 1;
    unsubscribe?.();
    unsubscribe = null;
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('online', onReconnect);
  });

  const selectedSummary = computed(() => conversations.value[selectedIndex.value] ?? null);
  return {
    conversations, activity, listState, listError, selectedIndex, selectedSummary,
    openRef, conversation, detailState, detailError, lastCommandError,
    inFlightCommandRef, ready, refresh, moveSelection, selectIndex,
    openConversationByRef, openSelected, closeReader, setArchived, archiveSelected,
  };
}
