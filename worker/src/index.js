// 网易云 API 代理 Worker
//
// 只做三件事，全部是「取数据 / 302」，不转发音频字节：
//   GET /api/search?q=关键词[&limit=20]   → 搜索 + 批量补封面
//   GET /api/lyric?id=歌曲ID              → LRC / 逐字 / 翻译
//   GET /api/url?id=歌曲ID                → 302 到网易云签名直链（https）
//
// 环境变量：
//   普通变量 ALLOWED_ORIGIN   允许跨域的来源，默认 *
//   Secret   MUSIC_U          可选，填了才能拿 VIP 曲目的直链
//   Secret   API_TOKEN        可选，填了之后所有接口都要带 ?k=
//
// 注意：MUSIC_U 是你网易云账号的登录凭证，等同于密码，只能放 Worker Secret，
// 绝不能写进前端或提交进 git。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ORIGIN = 'https://music.163.com';

// 用来试探「伪装国内 IP」是否有效。挑一个普通的国内公网 IP 即可。
const REAL_IP = '116.25.146.177';

// 口令门：2026-11-06 起关闭，改由 /api/login 的账号登录把关。
// 想临时恢复就把 REQUIRE_PASS 改成 true 并填 PASSWORD。
const REQUIRE_PASS = false;
const PASSWORD = '';

// 登录开关：false = 不启用登录，所有接口直接放行（页面也就不弹登录框了）。
// 前端靠 /api/health 返回的 login 字段决定要不要显示登录页。
// 也可以在 Cloudflare 里加一个同名的环境变量 REQUIRE_LOGIN=false 临时关掉，
// 不用改代码（改完记得重新部署，或者直接在 dashboard 改 vars）。
const REQUIRE_LOGIN = false;

function loginEnabled(env) {
  const raw = env && env.REQUIRE_LOGIN;
  if (raw === undefined || raw === '' || raw === null) return REQUIRE_LOGIN;
  const v = String(raw).trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}

/** 口令门开关：代码里的默认值，可以被同名环境变量覆盖 */
function passEnabled(env) {
  const raw = env && env.REQUIRE_PASS;
  if (raw === undefined || raw === '' || raw === null) return REQUIRE_PASS;
  const v = String(raw).trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}

// ---------------------------------------------------------------- 登录限流
// 防脚本化暴力破解：同一出口 IP 在 10 分钟内失败满 5 次就先拦住，到期自动放开。
// 计数放两处：
//   1) 模块内存：同步、快，能挡住连着打同一个 isolate 的尝试（冷启动后归零）
//   2) KV（绑了 ACCOUNTS 才有）：跨 isolate / 跨机房共享，但弱一致，只当增强
// 刻意不按账号名计数——否则任何人都能靠故意输错把某个账号锁死。
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const loginFails = new Map(); // ip -> { n, resetAt }

function liveLoginFail(ip) {
  const e = loginFails.get(ip);
  if (!e) return null;
  if (e.resetAt <= Date.now()) {
    loginFails.delete(ip);
    return null;
  }
  return e;
}

/** 还要等多少秒才能再试；0 = 没被拦 */
function loginBlockedSeconds(ip) {
  const e = liveLoginFail(ip);
  if (!e || e.n < LOGIN_MAX_FAILS) return 0;
  return Math.max(1, Math.ceil((e.resetAt - Date.now()) / 1000));
}

/** 记一次失败，返回这一步之后的累计次数 */
function noteLoginFail(ip) {
  const now = Date.now();
  const e = liveLoginFail(ip) || { n: 0, resetAt: now + LOGIN_WINDOW_MS };
  e.n += 1;
  loginFails.set(ip, e);

  // 别让 Map 无限长：超过 500 条就把过期的清掉
  if (loginFails.size > 500) {
    loginFails.forEach((v, k) => {
      if (v.resetAt <= now) loginFails.delete(k);
    });
  }
  return e.n;
}

function clearLoginFail(ip) {
  loginFails.delete(ip);
}

const loginFailKey = (ip) => `rl:login:${ip}`;

/** KV 里的失败记录（可能没绑 KV，一律容错） */
async function kvLoginFail(ip, env) {
  const kv = env && env.ACCOUNTS;
  if (!kv || typeof kv.get !== 'function') return null;
  try {
    const raw = await kv.get(loginFailKey(ip));
    const e = raw ? JSON.parse(raw) : null;
    return e && e.resetAt > Date.now() ? e : null;
  } catch (e) {
    return null;
  }
}

async function kvNoteLoginFail(ip, env) {
  const kv = env && env.ACCOUNTS;
  if (!kv || typeof kv.put !== 'function') return;
  try {
    const now = Date.now();
    const old = await kvLoginFail(ip, env);
    const e = old ? { n: Number(old.n) || 0, resetAt: old.resetAt } : { n: 0, resetAt: now + LOGIN_WINDOW_MS };
    e.n += 1;
    // 同一个 key 每秒只能写一次，写失败（429/限流）直接放弃，内存那层还在
    await kv.put(loginFailKey(ip), JSON.stringify(e), { expirationTtl: Math.ceil(LOGIN_WINDOW_MS / 1000) });
  } catch (e) {}
}

async function kvClearLoginFail(ip, env) {
  const kv = env && env.ACCOUNTS;
  if (!kv || typeof kv.delete !== 'function') return;
  try {
    await kv.delete(loginFailKey(ip));
  } catch (e) {}
}

/** 取客户端 IP：Workers 上 cf-connecting-ip 一定有；本地 dev 退化成固定桶 */
function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'local'
  );
}

// 账号表（二选一，都有就优先 KV）：
//   1) KV 绑定 ACCOUNTS：key = 账号名，value = {"password":"..."} 或 {"passwordHash":"<sha256 hex>"}
//   2) Secret ACCOUNTS_JSON：JSON 数组 [{"name":"...","password":"...","musicU":"..."}]
// 每个账号可选 musicU 字段（网易云 MUSIC_U），登录后该账号的请求就用它。
const SESSION_DAYS = 30;

