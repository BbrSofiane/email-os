/**
 * Shared keyboard model for the rows of a utility drawer (Activity) and of the
 * list contexts whose rows are not threads (`ContextRowList`: Reminders,
 * Drafts).
 *
 * One marker, one handler:
 * - A row is any focusable element that carries `data-drawer-row`. The primary
 *   action of a row is that element's native behaviour (rows are real buttons),
 *   so Enter and Space are never handled here.
 * - The container handler moves focus with ArrowDown/ArrowUp or J/K (any case),
 *   and jumps with Home/End. Movement stops at both ends and never wraps.
 * - Roving tabindex: the current row is the one Tab stop (`0`), every other row
 *   is `-1`, and the first row owns the stop while no row is current. Trailing
 *   action buttons are not rows: they keep native Tab and Enter, and stay
 *   Tab-reachable after their row.
 * - It ignores editable targets, IME composition, modifier keys (including
 *   Shift) and any target that is not itself a row marker, so a trailing button,
 *   a field or a tab never has its keys taken.
 * - Escape is not handled: the app owns it (it closes the drawer, or goes Back
 *   from a list context).
 */
import { ref, type Ref } from 'vue';

export interface DrawerRowsOptions {
  /** Row keys in render order; the first one owns the Tab stop when none is current. */
  keys: () => readonly string[];
  /** The remembered current row (for example a panel's last opened row). */
  initial?: () => string | null;
}

export interface DrawerRows {
  /** The current row key, or null while none was focused. */
  active: Ref<string | null>;
  /** Attributes for one row element: marker, roving tabindex and focus tracking. */
  rowAttrs: (key: string) => { 'data-drawer-row': string; tabindex: 0 | -1; onFocus: () => void };
  /** Keydown handler for the rows' container. */
  onKeydown: (event: KeyboardEvent) => void;
}

const ROW_SELECTOR = '[data-drawer-row]';

function isEditable(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function navigationTarget(key: string): 'next' | 'prev' | 'first' | 'last' | null {
  switch (key) {
    case 'ArrowDown': return 'next';
    case 'ArrowUp': return 'prev';
    case 'Home': return 'first';
    case 'End': return 'last';
    default: break;
  }
  const lower = key.length === 1 ? key.toLowerCase() : key;
  if (lower === 'j') return 'next';
  if (lower === 'k') return 'prev';
  return null;
}

export function useDrawerRows(options: DrawerRowsOptions): DrawerRows {
  const active = ref<string | null>(options.initial?.() ?? null);

  function currentKey(): string | null {
    const keys = options.keys();
    if (active.value !== null && keys.includes(active.value)) return active.value;
    return keys[0] ?? null;
  }

  function rowAttrs(key: string): { 'data-drawer-row': string; tabindex: 0 | -1; onFocus: () => void } {
    return {
      'data-drawer-row': key,
      tabindex: currentKey() === key ? 0 : -1,
      onFocus: () => { active.value = key; },
    };
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const container = event.currentTarget;
    const target = event.target;
    if (!(container instanceof HTMLElement) || !(target instanceof HTMLElement)) return;
    if (isEditable(target) || !target.hasAttribute('data-drawer-row')) return;
    const move = navigationTarget(event.key);
    if (move === null) return;

    // Only enabled, rendered rows can take focus.
    const rows = [...container.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
      .filter((row) => !row.hasAttribute('disabled') && !row.hidden);
    const index = rows.indexOf(target);
    if (index === -1) return;
    const next = move === 'first' ? 0
      : move === 'last' ? rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, index + (move === 'next' ? 1 : -1)));
    event.preventDefault();
    const row = rows[next];
    if (!row || row === target) return;
    row.focus({ preventScroll: false });
    // jsdom has no layout and no scrollIntoView.
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }

  return { active, rowAttrs, onKeydown };
}
