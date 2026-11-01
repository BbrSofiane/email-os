<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CancelReminder, ConversationRef, MailClient, PutReminder, Reminder, ReminderCondition } from '../lib/ipc/client';
import { toMailError } from '../lib/ipc/client';
const props = defineProps<{ client: MailClient; target: ConversationRef | null; initialDestination?: 'pending' | 'returned' | 'history' }>();
const emit = defineEmits<{ open: [target: ConversationRef]; destinationChange: [destination: 'pending' | 'returned' | 'history'] }>();
const rows = ref<Reminder[]>([]);
const error = ref('');
const busy = ref(false);
const loading = ref(true);
const source = ref<{ conversation: ConversationRef; sourceMessageId: string; revision: number | null } | null>(null);
const due = ref('');
const someday = ref(false);
const condition = ref<ReminderCondition>('if_no_reply');
const destination = ref<'pending' | 'returned' | 'history'>(props.initialDestination ?? 'pending');
watch(destination, value => emit('destinationChange', value));
let retry: (() => Promise<unknown>) | null = null;
let alive = true;
let generation = 0;
let unsubscribe: (() => void) | undefined;
const displayed = computed(() => rows.value.filter(r => destination.value === 'returned' ? r.phase === 'returned' : destination.value === 'history' ? ['suppressed', 'cancelled'].includes(r.phase) : !['returned', 'suppressed', 'cancelled'].includes(r.phase)));
async function refresh() {
  const token = ++generation;
  try {
    const result = await props.client.reminders!.list();
    if (alive && token === generation) { rows.value = result; loading.value = false; }
  } catch { if (alive && token === generation) { error.value = 'Could not load local reminders. Retry refresh.'; loading.value = false; } }
}
async function run(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true; error.value = ''; retry = action;
  try { await action(); retry = null; if (alive) { source.value = null; await refresh(); } }
  catch (raw) {
    if (alive) {
      const failure = toMailError(raw);
      if (failure.kind === 'invalid_request' && failure.field === 'dueAt') {
        retry = null;
        error.value = 'Choose a future RFC3339 time with seconds and Z or a numeric timezone offset. Local times and leap seconds are not supported.';
      } else if (failure.kind === 'invalid_request' || failure.kind === 'not_found') {
        retry = null; source.value = null;
        error.value = 'This target or revision is no longer actionable. Refresh and choose the current reminder before editing.';
        await refresh();
      } else {
        error.value = 'Reminder change was not acknowledged. Retry the exact request, or refresh to inspect durable state. Stale revisions require refresh before editing.';
      }
    }
  }
  finally { if (alive) busy.value = false; }
}
async function prepare(target: ConversationRef) {
  busy.value = true;
  try {
    const conversation = await props.client.getConversation(target);
    if (!alive) return;
    const latest = conversation.messages.at(-1);
    if (!latest) throw new Error('missing source');
    source.value = { conversation: { ...target }, sourceMessageId: latest.id, revision: null };
  } catch { if (alive) error.value = 'Could not prepare this conversation. Refresh and try again.'; }
  finally { if (alive) busy.value = false; }
}
function reschedule(r: Reminder) {
  retry = null; error.value = '';
  source.value = { conversation: r.conversation, sourceMessageId: r.sourceMessageId, revision: r.revision };
  due.value = r.dueAt ?? ''; someday.value = r.dueAt === null; condition.value = r.condition;
}
function submit() {
  if (!source.value || retry) return;
  const command: PutReminder = { conversation: source.value.conversation, sourceMessageId: source.value.sourceMessageId, expectedRevision: source.value.revision, dueAt: someday.value ? null : due.value, condition: condition.value, requestId: crypto.randomUUID() };
  void run(() => props.client.reminders!.put(command));
}
function cancel(r: Reminder) {
  const command: CancelReminder = { conversation: r.conversation, expectedRevision: r.revision, requestId: crypto.randomUUID() };
  void run(() => props.client.reminders!.cancel(command));
}
onMounted(async () => {
  try {
    const stop = await props.client.subscribe(() => { void refresh(); });
    if (!alive) { stop(); return; }
    unsubscribe = stop;
  } catch { if (alive) error.value = 'Live updates unavailable. Refresh to inspect progress.'; }
  await refresh();
  if (alive && props.target) await prepare(props.target);
});
onBeforeUnmount(() => { alive = false; generation++; unsubscribe?.(); });
</script>

