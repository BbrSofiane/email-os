import type { ConversationRef } from './ipc/client';

/**
 * The one place that declares a command. Each action is declared once, here:
 * its id, label, the shortcut it shows, its palette group, its search aliases,
 * its glyph, whether the destination navigator lists it, and (where the key
 * belongs to the command) its key binding and its G-chord second key.
 *
 * Availability ("can this run right now?") and execution depend on app state,
 * so the app supplies them as typed handler tables (`ActionHandlers` in
 * App.vue is a mapped type over `ActionId`: a missing handler is a compile
 * error). Keys that are not commands (J/K movement, X, Shift+J/K, the Escape
 * ladder, Reminders and Drafts row keys …) are declared once too, in
 * `keyOnlyDefinitions`, beside the command bindings, and `onKeydown` only
 * works out the focus context, asks `findKeyBinding`, checks availability and
 * dispatches. Pure data and pure functions: no Vue, no app state.
 */

export type ActionGroup = 'conversation' | 'selection' | 'view' | 'goto' | 'account';

export const actionGroups: ReadonlyArray<{ id: ActionGroup; label: string }> = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'selection', label: 'Selection' },
  { id: 'view', label: 'View' },
  { id: 'goto', label: 'Go to' },
  { id: 'account', label: 'Account' },
];

/** Glyph families reuse the row, header and pane glyph components; `own` shapes are drawn by CommandGlyph. */
export type GlyphSpec =
  | { readonly family: 'row'; readonly name: 'archive' | 'restore' | 'mark-read' | 'mark-unread' }
  | { readonly family: 'header'; readonly name: 'back' | 'remind' | 'reminders' | 'search' | 'star'; readonly filled?: true }
  | { readonly family: 'pane'; readonly name: 'inbox' | 'done' | 'provider' | 'trash' | 'drafts' | 'activity' | 'account' }
  | { readonly family: 'own'; readonly shape: 'open' | 'undo' | 'select-all-loaded' | 'clear-selection' | 'split' | 'filter' | 'sync' | 'switch' }
  /** Declared on purpose: the command has no glyph today and its icon slot stays empty. */
  | { readonly family: 'none' };

// ---------------------------------------------------------------------------
// Key bindings
// ---------------------------------------------------------------------------

/**
 * Which surface must own the key. `onKeydown` works the focus context out once
 * (`KeyFocus`); a binding only names the surface it needs.
 */
export type KeySurface =
  | 'any'
  | 'reader' // reader open
  | 'list' // reader closed
  | 'browsing' // list, empty state, Reminders/Drafts pane or body; no button owns it
  | 'browsing-or-reader'
  | 'selection' // the list surface that owns X and Shift+J/K
  | 'split-list' // a focused Inbox row or the empty state while the list is ready
  | 'reminders-browsing' // Reminders list and a browsing surface
  | 'reminders-row' // focus on a Reminders list row
  | 'drafts-row' // focus on a Drafts list row
  | 'empty-line'; // focus on the empty line itself, with its action shown

/** How a focused button treats the key: free (no check), the shortcut exclusion (message toggles stay usable), any button, or the shortcut exclusion except a Drafts row. */
export type KeyButtons = 'free' | 'shortcut' | 'strict' | 'shortcut-or-drafts-row';

/** `allow` acts on auto-repeat; `ignore` does not match a repeat (it falls through); `swallow` consumes a repeat without acting. */
export type KeyRepeat = 'allow' | 'ignore' | 'swallow';

/** `page` bindings stand down while a drawer or the narrow contact disclosure covers the page; `global` ones do not. */
export type KeyLayer = 'page' | 'global';

export interface KeyBinding {
  /** `KeyboardEvent.key` values that match (case sensitive: `h` and `H` are different bindings). */
  readonly keys: readonly string[];
  /** Required Shift state; omitted means either. */
  readonly shift?: boolean;
  readonly surface: KeySurface;
  readonly buttons: KeyButtons;
  readonly repeat: KeyRepeat;
  readonly scope: KeyLayer;
  /** A binding that only applies while mailbox actions are enabled (the plain `e`). */
  readonly needsMailboxActions?: true;
  /** Higher claims the key before lower; default 0. Commands come before key-only bindings at equal priority. */
  readonly priority?: number;
  /** Command bindings: `always` prevents the default and executes (the action checks itself); `when-available` only when it is available, but claims the key either way. */
  readonly prevent?: 'always' | 'when-available';
  /** Command bindings: the one key that picks between two commands (S: Star or Unstar). */
  readonly resolves?: KeyResolverId;
}

