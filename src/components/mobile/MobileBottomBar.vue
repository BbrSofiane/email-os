<script setup lang="ts">
import { ref } from 'vue';
import type { ActionId } from '../../lib/action-registry';
import HeaderGlyph from '../HeaderGlyph.vue';
import PaneGlyph from '../PaneGlyph.vue';

defineProps<{
  reader: boolean;
  inboxOrSaved: boolean;
  executeAction: (id: ActionId) => void;
  actionAvailable: (id: ActionId) => boolean;
  actionLabel: (id: ActionId) => string;
}>();

const actionsHost = ref<HTMLElement | null>(null);
defineExpose({ actionsHost });
</script>

<template>
  <div class="mobile-bottom-region" data-test="mobile-bottom-region">
    <div
      v-if="$slots.context"
      class="mobile-context-slot"
      data-test="mobile-context-slot"
    >
      <slot name="context" />
    </div>
    <div
      ref="actionsHost"
      class="mobile-reader-actions"
      data-test="mobile-reader-actions"
      :aria-hidden="!reader"
    />
    <nav v-if="!reader" class="mobile-navigation" aria-label="Primary">
      <button
        type="button"
        class="mobile-nav-item"
        data-test="mobile-mail"
        title="Mail (Inbox)"
        :aria-current="inboxOrSaved ? 'page' : undefined"
        @click="executeAction('inbox')"
      >
        <PaneGlyph name="inbox" />
        <span class="visually-hidden">Mail (Inbox)</span>
      </button>
      <button
        type="button"
        class="mobile-nav-item"
        data-test="mobile-search"
        :disabled="!actionAvailable('search')"
        :title="actionLabel('search')"
        @click="executeAction('search')"
      >
        <HeaderGlyph name="search" />
        <span class="visually-hidden">Search</span>
      </button>
    </nav>
    <button
      v-if="!reader"
      type="button"
      class="mobile-account"
      data-test="mobile-account"
      :disabled="!actionAvailable('account')"
      :title="actionLabel('account')"
      @click="executeAction('account')"
    >
      <PaneGlyph name="account" />
      <span class="visually-hidden">Account</span>
    </button>
  </div>
</template>
