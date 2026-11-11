import { flushVueNextTick } from './support/ui-settle';
/**
 * The docked reply composer shrinks the thread scroller. While a reply is open the
 * reader keeps the message being answered (the latest) in view above the card, until
 * the user scrolls or moves through the thread themselves. Geometry is stubbed: jsdom
 * has no layout, so this proves the decisions, not the pixels (measured in a browser).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';

import ReaderView from '../src/components/ReaderView.vue';
import type { Conversation } from '../src/lib/ipc/client';

const message = (id: string) => ({
  id,
  from: { displayName: 'Ada Fixture', mailbox: 'ada@example.test' },
  to: [{ displayName: 'You', mailbox: 'you@example.test' }],
  sentAt: '2026-02-02T09:00:00Z',
  bodyText: `Body of ${id}.`,
});
const conversation: Conversation = {
  ref: { accountId: 'a', conversationId: 'c1' },
  subject: 'Subject',
  messages: [message('m1'), message('m2'), message('m3')],
  isInInbox: true,
  pendingOperationId: null,
};

let wrapper: VueWrapper | null = null;
let observers: Array<{ callback: () => void; target: Element | null }> = [];
const scrollTopStore = new WeakMap<HTMLElement, number>();
const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
/** Viewport rectangles by data-test, mutable per test. */
let rects: Record<string, { top: number; bottom: number }> = {};

beforeEach(() => {
  observers = [];
  rects = { 'reader-scroll': { top: 100, bottom: 341 }, 'message-m3': { top: 286, bottom: 452 } };
  class FakeResizeObserver {
    private entry: { callback: () => void; target: Element | null };
    constructor(callback: () => void) { this.entry = { callback, target: null }; observers.push(this.entry); }
    observe(target: Element) { this.entry.target = target; }
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) { return scrollTopStore.get(this) ?? 0; },
    set(this: HTMLElement, value: number) { scrollTopStore.set(this, value); },
  });
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const key = (this as HTMLElement).dataset?.test ?? '';
    const r = rects[key];
    if (!r) return original.call(this);
    return { x: 0, y: r.top, left: 0, right: 100, top: r.top, bottom: r.bottom, width: 100, height: r.bottom - r.top, toJSON() {} } as DOMRect;
  };
  (Element.prototype as { __restoreRect?: unknown }).__restoreRect = original;
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  Element.prototype.getBoundingClientRect = (Element.prototype as unknown as { __restoreRect: () => DOMRect }).__restoreRect as never;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', originalScrollTop);
  else delete (HTMLElement.prototype as { scrollTop?: unknown }).scrollTop;
});

function mountReader(props: Record<string, unknown> = {}): VueWrapper {
  wrapper = mount(ReaderView, {
    props: { conversation, state: 'ready', error: null, commandInFlight: false, openRef: conversation.ref, ...props },
    attachTo: document.body,
  });
  return wrapper;
}

const scroller = (w: VueWrapper) => w.get('[data-test="reader-scroll"]').element as HTMLElement;
const fire = () => observers.forEach((o) => o.callback());

describe('reply composer keeps the answered message in view', () => {
  it('scrolls the latest message fully above the card when the reply opens', async () => {
    const w = mountReader();
    await flushVueNextTick();
    expect(scroller(w).scrollTop).toBe(0);
    await w.setProps({ replyDocked: true });
    await flushVueNextTick();
    // Latest bottom 452 vs viewport bottom 341: move down by 111.
    expect(scroller(w).scrollTop).toBe(111);
  });

  it('follows the latest message when the card grows (Cc / Subject opens) and the strip shrinks', async () => {
    const w = mountReader({ replyDocked: true });
    await flushVueNextTick();
    scrollTopStore.set(scroller(w), 0);
    rects['reader-scroll'] = { top: 100, bottom: 281 };
    rects['message-m3'] = { top: 226, bottom: 392 };
    fire();
    expect(scroller(w).scrollTop).toBe(111);
  });

  it('leaves the scroll alone when the latest message is already fully visible', async () => {
    rects['message-m3'] = { top: 180, bottom: 300 };
    const w = mountReader();
    await flushVueNextTick();
    await w.setProps({ replyDocked: true });
    await flushVueNextTick();
    expect(scroller(w).scrollTop).toBe(0);
  });

  it('stops following once the user scrolls the thread themselves', async () => {
    const w = mountReader({ replyDocked: true });
    await flushVueNextTick();
    await w.get('[data-test="reader-scroll"]').trigger('wheel');
    scrollTopStore.set(scroller(w), 7);
    fire();
    expect(scroller(w).scrollTop).toBe(7);
  });

  it('does nothing while no reply is docked', async () => {
    mountReader();
    await flushVueNextTick();
    fire();
    expect(scrollTopStore.get(document.querySelector('[data-test="reader-scroll"]') as HTMLElement) ?? 0).toBe(0);
  });

  it('does not move keyboard focus', async () => {
    const w = mountReader();
    await flushVueNextTick();
    const toggle = w.get('[data-test="message-toggle-m1"]').element as HTMLElement;
    toggle.focus();
    await w.setProps({ replyDocked: true });
    await flushVueNextTick();
    expect(document.activeElement).toBe(toggle);
  });
});