export type KeyResolverId = 'star-or-unstar';

export interface ChordSpec {
  /** The second key after G (lowercase, unmodified). */
  readonly key: string;
  /** The word the armed-chord hint uses ("D for Done"). */
  readonly word: string;
  /** Position in the hint ("E for Done, T for Trash …"). */
  readonly hintOrder: number;
}

export interface ActionDefinition {
  readonly id: string;
  readonly label: string;
  /** The shortcut text the palette shows (`''` for none). Kept explicit; the consistency test proves it matches the binding. */
  readonly shortcut: string;
  readonly group: ActionGroup;
  readonly glyph: GlyphSpec;
  /** Extra search words; the label and the bound key are always searchable. */
  readonly aliases: readonly string[];
  /** Listed by the destination navigator (Left from the list). */
  readonly navigator: boolean;
  readonly keys?: readonly KeyBinding[];
  readonly chord?: ChordSpec;
  /** The shortcut belongs to another command's binding (Unstar shares S with Star). */
  readonly sharesKeyWith?: string;
}

const NO_REPEAT = 'ignore' as const;

/**
 * Declaration order is the palette order inside a group (a stable sort by group
 * keeps it). Shortcut text is shown as declared; `action-registry.test.ts` proves
 * each one is backed by a binding that triggers it.
 */
