<script setup lang="ts">
/**
 * The Reminders list context (fixture only): one Ash coverage line, in-flow
 * recovery lines, the in-flow picker (Remind me / Reschedule) and the rows of
 * the selected tab. The tabs themselves sit in the app header (the split-tab
 * slot) and read the same `model`. All request semantics live in
 * `useReminders`; this component only renders them.
 *
 * Esc inside the picker dismisses the picker alone; anywhere else Esc is the
 * app's Back. Row keys come from ContextRowList (J/K, arrows, Home, End).
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { Reminder } from '../lib/ipc/client';
import { fullDateLabel } from '../lib/browsing-dates';
import { REMINDER_PHASES, REMINDERS_FIXTURE_DETAIL, REMINDERS_FIXTURE_LINE, type RemindersModel } from '../composables/useReminders';
import ContextRowList from './ContextRowList.vue';
import FullDate from './FullDate.vue';

const props = defineProps<{ model: RemindersModel }>();
const emit = defineEmits<{ open: [target: Reminder['conversation']] }>();
const {
  error, preparationError, preparationTarget, busy, loading, source, due, someday, condition, destination,
  displayed, activeRow, retrying, presetList, customForced, customShown, customOpen,
} = props.model;

interface ReminderItem { key: string; reminder: Reminder }
const items = computed<ReminderItem[]>(() => displayed.value.map(reminder => ({ key: reminder.conversation.conversationId, reminder })));
const CANCELLABLE = ['removing', 'pending', 'returning', 'failed'];

const paneEl = ref<HTMLElement | null>(null);
const pickerEl = ref<HTMLElement | null>(null);
const list = ref<{ focusRow: (key: string | null, options?: { preventScroll?: boolean }) => Promise<void> } | null>(null);

/** Focus the current row, or the pane itself when the tab has no rows. */
async function focusRow(options: { preventScroll?: boolean } = {}): Promise<void> {
  await nextTick();
  if (list.value) await list.value.focusRow(activeRow.value, options);
  else paneEl.value?.focus(options);
}
/** Keep focus inside an open picker while its request cannot be dismissed. */
function retainPickerFocus(): void {
  if (pickerEl.value && !pickerEl.value.contains(document.activeElement)) pickerEl.value.focus({ preventScroll: true });
}
defineExpose({ focusRow, retainPickerFocus, el: paneEl });

// The picker is an in-flow block: when it opens, focus moves to its first
// choice; when it closes while focus was inside it, focus returns to the rows.
watch(source, async (next, previous) => {
  await nextTick();
  if (next && !previous) pickerEl.value?.querySelector<HTMLElement>('button, input')?.focus();
  else if (!next && previous && (document.activeElement === document.body || document.activeElement === null)) await focusRow();
});

function dismiss() {
  props.model.closePicker();
  void focusRow();
}
function onPickerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
  // The picker owns this Escape: it must not also run the app's Back.
  event.stopPropagation(); event.preventDefault();
  if (busy.value || retrying.value) return;
  dismiss();
}
function rowTitle(item: ReminderItem): string { return `Revision ${item.reminder.revision}`; }
</script>

