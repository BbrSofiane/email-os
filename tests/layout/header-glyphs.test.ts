import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import HeaderGlyph from '../../src/components/HeaderGlyph.vue';

describe('HeaderGlyph additions', () => {
  let wrappers: VueWrapper[] = [];

  afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
  });

  it.each(['copy', 'collapse', 'contact', 'prompt', 'select'] as const)('%s renders its named SVG with a shape', (name) => {
    const wrapper = mount(HeaderGlyph, { props: { name } });
    wrappers.push(wrapper);
    const svg = wrapper.get('svg');
    expect(svg.attributes('data-glyph')).toBe(name);
    expect(svg.element.children.length).toBeGreaterThan(0);
  });
});
