<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import { loadReminderPreferences, saveReminderPreferences, type ReminderPreferences } from '../lib/reminder-preferences';
import { getDeviceTimeZone } from '../lib/reminder-timezone';

const emit = defineEmits<{ close: []; saved: [preferences: ReminderPreferences] }>();
const props = defineProps<{ compact?: boolean }>();
const hour = ref(8);
const minute = ref(0);
const error = ref('');
const status = ref('');
const saving = ref(false);
const confirmed = ref<ReminderPreferences>({ hour: 8, minute: 0 });
const timeZone = getDeviceTimeZone();

function load() {
  const preferences = loadReminderPreferences();
  hour.value = preferences.hour;
  minute.value = preferences.minute;
  confirmed.value = preferences;
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); }
}
function save() {
  if (saving.value) return;
  const preferences = { hour: Number(hour.value), minute: Number(minute.value) };
  if (!Number.isInteger(preferences.hour) || preferences.hour < 0 || preferences.hour > 23 || !Number.isInteger(preferences.minute) || preferences.minute < 0 || preferences.minute > 59) {
    error.value = 'Enter a valid local time.';
    return;
  }
  saving.value = true;
  error.value = '';
  status.value = '';
  if (!saveReminderPreferences(preferences)) {
    hour.value = confirmed.value.hour;
    minute.value = confirmed.value.minute;
    error.value = 'Could not save reminder settings.';
    saving.value = false;
    return;
  }
  confirmed.value = preferences;
  status.value = 'Saved';
  emit('saved', preferences);
  saving.value = false;
}

async function saveCompactChange(): Promise<void> {
  if (!props.compact) return;
  await nextTick();
  save();
}
onMounted(() => { load(); window.addEventListener('keydown', onKeydown); });
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <section role="dialog" aria-modal="true" aria-labelledby="reminder-settings-title" class="reminder-settings">
    <h2 id="reminder-settings-title" class="reminder-settings-accessible-title">Reminder settings</h2>
    <p>Choose the default time for date-based reminders in your device timezone: <strong>{{ timeZone ?? 'name unavailable' }}</strong>.</p>
    <details v-if="compact" class="settings-note">
      <summary>About changing the default</summary>
      <p>Changing defaults does not move existing reminders. Choose a new time to reschedule one. Changing your device timezone changes the time shown, not when a reminder returns.</p>
    </details>
    <p v-else>Changing defaults does not move existing reminders. Choose a new time to reschedule one. Changing your device timezone changes the time shown, not when a reminder returns.</p>
    <form @submit.prevent="save">
      <label for="reminder-default-hour">Hour
        <select id="reminder-default-hour" v-model.number="hour" aria-label="Default reminder hour" :disabled="saving" @change="saveCompactChange">
          <option v-for="value in 24" :key="value - 1" :value="value - 1">{{ String(value - 1).padStart(2, '0') }}</option>
        </select>
      </label>
      <label for="reminder-default-minute">Minute
        <select id="reminder-default-minute" v-model.number="minute" aria-label="Default reminder minute" :disabled="saving" @change="saveCompactChange">
          <option v-for="value in 60" :key="value - 1" :value="value - 1">{{ String(value - 1).padStart(2, '0') }}</option>
        </select>
      </label>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-else-if="compact && status" role="status" aria-live="polite">{{ status }}</p>
      <button v-if="!compact" type="submit">Save</button>
      <button v-if="!compact" type="button" @click="emit('close')">Cancel</button>
    </form>
  </section>
</template>

<style scoped>
.reminder-settings { display: grid; gap: 8px; color: var(--text-primary); font-size: var(--type-body); line-height: var(--leading-ui); }
h2, p { margin: 0; }
h2 { font-weight: var(--weight-strong); }
.reminder-settings > p { color: var(--text-secondary); }
form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: end; gap: 8px 12px; }
label { display: grid; gap: 4px; color: var(--text-secondary); }
select { width: 100%; min-width: 0; padding: 4px 8px; }
form > p, form > button { grid-column: 1 / -1; }
form > p[role="alert"] { color: var(--danger); }
</style>
