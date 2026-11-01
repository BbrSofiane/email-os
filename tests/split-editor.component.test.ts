import { afterEach, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import SplitEditor from '../src/components/SplitEditor.vue';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.replaceChildren(); });

function editor() {
  wrapper = mount(SplitEditor, { props: { split: null, busy: false, error: false }, attachTo: document.body });
  return wrapper;
}

// jsdom keeps disabled fields focused and even ignores blur() on them. Use
// a temporary focusable node to model Chrome's displacement to BODY; trusted
// displacement itself is asserted in discovery.rendered.test.ts.
function displaceToBody() {
  const temporary = document.createElement('button');
  document.body.append(temporary);
  temporary.focus();
  temporary.blur();
  temporary.remove();
}

it('restores the pre-save field after failure, not merely mount-time focus', async () => {
  const form = editor();
  const field = form.get<HTMLInputElement>('[data-test="split-value"]');
  field.element.focus();
  await form.setProps({ busy: true });
  displaceToBody();
  expect(document.activeElement).toBe(document.body);
  await form.setProps({ error: true, busy: false });
  await flushPromises();
  expect(document.activeElement).toBe(field.element);
});

it.each(['external', 'overlay', 'unmounted'] as const)('does not reclaim focus when ownership is %s', async (destination) => {
  const form = editor();
  await form.setProps({ busy: true });
  displaceToBody();
  const other = document.createElement('button');
  document.body.append(other);
  if (destination === 'external') other.focus();
  if (destination === 'overlay') form.element.setAttribute('inert', '');
  if (destination === 'unmounted') { form.unmount(); wrapper = null; }
  else await form.setProps({ busy: false, error: true });
  await flushPromises();
  expect(document.activeElement).toBe(destination === 'external' ? other : document.body);
});

it('does not emit duplicate saves or cancel in flight; success does not refocus fields', async () => {
  const form = editor();
  await form.get('form').trigger('submit');
  expect(form.emitted('save')).toHaveLength(1);
  await form.setProps({ busy: true });
  displaceToBody();
  await form.get('form').trigger('submit');
  await form.get('form').trigger('keydown', { key: 'Escape' });
  expect(form.emitted('save')).toHaveLength(1);
  expect(form.emitted('cancel')).toBeUndefined();
  await form.setProps({ busy: false });
  await flushPromises();
  expect(document.activeElement).toBe(document.body);
});
