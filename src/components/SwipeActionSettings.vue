<script setup lang="ts">
import { ref } from 'vue';
import { loadSwipePreferences, saveSwipePreferences, type SwipePreference, type SwipePreferences } from '../lib/swipe-preferences';

const emit = defineEmits<{ saved: [preferences: SwipePreferences] }>();
const preferences = ref(loadSwipePreferences());
const status = ref('');
const options: Array<{ value: SwipePreference; label: string }> = [
  { value: 'remind', label: 'Remind me' },
  { value: 'done', label: 'Mark done' },
  { value: 'none', label: 'None' },
];
function save(side: 'right' | 'left', value: SwipePreference): void {
  const next = { ...preferences.value, [side]: value };
  if (!saveSwipePreferences(next)) {
    status.value = 'Could not save';
    return;
  }
  preferences.value = next;
  emit('saved', next);
  status.value = 'Saved';
}
</script>

<template>
  <section class="swipe-settings" aria-labelledby="swipe-settings-title">
    <h2 id="swipe-settings-title">Swipe actions</h2>
    <fieldset v-for="side in ['right', 'left'] as const" :key="side">
      <legend>{{ `Swipe ${side}` }}</legend>
      <label v-for="option in options" :key="option.value">
        <input type="radio" :name="`swipe-${side}`" :value="option.value" :checked="preferences[side] === option.value" @change="save(side, option.value)">
        <span>{{ option.label }}</span>
      </label>
    </fieldset>
    <p role="status" aria-live="polite">{{ status }}</p>
  </section>
</template>