export const actionRegistry = [
  {
    id: 'compose', label: 'Compose new local draft', shortcut: 'C', group: 'conversation',
    glyph: { family: 'pane', name: 'drafts' }, aliases: ['new message', 'write', 'new draft', 'mail'], navigator: false,
    // Compose works from both the list and the reader, and from a Drafts row's open button.
    keys: [{ keys: ['c'], shift: false, surface: 'browsing-or-reader', buttons: 'shortcut-or-drafts-row', repeat: NO_REPEAT, scope: 'page', prevent: 'always' }],
  },
  {
    id: 'reply', label: 'Reply', shortcut: 'R', group: 'conversation',
    glyph: { family: 'none' }, aliases: ['respond', 'answer', 'write back', 'draft'], navigator: false,
    // Reply works from the reader only: the source is the displayed latest message.
    keys: [{ keys: ['r'], shift: false, surface: 'reader', buttons: 'shortcut', repeat: NO_REPEAT, scope: 'page', prevent: 'when-available' }],
  },
  {
    id: 'open', label: 'Open conversation', shortcut: 'Enter', group: 'conversation',
    glyph: { family: 'own', shape: 'open' }, aliases: ['read', 'view', 'enter'], navigator: false,
    keys: [{ keys: ['Enter'], surface: 'list', buttons: 'strict', repeat: 'allow', scope: 'page', prevent: 'always' }],
  },
  {
    id: 'back', label: 'Back', shortcut: 'Escape', group: 'conversation',
    glyph: { family: 'header', name: 'back' }, aliases: ['close', 'return', 'previous screen'], navigator: false,
    // Escape is the key-only `escape-ladder` below: it decides between Back, Clear selection and the surfaces.
  },
  {
    id: 'archive', label: 'Mark done', shortcut: 'E', group: 'conversation',
    glyph: { family: 'row', name: 'archive' }, aliases: ['archive', 'done', 'finish', 'clear'], navigator: false,
    keys: [
      { keys: ['e'], surface: 'reader', buttons: 'shortcut', repeat: 'allow', scope: 'page', needsMailboxActions: true, prevent: 'always' },
      { keys: ['e'], surface: 'list', buttons: 'strict', repeat: 'allow', scope: 'page', needsMailboxActions: true, prevent: 'always' },
    ],
  },
  {
    id: 'unarchive', label: 'Mark not done', shortcut: 'Shift+E', group: 'conversation',
    glyph: { family: 'row', name: 'restore' }, aliases: ['unarchive', 'restore', 'not done', 'move to inbox', 'undone', 'restore to inbox'], navigator: false,
    keys: [{ keys: ['E'], shift: true, surface: 'any', buttons: 'shortcut', repeat: 'allow', scope: 'page', prevent: 'always' }],
  },
  {
    id: 'remind', label: 'Remind me (this device)', shortcut: 'H', group: 'conversation',
    glyph: { family: 'header', name: 'remind' }, aliases: ['snooze', 'later', 'reminder'], navigator: false,
    keys: [{ keys: ['h'], shift: false, surface: 'any', buttons: 'shortcut', repeat: NO_REPEAT, scope: 'page', prevent: 'when-available' }],
  },
  {
    id: 'undo', label: 'Undo last action', shortcut: 'Z', group: 'conversation',
    glyph: { family: 'own', shape: 'undo' }, aliases: ['undo', 'revert', 'reverse', 'take back'], navigator: false,
    // Key auto-repeat must not double-dispatch undo.
    keys: [{ keys: ['z'], shift: false, surface: 'any', buttons: 'shortcut', repeat: 'swallow', scope: 'page', prevent: 'always' }],
  },
  {
    id: 'star', label: 'Star', shortcut: 'S', group: 'conversation',
    glyph: { family: 'header', name: 'star' }, aliases: ['favorite', 'flag', 'important', 'pin'], navigator: false,
    keys: [{ keys: ['s'], shift: false, surface: 'browsing-or-reader', buttons: 'shortcut', repeat: NO_REPEAT, scope: 'page', prevent: 'always', resolves: 'star-or-unstar' }],
  },
  {
    id: 'unstar', label: 'Unstar', shortcut: 'S', group: 'conversation',
    // Unstar: the filled star, the state it takes away.
    glyph: { family: 'header', name: 'star', filled: true }, aliases: ['unfavorite', 'unflag', 'remove star'], navigator: false,
    sharesKeyWith: 'star',
  },
  {
    id: 'read', label: 'Mark read', shortcut: '', group: 'conversation',
    glyph: { family: 'row', name: 'mark-read' }, aliases: ['seen', 'opened'], navigator: false,
  },
  {
    id: 'unread', label: 'Mark unread', shortcut: 'Shift+U', group: 'conversation',
    glyph: { family: 'row', name: 'mark-unread' }, aliases: ['unseen', 'new'], navigator: false,
    keys: [{ keys: ['U'], shift: true, surface: 'any', buttons: 'shortcut', repeat: 'allow', scope: 'page', prevent: 'always' }],
  },
  {
    id: 'select-all-loaded', label: 'Select all loaded', shortcut: '', group: 'selection',
    glyph: { family: 'own', shape: 'select-all-loaded' }, aliases: ['select all', 'every', 'bulk'], navigator: false,
  },
  {
    id: 'clear-selection', label: 'Clear selection', shortcut: 'Escape', group: 'selection',
    glyph: { family: 'own', shape: 'clear-selection' }, aliases: ['deselect', 'unselect', 'none'], navigator: false,
  },
  {
    id: 'search', label: 'Find older mail', shortcut: '/', group: 'view',
    glyph: { family: 'header', name: 'search' }, aliases: ['find', 'older', 'history'], navigator: false,
    // The one command key that stays live above a drawer, like Escape; availability decides.
    keys: [{ keys: ['/'], surface: 'any', buttons: 'free', repeat: 'allow', scope: 'global', prevent: 'when-available' }],
  },
  {
    id: 'create-split', label: 'Create split', shortcut: '', group: 'view',
    glyph: { family: 'own', shape: 'split' }, aliases: ['new split', 'new view', 'filter inbox'], navigator: false,
  },
  {
    id: 'edit-split', label: 'Edit split', shortcut: '', group: 'view',
    glyph: { family: 'own', shape: 'split' }, aliases: ['change split', 'rename split', 'view'], navigator: false,
  },
  {
    id: 'toggle-unread-filter', label: 'Show unread only', shortcut: '', group: 'view',
    glyph: { family: 'own', shape: 'filter' }, aliases: ['filter', 'unread only', 'all conversations'], navigator: false,
  },
  {
    id: 'inbox', label: 'Go to Inbox', shortcut: '', group: 'goto',
    glyph: { family: 'pane', name: 'inbox' }, aliases: ['home', 'mail'], navigator: true,
  },
  {
    id: 'saved', label: 'Go to saved split', shortcut: '', group: 'goto',
    glyph: { family: 'own', shape: 'split' }, aliases: ['split', 'view'], navigator: true,
  },
  {
    id: 'done', label: 'Go to cached Done', shortcut: 'G then E', group: 'goto',
    glyph: { family: 'pane', name: 'done' }, aliases: ['finished', 'completed'], navigator: true,
    chord: { key: 'e', word: 'Done', hintOrder: 1 },
  },
  {
    id: 'starred', label: 'Go to cached Starred', shortcut: '', group: 'goto',
    glyph: { family: 'header', name: 'star' }, aliases: ['favorites', 'flagged'], navigator: true,
  },
  {
    id: 'destinations', label: 'Go to Provider mail (read only)', shortcut: '', group: 'goto',
    glyph: { family: 'pane', name: 'provider' }, aliases: ['provider', 'labels', 'folders', 'all mail'], navigator: true,
  },
  {
    id: 'trash', label: 'Go to cached Trash (read only)', shortcut: 'G then T', group: 'goto',
    glyph: { family: 'pane', name: 'trash' }, aliases: ['bin', 'deleted', 'delete'], navigator: true,
    chord: { key: 't', word: 'Trash', hintOrder: 2 },
  },
  {
    id: 'reminders', label: 'Go to local Reminders', shortcut: 'G then H', group: 'goto',
    glyph: { family: 'header', name: 'reminders' }, aliases: ['snoozed', 'later'], navigator: true,
    chord: { key: 'h', word: 'Reminders', hintOrder: 4 },
  },
  {
    id: 'reminder-settings', label: 'Reminder Settings', shortcut: '', group: 'goto',
    glyph: { family: 'none' }, aliases: ['reminder', 'time', 'defaults', 'settings'], navigator: true,
  },
  {
    id: 'drafts', label: 'Go to local Drafts', shortcut: 'G then D', group: 'goto',
    glyph: { family: 'pane', name: 'drafts' }, aliases: ['compose', 'draft', 'writing'], navigator: true,
    chord: { key: 'd', word: 'Drafts', hintOrder: 3 },
  },
  {
    id: 'activity', label: 'Go to Activity', shortcut: '', group: 'goto',
    glyph: { family: 'pane', name: 'activity' }, aliases: ['operations', 'history', 'log', 'queue', 'pending'], navigator: true,
  },
  {
    id: 'account', label: 'Go to Account', shortcut: 'G then A', group: 'goto',
    glyph: { family: 'pane', name: 'account' }, aliases: ['settings', 'google', 'gmail', 'permissions', 'access'], navigator: true,
    chord: { key: 'a', word: 'Account', hintOrder: 5 },
  },
  {
    id: 'switch-account', label: 'Switch account', shortcut: '', group: 'goto',
    glyph: { family: 'own', shape: 'switch' }, aliases: ['change account', 'workspace', 'mailbox'], navigator: false,
  },
  {
    id: 'connect', label: 'Connect Gmail', shortcut: '', group: 'account',
    glyph: { family: 'pane', name: 'account' }, aliases: ['sign in', 'login', 'log in', 'google', 'gmail', 'reconnect'], navigator: false,
  },
  {
    id: 'sync', label: 'Sync now', shortcut: '', group: 'account',
    glyph: { family: 'own', shape: 'sync' }, aliases: ['refresh', 'fetch', 'check mail', 'retry', 'update'], navigator: false,
  },
] as const satisfies readonly ActionDefinition[];

