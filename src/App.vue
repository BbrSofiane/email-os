<script setup lang="ts">
/**
 * Slice 01 shell: keyboard-first fixture inbox, plain-text reader, durable activity.
 *
 * Keyboard contract (window-level, one handler):
 * - j / ArrowDown, k / ArrowUp: move selection (list focus follows).
 * - Enter: open selected conversation. Escape: close reader.
 * - e: archive the selected (or, while the reader is open, the open) conversation.
 * - Ignored with Ctrl/Meta/Alt held, during IME composition, inside text fields, and
 *   Enter/e are ignored when a button owns the key (it activates itself).
 * No composer, drafts, sending, search, or HTML rendering in this slice.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import InboxList from './components/InboxList.vue';
import ReaderView from './components/ReaderView.vue';
import ActivityPanel from './components/ActivityPanel.vue';
import { BROWSER_PREVIEW_DISCLOSURE } from './lib/ipc/browser-fake';
import type { ClientMode } from './lib/ipc';
import type { MailClient } from './lib/ipc/client';
import { sameConversation, useMailbox } from './composables/useMailbox';

const props = defineProps<{
  client: MailClient;
  mode: ClientMode;
}>();

const mailbox = useMailbox(props.client);
const inboxList = ref<InstanceType<typeof InboxList> | null>(null);
const emptyState = ref<HTMLElement | null>(null);

const readerOpen = computed(() => mailbox.openRef.value !== null);

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

function onKeydown(event: KeyboardEvent): void {
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
  if (readerIsOpen) {
    if (key === 'e' && !buttonOwns(event.target)) {
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
      if (buttonOwns(event.target)) return;
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
  () => mailbox.activity.value.filter((op) => op.status === 'queued' || op.status === 'applying').length,
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
    default:
      return 'unknown error';
  }
}
</script>

<template>
  <div class="app" :data-client-mode="props.mode">
    <header class="app-header">
      <h1>Email OS — Slice 01</h1>
      <p v-if="props.mode === 'browser-preview'" class="preview-banner" data-test="preview-banner" role="note">
        {{ BROWSER_PREVIEW_DISCLOSURE }}
      </p>
      <p class="status-line" data-test="status-line">
        <span>{{ mailbox.conversations.value.length }} in inbox</span>
        <span v-if="pendingCount > 0">{{ pendingCount }} pending operation(s)</span>
        <span v-if="mailbox.lastCommandError.value" role="alert" data-test="command-error">
          last command failed: {{ errorText(mailbox.lastCommandError.value) }}
        </span>
      </p>
    </header>

    <main class="app-main">
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
          Inbox is empty. Archived conversations stay recoverable from Activity.
        </p>
        <InboxList
          v-else
          ref="inboxList"
          :rows="mailbox.conversations.value"
          :selected-index="mailbox.selectedIndex.value"
          @select="mailbox.selectIndex($event)"
          @open="openRow"
        />
      </section>

      <section v-if="readerOpen" class="reader-pane" aria-label="Reader">
        <ReaderView
          :conversation="mailbox.conversation.value"
          :state="mailbox.detailState.value"
          :error="mailbox.detailError.value"
          :command-in-flight="mailbox.inFlightCommandRef.value !== null"
          @close="closeReader"
          @archive="archiveFromReader"
          @unarchive="unarchiveFromReader"
        />
      </section>

      <ActivityPanel
        :activity="mailbox.activity.value"
        @open="mailbox.openConversationByRef($event)"
        @unarchive="unarchiveFromActivity"
      />
    </main>
  </div>
</template>
