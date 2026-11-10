<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CancelReminder, ConversationRef, MailClient, PutReminder, Reminder, ReminderCondition, ReminderPhase } from '../lib/ipc/client';
import { toMailError } from '../lib/ipc/client';
import FullDate from './FullDate.vue';
import ReminderPicker from './ReminderPicker.vue';
import { useDrawerRows } from '../composables/useDrawerRows';
import { formatReminderDateTime } from '../lib/reminder-timezone';

const props = defineProps<{ client: MailClient; target: ConversationRef | null; initialDestination?: 'pending' | 'returned' | 'history' }>();
const emit = defineEmits<{ open: [target: ConversationRef]; destinationChange: [destination: 'pending' | 'returned' | 'history']; scheduled: [receipt: Reminder, rescheduled: boolean]; dismiss: [] }>();
const picker = ref<InstanceType<typeof ReminderPicker> | null>(null);
const rows = ref<Reminder[]>([]);
const error = ref('');
const preparationError = ref('');
const preparationTarget = ref<ConversationRef | null>(null);
const busy = ref(false);
const loading = ref(true);
const source = ref<{ conversation: ConversationRef; sourceMessageId: string; revision: number | null; subject: string; sender: string | null } | null>(null);
const dueAt = ref<string | null>(null);
const pickerReady = ref(false);
const condition = ref<ReminderCondition>('if_no_reply');
const destination = ref<'pending' | 'returned' | 'history'>(props.initialDestination ?? 'pending');
const PHASES: Record<ReminderPhase, { word: string; tone: 'warn' | 'fault' | 'calm' }> = {
  removing: { word: 'Hiding from Inbox', tone: 'warn' },
  pending: { word: 'Waiting', tone: 'calm' },
  returning: { word: 'Returning to Inbox', tone: 'warn' },
  cancelling: { word: 'Restoring Inbox', tone: 'warn' },
  returned: { word: 'In Inbox', tone: 'calm' },
  suppressed: { word: 'Skipped after reply', tone: 'calm' },
  cancelled: { word: 'Cancelled', tone: 'calm' },
  failed: { word: 'Needs attention', tone: 'fault' },
};
const TABS: ReadonlyArray<{ id: 'pending' | 'returned' | 'history'; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'returned', label: 'Returned' },
  { id: 'history', label: 'History' },
];
const NOTE = 'Saved on this device. Runs while Email OS is open; overdue reminders are checked at start.';
const NOTE_DETAIL = 'Reminders are saved on this device and run while Email OS is open. Overdue reminders are checked when Email OS starts. '
  + 'Scheduling hides this conversation from the Email OS Inbox. New incoming mail stays visible. Return and Cancel show only the original inbox messages again; neither marks mail read.';
watch(destination, value => emit('destinationChange', value));
const retry = ref<{ action: () => Promise<Reminder>; command?: PutReminder } | null>(null);
let alive = true;
let generation = 0;
let editorGeneration = 0;
let unsubscribe: (() => void) | undefined;
function bucketOf(r: Reminder): 'pending' | 'returned' | 'history' {
  return r.phase === 'returned' ? 'returned' : r.phase === 'suppressed' || r.phase === 'cancelled' ? 'history' : 'pending';
}
const displayed = computed(() => rows.value.filter(r => bucketOf(r) === destination.value));
/** Counts of the currently loaded rows per bucket (the same filter as `displayed`). */
const counts = computed<Record<'pending' | 'returned' | 'history', number>>(() => {
  const result = { pending: 0, returned: 0, history: 0 };
  for (const r of rows.value) result[bucketOf(r)]++;
  return result;
});
const drawerRows = useDrawerRows({ keys: () => displayed.value.map(r => r.conversation.conversationId) });

// Tabs own their arrow keys; rows use J/K/arrows (useDrawerRows).
function onTabKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const index = TABS.findIndex(tab => tab.id === destination.value);
  const last = TABS.length - 1;
  const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length
    : event.key === 'ArrowLeft' ? (index + last) % TABS.length
      : event.key === 'Home' ? 0
        : event.key === 'End' ? last
          : null;
  if (next === null) return;
  event.preventDefault();
  destination.value = TABS[next]!.id;
  void nextTick(() => document.getElementById(`reminder-tab-${destination.value}`)?.focus());
}

