<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import type { SavedSplit } from '../lib/ipc/client';
const props = defineProps<{ split: SavedSplit | null; busy: boolean; error: boolean }>();
const emit = defineEmits<{ save: [split: SavedSplit]; cancel: [] }>();
const form = ref<HTMLFormElement | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
let saveFocus: HTMLElement | null = null;
watch(() => props.busy, async (busy) => {
  if (busy) {
    const active = document.activeElement;
    saveFocus = active instanceof HTMLElement && form.value?.contains(active) ? active : null;
    return;
  }
  const previous = saveFocus;
  saveFocus = null;
  await nextTick(); // Wait until the fieldset and buttons are enabled again.
  const el = form.value;
  const active = document.activeElement;
  if (!props.error || props.busy || !previous || !el?.isConnected || el.closest('[inert]')) return;
  // Restore only focus displaced by this save, never focus moved to a different
  // view/control or an overlay. Unmounting also revokes this editor's ownership.
  if (active === document.body || el.contains(active)) {
    (previous.isConnected ? previous : nameInput.value)?.focus();
  }
}, { flush: 'sync' });
const draft = ref<SavedSplit>(props.split ? { ...props.split } : {
  name: '', criterion: 'sender', value: '', enabled: true, hideWhenEmpty: false,
});
onMounted(() => nameInput.value?.focus());
</script>

<template>
  <form ref="form" class="split-editor" aria-label="Saved split settings" @submit.prevent="!busy && emit('save', { ...draft })" @keydown.esc.stop.prevent="!busy && emit('cancel')">
    <p>One local view of Inbox. Matches the latest message’s sender, not recipients or message text. Saving or disabling a view never moves or deletes mail.</p>
    <fieldset :disabled="busy">
      <label>Name <input ref="nameInput" v-model="draft.name" required maxlength="40" data-test="split-name" /></label>
      <label>Match <select v-model="draft.criterion" data-test="split-criterion"><option value="sender">Exact sender address</option><option value="domain">Exact sender domain</option></select></label>
      <label>{{ draft.criterion === 'sender' ? 'Email address' : 'Domain (exact match; no @)' }} <input v-model="draft.value" required maxlength="320" :placeholder="draft.criterion === 'sender' ? 'alice@example.com' : 'example.com'" data-test="split-value" autocapitalize="none" spellcheck="false" /></label>
      <label><input v-model="draft.enabled" type="checkbox" data-test="split-enabled" /> Enabled</label>
      <label><input v-model="draft.hideWhenEmpty" type="checkbox" data-test="split-hide-empty" /> Hide tab when empty (still reachable in Commands)</label>
    </fieldset>
    <p v-if="error" role="alert">Could not save or load the split. Use a name (1–40 characters) and one valid address or domain, then retry. Your mail is unchanged.</p>
    <button type="submit" :disabled="busy" data-test="split-save">{{ busy ? 'Saving…' : 'Save split' }}</button>
    <button type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
  </form>
</template>
