/* /music —— 搜索优先 + 封面 + 歌词 + 大屏模式
 *
 * 数据全部走 Worker（workers/netease-api）：
 *   /api/health        探口令
 *   /api/search?q=     搜索
 *   /api/lyric?id=     歌词
 *   /api/url?id=       返回网易云直链 JSON，交给 <audio src>
 *
 * Worker 若配了口令（PASSWORD / API_TOKEN），每个请求都要带 &k=口令，
 * 口令存在 localStorage，第一次进来会弹口令门。
 */
(function () {
  'use strict';

  var API = String(window.MUSIC_API || '').replace(/\/+$/, '');
  // 口令存在浏览器里，其次才用页面里预置的
  var TOKEN = '';
  try { TOKEN = localStorage.getItem('music-pass') || ''; } catch (e) {}
  if (!TOKEN) TOKEN = String(window.MUSIC_TOKEN || '');

  function tk() {
    return TOKEN ? '&k=' + encodeURIComponent(TOKEN) : '';
  }

  /** 给任意 URL 补口令：没有查询串时要用 ? ，不能直接拼 & */
  function withK(url) {
    if (!TOKEN) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'k=' + encodeURIComponent(TOKEN);
  }

  /** 所有打 Worker 的请求都走这里：带上会话 token（Worker 再用它找到账号的 MUSIC_U） */
  function apiFetch(url, opts) {
    opts = opts || {};
    var h = {};
    var key;
    for (key in opts.headers || {}) h[key] = opts.headers[key];

    var acc = currentAccount();
    if (acc && acc.token && !h.authorization) h.authorization = 'Bearer ' + acc.token;
    if (acc && acc.musicU && !h['x-music-u']) h['x-music-u'] = acc.musicU;

    opts.headers = h;
    return fetch(url, opts);
  }

  var $ = function (id) { return document.getElementById(id); };

  var app = $('app');
  var input = $('q');
  var goBtn = $('q-go');
  var clearBtn = $('q-clear');
  var hint = $('hint');
  var results = $('results');
  var meta = $('meta');
  var skeleton = $('skeleton');
  var list = $('list');
  var empty = $('empty');
  var historyBox = $('history');
  var historyItems = $('history-items');
  var historyClear = $('history-clear');

  var gate = $('gate');
  var gateForm = $('gate-form');
  var gateInput = $('gate-input');
  var gateMsg = $('gate-msg');
  var gateActive = false;

  /* ---------------------------------------------------------------- 口令门 */
  // Worker 配了密码时，所有接口都要带 ?k=。这里先用 /api/health 探一下：
  // 200 说明没设密码（或口令对），401 就把门挡上。
  function healthStatus(pass) {
    var u = API + '/api/health' + (pass ? '?k=' + encodeURIComponent(pass) : '');
    return fetch(u).then(function (r) { return r.status; });
  }

  function showGate(msg) {
    gateActive = true;
    gateMsg.textContent = msg || '';
    gate.hidden = false;
    refreshAccountUI(); // 口令门盖着时别再显示账号登录页
    setTimeout(function () { gateInput.focus(); }, 30);
  }

  function hideGate() {
    gateActive = false;
    gate.hidden = true;
    gateInput.value = '';
    gateMsg.textContent = '';
    refreshAccountUI();
  }

  function savePass(p) {
    TOKEN = p;
    try {
      if (p) localStorage.setItem('music-pass', p);
      else localStorage.removeItem('music-pass');
    } catch (e) {}
  }

  /** 口令失效：清掉本地值，把卡片摆出来 */
  function requirePass() {
    savePass('');
    showGate('口令失效了，请重新输入');
  }

  /**
   * 401 统一处理：先看响应体 —— 是口令门就显示口令卡片，
   * 否则才当成"需要登录"。
   */
  function authGuard(r) {
    if (r.status !== 401 && r.status !== 403) return r;

    return r
      .clone()
      .json()
      .catch(function () { return {}; })
      .then(function (d) {
        if (d && d.needPassword) {
          requirePass();
          throw new Error('需要口令');
        }
        if (currentAccount()) {
          saveSession(null);
          refreshAccountUI();
          toast('登录过期了，重新登录一下');
        }
        throw new Error('需要登录');
      });
  }

  /** 拿口令去探一次，对了就存下来并关门 */
  function unlockWith(pass) {
    if (!pass) return Promise.resolve(false);

    return healthStatus(pass).then(function (code) {
      if (code !== 200) return false;

      savePass(pass);
      hideGate();
      // 解锁后重新问一次配置：可能只开了口令门，也可能还要账号登录
      homeLoaded = false;
      initAuth();
      return true;
    });
  }

  // 卡片就是口令门本体
  gateForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = gateInput.value.trim();
    if (!v) return;
    gateMsg.textContent = '验证中…';
    unlockWith(v).then(function (ok) {
      if (ok) return;
      gateMsg.textContent = '口令不对';
    }).catch(function () { gateMsg.textContent = '连不上 Worker'; });
  });

  var audio = $('audio');
  var player = $('player');
  var pCover = $('p-cover');
  var pTitle = $('p-title');
  var pArtist = $('p-artist');
  var seek = $('seek');
  var vol = $('vol');
  var tCur = $('t-cur');
  var tDur = $('t-dur');

  var stage = $('stage');
  var stageBg = $('stage-bg');
  var lyricsBox = $('lyrics');
  var sCover = $('s-cover');
  var sTitle = $('s-title');
  var sArtist = $('s-artist');
  var sSeek = $('s-seek');
  var sCur = $('s-cur');
  var sDur = $('s-dur');

  var songs = [];        // 当前播放队列
  var queues = { search: [], home: [], playlist: [] };
  var activeQueue = 'search';
  var current = -1;
  var currentId = null; // 当前音频对应的歌曲 id：列表换了也不会指错
  var nowPlaying = null; // 正在播的那首歌的完整对象，清空搜索后也要能下载
  var trackToken = 0;    // 连续切歌时用来丢弃过期的取址请求
  var lines = [];        // [{ t, text }]
  var activeLine = -1;
  var lyricToken = 0;
  var seeking = false;

  /* ------------------------------------------------------------------ 基础 */
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return '00:00';
    return pad(Math.floor(sec / 60)) + ':' + pad(Math.floor(sec % 60));
  }

  function fill(el, ratio) {
    el.style.setProperty('--fill', (Math.max(0, Math.min(1, ratio)) * 100).toFixed(2) + '%');
  }

  var toastEl = null;
  var toastTimer = null;

  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 3200);
  }

  function fail(msg) {
    hint.textContent = msg;
    hint.classList.add('is-error');
  }

  // 地址写错是最常见的问题，开局就拦下来，别等到请求失败
  if (API && !/^https?:\/\//i.test(API)) {
    fail('window.MUSIC_API 必须以 https:// 开头，现在是「' + API + '」');
  }

  /* ------------------------------------------------------------------ 搜索 */
  function setSearching(on) {
    app.classList.toggle('is-searching', on);
    results.hidden = !on;
    if (!on) {
      list.innerHTML = '';
      queues.search = [];
    }
  }

  /** 列表行：搜索结果 / 歌单 / 首页新歌共用一套（行本身是 div，里面才能塞「＋」按钮） */
  function buildRow(song, i, queueName) {
    var row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('data-i', i);
    row.setAttribute('data-q', queueName);
    row.setAttribute('data-id', song.id);

    var idx = document.createElement('span');
    idx.className = 'row-i';
    idx.textContent = pad(i + 1);

    var cover = document.createElement('img');
    cover.className = 'row-cover';
    cover.alt = '';
    cover.loading = 'lazy';
    if (song.cover) cover.src = song.cover;

    var main = document.createElement('span');
    main.className = 'row-main';
    var title = document.createElement('span');
    title.className = 'row-title';
    title.textContent = song.name || '未知曲目';
    var artist = document.createElement('span');
    artist.className = 'row-artist';
    artist.textContent = song.artists || '未知艺人';
    main.appendChild(title);
    main.appendChild(artist);

    var album = document.createElement('span');
    album.className = 'row-album';
    album.textContent = song.album || '';

    var dur = document.createElement('span');
    dur.className = 'row-dur';
    dur.textContent = song.duration ? fmt(song.duration / 1000) : '—';

    var add = document.createElement('button');
    add.className = 'row-add';
    add.type = 'button';
    add.title = '加入歌单';
    add.setAttribute('aria-label', '把这首歌加入歌单');
    add.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>';

    row.appendChild(idx);
    row.appendChild(cover);
    row.appendChild(main);
    row.appendChild(album);
    row.appendChild(dur);
    row.appendChild(add);
    return row;
  }

  /** 铺一批歌，同时把它登记成一条可播放队列 */
  function renderRows(container, arr, queueName) {
    container.innerHTML = '';
    queues[queueName] = arr;
    arr.forEach(function (song, i) {
      var li = document.createElement('li');
      li.appendChild(buildRow(song, i, queueName));
      container.appendChild(li);
    });
    highlightRows();
  }

  /** 按 song id 高亮，跨列表也不会错位 */
  function highlightRows() {
    var all = document.querySelectorAll('.row');
    for (var i = 0; i < all.length; i += 1) {
      all[i].classList.toggle('is-playing', currentId != null && all[i].getAttribute('data-id') === String(currentId));
    }
  }

  function renderSongs(data) {
    var arr = data.songs || [];
    skeleton.hidden = true;

    meta.textContent = arr.length
      ? '找到 ' + (data.total || arr.length) + ' 首，显示前 ' + arr.length + ' 首' +
        (data.abroad ? '（网易云降级结果）' : '')
      : '';

    empty.hidden = arr.length !== 0;
    // Worker 会带上 reason/hint：区分「网易云降级」和「被限流」，
    // 不要一律显示「没搜到」，那样根本没法排查
    empty.textContent = data.hint || '没搜到，换个关键词试试';

    renderRows(list, arr, 'search');
  }

  function search(kw) {
    if (!API) {
      fail('还没配置 Worker 地址（source/music/index.html 里的 window.MUSIC_API）');
      return;
    }

    kw = (kw || '').trim();
    if (!kw) {
      setSearching(false);
      return;
    }

    hint.classList.remove('is-error');
    hint.textContent = '搜索中…';
    setSearching(true);
    goBtn.disabled = true;
    skeleton.hidden = false;
    empty.hidden = true;
    list.innerHTML = '';
    meta.textContent = '';

    var url = API + '/api/search?q=' + encodeURIComponent(kw) + '&limit=20' + tk();

    apiFetch(url)
      .then(authGuard)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        goBtn.disabled = false;
        if (data.error) throw new Error(data.error);
        hint.textContent = '回车，或点放大镜';
        // 只有真搜出东西才记进历史，避免把错别字脏数据也存下来
        if (data.songs && data.songs.length) rememberSearch(kw);
        renderSongs(data);
      })
      .catch(function (e) {
        goBtn.disabled = false;
        skeleton.hidden = true;
        // 把实际请求的地址也打出来，404 时一眼能看出是哪个域名/路径不对
        fail('搜索失败：' + e.message + ' → ' + url);
        empty.hidden = false;
        empty.textContent = '搜索失败，看上面那行地址对不对';
      });
  }

  /* ---------------------------------------------------------------- 搜索记录 */
  var HISTORY_KEY = 'music-history';
  var HISTORY_MAX = 8;

  function loadHistory() {
    try {
      var arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (x) { return typeof x === 'string' && x; });
    } catch (e) {
      return [];
    }
  }

  function saveHistory(arr) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  function renderHistory() {
    var arr = loadHistory();

    historyItems.innerHTML = '';
    arr.forEach(function (kw) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'history-item';
      b.textContent = kw;
      b.title = kw;
      b.addEventListener('click', function () {
        input.value = kw;
        clearBtn.hidden = false;
        search(kw);
      });
      historyItems.appendChild(b);
    });

    historyBox.hidden = !arr.length;
  }

  function rememberSearch(kw) {
    kw = String(kw || '').trim();
    if (!kw) return;
    // 搜过的词提到最前，不产生重复
    var arr = loadHistory().filter(function (x) { return x !== kw; });
    arr.unshift(kw);
    saveHistory(arr.slice(0, HISTORY_MAX));
    renderHistory();
  }

  historyClear.addEventListener('click', function () {
    saveHistory([]);
    renderHistory();
  });

  /* ------------------------------------------------------------------ 歌词 */
  function parseLrc(text) {
    var out = [];
    var re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

    text.split(/\r?\n/).forEach(function (raw) {
      var content = raw.replace(re, '').trim();
      if (!content) return;

      var m;
      re.lastIndex = 0;
      while ((m = re.exec(raw))) {
        var frac = m[3] ? parseInt(m[3].padEnd(2, '0').slice(0, 2), 10) / 100 : 0;
        out.push({ t: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac, text: content });
      }
    });

    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  /** 翻译歌词：同一套时间轴，按 10ms 精度索引，和主歌词对齐 */
  function parseLrcMap(text) {
    var map = {};
    parseLrc(text).forEach(function (l) {
      map[Math.round(l.t * 100)] = l.text;
    });
    return map;
  }

  function renderLyrics(list2, trMap) {
    lyricsBox.innerHTML = '';

    if (!list2.length) {
      var p = document.createElement('p');
      p.className = 'lyrics-hint';
      p.textContent = '这首歌没有歌词';
      lyricsBox.appendChild(p);
      lines = [];
      activeLine = -1;
      return;
    }

    list2.forEach(function (line) {
      var el = document.createElement('p');
      el.className = 'line';

      var main = document.createElement('span');
      main.className = 'line-tx';
      main.textContent = line.text;
      el.appendChild(main);

      var tr = trMap && trMap[Math.round(line.t * 100)];
      if (tr) {
        var sub = document.createElement('span');
        sub.className = 'line-tr';
        sub.textContent = tr;
        el.appendChild(sub);
      }

      lyricsBox.appendChild(el);
    });

    lines = list2;
    activeLine = -1;
  }

  /* ---------------------------------------------- 大屏歌词：AMLL（按需加载） */
  // AMLL 的 core 是框架无关的，打包成一个 IIFE（约 392KB，brotli ~100KB）。
  // 默认从本站 /vendor 取；想放到自己的 CDN 上，只改下面两个常量即可：
  //   AMLL_CDN = 'https://cdn.example.com/amll/20261203/'   ← 记得带结尾斜杠
  // 留空则完全用本地副本。CDN 挂了会自动回退到本地，不会白屏。
  var AMLL_CDN = '';                 // 例：'https://cdn.example.com/amll/20261203/'
  var AMLL_LOCAL = '/vendor/';       // 仓库里的兜底副本（可以删，但删了就没退路了）
  var AMLL_VER = '?v=20261210';      // 只对本地副本做缓存穿透
  var amllWrap = document.getElementById('amll-wrap');
  var lastLyric = null;
  var amll = { status: 0, waiters: [], player: null, lines: [], raf: 0, last: 0, playing: null };

  function mobileLayout() {
    return window.matchMedia('(max-width: 900px)').matches;
  }

  function wantAmll() {
    return !(settings && settings.amll === false);
  }

  /** 从某个基址拉 CSS + JS，两个都成功才算可用 */
  function loadAmllFrom(base, withVer) {
    return new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = base + 'amll-core.css' + (withVer ? AMLL_VER : '');
      document.head.appendChild(link);

      var s = document.createElement('script');
      s.src = base + 'amll-core.js' + (withVer ? AMLL_VER : '');
      s.async = true;
      s.onload = function () { resolve(!!(window.AMLL && window.AMLL.DomLyricPlayer)); };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
  }

  function loadAmll() {
    if (amll.status === 2) return Promise.resolve(true);
    if (amll.status === 3) return Promise.resolve(false);

    var p = new Promise(function (res) { amll.waiters.push(res); });
    if (amll.status === 1) return p;
    amll.status = 1;

    function done(ok) {
      if (amll.status === 2 || amll.status === 3) return; // 只结算一次
      amll.status = ok ? 2 : 3;
      clearTimeout(guard);
      amll.waiters.splice(0).forEach(function (fn) { fn(ok); });
    }

    // 组件 392KB，移动网络下可能很慢：6 秒还不就绪就放弃，先用轻量歌词顶着
    var guard = setTimeout(function () { done(false); }, 6000);

    var first = AMLL_CDN ? loadAmllFrom(AMLL_CDN, false) : Promise.resolve(false);

    first
      .then(function (ok) {
        if (ok) {
          done(true);
          return;
        }
        return loadAmllFrom(AMLL_LOCAL, true).then(done);
      })
      .catch(function () { done(false); });

    return p;
  }

  /**
   * 网易云逐字歌词（yrc）：每行形如
   *   [28480,11820](28480,594,0)字(29074,594,0)字…
   * 前面还会混进几行 JSON 制作人信息（{"t":0,"c":[…]}），按首字符过滤掉。
   */
  function parseYrc(text) {
    var out = [];
    var raw = String(text || '').split('\n');

    for (var i = 0; i < raw.length; i += 1) {
      var line = raw[i].trim();
      if (!line || line.charAt(0) !== '[') continue;

      var head = /^\[(\d+),(\d+)\]/.exec(line);
      if (!head) continue;

      var start = parseInt(head[1], 10);
      var dur = parseInt(head[2], 10);
      var words = [];
      var re = /\((\d+),(\d+),\d+\)([^()]*)/g;
      var m;

      re.lastIndex = 0;
      while ((m = re.exec(line))) {
        var wt = parseInt(m[1], 10);
        var wd = parseInt(m[2], 10);
        if (!m[3]) continue;
        words.push({ word: m[3], startTime: wt, endTime: wt + wd });
      }

      if (!words.length) continue;
      out.push({ startTime: start, endTime: start + (dur || 0), words: words });
    }

    fixLineEnd(out);
    return out;
  }

  /** 行结束时间兜底：拿下一行的起点，避免最后一行/间奏把进度条撑爆 */
  function fixLineEnd(list) {
    for (var i = 0; i < list.length; i += 1) {
      var next = list[i + 1];
      if (next && (!list[i].endTime || list[i].endTime > next.startTime)) list[i].endTime = next.startTime;
      if (!list[i].endTime || list[i].endTime <= list[i].startTime) {
        list[i].endTime = next ? next.startTime : list[i].startTime + 4000;
      }
    }
  }

  /** 没有逐字歌词时退化成整行：每个词就是整行，AMLL 照样有弹性滚动和模糊 */
  function lrcToAmllLines(lrc) {
    var plain = parseLrc(lrc);
    var out = [];

    for (var i = 0; i < plain.length; i += 1) {
      var t = Math.round(plain[i].t * 1000);
      var end = i + 1 < plain.length ? Math.round(plain[i + 1].t * 1000) : t + 4000;
      out.push({
        startTime: t,
        endTime: end,
        words: [{ word: plain[i].text, startTime: t, endTime: end }]
      });
    }

    return out;
  }

  function amllLinesFor(data) {
    // 翻译按「10ms 取整」的时间点对齐（和 parseLrcMap 的键一致）
    var trMap = parseLrcMap(data.ytlyric || data.tlyric || '');
    var list = parseYrc(data.yrc || '');
    if (!list.length) list = lrcToAmllLines(data.lrc || '');

    if (settings.trans) {
      list.forEach(function (l) {
        var tr = trMap[Math.round(l.startTime / 10)];
        if (tr) l.translatedLyric = tr;
      });
    }

    return list;
  }

  /** 歌词偏移（毫秒，正数=歌词提前） */
  function offsetMs() {
    return settings && isFinite(settings.offset) ? settings.offset : 0;
  }

  function lyricMs() {
    return Math.round(audio.currentTime * 1000) + offsetMs();
  }

  function ensureAmllPlayer() {
    if (amll.player) return amll.player;

    var Ctor = window.AMLL.DomLyricPlayer;
    var p = new Ctor();
    amllWrap.appendChild(p.getElement());

    p.setEnableBlur(true);
    // 手机把当前行放在偏上，桌面居中（和原来 36% 的手感对齐）
    p.setAlignPosition(mobileLayout() ? 0.38 : 0.5);
    p.setWordFadeWidth(0.5);

    // 点歌词跳转：AMLL 自己派发 line-click，带行号
    p.addEventListener('line-click', function (e) {
      var line = amll.lines[e.lineIndex];
      if (!line || currentId == null) return;
      if (!isFinite(audio.duration) || audio.duration <= 0) {
        toast('还没加载好，稍等一下');
        return;
      }
      audio.currentTime = Math.max(0, (line.startTime - offsetMs()) / 1000 - 0.08);
      if (audio.paused) audio.play().catch(function () {});
      p.setCurrentTime(lyricMs(), true);
    });

    amll.player = p;
    amll.playing = null;
    syncAmllPlayState();
    return p;
  }

  /**
   * AMLL 自己维护 isPlaying：只有 true 才会推进逐字遮罩。
   * 页面加载后第一首歌的 play 事件往往早于播放器创建，必须在这里补同步，
   * 否则第一首有逐字歌词的歌会「有词无高亮」，换首歌才恢复。
   */
  function syncAmllPlayState() {
    var p = amll.player;
    if (!p) return;
    var playing = !audio.paused;
    if (playing === amll.playing) return;
    amll.playing = playing;
    if (playing) p.resume();
    else p.pause();
  }

  function amllFrame(ts) {
    var p = amll.player;
    if (!p) return;

    var delta = amll.last ? Math.min(1000, ts - amll.last) : 16;
    amll.last = ts;

    syncAmllPlayState();
    if (!audio.paused) p.setCurrentTime(lyricMs());
    p.update(delta);
    amll.raf = requestAnimationFrame(amllFrame);
  }

  function startAmll() {
    if (!amll.player || amll.raf) return;
    amll.last = 0;
    amll.raf = requestAnimationFrame(amllFrame);
  }

  function stopAmll() {
    if (amll.raf) cancelAnimationFrame(amll.raf);
    amll.raf = 0;
  }

  function showAmll(on) {
    amllWrap.hidden = !on;
    lyricsBox.hidden = on;
  }

  /**
   * 统一的歌词渲染入口：能上 AMLL 就上，加载失败/手机端就退回轻量渲染。
   * 歌切得太快时用 lastLyric 做令牌，避免旧请求回来把新歌覆盖掉。
   */
  function applyLyric() {
    var data = lastLyric;
    if (!data) return;

    // 调试开关打开时，把「有没有逐字」也标出来，方便判断是接口没给还是前端没渲染
    if (settings.debug) {
      var idEl = $('s-id');
      if (idEl) idEl.textContent = 'ID ' + currentId + (parseYrc(data.yrc || '').length ? ' · 逐字' : ' · 整行');
    }

    if (!wantAmll()) {
      showAmll(false);
      stopAmll();
      renderLyrics(parseLrc(data.lrc || ''), parseLrcMap(data.tlyric || ''));
      return;
    }

    // AMLL 还没就绪（首次打开、网络慢）时先把轻量歌词渲染出来，
    // 否则用户会一直盯着「歌词加载中…」，等 392KB 的组件下载完才看到字。
    if (amll.status !== 2) {
      showAmll(false);
      renderLyrics(parseLrc(data.lrc || ''), parseLrcMap(data.tlyric || ''));
    }

    loadAmll().then(function (ok) {
      if (!ok || !wantAmll() || lastLyric !== data) return;

      var list = amllLinesFor(data);
      if (!list.length) {
        showAmll(false);
        renderLyrics(parseLrc(data.lrc || ''), parseLrcMap(data.tlyric || ''));
        return;
      }

      var p = ensureAmllPlayer();
      amll.lines = list;
      var ms = lyricMs();
      p.setLyricLines(list, ms);
      p.setCurrentTime(ms, true);
      showAmll(true);
      if (amllShouldRun()) startAmll();

      // 旧渲染器的节点清掉，别在后台占 DOM
      lyricsBox.innerHTML = '';
      lines = [];
      activeLine = -1;
    });
  }

  function loadLyric(id) {
    var token = ++lyricToken;
    lyricsBox.innerHTML = '<p class="lyrics-hint">歌词加载中…</p>';
    lines = [];
    activeLine = -1;
    lastLyric = null;

    apiFetch(API + '/api/lyric?id=' + encodeURIComponent(id) + tk())
      .then(authGuard)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (token !== lyricToken) return;
        if (data.error) throw new Error(data.error);
        lastLyric = data;
        applyLyric();
      })
      .catch(function () {
        if (token !== lyricToken) return;
        lyricsBox.innerHTML = '<p class="lyrics-hint">歌词获取失败</p>';
      });
  }

  /* 歌词跟唱：只切「当前行」，不做逐字填充（网易云给不了逐字时间轴） */
  function syncLyrics() {
    if (!lines.length) return;

    var now = audio.currentTime + offsetMs() / 1000;
    var idx = -1;

    for (var i = 0; i < lines.length; i += 1) {
      if (lines[i].t <= now + 0.12) idx = i;
      else break;
    }

    if (idx === activeLine) return;

    var nodes = lyricsBox.querySelectorAll('.line');
    for (var j = 0; j < nodes.length; j += 1) {
      nodes[j].classList.toggle('is-active', j === idx);
    }

    if (idx >= 0 && nodes[idx]) {
      var box = lyricsBox;
      // 手机把当前行放在屏幕中上方（约 36% 高度），桌面居中
      var anchor = window.matchMedia('(max-width: 900px)').matches ? 0.36 : 0.5;
      box.scrollTo({
        top: nodes[idx].offsetTop - box.clientHeight * anchor + nodes[idx].offsetHeight / 2,
        behavior: 'smooth'
      });
    }

    activeLine = idx;
  }

  /* 点击歌词跳到对应时间 */
  lyricsBox.addEventListener('click', function (e) {
    var el = e.target.closest('.line');
    if (!el || currentId == null) return;

    var nodes = lyricsBox.querySelectorAll('.line');
    var idx = Array.prototype.indexOf.call(nodes, el);
    if (idx < 0 || !lines[idx]) return;

    if (!isFinite(audio.duration) || audio.duration <= 0) {
      toast('还没加载好，稍等一下');
      return;
    }

    // 减 80ms，让这一句刚好从起点开始唱
    audio.currentTime = Math.max(0, lines[idx].t - offsetMs() / 1000 - 0.08);
    if (audio.paused) audio.play().catch(function () {});
    activeLine = -1; // 强制 syncLyrics 重新定位
    syncLyrics();
  });

  /* ------------------------------------------------------------------ 播放 */
  /* ------------------------------------------------------- 随封面动态取色 */
  // 把封面画到小 canvas 上，取主色的色相/彩度（OKLCH），再按 MD3 的
  // tonal palette 生成 primary 系列。和 Material You 一个思路。
  var themeHue = null;
  var themeToken = 0;

  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function linearToSrgb(c) {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  function rgbToOklab(r, g, b) {
    var R = srgbToLinear(r);
    var G = srgbToLinear(g);
    var B = srgbToLinear(b);
    var l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    var m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    var s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    ];
  }

  function oklabToRgb(L, a, b) {
    var l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    var m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    var s_ = L - 0.0894841775 * a - 1.291485548 * b;
    var l = l_ * l_ * l_;
    var m = m_ * m_ * m_;
    var s = s_ * s_ * s_;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    ].map(linearToSrgb);
  }

  function inGamut(rgb) {
    return rgb.every(function (v) { return v >= -0.002 && v <= 1.002; });
  }

  function oklchToHex(L, C, H) {
    var rad = (H * Math.PI) / 180;
    var rgb = oklabToRgb(L, C * Math.cos(rad), C * Math.sin(rad));

    // 超出 sRGB 就二分降彩度，别让颜色被直接裁切
    if (!inGamut(rgb)) {
      var lo = 0;
      var hi = C;
      for (var i = 0; i < 18; i += 1) {
        var mid = (lo + hi) / 2;
        if (inGamut(oklabToRgb(L, mid * Math.cos(rad), mid * Math.sin(rad)))) lo = mid;
        else hi = mid;
      }
      rgb = oklabToRgb(L, lo * Math.cos(rad), lo * Math.sin(rad));
    }

    return (
      '#' +
      rgb
        .map(function (v) {
          var n = Math.round(Math.max(0, Math.min(1, v)) * 255);
          return (n < 16 ? '0' : '') + n.toString(16);
        })
        .join('')
    );
  }

  // CIE L* 的 0-100 档 → OKLab L
  function toneL(t) {
    return Math.pow(t / 100, 0.7385);
  }

  /** 从图片里取一个「有代表性」的色相 */
  function pickHue(img) {
    var S = 32;
    var canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;

    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, S, S);

    var data = ctx.getImageData(0, 0, S, S).data;
    var sx = 0;
    var sy = 0;
    var wsum = 0;
    var csum = 0;

    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;

      var lab = rgbToOklab(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
      var C = Math.hypot(lab[1], lab[2]);

      // 太黑、太白、接近灰的像素不参与取色
      if (lab[0] < 0.15 || lab[0] > 0.94) continue;
      if (C < 0.02) continue;

      var H = Math.atan2(lab[2], lab[1]);
      var w = Math.min(C, 0.22); // 彩度越高的像素越主导
      sx += Math.sin(H) * w;
      sy += Math.cos(H) * w;
      wsum += w;
      csum += C * w;
    }

    if (!wsum) return null;

    return {
      h: ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360,
      // 封面往往偏灰，提一档彩度并夹在合理区间；下限别太低，
      // 否则暗色主题下算出来的 primary 会接近白色，看着像「没生效」
      c: Math.max(0.065, Math.min(0.16, (csum / wsum) * 1.45))
    };
  }

  // 这些变量会被写到 <html> 上；重置时按同一份清单清掉
  var PALETTE_KEYS = [
    '--primary',
    '--on-primary',
    '--primary-container',
    '--on-primary-container',
    '--surface',
    '--surface-1',
    '--surface-2',
    '--surface-3',
    '--on-surface',
    '--on-surface-2',
    '--outline'
  ];

  function coverPalette(hue, dark) {
    var H = hue.h;
    var C = hue.c;

    // 中性色只带一点点封面色相，这样整页会「偏向」封面但不会变得花
    var N = Math.min(0.02, Math.max(0.005, C * 0.14));

    var accent = function (tone, scale) {
      return oklchToHex(toneL(tone), C * scale, H);
    };
    var neutral = function (tone) {
      return oklchToHex(toneL(tone), N, H);
    };

    if (dark) {
      return {
        '--primary': accent(78, 1),
        '--on-primary': accent(20, 0.7),
        '--primary-container': accent(32, 1),
        '--on-primary-container': accent(92, 1),

        // 深色不用纯黑：tone 10~20 才有"深色"的层次感，tone 6 出来接近 #090507
        '--surface': neutral(13),
        '--surface-1': neutral(16),
        '--surface-2': neutral(19),
        '--surface-3': neutral(22),
        '--on-surface': neutral(93),
        '--on-surface-2': neutral(76),
        '--outline': neutral(38)
      };
    }

    return {
      '--primary': accent(40, 1),
      '--on-primary': '#FFFFFF',
      '--primary-container': accent(90, 1),
      '--on-primary-container': accent(10, 1),

      '--surface': neutral(97),
      '--surface-1': neutral(95),
      '--surface-2': neutral(92),
      '--surface-3': neutral(89),
      '--on-surface': neutral(13),
      '--on-surface-2': neutral(42),
      '--outline': neutral(80)
    };
  }

  /** 种子色（用户自选）→ {h, c}，和封面取色走同一套色板生成 */
  function hexToHue(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return null;
    var n = parseInt(m[1], 16);
    var lab = rgbToOklab(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    var C = Math.hypot(lab[1], lab[2]);
    var H = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
    // 彩度夹一下：太低会接近灰，太高在暗色下会刺眼
    return { h: (H + 360) % 360, c: Math.max(0.07, Math.min(0.16, C)) };
  }

  /** 该用哪个色相：自定义种子色 > 背景图 > 封面 */
  function activeHue() {
    if (settings.seedMode === 'custom' && settings.seed) return hexToHue(settings.seed);
    if (settings.seedMode === 'bg' && bgHue) return bgHue;
    return themeHue;
  }

  function paintTheme() {
    var root = document.documentElement;
    var hue = activeHue();

    if (!hue) {
      PALETTE_KEYS.forEach(function (k) { root.style.removeProperty(k); });
    } else {
      var vars = coverPalette(hue, root.getAttribute('data-scheme') === 'dark');
      PALETTE_KEYS.forEach(function (k) { root.style.setProperty(k, vars[k]); });
    }

    paintStageTheme();
  }

  /**
   * 大屏内一律深色：把深色色板挂到 .stage 自己身上，
   * 退出大屏时整页仍然是用户选的那套深浅色（自定义属性会继承，作用域天然隔离）。
   */
  function paintStageTheme() {
    if (!stage) return;
    var hue = activeHue();
    if (!hue) {
      PALETTE_KEYS.forEach(function (k) { stage.style.removeProperty(k); });
      return;
    }
    var vars = coverPalette(hue, true);
    PALETTE_KEYS.forEach(function (k) { stage.style.setProperty(k, vars[k]); });
  }

  function applyCoverTheme(song) {
    var token = ++themeToken;

    if (!song || !song.cover) {
      themeHue = null;
      paintTheme();
      return;
    }

    var img = new Image();
    img.crossOrigin = 'anonymous'; // 封面 CDN 返回 ACAO: *，canvas 才读得到像素

    img.onload = function () {
      if (token !== themeToken) return;
      try {
        var hue = pickHue(img);
        if (!hue) {
          themeHue = null;
          paintTheme();
          return;
        }
        themeHue = hue;
        paintTheme();
      } catch (e) {
        // canvas 被污染或图片异常，退回默认配色
        themeHue = null;
        paintTheme();
      }
    };

    img.onerror = function () {
      if (token === themeToken) {
        themeHue = null;
        paintTheme();
      }
    };

    img.src = song.cover;
  }

  function paint(song) {
    pTitle.textContent = song.name || '未知曲目';
    pArtist.textContent = (song.artists || '') + (song.album ? ' · ' + song.album : '');
    $('p-id').textContent = 'ID ' + song.id;

    pCover.src = song.cover || '';
    pCover.style.visibility = song.cover ? 'visible' : 'hidden';

    sCover.src = song.cover || '';
    sTitle.textContent = song.name || '未知曲目';
    sArtist.textContent = song.artists || '';
    $('s-id').textContent = 'ID ' + song.id;

    // 大屏背景：拿封面做个高斯模糊铺底
    if (stageBg) {
      if (song.cover) {
        stageBg.style.backgroundImage = 'url("' + song.cover + '")';
        stageBg.classList.add('is-on');
      } else {
        stageBg.style.backgroundImage = '';
        stageBg.classList.remove('is-on');
      }
    }

    player.hidden = false;

    // 按当前封面重算主题色
    applyCoverTheme(song);

    highlightRows();
  }

  /**
   * 取播放直链再交给 <audio>。
   * Worker /api/url 现在回 JSON：直链一旦拿到，后续的分段/拖动就都由浏览器
   * 直接跟网易云 CDN 谈，不再每次都穿过 Worker。
   */
  function startTrack(song, autoplay) {
    var token = ++trackToken;

    apiFetch(API + '/api/url?id=' + encodeURIComponent(song.id) + tk())
      .then(authGuard)
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok || !d.url) throw new Error(d.error || 'HTTP ' + r.status);
          return d.url;
        });
      })
      .then(function (u) {
        if (token !== trackToken) return; // 已经切到别的歌了
        audio.src = u;
        audio.load();
        if (autoplay) audio.play().catch(function () {});
      })
      .catch(function (e) {
        if (token !== trackToken) return;
        if (e.message === '需要登录') return; // 登录页已经弹出来了
        toast('播放失败：' + e.message);
      });
  }

  function play(i) {
    var song = songs[i];
    if (!song) return;

    // 换了一条队列就清空随机播放的历史
    if (shuffleQueue !== songs) {
      shuffleQueue = songs;
      shuffleHistory.length = 0;
    }

    if (mode === 'shuffle') {
      if (shuffleHistory[shuffleHistory.length - 1] !== i) shuffleHistory.push(i);
      if (shuffleHistory.length > 100) shuffleHistory.shift();
    }

    current = i;
    currentId = song.id;
    nowPlaying = song;
    paint(song);

    startTrack(song, true);

    seek.value = '0';
    sSeek.value = '0';
    fill(seek, 0);
    fill(sSeek, 0);
    tCur.textContent = '00:00';
    sCur.textContent = '00:00';
    tDur.textContent = song.duration ? fmt(song.duration / 1000) : '00:00';
    sDur.textContent = tDur.textContent;

    // 大屏底部小播放条的存在感：确保角色类跟着走
    document.body.classList.add('is-audio-playing');

    loadLyric(song.id);
  }

  function toggle() {
    // 判断「有没有在放」必须看 id，不能看下标：
    // 换一次搜索结果，同一个下标就指向另一首歌了
    if (currentId == null) {
      if (songs.length) play(0);
      return;
    }
    if (audio.paused) audio.play().catch(function () {});
    else audio.pause();
  }

  function indexOfCurrent() {
    if (currentId == null) return -1;
    for (var i = 0; i < songs.length; i += 1) {
      if (songs[i].id === currentId) return i;
    }
    return -1;
  }

  function step(dir) {
    if (!songs.length) return;
    var idx = indexOfCurrent();

    // 随机模式：前进随机挑一首，后退回上一条历史
    if (mode === 'shuffle' && songs.length > 1) {
      if (dir < 0 && shuffleHistory.length > 1) {
        shuffleHistory.pop(); // 先弹掉当前这首
        var back = shuffleHistory[shuffleHistory.length - 1];
        if (back != null && songs[back]) {
          play(back);
          return;
        }
      }

      var pick = idx;
      for (var guard = 0; guard < 20 && pick === idx; guard += 1) {
        pick = Math.floor(Math.random() * songs.length);
      }
      if (pick === idx) pick = (idx + 1) % songs.length;
      play(pick);
      return;
    }

    var next = idx < 0 ? 0 : (idx + dir + songs.length) % songs.length;
    play(next);
  }

  /* ------------------------------------------------------------------ 大屏 */
  function openStage() {
    // 不能看 current 下标：换过一次搜索结果，正在播的那首不在新列表里，
    // current 就会被对齐成 -1。真正的依据是 nowPlaying。
    if (!nowPlaying) {
      toast('先选一首歌');
      return;
    }
    stage.hidden = false;
    stage.classList.add('is-dark'); // 大屏内一律深色，退出后整页恢复
    paintStageTheme();
    requestAnimationFrame(function () { stage.classList.add('is-open'); });
    app.classList.add('is-stage');
    setStageView('main');
    if (amll.player) {
      amll.player.setAlignPosition(mobileLayout() ? 0.38 : 0.5);
      amll.player.setCurrentTime(lyricMs(), true);
      if (amllShouldRun()) startAmll();
    }
    syncLyrics();
  }

  function closeStage() {
    stopAmll();
    stageView = 'main';
    stage.setAttribute('data-view', 'main');
    stage.classList.remove('is-open');
    app.classList.remove('is-stage');
    setTimeout(function () {
      if (!stage.classList.contains('is-open')) {
        stage.hidden = true;
        stage.classList.remove('is-dark');
        PALETTE_KEYS.forEach(function (k) { stage.style.removeProperty(k); });
      }
    }, 260);
  }

  /* ---------------------------------------------- 大屏视图：封面页 / 歌词页 */
  var stageView = 'main';

  /** 手机先看封面，点「歌词」才进歌词页；桌面一直显示歌词 */
  function amllShouldRun() {
    if (stage.hidden) return false;
    if (!mobileLayout()) return true;
    return stageView === 'lyrics';
  }

  function setStageView(view) {
    stageView = view === 'lyrics' ? 'lyrics' : 'main';
    stage.setAttribute('data-view', stageView);

    // 底部功能区那个「歌词」按钮同时是切换开关
    var lyrBtn = $('s-lyrics');
    if (lyrBtn) {
      lyrBtn.classList.toggle('is-on', stageView === 'lyrics');
      lyrBtn.setAttribute('aria-pressed', stageView === 'lyrics' ? 'true' : 'false');
    }

    if (amll.player) {
      // 歌词页把当前行提到屏幕中上方，封面页不用管
      amll.player.setAlignPosition(mobileLayout() ? (stageView === 'lyrics' ? 0.19 : 0.38) : 0.5);
    }

    if (amllShouldRun()) {
      if (amll.player) {
        amll.player.setCurrentTime(lyricMs(), true);
        startAmll();
      }
    } else {
      stopAmll();
    }
  }


  /* ------------------------------------------------------------ 播放列表 */
  var queuePop = $('queue-pop');
  var queueAnchor = null;
  var queueList = $('queue-list');
  var queueHint = $('queue-hint');
  var queueDrag = null;
  var queueJustDragged = false;

  function renderQueue() {
    queueList.innerHTML = '';

    if (!songs.length) {
      var empty = document.createElement('li');
      empty.className = 'queue-empty';
      empty.textContent = '还没有播放队列，先点一首歌';
      queueList.appendChild(empty);
      queueHint.hidden = true;
      return;
    }

    queueHint.hidden = false;

    songs.forEach(function (song, i) {
      var li = document.createElement('li');
      li.className = 'queue-row' + (song.id === currentId ? ' is-current' : '');
      li.setAttribute('data-i', String(i));

      var no = document.createElement('span');
      no.className = 'q-no';
      no.textContent = String(i + 1);

      var main = document.createElement('span');
      main.className = 'q-main';
      var t1 = document.createElement('span');
      t1.className = 'q-title';
      t1.textContent = song.name || '';
      var t2 = document.createElement('span');
      t2.className = 'q-artist';
      t2.textContent = song.artists || '未知艺人';
      main.appendChild(t1);
      main.appendChild(t2);

      var grip = document.createElement('span');
      grip.className = 'q-grip';
      grip.setAttribute('aria-hidden', 'true');
      grip.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16v2H4zm0 4h16v2H4zm0 4h16v2H4z"/></svg>';

      li.appendChild(no);
      li.appendChild(main);
      li.appendChild(grip);
      queueList.appendChild(li);
    });
  }

  function renumberQueue() {
    var rows = queueList.querySelectorAll('.queue-row');
    for (var i = 0; i < rows.length; i += 1) {
      rows[i].setAttribute('data-i', String(i));
      var no = rows[i].querySelector('.q-no');
      if (no) no.textContent = String(i + 1);
      rows[i].classList.toggle('is-current', !!(songs[i] && songs[i].id === currentId));
    }
  }

  /** 把 from 挪到 to：数组和 DOM 一起动，当前播放的下标按 id 重新对上 */
  function moveQueueItem(from, to) {
    if (from === to || from < 0 || to < 0 || from >= songs.length || to >= songs.length) return;

    var moved = songs.splice(from, 1)[0];
    songs.splice(to, 0, moved);
    current = indexOfCurrent();

    var rows = queueList.querySelectorAll('.queue-row');
    var row = rows[from];
    if (row && rows[to]) {
      if (from < to) rows[to].after(row);
      else rows[to].before(row);
    }
    renumberQueue();

    // 随机播放记的是下标，挪完就作废
    shuffleQueue = songs;
    shuffleHistory.length = 0;
  }

  function closeQueue() {
    queuePop.hidden = true;
    queueAnchor = null;
  }

  /** 锚定式弹出：贴在触发按钮上方，放不下就翻到下方，左右夹在视口里 */
  function openQueue(anchor) {
    var btn = anchor || $('queue-btn');
    if (!queuePop.hidden && queueAnchor === btn) {
      closeQueue();
      return;
    }

    renderQueue();
    queueAnchor = btn;
    queuePop.hidden = false;

    var r = btn.getBoundingClientRect();
    var box = queuePop.getBoundingClientRect();
    var gap = 10;

    var left = Math.min(Math.max(10, r.right - box.width), window.innerWidth - box.width - 10);
    var top = r.top - box.height - gap;
    if (top < 10) top = r.bottom + gap;

    queuePop.style.left = Math.round(left) + 'px';
    queuePop.style.top = Math.round(top) + 'px';
  }

  $('queue-close').addEventListener('click', closeQueue);

  document.addEventListener('pointerdown', function (e) {
    if (queuePop.hidden) return;
    if (queuePop.contains(e.target)) return;
    if (queueAnchor && queueAnchor.contains(e.target)) return;
    closeQueue();
  });

  window.addEventListener('resize', function () {
    if (!queuePop.hidden) closeQueue();
  });

  queuePop.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

  // 只有把手能拖：列表本身还要能上下滚
  queueList.addEventListener('pointerdown', function (e) {
    var grip = e.target.closest('.q-grip');
    if (!grip || (e.button != null && e.button > 0)) return;
    var row = grip.closest('.queue-row');
    if (!row) return;

    queueDrag = { row: row, y: e.clientY };
    row.classList.add('is-drag');
    if (row.setPointerCapture) {
      try { row.setPointerCapture(e.pointerId); } catch (err) {}
    }
    e.preventDefault();
  });

  queueList.addEventListener('pointermove', function (e) {
    if (!queueDrag) return;
    var under = document.elementFromPoint(e.clientX, e.clientY);
    var over = under && under.closest ? under.closest('.queue-row') : null;
    if (!over || over === queueDrag.row) return;

    var rows = Array.prototype.slice.call(queueList.querySelectorAll('.queue-row'));
    moveQueueItem(rows.indexOf(queueDrag.row), rows.indexOf(over));
  });

  function endQueueDrag() {
    if (!queueDrag) return;
    queueDrag.row.classList.remove('is-drag');
    queueDrag = null;
    queueJustDragged = true;
    setTimeout(function () { queueJustDragged = false; }, 260);
  }
  queueList.addEventListener('pointerup', endQueueDrag);
  queueList.addEventListener('pointercancel', endQueueDrag);

  queueList.addEventListener('click', function (e) {
    if (queueJustDragged) return;
    var row = e.target.closest('.queue-row');
    if (!row) return;
    var i = Number(row.getAttribute('data-i'));
    if (!songs[i]) return;
    play(i);
    renderQueue();
    closeQueue();
  });

  /* ------------------------------------------------------------------ 事件 */
  // 不自动搜索：打字过程中不发请求，只有回车或点「搜索」按钮才发。
  // 每次搜索都要打网易云接口，随打随搜很容易把这台出口 IP 打上限流。
  function runSearch() {
    if (goBtn.disabled) return;
    input.blur();
    // 搜索结果在「搜索」视图里，先把视图切过去再发请求
    if (location.hash !== '#/search') go('#/search');
    search(input.value);
  }

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });

  goBtn.addEventListener('click', runSearch);

  input.addEventListener('input', function () {
    clearBtn.hidden = !input.value;
    // 清空输入框只退回初始状态，不发请求
    if (!input.value.trim()) setSearching(false);
  });

  clearBtn.addEventListener('click', function () {
    input.value = '';
    clearBtn.hidden = true;
    setSearching(false);
    input.focus();
  });

  // 列表行统一在 document 上代理：搜索结果 / 歌单 / 首页新歌共用一套行为
  document.addEventListener('click', function (e) {
    var addBtn = e.target.closest('.row-add');
    if (addBtn) {
      e.preventDefault();
      e.stopPropagation();
      openAddDialog(addBtn.closest('.row'));
      return;
    }

    var row = e.target.closest('.row');
    if (!row) return;

    var q = row.getAttribute('data-q') || 'search';
    var i = Number(row.getAttribute('data-i'));
    var arr = queues[q] || [];
    var song = arr[i];
    if (!song) return;

    songs = arr;      // 点哪张列表，哪张就是当前队列
    activeQueue = q;
    if (song.id === currentId) toggle();
    else play(i);
  });

  // div 行没有原生键盘行为，补一下
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var row = document.activeElement && document.activeElement.closest && document.activeElement.closest('.row');
    if (!row) return;
    e.preventDefault();
    row.click();
  });

  $('play').addEventListener('click', toggle);
  $('prev').addEventListener('click', function () { step(-1); });
  $('next').addEventListener('click', function () { step(1); });
  $('s-play').addEventListener('click', toggle);
  $('s-prev').addEventListener('click', function () { step(-1); });
  $('s-next').addEventListener('click', function () { step(1); });

  $('open-stage').addEventListener('click', openStage);
  $('stage-close').addEventListener('click', closeStage);
  $('s-lyrics').addEventListener('click', function () {
    // 再点一次退出歌词页（封面页 ↔ 歌词页）
    setStageView(stageView === 'lyrics' ? 'main' : 'lyrics');
  });
  $('s-dl2').addEventListener('click', downloadCurrent);
  $('s-queue').addEventListener('click', function () { openQueue(this); });
  $('queue-btn').addEventListener('click', function () { openQueue(this); });

  audio.addEventListener('play', function () {
    document.body.classList.add('is-audio-playing');
    syncAmllPlayState();
  });

  audio.addEventListener('pause', function () {
    document.body.classList.remove('is-audio-playing');
    syncAmllPlayState();
  });

  // 拖动/点歌词跳转后立刻对齐，别等下一帧
  audio.addEventListener('seeked', function () {
    if (amll.player) amll.player.setCurrentTime(lyricMs(), true);
  });

  audio.addEventListener('loadedmetadata', function () {
    if (!isFinite(audio.duration)) return;
    var d = fmt(audio.duration);
    tDur.textContent = d;
    sDur.textContent = d;
  });

  audio.addEventListener('timeupdate', function () {
    if (seeking) return;

    var cur = fmt(audio.currentTime);
    tCur.textContent = cur;
    sCur.textContent = cur;

    if (audio.duration) {
      var ratio = audio.currentTime / audio.duration;
      seek.value = String(Math.round(ratio * 1000));
      sSeek.value = seek.value;
      fill(seek, ratio);
      fill(sSeek, ratio);
    }

    syncLyrics();
  });

  audio.addEventListener('ended', function () {
    if (mode === 'one') {
      audio.currentTime = 0;
      audio.play().catch(function () {});
      return;
    }

    // 随机播放：一直往下随机，不因为到了最后一首就停
    if (mode === 'shuffle') {
      step(1);
      return;
    }

    // 顺序播放：放到最后一首就停，不绕回开头
    var idx = indexOfCurrent();
    if (idx < 0 || idx >= songs.length - 1) return;
    step(1);
  });

  audio.addEventListener('error', function () {
    if (currentId == null) return;
    toast('这首放不了：可能是 VIP、版权受限或已下架');
  });

  function bindSeek(el) {
    el.addEventListener('input', function () {
      seeking = true;
      if (audio.duration) {
        var r = Number(el.value) / 1000;
        tCur.textContent = fmt(r * audio.duration);
        sCur.textContent = tCur.textContent;
        fill(seek, r);
        fill(sSeek, r);
      }
    });
    el.addEventListener('change', function () {
      if (audio.duration) audio.currentTime = (Number(el.value) / 1000) * audio.duration;
      seeking = false;
    });
  }

  bindSeek(seek);
  bindSeek(sSeek);

  vol.addEventListener('input', function () {
    audio.volume = Number(vol.value) / 100;
    fill(vol, Number(vol.value) / 100);
  });

  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    if (e.key === 'Escape') {
      // 弹出菜单 → 歌词页 → 封面页，逐层退
      if (queuePop && !queuePop.hidden) closeQueue();
      else if (stageView === 'lyrics') setStageView('main');
      else closeStage();
    }
    else if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight' && e.altKey) step(1);
    else if (e.key === 'ArrowLeft' && e.altKey) step(-1);
  });

  /* ---------------------------------------------------------------- 下载 */
  // 音频 CDN 带 ACAO: *，所以可以直接在浏览器里 fetch 成 Blob 再触发下载，
  // 不用让 Worker 转发字节（那样会白白吃流量）。
  var downloading = false;

  function safeName(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|\r\n]+/g, '_')
      .trim()
      .slice(0, 80);
  }

  function downloadCurrent() {
    // 用 nowPlaying 而不是 songs[indexOfCurrent()]：
    // 清空搜索会把 songs 清空，但当前这首还在放，照样该能下载
    var song = nowPlaying;
    if (!song) {
      toast('先选一首歌再下载');
      return;
    }
    if (downloading) {
      toast('正在下载中，稍等');
      return;
    }

    downloading = true;
    toast('正在准备下载…');

    apiFetch(API + '/api/url?id=' + encodeURIComponent(song.id) + tk())
      .then(authGuard)
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok || !d.url) throw new Error(d.error || 'HTTP ' + r.status);
          return d.url;
        });
      })
      .then(function (u) { return fetch(u); })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var ct = r.headers.get('content-type') || '';
        if (ct.indexOf('audio') === -1) throw new Error('拿到的不是音频（可能无版权）');
        return r.blob();
      })
      .then(function (blob) {
        var name = safeName((song.artists ? song.artists + ' - ' : '') + (song.name || '未命名')) + '.mp3';
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        toast('已开始下载：' + name);
      })
      .catch(function (e) {
        toast('下载失败：' + e.message);
      })
      .then(function () { downloading = false; });
  }

  [$('dl'), $('s-dl')].forEach(function (b) {
    if (b) b.addEventListener('click', downloadCurrent);
  });

  /* 播放模式：order（顺序）/ one（单曲循环）/ shuffle（随机） */
  var MODES = ['order', 'one', 'shuffle'];
  var MODE_LABEL = { order: '顺序播放', one: '单曲循环', shuffle: '随机播放' };

  var mode = 'order';
  try {
    var savedMode = localStorage.getItem('music-mode');
    if (MODES.indexOf(savedMode) >= 0) mode = savedMode;
  } catch (e) { /* 隐私模式 */ }

  // 随机模式下的播放历史：用来实现「上一首」
  var shuffleHistory = [];
  var shuffleQueue = null;

  var modeBtns = [$('mode'), $('s-mode'), $('s-mode2')].filter(Boolean);

  function applyMode() {
    modeBtns.forEach(function (b) {
      b.setAttribute('data-mode', mode);
      b.setAttribute('aria-label', MODE_LABEL[mode]);
      b.setAttribute('title', MODE_LABEL[mode]);
    });
  }

  function toggleMode() {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    try { localStorage.setItem('music-mode', mode); } catch (e) {}
    applyMode();
    toast(MODE_LABEL[mode]);
  }

  modeBtns.forEach(function (b) {
    b.addEventListener('click', toggleMode);
  });

  /* ------------------------------------------------------------------ 设置 */
  // 全部存在浏览器里：{ scheme: auto|light|dark, seed: '' | '#rrggbb', lyricScale, trans }
  var SETTINGS_KEY = 'music-settings';
  var darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

  function loadSettings() {
    var out = {
      scheme: 'auto', seed: '', seedMode: 'cover',
      bgMode: 'none', bgData: '', bgUrl: '', bgBlur: 10,
      lyricScale: 1, trans: true, amll: true, bold: false, debug: false, offset: 0
    };
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var o = JSON.parse(raw) || {};
        if (o.scheme === 'auto' || o.scheme === 'light' || o.scheme === 'dark') out.scheme = o.scheme;
        if (typeof o.seed === 'string' && /^#[0-9a-f]{6}$/i.test(o.seed)) out.seed = o.seed;
        if (o.seedMode === 'cover' || o.seedMode === 'bg' || o.seedMode === 'custom') out.seedMode = o.seedMode;
        else if (out.seed) out.seedMode = 'custom';
        if (o.bgMode === 'none' || o.bgMode === 'local' || o.bgMode === 'url') out.bgMode = o.bgMode;
        if (typeof o.bgData === 'string' && /^data:image\//.test(o.bgData)) out.bgData = o.bgData;
        if (typeof o.bgUrl === 'string' && /^https?:\/\//.test(o.bgUrl)) out.bgUrl = o.bgUrl;
        if (typeof o.bgBlur === 'number' && o.bgBlur >= 0 && o.bgBlur <= 40) out.bgBlur = o.bgBlur;
        if (typeof o.lyricScale === 'number' && o.lyricScale >= 0.8 && o.lyricScale <= 1.5) {
          out.lyricScale = o.lyricScale;
        }
        if (typeof o.trans === 'boolean') out.trans = o.trans;
        if (typeof o.amll === 'boolean') out.amll = o.amll;
        if (typeof o.bold === 'boolean') out.bold = o.bold;
        if (typeof o.debug === 'boolean') out.debug = o.debug;
        if (typeof o.offset === 'number' && Math.abs(o.offset) <= 2000) out.offset = o.offset;
      } else {
        // 迁移旧版单独存的深浅色
        var old = localStorage.getItem('music-scheme');
        if (old === 'light' || old === 'dark') out.scheme = old;
      }
    } catch (e) { /* 隐私模式 */ }
    return out;
  }

  var settings = loadSettings();

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  /** auto 时跟着设备走；页面开着改系统主题也会实时跟 */
  function applyScheme() {
    var next = settings.scheme === 'auto' ? (darkMedia.matches ? 'dark' : 'light') : settings.scheme;
    document.documentElement.setAttribute('data-scheme', next);
    paintTheme(); // 同一色相要按新的明暗重新算一遍色阶
  }

  function applySettings() {
    document.documentElement.style.setProperty('--lyric-scale', String(settings.lyricScale));
    stage.setAttribute('data-trans', settings.trans ? '1' : '0');
    stage.setAttribute('data-bold', settings.bold ? '1' : '0');
    document.body.classList.toggle('is-debug', settings.debug === true);
    applyBackground();
    applyScheme();
    syncSettingsUI();
  }

  var settingsDlg = $('settings');
  var segScheme = $('seg-scheme');
  var seedFollow = $('seed-follow');
  var seedBg = $('seed-bg');
  var seedColor = $('seed-color');
  var segBg = $('seg-bg');
  var bgLocalRow = $('bg-local-row');
  var bgUrlRow = $('bg-url-row');
  var bgBlurRow = $('bg-blur-row');
  var bgNote = $('bg-note');
  var bgFile = $('bg-file');
  var bgLink = $('bg-link');
  var bgBlur = $('bg-blur');
  var bgBlurVal = $('bg-blur-val');
  var bgEl = $('site-bg');
  var bgHue = null;
  var setTrans = $('set-trans');
  var setAmll = $('set-amll');
  var setBold = $('set-bold');
  var setDebug = $('set-debug');
  var setOffset = $('set-offset');
  var setOffsetVal = $('set-offset-val');
  var setSize = $('set-size');
  var setSizeVal = $('set-size-val');

  function syncSettingsUI() {
    var btns = segScheme.querySelectorAll('button');
    for (var i = 0; i < btns.length; i += 1) {
      btns[i].setAttribute('aria-checked', btns[i].getAttribute('data-v') === settings.scheme ? 'true' : 'false');
    }

    seedFollow.setAttribute('aria-pressed', settings.seedMode === 'cover' ? 'true' : 'false');
    seedBg.setAttribute('aria-pressed', settings.seedMode === 'bg' ? 'true' : 'false');
    seedBg.disabled = !bgSource();

    var bgBtns = segBg.querySelectorAll('button');
    for (var j = 0; j < bgBtns.length; j += 1) {
      bgBtns[j].setAttribute('aria-checked', bgBtns[j].getAttribute('data-v') === settings.bgMode ? 'true' : 'false');
    }
    bgLocalRow.hidden = settings.bgMode !== 'local';
    bgUrlRow.hidden = settings.bgMode !== 'url';
    bgBlurRow.hidden = settings.bgMode === 'none';
    bgNote.hidden = settings.bgMode === 'none';
    if (settings.bgMode === 'url') bgLink.value = settings.bgUrl || '';
    bgBlur.value = String(settings.bgBlur || 0);
    bgBlurVal.textContent = (settings.bgBlur || 0) + 'px';

    // 色板预览：自定义色就显示它，否则按当前取色来源算一个
    var hue = activeHue();
    var preview = settings.seedMode === 'custom' && settings.seed
      ? settings.seed
      : (hue ? oklchToHex(toneL(55), hue.c, hue.h) : '#8B5643');
    document.documentElement.style.setProperty('--seed-preview', preview);

    setTrans.checked = settings.trans;
    setAmll.checked = settings.amll !== false;
    setBold.checked = settings.bold === true;
    setDebug.checked = settings.debug === true;
    setOffset.value = String(settings.offset || 0);
    setOffsetVal.textContent = (settings.offset > 0 ? '+' : '') + (settings.offset || 0) + 'ms';
    setSize.value = String(settings.lyricScale);
    setSizeVal.textContent = Math.round(settings.lyricScale * 100) + '%';
  }

  function openSettings() {
    syncSettingsUI();
    if (settingsDlg.open) return;
    if (typeof settingsDlg.showModal === 'function') settingsDlg.showModal();
    else settingsDlg.setAttribute('open', '');
  }

  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', function () { settingsDlg.close(); });

  // 点对话框外面的遮罩也能关；MD3 的习惯
  settingsDlg.addEventListener('click', function (e) {
    if (e.target === settingsDlg) settingsDlg.close();
  });

  segScheme.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    settings.scheme = b.getAttribute('data-v');
    saveSettings();
    applyScheme();
    syncSettingsUI();
  });

  seedFollow.addEventListener('click', function () {
    settings.seedMode = 'cover';
    settings.seed = '';
    saveSettings();
    paintTheme();
    syncSettingsUI();
  });

  seedBg.addEventListener('click', function () {
    if (!bgSource()) {
      toast('先选一张背景图');
      return;
    }
    settings.seedMode = 'bg';
    saveSettings();
    paintTheme();
    syncSettingsUI();
  });

  seedColor.addEventListener('input', function () {
    settings.seed = seedColor.value;
    settings.seedMode = 'custom';
    saveSettings();
    paintTheme();
    syncSettingsUI();
  });

  /* ------------------------------------------------------- 背景图逻辑 */
  function bgSource() {
    if (settings.bgMode === 'local') return settings.bgData || '';
    if (settings.bgMode === 'url') return settings.bgUrl || '';
    return '';
  }

  function applyBackground() {
    var url = bgSource();
    if (!url) {
      bgEl.style.backgroundImage = '';
      bgEl.classList.remove('is-on');
      bgHue = null;
      if (settings.seedMode === 'bg') paintTheme();
      return;
    }
    bgEl.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
    bgEl.style.setProperty('--bg-blur', (settings.bgBlur || 0) + 'px');
    bgEl.classList.add('is-on');
    loadBgHue(url);
  }

  function loadBgHue(url) {
    var img = new Image();
    if (/^https?:/i.test(url)) img.crossOrigin = 'anonymous'; // 跨域图要 CORS 才读得到像素
    var token = ++themeToken;
    img.onload = function () {
      if (token !== themeToken) return;
      try {
        bgHue = pickHue(img) || null;
      } catch (e) {
        bgHue = null;
      }
      if (settings.seedMode === 'bg') paintTheme();
      syncSettingsUI();
    };
    img.onerror = function () {
      bgHue = null;
      if (settings.seedMode === 'bg') paintTheme();
    };
    img.src = url;
  }

  /** 本地图片压到最长边 1600、JPEG 0.72，避免撑爆 localStorage */
  function readBgFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 1600;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        try {
          settings.bgData = canvas.toDataURL('image/jpeg', 0.72);
        } catch (e) {
          toast('这张图处理失败');
          return;
        }
        settings.bgMode = 'local';
        saveSettings();
        applyBackground();
        syncSettingsUI();
        toast('背景已更新');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  segBg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var v = b.getAttribute('data-v');
    settings.bgMode = v;
    saveSettings();
    applyBackground();
    syncSettingsUI();
    if (v === 'local' && !settings.bgData) bgFile.click();
    if (v === 'url' && !settings.bgUrl) bgLink.focus();
  });

  $('bg-pick').addEventListener('click', function () { bgFile.click(); });

  bgFile.addEventListener('change', function () {
    if (bgFile.files && bgFile.files[0]) readBgFile(bgFile.files[0]);
    bgFile.value = '';
  });

  $('bg-apply').addEventListener('click', function () {
    var u = (bgLink.value || '').trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u) && !/^data:image\//i.test(u)) {
      toast('地址要以 http(s):// 开头');
      return;
    }
    var test = new Image();
    test.onload = function () {
      settings.bgUrl = u;
      settings.bgMode = 'url';
      saveSettings();
      applyBackground();
      syncSettingsUI();
      toast('背景已更新');
    };
    test.onerror = function () { toast('这张图加载失败'); };
    test.src = u;
  });

  bgBlur.addEventListener('input', function () {
    settings.bgBlur = Number(bgBlur.value);
    bgBlurVal.textContent = settings.bgBlur + 'px';
    bgEl.style.setProperty('--bg-blur', settings.bgBlur + 'px');
    saveSettings();
  });

  setTrans.addEventListener('change', function () {
    settings.trans = setTrans.checked;
    stage.setAttribute('data-trans', settings.trans ? '1' : '0');
    saveSettings();
    // AMLL 的翻译是塞进 LyricLine.translatedLyric 的，开关一变必须重建歌词
    if (amll.player) applyLyric();
  });

  setOffset.addEventListener('input', function () {
    settings.offset = Number(setOffset.value);
    setOffsetVal.textContent = (settings.offset > 0 ? '+' : '') + settings.offset + 'ms';
    saveSettings();

    // 立刻按新偏移对齐，不用等下一次 timeupdate
    if (amll.player) amll.player.setCurrentTime(lyricMs(), true);
    syncLyrics();
  });

  setBold.addEventListener('change', function () {
    settings.bold = setBold.checked;
    stage.setAttribute('data-bold', settings.bold ? '1' : '0');
    saveSettings();
  });

  setDebug.addEventListener('change', function () {
    settings.debug = setDebug.checked;
    document.body.classList.toggle('is-debug', settings.debug === true);
    saveSettings();
    // 重新灌一遍歌词，把「逐字 / 整行」标出来
    if (lastLyric) applyLyric();
  });

  setAmll.addEventListener('change', function () {
    settings.amll = setAmll.checked;
    saveSettings();
    applyLyric();
  });

  setSize.addEventListener('input', function () {
    settings.lyricScale = Number(setSize.value);
    document.documentElement.style.setProperty('--lyric-scale', String(settings.lyricScale));
    setSizeVal.textContent = Math.round(settings.lyricScale * 100) + '%';
    saveSettings();
  });

  function followDevice() {
    if (settings.scheme !== 'auto') return; // 手动选过就不再插手
    applyScheme();
  }

  if (darkMedia.addEventListener) darkMedia.addEventListener('change', followDevice);
  else if (darkMedia.addListener) darkMedia.addListener(followDevice);

  /* ------------------------------------------------------------------ 歌单库 */
  // 全部存在浏览器里：导入的网易云歌单 + 本地自建歌单
  var LIB_KEY = 'music-library';
  var lib = loadLib();
  var currentPlaylist = null;
  var pendingSong = null;
  var newPendingSong = null;

  function loadLib() {
    try {
      var o = JSON.parse(localStorage.getItem(LIB_KEY) || 'null');
      if (o && Array.isArray(o.playlists)) return o;
    } catch (e) { /* 隐私模式 */ }
    return { playlists: [] };
  }

  function saveLib() {
    try {
      localStorage.setItem(LIB_KEY, JSON.stringify(lib));
      return true;
    } catch (e) {
      toast('浏览器本地存满了，删几个歌单再试');
      return false;
    }
  }

  function findPlaylist(id) {
    for (var i = 0; i < lib.playlists.length; i += 1) {
      if (lib.playlists[i].id === id) return lib.playlists[i];
    }
    return null;
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }

  var sidebar = $('sidebar');
  var sideLists = $('side-lists');
  var sideEmpty = $('side-empty');
  var mainEl = $('main');

  function renderSidebar() {
    sideLists.innerHTML = '';
    lib.playlists.forEach(function (p) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'side-item side-pl';
      b.setAttribute('data-pl', p.id);
      b.innerHTML = '<span class="side-pl-name"></span><span class="side-pl-n"></span>';
      b.querySelector('.side-pl-name').textContent = p.name;
      b.querySelector('.side-pl-n').textContent = String(p.tracks.length);
      li.appendChild(b);
      sideLists.appendChild(li);
    });
    sideEmpty.hidden = lib.playlists.length > 0;
    markSidebar();
  }

  function markSidebar() {
    var hash = location.hash;
    var view = hash.indexOf('#/pl/') === 0 || hash.indexOf('#/n/') === 0 ? 'playlist' : hash === '#/search' ? 'search' : 'home';
    var items = sidebar.querySelectorAll('.side-item');
    for (var i = 0; i < items.length; i += 1) {
      var plId = items[i].getAttribute('data-pl');
      var go = items[i].getAttribute('data-go');
      var on = plId ? hash === '#/pl/' + plId : go === view;
      items[i].classList.toggle('is-on', on);
    }
  }

  function openSidebar() {
    sidebar.classList.add('is-open');
    app.classList.add('side-open');
  }

  function closeSidebar() {
    sidebar.classList.remove('is-open');
    app.classList.remove('side-open');
  }

  $('menu-btn').addEventListener('click', function () {
    if (sidebar.classList.contains('is-open')) closeSidebar();
    else openSidebar();
  });

  // 点遮罩关抽屉：遮罩是 .app 的 ::after，点上来 target 就是 app
  app.addEventListener('click', function (e) {
    if (!app.classList.contains('side-open')) return;
    if (e.target.closest('.sidebar') || e.target.closest('#menu-btn')) return;
    closeSidebar();
  });

  sidebar.addEventListener('click', function (e) {
    var nav = e.target.closest('[data-go]');
    if (nav) {
      go(nav.getAttribute('data-go') === 'home' ? '#/home' : '#/search');
      closeSidebar();
      return;
    }
    var pl = e.target.closest('[data-pl]');
    if (pl) {
      go('#/pl/' + pl.getAttribute('data-pl'));
      closeSidebar();
    }
  });

  /* ------------------------------------------------------------------ 账号 */
  // 账号在 Worker 里（KV 或 ACCOUNTS_JSON），浏览器只留一个签名过的会话 token
  var SESS_KEY = 'music-session';
  var session = loadSession();
  var qrTimer = null;
  var qrLibPromise = null;
  // Worker 里的 REQUIRE_LOGIN 开关：true 才要求登录，false 直接进站
  var loginRequired = true;

  function loadSession() {
    try {
      var o = JSON.parse(localStorage.getItem(SESS_KEY) || 'null');
      if (o && o.token && o.exp && o.exp > Date.now()) return o;
    } catch (e) { /* 隐私模式 */ }
    return null;
  }

  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESS_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESS_KEY);
    } catch (e) {}
  }

  function currentAccount() {
    if (!session) return null;
    // mode=local：扫码登录，MUSIC_U 只在本机
    if (session.mode === 'local') {
      return { name: session.name || '扫码账号', local: true, musicU: session.musicU };
    }
    return { name: session.name, token: session.token, hasMusicU: session.hasMusicU };
  }

  var loginEl = $('login');
  var loginMsg = $('login-msg');

  function refreshAccountUI() {
    var acc = currentAccount();

    // 口令门开着时先过口令；站长关掉登录时也不显示登录页
    loginEl.hidden = Boolean(acc) || !loginRequired || gateActive;
    $('side-user').hidden = !acc;

    if (acc) {
      $('side-user-name').textContent = acc.name;
      $('side-user-sub').textContent = acc.local ? '扫码 · 仅本机' : acc.hasMusicU ? '已绑定网易云' : '未绑定 MUSIC_U';
    }
  }

  /**
   * 问一下 Worker 的配置：
   *   - 401 + needPassword → 口令门开着，先显示口令卡片
   *   - 200 + login:false  → 不用登录，直接拉首页
   */
  function initAuth() {
    if (!API) return;

    fetch(withK(API + '/api/health'))
      .then(function (r) {
        return r
          .json()
          .catch(function () { return {}; })
          .then(function (d) { return { status: r.status, d: d }; });
      })
      .then(function (res) {
        if (res.status === 401 && res.d && res.d.needPassword) {
          loginRequired = true;
          refreshAccountUI();
          showGate('');
          return;
        }

        var next = res.d && res.d.login !== false;
        if (next !== loginRequired) {
          loginRequired = next;
          if (!loginRequired) homeLoaded = false;
        }
        refreshAccountUI();
        if (!loginRequired) loadHome();
      })
      .catch(function () { /* 连不上就按需要登录处理 */ });
  }

  function enterApp(res) {
    saveSession({
      token: res.token,
      name: res.name,
      exp: res.exp,
      hasMusicU: Boolean(res.hasMusicU)
    });
    refreshAccountUI();
    $('login-pass').value = '';
    loginMsg.textContent = '';
    homeLoaded = false; // 换了账号，首页重新取
    if (location.hash.indexOf('#/pl/') === 0 || location.hash.indexOf('#/n/') === 0) route();
    else loadHome();
  }

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();

    var name = $('login-name').value.trim();
    var pass = $('login-pass').value;

    if (!name || !pass) {
      loginMsg.textContent = '账号名和密码都要填';
      return;
    }

    loginMsg.textContent = '登录中…';

    apiFetch(withK(API + '/api/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name, password: pass })
    })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, d: d }; });
      })
      .then(function (res) {
        if (!res.ok || !res.d.token) {
          loginMsg.textContent = res.d.error || '账号或密码错误';
          return;
        }
        enterApp(res.d);
      })
      .catch(function (err) {
        loginMsg.textContent = '登录失败：' + err.message;
      });
  });

  $('user-logout').addEventListener('click', function () {
    closeSidebar();
    saveSession(null);
    refreshAccountUI();
    $('login-name').value = '';
    loginMsg.textContent = '';
    setTimeout(function () { $('login-name').focus(); }, 60);
  });

  /* 扫码取 MUSIC_U：账号在 Worker 里，这里只是帮站长把值捞出来填配置 */
  var dlgQr = $('dlg-qr');

  function stopQr() {
    if (qrTimer) {
      clearTimeout(qrTimer);
      qrTimer = null;
    }
  }

  function loadQrLib() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (qrLibPromise) return qrLibPromise;

    qrLibPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/js/qrcode.js?v=20261210c';
      s.onload = function () { resolve(window.qrcode); };
      s.onerror = function () { reject(new Error('二维码库没加载下来')); };
      document.head.appendChild(s);
    });

    return qrLibPromise;
  }

  function drawQr(text) {
    return loadQrLib().then(function (qrcode) {
      var qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();

      var canvas = $('qr-canvas');
      var ctx = canvas.getContext('2d');
      var n = qr.getModuleCount();
      var cell = canvas.width / n;

      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#111';
      for (var r = 0; r < n; r += 1) {
        for (var c = 0; c < n; c += 1) {
          if (qr.isDark(r, c)) {
            ctx.fillRect(Math.floor(c * cell), Math.floor(r * cell), Math.ceil(cell), Math.ceil(cell));
          }
        }
      }
    });
  }

  function startQr() {
    var status = $('qr-status');
    status.textContent = '正在获取二维码…';

    apiFetch(API + '/api/qr/key')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.key) throw new Error(d.error || '拿不到二维码');
        return drawQr(d.url).then(function () {
          status.textContent = '打开网易云音乐 App 扫码';
          pollQr(d.key, 0);
        });
      })
      .catch(function (e) {
        status.textContent = '二维码获取失败：' + e.message;
      });
  }

  function pollQr(key, tries) {
    if (tries > 150) {
      $('qr-status').textContent = '二维码超时了，点刷新重来';
      return;
    }

    qrTimer = setTimeout(function () {
      apiFetch(API + '/api/qr/check?key=' + encodeURIComponent(key))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.code === 803 && d.musicU) {
            onQrSuccess(d.musicU);
            return;
          }
          if (d.code === 800) {
            $('qr-status').textContent = '二维码过期了，点刷新';
            return;
          }
          $('qr-status').textContent = d.code === 802 ? '已扫码，在手机上点确认' : '打开网易云音乐 App 扫码';
          pollQr(key, tries + 1);
        })
        .catch(function () { pollQr(key, tries + 1); });
    }, 2000);
  }

  function onQrSuccess(musicU) {
    stopQr();
    $('qr-status').textContent = '登录成功，正在读取昵称…';

    // 用这个 MUSIC_U 问一下昵称；/api/me 认 x-music-u
    apiFetch(API + '/api/me', { headers: { 'x-music-u': musicU } })
      .then(function (r) { return r.json(); })
      .then(function (d) { finishLocalLogin(musicU, d && d.ok ? d.nickname : ''); })
      .catch(function () { finishLocalLogin(musicU, ''); });
  }

  /** 扫码登录：MUSIC_U 只写进本机 localStorage，换设备要重扫 */
  function finishLocalLogin(musicU, nickname) {
    saveSession({
      mode: 'local',
      musicU: musicU,
      name: nickname || '网易云扫码',
      exp: Date.now() + 30 * 86400000
    });

    closeDlg(dlgQr);
    refreshAccountUI();
    homeLoaded = false;
    if (location.hash.indexOf('#/pl/') === 0 || location.hash.indexOf('#/n/') === 0) route();
    else loadHome();
    toast('已扫码登录，只保存在这台浏览器');
  }

  $('qr-close').addEventListener('click', function () {
    stopQr();
    closeDlg(dlgQr);
  });

  $('qr-refresh').addEventListener('click', function () {
    stopQr();
    startQr();
  });

  $('login-qr').addEventListener('click', function () {
    openDlg(dlgQr);
    stopQr();
    startQr();
  });

  /* ------------------------------------------------------------------ 视图 */
  var views = { home: $('view-home'), search: $('view-search'), playlist: $('view-playlist') };

  function showView(name) {
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
    if (name !== 'search') app.classList.remove('is-searching');
    mainEl.scrollTop = 0;
    markSidebar();
  }

  function route() {
    var h = location.hash.replace(/^#\/?/, '');
    closeSidebar();

    if (h.indexOf('pl/') === 0) {
      showView('playlist');
      openLocal(h.slice(3));
      return;
    }
    if (h.indexOf('n/') === 0) {
      showView('playlist');
      openRemote(h.slice(2));
      return;
    }
    if (h === 'search') {
      showView('search');
      return;
    }
    showView('home');
    loadHome();
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  window.addEventListener('hashchange', route);

  /* ------------------------------------------------------------------ 发现页 */
  var homeLoaded = false;
  var homeCache = null;
  var activeCat = '';
  var homeSub = $('home-sub');

  function loadHome() {
    if (homeLoaded || !API) return;
    if (loginRequired && !currentAccount()) return;
    homeLoaded = true;

    renderHomeSkeleton();

    apiFetch(withK(API + '/api/home'))
      .then(authGuard)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) throw new Error(d.error);
        renderHome(d);
      })
      .catch(function (e) {
        homeLoaded = false;
        clearHomeSkeleton('首页加载失败：' + e.message);
      });
  }

  function formatCount(n) {
    if (n >= 100000000) return (n / 100000000).toFixed(1) + ' 亿';
    if (n >= 10000) return Math.round(n / 10000) + ' 万';
    return String(n || 0);
  }

  function makeCard(p, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'card';

    var img = document.createElement('img');
    img.className = 'card-img';
    img.alt = '';
    img.loading = 'lazy';
    if (p.cover) img.src = p.cover;

    var name = document.createElement('span');
    name.className = 'card-name';
    name.textContent = p.name || '未命名歌单';

    var sub = document.createElement('span');
    sub.className = 'card-sub';
    sub.textContent = p.playCount ? formatCount(p.playCount) + ' 播放' : p.trackCount ? p.trackCount + ' 首' : '';

    b.appendChild(img);
    b.appendChild(name);
    b.appendChild(sub);
    b.addEventListener('click', onClick);
    return b;
  }

  /** 首页骨架屏：请求还没回来时先把版面撑起来，别让页面空着抖一下 */
  function renderHomeSkeleton() {
    var i;

    var cards = $('home-recommend');
    cards.innerHTML = '';
    for (i = 0; i < 12; i += 1) {
      var c = document.createElement('div');
      c.className = 'sk-card';
      c.innerHTML = '<div class="sk-img"></div><div class="sk-line"></div><div class="sk-line short"></div>';
      cards.appendChild(c);
    }

    var cats = $('home-cats');
    cats.innerHTML = '';
    for (i = 0; i < 6; i += 1) {
      var chip = document.createElement('div');
      chip.className = 'sk-chip';
      cats.appendChild(chip);
    }

    var tops = $('home-tops');
    tops.innerHTML = '';
    for (i = 0; i < 3; i += 1) {
      var t = document.createElement('div');
      t.className = 'top-card sk-top';
      t.innerHTML =
        '<div class="sk-img sm"></div>' +
        '<div class="sk-stack"><div class="sk-line"></div><div class="sk-line short"></div>' +
        '<div class="sk-line short"></div></div>';
      tops.appendChild(t);
    }

    var news = $('home-new');
    news.innerHTML = '';
    for (i = 0; i < 5; i += 1) {
      var li = document.createElement('li');
      li.innerHTML =
        '<div class="sk-row"><div class="sk-img xs"></div>' +
        '<div class="sk-stack"><div class="sk-line"></div><div class="sk-line short"></div></div></div>';
      news.appendChild(li);
    }
  }

  function clearHomeSkeleton(msg) {
    ['home-recommend', 'home-cats', 'home-tops', 'home-new'].forEach(function (id) {
      $(id).innerHTML = '';
    });
    if (msg) homeSub.textContent = msg;
  }

  function renderHome(d) {
    homeCache = d;
    activeCat = '';
    homeSub.textContent = '分类 · 推荐歌单 · 榜单 · 新歌';

    var rec = $('home-recommend');
    $('home-rec-title').textContent = '推荐歌单';
    rec.innerHTML = '';
    (d.recommend || []).forEach(function (p) {
      rec.appendChild(makeCard(p, function () { go('#/n/' + p.id); }));
    });

    var cats = $('home-cats');
    cats.innerHTML = '';
    (d.categories || []).forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-btn';
      b.textContent = c.name;
      b.addEventListener('click', function () { loadCategory(c, b); });
      cats.appendChild(b);
    });

    var tops = $('home-tops');
    tops.innerHTML = '';
    (d.toplists || []).forEach(function (t) {
      var card = document.createElement('div');
      card.className = 'top-card';

      var img = document.createElement('img');
      img.className = 'top-cover';
      img.alt = '';
      img.loading = 'lazy';
      if (t.cover) img.src = t.cover;
      card.appendChild(img);

      var box = document.createElement('div');

      var h = document.createElement('p');
      h.className = 'top-name';
      h.textContent = t.name;
      box.appendChild(h);

      if (t.updateFrequency) {
        var f = document.createElement('p');
        f.className = 'top-freq';
        f.textContent = t.updateFrequency;
        box.appendChild(f);
      }

      var ul = document.createElement('div');
      ul.className = 'top-tracks';
      (t.tracks || []).forEach(function (s, si) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'top-track';
        b.textContent = s.name + ' · ' + (s.artists || '');
        b.addEventListener('click', function () {
          songs = t.tracks;
          activeQueue = 'home';
          if (s.id === currentId) toggle();
          else play(si);
        });
        ul.appendChild(b);
      });
      box.appendChild(ul);
      card.appendChild(box);
      tops.appendChild(card);
    });

    renderRows($('home-new'), d.newsongs || [], 'home');
  }

  /**
   * 分类在推荐歌单上面：点了就地把下面的卡片换成该分类，
   * 再点同一个 chip 回到默认推荐。
   */
  function loadCategory(c, btn) {
    var chips = document.querySelectorAll('.chip-btn');
    for (var i = 0; i < chips.length; i += 1) chips[i].classList.remove('is-on');

    var rec = $('home-recommend');

    if (activeCat === c.name) {
      activeCat = '';
      $('home-rec-title').textContent = '推荐歌单';
      rec.innerHTML = '';
      (homeCache ? homeCache.recommend || [] : []).forEach(function (p) {
        rec.appendChild(makeCard(p, function () { go('#/n/' + p.id); }));
      });
      return;
    }

    activeCat = c.name;
    btn.classList.add('is-on');
    $('home-rec-title').textContent = '分类：' + c.name;
    rec.innerHTML = '<p class="side-empty">加载中…</p>';

    apiFetch(withK(API + '/api/category?name=' + encodeURIComponent(c.name)))
      .then(authGuard)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (activeCat !== c.name) return; // 已经点到别的分类了
        rec.innerHTML = '';
        (d.playlists || []).forEach(function (p) {
          rec.appendChild(makeCard(p, function () { go('#/n/' + p.id); }));
        });
        if (!(d.playlists || []).length) rec.innerHTML = '<p class="side-empty">这个分类下没有歌单</p>';
      })
      .catch(function (e) {
        if (activeCat !== c.name) return;
        rec.innerHTML = '<p class="side-empty">加载失败：' + e.message + '</p>';
      });
  }

  /* ------------------------------------------------------------------ 歌单页 */
  function openLocal(id) {
    var p = findPlaylist(id);
    if (!p) {
      toast('歌单不存在了');
      go('#/home');
      return;
    }
    renderPlaylist({
      id: p.id,
      neteaseId: p.neteaseId || '',
      name: p.name,
      cover: p.cover,
      description: '',
      creator: '',
      tracks: p.tracks.slice(),
      source: 'local'
    });
  }

  function openRemote(id) {
    if (!/^\d{3,20}$/.test(id)) {
      go('#/home');
      return;
    }

    $('pl-kicker').textContent = '网易云歌单';
    $('pl-name').textContent = '加载中…';
    $('pl-desc').textContent = '';
    $('pl-cover').src = '';
    $('pl-import').hidden = true;
    $('pl-delete').hidden = true;
    renderRows($('pl-tracks'), [], 'playlist');

    apiFetch(withK(API + '/api/playlist?id=' + id))
      .then(authGuard)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) throw new Error(d.error);
        renderPlaylist({
          id: 'n' + d.id,
          neteaseId: d.id,
          name: d.name,
          cover: d.cover,
          description: d.description,
          creator: d.creator,
          tracks: d.tracks || [],
          source: 'netease'
        });
      })
      .catch(function (e) {
        toast('歌单加载失败：' + e.message);
        go('#/home');
      });
  }

  function renderPlaylist(data) {
    currentPlaylist = data;

    $('pl-cover').src = data.cover || DEFAULT_COVER;
    $('pl-name').textContent = data.name;
    $('pl-kicker').textContent = data.source === 'local' ? '我的歌单' : '网易云 · ' + (data.creator || '');
    $('pl-desc').textContent = data.description || data.tracks.length + ' 首';
    $('pl-edit').hidden = data.source !== 'local';
    $('pl-import').hidden = !(data.source === 'netease' && !findPlaylist(data.id));
    $('pl-delete').hidden = data.source !== 'local';

    renderRows($('pl-tracks'), data.tracks, 'playlist');
    $('pl-empty').hidden = data.tracks.length > 0;
    markSidebar();
  }

  $('pl-play').addEventListener('click', function () {
    var arr = queues.playlist || [];
    if (!arr.length) {
      toast('歌单是空的');
      return;
    }
    songs = arr;
    activeQueue = 'playlist';
    play(0);
  });

  $('pl-import').addEventListener('click', function () {
    if (!currentPlaylist) return;

    var p = {
      id: currentPlaylist.id,
      neteaseId: currentPlaylist.neteaseId || '',
      name: currentPlaylist.name,
      cover: currentPlaylist.cover,
      source: 'netease',
      addedAt: Date.now(),
      tracks: currentPlaylist.tracks.slice()
    };

    var old = findPlaylist(p.id);
    if (old) {
      old.tracks = p.tracks;
      old.name = p.name;
      old.cover = p.cover;
    } else {
      lib.playlists.unshift(p);
    }
    if (!saveLib()) return;

    renderSidebar();
    go('#/pl/' + p.id);
    toast('已导入「' + p.name + '」');
  });

  $('pl-delete').addEventListener('click', function () {
    if (!currentPlaylist || currentPlaylist.source !== 'local') return;

    for (var i = 0; i < lib.playlists.length; i += 1) {
      if (lib.playlists[i].id === currentPlaylist.id) {
        var name = lib.playlists[i].name;
        lib.playlists.splice(i, 1);
        saveLib();
        renderSidebar();
        toast('已删除「' + name + '」');
        go('#/home');
        return;
      }
    }
  });

  /* ------------------------------------------------------------------ 对话框 */
  var dlgImport = $('dlg-import');
  var dlgNew = $('dlg-new');
  var dlgAdd = $('dlg-add');

  function openDlg(d) {
    if (d && !d.open) d.showModal();
  }

  function closeDlg(d) {
    if (d && d.open) d.close();
  }

  $('import-btn').addEventListener('click', function () {
    closeSidebar();
    $('import-msg').textContent = '';
    $('import-input').value = '';
    openDlg(dlgImport);
    setTimeout(function () { $('import-input').focus(); }, 60);
  });

  $('import-close').addEventListener('click', function () { closeDlg(dlgImport); });

  $('import-form').addEventListener('submit', function (e) {
    e.preventDefault();

    var raw = $('import-input').value.trim();
    var m = /playlist[^\d]{0,12}(\d{3,20})/.exec(raw) || /^(\d{3,20})$/.exec(raw);
    var id = m && m[1];

    if (!id) {
      $('import-msg').textContent = '没认出歌单 ID：贴链接或纯数字都行';
      return;
    }

    $('import-msg').textContent = '导入中，歌单越长越慢…';

    apiFetch(withK(API + '/api/playlist?id=' + id))
      .then(authGuard)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) throw new Error(d.error);

        var p = {
          id: 'n' + id,
          neteaseId: id,
          name: d.name,
          cover: d.cover,
          source: 'netease',
          addedAt: Date.now(),
          tracks: d.tracks || []
        };

        var old = findPlaylist(p.id);
        if (old) {
          old.name = p.name;
          old.cover = p.cover;
          old.tracks = p.tracks;
        } else {
          lib.playlists.unshift(p);
        }
        if (!saveLib()) return;

        renderSidebar();
        closeDlg(dlgImport);
        go('#/pl/' + p.id);
        toast('已导入 ' + p.tracks.length + ' 首');
      })
      .catch(function (err) {
        $('import-msg').textContent = '导入失败：' + err.message;
      });
  });

  $('new-playlist').addEventListener('click', function () {
    closeSidebar();
    newPendingSong = null; // 从侧边栏进来就是纯新建，别把上一条待加入的歌带进来
    $('new-input').value = '';
    openDlg(dlgNew);
    setTimeout(function () { $('new-input').focus(); }, 60);
  });

  $('new-close').addEventListener('click', function () {
    newPendingSong = null;
    closeDlg(dlgNew);
  });

  $('new-form').addEventListener('submit', function (e) {
    e.preventDefault();

    var name = $('new-input').value.trim();
    if (!name) return;

    var p = { id: uid('p'), name: name, cover: '', source: 'local', addedAt: Date.now(), tracks: [] };

    if (newPendingSong) {
      p.tracks.push(newPendingSong);
      newPendingSong = null;
    }

    lib.playlists.unshift(p);
    if (!saveLib()) {
      lib.playlists.shift();
      return;
    }

    renderSidebar();
    closeDlg(dlgNew);
    go('#/pl/' + p.id);
  });

  function openAddDialog(row) {
    if (!row) return;

    var q = row.getAttribute('data-q') || 'search';
    var arr = queues[q] || [];
    var song = arr[Number(row.getAttribute('data-i'))];
    if (!song) return;

    pendingSong = song;
    newPendingSong = null;

    $('add-song').textContent = song.name + ' · ' + (song.artists || '');

    var ul = $('add-list');
    ul.innerHTML = '';

    if (!lib.playlists.length) {
      var tip = document.createElement('li');
      tip.className = 'sheet-note';
      tip.textContent = '还没有歌单，先建一个';
      ul.appendChild(tip);
    }

    lib.playlists.forEach(function (p) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick-item';
      b.innerHTML = '<span></span><span></span>';
      b.firstChild.textContent = p.name;
      b.lastChild.textContent = p.tracks.length + ' 首';
      b.addEventListener('click', function () { addSongTo(p); });
      li.appendChild(b);
      ul.appendChild(li);
    });

    openDlg(dlgAdd);
  }

  function addSongTo(p) {
    if (!pendingSong) return;

    for (var i = 0; i < p.tracks.length; i += 1) {
      if (p.tracks[i].id === pendingSong.id) {
        toast('「' + p.name + '」里已经有这首了');
        closeDlg(dlgAdd);
        return;
      }
    }

    p.tracks.push(pendingSong);
    if (!saveLib()) {
      p.tracks.pop();
      return;
    }

    renderSidebar();
    closeDlg(dlgAdd);
    toast('已加入「' + p.name + '」');

    if (currentPlaylist && currentPlaylist.id === p.id) openLocal(p.id);
  }

  $('add-new').addEventListener('click', function () {
    newPendingSong = pendingSong;
    closeDlg(dlgAdd);
    $('new-input').value = '';
    openDlg(dlgNew);
    setTimeout(function () { $('new-input').focus(); }, 60);
  });

  $('add-close').addEventListener('click', function () { closeDlg(dlgAdd); });

  /* ------------------------------------------------------------------ 编辑歌单 */
  var DEFAULT_COVER = '/img/playlist.webp';
  var dlgEdit = $('dlg-edit');
  var pendingCover = null; // null=没改，''=改回默认，dataURL=新封面

  $('side-close').addEventListener('click', closeSidebar);

  /** 把用户选的图裁成 320×320 的 jpeg dataURL，免得 localStorage 被原图撑爆 */
  function makeCover(file, cb) {
    var url = URL.createObjectURL(file);
    var img = new Image();

    img.onload = function () {
      var S = 320;
      var canvas = document.createElement('canvas');
      canvas.width = S;
      canvas.height = S;

      var ctx = canvas.getContext('2d');
      var side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);

      URL.revokeObjectURL(url);
      cb(canvas.toDataURL('image/jpeg', 0.85));
    };

    img.onerror = function () {
      URL.revokeObjectURL(url);
      cb('');
    };

    img.src = url;
  }

  function openEditDialog() {
    if (!currentPlaylist || currentPlaylist.source !== 'local') return;

    var p = findPlaylist(currentPlaylist.id);
    if (!p) return;

    pendingCover = null;
    $('edit-name').value = p.name;
    $('edit-cover-preview').src = p.cover || DEFAULT_COVER;
    $('edit-msg').textContent = '';
    openDlg(dlgEdit);
  }

  $('pl-edit').addEventListener('click', openEditDialog);
  $('edit-close').addEventListener('click', function () { closeDlg(dlgEdit); });

  $('edit-cover').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;

    makeCover(file, function (dataUrl) {
      if (!dataUrl) {
        $('edit-msg').textContent = '这张图读不出来，换一张试试';
        return;
      }
      pendingCover = dataUrl;
      $('edit-cover-preview').src = dataUrl;
      $('edit-msg').textContent = '';
    });

    e.target.value = ''; // 允许连续选同一张
  });

  $('edit-cover-reset').addEventListener('click', function () {
    pendingCover = '';
    $('edit-cover-preview').src = DEFAULT_COVER;
  });

  $('edit-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!currentPlaylist || currentPlaylist.source !== 'local') return;

    var p = findPlaylist(currentPlaylist.id);
    if (!p) return;

    var name = $('edit-name').value.trim();
    if (!name) {
      $('edit-msg').textContent = '歌单名不能空';
      return;
    }

    var old = { name: p.name, cover: p.cover };
    p.name = name;
    if (pendingCover !== null) p.cover = pendingCover;

    if (!saveLib()) {
      p.name = old.name;
      p.cover = old.cover;
      return;
    }

    renderSidebar();
    closeDlg(dlgEdit);
    openLocal(p.id);
    toast('已保存');
  });

  /* ------------------------------------------------------------------ 启动 */
  audio.volume = Number(vol.value) / 100;
  fill(vol, 0.8);
  fill(seek, 0);
  fill(sSeek, 0);

  // 封面地址挂了也要有东西看
  $('pl-cover').addEventListener('error', function () {
    this.onerror = null;
    this.src = DEFAULT_COVER;
  });
  applyMode();
  renderHistory();
  applySettings();
  renderSidebar();
  refreshAccountUI();
  route();
  initAuth();

  if (!API) {
    fail('先部署 Worker，再在 source/music/index.html 里填 window.MUSIC_API');
  }
  // 口令门已下线，登录由 #login + /api/login 负责，这里不再探口令
})();
