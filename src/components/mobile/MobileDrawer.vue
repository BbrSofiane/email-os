<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { ActionId, AvailableAction } from '../../lib/action-registry';
import HeaderGlyph from '../HeaderGlyph.vue';
import PaneGlyph from '../PaneGlyph.vue';

const props = defineProps<{
  open: boolean;
  email: string;
  current: ActionId | null;
  actions: AvailableAction[];
}>();
const emit = defineEmits<{
  close: [];
  execute: [id: ActionId];
  commands: [];
}>();

const panel = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;
const labels: Partial<Record<ActionId, string>> = {
  inbox: 'Inbox',
  saved: 'Saved split',
  starred: 'Starred',
  drafts: 'Drafts',
  done: 'Done',
  reminders: 'Reminders',
  trash: 'Trash',
  destinations: 'Provider mail',
  activity: 'Activity',
  account: 'Account',
  'reminder-settings': 'Reminder settings',
};
const order: ActionId[] = ['inbox', 'saved', 'starred', 'drafts', 'done', 'reminders', 'trash', 'destinations', 'activity', 'account', 'reminder-settings'];
const rows = () => order.flatMap((id) => {
  const action = props.actions.find((candidate) => candidate.id === id);
  return action ? [{ id, action, label: id === 'saved' ? action.label.replace(/^Go to /, '') : labels[id] ?? action.label }] : [];
});

function glyph(id: ActionId): string {
  if (id === 'inbox' || id === 'done' || id === 'drafts' || id === 'trash' || id === 'activity' || id === 'account' || id === 'destinations') return id === 'destinations' ? 'provider' : id;
  if (id === 'starred') return 'star';
  if (id === 'reminders') return 'reminders';
  if (id === 'saved') return 'files';
  return 'commands';
}

function focusCycle(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(() => props.open, async (open) => {
  if (open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    panel.value?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    if (!panel.value?.contains(document.activeElement)) panel.value?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  } else {
    await nextTick();
    if (returnFocus?.isConnected) returnFocus.focus();
  }
});

function choose(id: ActionId): void {
  emit('execute', id);
  emit('close');
}
</script>

<template>
  <div v-if="open" class="mobile-drawer-layer" data-test="mobile-drawer-layer">
    <button class="mobile-drawer-scrim" type="button" aria-label="Close Destinations" data-test="mobile-drawer-scrim" @click="emit('close')" />
    <section
      ref="panel"
      class="mobile-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Destinations"
      data-test="mobile-drawer"
      id="mobile-navigation-drawer"
      @keydown="focusCycle"
    >
      <p class="mobile-drawer-account">{{ email }}</p>
      <template v-for="(row, index) in rows()" :key="row.id">
        <div v-if="index === 8" class="mobile-drawer-separator" />
        <button
          type="button"
          class="mobile-drawer-row"
          :aria-current="current === row.id ? 'page' : undefined"
          :aria-description="row.action.label !== row.label ? row.action.label : undefined"
          :title="row.action.disabledReason"
          :disabled="!!row.action.disabledReason"
          @click="choose(row.id)"
        >
          <PaneGlyph v-if="['inbox', 'done', 'drafts', 'trash', 'activity', 'account', 'destinations'].includes(row.id)" :name="glyph(row.id) as 'inbox'" />
          <HeaderGlyph v-else :name="glyph(row.id) as 'menu'" />
          <span>{{ row.label }}</span>
        </button>
      </template>
      <button type="button" class="mobile-drawer-row" data-test="mobile-drawer-commands" @click="emit('commands')">
        <HeaderGlyph name="commands" />
        <span>Commands</span>
      </button>
    </section>
  </div>
</template>
