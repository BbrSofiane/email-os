<script setup lang="ts">
/**
 * Operation activity (Slice 01).
 *
 * Shows every operation with its status and failure. Archived conversations remain
 * recoverable: rows expose Open (loads the referenced conversation even when it is
 * no longer in the inbox) and Unarchive (explicit user action with a fresh request
 * ID). Failures stay visible; they are never auto-replayed.
 */
import type { OperationSummaryLike } from '../composables/useMailbox';

defineProps<{
  activity: OperationSummaryLike[];
}>();

const emit = defineEmits<{
  open: [ref: OperationSummaryLike['conversation']];
  unarchive: [ref: OperationSummaryLike['conversation']];
}>();

function statusLabel(status: string, failure: { kind: string } | null): string {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'applying':
      return 'applying…';
    case 'confirmed':
      return 'confirmed';
    case 'failed':
      return `failed (${failure?.kind ?? 'unknown'})`;
    default:
      return status;
  }
}
</script>

<template>
  <aside class="activity" aria-label="Operation activity">
    <h2 class="activity-title">Activity</h2>
    <p v-if="activity.length === 0" data-test="activity-empty">No operations yet.</p>
    <ul class="activity-list">
      <li
        v-for="op in activity"
        :key="op.id"
        class="activity-row"
        :class="`status-${op.status}`"
        :data-test="`activity-${op.status}`"
      >
        <span class="activity-status">{{ statusLabel(op.status, op.failure) }}</span>
        <span class="activity-action">{{ op.requestedArchived ? 'archive' : 'unarchive' }}</span>
        <span class="activity-id">{{ op.conversation.conversationId }}</span>
        <span class="activity-buttons">
          <button type="button" :data-test="`activity-open-${op.id}`" @click="emit('open', op.conversation)">
            Open
          </button>
          <button
            v-if="op.requestedArchived"
            type="button"
            :data-test="`activity-unarchive-${op.id}`"
            @click="emit('unarchive', op.conversation)"
          >
            Unarchive
          </button>
        </span>
      </li>
    </ul>
  </aside>
</template>
