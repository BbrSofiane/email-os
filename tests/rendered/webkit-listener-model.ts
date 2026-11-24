/**
 * Page script (for `Page.addScriptToEvaluateOnNewDocument`) that makes Chrome
 * treat listeners on a script-less sandboxed frame as WebKit does: they never
 * run. The first time the app reads such a frame's `contentDocument`, the
 * frame realm's `addEventListener` becomes a no-op. Observers (ResizeObserver,
 * ReportingObserver) and DOM access are untouched, as on WebKit, where the
 * owner's check found only listeners blocked.
 */
export const WEBKIT_LISTENER_MODEL = String.raw`(() => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument');
  const modelled = new WeakSet();
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
    configurable: true,
    get() {
      const doc = descriptor.get.call(this);
      const win = doc && doc.defaultView;
      if (win && this.hasAttribute('sandbox') && !this.sandbox.contains('allow-scripts') && !modelled.has(win)) {
        modelled.add(win);
        win.EventTarget.prototype.addEventListener = function () {};
      }
      return doc;
    },
  });
})()`;
