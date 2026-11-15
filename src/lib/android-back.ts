/** Install an Android-only page bridge for the native activity Back callback. */
export function installAndroidBackBridge(enabled: boolean, handle: () => boolean): () => void {
  if (!enabled || typeof window === 'undefined') return () => undefined;
  const bridge = () => handle();
  (window as Window & { __emailOsAndroidBack?: () => boolean }).__emailOsAndroidBack = bridge;
  return () => { if ((window as Window & { __emailOsAndroidBack?: () => boolean }).__emailOsAndroidBack === bridge) delete (window as Window & { __emailOsAndroidBack?: () => boolean }).__emailOsAndroidBack; };
}
