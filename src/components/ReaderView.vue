<script setup lang="ts">
/**
 * Plain-text reader (Slice 01). Opening is read-only.
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
        v-if="props.state === 'ready' && props.conversation"
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
