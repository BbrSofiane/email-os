<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MailClient } from '../lib/ipc/client';
import { linkHostMismatch, mailtoAddress } from '../lib/external-links';

const props = defineProps<{ url: string; text?: string; client: MailClient; preview: boolean; canOpen: boolean }>();
const emit = defineEmits<{ close: []; compose: [address: string]; opened: [status: string] }>();
const status = ref('');
const isMailto = computed(() => /^mailto:/i.test(props.url));
const address = computed(() => mailtoAddress(props.url));
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    status.value = isMailto.value ? 'Address copied.' : 'Link copied.';
  } catch {
    status.value = 'Clipboard unavailable. The link is shown as plain text.';
  }
}
async function open() {
  try {
    await props.client.openExternalLink(props.url);
    status.value = props.preview ? 'Modelled external open only; no browser was launched.' : 'Handed link to the system browser.';
    emit('opened', status.value);
  } catch {
    status.value = 'Could not open the link. You can copy it instead.';
  }
}
</script>
<template>
  <div role="group" aria-label="Confirm external browser">
    <template v-if="isMailto">
      <p v-if="address" class="link-confirm-url">{{ address }}</p>
      <p v-else>This address is not valid.</p>
      <template v-if="address">
        <button type="button" @click="copy(address)">Copy address</button>
        <button type="button" @click="emit('compose', address)">New message to {{ address }}</button>
      </template>
    </template>
    <template v-else>
      <p>Leave Email OS and open this link in your system browser?</p>
      <p class="link-confirm-url">{{ url }}</p>
      <p v-if="linkHostMismatch(url, text ?? '')">The link text shows a different address.</p>
      <p v-if="!canOpen">Opening links is not available on this device.</p>
      <button v-if="canOpen" type="button" @click="open">Open in browser</button>
      <button type="button" @click="copy(url)">Copy link</button>
    </template>
    <button type="button" @click="emit('close')">Keep reading</button>
    <p v-if="status" role="status" aria-live="polite">{{ status }}</p>
  </div>
</template>

<style scoped>
p { margin: 0 0 0.75rem; line-height: 1.5; }
.link-confirm-url { color: var(--text-primary); overflow-wrap: anywhere; font-family: var(--font-mono); }
button + button { margin-inline-start: 0.5rem; }
</style>
