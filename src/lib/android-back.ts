interface AndroidBackWindow extends Window {
  __emailOsAndroidBack?: () => boolean;
}

/** Install an Android-only page bridge for the native activity Back callback. */
export function installAndroidBackBridge(enabled: boolean, handle: () => boolean): () => void {
  if (!enabled || typeof window === 'undefined') {
    return () => undefined;
  }

  const androidWindow = window as AndroidBackWindow;
  const bridge = () => handle();
  androidWindow.__emailOsAndroidBack = bridge;

  return () => {
    if (androidWindow.__emailOsAndroidBack === bridge) {
      delete androidWindow.__emailOsAndroidBack;
    }
  };
}
