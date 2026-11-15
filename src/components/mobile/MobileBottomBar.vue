<script setup lang="ts">
import type { ActionId } from '../../lib/action-registry';
import HeaderGlyph from '../HeaderGlyph.vue';
import PaneGlyph from '../PaneGlyph.vue';

defineProps<{
  reader: boolean;
  executeAction: (id: ActionId) => void;
}>();

const emit = defineEmits<{
  account: [];
}>();
</script>

<template>
  <div class="mobile-bottom-region" data-test="mobile-bottom-region">
    <div class="mobile-context-slot" data-test="mobile-context-slot">
      <slot name="context" />
    </div>
    <nav v-if="!reader" class="mobile-bottom-bar" aria-label="Primary navigation">
      <button
        type="button"
        class="mobile-nav-item"
        data-test="mobile-mail"
        title="Mail (Inbox)"
        @click="executeAction('inbox')"
      >
        <PaneGlyph name="inbox" />
        <span class="visually-hidden">Mail (Inbox)</span>
      </button>
      <button
        type="button"
        class="mobile-nav-item"
        data-test="mobile-search"
        title="Search"
        @click="executeAction('search')"
      >
        <HeaderGlyph name="search" />
        <span class="visually-hidden">Search</span>
      </button>
      <button
        type="button"
        class="mobile-account"
        data-test="mobile-account"
        title="Account"
        @click="emit('account')"
      >
        <PaneGlyph name="account" />
        <span class="visually-hidden">Account</span>
      </button>
    </nav>
    <div v-else class="mobile-reader-actions" data-test="mobile-reader-actions">
      <slot name="actions" />
    </div>
  </div>
</template>
