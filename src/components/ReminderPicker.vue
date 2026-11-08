<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { loadReminderPreferences } from '../lib/reminder-preferences';
import { getReminderPresets, parseReminderTime, type ReminderTimeOption } from '../lib/reminder-time';
import { formatReminderDateTime, getDeviceTimeZone } from '../lib/reminder-timezone';

const props = defineProps<{ disabled?: boolean; initialValue?: string | null; rescheduling?: boolean; subject?: string | null; sender?: string | null }>();
const emit = defineEmits<{ select: [dueAt: string | null]; editing: []; dismiss: [] }>();
const input = ref<HTMLInputElement | null>(null);
const dialog = ref<HTMLElement | null>(null);
const initialSelection = props.rescheduling ? props.initialValue ?? null : null;
const selectedValue = ref<string | null>(initialSelection);
const hasSelection = ref(!!props.rescheduling);
const edited = ref(false);
const query = ref(props.rescheduling
  ? initialSelection ? formatReminderDateTime(initialSelection) : 'Someday'
  : '');
const error = ref('');
const activeIndex = ref<number | null>(null);
const confirmation = ref('');
const preferences = loadReminderPreferences();
const timeZone = getDeviceTimeZone();
const presets = getReminderPresets(new Date(), preferences);
const options = computed(() => presets.filter((option: ReminderTimeOption) => !edited.value || !query.value.trim() || option.label.toLowerCase().includes(query.value.trim().toLowerCase())));
const selectable = (option: ReminderTimeOption) => option.dueAt !== null || option.id === 'someday';
const activeOption = computed(() => {
  const option = activeIndex.value === null ? undefined : options.value[activeIndex.value];
  return option && selectable(option) ? option : null;
});
const activeDescendant = computed(() => !props.disabled && activeOption.value ? `reminder-time-option-${activeOption.value.id}` : undefined);
const listExpanded = computed(() => !props.disabled && options.value.length > 0);
watch([options, () => props.disabled], () => {
  activeIndex.value = null;
});
const targetSubject = computed(() => props.subject?.trim() || '(No subject)');


function choose(option: ReminderTimeOption) {
  if (props.disabled || (option.dueAt === null && option.id !== 'someday')) return;
  selectedValue.value = option.dueAt;
  hasSelection.value = true;
  edited.value = false;
  query.value = option.dueAt ? formatDueAt(option.dueAt) : 'Someday';
  emit('select', option.dueAt);
  error.value = '';
  confirmation.value = option.dueAt
    ? `Selected ${formatDueAt(option.dueAt)}.`
    : 'Selected Someday, with no due time.';
}
function formatDueAt(dueAt: string) {
  return formatReminderDateTime(dueAt);
}
function submit() {
  if (props.disabled) return;
  if (activeOption.value) { choose(activeOption.value); return; }
  if (hasSelection.value && !edited.value) {
    if (selectedValue.value && (!Number.isFinite(Date.parse(selectedValue.value)) || Date.parse(selectedValue.value) <= Date.now())) {
      error.value = 'Choose a future time.';
      return;
    }
    emit('select', selectedValue.value);
    error.value = '';
    confirmation.value = selectedValue.value ? `Selected ${formatDueAt(selectedValue.value)}.` : 'Selected Someday, with no due time.';
    return;
  }
  const value = query.value.trim();
  const option = options.value.find(selectable);
  if (!value) {
    if (option) choose(option);
    return;
  }
  const parsed = parseReminderTime(value, new Date(), preferences);
  if (!parsed.ok) {
    if (option) choose(option);
    else error.value = parsed.error;
    return;
  }
  selectedValue.value = parsed.dueAt;
  hasSelection.value = true;
  edited.value = false;
  query.value = parsed.dueAt ? formatDueAt(parsed.dueAt) : 'Someday';
  emit('select', parsed.dueAt);
  error.value = '';
  confirmation.value = parsed.dueAt ? `Selected ${formatDueAt(parsed.dueAt)}.` : 'Selected Someday, with no due time.';
}
function onDialogKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
  if (event.key === 'Tab') {
    const focusable = dialog.value ? [...dialog.value.querySelectorAll<HTMLElement>('input, button, select, textarea, a[href], summary, [tabindex]')]
      .filter(element => !element.matches(':disabled,[hidden],[inert]') && element.tabIndex >= 0 && !element.closest('[hidden],[inert]')) : [];
    if (!focusable.length) return;
    const first = focusable[0]!; const last = focusable.at(-1)!;
    if (document.activeElement === dialog.value || !dialog.value?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    return;
  }
}
function onInputKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'Tab') { onDialogKeydown(event); return; }
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || props.disabled) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!options.value.length || props.disabled) return;
    event.preventDefault(); event.stopPropagation();
    const available = options.value.map((option, index) => selectable(option) ? index : -1).filter(index => index >= 0);
    if (!available.length) return;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const current = activeIndex.value === null ? -1 : available.indexOf(activeIndex.value);
    const position = current < 0 ? (delta > 0 ? 0 : available.length - 1) : (current + delta + available.length) % available.length;
    activeIndex.value = available[position]!;
  } else if (event.key === 'Enter') {
    event.preventDefault(); event.stopPropagation();
    submit();
  }
}
function focusDialog() {
  if (!dialog.value?.contains(document.activeElement)) dialog.value?.focus({ preventScroll: true });
}
function dismiss() {
  if (props.disabled) { focusDialog(); return; }
  emit('dismiss');
}
watch(() => props.disabled, async disabled => {
  if (disabled) { await nextTick(); dialog.value?.focus({ preventScroll: true }); }
});
defineExpose({ focusDialog });
onMounted(async () => {
  await nextTick(); input.value?.focus();
});
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @click.self="dismiss">
      <section ref="dialog" tabindex="-1" class="picker action-overlay" data-reminder-picker role="dialog" aria-modal="true" aria-labelledby="reminder-picker-title" aria-describedby="reminder-picker-help reminder-target-description" @keydown.stop="onDialogKeydown">
        <h2 id="reminder-picker-title">When should this return?</h2>
        <p id="reminder-picker-help">Enter a time or choose a suggestion.</p>
        <p class="time-zone-note">Date-based defaults use your device timezone: <strong>{{ timeZone ?? 'name unavailable' }}</strong>.</p>
        <div id="reminder-target-description" class="reminder-target" aria-label="Conversation to remind">
          <p v-if="sender" class="reminder-sender">{{ sender }}</p>
          <details class="reminder-subject">
            <summary>{{ targetSubject }}</summary>
            <p>{{ targetSubject }}</p>
          </details>
        </div>
        <form @submit.prevent="submit">
          <label class="sr-only" for="reminder-time-input">Reminder time</label>
          <input ref="input" id="reminder-time-input" v-model="query" type="text" role="combobox" aria-autocomplete="list" aria-controls="reminder-time-listbox" autocomplete="off" placeholder="Try: 8 am, 3 days, Aug 7" :disabled="disabled" :aria-expanded="listExpanded" :aria-activedescendant="activeDescendant" :aria-invalid="!!error" :aria-describedby="error ? 'reminder-picker-help reminder-time-error' : 'reminder-picker-help'" @keydown.stop="onInputKeydown" @input="edited = true; emit('editing'); activeIndex = null; error = ''; confirmation = ''">
        </form>
        <p v-if="error" id="reminder-time-error" role="alert">{{ error }}</p>
        <ul v-show="listExpanded" id="reminder-time-listbox" role="listbox" aria-label="Suggested reminder times">
          <li v-for="(option, index) in options" :id="`reminder-time-option-${option.id}`" :key="option.id" role="option" :aria-selected="activeIndex === index" :aria-disabled="disabled || (option.dueAt === null && option.id !== 'someday')" @mouseenter="activeIndex = !disabled && selectable(option) ? index : null" @click="choose(option)">
            <span>{{ option.label }}</span><small v-if="option.dueAt"><time :datetime="option.dueAt">{{ formatDueAt(option.dueAt) }}</time></small><small v-else>Untimed</small>
          </li>
        </ul>
        <p v-if="!options.length && query.trim()" class="empty" role="status">No matching suggestions. Press Enter to use a valid custom time.</p>
        <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ confirmation }}</p>
        <div class="picker-controls"><slot /></div>
        <footer><span>↑ ↓ to move</span><span>Enter to choose</span><button type="button" :disabled="disabled" @click="dismiss">Esc to close</button></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: flex-start; justify-content: center; overflow-y: auto; padding: 15vh 16px 16px; background: var(--overlay-backdrop); }
