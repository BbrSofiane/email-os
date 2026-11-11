<script setup lang="ts">
/**
 * Operation activity and explicit recovery controls.
 *
 * Shows every operation with its status and failure. Done conversations remain
 * recoverable: rows expose Open (loads the referenced conversation even when it is
 * no longer in the inbox) and Mark not done (explicit user action with a fresh request
 * ID). Failures stay visible; they are never auto-replayed.
 *
 * Rows are the shared drawer rows (`.drawer-row`, DESIGN.md "Drawer Row"):
 * the cached subject (never the raw conversation id, which lives in a title),
 * the action label, and one status word in the trailing slot. Only the status
 * word carries colour. Single operations have no acceptance time in the DTO,
 * so they show none; groups do (`acceptedAt`).
 *
 * Keyboard: each op row, group toggle and group member exposes ONE row element
 * (`data-drawer-row`) to the shared roving model. Trailing buttons (Mark not
 * done, Retry) are not rows: they keep native Tab and Enter and stay
 * Tab-reachable after their row.
 *
 * Gmail recovery controls are gated by the authoritative mailbox-action capability.
 */
import { computed } from 'vue';
import type { ConversationRef, MailError, OperationGroupStatus, OperationGroupSummary } from '../lib/ipc/client';
import type { OperationSummaryLike } from '../composables/useMailbox';
import { useDrawerRows } from '../composables/useDrawerRows';
import FullDate from './FullDate.vue';

/** Skip-reason wording for persisted group-Undo decisions (§5). */
const SKIP_REASON_LABELS: Record<string, string> = {
  acceptance_rejected: 'rejected at acceptance',
  failed: 'failed',
  outcome_unknown: 'outcome unknown',
  unknown_prior: 'unknown prior state',
  already_undone: 'already undone',
};

const RETRY_TITLE = 'Retry with a new request ID. The original result is not rewritten.';

const props = defineProps<{
  activity: OperationSummaryLike[];
  /** Whether authoritative status currently permits mailbox commands. */
  actionsEnabled?: boolean;
  /** Retry is a durable Gmail operation and is unavailable in fixture mode. */
  gmailMode?: boolean;
  /** UX-05: recent group summaries, independent of Inbox/Done rows. */
  groups?: OperationGroupSummary[];
  /** Failed recent-group history read (distinct from an empty result). */
  groupsError?: MailError | null;
  /** The backend returned a continuation cursor for more groups. */
  groupsHasMore?: boolean;
  groupsLoadingMore?: boolean;
  /** Loaded detail for the expanded group (request-id addressable). */
  groupDetail?: OperationGroupStatus | null;
  /** Failed group-detail read (distinct from absence). */
  groupDetailError?: MailError | null;
  /** Request id of the currently expanded group, if any. */
  expandedRequestId?: string | null;
  /** Cached subject of a conversation already seen this session; null when never seen. */
  subjectFor?: (ref: ConversationRef) => string | null;
}>();

const emit = defineEmits<{
  open: [ref: OperationSummaryLike['conversation']];
  unarchive: [ref: OperationSummaryLike['conversation']];
  retry: [operationId: string];
  /** Expand a group summary; the parent loads authoritative detail by request id. */
  openGroup: [requestId: string];
  /** The group's single partial Undo attempt. */
  undoGroup: [groupId: string];
  /** Bounded Activity continuation for group history. */
  loadMoreGroups: [];
  /** Retry a failed recent-groups history read. */
  retryGroups: [];
  /** Retry a failed group-detail read. */
  retryGroupDetail: [];
}>();

type Tone = 'warn' | 'fault' | 'calm';
interface StatusView { word: string; tone: Tone; title: string }

/** One sentence-case word per state; the detail (failure kind) moves to the title. */
function statusView(status: string, failure: { kind: string } | null): StatusView {
  switch (status) {
    case 'queued': return { word: 'Queued', tone: 'warn', title: 'Queued' };
    case 'applying': return { word: 'Applying…', tone: 'warn', title: 'Applying' };
    case 'confirmed': return { word: 'Confirmed', tone: 'calm', title: 'Confirmed' };
    case 'failed': return { word: 'Failed', tone: 'fault', title: `Failed (${failure?.kind ?? 'unknown'})` };
    case 'outcome_unknown': return { word: 'Unknown', tone: 'warn', title: 'Outcome unknown' };
    case 'cancelled': return { word: 'Cancelled', tone: 'calm', title: 'Cancelled by Undo' };
    default: return { word: status, tone: 'calm', title: status };
  }
}

