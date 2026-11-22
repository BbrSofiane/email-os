/** Globals that indicate a native bridge is exposed to the frame. */
export const NATIVE_FRAME_GLOBALS = [
  '__TAURI_INTERNALS__',
  '__TAURI__',
  '__TAURI_IPC__',
  '__TAURI_POST_MESSAGE__',
  '__TAURI_METADATA__',
  'ipc',
] as const;

/** Native webviews may inject scripts into subframes; never show HTML if a frame can see app IPC globals (ADR 0006 decision 9). */
export function frameHasNativeGlobals(frame: HTMLIFrameElement): boolean {
  try {
    const win = frame.contentWindow;
    if (!win) return true;
    for (const name of NATIVE_FRAME_GLOBALS) {
      if (name in win || (win as unknown as Record<string, unknown>)[name] !== undefined) return true;
    }
    return false;
  } catch {
    return true;
  }
}
