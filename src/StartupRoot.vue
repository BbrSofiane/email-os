<script setup lang="ts">
/**
 * Root of the native shell: the one-time fixture-transition gate first, then
 * the app. `App.vue` is unchanged; it simply never mounts while the gate is up.
 */
import { ref } from 'vue';
import App from './App.vue';
import FixtureTransitionGate from './components/FixtureTransitionGate.vue';
import type { MailClient } from './lib/ipc/client';

defineProps<{ client: MailClient; mode: 'native' | 'browser-preview' }>();
const cleared = ref(false);
</script>

<template>
  <App v-if="cleared" :client="client" :mode="mode" />
  <FixtureTransitionGate v-else :client="client" @cleared="cleared = true" />
</template>
