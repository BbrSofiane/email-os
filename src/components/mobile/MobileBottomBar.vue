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
/**
 * Context slot above the bar row: the list teleports its split tabs here and
 * the reader its reply bar. Always rendered so a Teleport has a target; CSS
 * hides it while it is empty and adds its height to the scroll clearance
 * while it is not.
 */
const contextHost = ref<HTMLElement | null>(null);
defineExpose({ actionsHost, contextHost });
</script>

<template>
  <div class="mobile-bottom-region" data-test="mobile-bottom-region">
    <div
      ref="contextHost"
      class="mobile-context-slot"
      data-test="mobile-context-slot"
    />
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
      v-if="!reader && actionAvailable('account')"
      type="button"
      class="mobile-account"
      data-test="mobile-account"
      :title="actionLabel('account')"
      @click="executeAction('account')"
    >
      <PaneGlyph name="account" />
      <span class="visually-hidden">Account</span>
    </button>
  </div>
</template>
