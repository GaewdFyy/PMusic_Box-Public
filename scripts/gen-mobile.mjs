// 由 site/index.html 生成 site/m/index.html（移动端入口）
// 改完 index.html 记得跑一次：node scripts/gen-mobile.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'site/index.html');
const OUT = join(root, 'site/m/index.html');

let html = readFileSync(SRC, 'utf8');

// 标出这是移动端入口，CSS/JS 可以按 data-device 做差异化
html = html.replace('<html lang="zh-CN"', '<html lang="zh-CN" data-device="m"');

// 移动端不需要桌面的字号标题（首屏更快出内容）
html = html.replace(
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="format-detection" content="telephone=no">'
);

mkdirSync(join(root, 'site/m'), { recursive: true });
writeFileSync(OUT, html, 'utf8');
console.log('generated', OUT, html.length, 'bytes');