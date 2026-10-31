<script setup lang="ts">
/**
 * Single-slot notification for the latest accepted conversation action (UX-04).
 *
 * - Replaced, never stacked: the parent passes one slot or null.
 * - `role="status"` + polite live region; rendered in normal document flow so it
 *   never covers the focused row or the reader back path.
 * - Status text is derived from the matching Activity row on every refresh —
 *   the notice never invents a provider outcome.
 * - The Undo button and Z hint are advisory only: they hide after the window
 *   passes, but the backend's typed `undo_unavailable` decision stays the
 *   authority and is surfaced through the same slot.
 */
import { computed } from 'vue';
import type { OperationSummaryLike } from '../composables/useMailbox';

const props = defineProps<{
  /** Null renders an empty live region so slot replacement stays announceable. */
  notice: {
    /** Human label of the performed action, e.g. "Mark Done (Archive)". */
    label: string;
    subject: string;
    operation: OperationSummaryLike | null;
    /** ISO deadline from the refreshed activity row; null when not undoable. */
    undoableUntil: string | null;
  } | null;
  /** Advisory wall-clock milliseconds (App-owned timer); the backend decides eligibility. */
  now: number;
}>();

const emit = defineEmits<{ undo: [] }>();

const UNDO_EXPIRED_TEXT = 'Undo expired — Mark Not Done restores the whole conversation to Inbox';

const statusText = computed(() => {
  const status = props.notice?.operation?.status;
  switch (status) {
    case 'queued':
    case 'applying':
      return 'Accepted locally, not yet confirmed';
    case 'confirmed':
      return 'Confirmed';
    case 'failed':
      return 'Failed — restored, see Activity';
    case 'outcome_unknown':
      return 'Outcome unknown — see Activity';
    case 'cancelled':
      return 'Cancelled';
    default:
      // The Activity row has not landed yet; acceptance is the only known fact.
      return 'Accepted locally, not yet confirmed';
  }
});

const undoVisible = computed(() => {
  const until = props.notice?.undoableUntil;
  if (!until) return false;
  return Date.parse(until) > props.now;
});

const undoExpired = computed(() => {
  const status = props.notice?.operation?.status;
  return !undoVisible.value && (status === 'queued' || status === 'applying' || status === 'confirmed');
});

const truncatedSubject = computed(() => {
  const subject = props.notice?.subject ?? '';
  return subject.length > 60 ? `${subject.slice(0, 60)}…` : subject;
});
</script>

<template>
  <div class="action-notice" role="status" aria-live="polite" data-test="action-notice">
    <template v-if="notice">
      <p class="action-notice-text" data-test="action-notice-text">
        <span class="action-notice-label" data-test="action-notice-label">{{ notice.label }} · {{ truncatedSubject }}</span>
        <span class="action-notice-status" data-test="action-notice-status">{{ statusText }}</span>
        <span v-if="undoExpired" class="action-notice-expired" data-test="action-notice-expired">{{ UNDO_EXPIRED_TEXT }}</span>
      </p>
      <span v-if="undoVisible" class="action-notice-undo">
        <button type="button" data-test="action-notice-undo" @click="emit('undo')">Undo</button>
        <kbd data-test="action-notice-hint">Z</kbd>
      </span>
    </template>
  </div>
</template>
