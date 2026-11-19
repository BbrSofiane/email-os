<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import HeaderGlyph from '../HeaderGlyph.vue';

export interface MobileActionSheetItem {
  id: string;
  label: string;
  glyph: 'menu' | 'search' | 'commands' | 'star' | 'back' | 'remind' | 'reminders' | 'x' | 'compose' | 'done' | 'files' | 'reply' | 'read' | 'unread' | 'prev' | 'next' | 'copy' | 'collapse' | 'contact' | 'prompt';
  disabled?: boolean;
  disabledReason?: string;
  group?: string;
  keepOpenOnChoose?: boolean;
}

const props = defineProps<{ title: string; items: MobileActionSheetItem[] }>();
const emit = defineEmits<{ choose: [id: string]; close: [] }>();
const dialog = ref<HTMLElement | null>(null);
const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

function enabledRows(): HTMLButtonElement[] {
  return [...(dialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
}
function close(): void {
  emit('close');
  nextTick(() => opener?.focus());
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' || event.key === 'Backspace') {
    event.preventDefault();
    close();
    return;
  }
  const rows = enabledRows();
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
  } else if (event.key === 'Tab' && rows.length) {
    if (event.shiftKey && index <= 0) { event.preventDefault(); rows.at(-1)?.focus(); }
    else if (!event.shiftKey && index === rows.length - 1) { event.preventDefault(); rows[0]?.focus(); }
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  nextTick(() => enabledRows()[0]?.focus());
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="mobile-action-sheet-scrim" data-test="action-sheet-scrim" @click.self="close">
    <section
      ref="dialog"
      class="mobile-action-sheet"
      role="dialog"
      aria-modal="true"
      :aria-label="props.title"
      data-test="action-sheet"
    >
      <h2 class="mobile-action-sheet-title">{{ props.title }}</h2>
      <div class="mobile-action-sheet-items">
        <template v-for="(item, index) in props.items" :key="item.id">
          <div v-if="index > 0 && item.group !== props.items[index - 1]?.group" class="mobile-action-sheet-divider" role="separator" />
          <button
            type="button"
            class="mobile-action-sheet-row"
            :disabled="item.disabled"
            :title="item.disabledReason"
            :aria-label="item.disabledReason ? `${item.label}. ${item.disabledReason}` : item.label"
            @click="emit('choose', item.id); if (!item.keepOpenOnChoose) close()"
          >
            <HeaderGlyph :name="item.glyph" />
            <span>{{ item.label }}</span>
          </button>
        </template>
      </div>
    </section>
  </div>
</template>
