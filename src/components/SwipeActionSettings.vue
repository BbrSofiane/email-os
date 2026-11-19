<script setup lang="ts">
import { ref } from 'vue';
import { loadSwipePreferences, saveSwipePreferences, type SwipePreference, type SwipePreferences } from '../lib/swipe-preferences';

const props = defineProps<{ compact?: boolean }>();
const emit = defineEmits<{ saved: [preferences: SwipePreferences] }>();
const preferences = ref(loadSwipePreferences());
const feedback = ref<{ side: keyof SwipePreferences; saved: boolean } | null>(null);
const optionLabels: Record<SwipePreference, string> = {
  remind: 'Remind me',
  done: 'Mark done',
  none: 'None',
};

function save(side: keyof SwipePreferences, value: SwipePreference, event: Event): void {
  const confirmed = preferences.value[side];
  const next = { ...preferences.value, [side]: value };
  const saved = saveSwipePreferences(next);
  feedback.value = { side, saved };
  if (!saved) {
    if (props.compact && event.currentTarget instanceof HTMLInputElement) {
      // The browser already checked the tapped radio. The bound value stayed
      // the same, so restore the native group directly.
      const radios = event.currentTarget.closest('fieldset')?.querySelectorAll<HTMLInputElement>('input[type="radio"]');
      for (const radio of radios ?? []) radio.checked = radio.value === confirmed;
    }
    return;
  }
  preferences.value = next;
  emit('saved', next);
}

function sideStatus(side: keyof SwipePreferences): string {
  if (feedback.value?.side !== side) return '';
  if (feedback.value.saved) return 'Saved';
  return `Could not save swipe ${side}. Still: ${optionLabels[preferences.value[side]]}.`;
}
</script>

<template>
  <section class="swipe-settings" aria-labelledby="swipe-settings-title">
    <h2 class="compact-settings-heading" id="swipe-settings-title">Swipe actions</h2>
    <fieldset v-for="side in ['right', 'left'] as const" :key="compact ? `compact-${side}` : side">
      <legend>{{ `Swipe ${side}` }}</legend>
      <p
        v-if="compact"
        class="swipe-settings-status"
        role="status"
        aria-live="polite"
        :data-status="feedback?.side === side && !feedback.saved ? 'failed' : undefined"
      >{{ sideStatus(side) }}</p>
      <label v-for="(label, value) in optionLabels" :key="value">
        <input
          type="radio"
          :name="`swipe-${side}`"
          :value="value"
          :checked="preferences[side] === value"
          @change="save(side, value, $event)"
        >
        <span>{{ label }}</span>
      </label>
    </fieldset>
    <p v-if="!compact" role="status" aria-live="polite">{{ feedback ? (feedback.saved ? 'Saved' : 'Could not save') : '' }}</p>
  </section>
</template>
