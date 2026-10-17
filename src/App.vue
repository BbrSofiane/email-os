<script setup lang="ts">
/**
 * Gmail mailbox shell: keyboard-first inbox, plain-text reader, operation recovery,
 * and explicit account/action capability gates.
 *
 * Account gate: the account status read decides fixture-vs-Gmail. While the status
 * is loading or failed, the UI renders no mailbox content at all — it never falls
 * back silently to fixture mode.
 *
 * Keyboard contract (window-level, one handler):
 * - j / ArrowDown, k / ArrowUp: move selection (list focus follows).
 * - Enter: open selected conversation. Escape: close reader.
 * - e: archive the selected (or reader-open) conversation when actions are enabled.
 * - Shift+U: explicitly mark the selected/open conversation unread.
 * - Ignored with Ctrl/Meta/Alt held, during IME composition, inside text fields, and
 *   Enter/e are ignored when a button owns the key (it activates itself).
 * While a draft editor exists, every mailbox shortcut is suppressed. Draft text has
 * no submit/send path and is rendered only as ordinary text.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import InboxList from './components/InboxList.vue';
import ReaderView from './components/ReaderView.vue';
import ActivityPanel from './components/ActivityPanel.vue';
import AccountPanel from './components/AccountPanel.vue';
import DraftsPanel from './components/DraftsPanel.vue';
import { BROWSER_PREVIEW_DISCLOSURE } from './lib/ipc/browser-fake';
import type { ClientMode } from './lib/ipc';
import type { DraftRef, DraftSource, MailClient } from './lib/ipc/client';
import { sameConversation, useMailbox } from './composables/useMailbox';
import { useDrafts } from './composables/useDrafts';

const props = defineProps<{
  client: MailClient;
  mode: ClientMode;
}>();

const mailbox = useMailbox(props.client);
const inboxList = ref<InstanceType<typeof InboxList> | null>(null);
const emptyState = ref<HTMLElement | null>(null);

const readerOpen = computed(() => mailbox.openRef.value !== null);
const gmailMode = computed(() => mailbox.isGmail.value);
const mailboxActionsEnabled = computed(() => !gmailMode.value || mailbox.accountStatus.value?.mutationAccess === 'enabled');
const gmailActionsEnabled = computed(() => gmailMode.value && mailboxActionsEnabled.value);
const accountReady = computed(() => mailbox.accountState.value === 'ready');
const accountStatus = computed(() => mailbox.accountStatus.value);
const accountId = computed(() => accountStatus.value?.account?.accountId ?? null);
const drafts = useDrafts(props.client, accountId, props.mode);

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function buttonOwns(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && typeof el.closest === 'function' && el.closest('button, a') !== null;
}

async function focusSelectedRow(): Promise<void> {
  await nextTick();
  if (mailbox.conversations.value.length) inboxList.value?.focusRow(mailbox.selectedIndex.value);
  else emptyState.value?.focus();
}

function moveSelection(delta: number): void {
  mailbox.moveSelection(delta);
  void focusSelectedRow();
}

async function openSelected(): Promise<void> {
  await mailbox.openSelected();
}

async function openRow(index: number): Promise<void> {
  mailbox.selectIndex(index);
  await mailbox.openSelected();
}

function closeReader(): void {
  mailbox.closeReader();
  void focusSelectedRow();
}

async function archiveFromList(): Promise<void> {
  await mailbox.archiveSelected();
  await focusSelectedRow();
}

async function archiveRowFromList(target: { accountId: string; conversationId: string }): Promise<void> {
  const listElement = inboxList.value?.$el;
  const hadListFocus = listElement instanceof HTMLElement && listElement.contains(document.activeElement);
  const receipt = await mailbox.setArchived(target, true);
  if (!receipt || !hadListFocus) return;
  const operation = mailbox.activity.value.find((item) => item.id === receipt.operationId);
  if (operation?.status === 'failed') return;
  const focused = document.activeElement;
  const currentList = inboxList.value?.$el;
  if (focused !== document.body && !(currentList instanceof HTMLElement && currentList.contains(focused))) return;
  await focusSelectedRow();
}

function currentReaderTarget() {
  const target = mailbox.conversation.value?.ref ?? null;
  if (mailbox.detailState.value !== 'ready' || mailbox.inFlightCommandRef.value) return null;
  return sameConversation(target, mailbox.openRef.value) ? target : null;
}

async function archiveFromReader(): Promise<void> {
  const target = currentReaderTarget();
  const opened = mailbox.openRef.value;
  if (!target) return;
  const receipt = await mailbox.setArchived(target, true);
  // A late receipt must not drag the user back after they navigate or close.
  if (!receipt || mailbox.openRef.value !== opened || mailbox.listState.value !== 'ready') return;
  const op = mailbox.activity.value.find((item) => item.id === receipt.operationId);
  if (op?.status === 'failed') return;
  if (mailbox.selectedSummary.value) await mailbox.openSelected();
  else closeReader();
}

async function unarchiveFromReader(): Promise<void> {
  const target = currentReaderTarget();
  if (target) await mailbox.setArchived(target, false);
}

async function unarchiveFromActivity(target: { accountId: string; conversationId: string }): Promise<void> {
  await mailbox.setArchived(target, false);
}

async function setReadFromList(target: { accountId: string; conversationId: string }, read: boolean): Promise<void> {
  if (!gmailActionsEnabled.value) return;
  await mailbox.setRead(target, read);
}

async function setReadFromReader(read: boolean): Promise<void> {
  if (!gmailActionsEnabled.value) return;
  const target = currentReaderTarget();
  if (target) await mailbox.setRead(target, read);
}

async function markUnread(): Promise<void> {
  if (!gmailActionsEnabled.value) return;
  if (readerOpen.value) {
    const target = currentReaderTarget();
    if (target) await mailbox.setRead(target, false);
    return;
  }
  const summary = mailbox.selectedSummary.value;
  if (summary) await mailbox.setRead(summary.ref, false);
}

async function retryFromActivity(operationId: string): Promise<void> {
  await mailbox.retryOperation(operationId);
}

async function disconnectAccount(): Promise<void> {
  if (drafts.transitioning.value) return;
  drafts.setTransitioning(true);
  try {
    if (await drafts.flushAndClose()) await mailbox.disconnectAccount();
  } finally {
    drafts.setTransitioning(false);
  }
}

async function connectAccount(): Promise<void> {
  if (drafts.transitioning.value) return;
  drafts.setTransitioning(true);
  try {
    if (await drafts.flushAndClose()) await mailbox.connectAccount();
  } finally {
    drafts.setTransitioning(false);
  }
}

async function prepareReply(source: DraftSource): Promise<void> {
  if (await drafts.openNew(source)) closeReader();
}

function openDraft(ref: DraftRef): void {
  void drafts.openDraft(ref);
}

function onKeydown(event: KeyboardEvent): void {
  if (drafts.activeRef.value) return; // composer owns all keys, regardless of focused element
  if (event.isComposing || event.keyCode === 229) return; // IME composition
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isEditableTarget(event.target)) return;

  const key = event.key;
  const readerIsOpen = readerOpen.value;

  if (key === 'Escape') {
    if (readerIsOpen) {
      event.preventDefault();
      closeReader();
    }
    return;
  }
  if (key === 'U' && event.shiftKey && !buttonOwns(event.target)) {
    event.preventDefault();
    void markUnread();
    return;
  }
  if (readerIsOpen) {
    if (key === 'e' && mailboxActionsEnabled.value && !buttonOwns(event.target)) {
      event.preventDefault();
      void archiveFromReader();
    }
    return;
  }

  switch (key) {
    case 'j':
    case 'ArrowDown':
      event.preventDefault();
      moveSelection(1);
      return;
    case 'k':
    case 'ArrowUp':
      event.preventDefault();
      moveSelection(-1);
      return;
    case 'Enter':
      if (buttonOwns(event.target)) return;
      event.preventDefault();
      void openSelected();
      return;
    case 'e':
      if (!mailboxActionsEnabled.value || buttonOwns(event.target)) return;
      event.preventDefault();
      void archiveFromList();
      return;
    default:
      return;
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});

const pendingCount = computed(
  () => mailbox.activity.value.filter((op) => op.status === 'queued' || op.status === 'applying' || op.status === 'outcome_unknown').length,
);

function errorText(error: { kind: string; field?: string }): string {
  switch (error.kind) {
    case 'not_found':
      return 'not found';
    case 'invalid_request':
      return `invalid request (field: ${error.field ?? '?'})`;
    case 'request_id_conflict':
      return 'request ID conflict';
    case 'storage_unavailable':
      return 'storage unavailable';
    case 'profile_in_use':
      return 'profile in use';
    case 'read_only':
      return 'read-only account';
    case 'not_configured':
      return 'not configured';
    case 'auth_required':
      return 'sign-in required';
    case 'auth_cancelled':
      return 'sign-in cancelled';
    case 'auth_failed':
      return 'sign-in failed';
    case 'secrets_unavailable':
      return 'credential storage unavailable';
    case 'network_unavailable':
      return 'network unavailable';
    case 'rate_limited':
      return 'rate limited';
    case 'provider_unavailable':
      return 'provider unavailable';
    case 'invalid_provider_response':
      return 'unexpected provider response';
    case 'busy':
      return 'busy';
    case 'permission_required':
      return 'Google permission required';
    case 'provider_rejected':
      return 'provider rejected action';
    case 'outcome_unknown':
      return 'provider outcome unknown';
    default:
      return 'unknown error';
  }
}
</script>

<template>
  <div class="app" :data-client-mode="props.mode">
    <header class="app-header">
      <h1>Email OS — Mailbox</h1>
      <p v-if="props.mode === 'browser-preview'" class="preview-banner" data-test="preview-banner" role="note">
        {{ BROWSER_PREVIEW_DISCLOSURE }}
      </p>
      <p class="status-line" data-test="status-line">
        <span>{{ mailbox.conversations.value.length }} in inbox</span>
        <span v-if="pendingCount > 0">{{ pendingCount }} pending operation(s)</span>
        <span v-if="gmailActionsEnabled" data-test="read-shortcut-note">Shift+U marks the selected or open conversation unread.</span>
        <span v-if="mailbox.lastCommandError.value" role="alert" data-test="command-error">
          last command failed: {{ errorText(mailbox.lastCommandError.value) }}
        </span>
      </p>
    </header>

    <div v-if="!accountId && (drafts.closeSetupError.value || drafts.closeRetryAvailable.value)" role="alert" class="draft-close-recovery">
      <p v-if="drafts.closeSetupError.value">Close protection could not be initialized: {{ drafts.closeSetupError.value }}</p>
      <p v-else>{{ drafts.closeError.value }}</p>
      <button v-if="drafts.closeSetupError.value" type="button" data-test="retry-close-setup" @click="drafts.retryCloseSetup()">Retry close protection</button>
      <button v-if="drafts.closeRetryAvailable.value" type="button" data-test="retry-close" @click="drafts.retryClose()">Retry close request</button>
    </div>

    <main class="app-main">
      <section v-if="!accountReady" class="account-gate" aria-label="Account">
        <p
          v-if="mailbox.accountState.value === 'loading' && mailbox.listState.value !== 'error'"
          data-test="account-loading"
        >Determining account mode…</p>
        <div v-else data-test="account-error">
          <p v-if="mailbox.accountState.value === 'error'" role="alert">
            Could not determine the account status:
            {{ mailbox.accountError.value ? errorText(mailbox.accountError.value) : 'unknown error' }}.
          </p>
          <p v-else role="alert">
            Could not subscribe to or load the inbox:
            {{ mailbox.listError.value ? errorText(mailbox.listError.value) : 'unknown error' }}.
          </p>
          <button type="button" data-test="account-retry" @click="mailbox.refresh()">Retry</button>
        </div>
      </section>
      <template v-else>
        <AccountPanel
          v-if="gmailMode && accountStatus"
          :status="accountStatus"
          :busy="mailbox.accountBusy.value"
          :transitioning="drafts.transitioning.value"
          :action-error="mailbox.lastCommandError.value"
          @connect="connectAccount()"
          @disconnect="disconnectAccount()"
          @sync="mailbox.requestSync()"
          @enable-actions="mailbox.enableMailboxActions()"
          @cancel-upgrade="mailbox.cancelMailboxActionUpgrade()"
        />
        <DraftsPanel
          v-if="accountId"
          :summaries="drafts.summaries.value"
          :active-ref="drafts.activeRef.value"
          :source="drafts.activeSource.value"
          :content="drafts.content.value"
          :status="drafts.statusLabel.value"
          :visible="drafts.isVisible.value"
          :suspended-editor="!!drafts.activeRef.value && !drafts.isVisible.value"
          :creating="drafts.creating.value"
          :saving="drafts.saving.value"
          :conflict="drafts.conflict.value"
          :error="drafts.error.value"
          :create-error="drafts.createError.value"
          :deleting="drafts.deleting.value"
          :closing="drafts.closingForWindow.value"
          :transitioning="drafts.transitioning.value"
          :delete-pending="drafts.deletePending.value"
          :confirm-discard="drafts.confirmDiscard.value"
          :confirm-reload="drafts.confirmReload.value"
          :copy-pending="drafts.copyPending.value"
          :can-cancel-reply-preparation="drafts.canCancelReplyPreparation.value"
          :list-error="drafts.listError.value"
          :subscription-error="drafts.draftSubscriptionError.value"
          :close-error="drafts.closeError.value"
          :close-retry-available="drafts.closeRetryAvailable.value"
          :close-setup-error="drafts.closeSetupError.value"
          @retry-draft-subscription="drafts.retryDraftSubscription()"
          @retry-close="drafts.retryClose()"
          @retry-close-setup="drafts.retryCloseSetup()"
          @new-draft="drafts.openNew()"
          @cancel-reply-preparation="drafts.cancelReplyPreparation()"
          @open-draft="openDraft"
          @close-editor="drafts.flushAndClose()"
          @set-field="drafts.setContent"
          @retry="drafts.retrySave()"
          @ask-discard="drafts.confirmDiscard.value = true"
          @confirm-discard="drafts.discard()"
          @cancel-discard="drafts.confirmDiscard.value = false"
          @ask-reload="drafts.confirmReload.value = true"
          @confirm-reload="drafts.reloadSaved()"
          @cancel-reload="drafts.cancelReload()"
          @save-as-new="drafts.saveAsNew()"
        />
        <section class="list-pane" aria-label="Inbox">
        <p v-if="mailbox.listState.value === 'loading'" data-test="inbox-loading">Loading inbox…</p>
        <div v-else-if="mailbox.listState.value === 'error'" data-test="inbox-error">
          <p role="alert">Could not load the inbox: {{ mailbox.listError.value ? errorText(mailbox.listError.value) : 'unknown error' }}.</p>
          <button type="button" data-test="inbox-retry" @click="mailbox.refresh()">Retry</button>
        </div>
        <p
          v-else-if="mailbox.conversations.value.length === 0"
          data-test="inbox-empty"
          ref="emptyState"
          tabindex="-1"
        >
          No conversations are currently in the inbox. Archived conversations stay recoverable from Activity.
        </p>
        <InboxList
          v-else
          ref="inboxList"
          :rows="mailbox.conversations.value"
          :selected-index="mailbox.selectedIndex.value"
          :actions-enabled="mailboxActionsEnabled"
          :show-read-state="gmailMode"
          :show-read-controls="gmailActionsEnabled"
          @select="mailbox.selectIndex($event)"
          @open="openRow"
          @archive="archiveRowFromList"
          @set-read="setReadFromList"
        />
      </section>

      <section v-if="readerOpen" class="reader-pane" aria-label="Reader">
        <ReaderView
          :conversation="mailbox.conversation.value"
          :state="mailbox.detailState.value"
          :error="mailbox.detailError.value"
          :command-in-flight="mailbox.inFlightCommandRef.value !== null"
          :read-only="gmailMode && !mailboxActionsEnabled"
          :show-read-controls="gmailActionsEnabled"
          @close="closeReader"
          @archive="archiveFromReader"
          @unarchive="unarchiveFromReader"
          @set-read="setReadFromReader"
          @prepare-reply="prepareReply"
        />
      </section>

      <ActivityPanel
        :activity="mailbox.activity.value"
        :actions-enabled="mailboxActionsEnabled"
        :gmail-mode="gmailMode"
        @open="mailbox.openConversationByRef($event)"
        @unarchive="unarchiveFromActivity"
        @retry="retryFromActivity"
      />
      </template>
    </main>
  </div>
</template>
