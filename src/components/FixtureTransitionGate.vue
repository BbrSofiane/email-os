<script setup lang="ts">
/**
 * Startup screen for the one-time retirement of a legacy fixture database
 * (ADR 0002 stage 4). It stands in front of the app until the backend says the
 * transition is not needed or done. Closing the window is the cancel path:
 * nothing is changed and the user is asked again next launch.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { MailClient } from '../lib/ipc/client';
import {
  DISCLOSURE_ACTION,
  DISCLOSURE_CANCEL_NOTE,
  DISCLOSURE_PARAGRAPHS,
  DISCLOSURE_TITLE,
  UNAVAILABLE_MESSAGE,
  failureMessage,
  useFixtureTransition,
} from '../composables/useFixtureTransition';

const props = defineProps<{ client: MailClient }>();
const emit = defineEmits<{ (event: 'cleared'): void }>();

const gate = useFixtureTransition(props.client);
const { phase, status } = gate;
const heading = ref<HTMLElement | null>(null);
let stopCloseListener: (() => void) | null = null;
let alive = true;

watch(phase, async (next) => {
  if (next === 'clear') emit('cleared');
  else if (next !== 'checking') {
    await nextTick();
    heading.value?.focus();
  }
});

onMounted(async () => {
  // Closing the window while nothing is running is the documented cancel; while
  // the backup runs the window stays open until it is finished.
  props.client
    .subscribeAppClose((request) => {
      if (gate.phase.value === 'working') void props.client.cancelAppClose(request.requestId);
      else void props.client.completeAppClose(request.requestId);
    })
    .then((stop) => {
      if (alive) stopCloseListener = stop;
      else stop();
    })
    .catch(() => {});
  await gate.load();
});

onBeforeUnmount(() => {
  alive = false;
  stopCloseListener?.();
});
</script>

<template>
  <main class="transition-gate" data-test="fixture-transition-gate" aria-labelledby="transition-gate-title">
    <section v-if="phase === 'checking'" class="transition-card" aria-busy="true">
      <h1 id="transition-gate-title" ref="heading" tabindex="-1" class="visually-hidden">Starting Email OS</h1>
      <p role="status" data-test="transition-checking">Checking the demo mailbox…</p>
    </section>

    <section v-else-if="phase === 'disclosure'" class="transition-card" data-test="transition-disclosure">
      <h1 id="transition-gate-title" ref="heading" tabindex="-1">{{ DISCLOSURE_TITLE }}</h1>
      <p v-for="paragraph in DISCLOSURE_PARAGRAPHS(status?.legacyMegabytes ?? 1)" :key="paragraph">{{ paragraph }}</p>
      <div class="transition-actions">
        <button type="button" class="transition-primary" data-test="transition-accept" @click="gate.accept()">{{ DISCLOSURE_ACTION }}</button>
      </div>
      <p class="transition-note" data-test="transition-cancel-note">{{ DISCLOSURE_CANCEL_NOTE }}</p>
    </section>

    <section v-else-if="phase === 'working'" class="transition-card" aria-busy="true" data-test="transition-working">
      <h1 id="transition-gate-title" ref="heading" tabindex="-1">{{ DISCLOSURE_TITLE }}</h1>
      <p role="status">Backing up and checking the old mailbox. Please keep this window open.</p>
    </section>

    <section v-else-if="phase === 'failed' && status" class="transition-card" data-test="transition-failed">
      <h1 id="transition-gate-title" ref="heading" tabindex="-1">The mailbox could not be renewed yet</h1>
      <p role="alert" data-test="transition-failure">{{ failureMessage(status) }}</p>
      <div class="transition-actions">
        <button type="button" class="transition-primary" data-test="transition-retry" @click="gate.accept()">Try again</button>
      </div>
      <p class="transition-note">{{ DISCLOSURE_CANCEL_NOTE }}</p>
    </section>

    <section v-else-if="phase === 'unavailable'" class="transition-card" data-test="transition-unavailable">
      <h1 id="transition-gate-title" ref="heading" tabindex="-1">Email OS could not start</h1>
      <p role="alert">{{ UNAVAILABLE_MESSAGE }}</p>
      <div class="transition-actions">
        <button type="button" class="transition-primary" data-test="transition-recheck" @click="gate.load()">Check again</button>
      </div>
    </section>
  </main>
</template>

<style scoped>
.transition-gate {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 24px 16px;
  background: var(--surface-contact);
  color: var(--text-primary);
  font-family: var(--font-ui);
}
.transition-card {
  width: min(34rem, 100%);
  display: grid;
  gap: 12px;
  padding: 20px;
  background: var(--surface);
  border-radius: 8px;
  font-size: var(--type-reading);
  line-height: var(--leading-reading);
}
.transition-card h1 {
  margin: 0;
  font-size: var(--type-headline);
  font-weight: var(--weight-strong);
  line-height: var(--leading-headline);
}
.transition-card h1:focus { outline: none; }
.transition-card p { margin: 0; color: var(--text-secondary); }
.transition-note { font-size: var(--type-body); color: var(--text-tertiary); }
.transition-actions { display: flex; gap: 8px; }
.transition-primary {
  font: inherit;
  font-weight: var(--weight-strong);
  color: var(--text-primary);
  background: var(--focus-fill);
  border: 1px solid var(--focus-accent);
  border-radius: 6px;
  padding: 8px 14px;
  cursor: pointer;
}
.transition-primary:focus-visible { outline: 2px solid var(--focus-accent); outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
</style>
