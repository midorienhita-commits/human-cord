// render-check.mjs — md-to-pdf と同一の HTML 生成で、印刷直前 DOM を検証する。
// 使い方: node tools/render-check.mjs <in.md> "検査語1" "検査語2" ...
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const browser = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);

const [, , mdPath, ...needles] = process.argv;
const md = readFileSync(mdPath, 'utf8');

const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body><div id="content"></div>
<script type="module">
const { marked } = await import('https://cdn.jsdelivr.net/npm/marked@12/lib/marked.esm.js');
document.getElementById('content').innerHTML = marked.parse(${JSON.stringify(md)});
document.querySelectorAll('code.language-mermaid').forEach((c) => {
  const div = document.createElement('div'); div.className = 'mermaid';
  div.textContent = c.textContent; (c.closest('pre') || c).replaceWith(div);
});
const m = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
m.default.initialize({ startOnLoad: false, theme: 'neutral' });
await m.default.run({ querySelector: '.mermaid' });
</script></body></html>`;

const htmlPath = resolve('_render_check.tmp.html');
writeFileSync(htmlPath, html);
const url = 'file:///' + htmlPath.replace(/\\/g, '/');
const dump = execFileSync(browser, ['--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=20000', '--dump-dom', url], { encoding: 'utf8', maxBuffer: 1 << 27 });
unlinkSync(htmlPath);

console.log('dump bytes      :', dump.length);
console.log('rendered <svg>  :', (dump.match(/<svg/g) || []).length);
console.log('raw mermaid left:', (dump.match(/language-mermaid/g) || []).length, '(want 0)');
console.log('<h1>/<h2> count :', (dump.match(/<h[12]/g) || []).length);
console.log('<table> count   :', (dump.match(/<table/g) || []).length);
for (const n of needles) console.log((dump.includes(n) ? 'OK   ' : 'MISS ') + n);
