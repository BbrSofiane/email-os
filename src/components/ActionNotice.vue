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

/** Skip-reason wording for partial group Undo results (UX-05 §5). */
const SKIP_REASON_LABELS: Record<string, string> = {
  acceptance_rejected: 'rejected at acceptance',
  failed: 'failed',
  outcome_unknown: 'outcome unknown',
  unknown_prior: 'unknown prior state',
  already_undone: 'already undone',
};

export interface GroupNoticeView {
  count: number;
  /** Authoritative per-status member counts (accepted ≠ succeeded). */
  counts: { pending: number; confirmed: number; failed: number; rejected: number; unknown: number; cancelled: number };
  /** True while acceptance itself is unresolved (lost response, not yet committed). */
  acceptanceUnknown: boolean;
  /** True once any authoritative member status has landed. */
  statusKnown: boolean;
  /** ISO group-undo deadline from authoritative state; null when not undoable. */
  undoableUntil: string | null;
  hadWindow: boolean;
  /** True when the latest authoritative member-status read FAILED (distinct
   * from absence — never rendered as "Accepting…"). */
  statusError: boolean;
  /** Per-member group Undo outcomes, once the one attempt is accepted. */
  undone: {
    cancelled: number;
    compensating: number;
    skipped: number;
    skipReasons: Record<string, number>;
    /** CURRENT compensation outcomes, tracked separately from the original
     * execution statuses; a failed restoration is never hidden behind
     * permanent "restoring…" wording (§5/§6). */
    compensationOutcomes: { confirmed: number; failed: number; unknown: number; pending: number };
  } | null;
}

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
    /** Present when the slot holds a bulk group action instead of a single. */
    group?: GroupNoticeView | null;
  } | null;
  /** Advisory wall-clock milliseconds (App-owned timer); the backend decides eligibility. */
  now: number;
}>();

const emit = defineEmits<{ undo: []; undoGroup: []; dismissGroup: [] }>();

const isGroup = computed(() => !!props.notice?.group);

/** Group status text: aggregate wording never hides partial failure (§6). */
const groupStatusText = computed(() => {
  const group = props.notice?.group ?? null;
  if (!group) return '';
  if (group.acceptanceUnknown) return 'Acceptance not yet known';
  if (group.statusError && !group.statusKnown) return 'Status check failed — will retry on next refresh';
  if (!group.statusKnown) return 'Accepting…';
  if (group.undone) {
    const undoneCount = group.undone.cancelled + group.undone.compensating;
    const reasonEntries = Object.entries(group.undone.skipReasons).filter(([, n]) => n > 0);
    const skipText = group.undone.skipped === 1 && reasonEntries.length === 1
      ? `1 skipped — ${SKIP_REASON_LABELS[reasonEntries[0]![0]!] ?? reasonEntries[0]![0]!}`
      : `${group.undone.skipped} skipped${reasonEntries.length ? ` — ${reasonEntries.map(([reason, n]) => `${n} ${SKIP_REASON_LABELS[reason] ?? reason}`).join(', ')}` : ''}`;
    const parts = [`Undo accepted for ${undoneCount} of ${group.count}`, skipText];
    const outcomes = group.undone.compensationOutcomes;
    if (outcomes.failed > 0) {
      parts.push(`restore failed for ${outcomes.failed} — see Activity`);
    } else if (outcomes.unknown > 0) {
      parts.push(`restore outcome unknown for ${outcomes.unknown} — see Activity`);
    } else if (outcomes.pending > 0) {
      parts.push('restoring…');
    } else if (outcomes.confirmed > 0) {
      parts.push('restored');
    }
    return parts.join('; ');
  }
  const c = group.counts;
  const parts: string[] = [];
  if (c.confirmed > 0) parts.push(`${c.confirmed} confirmed`);
  if (c.pending > 0) parts.push(`${c.pending} pending`);
  if (c.failed > 0) parts.push(`${c.failed} failed`);
  if (c.unknown > 0) parts.push(`${c.unknown} outcome unknown`);
  if (c.cancelled > 0) parts.push(`${c.cancelled} cancelled`);
  if (c.rejected > 0) parts.push(`${c.rejected} rejected at acceptance`);
  return parts.length > 0 ? `Accepted · ${parts.join(', ')}` : 'Accepted';
});

const groupUndoVisible = computed(() => {
  const group = props.notice?.group ?? null;
  if (!group || group.undone || group.acceptanceUnknown) return false;
  const until = group.undoableUntil;
  return until !== null && Date.parse(until) > props.now;
});

const groupUndoExpired = computed(() => {
  const group = props.notice?.group ?? null;
  if (!group || group.undone || group.acceptanceUnknown || !group.hadWindow) return false;
  const until = group.undoableUntil;
  return until === null || Date.parse(until) <= props.now;
});

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
    <!-- Bulk group slot (UX-05): one identity, per-status counts, partial undo. -->
    <template v-if="notice && isGroup">
      <p class="action-notice-text" data-test="action-notice-text">
        <span class="action-notice-label" data-test="action-notice-label">{{ notice.label }} · {{ notice.group!.count }} conversations</span>
        <span class="action-notice-status" data-test="action-notice-status">{{ groupStatusText }}</span>
        <span v-if="notice.group!.acceptanceUnknown" class="action-notice-expired" data-test="action-notice-acceptance-unknown">
          Nothing is known to have committed; checking again replays this exact request.
        </span>
        <span v-else-if="groupUndoExpired" class="action-notice-expired" data-test="action-notice-expired">Undo expired — recover individual members from Activity</span>
      </p>
      <span v-if="notice.group!.acceptanceUnknown" class="action-notice-undo">
        <button type="button" data-test="action-notice-recover-acceptance" @click="emit('undoGroup')">Check acceptance</button>
        <!-- No Dismiss while acceptance is unresolved: the original request id
             and command must be kept and the mutation fence held until
             authoritative resolution (§3.3/§4.3). -->
      </span>
      <span v-else-if="groupUndoVisible" class="action-notice-undo">
        <button type="button" data-test="action-notice-undo-group" @click="emit('undoGroup')">Undo</button>
        <kbd data-test="action-notice-hint">Z</kbd>
      </span>
    </template>
    <template v-else-if="notice">
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
