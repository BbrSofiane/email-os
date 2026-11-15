/**
 * The attachment chooser's state, moved verbatim out of App.vue: the conversation
 * snapshot it shows, where focus and the reader's scroll position go back to when
 * it closes, and the open and close commands. Only the chooser's own origin
 * and scroll handling lives here; the reader's navigation and focus restoration
 * stay with the owner. The shell's keys, `inert` guards and template read the
 * returned state and commands.
 */
import { nextTick, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { Mailbox } from './useMailbox';

export interface AttachmentChooserDeps {
  mailbox: Mailbox;
  accountId: ComputedRef<string | null>;
  /** The shell's own root: the reader scroller is looked up inside it, so two workspaces never share one. */
  appRoot: Ref<HTMLElement | null>;
  /** A utility drawer or the palette/navigator overlay keeps the chooser closed. */
  drawer: Ref<string | null>;
  overlay: Ref<string | null>;
  readerOpen: ComputedRef<boolean>;
  /** Opening the chooser drops an armed G chord. */
  cancelGo: () => void;
}

export function useAttachmentChooser({ mailbox, accountId, appRoot, drawer, overlay, readerOpen, cancelGo }: AttachmentChooserDeps) {
  const attachmentConversation = ref<import('../lib/ipc/client').Conversation | null>(null);
  let attachmentOrigin: HTMLElement | null = null;
  let attachmentScroll = 0;
  function openAttachments(origin?: HTMLElement) {
    if (drawer.value || overlay.value || !readerOpen.value || mailbox.detailState.value !== 'ready' || !mailbox.conversation.value) return;
    cancelGo();
    attachmentOrigin = origin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    attachmentScroll = appRoot.value?.querySelector('.reader-scroll')?.scrollTop ?? 0;
    attachmentConversation.value = structuredClone(JSON.parse(JSON.stringify(mailbox.conversation.value)));
  }
  async function closeAttachments() {
    attachmentConversation.value = null;
    await nextTick();
    if (attachmentOrigin?.isConnected && !attachmentOrigin.closest('[inert]')) attachmentOrigin.focus({ preventScroll: true });
    const scroll = appRoot.value?.querySelector('.reader-scroll');
    if (scroll) scroll.scrollTop = attachmentScroll;
  }
  watch(accountId, () => { attachmentConversation.value = null; });
  return { attachmentConversation, openAttachments, closeAttachments };
}