<template>
  <section class="reminders-panel" aria-label="Desktop-local reminders">
    <p role="note">Synthetic fixture only · This device, while running. Overdue work reconciles on launch. No execution while fully quit or on other devices.</p>
    <p>New incoming mail stays in Inbox. Return and Cancel restore only the original inbox messages; neither marks mail read.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button type="button" :disabled="busy" @click="retry ? run(retry) : refresh()">{{ retry ? 'Retry exact request' : 'Refresh reminders' }}</button>
    <button v-if="retry" type="button" :disabled="busy" @click="retry = null; source = null; error = ''; refresh()">Inspect durable state</button>
    <form v-if="source" @submit.prevent="submit">
      <h3>{{ source.revision === null ? 'Remind me' : 'Reschedule' }}</h3>
      <p>{{ source.conversation.conversationId }} · source {{ source.sourceMessageId }}</p>
      <fieldset :disabled="busy || !!retry">
        <label><input v-model="someday" type="checkbox"> Someday — no automatic return</label>
        <label v-if="!someday">Time with timezone offset
          <input v-model="due" required type="text" placeholder="2030-11-03T09:00:00-05:00" aria-describedby="reminder-time-help">
        </label>
        <p id="reminder-time-help">Use RFC3339 with Z or a numeric offset. No ambiguous local times or automatic DST adjustment.</p>
        <label>Return condition
          <select v-model="condition"><option value="if_no_reply">If no reply (default)</option><option value="regardless">Regardless of reply</option></select>
        </label>
        <button type="submit">{{ source.revision === null ? 'Schedule and remove from Inbox' : 'Save new time' }}</button>
        <button type="button" @click="source = null">Dismiss picker</button>
      </fieldset>
    </form>
    <nav aria-label="Reminder membership">
      <button v-for="tab in (['pending', 'returned', 'history'] as const)" :key="tab" type="button" :aria-pressed="destination === tab" @click="destination = tab">{{ tab }}</button>
    </nav>
    <p v-if="loading" role="status">Loading local reminders…</p>
    <p v-else-if="!displayed.length">No {{ destination }} reminders.</p>
    <ul>
      <li v-for="r in displayed" :key="r.conversation.conversationId">
        <button type="button" @click="emit('open', r.conversation)">Open {{ r.subject || '(No subject)' }}</button>
        <p>{{ r.dueAt ?? 'Someday (unscheduled)' }} · {{ r.condition === 'if_no_reply' ? 'If no reply' : 'Regardless' }} · {{ r.phase }} · revision {{ r.revision }}</p>
        <button v-if="r.phase === 'pending'" type="button" :disabled="busy || !!retry" @click="reschedule(r)">Reschedule</button>
        <button v-if="['removing', 'pending', 'returning', 'failed'].includes(r.phase)" type="button" :disabled="busy || !!retry" @click="cancel(r)">{{ r.phase === 'failed' ? 'Cancel / recover original inbox messages' : 'Cancel and restore original inbox messages' }}</button>
        <p v-if="r.phase === 'failed'">Removal or return failed, or a later mailbox action superseded this reminder. Cancel does not override newer triage.</p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.reminders-panel { display: grid; gap: 1rem; overflow-wrap: anywhere; }
form, fieldset, label { display: grid; gap: .65rem; }
fieldset { border: 1px solid var(--border, #666); padding: 1rem; }
input[type="text"], select { width: 100%; min-width: 0; }
nav { display: flex; flex-wrap: wrap; gap: .5rem; }
li { margin-block: 1rem; }
</style>
