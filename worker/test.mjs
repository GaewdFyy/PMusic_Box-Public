// 本地冒烟测试：不需要 wrangler / Cloudflare 账号
//   node test.mjs [关键词]

import worker from './src/index.js';

const env = { ALLOWED_ORIGIN: '*' };
const kw = process.argv[2] || '起风了';

const call = (path) => worker.fetch(new Request('https://ne.test' + path), env);

console.log('--- /api/health ---');
{
  const r = await call('/api/health');
  console.log(r.status, await r.text());
}

console.log('\n--- /api/search ---');
let firstId = null;
{
  const r = await call('/api/search?q=' + encodeURIComponent(kw) + '&limit=5');
  const j = await r.json();
  console.log('status', r.status, ' 总数', j.total, ' 返回', j.songs && j.songs.length);
  (j.songs || []).forEach((s) => {
    console.log(`  ${s.id} | ${s.name} | ${s.artists} | ${s.album} | cover:${s.cover ? 'Y' : 'N'} | ${Math.round(s.duration / 1000)}s`);
  });
  firstId = j.songs && j.songs[0] && j.songs[0].id;
}

if (firstId) {
  console.log('\n--- /api/lyric ---');
  {
    const r = await call('/api/lyric?id=' + firstId);
    const j = await r.json();
    const lrcLines = (j.lrc || '').split('\n').filter((l) => /\[\d+:\d+/.test(l)).length;
    console.log('status', r.status, ' lrc行数', lrcLines, ' 逐字', j.klyric ? '有' : '无', ' 翻译', j.tlyric ? '有' : '无');
  }

  console.log('\n--- /api/url ---');
  {
    const r = await call('/api/url?id=' + firstId);
    let target = '';
    if (r.status === 200) {
      const j = await r.json();
      target = j.url || '';
      console.log('200 JSON 直链:', target.slice(0, 80));
    } else {
      console.log('status', r.status, await r.text());
    }
    if (target) {
      const r2 = await fetch(target, { headers: { Range: 'bytes=0-15' } });
      const b = Buffer.from(await r2.arrayBuffer());
      console.log(`  跟随 -> ${r2.status} ${r2.headers.get('content-type')} 头部=${b.toString('hex').slice(0, 16)}`);
      console.log('  支持分段:', r2.status === 206);
    }
    // 旧的跳转行为还在
    const r3 = await call('/api/url?id=' + firstId + '&redirect=1');
    console.log('redirect=1 ->', r3.status, (r3.headers.get('location') || '(无)').slice(0, 60));
  }
}

console.log('\n--- 错误处理 ---');
{
  const r1 = await call('/api/search');
  console.log('缺 q ->', r1.status);
  const r2 = await call('/api/url?id=1');
  console.log('无效 id ->', r2.status);
}
