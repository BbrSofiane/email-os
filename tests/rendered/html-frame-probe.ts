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
  const signalCss = "eos-target { display: none !important; }\neos-signal { display: block !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; overflow: hidden !important; visibility: hidden !important; pointer-events: none !important; }\neos-target:target ~ eos-signal { width: 1px !important; }\nhtml:active > eos-signal { height: 1px !important; }";
  const csp = "<meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'\">";
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
    // How the app sees link activation where no parent listener runs in the frame.
    ['link-signal', '<style>' + signalCss + '</style><div style="height:3000px"></div><a id=go href="about:srcdoc#eos-probe-0">go</a><eos-target id=eos-probe-0></eos-target><eos-signal></eos-signal>']
  ];
  const remoteImage = 'https://probe-image.invalid/p.png';
  const violations = [];
  let listenersRun = false;
  let reporter = null;
  const title = document.title;
  try {
    for (const [name, html] of payloads) {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.srcdoc = csp + html;
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
        // then insert the image, and require a CSP violation for it. Two signals:
        // the violation event, which needs a parent listener in the frame (WebKit
        // runs none), and a ReportingObserver of the frame's realm, an observer
        // like the app's link channel, read by callback or takeRecords().
        const record = (via, blockedURI, directive) => violations.push({ via, blockedURI: blockedURI || '', directive: directive || '' });
        frame.contentDocument.addEventListener('securitypolicyviolation', event => record('event', event.blockedURI, event.effectiveDirective || event.violatedDirective));
        if (frame.contentWindow.ReportingObserver) {
          reporter = new frame.contentWindow.ReportingObserver(reports => { for (const report of reports) record('report', report.body.blockedURL, report.body.effectiveDirective); }, { types: ['csp-violation'], buffered: true });
          reporter.observe();
        }
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
        if (name === 'remote-image') {
          const img = frame.contentDocument.querySelector('img');
          for (const report of reporter ? reporter.takeRecords() : []) {
            violations.push({ via: 'report', blockedURI: report.body.blockedURL || '', directive: report.body.effectiveDirective || '' });
          }
          add('remote image violation signals (informational)', true, 'listeners=' + listenersRun + ', ReportingObserver=' + Boolean(reporter) + ', via=' + [...new Set(violations.map(v => v.via))].join('+'));
          reporter?.disconnect();
          const blocked = violations.some(v => v.blockedURI.startsWith(remoteImage) && v.directive.startsWith('img-src'));
          add('remote image blocked by CSP', blocked && img.naturalWidth === 0, JSON.stringify(violations) + ', width=' + img.naturalWidth);
          const entries = win.performance.getEntriesByType('resource').filter(entry => entry.name === remoteImage);
          add('remote image resource timing (informational)', true, entries.map(e => 'status=' + e.responseStatus + ' transfer=' + e.transferSize).join('; ') || 'none');
        }
      } catch (error) { add(name + ' inspection', false, error); }
    }
  } catch (error) { add('probe execution', false, error); }
  finally { for (const [, frame] of frames) frame.remove(); }
  return { checks };
})()`;
