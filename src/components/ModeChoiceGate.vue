<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import type { MailClient } from '../lib/ipc/client';
import { useModeChoice } from '../composables/useModeChoice';
const props = defineProps<{ client: MailClient }>();
const emit = defineEmits<{ (event: 'cleared'): void }>();
const gate = useModeChoice(props.client);
const { phase, error } = gate;
const heading = ref<HTMLElement | null>(null);
watch(phase, async (next) => {
  if (next === 'clear') emit('cleared');
  else if (next === 'choose') { await nextTick(); heading.value?.focus(); }
});
onMounted(() => { void gate.load(); });
</script>

<template>
  <main v-if="phase === 'choose' || phase === 'switching'" class="transition-gate" data-test="mode-choice-gate">
    <section class="transition-card" aria-labelledby="mode-choice-title">
      <h1 id="mode-choice-title" ref="heading" tabindex="-1">Choose a mailbox</h1>
      <button class="primary" type="button" data-test="mode-choice-own" :disabled="phase === 'switching'" @click="gate.chooseOwnMail()">Use your own mail</button>
      <p>Sign in on this phone. Starts read-only.</p>
      <button type="button" data-test="mode-choice-demo" :disabled="phase === 'switching'" @click="gate.chooseDemo()">Open the demo mailbox</button>
      <p>Synthetic mail. Nothing in it is sent anywhere.</p>
      <p class="note">You can switch later in Account.</p>
      <p v-if="phase === 'switching'" role="status">Switching…</p>
      <p v-if="error" role="alert" data-test="mode-choice-error">{{ error }}</p>
    </section>
  </main>
</template>
<style scoped>
.transition-gate { display: grid; place-items: center; min-height: 100vh; padding: 24px 16px; background: var(--surface-contact); color: var(--text-primary); font-family: var(--font-ui); }
.transition-card { width: min(34rem, 100%); display: grid; gap: 12px; padding: 20px; background: var(--surface); border-radius: 8px; font-size: var(--type-reading); line-height: var(--leading-reading); }
h1 { margin: 0; font-size: var(--type-headline); font-weight: var(--weight-strong); line-height: var(--leading-headline); }
h1:focus { outline: none; }
p { margin: 0; color: var(--text-secondary); }
.note { font-size: var(--type-body); color: var(--text-tertiary); }
button { justify-self: start; font: inherit; font-weight: var(--weight-strong); color: var(--text-primary); background: var(--surface); border: 1px solid var(--focus-accent); border-radius: 6px; padding: 8px 14px; cursor: pointer; }
button.primary { background: var(--focus-fill); }
button:focus-visible { outline: 2px solid var(--focus-accent); outline-offset: 2px; }
button:disabled { opacity: .6; cursor: default; }
</style>