async function refresh() {
  const token = ++generation;
  try {
    const result = await props.client.reminders!.list();
    if (alive && token === generation) { rows.value = result; loading.value = false; error.value = error.value === 'Could not load local reminders. Retry refresh.' ? '' : error.value; }
  } catch { if (alive && token === generation) { error.value = 'Could not load local reminders. Retry refresh.'; loading.value = false; } }
}
async function run(action: () => Promise<Reminder>, command?: PutReminder) {
  if (busy.value) return;
  const token = editorGeneration;
  busy.value = true; error.value = ''; retry.value = { action, command };
  try {
    const result = await action();
    if (alive && token === editorGeneration) {
      retry.value = null;
      if (command) emit('scheduled', result, command.expectedRevision !== null);
      source.value = null;
      dueAt.value = null;
      pickerReady.value = false;
      await refresh();
    }
  } catch (raw) {
    if (alive && token === editorGeneration) {
      const failure = toMailError(raw);
      if (failure.kind === 'invalid_request' && failure.field === 'dueAt') {
        retry.value = null;
        error.value = 'Choose a future time. The selected time must include Z or a numeric timezone offset.';
      } else if (failure.kind === 'invalid_request' && failure.field === 'sourceMessageId' && command?.expectedRevision === null) {
        retry.value = null; source.value = null;
        preparationTarget.value = { ...command.conversation };
        preparationError.value = 'This conversation has a newer message. Refresh the source, review it, then schedule again.';
      } else if (failure.kind === 'invalid_request' || failure.kind === 'not_found') {
        retry.value = null; source.value = null;
        error.value = 'This reminder is no longer actionable. Refresh and choose the current reminder before editing.';
        await refresh();
      } else {
        error.value = 'Reminder change was not acknowledged. Retry the exact request, or refresh to inspect saved state. Refresh before editing a stale reminder.';
      }
    }
  }
  finally { if (alive && token === editorGeneration) busy.value = false; }
}
async function prepare(target: ConversationRef) {
  if (busy.value || retry.value) return;
  const token = ++editorGeneration;
  const requested = { ...target };
  preparationTarget.value = requested;
  source.value = null;
  busy.value = true;
  try {
    const conversation = await props.client.getConversation(requested);
    if (!alive || token !== editorGeneration) return;
    const latest = conversation.messages.at(-1);
    if (conversation.ref.accountId !== requested.accountId || conversation.ref.conversationId !== requested.conversationId || !latest) {
      preparationError.value = 'No current source message is available for this conversation. Retry preparation after it is available.';
      return;
    }
    if (conversation.retainedSnapshotAt || conversation.contextComplete === false) {
      preparationError.value = 'This conversation is retained or incomplete. A current conversation is required; retry.value preparation after it is available.';
      return;
    }
    source.value = { conversation: requested, sourceMessageId: latest.id, revision: null, subject: conversation.subject, sender: latest.from.displayName?.trim() || latest.from.mailbox || null };
    preparationTarget.value = null;
    preparationError.value = '';
  } catch { if (alive && token === editorGeneration) preparationError.value = 'Could not load the current source message. Retry preparation for this conversation.'; }
  finally { if (alive && token === editorGeneration) busy.value = false; }
}
function clearPicker(notifyParent: boolean) {
  const wasNew = source.value?.revision === null;
  editorGeneration++;
  busy.value = false; retry.value = null; source.value = null; dueAt.value = null; pickerReady.value = false;
  preparationTarget.value = null; preparationError.value = '';
  if (notifyParent && wasNew) emit('dismiss');
}
const dismissBlocked = computed(() => busy.value || !!retry.value);
function retainPickerFocus() { picker.value?.focusDialog(); }
function dismissPicker() {
  if (dismissBlocked.value) { retainPickerFocus(); return; }
  clearPicker(true);
}
function inspectSavedState() {
  if (busy.value) return;
  // Explicitly abandon the ambiguous command only to inspect durable state.
  clearPicker(false); error.value = ''; void refresh();
}
defineExpose({ dismissBlocked, retainPickerFocus, dismissPicker });

