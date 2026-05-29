// md-to-pdf.mjs — Markdown 白書を PDF にレンダリングする。
// 依存ゼロ: インストール済み Chrome/Edge を headless で使い、marked / mermaid は CDN から読む。
// 文書内容は外部送信されず、ローカルの headless ブラウザで組版・印刷するだけ。
// 使い方: node tools/md-to-pdf.mjs whitepaper-v0.2.ja.md whitepaper-v0.2.ja.pdf
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = CANDIDATES.find(existsSync);
if (!browser) { console.error('Chrome/Edge が見つかりません'); process.exit(1); }

const [, , mdPath, pdfPath] = process.argv;
if (!mdPath || !pdfPath) { console.error('usage: md-to-pdf.mjs <in.md> <out.pdf>'); process.exit(1); }

const md = readFileSync(mdPath, 'utf8');

const css = `
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Yu Gothic", "Meiryo", "Hiragino Kaku Gothic ProN", system-ui, sans-serif;
         font-size: 10.5pt; line-height: 1.65; color: #1a1a1a; }
  h1 { font-size: 20pt; border-bottom: 3px solid #2c3e50; padding-bottom: 4px; }
  h2 { font-size: 14pt; margin-top: 1.4em; border-bottom: 1px solid #bbb; padding-bottom: 2px; page-break-after: avoid; }
  h3, h4 { page-break-after: avoid; }
  table { border-collapse: collapse; width: 100%; font-size: 9pt; margin: 0.6em 0; page-break-inside: avoid; }
  th, td { border: 1px solid #999; padding: 4px 7px; text-align: left; vertical-align: top; }
  th { background: #eef2f5; }
  code { background: #f2f2f2; padding: 1px 4px; border-radius: 3px; font-size: 9pt; }
  pre code { display: block; padding: 8px; }
  blockquote { border-left: 3px solid #ccc; margin: 0.6em 0; padding: 2px 12px; color: #555; }
  .mermaid { text-align: center; page-break-inside: avoid; margin: 1em 0; }
  .mermaid svg { max-width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid #ddd; margin: 1.2em 0; }
  a { color: #1a1a1a; text-decoration: none; }
`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="content"></div>
<script type="module">
const { marked } = await import('https://cdn.jsdelivr.net/npm/marked@12/lib/marked.esm.js');
const md = ${JSON.stringify(md)};
document.getElementById('content').innerHTML = marked.parse(md);
document.querySelectorAll('code.language-mermaid').forEach((c) => {
  const div = document.createElement('div');
  div.className = 'mermaid';
  div.textContent = c.textContent;
  (c.closest('pre') || c).replaceWith(div);
});
const m = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
m.default.initialize({ startOnLoad: false, theme: 'neutral' });
await m.default.run({ querySelector: '.mermaid' });
document.title = 'READY';
</script></body></html>`;

const htmlPath = resolve(pdfPath + '.tmp.html');
const absPdf = resolve(pdfPath);
writeFileSync(htmlPath, html);
const url = 'file:///' + htmlPath.replace(/\\/g, '/');

execFileSync(browser, [
  '--headless', '--disable-gpu', '--no-sandbox',
  '--no-pdf-header-footer',
  '--run-all-compositor-stages-before-draw',
  '--virtual-time-budget=25000',
  '--print-to-pdf=' + absPdf,
  url,
], { stdio: 'ignore' });

unlinkSync(htmlPath);
if (!existsSync(absPdf)) { console.error('PDF が生成されませんでした'); process.exit(1); }
const bytes = readFileSync(absPdf).length;
console.log('wrote', pdfPath, '(' + bytes + ' bytes)');
