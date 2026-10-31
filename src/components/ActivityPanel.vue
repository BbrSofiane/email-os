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
import type { OperationGroupStatus, OperationGroupSummary } from '../lib/ipc/client';
import type { OperationSummaryLike } from '../composables/useMailbox';

const props = defineProps<{
  activity: OperationSummaryLike[];
  /** Whether authoritative status currently permits mailbox commands. */
  actionsEnabled?: boolean;
  /** Retry is a durable Gmail operation and is unavailable in fixture mode. */
  gmailMode?: boolean;
  /** UX-05: recent group summaries, independent of Inbox/Done rows. */
  groups?: OperationGroupSummary[];
  /** Loaded detail for the expanded group (request-id addressable). */
  groupDetail?: OperationGroupStatus | null;
  /** Request id of the currently expanded group, if any. */
  expandedRequestId?: string | null;
}>();

const emit = defineEmits<{
  open: [ref: OperationSummaryLike['conversation']];
  unarchive: [ref: OperationSummaryLike['conversation']];
  retry: [operationId: string];
  /** Expand a group summary; the parent loads authoritative detail by request id. */
  openGroup: [requestId: string];
  /** The group's single partial Undo attempt. */
  undoGroup: [groupId: string];
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

function groupActionLabel(group: OperationGroupSummary): string {
  if (group.kind === 'read') return group.requestedRead ? 'Mark read' : 'Mark unread';
  return group.requestedArchived ? 'Mark Done (archive)' : 'Mark Not Done (restore)';
}

function groupDateLabel(group: OperationGroupSummary): string {
  return group.acceptedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC');
}

function memberStatusLabel(status: string, failure: { kind: string } | null, rejection: string | null): string {
  if (rejection === 'conversation_missing') return 'rejected — conversation unavailable';
  if (rejection === 'target_bound_exceeded') return 'rejected — too many messages';
  return statusLabel(status, failure);
}

function memberCanRetry(member: OperationGroupStatus['members'][number]): boolean {
  return !!props.gmailMode && !!props.actionsEnabled && member.operationId !== null && canRetry(member.status);
}
</script>

<template>
  <aside class="activity" aria-label="Operation activity">
    <h2 class="activity-title">Activity</h2>
    <p v-if="activity.length === 0 && (groups ?? []).length === 0" data-test="activity-empty">No operations yet.</p>

    <!-- UX-05 durable groups: addressable independently of current list rows;
         per-member recovery and one partial group Undo. -->
    <section v-if="(groups ?? []).length > 0" class="activity-groups" aria-label="Conversation groups" data-test="activity-groups">
      <h3 class="activity-groups-title">Conversation groups</h3>
      <ul class="activity-group-list">
        <li
          v-for="group in groups"
          :key="group.groupId"
          class="activity-group"
          :data-test="`activity-group-${group.groupId}`"
        >
          <button
            type="button"
            class="activity-group-toggle"
            :data-test="`activity-group-toggle-${group.groupId}`"
            :aria-expanded="expandedRequestId === group.requestId ? 'true' : 'false'"
            @click="emit('openGroup', group.requestId)"
          >
            {{ groupActionLabel(group) }} · {{ group.members.length }} conversations · {{ groupDateLabel(group) }}
            <template v-if="group.undone"> · undo accepted</template>
          </button>
          <div
            v-if="expandedRequestId === group.requestId && groupDetail && groupDetail.group.groupId === group.groupId"
            class="activity-group-detail"
            :data-test="`group-detail-${group.groupId}`"
          >
            <p class="activity-group-request" data-test="group-detail-request">Request {{ groupDetail.group.requestId }}</p>
            <p v-if="groupDetail.undo.available" data-test="group-undo-available">
              <button
                type="button"
                :data-test="`group-undo-${groupDetail.group.groupId}`"
                @click="emit('undoGroup', groupDetail.group.groupId)"
              >Undo this group</button>
            </p>
            <p v-else-if="groupDetail.undo.reason" data-test="group-undo-unavailable">Group Undo unavailable: {{ groupDetail.undo.reason.replace('_', ' ') }}.</p>
            <ul class="activity-group-members">
              <li
                v-for="member in groupDetail.members"
                :key="member.ordinal"
                class="activity-group-member"
                :data-test="`group-member-${member.ordinal}`"
              >
                <span class="activity-status" :data-test="`group-member-status-${member.status}`">{{ memberStatusLabel(member.status, member.failure, member.rejection) }}</span>
                <span class="activity-id">{{ member.conversation.conversationId }}</span>
                <p v-if="member.status === 'outcome_unknown'" class="activity-warning" data-test="member-unknown-warning">
                  Verify current mailbox state first. Retrying may override the current state.
                </p>
                <span class="activity-buttons">
                  <button type="button" :data-test="`group-member-open-${member.ordinal}`" @click="emit('open', member.conversation)">Open</button>
                  <button
                    v-if="memberCanRetry(member)"
                    type="button"
                    :data-test="`group-member-retry-${member.ordinal}`"
                    @click="emit('retry', member.operationId!)"
                  >Retry with a new request ID</button>
                </span>
              </li>
            </ul>
          </div>
        </li>
      </ul>
    </section>

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
