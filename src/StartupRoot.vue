<script setup lang="ts">
/**
 * Root of the native shell: the one-time fixture-transition gate first, then
 * the Android first-run mailbox choice (ADR 0005; desktop clears it at once),
 * then the app. `App.vue` never mounts while a gate is up.
 */
import { ref } from 'vue';
import App from './App.vue';
import ModeChoiceGate from './components/ModeChoiceGate.vue';
import FixtureTransitionGate from './components/FixtureTransitionGate.vue';
import type { MailClient } from './lib/ipc/client';
import { useLayoutMode } from './composables/useLayoutMode';

defineProps<{ client: MailClient; mode: 'native' | 'browser-preview' }>();
const transitionCleared = ref(false);
const cleared = ref(false);
const layoutMode = useLayoutMode();
</script>

<template>
  <App v-if="cleared" :client="client" :mode="mode" />
  <div v-else class="app startup-shell" :data-layout="layoutMode">
    <FixtureTransitionGate v-if="!transitionCleared" :client="client" @cleared="transitionCleared = true" />
    <ModeChoiceGate v-else :client="client" @cleared="cleared = true" />
  </div>
</template>