export type ActionId = (typeof actionRegistry)[number]['id'];

// ---------------------------------------------------------------------------
// Keys that are not commands
// ---------------------------------------------------------------------------

/** Bound keys that move or select without being a command; shown, never executed. */
export type KeyHintScope = 'reminders' | 'drafts';
/** `scope` limits a hint to the list context where the key works; no scope means everywhere. `needsRows` hides it while the list has no rows. */
export interface KeyHint { id: string; label: string; keys: readonly string[]; aliases: readonly string[]; scope?: KeyHintScope; needsRows?: boolean }

export interface KeyOnlyDefinition {
  readonly id: string;
  readonly bindings: readonly KeyBinding[];
  /** Commands this key chooses between (Escape: Back or Clear selection); their shortcut text is backed by it. */
  readonly triggers?: readonly string[];
  /** The teaching lines the palette's Keys list shows for this key, in order. */
  readonly hints?: readonly KeyHint[];
}

/**
 * Declaration order is the order of the palette's Keys list. Dispatch order is
 * priority, then commands before these, then this order.
 */
export const keyOnlyDefinitions = [
  {
    id: 'list-move',
    bindings: [{ keys: ['j', 'ArrowDown', 'k', 'ArrowUp'], surface: 'list', buttons: 'free', repeat: 'allow', scope: 'page' }],
    hints: [{ id: 'move', label: 'Next and previous conversation', keys: ['J', 'K'], aliases: ['down', 'up', 'arrow', 'move', 'navigate'], needsRows: true }],
  },
  {
    id: 'select-toggle',
    bindings: [{ keys: ['x', 'X'], surface: 'selection', buttons: 'free', repeat: 'swallow', scope: 'page' }],
    hints: [{ id: 'select', label: 'Select conversation', keys: ['X'], aliases: ['check', 'toggle', 'mark'], needsRows: true }],
  },
  {
    id: 'select-extend',
    bindings: [{ keys: ['J', 'K'], shift: true, surface: 'selection', buttons: 'free', repeat: 'allow', scope: 'page' }],
    hints: [{ id: 'extend', label: 'Extend selection', keys: ['Shift+J', 'Shift+K'], aliases: ['range', 'multiple', 'select'], needsRows: true }],
  },
  {
    id: 'navigator-open',
    bindings: [{ keys: ['ArrowLeft'], shift: false, surface: 'browsing', buttons: 'free', repeat: 'allow', scope: 'page' }],
    hints: [{ id: 'destinations', label: 'Open destinations', keys: ['←'], aliases: ['navigator', 'left', 'go to'] }],
  },
  {
    id: 'reminder-tabs',
    bindings: [{ keys: ['[', ']'], surface: 'reminders-browsing', buttons: 'free', repeat: NO_REPEAT, scope: 'page' }],
    hints: [{ id: 'reminder-tabs', label: 'Previous and next reminders tab', keys: ['[', ']'], aliases: ['pending', 'returned', 'history', 'tab', 'switch'], scope: 'reminders' }],
  },
  {
    id: 'reminder-row',
    bindings: [{ keys: ['h', 'H'], surface: 'reminders-row', buttons: 'free', repeat: NO_REPEAT, scope: 'page' }],
    hints: [
      { id: 'reminder-reschedule', label: 'Reschedule focused reminder', keys: ['H'], aliases: ['remind', 'snooze', 'time'], scope: 'reminders' },
      { id: 'reminder-cancel', label: 'Cancel focused reminder', keys: ['Shift+H'], aliases: ['remove', 'unremind', 'restore'], scope: 'reminders' },
    ],
  },
  {
    id: 'draft-discard',
    bindings: [{ keys: ['Delete', 'Backspace'], shift: false, surface: 'drafts-row', buttons: 'free', repeat: NO_REPEAT, scope: 'page' }],
    hints: [{ id: 'draft-discard', label: 'Discard focused draft (asks first)', keys: ['Delete', 'Backspace'], aliases: ['delete', 'remove', 'trash'], scope: 'drafts' }],
  },
  {
    // Escape ladder (§3.2): drawer, composer, disclosure, then reader or selection or context Back.
    id: 'escape-ladder',
    bindings: [{ keys: ['Escape'], surface: 'any', buttons: 'free', repeat: 'allow', scope: 'global' }],
    triggers: ['back', 'clear-selection'],
  },
  {
    id: 'chord-arm',
    bindings: [{ keys: ['g'], shift: false, surface: 'browsing', buttons: 'free', repeat: 'allow', scope: 'page' }],
  },
  {
    // Split navigation is nonwrapping and owns only the list, never fields or toolbar buttons.
    id: 'split-tab',
    bindings: [{ keys: ['Tab'], surface: 'split-list', buttons: 'free', repeat: 'allow', scope: 'page' }],
  },
  {
    id: 'reader-message',
    bindings: [{ keys: ['n', 'N', 'p', 'P', 'o', 'O'], surface: 'reader', buttons: 'free', repeat: 'allow', scope: 'page' }],
  },
  {
    // Reader J/K moves the reader cursor within the originating Inbox; the arrows stay native while reading.
    id: 'reader-move',
    bindings: [{ keys: ['j', 'k'], surface: 'reader', buttons: 'free', repeat: 'allow', scope: 'page' }],
  },
  {
    // The empty line's own action: Enter and Space on the empty line itself, before the list's Enter.
    id: 'empty-line',
    bindings: [{ keys: ['Enter', ' '], shift: false, surface: 'empty-line', buttons: 'free', repeat: NO_REPEAT, scope: 'page', priority: 1 }],
  },
] as const satisfies readonly KeyOnlyDefinition[];

