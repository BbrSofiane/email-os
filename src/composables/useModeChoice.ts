/**
 * First-run mailbox choice on Android (ADR 0005 section 3). The backend
 * reports whether a choice was made; desktop and the browser preview always
 * report one. Choosing the mode that is already open only records the choice;
 * choosing the other mode swaps the backend session, so the page reloads to
 * start every composable clean.
 */
import { ref } from 'vue';
import type { MailClient } from '../lib/ipc/client';
import { errorText } from '../lib/error-text';
import { reloadPage } from '../lib/reload';

/** One-shot flag: after switching to your own mail, start sign-in once. */
export const CONNECT_AFTER_SWITCH_KEY = 'email-os.connect-after-switch';

/** Reads and clears the flag. Storage is optional; any failure reads as false. */
export function takeConnectAfterSwitch(): boolean {
  try {
    const value = sessionStorage.getItem(CONNECT_AFTER_SWITCH_KEY);
    sessionStorage.removeItem(CONNECT_AFTER_SWITCH_KEY);
    return value === 'true';
  } catch {
    return false;
  }
}

export function setConnectAfterSwitch(): void {
  try {
    sessionStorage.setItem(CONNECT_AFTER_SWITCH_KEY, 'true');
  } catch {
    // Storage is optional: without it the user presses Connect themselves.
  }
}

export function clearConnectAfterSwitch(): void {
  try {
    sessionStorage.removeItem(CONNECT_AFTER_SWITCH_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

export type ModeChoicePhase = 'checking' | 'choose' | 'switching' | 'clear';

export function useModeChoice(client: MailClient) {
  const phase = ref<ModeChoicePhase>('checking');
  const error = ref<string | null>(null);

  function fail(cause: unknown): void {
    const typed = cause && typeof cause === 'object' && 'kind' in cause
      ? cause as { kind: string }
      : { kind: 'unknown' };
    error.value = errorText(typed);
    phase.value = 'choose';
  }

  async function load(): Promise<void> {
    phase.value = 'checking';
    error.value = null;
    try {
      const choice = await client.getModeChoice();
      phase.value = choice.chosen ? 'clear' : 'choose';
    } catch (cause) {
      fail(cause);
    }
  }

  async function chooseDemo(): Promise<void> {
    if (phase.value !== 'choose') return;
    phase.value = 'switching';
    error.value = null;
    try {
      const result = await client.switchMode('fixture');
      if (result.mode === 'fixture') phase.value = 'clear';
      else reloadPage();
    } catch (cause) {
      fail(cause);
    }
  }

  async function chooseOwnMail(): Promise<void> {
    if (phase.value !== 'choose') return;
    phase.value = 'switching';
    error.value = null;
    setConnectAfterSwitch();
    try {
      await client.switchMode('gmail');
      reloadPage();
    } catch (cause) {
      clearConnectAfterSwitch();
      fail(cause);
    }
  }

  return { phase, error, load, chooseDemo, chooseOwnMail };
}
