// crop-zoom.mjs: 写真の中央領域を切り出し整数倍拡大して保存(バンド位置の目視比較用)。
// 実行: node crop-zoom.mjs <in.png> <out.png> [fx fy fw fh zoom]  (f* は 0..1 の相対矩形)
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, encodePng } from '../../src/image.js';
const [inp, outp, fx = 0.35, fy = 0.35, fw = 0.3, fh = 0.3, zoom = 3] = process.argv.slice(2);
const { w, h, pixels } = decodePng(readFileSync(inp));
const x0 = Math.round(fx * w), y0 = Math.round(fy * h);
const cw = Math.round(fw * w), ch = Math.round(fh * h);
const Z = Number(zoom);
const out = Buffer.alloc(cw * Z * ch * Z);
for (let y = 0; y < ch * Z; y++) for (let x = 0; x < cw * Z; x++) {
  out[y * cw * Z + x] = pixels[(y0 + Math.floor(y / Z)) * w + (x0 + Math.floor(x / Z))];
}
writeFileSync(outp, encodePng(out, cw * Z, ch * Z));
console.log(`${outp}: ${cw}x${ch} @${x0},${y0} -> ${cw * Z}x${ch * Z}`);