export type KeyOnlyId = (typeof keyOnlyDefinitions)[number]['id'];

// ---------------------------------------------------------------------------
// Derived views (the palette, the chord, the labels)
// ---------------------------------------------------------------------------

export interface ActionHandler {
  /** Can the command run right now? Called after the workspace and account gate; `explicit` is a row's own target. */
  available(explicit?: ConversationRef): boolean;
  execute(explicit?: ConversationRef): Promise<void> | void;
  /** The palette label when it depends on state ("Mark done — 3 selected"); the declared label is the default. */
  label?(declared: string): string;
}
/** The app supplies one handler per declared action; a missing one is a compile error. */
export type ActionHandlers = { readonly [K in ActionId]: ActionHandler };

export interface AvailableAction { id: ActionId; label: string; shortcut: string; aliases?: readonly string[]; disabledReason?: string }

const definitions: readonly ActionDefinition[] = actionRegistry;

export function actionDefinition(id: ActionId): ActionDefinition {
  return definitions.find((action) => action.id === id)!;
}

/** A declaration by a plain string id (a stored action's id), or undefined. */
export function findAction(id: string): ActionDefinition | undefined {
  return definitions.find((action) => action.id === id);
}

export function actionLabel(id: ActionId): string {
  const action = actionDefinition(id);
  return `${action.label}${action.shortcut ? ` — ${action.shortcut}` : ''}`;
}

