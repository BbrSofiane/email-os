/**
 * The G-chord state machine, moved verbatim out of App.vue: arming, the chord
 * window, the grace window that swallows a late second key, and which second
 * keys are currently offered. It owns its two timers and the pending flag;
 * whether a target is offered comes from `actionAvailable`, passed in. The
 * owner decides when to cancel (blur, focus, composition, modal surfaces).
 */
import { computed, ref } from 'vue';
import { goTargets, type ActionId } from '../lib/action-registry';

// G-chord (g then e/t/d/h, and a in Gmail mode). The chord window is long enough for a hesitant second
// key; when it lapses the hint disappears and a short grace window swallows a
// late e/h, so a slow "g e" can never fall through to the plain-key meaning of
// e (Archive). Any other key, focus change or explicit cancel ends the grace.
const GO_CHORD_WINDOW_MS = 1500;
const GO_CHORD_GRACE_MS = 600;

export interface GoChordDeps {
  actionAvailable: (id: ActionId) => boolean;
}

export function useGoChord({ actionAvailable }: GoChordDeps) {
  let goTimer: ReturnType<typeof setTimeout> | null = null;
  let goGraceTimer: ReturnType<typeof setTimeout> | null = null;
  const goPending = ref(false);
  function endGoGrace(): void { if (goGraceTimer) clearTimeout(goGraceTimer); goGraceTimer = null; }
  function cancelGo(): void {
    if (goTimer) clearTimeout(goTimer);
    goTimer = null;
    goPending.value = false;
    endGoGrace();
  }
  function armGo(): void {
    cancelGo();
    goPending.value = true;
    goTimer = setTimeout(() => {
      goTimer = null;
      goPending.value = false;
      goGraceTimer = setTimeout(endGoGrace, GO_CHORD_GRACE_MS);
    }, GO_CHORD_WINDOW_MS);
  }
  /** Only what the palette and rail offer: Trash needs its rail item, Reminders its transport, Account Gmail mode. */
  function availableGoTargets() {
    return goTargets.filter((target) => target.id === 'done' || actionAvailable(target.id));
  }
  /** The chord's target for an unmodified key, or undefined (the key keeps its plain meaning). */
  function goTargetFor(event: KeyboardEvent) {
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return undefined;
    return availableGoTargets().find((target) => target.key === event.key);
  }
  /** Keys whose chorded meaning (Done / Trash / Drafts / Reminders / Account) differs from the plain key. */
  function isGoSecondKey(event: KeyboardEvent): boolean {
    return goTargetFor(event) !== undefined;
  }
  const goHintLabel = computed(() => {
    const phrases = availableGoTargets().map((target) => `${target.key.toUpperCase()} for ${target.word}`);
    const list = phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} or ${phrases.at(-1)}` : phrases[0];
    return `g pressed. Press ${list}, Escape to cancel.`;
  });

  return {
    goPending,
    goHintLabel,
    endGoGrace,
    cancelGo,
    armGo,
    goTargetFor,
    isGoSecondKey,
    /** The chord is armed: a second key is awaited. */
    isArmed: () => goTimer !== null,
    /** The window just lapsed: a late second key is still swallowed. */
    inGraceWindow: () => goGraceTimer !== null,
  };
}
