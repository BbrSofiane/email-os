import { describe, expect, it } from 'vitest';
import {
  actionDefinition,
  actionGroups,
  actionRegistry,
  bindingMatches,
  describeKey,
  findKeyBinding,
  goTargets,
  keyHints,
  keyOnlyDefinitions,
  type ActionDefinition,
  type KeyBinding,
  type KeyFocus,
  type KeySurface,
} from '../../src/lib/action-registry';

const definitions: readonly ActionDefinition[] = actionRegistry;
const keyOnly: ReadonlyArray<{ id: string; bindings: readonly KeyBinding[]; triggers?: readonly string[] }> = keyOnlyDefinitions;

/** A focus context that satisfies a surface (and no button rule), so a binding can be fired in isolation. */
const NONE: KeyFocus = {
  readerOpen: false, covered: false, browsingOwns: false, selectionKeysOwned: false, splitListOwns: false,
  remindersBrowsing: false, remindersRowOwns: false, draftsRowOwns: false, emptyLineAction: false,
  buttonOwns: false, shortcutBlocked: false, mailboxActionsEnabled: true,
};
const SURFACE_FOCUS: Record<KeySurface, KeyFocus> = {
  any: NONE,
  reader: { ...NONE, readerOpen: true },
  list: NONE,
  browsing: { ...NONE, browsingOwns: true },
  'browsing-or-reader': { ...NONE, browsingOwns: true },
  selection: { ...NONE, browsingOwns: true, selectionKeysOwned: true },
  'split-list': { ...NONE, browsingOwns: true, splitListOwns: true },
  'reminders-browsing': { ...NONE, browsingOwns: true, remindersBrowsing: true },
  'reminders-row': { ...NONE, browsingOwns: true, remindersBrowsing: true, remindersRowOwns: true, buttonOwns: true, shortcutBlocked: true },
  'drafts-row': { ...NONE, browsingOwns: true, draftsRowOwns: true, buttonOwns: true, shortcutBlocked: true },
  'empty-line': { ...NONE, browsingOwns: true, emptyLineAction: true },
};
const eventFor = (binding: KeyBinding, key = binding.keys[0]!) => ({ key, shiftKey: binding.shift === true, repeat: false });

/** Real focus situations; collisions are checked inside each. */
const SCENARIOS: Record<string, KeyFocus> = {
  'body or list row': { ...NONE, browsingOwns: true, selectionKeysOwned: true, splitListOwns: true },
  'empty state without action': { ...NONE, browsingOwns: true, selectionKeysOwned: true, splitListOwns: true },
  'empty state with action': { ...NONE, browsingOwns: true, selectionKeysOwned: true, splitListOwns: true, emptyLineAction: true },
  'list toolbar button': { ...NONE, buttonOwns: true, shortcutBlocked: true },
  'reminders pane': { ...NONE, browsingOwns: true, remindersBrowsing: true },
  'reminders row button': { ...NONE, browsingOwns: true, remindersBrowsing: true, remindersRowOwns: true, buttonOwns: true, shortcutBlocked: true },
  'drafts row button': { ...NONE, browsingOwns: true, draftsRowOwns: true, buttonOwns: true, shortcutBlocked: true },
  'trash list': { ...NONE, browsingOwns: true, splitListOwns: true },
  'reader body': { ...NONE, readerOpen: true },
  'reader message toggle': { ...NONE, readerOpen: true, buttonOwns: true, shortcutBlocked: false },
  'reader toolbar button': { ...NONE, readerOpen: true, buttonOwns: true, shortcutBlocked: true },
  'drawer or narrow disclosure': { ...NONE, covered: true, browsingOwns: true },
};