watch(() => [props.client, props.target?.accountId, props.target?.conversationId], () => {
  clearPicker(false);
  condition.value = 'if_no_reply';
  if (props.target) void prepare(props.target);
});
function reschedule(r: Reminder) {
  clearPicker(false); error.value = '';
  source.value = { conversation: r.conversation, sourceMessageId: r.sourceMessageId, revision: r.revision, subject: r.subject, sender: null };
  dueAt.value = r.dueAt;
  pickerReady.value = r.dueAt === null || (Number.isFinite(Date.parse(r.dueAt)) && Date.parse(r.dueAt) > Date.now());
  condition.value = r.condition;
}
function selectTime(value: string | null) { dueAt.value = value; pickerReady.value = true; }
function editTime() { pickerReady.value = false; }
function submit() {
  if (!source.value || !pickerReady.value || retry.value || busy.value) return;
  const command: PutReminder = { conversation: source.value.conversation, sourceMessageId: source.value.sourceMessageId, expectedRevision: source.value.revision, dueAt: dueAt.value, condition: condition.value, requestId: crypto.randomUUID() };
  void run(() => props.client.reminders!.put(command), command);
}
function cancel(r: Reminder) {
  const command: CancelReminder = { conversation: r.conversation, expectedRevision: r.revision, requestId: crypto.randomUUID() };
  void run(() => props.client.reminders!.cancel(command));
}
onMounted(async () => {
  const token = editorGeneration;
  try {
    const stop = await props.client.subscribe(() => { void refresh(); });
    if (!alive) { stop(); return; }
    unsubscribe = stop;
  } catch { if (alive) error.value = 'Live updates unavailable. Refresh to inspect progress.'; }
  await refresh();
  if (alive && token === editorGeneration && props.target) await prepare(props.target);
});
onBeforeUnmount(() => { alive = false; generation++; editorGeneration++; unsubscribe?.(); });
</script>

