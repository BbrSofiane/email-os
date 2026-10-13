<script setup lang="ts">
/**
 * Plain-text reader (Slices 01 + 02). Opening is read-only — never marks read.
 *
 * Slice 02: in Gmail mode the archive toggle is hidden entirely (`readOnly`), and
 * Gmail-supplied plain-text limitations are disclosed explicitly (`unsupportedReason`,
 * `contextComplete === false`) instead of silently dropping content.
 *
 * Safety: message content is rendered exclusively through text interpolation
 * ({{ }}). No v-html, no markdown/HTML processing, no remote assets anywhere in
 * this slice — hostile markup stays literal text.
 */
import { nextTick, ref, watch } from 'vue';
import type { Conversation, MailError } from '../lib/ipc/client';
import type { DetailState } from '../composables/useMailbox';

const props = defineProps<{
  conversation: Conversation | null;
  state: DetailState;
  error: MailError | null;
  commandInFlight: boolean;
  /** Gmail mode: archive/unarchive controls are hidden, not just disabled. */
  readOnly?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  archive: [];
  unarchive: [];
}>();

const container = ref<HTMLElement | null>(null);

function describeError(error: MailError): string {
  switch (error.kind) {
    case 'not_found':
      return 'That conversation is no longer available.';
    case 'invalid_request':
      return `The request was rejected (invalid field: ${error.field}).`;
    case 'request_id_conflict':
      return 'The request conflicted with an earlier request ID.';
    case 'storage_unavailable':
      return 'Local storage is unavailable. The operation was not confirmed.';
    case 'profile_in_use':
      return 'Another window is using this profile.';
    case 'read_only':
      return 'Gmail is read-only; archiving is unavailable.';
    case 'not_configured':
      return 'Gmail is not configured on this device.';
    case 'auth_required':
      return 'Sign-in is required; cached conversations stay readable.';
    case 'auth_cancelled':
      return 'Sign-in was cancelled.';
    case 'auth_failed':
      return 'Sign-in failed. Cached conversations stay readable.';
    case 'secrets_unavailable':
      return 'Secure credential storage is unavailable.';
    case 'network_unavailable':
      return 'The network is unavailable; cached conversations stay readable.';
    case 'rate_limited':
      return 'The provider is rate limiting. Cached conversations stay readable.';
    case 'provider_unavailable':
      return 'The mail provider is temporarily unavailable.';
    case 'invalid_provider_response':
      return 'The provider returned an unexpected response.';
    case 'busy':
      return 'A sync is already in progress. Try again shortly.';
    default:
      return 'Could not load the conversation.';
  }
}

watch(
  () => props.conversation?.ref.conversationId,
  async (id, previousId) => {
    // A background status refresh must not steal focus from the toolbar/activity.
    if (id && id !== previousId && props.state === 'ready') {
      await nextTick();
      container.value?.focus();
    }
  },
);
</script>

<template>
  <article
    class="reader"
    tabindex="-1"
    aria-label="Conversation reader"
    data-test="reader"
    ref="container"
  >
    <div class="reader-toolbar">
      <button type="button" data-test="reader-close" @click="emit('close')">Close (Esc)</button>
      <button
        v-if="!props.readOnly && props.state === 'ready' && props.conversation"
        type="button"
        data-test="reader-archive-toggle"
        :disabled="props.commandInFlight"
        @click="props.conversation.isInInbox ? emit('archive') : emit('unarchive')"
      >
        {{ props.conversation.isInInbox ? 'Archive (e)' : 'Unarchive' }}
      </button>
    </div>

    <p v-if="props.state === 'loading'" data-test="reader-loading">Loading conversation…</p>
    <p v-else-if="props.state === 'error' && props.error" data-test="reader-error" role="alert">
      {{ describeError(props.error) }}
    </p>
    <template v-else-if="props.conversation">
      <h2 class="reader-subject">{{ props.conversation.subject }}</h2>
      <p v-if="props.readOnly" class="reader-readonly" data-test="reader-readonly" role="note">
        Read-only Gmail view: messages are never marked as read.
      </p>
      <p
        v-if="props.conversation.unsupportedReason"
        data-test="unsupported-notice"
        class="reader-notice"
        role="note"
      >
        Some content is not shown: {{ props.conversation.unsupportedReason }}
      </p>
      <p
        v-else-if="props.conversation.contextComplete === false"
        data-test="context-incomplete"
        class="reader-notice"
        role="note"
      >
        This cached conversation may be incomplete; some context was unavailable in plain text.
      </p>
      <p v-if="props.conversation.pendingOperationId" data-test="reader-pending" class="reader-pending">
        A pending archive operation is being applied to this conversation.
      </p>
      <ol class="messages">
        <li v-for="message in props.conversation.messages" :key="message.id" class="message">
          <header class="message-header">
            <span class="message-from">{{ message.from.displayName ?? message.from.mailbox }}</span>
            <span class="message-to">to {{ message.to.map((t) => t.displayName ?? t.mailbox).join(', ') }}</span>
            <time class="message-time">{{ message.sentAt }}</time>
          </header>
          <div class="message-body">{{ message.bodyText }}</div>
        </li>
      </ol>
    </template>
  </article>
</template>