describe('action registry: declarations', () => {
  it('declares every action exactly once, with a label, a group, aliases and a glyph', () => {
    const ids = definitions.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(32);
    const groups = new Set(actionGroups.map((group) => group.id));
    for (const action of definitions) {
      expect(action.label.length, action.id).toBeGreaterThan(0);
      expect(groups.has(action.group), action.id).toBe(true);
      expect(Array.isArray(action.aliases), action.id).toBe(true);
      expect(action.glyph.family, action.id).toBeTruthy();
    }
  });

  it('draws a glyph for every command except the two that have none today', () => {
    const none = definitions.filter((action) => action.glyph.family === 'none').map((action) => action.id);
    expect(none).toEqual(['reply', 'reminder-settings']);
  });

  it('keeps unique labels', () => {
    const labels = definitions.map((action) => action.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('lists the destination navigator members', () => {
    expect(definitions.filter((action) => action.navigator).map((action) => action.id).sort()).toEqual(
      ['inbox', 'saved', 'done', 'destinations', 'trash', 'starred', 'account', 'activity', 'drafts', 'reminders', 'reminder-settings'].sort(),
    );
  });
});

describe('action registry: shortcuts have a binding that triggers them', () => {
  const shortcutOf = (id: string) => definitions.find((action) => action.id === id)!.shortcut;

  it('every shortcut text is backed by a key, a chord, a shared key or a key-only binding that names the action', () => {
    for (const action of definitions) {
      if (!action.shortcut) {
        expect(action.keys ?? [], `${action.id} declares a key but no shortcut text`).toEqual([]);
        expect(action.chord, `${action.id} declares a chord but no shortcut text`).toBeUndefined();
        continue;
      }
      const viaKeys = (action.keys ?? []).some((binding) => describeKey(binding) === action.shortcut);
      const viaChord = action.chord ? `G then ${action.chord.key.toUpperCase()}` === action.shortcut : false;
      const viaShared = action.sharesKeyWith ? shortcutOf(action.sharesKeyWith) === action.shortcut && (definitions.find((other) => other.id === action.sharesKeyWith)!.keys ?? []).length > 0 : false;
      const viaKeyOnly = keyOnly.some((def) => def.triggers?.includes(action.id) && def.bindings.some((binding) => describeKey(binding) === action.shortcut));
      expect(viaKeys || viaChord || viaShared || viaKeyOnly, `${action.id}: "${action.shortcut}" has no binding behind it`).toBe(true);
    }
  });

  it('every command binding is found by the lookup and resolves to its command', () => {
    for (const action of definitions) {
      for (const binding of action.keys ?? []) {
        for (const key of binding.keys) {
          const found = findKeyBinding(eventFor(binding, key), SURFACE_FOCUS[binding.surface]);
          expect(found, `${action.id} ${key}`).toBeDefined();
          expect(found).toMatchObject({ kind: 'command', action: action.id });
        }
      }
    }
  });

  it('every key-only binding is found by the lookup and resolves to its handler', () => {
    for (const definition of keyOnly) {
      for (const binding of definition.bindings) {
        for (const key of binding.keys) {
          const found = findKeyBinding(eventFor(binding, key), SURFACE_FOCUS[binding.surface]);
          expect(found, `${definition.id} ${key}`).toBeDefined();
          expect(found).toMatchObject({ kind: 'key', handler: definition.id });
        }
      }
    }
  });

  it('a chord shortcut has exactly one second key, shown in the hint order', () => {
    const chorded = definitions.filter((action) => action.chord);
    expect(chorded.map((action) => action.id).sort()).toEqual(['account', 'done', 'drafts', 'reminders', 'trash']);
    expect(new Set(chorded.map((action) => action.chord!.key)).size).toBe(chorded.length);
    expect(goTargets.map((target) => `${target.key}:${target.id}`)).toEqual(['e:done', 't:trash', 'd:drafts', 'h:reminders', 'a:account']);
    for (const action of chorded) expect(action.shortcut).toBe(`G then ${action.chord!.key.toUpperCase()}`);
  });

  it('a shared-key command points at a real command', () => {
    for (const action of definitions) {
      if (action.sharesKeyWith) expect(definitions.some((other) => other.id === action.sharesKeyWith)).toBe(true);
    }
  });
});

describe('action registry: no two bindings collide', () => {
  type Row = { name: string; binding: KeyBinding };
  const rows: Row[] = [
    ...definitions.flatMap((action) => (action.keys ?? []).map((binding) => ({ name: action.id, binding }))),
    ...keyOnly.flatMap((definition) => definition.bindings.map((binding) => ({ name: definition.id, binding }))),
  ];

  it('claims every real key event with at most one binding per priority, in every focus scenario', () => {
    const keys = [...new Set(rows.flatMap((row) => row.binding.keys))];
    const collisions: string[] = [];
    for (const [scenarioName, focus] of Object.entries(SCENARIOS)) {
      for (const key of keys) {
        for (const shiftKey of [false, true]) {
          for (const repeat of [false, true]) {
            const hits = rows.filter((row) => bindingMatches(row.binding, { key, shiftKey, repeat }, focus));
            const byPriority = new Map<number, Set<string>>();
            for (const hit of hits) {
              const priority = hit.binding.priority ?? 0;
              byPriority.set(priority, (byPriority.get(priority) ?? new Set<string>()).add(hit.name));
            }
            for (const [priority, names] of byPriority) {
              if (names.size > 1) collisions.push(`${scenarioName}: "${key}"${shiftKey ? '+Shift' : ''}${repeat ? ' repeat' : ''} p${priority} -> ${[...names].join(' vs ')}`);
            }
          }
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('the one declared overlap is the empty line before the list Enter', () => {
    const focus = SCENARIOS['empty state with action']!;
    expect(findKeyBinding({ key: 'Enter', shiftKey: false, repeat: false }, focus)).toMatchObject({ kind: 'key', handler: 'empty-line' });
    expect(findKeyBinding({ key: 'Enter', shiftKey: false, repeat: false }, SCENARIOS['empty state without action']!)).toMatchObject({ kind: 'command', action: 'open' });
  });
});

describe('action registry: lookup semantics', () => {
  const at = (scenario: string, key: string, init: { shiftKey?: boolean; repeat?: boolean } = {}) =>
    findKeyBinding({ key, shiftKey: init.shiftKey ?? false, repeat: init.repeat ?? false }, SCENARIOS[scenario]!);

  it('keys are case sensitive, like the dispatcher they replace', () => {
    expect(at('body or list row', 'h')).toMatchObject({ action: 'remind' });
    expect(at('body or list row', 'H')).toBeUndefined();
    expect(at('body or list row', 'E', { shiftKey: true })).toMatchObject({ action: 'unarchive' });
    expect(at('body or list row', 'E')).toBeUndefined();
    expect(at('body or list row', 'U', { shiftKey: true })).toMatchObject({ action: 'unread' });
  });

  it('a button owning the key blocks the strict bindings but not the reader message toggles', () => {
    expect(at('list toolbar button', 'Enter')).toBeUndefined();
    expect(at('list toolbar button', 'e')).toBeUndefined();
    expect(at('reader toolbar button', 'e')).toBeUndefined();
    expect(at('reader message toggle', 'e')).toMatchObject({ action: 'archive' });
    expect(at('reader message toggle', 's')).toMatchObject({ action: 'star', binding: { resolves: 'star-or-unstar' } });
    expect(at('reader toolbar button', 'z')).toBeUndefined();
  });

  it('a drafts row keeps C although it is a button', () => {
    expect(at('drafts row button', 'c')).toMatchObject({ action: 'compose' });
    expect(at('list toolbar button', 'c')).toBeUndefined();
    expect(at('drafts row button', 'Delete')).toMatchObject({ kind: 'key', handler: 'draft-discard' });
    expect(at('drafts row button', 'Delete', { shiftKey: true })).toBeUndefined();
  });

  it('H and Shift+H belong to a Reminders row button, plain H to Remind everywhere else', () => {
    expect(at('reminders row button', 'h')).toMatchObject({ kind: 'key', handler: 'reminder-row' });
    expect(at('reminders row button', 'H', { shiftKey: true })).toMatchObject({ kind: 'key', handler: 'reminder-row' });
    expect(at('reminders pane', 'h')).toMatchObject({ kind: 'command', action: 'remind' });
  });

  it('repeat: ignored keys do not match, swallowed keys do, the rest act', () => {
    expect(at('body or list row', 's', { repeat: true })).toBeUndefined();
    expect(at('body or list row', 'c', { repeat: true })).toBeUndefined();
    expect(at('body or list row', 'z', { repeat: true })).toMatchObject({ action: 'undo' });
    expect(at('body or list row', 'x', { repeat: true })).toMatchObject({ kind: 'key', handler: 'select-toggle' });
    expect(at('body or list row', 'j', { repeat: true })).toMatchObject({ kind: 'key', handler: 'list-move' });
  });

  it('a drawer or narrow disclosure stands every page key down but not / or Escape', () => {
    expect(at('drawer or narrow disclosure', 'h')).toBeUndefined();
    expect(at('drawer or narrow disclosure', 'j')).toBeUndefined();
    expect(at('drawer or narrow disclosure', '/')).toMatchObject({ action: 'search' });
    expect(at('drawer or narrow disclosure', 'Escape')).toMatchObject({ kind: 'key', handler: 'escape-ladder' });
  });

  it('plain e needs mailbox actions; the reader and the list use different surfaces', () => {
    const lookup = (readerOpen: boolean, mailboxActionsEnabled: boolean) =>
      findKeyBinding({ key: 'e', shiftKey: false, repeat: false }, { ...NONE, readerOpen, mailboxActionsEnabled });
    expect(lookup(true, true)).toMatchObject({ action: 'archive' });
    expect(lookup(false, true)).toMatchObject({ action: 'archive' });
    expect(lookup(true, false)).toBeUndefined();
    expect(lookup(false, false)).toBeUndefined();
  });

  it('the reader owns n p o O j k and consumes the list keys', () => {
    for (const key of ['n', 'N', 'p', 'P', 'o', 'O']) expect(at('reader body', key)).toMatchObject({ handler: 'reader-message' });
    for (const key of ['j', 'k']) expect(at('reader body', key)).toMatchObject({ handler: 'reader-move' });
    expect(at('reader body', 'ArrowDown')).toBeUndefined();
    expect(at('reader body', 'x')).toBeUndefined();
  });
});

describe('action registry: the palette views', () => {
  it('keeps the Keys list in declaration order with unique ids and keycaps', () => {
    expect(keyHints.map((hint) => hint.id)).toEqual(['move', 'select', 'extend', 'destinations', 'reminder-tabs', 'reminder-reschedule', 'reminder-cancel', 'draft-discard']);
    expect(new Set(keyHints.map((hint) => hint.id)).size).toBe(keyHints.length);
  });

  it('resolves a definition by id', () => {
    expect(actionDefinition('archive').label).toBe('Mark done');
  });
});
