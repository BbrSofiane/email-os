/**
 * Client selection for Slice 01.
 *
 * - Native Tauri runtime: narrow adapter over the approved named commands/event.
 * - Plain browser: clearly labelled in-memory fake. The UI must render the
 *   memory-only disclosure whenever this mode is active.
 */
import type { MailClient } from './client';
import { createTauriMailClient } from './tauri-client';
import { createBrowserPreviewMailClient } from './browser-fake';

export type ClientMode = 'native' | 'browser-preview';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function selectMailClient(): { client: MailClient; mode: ClientMode } {
  if (isTauriRuntime()) {
    return { client: createTauriMailClient(), mode: 'native' };
  }
  return { client: createBrowserPreviewMailClient(), mode: 'browser-preview' };
}