.picker { width: min(576px, 100%); max-height: 70vh; padding: 0 0 6px; }
h2 { margin: 12px 16px 4px; font-size: var(--type-body); font-weight: var(--weight-strong); line-height: var(--leading-ui); }
#reminder-picker-help { margin: 0 16px 8px; color: var(--text-secondary); }
.time-zone-note { margin: 0 16px 8px; color: var(--text-secondary); }
.reminder-target { min-width: 0; margin: 0 16px 12px; padding: 8px 10px; background: var(--surface-raised); overflow-wrap: anywhere; }
.reminder-sender { margin: 0 0 3px; color: var(--text-secondary); }
.reminder-subject { min-width: 0; color: var(--text-primary); }
.reminder-subject summary { cursor: pointer; overflow-wrap: anywhere; }
.reminder-subject p { margin: 6px 0 0; color: var(--text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
form { padding: 0 12px 4px; }
input { display: block; box-sizing: border-box; width: 100%; height: 38px; padding: 0 12px; }
ul { display: grid; gap: 0; padding: 0 0 6px; margin: 0; list-style: none; }
li[role="option"] { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; min-width: 0; min-height: 36px; padding: 6px 16px; line-height: var(--leading-ui); cursor: pointer; }
li[role="option"] > span { min-width: 0; }
li[role="option"][aria-selected="true"], li[role="option"]:not([aria-disabled="true"]):hover { background: var(--focus-fill); box-shadow: inset 3px 0 0 var(--focus-accent); }
li[role="option"][aria-disabled="true"] { cursor: not-allowed; color: var(--text-tertiary); }
small { flex: 0 1 58%; min-width: 0; color: var(--text-secondary); font-size: var(--type-body); line-height: var(--leading-ui); text-align: right; white-space: normal; overflow-wrap: anywhere; }
.empty { padding: .5rem 0; color: var(--text-secondary); }
.picker-controls { display: grid; gap: 12px; padding: 8px 16px; }
footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 12px; padding: 8px 16px 0; border-top: 1px solid var(--rule); color: var(--text-secondary); font-size: var(--type-body); }
footer button { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
