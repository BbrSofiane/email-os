import { mount, type VueWrapper } from '@vue/test-utils';
import ReaderView from '../src/components/ReaderView.vue';
import type { Conversation } from '../src/lib/ipc/client';

/** Mount a ReaderView with the shared neutral transport defaults used by unit suites. */
export function mountReaderView(
  conversation: Conversation,
  props: Record<string, unknown> = {},
  state: 'ready' | 'loading' | 'error' = 'ready',
): VueWrapper {
  return mount(ReaderView, {
    props: {
      conversation: state === 'ready' ? conversation : null,
      state,
      error: null,
      commandInFlight: false,
      openRef: conversation.ref,
      ...props,
    },
    attachTo: document.body,
  });
}
