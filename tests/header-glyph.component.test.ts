import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import HeaderGlyph from '../src/components/HeaderGlyph.vue';
import CommandGlyph from '../src/components/CommandGlyph.vue';

const markup = (name: 'remind' | 'reminders') => mount(HeaderGlyph, { props: { name } }).html();

describe('reminder glyphs', () => {
  it('draws "Remind me" (an action on this conversation) and "Reminders" (the list) differently', () => {
    expect(markup('remind')).not.toBe(markup('reminders'));
    // Remind keeps the clock the row action also uses; Reminders is the bell.
    expect(markup('remind')).toContain('<circle');
    expect(markup('reminders')).not.toContain('<circle');
  });

  it('uses the matching glyph in the command palette', () => {
    const glyph = (id: 'remind' | 'reminders') => mount(CommandGlyph, { props: { id } }).html();
    expect(glyph('remind')).toContain('<circle');
    expect(glyph('reminders')).not.toContain('<circle');
  });
});
