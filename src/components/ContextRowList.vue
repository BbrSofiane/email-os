<script setup lang="ts" generic="T extends { key: string }">
/**
 * Rows of a list context whose rows are not threads (Reminders, Drafts):
 * the Conversation Row geometry of DESIGN.md with slots instead of sender,
 * subject and snippet.
 *
 * - 36px rows on 12px type, inset 6px from both pane edges, a 44px gutter
 *   (`lead`), the text on the 50px content inset, the trailing slot about 25px
 *   from the pane edge. No row borders: rows are separated by rhythm alone.
 * - The current row is the one signal: Focus Stone fill plus the 4px Dusk
 *   Lavender bar, and `aria-current` on its item, like InboxList.
 * - One real button per row (`primary`) is the row's action and its keyboard
 *   marker. `secondary` is a quiet Ash line beside it, outside the button's
 *   name. ArrowUp/ArrowDown or J/K, Home and End move between rows through
 *   `useDrawerRows` (roving tabindex, no wrap; editable targets, IME and
 *   modified keys are ignored). Enter and Space stay native. The trailing slot
 *   and the row `actions` are not rows: they keep native Tab and Enter and
 *   stay Tab-reachable. Escape is the app's.
 * - Clicking the row outside any control opens it, like an Inbox row.
 * - `note` is an exception line under its row (Coral or Amber), only where one
 *   applies.
 */
import { computed, nextTick, ref } from 'vue';
import { useDrawerRows } from '../composables/useDrawerRows';

const props = defineProps<{
  items: readonly T[];
  /** The list's accessible name. */
  label: string;
  /** The remembered current row key (restored after a reader round trip). */
  activeKey?: string | null;
  /** Visually hidden verb that starts the open button's accessible name. */
  openVerb?: string;
  /** Hover title of the open button (for example a revision). */
  rowTitle?: (item: T) => string | undefined;
  rowTestId?: (item: T) => string | undefined;
  /** Test hook of the open button (the row's marker element). */
  openTestId?: (item: T) => string | undefined;
  /** Rows cannot be opened while true (an editor transition is running). */
  disabled?: boolean;
}>();
const emit = defineEmits<{ open: [item: T]; 'update:activeKey': [key: string] }>();

const listEl = ref<HTMLElement | null>(null);
const rows = useDrawerRows({ keys: () => props.items.map(item => item.key), initial: () => props.activeKey ?? null });
/** The current row: the remembered one, else the first (the Tab stop). */
const currentKey = computed(() => {
  const keys = props.items.map(item => item.key);
  return rows.active.value !== null && keys.includes(rows.active.value) ? rows.active.value : keys[0] ?? null;
});

/** Opening a row also makes it the remembered current row, so Back lands on it. */
function open(item: T): void {
  if (props.disabled) return;
  emit('update:activeKey', item.key);
  emit('open', item);
}

function onRowClick(event: MouseEvent, item: T): void {
  const target = event.target;
  if (target instanceof Element && target.closest('button, a, input, select, textarea, label')) return;
  open(item);
}

/** Focus one row's button (or the list itself when there is no row to take it). */
async function focusRow(key: string | null, options: { preventScroll?: boolean } = {}): Promise<void> {
  await nextTick();
  const button = key === null ? null : [...(listEl.value?.querySelectorAll<HTMLElement>('[data-drawer-row]') ?? [])]
    .find(el => el.dataset.drawerRow === key) ?? null;
  const first = listEl.value?.querySelector<HTMLElement>('[data-drawer-row]') ?? null;
  (button ?? first ?? listEl.value)?.focus({ preventScroll: options.preventScroll ?? false });
}

defineExpose({ focusRow, el: listEl });
</script>

<template>
  <ul ref="listEl" class="context-list" role="list" :aria-label="label" tabindex="-1" @keydown="rows.onKeydown">
    <li
      v-for="item in items"
      :key="item.key"
      class="context-item"
      role="listitem"
      :aria-current="currentKey === item.key ? 'true' : undefined"
      :data-test="rowTestId?.(item)"
    >
      <div class="context-row" :class="{ focused: currentKey === item.key }" @click="onRowClick($event, item)">
        <span class="context-row-lead"><slot name="lead" :item="item" /></span>
        <button
          type="button"
          class="context-row-main"
          v-bind="rows.rowAttrs(item.key)"
          :title="rowTitle?.(item)"
          :data-test="openTestId?.(item)"
          :disabled="disabled || undefined"
          @focus="emit('update:activeKey', item.key)"
          @click="open(item)"
        >
          <span class="visually-hidden">{{ `${openVerb ?? 'Open'} ` }}</span>
          <span class="context-row-primary"><slot name="primary" :item="item" /></span>
        </button>
        <span class="context-row-secondary"><slot name="secondary" :item="item" /></span>
        <span class="context-row-actions"><slot name="actions" :item="item" /></span>
        <span class="context-row-trailing"><slot name="trailing" :item="item" /></span>
      </div>
      <slot name="note" :item="item" />
    </li>
  </ul>
</template>
