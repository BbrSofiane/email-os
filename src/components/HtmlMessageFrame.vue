<script lang="ts">
import type { MessageHtmlBody } from '../lib/ipc/generated';
import type { SanitizedMail } from '../lib/html-mail/sanitize';

// Keep only the last 20 sanitized variants, including their inline metadata.
const cache = new Map<string, { mail: SanitizedMail; body: MessageHtmlBody }>();
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ConversationRef, MailClient } from '../lib/ipc/client';
import { sanitizeMailHtml } from '../lib/html-mail/sanitize';
import { frameHasNativeGlobals } from '../lib/html-mail/frame-guard';
import { buildFrameDocument, fitZoom, FRAME_SANDBOX, type FrameTheme } from '../lib/html-mail/frame-document';

const props = defineProps<{
  client: MailClient;
  conversation: ConversationRef;
  messageId: string;
  /** Accessible frame title, e.g. "Message from Ana Ridpath". */
  title: string;
  /** The user chose "Load images" for this message (reader visit only). */
  remoteImages: boolean;
  quoteOpen: boolean;
  /** App reading tokens; the paper/adaptive mode follows the mail itself. */
  theme: Omit<FrameTheme, 'mode'>;
}>();
const emit = defineEmits<{ link: [url: string, text: string]; state: [value: { remoteBlocked: number; hasTrailingQuote: boolean }]; fallback: [reason: 'unavailable' | 'error'] }>();
const frame = ref<HTMLIFrameElement | null>(null);
const result = ref<{ mail: SanitizedMail; body: MessageHtmlBody } | null>(null);
const unavailable = ref(false);
let generation = 0;
let cleanup = () => {};
let fetchedKey = '';
let fetched: Promise<MessageHtmlBody> | null = null;

watch(() => [props.conversation.accountId, props.conversation.conversationId, props.messageId, props.remoteImages] as const, async ([account, conversation, message, remote]) => {
  const current = ++generation;
  cleanup();
  result.value = null;
  unavailable.value = false;
  const identity = JSON.stringify([account, conversation, message]);
  const key = JSON.stringify([account, conversation, message, remote]);
  try {
    let entry = cache.get(key);
    if (!entry) {
      if (fetchedKey !== identity || !fetched) {
        fetchedKey = identity;
        fetched = props.client.getMessageHtml({ accountId: account, conversationId: conversation }, message);
      }
      const body = await fetched;
      entry = { body, mail: sanitizeMailHtml(body.html, { remoteImages: remote }) };
      cache.set(key, entry);
      if (cache.size > 20) cache.delete(cache.keys().next().value!);
    } else {
      cache.delete(key);
      cache.set(key, entry);
    }
    if (current === generation) result.value = entry;
  } catch {
    if (current === generation) emit('fallback', 'error');
  }
}, { immediate: true });

const srcdoc = ref('');
/** Mail that sets its own colours renders on a paper card; other mail takes the app's colours (ADR 0006 decision 15). */
const paper = computed(() => result.value?.mail.hasOwnColours ?? false);
watch([result, () => props.theme], () => {
  if (!result.value) {
    srcdoc.value = '';
    return;
  }
  const theme: FrameTheme = { ...props.theme, mode: paper.value ? 'paper' : 'adaptive' };
  srcdoc.value = buildFrameDocument(result.value.mail, {
    remoteImages: props.remoteImages,
    theme,
    quoteOpen: props.quoteOpen,
  });
}, { deep: true });
watch(() => props.quoteOpen, (open) => {
  frame.value?.contentDocument?.documentElement.classList.toggle('eos-quote-open', open);
  requestAnimationFrame(() => fit());
});

let fit = () => {};
function onLoad() {
  const element = frame.value;
  const entry = result.value;
  if (!element || !entry) return;
  cleanup();
  if (frameHasNativeGlobals(element)) {
    unavailable.value = true;
    emit('fallback', 'unavailable');
    return;
  }
  const doc = element.contentDocument;
  if (!doc) return;
  const root = doc.documentElement;
  let active = true;
  let raf = 0;
  fit = () => {
    if (!active || !element.clientWidth) return;
    root.style.zoom = '1';
    root.style.overflowX = 'hidden';
    // The frame always takes its content height, so it never scrolls vertically.
    root.style.overflowY = 'hidden';
    const width = root.scrollWidth;
    const zoom = fitZoom(width, element.clientWidth);
    root.style.zoom = String(zoom);
    root.style.overflowX = width * zoom > element.clientWidth ? 'auto' : 'hidden';
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (!active) return;
      // Engines disagree on whether sizes of a zoomed root are reported zoomed.
      // Collapsing the frame for one synchronous layout makes the scrolling
      // element's scrollHeight equal to the content height in the frame's own
      // pixels, whatever the engine's zoom semantics (no paint happens between).
      element.style.height = '0px';
      const height = (doc.scrollingElement ?? root).scrollHeight;
      element.style.height = `${Math.ceil(height)}px`;
    });
  };
  const activate = (target: EventTarget | null) => {
    const link = target && (target as Node).nodeType === 1 ? (target as Element).closest('[data-eos-href]') : null;
    const url = link?.getAttribute('data-eos-href');
    if (url) emit('link', url, (link?.textContent ?? '').trim().slice(0, 200));
  };
  const click = (event: MouseEvent) => { event.preventDefault(); activate(event.target); };
  const keydown = (event: KeyboardEvent) => {
    const target = event.target as Element | null;
    if ((event.key === 'Enter' || event.key === ' ') && target?.closest('[data-eos-href]')) {
      event.preventDefault();
      activate(target);
      return;
    }
    if ((event.shiftKey && /^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/.test(event.key)) || ((event.ctrlKey || event.metaKey) && /^[ac]$/i.test(event.key))) return;
    const forwarded = new KeyboardEvent('keydown', { key: event.key, code: event.code, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey, repeat: event.repeat, bubbles: true, cancelable: true });
    if (!element.dispatchEvent(forwarded)) event.preventDefault();
  };
  doc.addEventListener('click', click, true);
  doc.addEventListener('keydown', keydown, true);
  const images = [...doc.querySelectorAll('img')];
  for (const img of images) {
    img.addEventListener('load', fit);
    const inline = entry.body.inlineImages.find((item) => item.contentId === img.dataset.eosCid);
    if (inline) void props.client.getInlineImage(props.conversation, props.messageId, inline.attachmentId).then((data) => {
      if (active) img.src = `data:${data.mimeType};base64,${data.base64}`;
    }).catch(() => {});
  }
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
  if (element.parentElement) observer?.observe(element.parentElement);
  cleanup = () => {
    active = false;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    doc.removeEventListener('click', click, true);
    doc.removeEventListener('keydown', keydown, true);
    for (const img of images) img.removeEventListener('load', fit);
    fit = () => {};
  };
  fit();
  emit('state', { remoteBlocked: entry.mail.remoteBlocked, hasTrailingQuote: entry.mail.hasTrailingQuote });
}
onBeforeUnmount(() => { generation++; cleanup(); });
</script>

<template>
  <iframe v-if="result && !unavailable" ref="frame" :sandbox="FRAME_SANDBOX" :srcdoc="srcdoc" :title="title" class="html-message-frame" :class="{ paper }" referrerpolicy="no-referrer" @load="onLoad" />
</template>

<style scoped>
.html-message-frame { display: block; width: 100%; border: 0; }
.html-message-frame.paper { border-radius: 8px; background: #ffffff; }
</style>
