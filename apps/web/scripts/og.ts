// Renders the share card for every entry in SHARE_CARDS into public/og, in bursar.world's type and
// imagery, with the locally installed Chrome. Run after changing a card: `pnpm --filter @bursar/web og`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SHARE_CARDS } from '../src/share';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'public/og');

const dataUri = (path: string, type: string) => `data:${type};base64,${readFileSync(join(ROOT, path)).toString('base64')}`;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const fonts = {
  sans: dataUri('public/fonts/zalando.woff2', 'font/woff2'),
  mono: dataUri('public/fonts/geist-mono.woff2', 'font/woff2'),
};
const glass = dataUri('scripts/og/glass.jpg', 'image/jpeg');
const logo = dataUri('public/brand/logo.png', 'image/png');

const page = (eyebrow: string, headline: string) => `<!doctype html><html><head><style>
@font-face{font-family:Zalando Sans;src:url(${fonts.sans})format("woff2");font-weight:100 900}
@font-face{font-family:Geist Mono;src:url(${fonts.mono})format("woff2");font-weight:100 900}
*{margin:0;box-sizing:border-box}
html,body{width:1200px;height:630px;overflow:hidden}
body{position:relative;color:#342440;font-family:Zalando Sans}
.bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.wash{position:absolute;inset:0;background:linear-gradient(100deg,#faf8f7f2 0%,#faf8f7d9 55%,#faf8f740 100%)}
.card{position:absolute;inset:64px 72px;display:flex;flex-direction:column;justify-content:space-between}
.brand{display:flex;align-items:center;gap:18px;font-size:30px;font-weight:500;letter-spacing:-.04em}
.brand img{width:56px;height:56px;border-radius:50%;border:1px solid #fff}
.eyebrow{font:500 20px Geist Mono;text-transform:uppercase;letter-spacing:.02em;color:#5f4f66;margin-bottom:26px}
h1{font-weight:400;text-transform:uppercase;letter-spacing:-.06em;line-height:.98;font-size:${headline.length > 30 ? 72 : 88}px;max-width:960px}
.foot{display:flex;justify-content:space-between;font:500 18px Geist Mono;text-transform:uppercase;color:#5f4f66}
</style></head><body>
<img class="bg" src="${glass}">
<div class="wash"></div>
<div class="card">
  <div class="brand"><img src="${logo}">BURSAR®</div>
  <div><p class="eyebrow">${escape(eyebrow)}</p><h1>${escape(headline)}</h1></div>
  <div class="foot"><span>Your agents. Your limits.</span><span>app.bursar.world</span></div>
</div></body></html>`;

mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'bursar-og-'));
try {
  for (const [name, { eyebrow, headline }] of Object.entries(SHARE_CARDS)) {
    const html = join(work, `${name}.html`);
    const png = join(work, `${name}.png`);
    writeFileSync(html, page(eyebrow, headline));
    execFileSync(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--window-size=1200,630',
      '--virtual-time-budget=3000',
      `--screenshot=${png}`,
      `file://${html}`,
    ], { stdio: 'ignore' });
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '88', png, '--out', join(OUT, `${name}.jpg`)], { stdio: 'ignore' });
    console.log(name);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
