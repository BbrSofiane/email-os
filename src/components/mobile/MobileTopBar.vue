<script setup lang="ts">
import { ref } from 'vue';
import type { ActionId } from '../../lib/action-registry';
import HeaderGlyph from '../HeaderGlyph.vue';

defineProps<{
  reader: boolean;
  title: string;
  executeAction: (id: ActionId) => void;
  openDestinations: () => void;
}>();

const backHost = ref<HTMLElement | null>(null);
defineExpose({ backHost });
</script>

<template>
  <header class="mobile-top-bar" data-test="mobile-top-bar">
    <span
      v-if="reader"
      ref="backHost"
      class="mobile-back-host"
      data-test="mobile-back-host"
    />
    <button
      v-else
      type="button"
      class="mobile-round-button"
      data-test="mobile-menu"
      title="Destinations"
      aria-label="Destinations"
      @click="openDestinations"
    >
      <HeaderGlyph name="menu" />
      <span class="visually-hidden">Destinations</span>
    </button>
    <span v-if="!reader && title !== 'Inbox'" class="mobile-title">{{ title }}</span>
    <span v-else class="mobile-spacer" />
    <button
      v-if="!reader"
      type="button"
      class="mobile-round-button"
      data-test="mobile-compose"
      title="Compose new local draft"
      aria-label="Compose new local draft"
      @click="executeAction('compose')"
    >
      <HeaderGlyph name="compose" />
      <span class="visually-hidden">Compose</span>
    </button>
    <span v-else class="mobile-spacer" />
  </header>
</template>