/** The hints of the palette's Keys list, in declaration order. */
export const keyHints: readonly KeyHint[] = (keyOnlyDefinitions as readonly KeyOnlyDefinition[]).flatMap((definition) => definition.hints ?? []);

function recordOf<T>(pick: (action: ActionDefinition) => T): Record<ActionId, T> {
  return Object.fromEntries(definitions.map((action) => [action.id, pick(action)])) as Record<ActionId, T>;
}
/** Palette group per action; its key order is the palette order inside a group. */
export const actionGroupOf: Record<ActionId, ActionGroup> = recordOf((action) => action.group);
/** Extra search words per action; the label and the bound key are always searchable. */
export const actionAliases: Record<ActionId, readonly string[]> = recordOf((action) => action.aliases);

export interface GoTarget { key: string; id: ActionId; word: string }
/** The action each G chord's second key opens, in the order the hint names them. */
export const goTargets: readonly GoTarget[] = definitions
  .filter((action) => action.chord)
  .map((action) => ({ key: action.chord!.key, id: action.id as ActionId, word: action.chord!.word, order: action.chord!.hintOrder }))
  .sort((a, b) => a.order - b.order)
  .map(({ key, id, word }) => ({ key, id, word }));

// ---------------------------------------------------------------------------
// Key lookup
// ---------------------------------------------------------------------------

/**
 * The focus context `onKeydown` works out for one key event. Every field is a
 * fact about the event's target and the visible surfaces; the registry decides
 * what the key means from these alone.
 */