// 开箱就能登的账号：第一次部署时先给一个，进去之后建议改用 Secret/KV，
// 再把这里删掉（否则密码会留在代码里）。
const BUILTIN_ACCOUNTS = [{ name: 'admini', password: 'gggxxqb4' }];

// ---------------------------------------------------------------- weapi 加密
// 网易云网页版所有接口都是加密的。明文 /api/* 那套是老服务，会按出口 IP 判定
// 「境外」并直接回空 result（搜索就是死在这里），而 weapi 没有这个降级。
// 所以搜索 / 歌词 / 取播放地址都优先走这里，明文只当兜底。
//
// 算法（照抄浏览器端）：
//   params    = AES(AES(JSON, presetKey), secretKey)   → base64
//   encSecKey = RSA(secretKey 反转)                    → 256 位 hex
//
// RSA 是「无填充 + 原文反转」的非标准用法，WebCrypto 不支持，所以用 BigInt
// 自己算模幂。指数固定 0x10001，只有 17 次平方，开销可以忽略。
//
// 合并成单文件是为了能在 Cloudflare 后台直接粘贴部署（后台编辑器只收单文件）。

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const PUB_KEY = '010001';
const MODULUS =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725' +
  '152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312' +
  'ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424' +
  'd813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8' +
  'e7';

const ENC = new TextEncoder();
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

async function aes(text, key) {
  const k = await crypto.subtle.importKey('raw', ENC.encode(key), { name: 'AES-CBC' }, false, ['encrypt']);
  // WebCrypto 的 CBC 自带 PKCS#7 填充，和浏览器端 CryptoJS 一致
  const out = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ENC.encode(IV) }, k, ENC.encode(text));
  return bytesToBase64(new Uint8Array(out));
}

function modPow(base, exp, mod) {
  let r = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

function rsa(text) {
  const m = BigInt('0x' + bytesToHex(ENC.encode(text)));
  const c = modPow(m, BigInt('0x' + PUB_KEY), BigInt('0x' + MODULUS));
  return c.toString(16).padStart(256, '0');
}

function secretKey() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < 16; i++) s += BASE62[buf[i] % 62];
  return s;
}

/** 把对象加密成 { params, encSecKey, secretKey } */
async function weapi(object) {
  const text = JSON.stringify(object);
  const key = secretKey();
  const params = await aes(await aes(text, PRESET_KEY), key);
  return { params, encSecKey: rsa(key.split('').reverse().join('')), secretKey: key };
}

/** 生成 x-www-form-urlencoded 请求体 */
async function weapiBody(object) {
  const { params, encSecKey } = await weapi(object);
  return `params=${encodeURIComponent(params)}&encSecKey=${encodeURIComponent(encSecKey)}`;
}
// ------------------------------------------------------------ weapi 加密结束


function cors(origin, allowed) {
  // ALLOWED_ORIGIN 支持逗号分隔的多个来源
  const list = String(allowed || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const any = !list.length || list.indexOf('*') >= 0;
  const allow = any ? '*' : list.indexOf(origin) >= 0 ? origin : list[0];

  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-music-u, authorization',
    vary: 'origin'
  };
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...cors(request.headers.get('origin') || '', env.ALLOWED_ORIGIN)
    }
  });
}

/**
 * 兼容两种常见的粘贴方式：
 *   1. 只粘值           → 3A7F...（网易云 MUSIC_U 的裸值）
 *   2. 粘了整串 cookie  → MUSIC_U=3A7F...; __csrf=xxx; NMTID=yyy
 * 第二种如果直接拼成 "MUSIC_U=<整串>" 会得到畸形 header，网易云就当没登录。
 */
function cookieHeader(raw) {
  const base = ['appver=2.0.2', 'os=pc'];
  const s = String(raw || '').trim();
  if (!s) return base.join('; ');

  // 已经带 MUSIC_U= 了，说明是整串 cookie，原样拼上去（合法的多 cookie 形式）
  if (/MUSIC_U=/.test(s)) return base.concat([s]).join('; ');

  // 裸值：只有它，没有分号、等号之类
  return base.concat([`MUSIC_U=${s}`]).join('; ');
}

function headers(env, opts) {
  const h = {
    'User-Agent': UA,
    Referer: `${ORIGIN}/`,
    Origin: ORIGIN,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    // 优先级：本次请求带的 MUSIC_U（登录用户） > Worker Secret > 匿名
    Cookie: cookieHeader(
      opts && opts.musicU ? opts.musicU : opts && opts.noCookie ? '' : env.MUSIC_U
    )
  };

  // 试探用：让网易云以为请求来自国内
  if (opts && opts.realIP) h['X-Real-IP'] = REAL_IP;

  return h;
}

async function ne(path, env, opts) {
  // 注意：这里不要加 cf: { cacheTtl }。
  // 带上 Cookie 的请求再让边缘缓存，会出现「返回 200 但没有 result 字段」的
  // 空壳响应，表现为搜索永远 0 条。缓存交给浏览器和 page 层做就够了。
  const res = await fetch(ORIGIN + path, { headers: headers(env, opts) });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`网易云返回非 JSON（HTTP ${res.status}）`);
  }
}

/** 统一成前端要的形状。兼容明文接口（artists/album）和加密接口（ar/al）两种字段名 */
function mapSong(s) {
  const al = s.al || s.album || {};
  const ar = s.ar || s.artists || [];
  const pic = al.picUrl || '';
  return {
    id: s.id,
    name: s.name,
    artists: ar.map((a) => a && a.name).filter(Boolean).join(' / '),
    album: al.name || '',
    // 网易云的封面地址给的是 http，https 页面里会被当混合内容拦掉
    cover: pic ? `${pic.replace(/^http:\/\//i, 'https://')}?param=300y300` : '',
    duration: s.dt || s.duration || 0
  };
}