<template>
  <div class="reminders-panel" data-test="reminders-panel">
    <p class="drawer-note" role="note" :title="NOTE_DETAIL">{{ NOTE }}<span class="visually-hidden"> · {{ NOTE_DETAIL }}</span></p>
    <p v-if="error" role="alert" class="drawer-alert">{{ error }}</p>
    <p v-if="preparationError" role="alert" class="drawer-alert">{{ preparationError }}</p>
    <div class="drawer-toolbar reminders-toolbar">
      <button v-if="preparationTarget" type="button" class="drawer-quiet" :disabled="busy || !!retry" @click="prepare(preparationTarget)">{{ busy ? 'Preparing conversation…' : 'Retry preparation / refresh conversation' }}</button>
      <button type="button" class="drawer-quiet" :disabled="busy" @click="retry ? run(retry.action, retry.command) : refresh()">{{ retry ? 'Retry exact request' : 'Refresh reminders' }}</button>
      <button v-if="retry" type="button" class="drawer-quiet" :disabled="busy" @click="inspectSavedState">Inspect saved state</button>
    </div>
    <div v-if="source" class="picker-host">
      <header><h3 class="drawer-section-title">{{ source.revision === null ? 'Remind me' : 'Reschedule reminder' }}</h3><p>Conversation ready</p></header>
      <ReminderPicker ref="picker" :disabled="busy || !!retry" :initial-value="dueAt" :rescheduling="source.revision !== null" :subject="source.subject" :sender="source.sender" @select="selectTime" @editing="editTime" @dismiss="dismissPicker">
        <p v-if="error" role="alert">{{ error }}</p>
        <button v-if="retry" type="button" :disabled="busy" @click="run(retry.action, retry.command)">Retry exact request</button>
        <button v-if="retry" type="button" :disabled="busy" @click="inspectSavedState">Inspect saved state</button>
        <label class="condition">Return condition
          <select v-model="condition" :disabled="busy || !!retry"><option value="if_no_reply">If no reply</option><option value="regardless">Return regardless of reply</option></select>
        </label>
        <p v-if="dueAt" class="chosen-time">Selected: <time :datetime="dueAt">{{ formatReminderDateTime(dueAt) }}</time></p>
        <p v-else-if="pickerReady" class="chosen-time">Selected: Someday</p>
        <button type="button" :disabled="busy || !!retry || !pickerReady" @click="submit">{{ busy ? 'Saving reminder…' : source.revision === null ? 'Schedule reminder' : 'Save new time' }}</button>
      </ReminderPicker>
    </div>
    <div class="reminder-tabs" role="tablist" aria-label="Reminder membership" @keydown="onTabKeydown">
      <button
        v-for="tab in TABS"
        :id="`reminder-tab-${tab.id}`"
        :key="tab.id"
        type="button"
        role="tab"
        class="reminder-tab"
        :data-test="`reminder-tab-${tab.id}`"
        :aria-selected="destination === tab.id"
        aria-controls="reminder-tabpanel"
        :tabindex="destination === tab.id ? 0 : -1"
        @click="destination = tab.id"
      >{{ tab.label }} <span class="reminder-tab-count">{{ counts[tab.id] }}</span></button>
    </div>
    <div id="reminder-tabpanel" role="tabpanel" :aria-labelledby="`reminder-tab-${destination}`">
      <p v-if="loading" class="drawer-note" role="status">Loading local reminders…</p>
      <p v-else-if="!displayed.length" class="drawer-note">No {{ destination }} reminders.</p>
      <ul class="drawer-rows" @keydown="drawerRows.onKeydown">
        <li v-for="r in displayed" :key="r.conversation.conversationId" class="reminder-row" :data-test="`reminder-row-${r.phase}`">
          <div class="drawer-row">
            <button
              type="button"
              class="drawer-row-main"
              v-bind="drawerRows.rowAttrs(r.conversation.conversationId)"
              :title="`Revision ${r.revision}`"
              @click="emit('open', r.conversation)"
            >
              <span class="visually-hidden">Open </span>
              <span class="drawer-subject drawer-strong">{{ r.subject || '(No subject)' }}</span>
            </button>
            <span class="drawer-row-trailing">
              <span class="drawer-date"><FullDate v-if="r.dueAt" :at="r.dueAt" /><template v-else>Someday</template></span>
              <span class="activity-status reminder-phase" :class="`tone-${PHASES[r.phase].tone}`" :data-test="`reminder-phase-${r.phase}`">{{ PHASES[r.phase].word }}</span>
            </span>
          </div>
          <div v-if="r.condition === 'regardless' || ['removing', 'pending', 'returning', 'failed'].includes(r.phase)" class="drawer-row-actions">
            <span v-if="r.condition === 'regardless'" class="drawer-note" data-test="reminder-condition">Returns regardless of reply</span>
            <button v-if="r.phase === 'pending'" type="button" class="drawer-quiet" :disabled="busy || !!retry" @click="reschedule(r)">Reschedule</button>
            <button
              v-if="['removing', 'pending', 'returning', 'failed'].includes(r.phase)"
              type="button"
              class="drawer-quiet"
              :aria-label="r.phase === 'failed' ? 'Cancel and show original inbox messages' : 'Cancel reminder and show in Inbox'"
              :title="r.phase === 'failed' ? 'Cancel and show original inbox messages' : 'Cancel reminder and show in Inbox'"
              :disabled="busy || !!retry"
              @click="cancel(r)"
            >Cancel reminder</button>
          </div>
          <p v-if="r.phase === 'failed'" class="drawer-note tone-fault">A local hide or return failed, or a later mailbox action superseded this reminder. Cancel does not override newer triage.</p>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.reminders-panel { display: flex; flex-direction: column; gap: 12px; overflow-wrap: anywhere; }
.picker-host { display: grid; justify-items: center; gap: 12px; }
.picker-host header { text-align: center; }
.picker-host h3, .picker-host header p { margin: 0; }
.picker-host header p { color: var(--text-secondary); }
.picker-host > button { width: min(100%, 23rem); }
.condition { display: grid; gap: 4px; color: var(--text-secondary); }
.condition select { width: 100%; min-width: 0; padding: 4px 8px; color: var(--text-primary); }
.chosen-time { margin: 0; color: var(--text-secondary); }
.reminder-tabs { display: flex; gap: 6px; }
.reminder-tab { background: transparent; color: var(--text-secondary); border: 0; border-radius: 4px; padding: 4px 8px; }
.reminder-tab[aria-selected='true'] { color: var(--text-primary); font-weight: var(--weight-strong); background: var(--focus-fill); }
.reminder-tab-count { color: var(--text-secondary); font-weight: var(--weight-regular); font-variant-numeric: tabular-nums; }
</style>
