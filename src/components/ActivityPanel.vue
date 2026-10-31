<script setup lang="ts">
/**
 * Operation activity and explicit recovery controls.
 *
 * Shows every operation with its status and failure. Archived conversations remain
 * recoverable: rows expose Open (loads the referenced conversation even when it is
 * no longer in the inbox) and Unarchive (explicit user action with a fresh request
 * ID). Failures stay visible; they are never auto-replayed.
 *
 * Gmail recovery controls are gated by the authoritative mailbox-action capability.
 */
import type { OperationSummaryLike } from '../composables/useMailbox';

defineProps<{
  activity: OperationSummaryLike[];
  /** Whether authoritative status currently permits mailbox commands. */
  actionsEnabled?: boolean;
  /** Retry is a durable Gmail operation and is unavailable in fixture mode. */
  gmailMode?: boolean;
}>();

const emit = defineEmits<{
  open: [ref: OperationSummaryLike['conversation']];
  unarchive: [ref: OperationSummaryLike['conversation']];
  retry: [operationId: string];
}>();

function statusLabel(status: string, failure: { kind: string } | null): string {
  switch (status) {
    case 'queued': return 'queued';
    case 'applying': return 'applying…';
    case 'confirmed': return 'confirmed';
    case 'failed': return `failed (${failure?.kind ?? 'unknown'})`;
    case 'outcome_unknown': return 'outcome unknown';
    case 'cancelled': return 'Cancelled by Undo';
    default: return status;
  }
}

function actionLabel(op: OperationSummaryLike): string {
  if (op.kind === 'read') return op.requestedRead === true ? 'mark read' : op.requestedRead === false ? 'mark unread' : 'read state change';
  return op.requestedArchived ? 'archive' : 'unarchive';
}

function errorLabel(kind: string): string {
  switch (kind) {
    case 'permission_required': return 'Google permission is not enabled.';
    case 'provider_rejected': return 'The provider rejected the requested state.';
    case 'provider_unavailable': return 'The provider was unavailable; this is not a confirmed result.';
    case 'outcome_unknown': return 'The request may have reached Google, but its result could not be confirmed.';
    case 'auth_required': return 'Sign-in is required before this action can run.';
    case 'rate_limited': return 'Google rate limited this action; it can be retried.';
    case 'network_unavailable': return 'The network was unavailable.';
    case 'storage_unavailable': return 'Local storage failed; the action was not confirmed.';
    default: return `Action error: ${kind}.`;
  }
}

function canRetry(status: string): boolean {
  return status === 'failed' || status === 'outcome_unknown';
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
        <span class="activity-action">{{ actionLabel(op) }}</span>
        <span v-if="op.undoOf" class="activity-undo-of" :data-test="`activity-undo-of-${op.id}`">Undo of {{ op.undoOf }}</span>
        <span class="activity-id">{{ op.conversation.conversationId }}</span>
        <p v-if="op.lastError" class="activity-error" data-test="activity-error">{{ errorLabel(op.lastError.kind) }}</p>
        <p v-if="op.status === 'outcome_unknown'" class="activity-warning" data-test="activity-unknown-warning">
          Verify current mailbox state first. Retrying may override the current state.
        </p>
        <span class="activity-buttons">
          <button type="button" :data-test="`activity-open-${op.id}`" @click="emit('open', op.conversation)">
            Open
          </button>
          <button
            v-if="(op.kind === undefined || op.kind === 'archive') && op.requestedArchived && op.status !== 'cancelled' && actionsEnabled"
            type="button"
            :data-test="`activity-unarchive-${op.id}`"
            @click="emit('unarchive', op.conversation)"
          >
            Unarchive
          </button>
          <button
            v-if="gmailMode && actionsEnabled && canRetry(op.status)"
            type="button"
            :data-test="`activity-retry-${op.id}`"
            @click="emit('retry', op.id)"
          >
            Retry with a new request ID
          </button>
        </span>
      </li>
    </ul>
  </aside>
</template>
