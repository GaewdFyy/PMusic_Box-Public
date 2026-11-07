// 本地开发用的 HTTP 包装：把 Worker 的 fetch 跑在 Node 上
//   node dev-server.mjs
// 然后页面的 window.MUSIC_API 填 http://127.0.0.1:8787
//
// 只是调试用，不要部署这个文件。

import http from 'node:http';
import worker from './src/index.js';

const PORT = Number(process.env.PORT || 8787);

// Worker 里的 caches.default 在 Node 上没有，垫一个内存版
const store = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      const hit = store.get(req.url);
      return hit ? new Response(hit, { headers: { 'content-type': 'application/json' } }) : undefined;
    },
    async put(req, res) {
      store.set(req.url, await res.text());
    }
  }
};

const env = {
  ALLOWED_ORIGIN: '*',
  // 想看 VIP 曲目能不能播，就把你的 MUSIC_U 放到环境变量里：
  //   $env:MUSIC_U="xxx"; node dev-server.mjs
  MUSIC_U: process.env.MUSIC_U || '',
  // 本地测口令门：$env:API_TOKEN="hunter2"; node dev-server.mjs
  API_TOKEN: process.env.API_TOKEN || '',
  // 本地测账号登录：$env:ACCOUNTS_JSON='[{"name":"a","password":"123","musicU":"..."}]'
  ACCOUNTS_JSON: process.env.ACCOUNTS_JSON || '',
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  // 本地测登录开关：$env:REQUIRE_LOGIN="false"; node dev-server.mjs
  REQUIRE_LOGIN: process.env.REQUIRE_LOGIN || '',
  // 本地测口令门：$env:REQUIRE_PASS="true"; $env:PASSWORD="1234"; node dev-server.mjs
  REQUIRE_PASS: process.env.REQUIRE_PASS || '',
  PASSWORD: process.env.PASSWORD || ''
};

const server = http.createServer(async (req, res) => {
  try {
    // 把请求体也转发进去，否则 POST /api/login 收不到 JSON
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const request = new Request('http://127.0.0.1:' + PORT + req.url, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
    });

    const response = await worker.fetch(request, env);

    const headers = {};
    response.headers.forEach((v, k) => {
      headers[k] = v;
    });

    res.writeHead(response.status, headers);

    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dev-server error: ' + e.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('worker dev server -> http://127.0.0.1:' + PORT);
  console.log('  /api/health  /api/search?q=起风了  /api/lyric?id=1330348068  /api/url?id=1330348068');
});