function actionLabel(op: OperationSummaryLike): string {
  if (op.kind === 'star') return op.requestedStarred ? 'Star' : 'Unstar';
  if (op.kind === 'read') return op.requestedRead === true ? 'Mark read' : op.requestedRead === false ? 'Mark unread' : 'Read state change';
  return op.requestedArchived ? 'Mark done' : 'Mark not done';
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
  if (group.kind === 'star') return group.requestedStarred ? 'Star' : 'Unstar';
  if (group.kind === 'read') return group.requestedRead ? 'Mark read' : 'Mark unread';
  return group.requestedArchived ? 'Mark done' : 'Mark not done';
}

function groupLabel(group: OperationGroupSummary): string {
  const count = group.members.length;
  return `${groupActionLabel(group)} · ${count} ${count === 1 ? 'conversation' : 'conversations'}`;
}

function memberStatus(status: string, failure: { kind: string } | null, rejection: string | null): StatusView {
  if (rejection === 'conversation_missing') return { word: 'Rejected', tone: 'fault', title: 'Rejected — conversation unavailable' };
  if (rejection === 'target_bound_exceeded') return { word: 'Rejected', tone: 'fault', title: 'Rejected — too many messages' };
  return statusView(status, failure);
}

function memberCanRetry(member: OperationGroupStatus['members'][number]): boolean {
  return !!props.gmailMode && !!props.actionsEnabled && member.operationId !== null && canRetry(member.status);
}

/** Standalone retry rows linked to this original operation (§4.3), newest last. */
function retryLineageFor(operationId: string): OperationSummaryLike[] {
  return props.activity.filter((op) => op.retryOf === operationId);
}

function undoStatusLabel(status: string, failure: { kind: string } | null): string {
  switch (status) {
    case 'queued': return 'restoring (queued)';
    case 'applying': return 'restoring (applying)';
    case 'confirmed': return 'restored';
    case 'failed': return `restore failed (${failure?.kind ?? 'unknown'})`;
    case 'outcome_unknown': return 'restore outcome unknown';
    case 'cancelled': return 'restore cancelled';
    default: return status;
  }
}

/** The cached subject, "(No subject)" for a seen empty one, never a raw id. */
function subjectText(ref: ConversationRef): string {
  const subject = props.subjectFor?.(ref) ?? null;
  if (subject === null) return 'Unknown conversation';
  return subject.trim() === '' ? '(No subject)' : subject;
}

/** The opaque id is evidence for a title, never row text. */
function idTitle(ref: ConversationRef): string {
  return `Conversation ${ref.conversationId}`;
}

const expandedGroup = computed(() => (props.groups ?? []).find((group) => group.requestId === props.expandedRequestId) ?? null);
const detailShown = computed(() => !!expandedGroup.value && !!props.groupDetail && props.groupDetail.group.groupId === expandedGroup.value.groupId);

const rowKeys = computed<string[]>(() => {
  const keys: string[] = [];
  for (const group of props.groups ?? []) {
    keys.push(`g:${group.groupId}`);
    if (expandedGroup.value?.groupId === group.groupId && detailShown.value) {
      for (const member of props.groupDetail!.members) keys.push(`m:${group.groupId}:${member.ordinal}`);
    }
  }
  for (const op of props.activity) keys.push(`o:${op.id}`);
  return keys;
});
const rows = useDrawerRows({ keys: () => rowKeys.value });
</script>

