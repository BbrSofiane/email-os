import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { press as dispatchKey } from './helpers';
import { useDrawerRows } from '../src/composables/useDrawerRows';

/**
 * A minimal drawer: three rows (real buttons), a trailing action button that is
 * not a row, and a text field. The composable is exercised exactly as the panels
 * use it: `v-bind="rows.rowAttrs(key)"` and one container keydown handler.
 */
const Harness = defineComponent({
  props: { initial: { type: String as () => string | null, default: null } },
  setup(props) {
    const keys = ref(['a', 'b', 'c']);
    const rows = useDrawerRows({ keys: () => keys.value, initial: () => props.initial });
    return () => h('div', { 'data-test': 'container', onKeydown: rows.onKeydown }, [
      ...keys.value.map((key) => h('div', { key }, [
        h('button', { type: 'button', 'data-test': `row-${key}`, ...rows.rowAttrs(key) }, key),
        h('button', { type: 'button', 'data-test': `act-${key}` }, 'Act'),
      ])),
      h('input', { type: 'text', 'data-test': 'field' }),
    ]);
  },
});

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

function mountHarness(initial: string | null = null): VueWrapper {
  wrapper = mount(Harness, { props: { initial }, attachTo: document.body });
  return wrapper;
}
function focusTarget(w: VueWrapper, test: string): HTMLElement {
  const el = w.get(`[data-test="${test}"]`).element as HTMLElement;
  el.focus();
  return el;
}
const active = () => (document.activeElement as HTMLElement | null)?.dataset.test;

describe('useDrawerRows', () => {
  it('moves with ArrowDown/ArrowUp and J/K (any case) and stops at both ends', () => {
    const w = mountHarness();
    expect(dispatchKey('ArrowDown', { bubbles: true, cancelable: true }, focusTarget(w, 'row-a')).defaultPrevented).toBe(true);
    expect(active()).toBe('row-b');
    dispatchKey('j', { bubbles: true, cancelable: true }, focusTarget(w, 'row-b'));
    expect(active()).toBe('row-c');
    // No wrap at the end.
    dispatchKey('J', { bubbles: true, cancelable: true }, focusTarget(w, 'row-c'));
    expect(active()).toBe('row-c');
    dispatchKey('ArrowUp', { bubbles: true, cancelable: true }, focusTarget(w, 'row-c'));
    expect(active()).toBe('row-b');
    dispatchKey('k', { bubbles: true, cancelable: true }, focusTarget(w, 'row-b'));
    expect(active()).toBe('row-a');
    dispatchKey('K', { bubbles: true, cancelable: true }, focusTarget(w, 'row-a'));
    expect(active()).toBe('row-a');
  });

  it('jumps with Home and End', () => {
    const w = mountHarness();
    dispatchKey('End', { bubbles: true, cancelable: true }, focusTarget(w, 'row-b'));
    expect(active()).toBe('row-c');
    dispatchKey('Home', { bubbles: true, cancelable: true }, focusTarget(w, 'row-c'));
    expect(active()).toBe('row-a');
  });

  it('keeps one roving Tab stop: the first row, then the current row', async () => {
    const w = mountHarness();
    const tabs = () => ['a', 'b', 'c'].map((key) => w.get(`[data-test="row-${key}"]`).attributes('tabindex'));
    expect(tabs()).toEqual(['0', '-1', '-1']);
    dispatchKey('j', { bubbles: true, cancelable: true }, focusTarget(w, 'row-a'));
    await w.vm.$nextTick();
    expect(tabs()).toEqual(['-1', '0', '-1']);
    // Trailing buttons carry no tabindex of their own: they stay Tab-reachable.
    expect(w.get('[data-test="act-a"]').attributes('tabindex')).toBeUndefined();
  });

  it('starts the Tab stop on a remembered row', () => {
    const w = mountHarness('c');
    expect(['a', 'b', 'c'].map((key) => w.get(`[data-test="row-${key}"]`).attributes('tabindex'))).toEqual(['-1', '-1', '0']);
  });

  it('ignores editable targets, IME composition, modifiers and Shift', () => {
    const w = mountHarness();
    expect(dispatchKey('j', { bubbles: true, cancelable: true }, focusTarget(w, 'field')).defaultPrevented).toBe(false);
    expect(active()).toBe('field');
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }] as KeyboardEventInit[]) {
      const event = dispatchKey('ArrowDown', { bubbles: true, cancelable: true, ...init }, focusTarget(w, 'row-a'));
      expect(event.defaultPrevented).toBe(false);
      expect(active()).toBe('row-a');
    }
  });

  it('ignores a target that is not a row marker, so trailing buttons keep native keys', () => {
    const w = mountHarness();
    const event = dispatchKey('j', { bubbles: true, cancelable: true }, focusTarget(w, 'act-a'));
    expect(event.defaultPrevented).toBe(false);
    expect(active()).toBe('act-a');
    expect(dispatchKey('ArrowDown', { bubbles: true, cancelable: true }, focusTarget(w, 'act-a')).defaultPrevented).toBe(false);
  });

  it('leaves Enter, Space and Escape alone and lets Enter activate the row natively', async () => {
    const w = mountHarness();
    for (const key of ['Enter', ' ', 'Escape', 'Tab']) expect(dispatchKey(key, { bubbles: true, cancelable: true }, focusTarget(w, 'row-a')).defaultPrevented).toBe(false);
    // jsdom has no layout: a real click is what Enter produces on a button.
    let clicks = 0;
    w.get('[data-test="row-a"]').element.addEventListener('click', () => { clicks += 1; });
    await w.get('[data-test="row-a"]').trigger('click');
    expect(clicks).toBe(1);
  });

  it('skips disabled rows', async () => {
    const w = mountHarness();
    (w.get('[data-test="row-b"]').element as HTMLButtonElement).disabled = true;
    dispatchKey('ArrowDown', { bubbles: true, cancelable: true }, focusTarget(w, 'row-a'));
    expect(active()).toBe('row-c');
  });
});
