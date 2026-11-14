/**
 * The single-slot action notice (UX-04/UX-05) and the advisory Undo clock,
 * moved verbatim out of App.vue. The notice is a pure view over the mailbox's
 * last single action, last group and activity rows; the clock ticks every
 * 250 ms while the owner is mounted so `undoWindowOpen` follows expiry.
 * Nothing here dispatches: Undo itself stays with the owner.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { GroupNoticeView } from '../components/ActionNotice.vue';
import { findAction } from '../lib/action-registry';
import type { LastActionId, Mailbox } from './useMailbox';

export interface ActionNoticeDeps {
  mailbox: Pick<Mailbox, 'lastGroup' | 'lastAction' | 'activity'>;
}

export function useActionNotice({ mailbox }: ActionNoticeDeps) {
  /** Advisory wall clock for the Undo hint; the backend owns eligibility. */
  const nowMs = ref(Date.now());
  let nowTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Single-slot notice state, single-or-group identity (UX-04/UX-05). Status text
   * derives from the matching Activity row / authoritative group status on every
   * refresh; undo windows come only from refreshed authoritative state. The
   * backend stays the authority: an `expired` rejection refreshes and then closes
   * the slot window below. After a successful undo the slot reports the outcome.
   */
  const actionNotice = computed(() => {
    const groupSlot = mailbox.lastGroup.value;
    if (groupSlot) {
      const status = groupSlot.status;
      const counts = { pending: 0, confirmed: 0, failed: 0, rejected: 0, unknown: 0, cancelled: 0 };
      if (status) {
        for (const member of status.members) {
          if (member.status === 'rejected') counts.rejected += 1;
          else if (member.status === 'confirmed') counts.confirmed += 1;
          else if (member.status === 'failed') counts.failed += 1;
          else if (member.status === 'outcome_unknown') counts.unknown += 1;
          else if (member.status === 'cancelled') counts.cancelled += 1;
          else counts.pending += 1; // queued | applying
        }
      }
      let undoneView: GroupNoticeView['undone'] = null;
      const undoMembers = status?.undoReceipt?.members ?? groupSlot.undone?.members;
      if (undoMembers) {
        const skipReasons: Record<string, number> = {};
        let cancelled = 0;
        let compensating = 0;
        let skipped = 0;
        for (const member of undoMembers) {
          if (member.decision.kind === 'cancelled') cancelled += 1;
          else if (member.decision.kind === 'compensating') compensating += 1;
          else {
            skipped += 1;
            skipReasons[member.decision.reason] = (skipReasons[member.decision.reason] ?? 0) + 1;
          }
        }
        // CURRENT compensation outcomes: prefer the backend's persisted undo
        // record (also correct after restart / lost undo response); fall back to
        // the refreshed activity rows for compensations it lists. Compensation
        // status is tracked separately from the original execution statuses.
        const outcomes = { confirmed: 0, failed: 0, unknown: 0, pending: 0 };
        const record = groupSlot.status?.undoReceipt;
        if (record) {
          for (const member of record.members) {
            for (const compensation of member.compensations) {
              if (compensation.status === 'confirmed') outcomes.confirmed += 1;
              else if (compensation.status === 'failed') outcomes.failed += 1;
              else if (compensation.status === 'outcome_unknown') outcomes.unknown += 1;
              else outcomes.pending += 1;
            }
          }
        } else {
          for (const member of groupSlot.undone?.members ?? []) {
            for (const operationId of member.operationIds) {
              const row = mailbox.activity.value.find((item) => item.id === operationId);
              if (!row) outcomes.pending += 1;
              else if (row.status === 'confirmed') outcomes.confirmed += 1;
              else if (row.status === 'failed') outcomes.failed += 1;
              else if (row.status === 'outcome_unknown') outcomes.unknown += 1;
              else outcomes.pending += 1;
            }
          }
        }
        undoneView = { cancelled, compensating, skipped, skipReasons, compensationOutcomes: outcomes };
      }
      const group: GroupNoticeView = {
        count: groupSlot.members.length,
        counts,
        acceptanceUnknown: groupSlot.state === 'acceptance-unknown',
        statusKnown: status !== null,
        statusError: groupSlot.statusError,
        undoableUntil: status?.undo.undoableUntil ?? null,
        hadWindow: groupSlot.hadWindow,
        undone: undoneView,
      };
      const groupActionId: LastActionId = groupSlot.kind === 'star' ? (groupSlot.requestedStarred ? 'star' : 'unstar') : groupSlot.kind === 'read'
        ? (groupSlot.requestedRead ? 'read' : 'unread')
        : (groupSlot.requestedArchived ? 'archive' : 'unarchive');
      return {
        label: groupSlot.kind === 'star' ? (groupSlot.requestedStarred ? 'Star' : 'Unstar') : groupSlot.kind === 'read' ? (groupSlot.requestedRead ? 'Mark read' : 'Mark unread') : (groupSlot.requestedArchived ? 'Mark done' : 'Mark not done'),
        actionId: groupActionId,
        subject: null,
        operation: null,
        undoableUntil: null,
        hadWindow: false,
        undone: null,
        group,
      };
    }
    const slot = mailbox.lastAction.value;
    if (!slot) return null;
    const operation = mailbox.activity.value.find((item) => item.id === slot.receipt.operationId) ?? null;
    const label = findAction(slot.actionId)?.label ?? slot.actionId;
    return {
      label,
      actionId: slot.actionId,
      subject: slot.subject,
      operation,
      // Post-undo the window is closed outright: a stale activity row can still
      // carry undoableUntil, and the palette/key must never send a second undo.
      undoableUntil: slot.undone ? null : operation ? operation.undoableUntil ?? null : slot.undoableUntil,
      hadWindow: slot.hadWindow,
      undone: slot.undone
        ? {
            outcome: slot.undone.outcome,
            compensations: mailbox.activity.value.filter((item) => slot.undone?.operationIds.includes(item.id) ?? false),
          }
        : null,
    };
  });

  /** Palette/key availability share this window check; expiry is advisory only.
   *  An in-flight undo owns the slot: a second dispatch (key repeat, double-tap,
   *  button+key) must never race it into a false `already_undone` failure. */
  const undoWindowOpen = computed(() => {
    const notice = actionNotice.value;
    if (!notice || notice.undone) return false;
    const until = notice.group ? notice.group.undoableUntil : notice.undoableUntil;
    return until !== null && Date.parse(until) > nowMs.value;
  });

  onMounted(() => {
    nowTimer = setInterval(() => { nowMs.value = Date.now(); }, 250);
  });
  onBeforeUnmount(() => {
    if (nowTimer !== null) clearInterval(nowTimer);
    nowTimer = null;
  });

  return { nowMs, actionNotice, undoWindowOpen };
}
