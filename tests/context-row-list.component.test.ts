/**
 * ContextRowList: the shared row list of the list contexts whose rows are not
 * threads. Keyboard model (roving tabindex, J/K, arrows, Home, End, no wrap),
 * what it ignores, the one-signal current row, opening, and the slots.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import ContextRowList from '../src/components/ContextRowList.vue';

interface Item { key: string; name: string; note?: string }
const items: Item[] = [{ key: 'a', name: 'Alpha' }, { key: 'b', name: 'Beta', note: 'Needs attention' }, { key: 'c', name: 'Gamma' }];

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });

function mountList(props: Record<string, unknown> = {}) {
  wrapper = mount(ContextRowList, {
    props: { items, label: 'Test rows', ...props },
    attachTo: document.body,
    slots: {
      lead: '<i class="lead-mark"></i>',
      primary: '<template #primary="{ item }"><b class="name">{{ item.name }}</b></template>',
      secondary: '<template #secondary="{ item }"><span v-if="item.key === \'a\'" class="second">second</span></template>',
      trailing: '<template #trailing="{ item }"><time class="when" datetime="2030-01-01T00:00:00.000Z">{{ item.key }}</time></template>',
      actions: '<template #actions="{ item }"><button type="button" class="act">Act {{ item.key }}</button></template>',
      note: '<template #note="{ item }"><p v-if="item.note" class="note">{{ item.note }}</p></template>',
    },
  });
  return wrapper;
}
const mains = () => wrapper!.findAll('[data-drawer-row]');
function press(el: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  (el as HTMLElement).focus();
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

describe('ContextRowList anatomy', () => {
  it('renders a named list of rows with the Conversation Row geometry classes and the slots in order', () => {
    const w = mountList();
    expect(w.get('ul').attributes('role')).toBe('list');
    expect(w.get('ul').attributes('aria-label')).toBe('Test rows');
    expect(w.findAll('li')).toHaveLength(3);
    const first = w.get('li');
    const row = first.get('.context-row');
    const order = [...row.element.children].map((child) => child.className);
    expect(order).toEqual(['context-row-lead', 'context-row-main', 'context-row-secondary', 'context-row-actions', 'context-row-trailing']);
    expect(row.get('.context-row-main').text()).toBe('Open Alpha');
    expect(row.get('.second').text()).toBe('second');
    expect(row.get('time').attributes('datetime')).toBe('2030-01-01T00:00:00.000Z');
    // An exception line sits under its row only where one applies.
    expect(w.findAll('.note').map((note) => note.text())).toEqual(['Needs attention']);
    expect(w.findAll('li')[1]!.get('.note').element.previousElementSibling).toBe(w.findAll('li')[1]!.get('.context-row').element);
  });

  it('opens with a visually hidden verb that can be replaced, and a row title', () => {
    mountList({ openVerb: 'Edit', rowTitle: (item: Item) => `Title ${item.key}` });
    expect(mains()[0]!.text()).toBe('Edit Alpha');
    expect(mains()[0]!.attributes('title')).toBe('Title a');
  });
});

describe('ContextRowList current row (the one signal)', () => {
  it('marks the first row current, then the focused one, with aria-current on exactly one item', async () => {
    const w = mountList();
    const current = () => w.findAll('li').map((li) => li.attributes('aria-current') ?? '');
    expect(current()).toEqual(['true', '', '']);
    expect(w.findAll('.context-row.focused')).toHaveLength(1);
    (mains()[2]!.element as HTMLElement).focus();
    await nextTick();
    expect(current()).toEqual(['', '', 'true']);
    expect(w.findAll('.context-row.focused')).toHaveLength(1);
    expect(w.findAll('li')[2]!.get('.context-row').classes()).toContain('focused');
  });

  it('restores the remembered current row and reports a change before any open', async () => {
    const w = mountList({ activeKey: 'b' });
    expect(w.findAll('li').map((li) => li.attributes('aria-current') ?? '')).toEqual(['', 'true', '']);
    expect(mains().map((main) => main.attributes('tabindex'))).toEqual(['-1', '0', '-1']);
    await mains()[2]!.trigger('focus');
    expect(w.emitted('update:activeKey')!.at(-1)).toEqual(['c']);
    await mains()[0]!.trigger('click');
    expect(w.emitted('update:activeKey')!.at(-1)).toEqual(['a']);
    expect(w.emitted('open')![0]).toEqual([items[0]]);
  });

  it('opens a row by a click outside its controls but not from its action buttons', async () => {
    const w = mountList();
    await w.findAll('.context-row')[1]!.trigger('click');
    expect(w.emitted('open')).toHaveLength(1);
    expect(w.emitted('open')![0]).toEqual([items[1]]);
    await w.findAll('.act')[2]!.trigger('click');
    expect(w.emitted('open')).toHaveLength(1);
  });
});

describe('ContextRowList keyboard', () => {
  it('is one Tab stop: the first row, then the current row', () => {
    mountList();
    expect(mains().map((main) => main.attributes('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('moves with ArrowDown/ArrowUp and J/K, jumps with Home and End, and never wraps', () => {
    mountList();
    const focused = () => (document.activeElement as HTMLElement).dataset.drawerRow;
    expect(press(mains()[0]!.element, 'ArrowDown').defaultPrevented).toBe(true);
    expect(focused()).toBe('b');
    press(document.activeElement!, 'j');
    expect(focused()).toBe('c');
    press(document.activeElement!, 'J');
    expect(focused()).toBe('c');
    press(document.activeElement!, 'ArrowUp');
    expect(focused()).toBe('b');
    press(document.activeElement!, 'k');
    press(document.activeElement!, 'K');
    expect(focused()).toBe('a');
    press(document.activeElement!, 'End');
    expect(focused()).toBe('c');
    press(document.activeElement!, 'Home');
    expect(focused()).toBe('a');
  });

  it('leaves Enter to the native button, and the trailing action buttons to native keys', () => {
    const w = mountList();
    // Enter is never handled here: the real button owns it.
    expect(press(mains()[0]!.element, 'Enter').defaultPrevented).toBe(false);
    const act = w.findAll('.act')[0]!.element;
    const event = press(act, 'j');
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(act);
  });

  it('ignores IME composition, modifier keys and editable targets', () => {
    const w = mountList();
    const input = document.createElement('input');
    w.element.appendChild(input);
    expect(press(mains()[0]!.element, 'j', { isComposing: true }).defaultPrevented).toBe(false);
    expect(press(mains()[0]!.element, 'j', { keyCode: 229 }).defaultPrevented).toBe(false);
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
      expect(press(mains()[0]!.element, 'j', init).defaultPrevented).toBe(false);
    }
    expect(press(input, 'j').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('focusRow focuses a row by key, falls back to the first row, and the list when it has none', async () => {
    const w = mountList();
    const vm = w.vm as unknown as { focusRow: (key: string | null) => Promise<void> };
    await vm.focusRow('c');
    expect((document.activeElement as HTMLElement).dataset.drawerRow).toBe('c');
    await vm.focusRow('missing');
    expect((document.activeElement as HTMLElement).dataset.drawerRow).toBe('a');
    await w.setProps({ items: [] });
    await vm.focusRow('a');
    expect(document.activeElement).toBe(w.get('ul').element);
  });
});
