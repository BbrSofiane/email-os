<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ConversationRef, MailClient } from '../lib/ipc/client';
import type { MessageHtmlBody } from '../lib/ipc/generated';
import { cachedMail, cacheMail, mailCacheEpoch, type CachedMail } from '../lib/html-mail/mail-cache';
import { sanitizeMailHtml } from '../lib/html-mail/sanitize';
import { frameHasNativeGlobals } from '../lib/html-mail/frame-guard';
import { attachFrameSignals, frameListenersRun, keepBrokenImageRatio } from '../lib/html-mail/frame-signals';
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
const result = ref<CachedMail | null>(null);
const unavailable = ref(false);
let generation = 0;
let cleanup = () => {};
let fetchedKey = '';
let fetched: Promise<MessageHtmlBody> | null = null;

/** A new frame per document: removed listeners are always followed by a load. */
const frameKey = ref(0);

// Separate sources, so a refresh that only replaces the conversation object
// with equal ids does not tear down a message that stays on screen.
watch([
  () => props.conversation.accountId,
  () => props.conversation.conversationId,
  () => props.messageId,
  () => props.remoteImages,
] as const, async ([account, conversation, message, remote]) => {
  const current = ++generation;
  cleanup();
  result.value = null;
  unavailable.value = false;
  const identity = JSON.stringify([account, conversation, message]);
  const key = JSON.stringify([account, conversation, message, remote]);
  try {
    let entry = cachedMail(key);
    if (!entry) {
      const epoch = mailCacheEpoch();
      if (fetchedKey !== identity || !fetched) {
        fetchedKey = identity;
        fetched = props.client.getMessageHtml({ accountId: account, conversationId: conversation }, message);
      }
      const body = await fetched;
      entry = { body, mail: sanitizeMailHtml(body.html, { remoteImages: remote }) };
      cacheMail(key, entry, epoch);
    }
    if (current === generation) {
      frameKey.value += 1;
      result.value = entry;
    }
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
  // Immediate: a cached message sets `result` during setup, before this watch exists.
}, { deep: true, immediate: true });
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
  const images = [...doc.querySelectorAll('img')];
  let active = true;
  let raf = 0;
  fit = () => {
    if (!active || !element.clientWidth) return;
    for (const img of images) keepBrokenImageRatio(img);
    root.style.zoom = '1';
    root.style.overflowX = 'hidden';
    // The frame always takes its content height, so it never scrolls vertically.
    root.style.overflowY = 'hidden';
    // The root's scrollWidth leaves out its end padding when content overflows,
    // so measure how far content exceeds the body and keep both paddings.
    const overflow = Math.max(0, doc.body.scrollWidth - doc.body.clientWidth);
    const width = Math.max(root.scrollWidth, element.clientWidth + overflow);
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
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
  if (element.parentElement) observer?.observe(element.parentElement);
  let detach: () => void;
  if (frameListenersRun(doc)) {
    // Chromium (Android WebView, browser preview): the app's listeners run on frame nodes.
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
    for (const img of images) img.addEventListener('load', fit);
    detach = () => {
      doc.removeEventListener('click', click, true);
      doc.removeEventListener('keydown', keydown, true);
      for (const img of images) img.removeEventListener('load', fit);
    };
  } else {
    // WebKit runs no listener on a frame without allow-scripts (ADR 0006,
    // implementation record 12): signals that need no code in the frame.
    detach = attachFrameSignals(element, doc, {
      onLink: activate,
      releaseFocus: () => {
        const host = element.parentElement?.closest<HTMLElement>('[tabindex]');
        if (host) host.focus({ preventScroll: true });
        else element.blur();
      },
    });
    // An image that loads or fails changes size; that replaces the load listener.
    for (const img of images) observer?.observe(img);
  }
  for (const img of images) {
    const inline = entry.body.inlineImages.find((item) => item.contentId === img.dataset.eosCid);
    if (inline) void props.client.getInlineImage(props.conversation, props.messageId, inline.attachmentId).then((data) => {
      if (active) img.src = `data:${data.mimeType};base64,${data.base64}`;
    }).catch(() => {});
  }
  cleanup = () => {
    active = false;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    detach();
    fit = () => {};
  };
  fit();
  emit('state', { remoteBlocked: entry.mail.remoteBlocked, hasTrailingQuote: entry.mail.hasTrailingQuote });
}
onBeforeUnmount(() => { generation++; cleanup(); });
</script>

<template>
  <iframe v-if="result && !unavailable" :key="frameKey" ref="frame" :sandbox="FRAME_SANDBOX" :srcdoc="srcdoc" :title="title" class="html-message-frame" :class="{ paper }" referrerpolicy="no-referrer" @load="onLoad" />
</template>

<style scoped>
.html-message-frame { display: block; width: 100%; border: 0; }
.html-message-frame.paper { border-radius: 8px; background: #ffffff; }
</style>
