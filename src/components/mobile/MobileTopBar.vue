<script setup lang="ts">
import HeaderGlyph from '../HeaderGlyph.vue';
defineProps<{ reader: boolean; title: string; executeAction: (id: any) => void }>();
</script>
<template><header class="mobile-top-bar" data-test="mobile-top-bar">
  <button v-if="reader" type="button" class="mobile-round-button" data-test="mobile-reader-back" title="Back to conversation list" @click="executeAction('back')"><HeaderGlyph name="back"/><span class="visually-hidden">Back</span></button>
  <button v-else type="button" class="mobile-round-button" data-test="mobile-menu" title="Destinations" @click="executeAction('navigator')"><HeaderGlyph name="menu"/><span class="visually-hidden">Destinations</span></button>
  <h1 v-if="!reader && title !== 'Inbox'" class="mobile-title">{{ title }}</h1><span v-else class="mobile-spacer"></span>
  <button v-if="!reader" type="button" class="mobile-round-button" data-test="mobile-compose" title="Compose new local draft" @click="executeAction('compose')"><HeaderGlyph name="compose"/><span class="visually-hidden">Compose</span></button><span v-else class="mobile-spacer"></span>
</header></template>
