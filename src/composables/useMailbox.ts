/** Core read models are authoritative; events only request another snapshot. */
import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue';
import type {
  AccountStatus,
  Conversation,
  ConversationRef,
  InboxSnapshot,
  MailClient,
  MailError,
  MailMode,
  OperationReceipt,
} from '../lib/ipc/client';
import { toMailError } from '../lib/ipc/client';

export type ListState = 'loading' | 'ready' | 'error';
export type DetailState = 'idle' | 'loading' | 'ready' | 'error';
export type AccountState = 'loading' | 'ready' | 'error';
export type AccountAction = 'connect' | 'disconnect' | 'sync' | 'enable-actions' | 'cancel-upgrade';
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
  /** Authoritative account/mode status; `null` until the first status read lands. */
  accountStatus: Ref<AccountStatus | null>;
  accountState: Ref<AccountState>;
  accountError: Ref<MailError | null>;
  accountBusy: Ref<AccountAction | null>;
  /** Mode from the last accepted status; `null` while unknown (UI must fail closed). */
  mode: ComputedRef<MailMode | null>;
  isGmail: ComputedRef<boolean>;
  ready: Promise<void>;
  refresh(): Promise<void>;
  connectAccount(): Promise<void>;
  disconnectAccount(): Promise<void>;
  requestSync(): Promise<void>;
  moveSelection(delta: number): void;
  selectIndex(index: number): void;
  openConversationByRef(ref: ConversationRef): Promise<void>;
  openSelected(): Promise<void>;
  closeReader(): void;
  setArchived(target: ConversationRef, archived: boolean): Promise<OperationReceipt | null>;
  setRead(target: ConversationRef, read: boolean): Promise<OperationReceipt | null>;
  retryOperation(operationId: string): Promise<OperationReceipt | null>;
  enableMailboxActions(): Promise<void>;
  cancelMailboxActionUpgrade(): Promise<void>;
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
  const accountStatus = ref<AccountStatus | null>(null);
  const accountState = ref<AccountState>('loading');
  const accountError = ref<MailError | null>(null);
  const accountBusy = ref<AccountAction | null>(null);

  let listToken = 0;
  let detailToken = 0;
  let commandToken = 0;
  let mailboxSessionToken = 0;
  let statusToken = 0;
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

  /** Status failures never reject: the UI gate renders them and stays fail-closed. */
  async function refreshStatus(token: number): Promise<void> {
    try {
      const status = await client.getAccountStatus();
      if (detached || token !== statusToken) return;
      accountStatus.value = status;
      accountError.value = null;
      accountState.value = 'ready';
    } catch (raw) {
      if (detached || token !== statusToken) return;
      accountError.value = toMailError(raw);
      accountState.value = 'error';
    }
  }

  async function refresh(): Promise<void> {
    if (detached) return;
    const token = ++listToken;
    try {
      // Subscription-before-read: events are registered before any status/list/detail
      // read so a change occurring mid-refresh cannot be lost. A successful list alone
      // must not hide a broken change subscription.
      await ensureSubscribed();
      if (detached) return;
      // Status failures are handled inside refreshStatus (the UI gate renders them
      // fail-closed); list/detail failures reject into the catch below.
      await Promise.all([
        refreshStatus(++statusToken),
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

  async function connectAccount(): Promise<void> {
    if (accountBusy.value) return;
    accountBusy.value = 'connect';
    // Mirror core: connecting flips the connection optimistically; a failure is
    // corrected by the status refetch below.
    if (accountStatus.value) {
      accountStatus.value = { ...accountStatus.value, connection: 'authenticating' };
    }
    try {
      await client.connectAccount();
      if (!detached) await refresh();
    } catch (raw) {
      if (!detached) {
        lastCommandError.value = toMailError(raw);
        await refreshStatus(++statusToken);
      }
    } finally {
      if (!detached) accountBusy.value = null;
    }
  }

  async function disconnectAccount(): Promise<void> {
    if (accountBusy.value) return;
    accountBusy.value = 'disconnect';
    try {
      // Resolves only after core deleted credentials and cleared local data.
      await client.disconnectAccount();
    } catch (raw) {
      if (!detached) lastCommandError.value = toMailError(raw);
      return;
    } finally {
      if (!detached) accountBusy.value = null;
    }
    if (detached) return;
    // Drop every cached surface immediately and invalidate in-flight reads so stale
    // responses cannot repopulate the UI after a disconnect.
    closeReader();
    listToken += 1;
    detailToken += 1;
    commandToken += 1;
    mailboxSessionToken += 1;
    inFlightCommandRef.value = null;
    conversations.value = [];
    activity.value = [];
    selectedIndex.value = 0;
    if (accountStatus.value) {
      const sync = accountStatus.value.sync;
      accountStatus.value = {
        ...accountStatus.value,
        connection: 'disconnected',
        account: null,
        sync: { ...sync, state: 'idle', error: null, lastSyncedAt: null, cachedConversations: 0, initialSyncComplete: false },
      };
    }
    await refresh();
  }

  async function requestSync(): Promise<void> {
    if (accountBusy.value) return;
    accountBusy.value = 'sync';
    try {
      // Acceptance, not completion; progress arrives via status changes/events.
      await client.requestSync();
      if (!detached) await refresh();
    } catch (raw) {
      if (!detached) lastCommandError.value = toMailError(raw);
    } finally {
      if (!detached) accountBusy.value = null;
    }
  }

  function mutationsAllowed(): boolean {
    if (accountState.value !== 'ready' || !accountStatus.value) {
      lastCommandError.value = { kind: 'invalid_request', field: 'accountStatus' };
      return false;
    }
    if (accountStatus.value.mode === 'gmail' && accountStatus.value.mutationAccess !== 'enabled') {
      lastCommandError.value = { kind: 'read_only' };
      return false;
    }
    return true;
  }

  async function submitMutation(
    send: (requestId: string) => Promise<OperationReceipt>,
    target: ConversationRef | null,
  ): Promise<OperationReceipt | null> {
    if (!mutationsAllowed()) return null;
    const token = ++commandToken;
    const sessionToken = mailboxSessionToken;
    inFlightCommandRef.value = target ? { ...target } : null;
    try {
      const receipt = await send(crypto.randomUUID());
      if (detached || sessionToken !== mailboxSessionToken) return receipt;
      if (token === commandToken) lastCommandError.value = null;
      // A successful receipt is authoritative acceptance even if a newer
      // command owns the error slot. Events are best-effort, so refresh this
      // account session rather than dropping the older accepted operation.
      await refresh();
      return receipt;
    } catch (raw) {
      if (!detached && sessionToken === mailboxSessionToken && token === commandToken) {
        lastCommandError.value = toMailError(raw);
      }
      return null;
    } finally {
      if (!detached && sessionToken === mailboxSessionToken && token === commandToken) {
        inFlightCommandRef.value = null;
      }
    }
  }

  async function setArchived(target: ConversationRef, archived: boolean): Promise<OperationReceipt | null> {
    return submitMutation(
      (requestId) => client.setArchived({ conversation: { ...target }, archived, requestId }),
      target,
    );
  }

  async function setRead(target: ConversationRef, read: boolean): Promise<OperationReceipt | null> {
    if (accountStatus.value?.mode !== 'gmail') {
      lastCommandError.value = { kind: 'read_only' };
      return null;
    }
    return submitMutation(
      (requestId) => client.setRead({ conversation: { ...target }, read, requestId }),
      target,
    );
  }

  async function retryOperation(operationId: string): Promise<OperationReceipt | null> {
    if (mode.value !== 'gmail') {
      lastCommandError.value = { kind: 'invalid_request', field: 'mode' };
      return null;
    }
    return submitMutation(
      (requestId) => client.retryOperation({ operationId, requestId }),
      null,
    );
  }

  async function enableMailboxActions(): Promise<void> {
    if (accountBusy.value || accountState.value !== 'ready' || accountStatus.value?.mode !== 'gmail' || accountStatus.value.mutationAccess === 'enabled') return;
    accountBusy.value = 'enable-actions';
    lastCommandError.value = null;
    try {
      // This command only accepts/enqueues an explicit OAuth upgrade. Enabled state
      // comes exclusively from a later authoritative account-status read.
      await client.enableMailboxActions();
      if (!detached) await refreshStatus(++statusToken);
    } catch (raw) {
      if (!detached) {
        lastCommandError.value = toMailError(raw);
        await refreshStatus(++statusToken);
      }
    } finally {
      if (!detached) accountBusy.value = null;
    }
  }

  async function cancelMailboxActionUpgrade(): Promise<void> {
    if (accountBusy.value || accountState.value !== 'ready' || accountStatus.value?.mutationAccess !== 'upgrading') return;
    accountBusy.value = 'cancel-upgrade';
    lastCommandError.value = null;
    try {
      await client.cancelMailboxActionUpgrade();
      if (!detached) await refreshStatus(++statusToken);
    } catch (raw) {
      if (!detached) {
        lastCommandError.value = toMailError(raw);
        await refreshStatus(++statusToken);
      }
    } finally {
      if (!detached) accountBusy.value = null;
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
  const mode = computed<MailMode | null>(() => accountStatus.value?.mode ?? null);
  const isGmail = computed(() => mode.value === 'gmail');
  return {
    conversations, activity, listState, listError, selectedIndex, selectedSummary,
    openRef, conversation, detailState, detailError, lastCommandError,
    inFlightCommandRef, ready, refresh, moveSelection, selectIndex,
    openConversationByRef, openSelected, closeReader, setArchived, setRead, retryOperation,
    enableMailboxActions, cancelMailboxActionUpgrade, archiveSelected,
    accountStatus, accountState, accountError, accountBusy, mode, isGmail,
    connectAccount, disconnectAccount, requestSync,
  };
}