/** POST 一个 weapi 加密接口，返回解析后的 JSON */
async function weapiPost(path, obj, env, opts) {
  const body = await weapiBody(obj);
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${ORIGIN}${path}${sep}csrf_token=`, {
    method: 'POST',
    headers: { ...headers(env, opts), 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`加密接口 ${path} 返回非 JSON（HTTP ${res.status}，${text.length} 字节）`);
  }
}

/**
 * 加密搜索（网页版自己在用的接口）。
 *
 * 老明文接口 /api/search/get/web 会按出口 IP 判定境外，直接回空 result，
 * 所以优先走 weapi。注意路径是 cloudsearch/pc：cloudsearch/get/web 现在
 * 一律回 code=50000005，pc 这个老路径反而还活着。
 */
async function searchWeapi(q, limit, offset, env) {
  const data = await weapiPost(
    '/weapi/cloudsearch/pc',
    { s: q, type: 1, limit, offset: offset || 0, total: true, csrf_token: '' },
    env
  );

  if (data.code !== 200 || !data.result) {
    throw new Error(`加密搜索 code=${data.code}${data.message ? ' ' + data.message : ''}`);
  }

  const songs = data.result.songs || [];
  return {
    total: data.result.songCount || songs.length,
    songs: songs.map(mapSong),
    // 加密接口不返回 abroad，但顺带带出来有就带
    abroad: Boolean(data.abroad)
  };
}

/** 明文搜索（回退用）。先拿列表，再批量补封面 */
async function searchPlain(q, limit, offset, env) {
  const build = () =>
    `/api/search/get/web?s=${encodeURIComponent(q)}&type=1&limit=${limit}&offset=${offset || 0}&realIP=${REAL_IP}`;
  const hopts = { realIP: true };

  let data = await ne(build(), env, hopts);
  if (!data || data.result == null) {
    throw new Error(`网易云搜索异常 code=${data && data.code}`);
  }

  let got = extractSongs(data);

  if (!got.songs.length) {
    const again = await ne(build(), env, hopts);
    if (again && again.result != null) got = extractSongs(again);
  }

  if (!got.songs.length) return { total: 0, songs: [], abroad: Boolean(data.abroad) };

  // v3 才带 al.picUrl；老接口 /api/song/detail 返回里没有封面
  const ids = got.songs.map((s) => s.id);
  const detail = {};
  try {
    const c = encodeURIComponent(JSON.stringify(ids.map((id) => ({ id }))));
    const d = await ne(`/api/v3/song/detail?c=${c}`, env);
    (d.songs || []).forEach((s) => {
      detail[s.id] = s;
    });
  } catch (e) {
    // 补封面失败不影响搜索结果，退回无封面
  }

  return {
    total: got.total,
    abroad: Boolean(data.abroad),
    songs: got.songs.map((s) => mapSong(detail[s.id] || s))
  };
}

function extractSongs(data) {
  const raw = data && data.result;
  if (!raw) return { songs: [], total: 0 };
  const isArray = Array.isArray(raw);
  const songs = isArray ? raw : Array.isArray(raw.songs) ? raw.songs : [];
  const total = isArray ? songs.length : raw.songCount || songs.length;
  return { songs, total };
}

/**
 * 搜索：先加密接口，不行再回退明文接口。
 * 两个都空的时候，把各自的原因一并回给前端，别让页面只会说「没搜到」。
 */
/** 搜歌单：走同一个 cloudsearch，type=1000 */
async function searchPlaylistsWeapi(q, limit, offset, env) {
  const data = await weapiPost(
    '/weapi/cloudsearch/pc',
    { s: q, type: 1000, limit, offset: offset || 0, total: true, csrf_token: '' },
    env
  );

  if (data.code !== 200 || !data.result) {
    throw new Error(`加密搜歌单 code=${data.code}${data.message ? ' ' + data.message : ''}`);
  }

  const list = data.result.playlists || [];
  return {
    total: data.result.playlistCount || list.length,
    playlists: list.map(mapPlaylist)
  };
}

async function searchPlaylistsPlain(q, limit, offset, env) {
  const url =
    `/api/search/get/web?s=${encodeURIComponent(q)}&type=1000&limit=${limit}` +
    `&offset=${offset || 0}&realIP=${REAL_IP}`;
  const data = await ne(url, env, { realIP: true });
  const r = (data && data.result) || {};
  const list = r.playlists || [];
  return {
    total: r.playlistCount || list.length,
    playlists: list.map(mapPlaylist)
  };
}

async function searchPlaylists(q, limit, offset, env) {
  let weapiError = null;

  try {
    const r = await searchPlaylistsWeapi(q, limit, offset, env);
    if (r.playlists.length) return { ...r, source: 'weapi' };
    weapiError = '加密接口返回 0 条';
  } catch (e) {
    weapiError = String((e && e.message) || e);
  }

  try {
    const plain = await searchPlaylistsPlain(q, limit, offset, env);
    return { ...plain, source: 'plain', weapiError };
  } catch (e) {
    return {
      total: 0,
      playlists: [],
      reason: 'error',
      source: 'none',
      hint: `搜索歌单失败：${weapiError}`,
      error: String((e && e.message) || e)
    };
  }
}

async function search(q, limit, offset, env) {
  let weapiError = null;

  try {
    const r = await searchWeapi(q, limit, offset, env);
    if (r.songs.length) return { ...r, source: 'weapi' };
    weapiError = '加密接口返回 0 条';
  } catch (e) {
    weapiError = String((e && e.message) || e);
  }

  let plain;
  try {
    plain = await searchPlain(q, limit, offset, env);
  } catch (e) {
    return {
      total: 0,
      songs: [],
      reason: 'error',
      source: 'none',
      hint: `搜索失败：${weapiError}`,
      error: String((e && e.message) || e)
    };
  }

  if (plain.songs.length) {
    return { ...plain, source: 'plain', weapiError };
  }

  const abroad = plain.abroad;
  return {
    total: 0,
    songs: [],
    abroad,
    reason: abroad ? 'abroad' : 'empty',
    source: 'none',
    weapiError,
    hint: abroad
      ? '网易云把这次请求判定为境外，明文接口返回空结果（加密接口也没返回内容）'
      : '网易云两个接口都返回了空结果（多半是这条出口 IP 被临时限流）'
  };
}

async function lyric(id, env) {
  // 新版接口（/v1）才带逐字 yrc；老接口只有整行，两边都试，谁能给就用谁
  const v1 = await weapiPost(
    '/weapi/song/lyric/v1',
    { id, cp: false, lv: -1, kv: -1, tv: -1, rv: -1, rv2: -1, yv: -1, ytv: -1, yrv: -1, csrf_token: '' },
    env
  ).catch(() => null);

  let d = v1 && v1.code === 200 && v1.lrc ? v1 : null;

  if (!d) {
    try {
      d = await weapiPost('/weapi/song/lyric', { id, lv: -1, kv: -1, tv: -1, csrf_token: '' }, env);
    } catch (e) {
      d = null;
    }
  }

  if (!d || d.code !== 200 || !d.lrc) {
    d = await ne(`/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`, env);
  }

  const pick = (root) => (root && root.lyric) || '';

  return {
    lrc: pick(d.lrc),
    // 逐字歌词不是每首都有，为空时前端退化成整行高亮
    klyric: pick(d.klyric),
    tlyric: pick(d.tlyric),
    // AMLL 用这两个：逐字正文 + 逐字翻译（网易云叫 yrc / ytlyric）
    yrc: pick(d.yrc),
    ytlyric: pick(d.ytlyric) || pick(d.ytlrc),
    yromalrc: pick(d.yromalrc)
  };
}

/** 音质档位 → 码率。前端传 level，Worker 翻译成网易云要的 br */
const QUALITY_BR = {
  standard: 128000,
  higher: 192000,
  exhigh: 320000,
  lossless: 999000,
  hires: 1900000
};

async function songUrl(id, env, level) {
  const want = QUALITY_BR[level] || QUALITY_BR.exhigh;
  let item = null;

  // 高音质拿不到（非 VIP / 无版权）就降到 320k，别让整首歌放不出来
  const tries = want > QUALITY_BR.exhigh ? [want, QUALITY_BR.exhigh] : [want];

  for (const br of tries) {
    try {
      const d = await weapiPost(
        '/weapi/song/enhance/player/url',
        { ids: JSON.stringify([id]), br, csrf_token: '' },
        env
      );
      item = (d.data || [])[0];
    } catch (e) {
      item = null;
    }

    if (!item || !item.url) {
      try {
        const d = await ne(
          `/api/song/enhance/player/url?id=${encodeURIComponent(id)}&ids=${encodeURIComponent(`[${id}]`)}&br=${br}`,
          env
        );
        item = (d.data || [])[0];
      } catch (e) {
        item = null;
      }
    }

    if (item && item.url) break;
  }

  if (!item || !item.url) return null;
  // 网易云给的是 http，强制升到 https，避免 https 页面上的混合内容
  return item.url.replace(/^http:\/\//i, 'https://');
}

// ---------------------------------------------------------------- 首页 / 歌单

const TOP_LISTS = [
  { id: '3778678', fallback: '热歌榜' },
  { id: '19723756', fallback: '飙升榜' },
  { id: '3779629', fallback: '新歌榜' }
];

/** 缓存键：同一份公共数据不该按口令等参数各存一份 */
function cacheKey(url) {
  const u = new URL(url);
  ['k', 't'].forEach((p) => u.searchParams.delete(p));
  return new Request(u.toString(), { method: 'GET' });
}

/**
 * 读缓存 → 没有就算 → 写缓存。缓存坏掉不能影响主流程
 * shouldCache：可选。返回 false 就不写缓存，避免把一次失败的空结果钉住整个 TTL。
 * 不传时行为与以前完全一致。
 */
async function withCache(url, ttl, produce, shouldCache) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = cacheKey(url);

  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return { data: await hit.json(), cached: true };
    } catch (e) { /* 没有 cache 绑定就直连 */ }
  }

  const data = await produce();

  if (cache && (!shouldCache || shouldCache(data))) {
    try {
      await cache.put(
        key,
        new Response(JSON.stringify(data), {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `max-age=${ttl}` }
        })
      );
    } catch (e) { /* 写缓存失败无所谓 */ }
  }

  return { data, cached: false };
}

function pic(url, size) {
  if (!url) return '';
  return `${url.replace(/^http:\/\//i, 'https://')}?param=${size}`;
}

function mapPlaylist(p) {
  return {
    id: p.id,
    name: p.name,
    cover: pic(p.coverImgUrl || p.picUrl || p.coverUrl, '400y400'),
    playCount: p.playCount || p.playcount || 0,
    trackCount: p.trackCount || 0,
    creator: (p.creator && p.creator.nickname) || ''
  };
}

async function songsByIds(ids, env) {
  const out = [];
  const opts = { noCookie: true };

  // 一包 200 首，POST body 没有 URL 长度限制，慢一点但稳
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    try {
      const d = await weapiPost(
        '/weapi/v3/song/detail',
        { c: JSON.stringify(chunk.map((id) => ({ id }))), csrf_token: '' },
        env,
        opts
      );
      (d.songs || []).forEach((s) => out.push(mapSong(s)));
    } catch (e) { /* 某一批失败就少这几首，不要整单失败 */ }
  }

  return out;
}

async function playlistData(id, env) {
  // v3 对匿名请求只返回 ~10 个 trackId（实测），v6 才给全量 tracks
  const d = await weapiPost('/weapi/v6/playlist/detail', { id, n: 1000, s: 0, csrf_token: '' }, env, { noCookie: true });
  const p = d.playlist;
  if (!p) throw new Error('歌单不存在或不可见');

  let tracks = (p.tracks || []).map(mapSong).filter((s) => s && s.id);

  // 万一 tracks 被裁，就退回 trackIds + 批量补详情
  if (!tracks.length && (p.trackIds || []).length) {
    tracks = await songsByIds(p.trackIds.slice(0, 800).map((t) => t.id), env);
  }

  return {
    id: p.id,
    name: p.name,
    cover: pic(p.coverImgUrl, '500y500'),
    description: (p.description || '').slice(0, 200),
    creator: (p.creator && p.creator.nickname) || '',
    trackCount: p.trackCount || tracks.length,
    tracks: tracks.slice(0, 800)
  };
}

async function categoryData(name, limit, env) {
  const d = await weapiPost(
    '/weapi/playlist/list',
    { cat: name, order: 'hot', offset: 0, limit: limit || 12, total: true, csrf_token: '' },
    env,
    { noCookie: true }
  );
  return { name, playlists: (d.playlists || []).map(mapPlaylist) };
}

async function homeData(env) {
  const opts = { noCookie: true };

  const [rec, cat, ns] = await Promise.all([
    weapiPost('/weapi/personalized/playlist', { limit: 12, total: true, n: 1000, csrf_token: '' }, env, opts),
    weapiPost('/weapi/playlist/catalogue', { csrf_token: '' }, env, opts),
    weapiPost('/weapi/personalized/newsong', { type: 'recommend', limit: 9, areaId: 0, csrf_token: '' }, env, opts)
  ]);

  // 三个榜单：v6 直接给 tracks，取前 3 首做试听
  const lists = await Promise.all(
    TOP_LISTS.map(async (t) => {
      try {
        const d = await weapiPost('/weapi/v6/playlist/detail', { id: t.id, n: 3, s: 0, csrf_token: '' }, env, opts);
        const p = d.playlist || {};
        return {
          id: t.id,
          name: p.name || t.fallback,
          cover: pic(p.coverImgUrl, '400y400'),
          updateFrequency: p.updateFrequency || '',
          tracks: (p.tracks || []).slice(0, 3).map(mapSong)
        };
      } catch (e) {
        return { id: t.id, name: t.fallback, cover: '', updateFrequency: '', tracks: [] };
      }
    })
  );

  const newsongs = (ns.result || []).map((x) => {
    const m = mapSong(x.song || x);
    if (!m.cover && x.picUrl) m.cover = pic(x.picUrl, '300y300');
    return m;
  });

  return {
    recommend: (rec.result || []).map(mapPlaylist),
    categories: (cat.sub || []).slice(0, 16).map((c) => ({ id: c.id, name: c.name })),
    toplists: lists,
    newsongs
  };
}

// ---------------------------------------------------------------- 登录 / 二维码

/** Workers 里 set-cookie 可能是数组也可能是拼接串，两种都兜住 */
function cookieList(res) {
  if (res.headers && typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const raw = res.headers.get('set-cookie') || '';
  return raw ? raw.split(/,(?=[^;=]+=)/) : [];
}

function pickCookie(list, name) {
  const re = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)');
  for (const c of list) {
    const m = re.exec(c);
    if (m) return decodeURIComponent(m[1]);
  }
  return '';
}

async function qrKey(env) {
  const d = await weapiPost('/weapi/login/qrcode/unikey', { type: 1, csrf_token: '' }, env, { noCookie: true });
  if (d.code !== 200 || !d.unikey) throw new Error(d.message || '拿不到二维码 key（可能被风控）');
  return {
    key: d.unikey,
    // 网易云 App 扫这个网址就是登录确认
    url: `https://music.163.com/login?codekey=${encodeURIComponent(d.unikey)}`
  };
}

async function qrCheck(key, env) {
  const body = await weapiBody({ key, type: 1 });
  const res = await fetch(`${ORIGIN}/weapi/login/qrcode/client/login?csrf_token=`, {
    method: 'POST',
    headers: { ...headers(env, { noCookie: true }), 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const text = await res.text();
  let d = {};
  try {
    d = JSON.parse(text);
  } catch (e) { /* 非 JSON 就当没扫到 */ }

  const musicU = pickCookie(cookieList(res), 'MUSIC_U');
  return {
    code: d.code,
    message: d.message || d.msg || '',
    // 800 过期 / 801 等待 / 802 待确认 / 803 成功
    musicU: d.code === 803 ? musicU : ''
  };
}

/** vipType：11 = 黑胶 VIP，10 = 音乐包，0 = 普通用户（网易云的约定） */
function vipLabelOf(vipType) {
  if (vipType === 11) return '黑胶VIP';
  if (vipType === 10) return '音乐包';
  return '普通用户';
}

async function accountInfo(musicU, env) {
  const res = await fetch(`${ORIGIN}/api/nuser/account/get`, { headers: headers(env, { musicU }) });
  const j = await res.json().catch(() => ({}));

  const acc = (j && j.account) || null;
  const prof = (j && j.profile) || null;
  // 两个地方都可能给 vipType，取值优先 profile（更全）
  const vipType = Number((prof && prof.vipType) || (acc && acc.vipType) || 0);

  return {
    ok: Boolean(acc),
    nickname: (acc && acc.userName) || (prof && prof.nickname) || '',
    userId: (prof && prof.userId) || null,
    avatar: (prof && prof.avatarUrl) || '',
    level: Number((prof && prof.level) || 0),
    vipType,
    vipLabel: vipLabelOf(vipType),
    code: j && j.code
  };
}

/** 当前登录账号在网易云里的歌单（收藏 + 自建） */
async function userPlaylists(uid, env) {
  const d = await weapiPost(
    '/weapi/user/playlist',
    { uid, limit: 100, offset: 0, csrf_token: '' },
    env
  );

  const list = (d.playlist || []).map((p) => ({
    id: p.id,
    name: p.name,
    cover: pic(p.coverImgUrl, '300y300'),
    trackCount: p.trackCount || 0,
    specialType: p.specialType || 0,
    creator: (p.creator && p.creator.nickname) || ''
  }));

  return { uid, playlists: list };
}

// ---------------------------------------------------------------- 账号 / 会话

function b64url(bytes) {
  const b = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', ENC.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSign(keyStr, msg) {
  const key = await crypto.subtle.importKey('raw', ENC.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, ENC.encode(msg)));
}

/** 没配 SESSION_SECRET 就拿账号表当密钥——它同样是 Secret，够用 */
function sessionKey(env) {
  return String(env.SESSION_SECRET || env.ACCOUNTS_JSON || 'pmusic-local-key');
}

async function makeToken(name, env) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const payload = b64url(ENC.encode(JSON.stringify({ n: name, e: exp })));
  return { token: `${payload}.${await hmacSign(sessionKey(env), payload)}`, exp };
}

/** 校验签名和过期时间，返回账号名 */
async function readToken(token, env) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;

  const expect = await hmacSign(sessionKey(env), parts[0]);
  if (expect !== parts[1]) return null;

  let data = null;
  try {
    data = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
  } catch (e) {
    return null;
  }

  if (!data || !data.n || !data.e || data.e < Date.now()) return null;
  return data.n;
}

async function getAccount(name, env) {
  if (!name) return null;

  // 1) KV：一个 key 一个账号，增删不用动代码
  if (env.ACCOUNTS && typeof env.ACCOUNTS.get === 'function') {
    try {
      const raw = await env.ACCOUNTS.get(name);
      if (raw) return { name, ...JSON.parse(raw) };
    } catch (e) {
      return null;
    }
    return null;
  }

  // 2) Secret ACCOUNTS_JSON：整张表
  if (env.ACCOUNTS_JSON) {
    try {
      const list = JSON.parse(env.ACCOUNTS_JSON);
      const hit = (Array.isArray(list) ? list : []).find((a) => a && a.name === name);
      if (hit) return hit;
    } catch (e) { /* 配置写坏了就当没有 */ }
  }

  // 3) 代码里的兜底账号
  const builtin = BUILTIN_ACCOUNTS.find((a) => a.name === name);
  if (builtin) return builtin;

  return null;
}

async function verifyLogin(name, password, env) {
  const acc = await getAccount(name, env);
  if (!acc) return null;

  if (acc.passwordHash) {
    return (await sha256hex(password)) === acc.passwordHash ? acc : null;
  }
  if (typeof acc.password === 'string') {
    return acc.password === password ? acc : null;
  }
  return null;
}

/** 从 Authorization: Bearer ... 里取账号名 */
function bearerOf(request) {
  const raw = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: cors(request.headers.get('origin') || '', env.ALLOWED_ORIGIN)
      });
    }

    // 口令门默认关闭（REQUIRE_PASS=false）。开着的时候所有接口（含 health/login）都要带 ?k=
    // 口令为空等于没设防——直接跳过，免得出现"不带 k 进不去、带空 k 反而能进"的怪状态
    const passValue = (env && env.PASSWORD) || PASSWORD;
    if (passEnabled(env) && passValue && url.searchParams.get('k') !== passValue) {
      return json({ error: 'unauthorized', needPassword: true }, 401, request, env);
    }

    // 登录态：会话里的账号优先，其次请求头里的 MUSIC_U（本机扫码登录），最后 Worker Secret
    const sessionName = await readToken(bearerOf(request), env);
    const sessionAcc = sessionName ? await getAccount(sessionName, env) : null;
    const headerU = (request.headers.get('x-music-u') || url.searchParams.get('u') || '').trim();
    const userU = (sessionAcc && sessionAcc.musicU) || headerU;
    const ctx = userU ? { ...env, MUSIC_U: userU } : env;

    // 口令门关了，改由登录把关。两种凭证：
    //   1) Worker 会话 token（账号密码登录，换设备也能用）
    //   2) x-music-u 请求头（本机扫码登录，只存在这台浏览器）
    // REQUIRE_LOGIN=false 时整个登录校验跳过，接口全开。
    const PUBLIC = ['/api/health', '/api/login', '/api/session', '/api/qr/key', '/api/qr/check'];
    const needLogin = loginEnabled(env);
    // 认 sessionAcc 而不是 sessionName：账号被删掉之后，旧 token 立刻失效
    if (needLogin && PUBLIC.indexOf(url.pathname) === -1 && !sessionAcc && !headerU) {
      return json({ error: 'unauthorized', needLogin: true }, 401, request, env);
    }

    try {
      if (url.pathname === '/api/health') {
        return json(
          { ok: true, vip: Boolean(ctx.MUSIC_U), login: needLogin, ts: Date.now() },
          200,
          request,
          env
        );
      }

      // 登录：账号密码 → 签名 token
      if (url.pathname === '/api/login' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const name = String(body.name || '').trim();
        const password = String(body.password || '');

        if (!name || !password) {
          return json({ error: '账号名和密码都要填' }, 400, request, env);
        }

        // 限流：先看内存（快），没被拦再问一次 KV（跨 isolate，弱一致）
        const ip = clientIp(request);
        let wait = loginBlockedSeconds(ip);
        if (!wait) {
          const kv = await kvLoginFail(ip, env);
          if (kv && Number(kv.n) >= LOGIN_MAX_FAILS) {
            wait = Math.max(1, Math.ceil((kv.resetAt - Date.now()) / 1000));
          }
        }
        if (wait) {
          const later = wait < 60 ? `${wait} 秒` : `${Math.ceil(wait / 60)} 分钟`;
          const res = json(
            { error: `密码错误次数过多，请 ${later}后再试`, retryAfter: wait },
            429,
            request,
            env
          );
          res.headers.set('retry-after', String(wait));
          return res;
        }

        // 简单拖一下时间，别让人拿脚本高速猜
        await new Promise((r) => setTimeout(r, 250));

        const acc = await verifyLogin(name, password, env);
        if (!acc) {
          noteLoginFail(ip);
          await kvNoteLoginFail(ip, env);
          return json({ error: '账号或密码不对' }, 401, request, env);
        }

        // 登录成功就把这张 IP 的失败计数清掉
        clearLoginFail(ip);
        await kvClearLoginFail(ip, env);

        const t = await makeToken(name, env);
        return json(
          { ok: true, name, token: t.token, exp: t.exp, hasMusicU: Boolean(acc.musicU) },
          200,
          request,
          env
        );
      }

      // 会话自检
      if (url.pathname === '/api/session') {
        if (!sessionAcc) return json({ ok: false }, 401, request, env);
        return json(
          { ok: true, name: sessionName, hasMusicU: Boolean(sessionAcc.musicU) },
          200,
          request,
          env
        );
      }

      // 二维码登录：拿 key
      if (url.pathname === '/api/qr/key') {
        return json(await qrKey(ctx), 200, request, env);
      }

      // 二维码登录：轮询状态，803 时把 MUSIC_U 带回来
      if (url.pathname === '/api/qr/check') {
        const key = (url.searchParams.get('key') || '').trim();
        if (!key) return json({ error: '缺少 key' }, 400, request, env);
        return json(await qrCheck(key, ctx), 200, request, env);
      }

      // 用 MUSIC_U 换账号信息（校验能不能用）
      if (url.pathname === '/api/me') {
        if (!userU) return json({ ok: false, error: '缺少 MUSIC_U' }, 400, request, env);
        return json(await accountInfo(userU, ctx), 200, request, env);
      }

      // 设置里的「账号」组：昵称 / 等级 / VIP 等级
      if (url.pathname === '/api/account') {
        if (!userU) {
          return json({ ok: false, bound: false, error: '当前账号没有绑定网易云（MUSIC_U）' }, 400, request, env);
        }
        const info = await accountInfo(userU, ctx);
        return json({ ...info, bound: true }, 200, request, env);
      }

      // 读取当前网易云账号下的歌单，供「导入我的歌单」用
      if (url.pathname === '/api/myplaylists') {
        if (!userU) {
          return json({ ok: false, bound: false, error: '当前账号没有绑定网易云（MUSIC_U）' }, 400, request, env);
        }
        const info = await accountInfo(userU, ctx);
        if (!info.userId) {
          return json({ ok: false, error: '读不到账号 UID，凭证可能已经失效' }, 400, request, env);
        }
        const r = await userPlaylists(info.userId, ctx);
        return json({ ok: true, ...r }, 200, request, env);
      }

      if (url.pathname === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json({ error: '缺少 q 参数' }, 400, request, env);
        const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 20));
        // 网易云超过 ~1000 条会开始返回空/重复，夹一下，别让前端翻出一堆假页
        const offset = Math.min(1000, Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0));
        // kind=playlist 搜歌单，默认搜歌曲（保持老调用方不变）
        if (url.searchParams.get('kind') === 'playlist') {
          return json(await searchPlaylists(q, limit, offset, ctx), 200, request, env);
        }
        return json(await search(q, limit, offset, ctx), 200, request, env);
      }

      // 歌词按歌曲 ID 缓存 1 小时：同一首歌的歌词基本不会变，重复请求没必要再打上游。
      // 只有真拿到歌词才写缓存，避免一次空结果被钉住一小时（此时下次请求会重新取）。
      if (url.pathname === '/api/lyric') {
        const id = url.searchParams.get('id');
        if (!id) return json({ error: '缺少 id 参数' }, 400, request, env);
        const r = await withCache(
          request.url,
          3600,
          () => lyric(id, ctx),
          (d) => Boolean(d && (d.lrc || d.yrc || d.klyric))
        );
        return json(r.data, 200, request, env);
      }

      if (url.pathname === '/api/url') {
        const id = url.searchParams.get('id');
        if (!id) return json({ error: '缺少 id 参数' }, 400, request, env);

        const level = (url.searchParams.get('level') || 'exhigh').trim();
        const target = await songUrl(id, ctx, level);
        if (!target) {
          return json({ error: '拿不到播放地址（VIP / 版权受限 / 已下架）' }, 404, request, env);
        }

        // 默认回 JSON，让前端把直链交给 <audio>。
        // 302 虽然也能播，但媒体元素的 src 始终指向 Worker，浏览器每次补
        // 区间 / 拖动进度都要重新穿过 Worker 再问一次网易云，慢且容易被限流。
        // ?redirect=1 保留旧的跳转行为（浏览器直接打开时方便测试）。
        if (url.searchParams.get('redirect') === '1') {
          return new Response(null, {
            status: 302,
            headers: {
              Location: target,
              'cache-control': 'no-store',
              ...cors(request.headers.get('origin') || '', env.ALLOWED_ORIGIN)
            }
          });
        }

        return json({ url: target }, 200, request, env);
      }

      // 首页聚合：推荐歌单 + 分类 + 榜单 + 新歌，缓存 10 分钟
      if (url.pathname === '/api/home') {
        const r = await withCache(request.url, 600, () => homeData(ctx));
        return json({ ...r.data, cached: r.cached }, 200, request, env);
      }

      // 歌单详情（导入用）：id 必须全是数字，别把任意字符串透传给网易云
      if (url.pathname === '/api/playlist') {
        const id = (url.searchParams.get('id') || '').trim();
        if (!/^\d{3,20}$/.test(id)) {
          return json({ error: '歌单 id 不合法（应该是纯数字）' }, 400, request, env);
        }
        const r = await withCache(request.url, 300, () => playlistData(id, ctx));
        return json({ ...r.data, cached: r.cached }, 200, request, env);
      }

      // 分类下的歌单（首页分类 chip）
      if (url.pathname === '/api/category') {
        const name = (url.searchParams.get('name') || '').trim();
        if (!name) return json({ error: '缺少 name' }, 400, request, env);
        const limit = Math.min(30, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 12));
        const r = await withCache(request.url, 600, () => categoryData(name, limit, ctx));
        return json({ ...r.data, cached: r.cached }, 200, request, env);
      }

      if (url.pathname === '/api/debug') {
        const q = (url.searchParams.get('q') || '周杰伦').trim();
        const id = url.searchParams.get('id') || '186016';
        const out = {
          env: {
            hasMusicU: Boolean(env.MUSIC_U),
            musicULength: env.MUSIC_U ? String(env.MUSIC_U).length : 0,
            // 整串 cookie 里会出现 MUSIC_U= 和分号；裸值不会
            hasMusicUPrefix: /MUSIC_U=/.test(String(env.MUSIC_U || '')),
            hasSemicolon: String(env.MUSIC_U || '').includes(';'),
            // 实际发出去的 Cookie 头长什么样（值本身打码）
            cookiePreview: cookieHeader(env.MUSIC_U)
              .replace(/(MUSIC_U=\w{4})\w+/g, '$1…')
              .slice(0, 120),
            hasToken: Boolean(env.API_TOKEN)
          },
          search: null,
          url: null
        };

        try {
          const res = await fetch(
            `${ORIGIN}/api/search/get/web?s=${encodeURIComponent(q)}&type=1&limit=3&offset=0`,
            { headers: headers(env) }
          );
          const text = await res.text();
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch (e) {
            /* 不是 JSON，下面原样返回 */
          }
          out.search = {
            http: res.status,
            contentType: res.headers.get('content-type'),
            code: parsed && parsed.code,
            abroad: parsed && parsed.abroad,
            hasResult: Boolean(parsed && parsed.result),
            // result 在不同 IP 下可能是对象也可能是数组，两个都报出来
            resultType: parsed && parsed.result ? (Array.isArray(parsed.result) ? 'array' : typeof parsed.result) : 'none',
            resultKeys:
              parsed && parsed.result && !Array.isArray(parsed.result)
                ? Object.keys(parsed.result).slice(0, 10)
                : undefined,
            songCount: parsed && parsed.result && !Array.isArray(parsed.result) ? parsed.result.songCount : undefined,
            songsLen:
              parsed && parsed.result
                ? Array.isArray(parsed.result)
                  ? parsed.result.length
                  : Array.isArray(parsed.result.songs)
                    ? parsed.result.songs.length
                    : 0
                : 0,
            bytes: text.length,
            raw: parsed ? undefined : text.slice(0, 400),
            keys: parsed ? Object.keys(parsed).slice(0, 12) : undefined
          };
        } catch (e) {
          out.search = { error: String(e.message) };
        }

        // 关键对照：同一条出口 IP，明文接口（会判境外）vs 加密接口（网页版用的）
        try {
          const r = await searchWeapi(q, 3, 0, env);
          out.searchWeapi = {
            ok: true,
            abroad: r.abroad,
            total: r.total,
            songsLen: r.songs.length,
            first: r.songs[0] ? `${r.songs[0].name} - ${r.songs[0].artists}` : null
          };
        } catch (e) {
          out.searchWeapi = { ok: false, error: String(e.message) };
        }

        try {
          const res = await fetch(`${ORIGIN}/api/song/enhance/player/url?id=${id}&ids=${encodeURIComponent(`[${id}]`)}&br=320000`, { headers: headers(env) });
          const text = await res.text();
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch (e) {
            /* ignore */
          }
          const item = parsed && parsed.data && parsed.data[0];
          out.url = {
            http: res.status,
            code: parsed && parsed.code,
            hasUrl: Boolean(item && item.url),
            fee: item && item.fee,
            br: item && item.br,
            urlHost: item && item.url ? new URL(item.url).host : null
          };
        } catch (e) {
          out.url = { error: String(e.message) };
        }

        // 登录态：cookie 到底有没有被认。这是判断 VIP 能不能用的关键
        try {
          const res = await fetch(`${ORIGIN}/api/nuser/account/get`, { headers: headers(env) });
          const j = await res.json();
          out.account = {
            http: res.status,
            code: j.code,
            msg: j.message || j.msg || null,
            hasAccount: Boolean(j.account),
            nickname: j.account ? j.account.userName : null,
            vipType: j.account ? j.account.vipType : null,
            profileId: j.profile ? j.profile.userId : null
          };
        } catch (e) {
          out.account = { error: String(e.message) };
        }

        // 对照组：一首确定免费的歌（起风了），用来区分「cookie 不灵」和「接口不灵」
        try {
          const freeId = '1330348068';
          const res = await fetch(`${ORIGIN}/api/song/enhance/player/url?id=${freeId}&ids=${encodeURIComponent(`[${freeId}]`)}&br=320000`, { headers: headers(env) });
          const j = await res.json();
          const item = j.data && j.data[0];
          out.urlFree = {
            code: j.code,
            hasUrl: Boolean(item && item.url),
            br: item && item.br
          };
        } catch (e) {
          out.urlFree = { error: String(e.message) };
        }

        return json(out, 200, request, env);
      }

      return json(
        { error: 'not found', usage: ['/api/search?q=', '/api/lyric?id=', '/api/url?id=', '/api/home', '/api/playlist?id=', '/api/health'] },
        404,
        request,
        env
      );
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502, request, env);
    }
  }
};