export interface KeyFocus {
  readerOpen: boolean;
  /** A drawer or the narrow contact disclosure covers the page. */
  covered: boolean;
  /** List, empty state, Reminders/Drafts pane or body owns the key, and no button does. */
  browsingOwns: boolean;
  /** The list surface that owns X and Shift+J/K. */
  selectionKeysOwned: boolean;
  /** A focused Inbox row or the empty state with a ready list. */
  splitListOwns: boolean;
  remindersBrowsing: boolean;
  remindersRowOwns: boolean;
  draftsRowOwns: boolean;
  /** Focus is on the empty line and it shows an action. */
  emptyLineAction: boolean;
  /** Any button or link owns the key. */
  buttonOwns: boolean;
  /** A button owns the key and it is not the reader's message navigation focus. */
  shortcutBlocked: boolean;
  mailboxActionsEnabled: boolean;
}

export interface KeyEventFacts { key: string; shiftKey: boolean; repeat: boolean }

export type ResolvedKeyBinding =
  | { kind: 'command'; action: ActionId; binding: KeyBinding }
  | { kind: 'key'; handler: KeyOnlyId; binding: KeyBinding };

const orderedBindings: readonly ResolvedKeyBinding[] = [
  ...definitions.flatMap((action) => (action.keys ?? []).map((binding): ResolvedKeyBinding => ({ kind: 'command', action: action.id as ActionId, binding }))),
  ...keyOnlyDefinitions.flatMap((definition) => (definition.bindings as readonly KeyBinding[]).map((binding): ResolvedKeyBinding => ({ kind: 'key', handler: definition.id, binding }))),
]
  .map((resolved, index) => ({ resolved, index }))
  .sort((a, b) => (b.resolved.binding.priority ?? 0) - (a.resolved.binding.priority ?? 0) || a.index - b.index)
  .map(({ resolved }) => resolved);

function surfaceOwns(surface: KeySurface, focus: KeyFocus): boolean {
  switch (surface) {
    case 'any': return true;
    case 'reader': return focus.readerOpen;
    case 'list': return !focus.readerOpen;
    case 'browsing': return focus.browsingOwns;
    case 'browsing-or-reader': return focus.browsingOwns || focus.readerOpen;
    case 'selection': return focus.selectionKeysOwned;
    case 'split-list': return focus.splitListOwns;
    case 'reminders-browsing': return focus.remindersBrowsing;
    case 'reminders-row': return focus.remindersRowOwns;
    case 'drafts-row': return focus.draftsRowOwns;
    case 'empty-line': return !focus.readerOpen && focus.emptyLineAction;
  }
}

function buttonsAllow(buttons: KeyButtons, focus: KeyFocus): boolean {
  switch (buttons) {
    case 'free': return true;
    case 'shortcut': return !focus.shortcutBlocked;
    case 'strict': return !focus.buttonOwns;
    case 'shortcut-or-drafts-row': return !focus.shortcutBlocked || focus.draftsRowOwns;
  }
}

/**
 * Whether one binding claims this key event: its key, Shift state, layer,
 * repeat rule, mailbox-actions need, surface and button rule all agree. An
 * ignored repeat does not match, a swallowed one does.
 */
export function bindingMatches(binding: KeyBinding, event: KeyEventFacts, focus: KeyFocus): boolean {
  if (!binding.keys.includes(event.key)) return false;
  if (binding.shift !== undefined && binding.shift !== event.shiftKey) return false;
  if (focus.covered && binding.scope !== 'global') return false;
  if (event.repeat && binding.repeat === 'ignore') return false;
  if (binding.needsMailboxActions && !focus.mailboxActionsEnabled) return false;
  return surfaceOwns(binding.surface, focus) && buttonsAllow(binding.buttons, focus);
}

/** The binding that claims this key event, or undefined. Availability is checked by the caller. */
export function findKeyBinding(event: KeyEventFacts, focus: KeyFocus): ResolvedKeyBinding | undefined {
  return orderedBindings.find(({ binding }) => bindingMatches(binding, event, focus));
}

/** The shortcut text a binding would be displayed as ("Shift+E", "H", "Enter"). */
export function describeKey(binding: KeyBinding): string {
  const key = binding.keys[0]!;
  const text = key.length === 1 && /[a-z]/i.test(key) ? key.toUpperCase() : key;
  return binding.shift && key.toLowerCase() !== key.toUpperCase() ? `Shift+${text}` : text;
}
