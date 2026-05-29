// mmd-to-svg.mjs — Mermaid (.mmd) を SVG にレンダリングする。
// 依存ゼロ: インストール済みの Chrome/Edge を headless で使い、mermaid は CDN から読む。
// 文書内容は外部送信されず、ローカルの headless ブラウザで描画するだけ。
// 使い方: node tools/mmd-to-svg.mjs figures/architecture.ja.mmd figures/architecture.ja.svg
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = CANDIDATES.find(existsSync);
if (!browser) { console.error('Chrome/Edge が見つかりません'); process.exit(1); }

const [, , mmdPath, svgPath] = process.argv;
if (!mmdPath || !svgPath) { console.error('usage: mmd-to-svg.mjs <in.mmd> <out.svg>'); process.exit(1); }

const diagram = readFileSync(mmdPath, 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body><div id="out">PENDING</div>
<script type="module">
const m = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
m.default.initialize({ startOnLoad: false, theme: 'neutral' });
const { svg } = await m.default.render('g', ${JSON.stringify(diagram)});
document.getElementById('out').innerHTML = svg;
</script></body></html>`;

const htmlPath = resolve(svgPath + '.tmp.html');
writeFileSync(htmlPath, html);
const url = 'file:///' + htmlPath.replace(/\\/g, '/');

const dump = execFileSync(browser, [
  '--headless', '--disable-gpu', '--no-sandbox',
  '--virtual-time-budget=15000', '--dump-dom', url,
], { encoding: 'utf8', maxBuffer: 1 << 27 });

unlinkSync(htmlPath);
const match = dump.match(/<svg[\s\S]*<\/svg>/);
if (!match) { console.error('SVG が抽出できませんでした'); process.exit(1); }
writeFileSync(svgPath, '<?xml version="1.0" encoding="UTF-8"?>\n' + match[0] + '\n');
console.log('wrote', svgPath, '(' + match[0].length + ' bytes)');
