import { onBeforeUnmount, ref } from 'vue';
import type { ConversationRef, MailClient } from '../lib/ipc/client';
import type { AttachmentDescriptor } from '../lib/ipc/generated';
import { displayFileName } from '../lib/display-name';

/** Stable identity of one file inside a conversation. */
export function attachmentKey(file: Pick<AttachmentDescriptor, 'messageId' | 'attachmentId'>): string {
  return `${file.messageId}:${file.attachmentId}`;
}

export const ATTACHMENT_SAVE_ERROR = 'File not saved: unavailable offline, missing, cancelled, too large, or invalid content. Retry explicitly; a lost response may have left a unique file in Downloads.';
export const ATTACHMENT_CANCEL_ERROR = 'Could not confirm cancellation. A completed download may remain in Downloads.';

/**
 * The one save/cancel transfer state shared by the Cmd+O chooser and the inline
 * attachment rows. One transfer at a time. Status and error text is exact and
 * honest: nothing is claimed saved until `saveAttachment` resolves, and a
 * cancellation is only "requested" until the transfer stops.
 *
 * Call from a component's setup: an in-flight transfer is cancelled and later
 * results are ignored when that component unmounts.
 */
export function useAttachmentTransfer(options: {
  client: () => MailClient;
  conversation: () => ConversationRef;
  preview: () => boolean;
}) {
  const pending = ref<string | null>(null);
  const status = ref('');
  const error = ref('');
  /** Key of the file the current status/error line belongs to. */
  const target = ref<string | null>(null);
  let live = true;
  let epoch = 0;

  async function save(file: AttachmentDescriptor): Promise<void> {
    if (pending.value) return;
    const id = crypto.randomUUID();
    const mine = epoch;
    pending.value = id;
    error.value = '';
    status.value = '';
    target.value = attachmentKey(file);
    const client = options.client();
    try {
      const saved = await client.saveAttachment({
        conversation: { ...options.conversation() },
        messageId: file.messageId,
        attachmentId: file.attachmentId,
        requestId: id,
      });
      if (live && mine === epoch) {
        status.value = options.preview()
          ? 'Modelled save in preview memory only; no file was written.'
          : `Saved to Downloads as ${displayFileName(saved.filename)}. No file was opened.`;
      }
    } catch {
      if (live && mine === epoch) error.value = ATTACHMENT_SAVE_ERROR;
    } finally {
      if (live && pending.value === id) pending.value = null;
    }
  }

  async function cancel(): Promise<void> {
    const id = pending.value;
    if (!id) return;
    const mine = epoch;
    try {
      await options.client().cancelAttachment(id);
      if (live && mine === epoch) status.value = 'Cancellation requested; waiting for transfer to stop.';
    } catch {
      if (live && mine === epoch) error.value = ATTACHMENT_CANCEL_ERROR;
    }
  }

  /** Drop the visible outcome (the conversation changed). Does not cancel. */
  function reset(): void {
    epoch += 1;
    status.value = '';
    error.value = '';
    target.value = null;
  }

  onBeforeUnmount(() => {
    live = false;
    if (pending.value) void options.client().cancelAttachment(pending.value).catch(() => {});
  });

  return { pending, status, error, target, save, cancel, reset };
}
