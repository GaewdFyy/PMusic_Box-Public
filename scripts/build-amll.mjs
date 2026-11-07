// 重新打包 AMLL 歌词播放器 → site/vendor/amll-core.{js,css}
//
// 平时不用跑：产物已经提交在仓库里，跑一次只是因为要升级 AMLL 或改打包参数。
// 需要先在仓库根目录装依赖（esbuild 的 postinstall 若被拦截，需手动放行一次）：
//   npm i -D esbuild @applemusic-like-lyrics/core @pixi/app @pixi/core @pixi/display \
//     @pixi/filter-blur @pixi/filter-bulge-pinch @pixi/filter-color-matrix @pixi/sprite
// 然后：
//   node scripts/build-amll.mjs
//
// 产物：约 392KB（brotli ~100KB），只在桌面大屏打开时按需加载。
// 注意：AMLL 是 AGPL-3.0-only，改这个仓库等于整站按 AGPL 发布。
import { writeFileSync, copyFileSync, rmSync } from 'node:fs';

let esbuild;
try {
  esbuild = await import('esbuild');
} catch (e) {
  console.error('缺 esbuild，先按文件头的命令装依赖');
  process.exit(1);
}

const entry = 'scripts/.amll-entry.mjs';
writeFileSync(
  entry,
  'import { DomLyricPlayer } from "@applemusic-like-lyrics/core";\nwindow.AMLL = { DomLyricPlayer };\n',
  'utf8'
);

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  outfile: 'site/vendor/amll-core.js'
});

copyFileSync('node_modules/@applemusic-like-lyrics/core/dist/style.css', 'site/vendor/amll-core.css');
rmSync(entry, { force: true });
console.log('built site/vendor/amll-core.js + amll-core.css');
