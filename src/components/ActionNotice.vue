<script setup lang="ts">
/**
 * Single-slot notification for the latest accepted conversation action (UX-04).
 *
 * - Replaced, never stacked: the parent passes one slot or null.
 * - `role="status"` + polite live region; rendered in normal document flow so it
 *   never covers the focused row or the reader back path. The region stays
 *   mounted when empty (zero height, never `display:none`) so announcements are
 *   not dropped when content is inserted.
 * - Status text is derived from the matching Activity row on every refresh —
 *   the notice never invents a provider outcome. After a successful undo the
 *   parent reports the outcome (cancelled or the compensating rows) through
 *   `undone`, and the notice says Cancelled / Restored / the failure or
 *   uncertainty explicitly.
 * - The Undo button and Z hint are advisory only: they hide after the window
 *   passes, but the backend's typed `undo_unavailable` decision stays the
 *   authority and is surfaced through the same slot.
 */
import { computed } from 'vue';
import type { LastActionId, OperationSummaryLike } from '../composables/useMailbox';
import type { UndoOutcome } from '../lib/ipc/client';

const props = defineProps<{
  /** Null renders an empty live region so slot replacement stays announceable. */
  notice: {
    /** Human label of the performed action, e.g. "Mark Done (Archive)". */
    label: string;
    /** The setter action performed; selects the expired-recovery clause. */
    actionId: LastActionId;
    /** Subject when known; omitted (never a raw id) when unknown. */
    subject: string | null;
    operation: OperationSummaryLike | null;
    /** ISO deadline from the refreshed activity row; null when not undoable. */
    undoableUntil: string | null;
    /** True once this action had an undo window; gates the expired wording. */
    hadWindow: boolean;
    /** Set after a successful undo: outcome plus the refreshed compensating rows. */
    undone: { outcome: UndoOutcome; compensations: OperationSummaryLike[] } | null;
  } | null;
  /** Advisory wall-clock milliseconds (App-owned timer); the backend decides eligibility. */
  now: number;
}>();

const emit = defineEmits<{ undo: [] }>();

/** Recovery clause after an expired window, per the action that was undone. */
const UNDO_EXPIRED_RECOVERY: Record<LastActionId, string> = {
  archive: 'Mark Not Done restores the whole conversation to Inbox',
  unarchive: 'Mark Done archives the whole conversation',
  read: 'use the opposite read control',
  unread: 'use the opposite read control',
};

const statusText = computed(() => {
  const undone = props.notice?.undone ?? null;
  if (undone) {
    if (undone.outcome === 'cancelled') return 'Cancelled';
    const statuses = undone.compensations.map((op) => op.status);
    if (statuses.includes('failed')) return 'Restore failed — see Activity';
    if (statuses.includes('outcome_unknown')) return 'Restore outcome unknown — see Activity';
    if (statuses.length > 0 && statuses.every((status) => status === 'confirmed')) return 'Restored';
    // Compensations not landed/confirmed yet (or not visible in activity yet).
    return 'Restoring…';
  }
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
  if (!until || props.notice?.undone) return false;
  return Date.parse(until) > props.now;
});

const undoExpired = computed(() => {
  const status = props.notice?.operation?.status;
  // Never after an undo: the original op row can stay `confirmed` while the
  // compensations fail — the failure wording, not expiry, is the story then.
  return !props.notice?.undone && !!props.notice?.hadWindow && !undoVisible.value
    && (status === 'queued' || status === 'applying' || status === 'confirmed');
});

const undoExpiredText = computed(() => {
  const actionId = props.notice?.actionId ?? 'archive';
  return `Undo expired — ${UNDO_EXPIRED_RECOVERY[actionId]}`;
});

const truncatedSubject = computed(() => {
  const subject = props.notice?.subject ?? '';
  return subject.length > 60 ? `${subject.slice(0, 60)}…` : subject;
});
</script>

<template>
  <div
    class="action-notice"
    :class="{ 'action-notice-empty': !notice }"
    role="status"
    aria-live="polite"
    data-test="action-notice"
  >
    <template v-if="notice">
      <p class="action-notice-text" data-test="action-notice-text">
        <span class="action-notice-label" data-test="action-notice-label">
          {{ notice.label }}<template v-if="notice.subject"> · {{ truncatedSubject }}</template>
        </span>
        <span class="action-notice-status" data-test="action-notice-status">{{ statusText }}</span>
        <span v-if="undoExpired" class="action-notice-expired" data-test="action-notice-expired">{{ undoExpiredText }}</span>
      </p>
      <span v-if="undoVisible" class="action-notice-undo">
        <button type="button" data-test="action-notice-undo" @click="emit('undo')">Undo</button>
        <kbd data-test="action-notice-hint">Z</kbd>
      </span>
    </template>
  </div>
</template>
