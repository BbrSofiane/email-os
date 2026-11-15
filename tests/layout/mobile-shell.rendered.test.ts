// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { startRenderedHarness, PHONE_VIEWPORT, type RenderedHarness } from '../rendered/chromium';
const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';
describe.skipIf(!chromePath)('compact shell geometry', () => {
 let h: RenderedHarness | null = null;
 beforeAll(async()=>{ h=await startRenderedHarness(chromePath,'email-os-mobile-shell-',new URL('../..',import.meta.url).pathname,PHONE_VIEWPORT); },120000);
 afterAll(async()=>{await h?.close();});
 it.each([{width:412,height:915},{width:360,height:800}])('keeps frame in bounds at $width × $height',async ({width,height})=>{
   await h!.cdp.cmd('Emulation.setDeviceMetricsOverride',{width,height,screenWidth:width,screenHeight:height,deviceScaleFactor:PHONE_VIEWPORT.deviceScaleFactor,mobile:true});
   await h!.cdp.js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
   const m=await h!.cdp.js<any>(`(()=>{const r=e=>{const x=e.getBoundingClientRect();return {x:x.x,y:x.y,right:x.right,bottom:x.bottom,width:x.width,height:x.height}};const top=document.querySelector('[data-test=mobile-top-bar]');const bottom=document.querySelector('[data-test=mobile-bottom-region]');return {layout:document.querySelector('.app')?.dataset.layout,overflow:document.documentElement.scrollWidth>innerWidth,top:top&&r(top),bottom:bottom&&r(bottom),buttons:[...document.querySelectorAll('[data-test=mobile-top-bar] button,[data-test=mobile-bottom-region] button')].map(r)}})()`);
   expect(m.layout).toBe('compact'); expect(m.overflow).toBe(false); expect(m.top).toBeTruthy(); expect(m.bottom).toBeTruthy(); expect(m.top.bottom).toBeLessThan(m.bottom.y); for(const b of m.buttons) expect(b.width).toBeGreaterThanOrEqual(48),expect(b.height).toBeGreaterThanOrEqual(48);
 });
 it('writes requested review screenshots when enabled',async()=>{const dir=process.env.EMAIL_OS_SCREENSHOT_DIR;if(!dir)return;mkdirSync(dir,{recursive:true});await h!.saveScreenshot(`${dir}/inbox.png`);});
});
