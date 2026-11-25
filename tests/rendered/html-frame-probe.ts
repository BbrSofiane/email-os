export interface FrameProbeResult {
  checks: Array<{ name: string; pass: boolean; detail: string }>;
}

// This expression is also evaluated directly in native webviews; keep it self-contained.
export const FRAME_PROBE_SOURCE = String.raw`(async () => {
  const globals = ['__TAURI_INTERNALS__', '__TAURI__', '__TAURI_IPC__', '__TAURI_POST_MESSAGE__', '__TAURI_METADATA__', 'ipc'];
  const checks = [];
  const frames = [];
  const add = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: String(detail) });
  // The app's FRAME_SIGNAL_CSS (a unit test keeps the two equal).
  const signalCss = "@layer eos-signal {\neos-target { all: initial !important; display: none !important; }\neos-signal { all: initial !important; display: block !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; overflow: hidden !important; visibility: hidden !important; pointer-events: none !important; }\neos-target:target ~ eos-signal { width: 1px !important; }\nhtml:active > eos-signal { height: 1px !important; }\n}";
  const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'";
  const csp = "<meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"" + policy + "\">";
  const payloads = [
    ['script', '<script>parent.__eosPwned="script";parent.document.title="PWNED"<\/script>'],
    ['img', '<img src=x onerror="parent.__eosPwned=\'img\';parent.document.title=\'PWNED\'">'],
    ['body', '<body onload="parent.__eosPwned=\'body\';parent.document.title=\'PWNED\'">'],
    ['svg', '<svg onload="parent.__eosPwned=\'svg\';parent.document.title=\'PWNED\'"></svg>'],
    ['js', '<a id=js href="javascript:parent.__eosPwned=\'js\';parent.document.title=\'PWNED\'">x</a>'],
    ['iframe', '<iframe src="javascript:parent.__eosPwned=\'iframe\';parent.document.title=\'PWNED\'"></iframe>'],
    ['refresh', '<meta http-equiv=refresh content="0;url=javascript:parent.__eosPwned=\'refresh\';parent.document.title=\'PWNED\'">'],
    ['object', '<object data="javascript:parent.__eosPwned=\'object\';parent.document.title=\'PWNED\'"></object>'],
    ['form', '<form action="javascript:parent.__eosPwned=\'form\';parent.document.title=\'PWNED\'"><button id=submit>go</button></form>'],
    ['nav', '<a id=nav href="https://nav.invalid/">go</a>'],
    ['remote-image', '<p>remote image is inserted by the parent after load</p>'],
    // A same-origin image (served by the dev server) in the same kind of frame,
    // without and with the frame policy: tells a CSP block from a failed load.
    ['image-control', '<img id=probe>'],
    ['image-policy', '<img id=probe>'],
    // How the app sees link activation where no parent listener runs in the frame.
    ['link-signal', '<style>' + signalCss + '</style><div style="height:3000px"></div><a id=go href="about:srcdoc#eos-probe-0">go</a><eos-target id=eos-probe-0></eos-target><eos-signal></eos-signal>']
  ];
  const remoteImage = 'https://probe-image.invalid/p.png';
  const controlImage = new URL('/src-tauri/icons/icon.png', location.href).href;
  const violations = [];
  let listenersRun = false;
  const title = document.title;
  try {
    for (const [name, html] of payloads) {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.srcdoc = (name === 'image-control' ? '<meta charset="utf-8">' : csp) + html.replace('<img id=probe>', '<img id=probe src="' + controlImage + '">');
      frames.push([name, frame]);
      const loaded = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 3000);
        frame.onload = () => { clearTimeout(timer); resolve(true); };
        document.body.append(frame);
      });
      add(name + ' load', loaded, loaded ? 'loaded' : 'timeout');
      if (!loaded) continue;
      if (name === 'script') {
        // WebKit runs no listener whose target is in a frame without allow-scripts,
        // whichever realm the function belongs to; Chromium does.
        const probe = () => { listenersRun = true; };
        frame.contentDocument.addEventListener('eos-probe', probe);
        frame.contentDocument.dispatchEvent(new frame.contentWindow.Event('eos-probe'));
        frame.contentDocument.removeEventListener('eos-probe', probe);
        add('parent listeners run in frame (informational)', true, listenersRun);
      }
      if (name === 'link-signal') {
        frame.style.height = '200px';
        const widths = [];
        const scroll = [scrollX, scrollY].join();
        const observer = new ResizeObserver(entries => { for (const entry of entries) widths.push(Math.round(entry.contentRect.width)); });
        observer.observe(frame.contentDocument.querySelector('eos-signal'));
        await new Promise(resolve => setTimeout(resolve, 200));
        frame.contentDocument.querySelector('#go').click();
        await new Promise(resolve => setTimeout(resolve, 300));
        const href = frame.contentWindow.location.href;
        const frameScroll = frame.contentDocument.scrollingElement.scrollTop;
        const parentScroll = [scrollX, scrollY].join();
        frame.contentWindow.location.replace('about:srcdoc#eos-probe-idle');
        frame.contentWindow.history.replaceState(null, '', 'about:srcdoc');
        await new Promise(resolve => setTimeout(resolve, 300));
        observer.disconnect();
        add('link signal seen by a parent ResizeObserver', widths.includes(1) && widths[widths.length - 1] === 0, 'widths=' + widths.join());
        add('link signal is same-document and scrolls nothing', href === 'about:srcdoc#eos-probe-0' && frameScroll === 0 && parentScroll === scroll, href + ', frame scroll=' + frameScroll + ', parent scroll ' + scroll + ' -> ' + parentScroll);
      }
      if (name === 'remote-image') {
        // A violation in the srcdoc parse can fire before the parent can listen, and
        // Chrome may still list a CSP-blocked load in resource timing. Listen first,
        // then insert the image, and require a CSP violation for it. The listener
        // runs only where parent listeners run in the frame (Chromium); WebKit
        // runs none and gives no csp-violation report to a ReportingObserver.
        frame.contentDocument.addEventListener('securitypolicyviolation', event => {
          violations.push({ blockedURI: event.blockedURI, directive: event.effectiveDirective || event.violatedDirective });
        });
        const img = frame.contentDocument.createElement('img');
        img.src = remoteImage;
        frame.contentDocument.body.append(img);
      }
      const element = frame.contentDocument.querySelector('#js, #submit, #nav');
      if (element) {
        element.click();
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: frame.contentWindow }));
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    add('parent untouched', !('__eosPwned' in window), String(window.__eosPwned));
    add('parent title', document.title === title, document.title);
    add('parent IPC (informational)', true, String('__TAURI_INTERNALS__' in window));
    for (const [name, frame] of frames) {
      try {
        const win = frame.contentWindow;
        if (name === 'nav') {
          let location;
          try { location = win.location.href; } catch (error) { location = String(error); }
          add('nav location (informational)', true, location);
          continue;
        }
        add(name + ' location', win.location.href === 'about:srcdoc', win.location.href);
        const found = globals.filter(key => key in win || win[key] !== undefined);
        add(name + ' globals', found.length === 0, found.join(', ') || 'none');
        if (name === 'image-control' || name === 'image-policy') continue;
        if (name === 'remote-image') {
          const img = frame.contentDocument.querySelector('img');
          const probeImage = key => frames.find(([other]) => other === key)?.[1].contentDocument?.querySelector('#probe');
          const control = probeImage('image-control');
          const policed = probeImage('image-policy');
          const controlLoads = Boolean(control && control.complete && control.naturalWidth > 0);
          const policyBlocks = Boolean(policed && policed.complete && policed.naturalWidth === 0);
          const meta = frame.contentDocument.head.children[1];
          const metaExact = meta?.getAttribute('http-equiv') === 'Content-Security-Policy' && meta.getAttribute('content') === policy;
          add('image policy control (informational)', true, controlImage + ': without policy ' + (controlLoads ? 'loads' : 'unavailable') + ', with policy ' + (policyBlocks ? 'blocked' : 'loaded'));
          if (controlLoads) add('same-origin image blocked by the frame policy', policyBlocks, 'width=' + policed?.naturalWidth);
          const event = violations.some(v => v.blockedURI.startsWith(remoteImage) && v.directive.startsWith('img-src'));
          const detail = JSON.stringify(violations) + ', width=' + img.naturalWidth + ', listeners=' + listenersRun + ', policy meta ' + (metaExact ? 'exact' : 'MISSING');
          if (listenersRun) {
            // Chromium: the violation event is required, as before.
            add('remote image blocked by CSP', event && img.naturalWidth === 0, detail + ', via=event');
          } else if (controlLoads) {
            // WebKit: the exact policy is in the document, an image that loads
            // without it is blocked with it, and the remote image did not load.
            add('remote image blocked by CSP', metaExact && policyBlocks && img.naturalWidth === 0, detail + ', via=structural');
          } else {
            // No control image (a build without the dev server): only the console
            // line "Refused to load ... img-src" proves the block.
            add('remote image blocked by CSP (MANUAL: confirm the console line "Refused to load ' + remoteImage + '")', metaExact && img.naturalWidth === 0, detail + ', via=manual');
          }
          const entries = win.performance.getEntriesByType('resource').filter(entry => entry.name === remoteImage);
          add('remote image resource timing (informational)', true, entries.map(e => 'status=' + e.responseStatus + ' transfer=' + e.transferSize).join('; ') || 'none');
        }
      } catch (error) { add(name + ' inspection', false, error); }
    }
  } catch (error) { add('probe execution', false, error); }
  finally { for (const [, frame] of frames) frame.remove(); }
  return { checks };
})()`;