<template>
  <div ref="paneEl" class="context-pane" data-test="reminders-panel" tabindex="-1">
    <!-- Honest state, once: the fixture disclosure is visible; the rest is its title and hidden text. -->
    <div class="context-coverage">
      <p class="cached-coverage" role="note" data-test="reminders-coverage" :title="REMINDERS_FIXTURE_DETAIL">{{ REMINDERS_FIXTURE_LINE }}<span class="visually-hidden"> · {{ REMINDERS_FIXTURE_DETAIL }}</span></p>
      <button type="button" class="drawer-quiet" data-test="reminders-refresh" :disabled="busy" @click="model.retryOrRefresh()">{{ retrying ? 'Retry exact request' : 'Refresh reminders' }}</button>
    </div>
    <div v-if="error" class="recovery-banner" data-test="reminders-error">
      <p role="alert">{{ error }}</p>
      <button v-if="retrying" type="button" :disabled="busy" @click="model.inspectDurableState()">Inspect durable state</button>
    </div>
    <div v-if="preparationError" class="recovery-banner" data-test="reminders-preparation-error">
      <p role="alert">{{ preparationError }}</p>
      <button v-if="preparationTarget" type="button" :disabled="busy || retrying" @click="model.prepare(preparationTarget)">{{ busy ? 'Preparing current source…' : 'Retry preparation / refresh source' }}</button>
    </div>
    <form
      v-if="source"
      ref="pickerEl"
      class="reminder-form"
      tabindex="-1"
      data-test="reminder-form"
      :data-source-conversation="source.conversation.conversationId"
      :data-source-message="source.sourceMessageId"
      @submit.prevent="model.submit()"
      @keydown="onPickerKeydown"
    >
      <h2 class="drawer-section-title">{{ source.revision === null ? 'Remind me' : 'Reschedule' }}</h2>
      <!-- The subject names the mail; the opaque ids stay in the title and data attributes. -->
      <p class="reminder-subject" :title="`Conversation ${source.conversation.conversationId} · source ${source.sourceMessageId}`">{{ source.subject || '(No subject)' }}</p>
      <fieldset class="reminder-fields" :disabled="busy || retrying">
        <div class="reminder-presets" role="group" aria-label="Return time">
          <button
            v-for="preset in presetList"
            :key="preset.id"
            type="button"
            class="drawer-chip"
            :data-test="`reminder-preset-${preset.id}`"
            :aria-pressed="!someday && due === preset.at"
            :title="fullDateLabel(preset.at)"
            @click="model.choosePreset(preset.at)"
          >{{ preset.label }}</button>
          <label class="reminder-someday" title="Someday — no automatic return"><input v-model="someday" type="checkbox"> Someday</label>
          <button
            v-if="!someday"
            type="button"
            class="drawer-chip"
            data-test="reminder-custom"
            :aria-expanded="customShown"
            aria-controls="reminder-custom-field"
            :disabled="customForced"
            @click="customOpen = !customOpen"
          >Custom</button>
        </div>
        <div v-if="!someday && customShown" id="reminder-custom-field" class="reminder-custom">
          <label class="field-row"><span class="field-label reminder-label">Time with timezone offset</span>
            <input v-model="due" class="field-input" required type="text" placeholder="2030-11-03T09:00:00-05:00" aria-describedby="reminder-time-help">
          </label>
          <p id="reminder-time-help" class="drawer-note">Use RFC3339 with Z or a numeric offset. No ambiguous local times or automatic DST adjustment.</p>
        </div>
        <label class="field-row"><span class="field-label reminder-label">Return condition</span>
          <select v-model="condition" class="field-input"><option value="if_no_reply">If no reply (default)</option><option value="regardless">Regardless of reply</option></select>
        </label>
        <div class="reminder-actions">
          <button type="submit" class="drawer-primary" :disabled="!someday && due.trim() === ''">{{ source.revision === null ? 'Schedule and remove from Inbox' : 'Save new time' }}</button>
          <button type="button" class="drawer-quiet" @click="dismiss()">Dismiss picker</button>
        </div>
      </fieldset>
    </form>
    <div id="reminder-tabpanel" role="tabpanel" :aria-labelledby="`reminder-tab-${destination}`">
      <p v-if="loading" class="list-state" role="status">Loading local reminders…</p>
      <p v-else-if="!displayed.length" class="list-state" data-test="reminders-empty">No {{ destination }} reminders.</p>
      <ContextRowList
        v-if="items.length"
        ref="list"
        :items="items"
        :label="`${destination[0]!.toUpperCase()}${destination.slice(1)} reminders`"
        :active-key="activeRow"
        :row-title="rowTitle"
        :row-test-id="(item: ReminderItem) => `reminder-row-${item.reminder.phase}`"
        @update:active-key="activeRow = $event"
        @open="emit('open', $event.reminder.conversation)"
      >
        <template #primary="{ item }"><span class="context-subject">{{ item.reminder.subject || '(No subject)' }}</span></template>
        <template #secondary="{ item }"><span v-if="item.reminder.condition === 'regardless'" data-test="reminder-condition">Returns regardless of reply</span></template>
        <template #actions="{ item }">
          <button v-if="item.reminder.phase === 'pending'" type="button" class="drawer-quiet" :disabled="busy || retrying" @click="model.reschedule(item.reminder)">Reschedule</button>
          <button
            v-if="CANCELLABLE.includes(item.reminder.phase)"
            type="button"
            class="drawer-quiet"
            :aria-label="item.reminder.phase === 'failed' ? 'Cancel reminder and recover original inbox messages' : 'Cancel reminder and restore original inbox messages'"
            :title="item.reminder.phase === 'failed' ? 'Cancel / recover original inbox messages' : 'Cancel and restore original inbox messages'"
            :disabled="busy || retrying"
            @click="model.cancel(item.reminder)"
          >Cancel reminder</button>
        </template>
        <template #trailing="{ item }">
          <span class="context-date"><FullDate v-if="item.reminder.dueAt" :at="item.reminder.dueAt" /><template v-else>Someday</template></span>
          <span class="activity-status context-phase" :class="`tone-${REMINDER_PHASES[item.reminder.phase].tone}`" :data-test="`reminder-phase-${item.reminder.phase}`">{{ REMINDER_PHASES[item.reminder.phase].word }}</span>
        </template>
        <template #note="{ item }">
          <p v-if="item.reminder.phase === 'failed'" class="context-row-note tone-fault">Removal or return failed, or a later mailbox action superseded this reminder. Cancel does not override newer triage.</p>
        </template>
      </ContextRowList>
    </div>
  </div>
</template>

<style scoped>
.context-pane:focus { outline: none; }
.context-coverage { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-right: 24px; }
.context-coverage .cached-coverage { padding-right: 0; }
.context-coverage .drawer-quiet { margin-right: -8px; }
.reminder-form, .reminder-fields { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.reminder-form { padding: 6px 24px 12px 50px; overflow-wrap: anywhere; }
.reminder-fields { border: 0; margin: 0; padding: 0; }
.reminder-form .drawer-section-title { margin: 0; }
.reminder-subject { margin: 0; color: var(--text-primary); font-weight: var(--weight-strong); }
.reminder-presets { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-left: -8px; }
.reminder-someday { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; }
.reminder-custom { display: flex; flex-direction: column; gap: 4px; }
.reminder-label { flex: 0 0 9rem; }
.reminder-actions { display: flex; align-items: center; gap: 6px; margin: 6px 0 0 -8px; }
</style>