<template>
  <div class="activity" data-test="activity-panel" @keydown="rows.onKeydown">
    <p v-if="activity.length === 0 && (groups ?? []).length === 0 && !groupsError" class="drawer-note" data-test="activity-empty">No operations yet.</p>

    <!-- UX-05 durable groups: addressable independently of current list rows;
         per-member recovery and one partial group Undo. -->
    <p v-if="groupsError" role="alert" class="drawer-alert" data-test="groups-error">
      Could not load the group history: {{ errorLabel(groupsError.kind) }}
      <button type="button" class="drawer-quiet" data-test="groups-retry" @click="emit('retryGroups')">Retry</button>
    </p>
    <div v-if="(groups ?? []).length > 0" class="activity-groups drawer-section" data-test="activity-groups">
      <h3 class="drawer-section-title">Bulk actions</h3>
      <ul class="drawer-rows">
        <li
          v-for="group in groups"
          :key="group.groupId"
          class="activity-group"
          :data-test="`activity-group-${group.groupId}`"
        >
          <div class="drawer-row">
            <button
              type="button"
              class="drawer-row-main activity-group-toggle"
              v-bind="rows.rowAttrs(`g:${group.groupId}`)"
              :data-test="`activity-group-toggle-${group.groupId}`"
              :title="`Request ${group.requestId}`"
              :aria-expanded="expandedRequestId === group.requestId ? 'true' : 'false'"
              @click="emit('openGroup', group.requestId)"
            >
              <span class="drawer-subject">{{ groupLabel(group) }}<template v-if="group.undone"> · undo accepted</template></span>
              <FullDate class="drawer-date" :at="group.acceptedAt" />
            </button>
          </div>
          <div
            v-if="expandedRequestId === group.requestId && ((groupDetail && groupDetail.group.groupId === group.groupId) || (!!groupDetailError && !groupDetail))"
            class="activity-group-detail"
            :data-test="`group-detail-${group.groupId}`"
          >
            <template v-if="groupDetail && groupDetail.group.groupId === group.groupId">
              <p v-if="groupDetailError" role="alert" class="drawer-alert" data-test="group-detail-error">
                Could not load this group's detail: {{ errorLabel(groupDetailError.kind) }}
                <button type="button" class="drawer-quiet" :data-test="`group-detail-retry-${groupDetail.group.groupId}`" @click="emit('retryGroupDetail')">Retry</button>
              </p>
              <p v-if="groupDetail.undo.available" class="drawer-line" data-test="group-undo-available">
                <button
                  type="button"
                  class="drawer-action"
                  :data-test="`group-undo-${groupDetail.group.groupId}`"
                  :disabled="!actionsEnabled"
                  @click="emit('undoGroup', groupDetail.group.groupId)"
                >Undo this group</button>
              </p>
              <p v-else-if="groupDetail.undo.reason" class="drawer-note" data-test="group-undo-unavailable">Group Undo unavailable: {{ groupDetail.undo.reason.replace('_', ' ') }}.</p>
              <ul class="drawer-rows activity-group-members">
                <li
                  v-for="member in groupDetail.members"
                  :key="member.ordinal"
                  class="activity-group-member"
                  :data-test="`group-member-${member.ordinal}`"
                >
                  <div class="drawer-row">
                    <button
                      type="button"
                      class="drawer-row-main"
                      v-bind="rows.rowAttrs(`m:${groupDetail.group.groupId}:${member.ordinal}`)"
                      :data-test="`group-member-open-${member.ordinal}`"
                      :title="idTitle(member.conversation)"
                      @click="emit('open', member.conversation)"
                    >
                      <span class="visually-hidden">Open </span>
                      <span class="drawer-subject">{{ subjectText(member.conversation) }}</span>
                    </button>
                    <span class="drawer-row-trailing">
                      <button
                        v-if="memberCanRetry(member)"
                        type="button"
                        class="drawer-quiet"
                        :data-test="`group-member-retry-${member.ordinal}`"
                        :title="RETRY_TITLE"
                        @click="emit('retry', member.operationId!)"
                      >Retry</button>
                      <span
                        class="activity-status"
                        :class="[`status-${member.status}`, `tone-${memberStatus(member.status, member.failure, member.rejection).tone}`]"
                        :data-test="`group-member-status-${member.status}`"
                        :title="memberStatus(member.status, member.failure, member.rejection).title"
                      >{{ memberStatus(member.status, member.failure, member.rejection).word }}</span>
                    </span>
                  </div>
                  <p v-if="member.status === 'outcome_unknown'" class="drawer-note tone-warn activity-warning" data-test="member-unknown-warning">
                    Verify current mailbox state first. Retrying may override the current state.
                  </p>
                  <!-- Persisted per-member Undo decision plus CURRENT compensation
                       outcomes, distinct from the original execution status (§5). -->
                  <p
                    v-if="groupDetail.undoReceipt?.members.find((undoMember) => undoMember.ordinal === member.ordinal)"
                    class="drawer-note activity-undo-decision"
                    :data-test="`group-member-undo-decision-${member.ordinal}`"
                  >
                    <template
                      v-for="undoMember in [groupDetail.undoReceipt!.members.find((undoMember) => undoMember.ordinal === member.ordinal)!]"
                      :key="undoMember.ordinal"
                    >
                      <span v-if="undoMember.decision.kind === 'cancelled'">Undo decision: cancelled (pending intent withdrawn)</span>
                      <span v-else-if="undoMember.decision.kind === 'skipped'">Undo decision: skipped — {{ SKIP_REASON_LABELS[undoMember.decision.reason] ?? undoMember.decision.reason }}</span>
                      <template v-else>
                        <span>Undo decision: restoring</span>
                        <ul class="activity-compensations">
                          <li
                            v-for="compensation in undoMember.compensations"
                            :key="compensation.operationId"
                            :data-test="`group-compensation-${compensation.operationId}`"
                          >{{ undoStatusLabel(compensation.status, compensation.failure) }}</li>
                        </ul>
                      </template>
                    </template>
                  </p>
                  <!-- Retry lineage: standalone retries linked to this member for
                       inspection; the historical member result is not rewritten. -->
                  <p
                    v-if="retryLineageFor(member.operationId ?? '').length > 0"
                    class="drawer-line activity-retry-lineage"
                    :data-test="`group-member-retry-lineage-${member.ordinal}`"
                  >
                    <button
                      v-for="retryRow in retryLineageFor(member.operationId ?? '')"
                      :key="retryRow.id"
                      type="button"
                      class="drawer-quiet"
                      :data-test="`group-member-retry-link-${member.ordinal}-${retryRow.id}`"
                      @click="emit('open', retryRow.conversation)"
                    >Retry {{ retryRow.id }} — {{ retryRow.status.replace('_', ' ') }}</button>
                  </p>
                </li>
              </ul>
            </template>
            <p v-else-if="groupDetailError" role="alert" class="drawer-alert" data-test="group-detail-error">
              Could not load this group's detail: {{ errorLabel(groupDetailError.kind) }}
              <button type="button" class="drawer-quiet" :data-test="`group-detail-retry-${group.groupId}`" @click="emit('retryGroupDetail')">Retry</button>
            </p>
          </div>
        </li>
      </ul>
      <button
        v-if="groupsHasMore"
        type="button"
        class="drawer-quiet activity-groups-more"
        data-test="activity-groups-more"
        :disabled="groupsLoadingMore"
        @click="emit('loadMoreGroups')"
      >Show older</button>
    </div>

    <div v-if="activity.length > 0" class="drawer-section">
      <h3 v-if="(groups ?? []).length > 0" class="drawer-section-title">Actions</h3>
      <ul class="drawer-rows activity-list">
        <li
          v-for="op in activity"
          :key="op.id"
          class="activity-row"
          :data-test="`activity-${op.status}`"
        >
          <div class="drawer-row">
            <button
              type="button"
              class="drawer-row-main"
              v-bind="rows.rowAttrs(`o:${op.id}`)"
              :data-test="`activity-open-${op.id}`"
              :title="idTitle(op.conversation)"
              @click="emit('open', op.conversation)"
            >
              <span class="visually-hidden">Open </span>
              <span class="drawer-subject">{{ subjectText(op.conversation) }}</span>
              <span class="activity-action">{{ actionLabel(op) }}</span>
            </button>
            <span class="drawer-row-trailing">
              <button
                v-if="(op.kind === undefined || op.kind === 'archive') && op.requestedArchived && op.status !== 'cancelled' && actionsEnabled"
                type="button"
                class="drawer-quiet"
                :data-test="`activity-unarchive-${op.id}`"
                @click="emit('unarchive', op.conversation)"
              >Mark not done</button>
              <button
                v-if="gmailMode && actionsEnabled && canRetry(op.status)"
                type="button"
                class="drawer-quiet"
                :data-test="`activity-retry-${op.id}`"
                :title="RETRY_TITLE"
                @click="emit('retry', op.id)"
              >Retry</button>
              <span
                class="activity-status"
                :class="[`status-${op.status}`, `tone-${statusView(op.status, op.failure).tone}`]"
                :title="`${statusView(op.status, op.failure).title}. Operation ${op.id}`"
              >{{ statusView(op.status, op.failure).word }}</span>
            </span>
          </div>
          <p v-if="op.undoOf" class="drawer-note activity-undo-of" :data-test="`activity-undo-of-${op.id}`">Undo of {{ op.undoOf }}</p>
          <p
            v-if="op.lastError || op.failure"
            class="drawer-note activity-error"
            :class="op.status === 'failed' ? 'tone-fault' : 'tone-warn'"
            data-test="activity-error"
          >{{ errorLabel((op.lastError ?? op.failure)!.kind) }}</p>
          <p v-if="op.status === 'outcome_unknown'" class="drawer-note tone-warn activity-warning" data-test="activity-unknown-warning">
            Verify current mailbox state first. Retrying may override the current state.
          </p>
        </li>
      </ul>
    </div>
  </div>
</template>
