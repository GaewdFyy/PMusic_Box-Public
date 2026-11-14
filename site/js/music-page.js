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

  /* ------------------------------------------------------- 视口与安全区 */
  /* Android 上 position:fixed / inset:0 的高度是「布局视口」，比可视视口高一条地址栏；
     部分 WebView 的 env(safe-area-inset-top) 还会返回离谱值（没消费 WindowInsets，或按物理像素算）。
     两个毛病叠在一起就是：大屏顶部一大块空白 + 底部功能区被浏览器工具栏挡住。
     所以高度统一由 visualViewport 驱动，安全区按平台分流（CSS 里的 --safe-top / --safe-bottom）。 */
  var vv = window.visualViewport || null;
  var UA = navigator.userAgent || '';
  var OS = /Android/i.test(UA) ? 'android' : /iP(hone|ad|od)/.test(UA) ? 'ios' : 'other';
  document.documentElement.setAttribute('data-os', OS);

  /** 手机端入口（由 Pages 中间件分流，页面里带 data-device="m"） */
  function isMobileUI() {
    return document.documentElement.getAttribute('data-device') === 'm';
  }

  /** 量一次 env(safe-area-inset-top)：离谱值（>12% 屏高）当 0，安卓最多认 12px */
  function probeSafeTop() {
    var d = document.createElement('div');
    d.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding-top:env(safe-area-inset-top,0px)';
    document.body.appendChild(d);
    var v = parseFloat(getComputedStyle(d).paddingTop) || 0;
    d.remove();
    if (v > window.innerHeight * 0.12) v = 0;
    if (OS === 'android') v = Math.min(v, 12);
    document.documentElement.style.setProperty('--safe-top', v + 'px');
  }

  var appH = 0;
  var appHRaf = 0;

  function syncAppH() {
    var h = Math.round((vv && vv.height) || window.innerHeight || 0);
    if (!h) return;
    // 软键盘把可视高度砍掉一大截时别跟着缩，否则整页被压扁
    if (appH && appH - h > 140) return;
    // 1~2px 的抖动不写，避免地址栏动画期间触发 AMLL 的 ResizeObserver 连锁重排
    if (appH && Math.abs(h - appH) < 2) return;
    appH = h;
    document.documentElement.style.setProperty('--app-h', h + 'px');
  }

  function onViewportChange() {
    if (appHRaf) return;
    appHRaf = requestAnimationFrame(function () {
      appHRaf = 0;
      syncAppH();
    });
  }

  probeSafeTop();
  syncAppH();

  if (vv) {
    vv.addEventListener('resize', onViewportChange);
    vv.addEventListener('scroll', onViewportChange);
  }
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', function () {
    setTimeout(function () {
      appH = 0;
      syncAppH();
      probeSafeTop();
    }, 250);
  });

  var app = $('app');
  var input = $('q');
  var goBtn = $('q-go');
  var clearBtn = $('q-clear');
  var hint = $('hint');
  var results = $('results');
  var meta = $('meta');
  var skeleton = $('skeleton');
  var list = $('list');
  var plist = $('plist');       // 歌单搜索结果（和歌曲列表互斥）
  var segKind = $('seg-kind');
  var empty = $('empty');
  var historyBox = $('history');
  var historyItems = $('history-items');
  var historyClear = $('history-clear');
  var pager = $('pager');
  var pgPrev = $('pg-prev');
  var pgNext = $('pg-next');
  var pgNums = $('pg-nums');
  var pgInfo = $('pg-info');

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

  // 歌词栏的底部要跟着播放器实际高度走（收起侧栏、空状态、换行都会变）
  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      document.documentElement.style.setProperty('--player-h', player.offsetHeight + 'px');
    }).observe(player);
    document.documentElement.style.setProperty('--player-h', player.offsetHeight + 'px');
  }
  var pCover = $('p-cover');
  var pTitle = $('p-title');
  var pArtist = $('p-artist');
  var seek = $('seek');
  var vol = $('vol');
  var tCur = $('t-cur');
  var tDur = $('t-dur');

  var stage = $('stage');
  var stageBg = $('stage-bg');
  var auroraEl = $('stage-aurora');
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
    var r = Math.max(0, Math.min(1, ratio));
    el.style.setProperty('--fill', (r * 100).toFixed(2) + '%');
    var item = waveOf(el);
    if (item) {
      item.ratio = r;
      drawWave(item);
    }
  }

  /* ------------------------------------------------ MD3 波浪进度条 */
  var waveItems = [];
  var waveRaf = 0;
  var wavePhase = 0;
  var waveLast = 0;

  function waveOf(el) {
    for (var i = 0; i < waveItems.length; i += 1) {
      if (waveItems[i].input === el) return waveItems[i];
    }
    return null;
  }

  function waveColor(el, name, fallback) {
    var v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
  }

  /**
   * 振幅包络：已播放段是波形，越靠近进度点振幅越小，在进度点收成 0；
   * 之后（未播放段）完全平直，所以曲线和直线是连续过渡的。
   * 左端也收一下，圆头才贴着中线 —— 否则 3.5px 的圆头会顶出一个尖角。
   */
  function waveAmpAt(x, px, amp, pad) {
    var fade = 26;
    var d = px - x;
    if (d <= 0) return 0;

    var a = d >= fade ? amp : amp * smoothstep(d / fade);
    var rise = 10;
    if (x < pad + rise) a *= smoothstep(Math.max(0, x - pad) / rise);
    return a;
  }

  function smoothstep(t) {
    var v = Math.max(0, Math.min(1, t));
    return v * v * (3 - 2 * v);
  }

  function wavePath(ctx, w, h, phase, px, amp, pad) {
    var mid = h / 2;
    var len = 34;
    var last = Math.min(w - pad, Math.max(pad, px));
    ctx.beginPath();
    ctx.moveTo(pad, mid);
    for (var x = pad; x <= last; x += 1) {
      var y = mid + Math.sin(x / len * Math.PI * 2 + phase) * waveAmpAt(x, px, amp, pad);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(last, mid);
  }

  function drawWave(item) {
    var ctx = item.ctx;
    var input = item.input;
    var w = item.w;
    var h = item.h;
    if (!ctx || !w) return;

    ctx.clearRect(0, 0, w, h);

    var active = waveColor(input, '--primary', '#DDC8C1');
    var idle = waveColor(input, '--outline', '#4F4643');

    // 两端各留 2px：圆头（lineWidth 3.5）才不会被画布边缘切平
    var pad = 2;
    var ratio = Math.max(0, Math.min(1, item.ratio || 0));
    var px = pad + ratio * Math.max(0, w - pad * 2);
    var mid = h / 2;
    var amp = 2 * (item.amp || 0);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;

    // 未播放段：直线
    ctx.strokeStyle = idle;
    ctx.beginPath();
    ctx.moveTo(px, mid);
    ctx.lineTo(w - pad, mid);
    ctx.stroke();

    // 已播放段：波形，在进度点收敛成直线
    if (px > pad + 0.5) {
      ctx.strokeStyle = active;
      wavePath(ctx, w, h, wavePhase, px, amp, pad);
      ctx.stroke();
    }

    // 进度点：一根竖线（替代原来的圆点）
    var ih = 11;
    ctx.strokeStyle = active;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(px, mid - ih / 2);
    ctx.lineTo(px, mid + ih / 2);
    ctx.stroke();
  }

  function layoutWave(item) {
    var input = item.input;
    var w = input.offsetWidth;
    if (!w) return;
    var h = 16;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    item.w = w;
    item.h = h;
    item.canvas.width = Math.round(w * dpr);
    item.canvas.height = Math.round(h * dpr);
    item.canvas.style.width = w + 'px';
    item.canvas.style.height = h + 'px';
    item.canvas.style.left = input.offsetLeft + 'px';
    item.canvas.style.top = (input.offsetTop + (input.offsetHeight - h) / 2) + 'px';
    item.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawWave(item);
  }

  function relayoutWaves() {
    waveItems.forEach(layoutWave);
  }

  function waveLoop(ts) {
    waveRaf = 0;
    var dt = waveLast ? Math.min(64, ts - waveLast) : 16;
    waveLast = ts;

    var playing = !audio.paused;
    if (playing) wavePhase += dt / 1000 * 1.6;

    var target = playing ? 1 : 0;
    var moving = false;

    waveItems.forEach(function (item) {
      var a = item.amp || 0;
      a += (target - a) * Math.min(1, dt / 110);
      if (Math.abs(target - a) < 0.004) a = target;
      item.amp = a;
      if (a !== target) moving = true;
      drawWave(item);
    });

    if (playing || moving) waveRaf = requestAnimationFrame(waveLoop);
    else waveLast = 0;
  }

  function waveKick() {
    if (waveRaf) return;
    waveLast = 0;
    waveRaf = requestAnimationFrame(waveLoop);
  }

  function setupWave(input) {
    if (!input || !input.parentElement) return;
    input.classList.add('is-wave');
    input.parentElement.classList.add('wave-host');
    var canvas = document.createElement('canvas');
    canvas.className = 'wave-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    input.parentElement.appendChild(canvas);
    var item = { input: input, canvas: canvas, ctx: canvas.getContext('2d'), ratio: 0, w: 0, h: 0, amp: 0 };
    waveItems.push(item);
    requestAnimationFrame(function () { layoutWave(item); });
  }

  setupWave(seek);
  setupWave(sSeek);
  window.addEventListener('resize', relayoutWaves);

  // 播放条/大屏显示出来时宽度才从 0 变成实际值，用 ResizeObserver 跟一下
  if (window.ResizeObserver) {
    var waveRO = new ResizeObserver(function () { relayoutWaves(); });
    waveItems.forEach(function (item) { waveRO.observe(item.input); });
  }

  var toastEl = null;
  var toastTimer = null;

  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      if ('popover' in toastEl) toastEl.setAttribute('popover', 'manual');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    if (toastEl.showPopover) {
      try { if (!toastEl.matches(':popover-open')) toastEl.showPopover(); } catch (e) {}
    }
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
      setTimeout(function () {
        if (toastEl.hidePopover) {
          try { if (toastEl.matches(':popover-open')) toastEl.hidePopover(); } catch (e) {}
        }
      }, 220);
    }, 3200);
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
      if (plist) plist.innerHTML = '';
      queues.search = [];
      pager.hidden = true;
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
    list.hidden = false;
    if (plist) plist.hidden = true;

    meta.textContent = arr.length
      ? '找到 ' + (data.total || arr.length) + ' 首' + (data.abroad ? '（网易云降级结果）' : '')
      : '';

    empty.hidden = arr.length !== 0;
    // Worker 会带上 reason/hint：区分「网易云降级」和「被限流」，
    // 不要一律显示「没搜到」，那样根本没法排查
    empty.textContent = data.hint || '没搜到，换个关键词试试';

    renderRows(list, arr, 'search');
  }

  /** 搜索结果切歌 / 歌单：两套列表互斥显示 */
  var searchKind = 'song';

  function syncKindUI() {
    if (!segKind) return;
    var btns = segKind.querySelectorAll('button');
    for (var i = 0; i < btns.length; i += 1) {
      btns[i].setAttribute('aria-checked', btns[i].getAttribute('data-v') === searchKind ? 'true' : 'false');
    }
  }

  /** 歌单结果：封面 + 名字 + 曲目数 / 播放量 + 创建者，点一下进歌单预览页 */
  function renderPlaylists(data) {
    var arr = data.playlists || [];
    skeleton.hidden = true;
    list.hidden = true;
    plist.hidden = false;
    plist.innerHTML = '';

    meta.textContent = arr.length ? '找到 ' + (data.total || arr.length) + ' 个歌单' : '';
    empty.hidden = arr.length !== 0;
    empty.textContent = data.hint || '没搜到歌单，换个关键词试试';

    arr.forEach(function (p) {
      var li = document.createElement('li');
      var row = document.createElement('div');
      row.className = 'pl-row';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.setAttribute('data-plid', p.id);

      var cover = document.createElement('img');
      cover.className = 'pl-row-cover';
      cover.alt = '';
      cover.loading = 'lazy';
      if (p.cover) cover.src = p.cover;

      var main = document.createElement('span');
      main.className = 'pl-row-main';
      var name = document.createElement('span');
      name.className = 'pl-row-name';
      name.textContent = p.name || '未命名歌单';
      var sub = document.createElement('span');
      sub.className = 'pl-row-sub';
      sub.textContent = [p.trackCount ? p.trackCount + ' 首' : '', p.creator || '']
        .filter(Boolean).join(' · ');
      main.appendChild(name);
      main.appendChild(sub);

      var n = document.createElement('span');
      n.className = 'pl-row-n';
      var plays = Number(p.playCount) || 0;
      n.textContent = plays ? (plays >= 10000 ? (plays / 10000).toFixed(1) + ' 万' : plays) + ' 播放' : '';

      row.appendChild(cover);
      row.appendChild(main);
      row.appendChild(n);
      li.appendChild(row);
      plist.appendChild(li);
    });
  }

  if (segKind) {
    segKind.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var next = b.getAttribute('data-v') === 'playlist' ? 'playlist' : 'song';
      if (next === searchKind) return;
      searchKind = next;
      syncKindUI();

      // 切类型就用当前关键词重搜；没搜过就只清空列表
      var kw = (input.value || '').trim();
      if (kw && searchState.kw) search(kw, 1, true);
      else {
        setSearching(false);
        hint.textContent = '回车，或点按钮';
      }
    });
  }

  /* ------------------------------------------------------------ 搜索翻页 */
  var PAGE_SIZE = 20;
  // 网易云超过 1000 条就开始返回空/重复，别让用户一直翻下去
  var MAX_OFFSET = 1000;
  var searchState = {
    kw: '',
    page: 1,
    total: 0,
    pages: 1,
    page1FirstId: null,
    noOffset: false,
    unit: '首'
  };

  function maxPageFor(total) {
    return Math.max(1, Math.min(Math.floor(MAX_OFFSET / PAGE_SIZE) + 1, Math.ceil((total || 0) / PAGE_SIZE)));
  }

  function renderPager() {
    var st = searchState;
    pager.hidden = st.pages <= 1 || st.noOffset;
    if (pager.hidden) return;

    pgPrev.disabled = st.page <= 1;
    pgNext.disabled = st.page >= st.pages;

    // 「第 2 / 12 页 · 共 231 首」
    var unit = st.unit || '首';
    pgInfo.textContent = '第 ' + st.page + ' / ' + st.pages + ' 页 · 共 ' + st.total + ' ' + unit +
      (st.total > MAX_OFFSET ? '（最多前 ' + MAX_OFFSET + ' ' + unit + '）' : '');

    var nums = [];
    var i;
    for (i = 1; i <= st.pages; i += 1) {
      // 只留首页、末页和当前页左右各一页，其余用省略号
      if (i === 1 || i === st.pages || Math.abs(i - st.page) <= 1) nums.push(i);
      else if (nums[nums.length - 1] !== '…') nums.push('…');
    }

    pgNums.innerHTML = '';
    nums.forEach(function (n) {
      if (n === '…') {
        var gap = document.createElement('span');
        gap.className = 'pager-num is-gap';
        gap.textContent = '…';
        pgNums.appendChild(gap);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pager-num' + (n === st.page ? ' is-on' : '');
      b.textContent = String(n);
      b.setAttribute('aria-label', '第 ' + n + ' 页');
      if (n === st.page) b.setAttribute('aria-current', 'page');
      b.addEventListener('click', function () {
        if (n === searchState.page) return;
        search(searchState.kw, n, true);
      });
      pgNums.appendChild(b);
    });
  }

  function gotoPage(delta) {
    var next = searchState.page + delta;
    if (next < 1 || next > searchState.pages) return;
    search(searchState.kw, next, true);
  }

  pgPrev.addEventListener('click', function () { gotoPage(-1); });
  pgNext.addEventListener('click', function () { gotoPage(1); });

  function search(kw, page, keepScroll) {
    if (!API) {
      fail('还没配置 Worker 地址（source/music/index.html 里的 window.MUSIC_API）');
      return;
    }

    kw = (kw || '').trim();
    if (!kw) {
      setSearching(false);
      return;
    }

    var p = Math.max(1, Math.floor(Number(page) || 1));
    var offset = (p - 1) * PAGE_SIZE;

    searchState.kw = kw;
    searchState.page = p;

    hint.classList.remove('is-error');
    hint.textContent = p > 1 ? '正在翻到第 ' + p + ' 页…' : '搜索中…';
    setSearching(true);
    goBtn.disabled = true;
    skeleton.hidden = false;
    empty.hidden = true;
    list.innerHTML = '';
    if (plist) plist.innerHTML = '';
    meta.textContent = '';

    var kind = searchKind;
    var url =
      API + '/api/search?q=' + encodeURIComponent(kw) + '&limit=' + PAGE_SIZE +
      (offset ? '&offset=' + offset : '') +
      (kind === 'playlist' ? '&kind=playlist' : '') + tk();

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

        var arr = kind === 'playlist' ? (data.playlists || []) : (data.songs || []);
        searchState.unit = kind === 'playlist' ? '个歌单' : '首';

        // 旧版 Worker 不认 offset：第 2 页会原样返回第 1 页。
        // 这里认出来并降级，而不是让用户以为「翻页坏了」。
        if (p === 1) {
          searchState.page1FirstId = arr.length ? arr[0].id : null;
          searchState.noOffset = false;
        } else if (
          arr.length &&
          searchState.page1FirstId != null &&
          arr[0].id === searchState.page1FirstId
        ) {
          // 服务端没认 offset，返回的其实就是第一页 —— 把状态也退回第一页，别骗自己
          searchState.noOffset = true;
          searchState.page = 1;
          toast('服务端还没更新，暂时只能看第一页');
        }

        searchState.total = data.total || arr.length;
        searchState.pages = maxPageFor(searchState.total);
        if (searchState.page > searchState.pages) searchState.page = searchState.pages;

        // 只有真搜出东西才记进历史，避免把错别字脏数据也存下来
        if (p === 1 && arr.length) rememberSearch(kw);

        if (kind === 'playlist') renderPlaylists(data);
        else renderSongs(data);
        renderPager();

        if (keepScroll && mainEl) mainEl.scrollTo({ top: 0, behavior: 'smooth' });
      })
      .catch(function (e) {
        goBtn.disabled = false;
        skeleton.hidden = true;
        pager.hidden = true;
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
  var AMLL_VER = '?v=20261216';      // 只对本地副本做缓存穿透
  var amllWrap = document.getElementById('amll-wrap');
  var lastLyric = null;
  // src 记录到底是从 CDN 还是本地副本加载成功的，设置里要如实显示
  var amll = { status: 0, waiters: [], player: null, lines: [], raf: 0, last: 0, playing: null, src: '' };

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
      refreshAmllStatus(); // 设置里的「组件状态」要跟着变
    }

    // 组件 392KB，移动网络下可能很慢：6 秒还不就绪就放弃，先用轻量歌词顶着
    var guard = setTimeout(function () { done(false); }, 6000);

    var first = AMLL_CDN ? loadAmllFrom(AMLL_CDN, false) : Promise.resolve(false);

    first
      .then(function (ok) {
        if (ok) {
          amll.src = 'cdn';
          done(true);
          return;
        }
        return loadAmllFrom(AMLL_LOCAL, true).then(function (ok2) {
          if (ok2) amll.src = 'local';
          done(ok2);
        });
      })
      .catch(function () { done(false); });

    return p;
  }

  /* 进站后偷偷把 core 拉进浏览器缓存：只下载，不执行，也不进上面的状态机。
   * 等真要画歌词时 <script> 直接命中缓存（/vendor/* 是 immutable），几乎瞬开。
   * 三个前提：页面已经 load 完、浏览器空闲、用户没关掉 AMLL 歌词。 */
  var amllPrefetched = false;

  function preloadAmll() {
    if (amllPrefetched || amll.status !== 0 || !wantAmll()) return;

    // 省流量模式或 2G：这 390KB 就别添乱了，等真要看歌词再说
    var conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
    if (conn && (conn.saveData || /2g/.test(conn.effectiveType || ''))) return;

    amllPrefetched = true;

    var base = AMLL_CDN || AMLL_LOCAL;
    var ver = AMLL_CDN ? '' : AMLL_VER;
    var files = [
      { name: 'amll-core.css', as: 'style' },
      { name: 'amll-core.js', as: 'script' }
    ];

    files.forEach(function (f) {
      var link = document.createElement('link');
      link.rel = 'prefetch';
      link.as = f.as;
      link.href = base + f.name + ver;
      document.head.appendChild(link);
    });
  }

  function scheduleAmllPreload() {
    // 空闲回调：优先级低于首屏的 CSS/JS/接口，抢不到带宽也不影响渲染
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(preloadAmll, { timeout: 3000 });
    } else {
      setTimeout(preloadAmll, 1200);
    }
  }

  if (document.readyState === 'complete') scheduleAmllPreload();
  else window.addEventListener('load', scheduleAmllPreload);

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

  /* ------------------------------------------------ AMLL 视图（大屏 + 侧栏） */
  /* AMLL 的每个实例自带 DOM、ResizeObserver、scrollEngine，互不共享状态；
     所以「大屏」和「桌面右侧歌词栏」各建一个实例，而不是把同一个节点搬来搬去
     （搬节点会经过一次 0×0 测量，弹簧滚动状态会脏）。两边共用一条 rAF。 */
  var amllViews = {};      // key -> { key, wrap, player, lines, playing, running }
  var amllLast = 0;
  var drawerOpen = false;

  function amllView(key, wrap) {
    if (amllViews[key]) return amllViews[key];
    if (!wrap || !window.AMLL || !window.AMLL.DomLyricPlayer) return null;

    var Ctor = window.AMLL.DomLyricPlayer;
    var p = new Ctor();
    wrap.appendChild(p.getElement());

    p.setEnableBlur(true);
    p.setWordFadeWidth(0.5);
    // 侧栏窄，当前行放偏上（0.35）；大屏手机 0.38，桌面居中
    p.setAlignPosition(key === 'drawer' ? 0.35 : (key === 'stage' && mobileLayout() ? 0.38 : 0.5));

    var view = { key: key, wrap: wrap, player: p, lines: [], playing: null, running: false };

    // 点歌词跳转：AMLL 自己派发 line-click，带行号（行号是实例内的，指同一份歌词数组）
    p.addEventListener('line-click', function (e) {
      var line = view.lines[e.lineIndex];
      if (!line || currentId == null) return;
      if (!isFinite(audio.duration) || audio.duration <= 0) {
        toast('还没加载好，稍等一下');
        return;
      }
      audio.currentTime = Math.max(0, (line.startTime - offsetMs()) / 1000 - 0.08);
      if (audio.paused) audio.play().catch(function () {});
      eachAmllView(function (v) {
        if (v.running) v.player.setCurrentTime(lyricMs(), true);
      });
    });

    amllViews[key] = view;
    return view;
  }

  function eachAmllView(fn) {
    Object.keys(amllViews).forEach(function (k) { fn(amllViews[k]); });
  }

  function pushLinesToView(v, list) {
    if (!v) return;
    v.lines = list;
    var ms = lyricMs();
    v.player.setLyricLines(list, ms);
    v.player.setCurrentTime(ms, true);
  }

  /**
   * AMLL 自己维护 isPlaying：只有 true 才会推进逐字遮罩。
   * 页面加载后第一首歌的 play 事件往往早于播放器创建，必须在这里补同步，
   * 否则第一首有逐字歌词的歌会「有词无高亮」，换首歌才恢复。
   */
  function syncAmllPlayState(v) {
    if (!v || !v.player) return;
    var playing = !audio.paused;
    if (playing === v.playing) return;
    v.playing = playing;
    if (playing) v.player.resume();
    else v.player.pause();
  }

  function amllFrame(ts) {
    amll.raf = 0;
    var delta = amllLast ? Math.min(1000, ts - amllLast) : 16;
    amllLast = ts;

    var any = false;
    eachAmllView(function (v) {
      if (!v.running) return;
      any = true;
      syncAmllPlayState(v);
      if (!audio.paused) v.player.setCurrentTime(lyricMs());
      v.player.update(delta);
    });

    if (any) amll.raf = requestAnimationFrame(amllFrame);
    else amllLast = 0;
  }

  /** 只有「正在显示」的视图才跑；两个视图共用一条 rAF */
  function syncAmllRaf() {
    var any = false;
    eachAmllView(function (v) { if (v.running) any = true; });

    if (any && !amll.raf) {
      amllLast = 0;
      amll.raf = requestAnimationFrame(amllFrame);
    } else if (!any && amll.raf) {
      cancelAnimationFrame(amll.raf);
      amll.raf = 0;
    }
  }

  /** 按「大屏是否可见 / 侧栏是否打开」重算每个视图该不该跑 */
  function syncViewRunning() {
    var stageOn = amllShouldRun() && !!amllViews.stage;
    var drawerOn = drawerOpen && drawerMode === 'amll' && !!amllViews.drawer;
    eachAmllView(function (v) {
      v.running = v.key === 'stage' ? stageOn : drawerOn;
    });
    syncAmllRaf();
  }

  function showAmll(on) {
    var v = amllViews.stage;
    if (v) v.wrap.hidden = !on;
    lyricsBox.hidden = !!on;
  }

  /**
   * 统一的歌词渲染入口：能上 AMLL 就上，加载失败/关掉开关就退回轻量渲染。
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
      eachAmllView(function (v) { v.running = false; });
      syncAmllRaf();
      renderLyrics(parseLrc(data.lrc || ''), parseLrcMap(data.tlyric || ''));
      if (drawerOpen) refreshDrawerRenderer();
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

      var v = amllView('stage', amllWrap);
      if (!v) return;
      pushLinesToView(v, list);
      // 侧栏已经开着的话同步过去（没开就不建实例，省一份 DOM）
      if (drawerOpen) {
        if (drawerMode === 'amll' && amllViews.drawer) pushLinesToView(amllViews.drawer, list);
        else if (drawerMode === 'lite') renderLiteDrawer();
      }

      showAmll(true);
      syncViewRunning();

      // 旧渲染器的节点清掉，别在后台占 DOM
      lyricsBox.innerHTML = '';
      lines = [];
      activeLine = -1;
    });
  }

  /* -------------------------------------------------- 桌面右侧歌词栏 */
  var lyricDrawer = $('lyric-drawer');
  var amllDrawerWrap = $('amll-drawer-wrap');
  var liteDrawerBox = $('lyrics-drawer');
  var lyricDrawerHint = $('lyric-drawer-hint');

  var drawerMode = 'amll';   // 实际在用的渲染器：amll | lite
  var liteLines = [];
  var liteActive = -1;

  /** 设置里选了轻量、或者干脆关掉了 AMLL，就走轻量 */
  function drawerWantsAmll() {
    return settings.drawerLyric !== 'lite' && wantAmll();
  }

  /** 轻量歌词：只做整行高亮，成本比 AMLL 低一个数量级 */
  function renderLiteDrawer() {
    liteDrawerBox.innerHTML = '';
    liteLines = [];
    liteActive = -1;

    if (!lastLyric) {
      lyricDrawerHint.hidden = false;
      lyricDrawerHint.textContent = '播放后自动加载歌词';
      return;
    }

    var list = parseLrc(lastLyric.lrc || '');
    if (!list.length) {
      lyricDrawerHint.hidden = false;
      lyricDrawerHint.textContent = '这首歌没有歌词';
      return;
    }

    var trMap = parseLrcMap(lastLyric.tlyric || '');
    list.forEach(function (line) {
      var el = document.createElement('p');
      el.className = 'line';

      var main = document.createElement('span');
      main.className = 'line-tx';
      main.textContent = line.text;
      el.appendChild(main);

      if (settings.trans) {
        var tr = trMap[Math.round(line.t * 100)];
        if (tr) {
          var sub = document.createElement('span');
          sub.className = 'line-tr';
          sub.textContent = tr;
          el.appendChild(sub);
        }
      }

      liteDrawerBox.appendChild(el);
    });

    liteLines = list;
    lyricDrawerHint.hidden = true;
    syncLiteDrawer();
  }

  function syncLiteDrawer(force) {
    if (!drawerOpen || drawerMode !== 'lite' || !liteLines.length) return;

    var now = audio.currentTime + offsetMs() / 1000;
    var idx = -1;
    for (var i = 0; i < liteLines.length; i += 1) {
      if (liteLines[i].t <= now + 0.12) idx = i;
      else break;
    }
    if (idx === liteActive && !force) return;

    var nodes = liteDrawerBox.querySelectorAll('.line');
    for (var j = 0; j < nodes.length; j += 1) nodes[j].classList.toggle('is-active', j === idx);

    if (idx >= 0 && nodes[idx]) {
      liteDrawerBox.scrollTo({
        top: nodes[idx].offsetTop - liteDrawerBox.clientHeight * 0.38 + nodes[idx].offsetHeight / 2,
        behavior: force ? 'auto' : 'smooth'
      });
    }
    liteActive = idx;
  }

  // 轻量歌词也支持点行跳转
  liteDrawerBox.addEventListener('click', function (e) {
    var el = e.target.closest('.line');
    if (!el || !liteLines.length) return;

    var nodes = liteDrawerBox.querySelectorAll('.line');
    var idx = Array.prototype.indexOf.call(nodes, el);
    if (idx < 0 || !liteLines[idx]) return;

    if (!isFinite(audio.duration) || audio.duration <= 0) {
      toast('还没加载好，稍等一下');
      return;
    }

    audio.currentTime = Math.max(0, liteLines[idx].t - offsetMs() / 1000 - 0.08);
    if (audio.paused) audio.play().catch(function () {});
    syncLiteDrawer(true);
  });

  function ensureDrawerView() {
    if (!wantAmll()) {
      lyricDrawerHint.hidden = false;
      lyricDrawerHint.textContent = 'AMLL 歌词被关掉了，已切到轻量';
      return null;
    }

    if (amll.status !== 2) {
      lyricDrawerHint.hidden = false;
      lyricDrawerHint.textContent = '歌词加载中…';
      loadAmll().then(function (ok) {
        if (!ok) {
          lyricDrawerHint.textContent = '歌词组件没加载下来';
          return;
        }
        if (drawerOpen && drawerMode === 'amll') {
          ensureDrawerView();
          syncViewRunning();
        }
      });
      return null;
    }

    var v = amllView('drawer', amllDrawerWrap);
    if (!v) return null;

    if (lastLyric) {
      var list = amllLinesFor(lastLyric);
      if (list.length) {
        pushLinesToView(v, list);
        lyricDrawerHint.hidden = true;
      } else {
        lyricDrawerHint.hidden = false;
        lyricDrawerHint.textContent = '这首歌没有歌词';
      }
    } else {
      lyricDrawerHint.hidden = false;
      lyricDrawerHint.textContent = '播放后自动加载歌词';
    }
    return v;
  }

  /** 按设置决定歌词栏用哪套渲染；开着的时候切换立刻生效 */
  function refreshDrawerRenderer() {
    if (!drawerOpen) return;

    var useAmll = drawerWantsAmll();
    drawerMode = useAmll ? 'amll' : 'lite';

    amllDrawerWrap.hidden = !useAmll;
    liteDrawerBox.hidden = useAmll;
    lyricDrawerHint.hidden = true;
    lyricDrawerHint.textContent = '';

    if (useAmll) {
      ensureDrawerView();
    } else {
      if (amllViews.drawer) amllViews.drawer.running = false;
      renderLiteDrawer();
    }

    syncViewRunning();
  }

  function openLyricDrawer() {
    if (isMobileUI()) return;
    // 大屏是全屏的，两个同时开着没意义
    if (!stage.hidden) closeStage();

    drawerOpen = true;
    // 让 .app 多出一列，正文自己往左让，而不是被盖住
    app.classList.add('has-lyrics');
    lyricDrawer.classList.add('is-open');
    lyricDrawer.setAttribute('aria-hidden', 'false');
    $('lyric-btn').classList.add('is-on');

    // 等这一列真正让出来再量尺寸：AMLL 是 contain: strict，0 宽会算错布局
    requestAnimationFrame(function () {
      refreshDrawerRenderer();
      if (drawerMode === 'lite') syncLiteDrawer(true);
    });
  }

  function closeLyricDrawer() {
    drawerOpen = false;
    app.classList.remove('has-lyrics');
    lyricDrawer.classList.remove('is-open');
    lyricDrawer.setAttribute('aria-hidden', 'true');
    $('lyric-btn').classList.remove('is-on');
    if (amllViews.drawer) amllViews.drawer.running = false;
    syncAmllRaf();
  }

  function toggleLyricDrawer() {
    if (drawerOpen) closeLyricDrawer();
    else openLyricDrawer();
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

  /** 两个色相之间的短弧中点（0–360，跨过 0° 也不会跑反方向） */
  function midHue(a, b) {
    var d = ((b - a + 540) % 360) - 180;
    return (a + d / 2 + 360) % 360;
  }

  /** 两个色相在色环上的最短距离（0–180） */
  function hueDist(a, b) {
    return Math.abs(((b - a + 540) % 360) - 180);
  }

  /**
   * 从图片里取色：主色（主导色相 + 彩度）与辅助色（另一个色簇）。
   * 大屏背景要两种颜色才不像「一个大色块」，所以这里多做一次分桶。
   */
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
    // 留一份原样的像素（角度、彩度、权重），第二色相要用
    var hh = [];
    var cc = [];
    var ww = [];

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

      hh.push(((H * 180) / Math.PI + 360) % 360);
      cc.push(C);
      ww.push(w);
    }

    if (!wsum) return null;

    var h = ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360;
    // 封面往往偏灰，提一档彩度并夹在合理区间；下限别太低，
    // 否则暗色主题下算出来的 primary 会接近白色，看着像「没生效」
    var c = Math.max(0.065, Math.min(0.16, (csum / wsum) * 1.45));

    // 辅助色：按 30° 分 12 个桶，挑「离主色 50° 以上、权重最大」的那个，
    // 这样拿到的才是封面里真实存在的第二种颜色，而不是硬算一个补色
    var bins = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (var k = 0; k < hh.length; k += 1) {
      bins[Math.min(11, Math.floor(hh[k] / 30))] += ww[k];
    }

    var bestBin = -1;
    var bestW = 0;
    for (var b = 0; b < 12; b += 1) {
      if (hueDist(h, b * 30 + 15) < 50) continue;
      if (bins[b] > bestW) {
        bestW = bins[b];
        bestBin = b;
      }
    }

    var h2;
    var c2;
    if (bestBin >= 0) {
      var bs = 0;
      var bc = 0;
      for (var m = 0; m < hh.length; m += 1) {
        if (Math.floor(hh[m] / 30) !== bestBin) continue;
        bs += ww[m];
        bc += cc[m] * ww[m];
      }
      // 辅助色相：该桶里像素的圆均值（比直接取桶中心更贴合真实颜色）
      var bx = 0;
      var by = 0;
      for (var n = 0; n < hh.length; n += 1) {
        if (Math.floor(hh[n] / 30) !== bestBin) continue;
        var rad = (hh[n] * Math.PI) / 180;
        bx += Math.sin(rad) * ww[n];
        by += Math.cos(rad) * ww[n];
      }
      h2 = ((Math.atan2(bx, by) * 180) / Math.PI + 360) % 360;
      c2 = bs > 0 ? Math.max(0.05, Math.min(0.18, (bc / bs) * 1.4)) : c * 0.85;
    } else {
      // 封面几乎是单色：挪 32° 造一个邻近色，别让背景只有一种颜色
      h2 = (h + 32) % 360;
      c2 = c * 0.85;
    }

    return { h: h, c: c, h2: h2, c2: c2 };
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

      // 浅色底不要顶到接近纯白（原来 97/95/92/89）：压到 94 起步，
      // 带一点封面色相，页面看起来是「暖一点的白」而不是刺眼的 #FFF
      '--surface': neutral(94),
      '--surface-1': neutral(92),
      '--surface-2': neutral(89),
      '--surface-3': neutral(86),
      '--on-surface': neutral(13),
      '--on-surface-2': neutral(42),
      '--outline': neutral(78)
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

  /** 按来源算色相：custom=自选色，bg=背景图，其余=歌曲封面 */
  function hueFromMode(mode) {
    if (mode === 'custom' && settings.seed) return hexToHue(settings.seed);
    if (mode === 'bg' && bgHue) return bgHue;
    return themeHue;
  }

  /** 主页取色 */
  function activeHue() {
    return hueFromMode(settings.seedPage);
  }

  /** 大屏取色（可以和主页不同） */
  function stageHue() {
    return hueFromMode(settings.seedStage);
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

  /* 大屏动态渐变用到的颜色变量（CSS 里用 @property 注册过，换歌会平滑插值） */
  var STAGE_GRAD_KEYS = ['--g1', '--g2', '--g3', '--g4', '--bg-a', '--bg-b'];

  /**
   * 由取到的色相生成一组「光斑颜色」：
   * g1 主色（最大那团）、g2 辅助色、g3 提亮色、g4 深色（压住底部），
   * bg-a / bg-b 是舞台底色。整体压暗，保证歌词和封面浮在上面还读得清。
   */
  function stageGradientColors(hue) {
    var h = hue.h;
    var c = Math.max(0.075, Math.min(0.2, hue.c));
    // 自选色 / 背景图取色没有第二色相，按主色偏 32° 补一个
    var h2 = typeof hue.h2 === 'number' ? hue.h2 : (h + 32) % 360;
    var c2 = typeof hue.c2 === 'number' ? Math.max(0.06, Math.min(0.2, hue.c2)) : c * 0.85;
    var hm = midHue(h, h2);

    var mix = function (l, cc, hh) {
      return 'oklch(' + l.toFixed(3) + ' ' + cc.toFixed(3) + ' ' + hh.toFixed(1) + ')';
    };

    return {
      '--g1': mix(0.62, Math.min(0.24, c * 1.55), h),
      '--g2': mix(0.55, Math.min(0.22, c2 * 1.5), h2),
      '--g3': mix(0.75, Math.min(0.17, c * 0.95), hm),
      '--g4': mix(0.42, Math.min(0.24, c2 * 1.7), (h2 + 16) % 360),
      '--bg-a': mix(0.3, Math.min(0.06, c * 0.35), h),
      '--bg-b': mix(0.15, Math.min(0.03, c * 0.18), h2)
    };
  }

  /**
   * 大屏内一律深色：把深色色板挂到 .stage 自己身上，
   * 退出大屏时整页仍然是用户选的那套深浅色（自定义属性会继承，作用域天然隔离）。
   */
  function paintStageTheme() {
    if (!stage) return;
    var hue = stageHue();

    if (!hue) {
      PALETTE_KEYS.forEach(function (k) { stage.style.removeProperty(k); });
      STAGE_GRAD_KEYS.forEach(function (k) { stage.style.removeProperty(k); });
      return;
    }

    var vars = coverPalette(hue, true);
    PALETTE_KEYS.forEach(function (k) { stage.style.setProperty(k, vars[k]); });

    // 背景光斑的颜色跟着同一份取色走，换歌时由 CSS transition 慢慢变过去
    var grad = stageGradientColors(hue);
    STAGE_GRAD_KEYS.forEach(function (k) { stage.style.setProperty(k, grad[k]); });
  }

  /**
   * 光斑动效速率：播放时 1，暂停时 0.32（同时挂 .is-calm 让整层收一点）。
   * 用 WAAPI 改 playbackRate 而不是换 animation-duration —— 后者会让动画重算进度，
   * 光斑会「跳」一下；playbackRate 只是改变推进速度，画面是连着的。
   */
  function setStageMotion(rate) {
    if (!auroraEl) return;
    auroraEl.classList.toggle('is-calm', rate < 1);

    if (typeof auroraEl.getAnimations !== 'function') return;

    var list;
    try {
      list = auroraEl.getAnimations({ subtree: true });
    } catch (e) {
      list = auroraEl.getAnimations();
    }

    for (var i = 0; i < list.length; i += 1) {
      try {
        list[i].playbackRate = rate;
      } catch (e) { /* 老浏览器不支持就算了，CSS 里还有 prefers-reduced-motion 兜底 */ }
    }
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

  /**
   * 大屏背景两种模式：
   * - 流光（默认）：.stage-aurora 那几团渐变光斑，把旧的封面底图清掉
   * - 模糊封面：关掉流光后，把封面铺进 .stage-bg（自带 blur(64px)），更省电
   */
  function applyStageBg(song) {
    if (!stageBg) return;

    var cover = song && song.cover;
    var useBlur = settings.stageFx === false;

    if (useBlur && cover) {
      stageBg.style.backgroundImage = 'url("' + cover + '")';
      stageBg.classList.add('is-on');
    } else {
      stageBg.style.backgroundImage = '';
      stageBg.classList.remove('is-on');
    }
  }

  function paint(song) {
    player.classList.remove('is-empty');

    pTitle.textContent = song.name || '未知曲目';
    pArtist.textContent = (song.artists || '') + (song.album ? ' · ' + song.album : '');
    $('p-id').textContent = 'ID ' + song.id;

    pCover.src = song.cover || DEFAULT_COVER;
    pCover.style.visibility = 'visible';

    sCover.src = song.cover || '';
    sTitle.textContent = song.name || '未知曲目';
    sArtist.textContent = song.artists || '';
    $('s-id').textContent = 'ID ' + song.id;

    // 大屏背景：流光模式下清掉旧底图，模糊模式下把封面铺进去
    applyStageBg(song);

    // 按当前封面重算主题色
    applyCoverTheme(song);

    highlightRows();
    markPlayed();

    // 锁屏 / 通知栏 / 耳机的歌名封面
    updateMediaMeta(song);
  }

  /**
   * 取播放直链再交给 <audio>。
   * Worker /api/url 现在回 JSON：直链一旦拿到，后续的分段/拖动就都由浏览器
   * 直接跟网易云 CDN 谈，不再每次都穿过 Worker。
   */
  function startTrack(song, autoplay) {
    var token = ++trackToken;

    apiFetch(API + '/api/url?id=' + encodeURIComponent(song.id) + '&level=' + encodeURIComponent(settings.playLevel || 'exhigh') + tk())
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

    // 取播放地址是异步的（要过一次 Worker）。这里先把上一首停掉、把 src 断干净，
    // 否则「点了下一首，但旧歌还在响，直到新地址回来才换」——这正是用户报的那个 bug。
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch (e) { /* 忽略：断流失败也不影响后面换歌 */ }
    stopSleepFade();

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
    rememberPlayed(song);
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
      else toast('先搜一首歌，或者打开一个歌单');
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

  /**
   * 把"正在播的这首"整个丢掉：退出登录、换账号时用。
   * 只清播放状态，不动 songs / queues —— 退出登录后列表还能继续点，
   * 下一首会重新走一遍取址和绘制。
   */
  function resetPlayback() {
    trackToken += 1; // 还在路上的取址请求作废
    lyricToken += 1;

    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load(); // 真正断掉连接，否则退出后浏览器还在后台下这段音频
    } catch (e) {}

    nowPlaying = null;
    currentId = null;
    current = -1;
    lines = [];
    activeLine = -1;
    lastPosPush = 0;

    if (!stage.hidden) closeStage();
    showAmll(false);
    eachAmllView(function (v) {
      v.lines = [];
      v.running = false;
      try { v.player.setLyricLines([], 0); } catch (e) {}
    });
    syncAmllRaf();
    lyricsBox.innerHTML = '';

    // 播放条常驻：只回到空状态，不再整条收起来
    player.classList.add('is-empty');
    pTitle.textContent = '未在播放';
    pArtist.textContent = '选一首歌开始';
    $('p-id').textContent = '';
    pCover.src = DEFAULT_COVER;
    pCover.style.visibility = 'visible';

    seek.value = '0';
    fill(seek, 0);
    tCur.textContent = '00:00';
    tDur.textContent = '00:00';

    // 大屏里也可能留着上一个人的封面和歌名
    sCover.removeAttribute('src');
    sTitle.textContent = '';
    sArtist.textContent = '';
    $('s-id').textContent = '';
    sSeek.value = '0';
    fill(sSeek, 0);
    sCur.textContent = '00:00';
    sDur.textContent = '00:00';
    applyStageBg(null);

    // 锁屏：元数据和状态一起清掉，通知栏的控件会自己消失
    if (mediaOk()) {
      try { navigator.mediaSession.metadata = null; } catch (e) {}
      try { navigator.mediaSession.playbackState = 'none'; } catch (e) {}
    }

    highlightRows();
  }

  /* ------------------------------------------------------------------ 大屏 */
  function openStage() {
    // 不能看 current 下标：换过一次搜索结果，正在播的那首不在新列表里，
    // current 就会被对齐成 -1。真正的依据是 nowPlaying。
    if (!nowPlaying) {
      toast('先选一首歌');
      return;
    }
    // 侧栏和全屏大屏互斥
    if (drawerOpen) closeLyricDrawer();

    stage.hidden = false;
    stage.classList.add('is-dark'); // 大屏内一律深色，退出后整页恢复
    paintStageTheme();
    // 背景动效跟着当前是不是在放：暂停时慢速、幅度也小
    setStageMotion(audio.paused ? 0.32 : 1);
    requestAnimationFrame(function () { stage.classList.add('is-open'); });
    app.classList.add('is-stage');
    setStageView('main');

    var v = amllViews.stage;
    if (v) {
      v.player.setAlignPosition(mobileLayout() ? 0.38 : 0.5);
      v.player.setCurrentTime(lyricMs(), true);
    }
    syncViewRunning();
    syncLyrics();
  }

  function closeStage() {
    // 只停大屏这个视图；侧栏如果开着，它自己的 rAF 还要继续跑
    if (amllViews.stage) amllViews.stage.running = false;
    syncAmllRaf();

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

    var v = amllViews.stage;
    if (v) {
      // 歌词页把当前行提到屏幕中上方，封面页不用管
      v.player.setAlignPosition(mobileLayout() ? (stageView === 'lyrics' ? 0.19 : 0.38) : 0.5);
      v.player.setCurrentTime(lyricMs(), true);
    }

    syncViewRunning();
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
    document.body.classList.remove('is-queue-open');
  }

  /** 锚定式弹出：贴在触发按钮上方，放不下就翻到下方，左右夹在视口里 */
  function openQueue(anchor) {
    var btn = anchor || $('queue-btn');
    closeSleepPop();

    // 手机走底部模态面板，不做锚定
    if (isMobileUI()) {
      if (!queuePop.hidden) {
        closeQueue();
        return;
      }
      renderQueue();
      queueAnchor = btn;
      queuePop.style.left = '';
      queuePop.style.top = '';
      queuePop.hidden = false;
      document.body.classList.add('is-queue-open');
      return;
    }

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
    // 用可视视口夹取：Android 上 innerWidth / innerHeight 是布局视口，弹出的面板会伸出屏幕
    var vw = (vv && vv.width) || window.innerWidth;
    var vh = (vv && vv.height) || window.innerHeight;

    var left = Math.min(Math.max(10, r.right - box.width), vw - box.width - 10);
    var top = r.top - box.height - gap;
    if (top < 10) top = r.bottom + gap;
    if (top + box.height > vh - 10) top = Math.max(10, vh - box.height - 10);

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
    // 手机上 resize 也会跟着地址栏变化触发，别把底部面板抖没了
    if (!queuePop.hidden && !isMobileUI()) closeQueue();
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

    // 歌单搜索结果：点一下进歌单预览页（#/n/<id>）
    var plRow = e.target.closest('.pl-row');
    if (plRow && plRow.getAttribute('data-plid')) {
      e.preventDefault();
      go('#/n/' + plRow.getAttribute('data-plid'));
      return;
    }

    var row = e.target.closest('.row');
    if (!row) return;

    // 歌单多选模式：点行 = 勾选 / 取消，不触发播放
    if (selectMode && (row.getAttribute('data-q') || '') === 'playlist') {
      e.preventDefault();
      togglePick(row.getAttribute('data-id'));
      return;
    }

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
    var el = document.activeElement;
    var plRow = el && el.closest && el.closest('.pl-row');
    if (plRow && plRow.getAttribute('data-plid')) {
      e.preventDefault();
      go('#/n/' + plRow.getAttribute('data-plid'));
      return;
    }

    var row = el && el.closest && el.closest('.row');
    if (!row) return;
    e.preventDefault();
    row.click();
  });

  $('play').addEventListener('click', toggle);
  $('prev').addEventListener('click', function () { step(-1); });
  $('next').addEventListener('click', function () { step(1); });
  // 手机播放器：播控挪到封面右侧，这两个是那套按钮
  $('pm-play').addEventListener('click', toggle);
  $('pm-next').addEventListener('click', function () { step(1); });
  $('p-add').addEventListener('click', function () {
    if (!nowPlaying) {
      toast('先选一首歌');
      return;
    }
    openAddForSong(nowPlaying);
  });
  $('s-play').addEventListener('click', toggle);
  $('s-prev').addEventListener('click', function () { step(-1); });
  $('s-next').addEventListener('click', function () { step(1); });

  // 封面就是大屏入口：桌面悬停出现角标，手机直接点封面
  $('p-cover-btn').addEventListener('click', function () {
    if (!nowPlaying) {
      toast('先选一首歌');
      return;
    }
    openStage();
  });
  $('stage-close').addEventListener('click', closeStage);
  $('s-lyrics').addEventListener('click', function () {
    // 再点一次退出歌词页（封面页 ↔ 歌词页）
    setStageView(stageView === 'lyrics' ? 'main' : 'lyrics');
  });
  $('s-dl2').addEventListener('click', downloadCurrent);
  $('s-queue').addEventListener('click', function () { openQueue(this); });
  $('queue-btn').addEventListener('click', function () { openQueue(this); });
  $('lyric-btn').addEventListener('click', toggleLyricDrawer);
  $('lyric-close').addEventListener('click', closeLyricDrawer);

  audio.addEventListener('play', function () {
    document.body.classList.add('is-audio-playing');
    syncAmllPlayState();
    waveKick();
    setStageMotion(1);
  });

  audio.addEventListener('pause', function () {
    document.body.classList.remove('is-audio-playing');
    syncAmllPlayState();
    waveKick();
    // 暂停后背景几乎停住，只留一点点漂移，不喧宾夺主
    setStageMotion(0.32);
  });

  // 拖动/点歌词跳转后立刻对齐，别等下一帧
  audio.addEventListener('seeked', function () {
    eachAmllView(function (v) {
      if (v.running) v.player.setCurrentTime(lyricMs(), true);
    });
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
    syncLiteDrawer();
  });

  audio.addEventListener('ended', function () {
    // 「播完当前这首」的睡眠定时：到这儿就停，不再自动切下一首
    if (sleepTrackEnd) {
      clearSleepAll();
      paintSleepUI();
      audio.pause();
      toast('睡眠定时：这首播完已暂停');
      return;
    }
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
    // 切歌时会主动 removeAttribute('src') 断流，那不是真的加载失败
    if (!audio.getAttribute('src')) return;
    if (currentId == null) return;
    toast('这首放不了：可能是 VIP、版权受限或已下架');
  });

  /* ------------------------------------- 系统媒体控制（锁屏 / 通知栏 / 耳机线控）
     手机锁屏、下拉通知栏、蓝牙耳机、车载、浏览器媒体键都走 MediaSession 这一套。
     这里只做「把页面里的播放器挂到系统上」，真正的播放逻辑还是 play / toggle / step。
     不支持 MediaSession 的浏览器（部分 Firefox、老 Safari）会整段跳过，不影响播放。 */
  var MEDIA_SKIP = 10;  // 锁屏快进/快退的默认步长（秒）
  var lastPosPush = 0;  // setPositionState 别推太勤：timeupdate 一秒要来好几次

  function mediaOk() {
    return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
  }

  /** 锁屏封面：把 400 的缩略图换成 512，否则铺到锁屏上会糊 */
  function mediaArtwork(song) {
    var cover = (song && song.cover) || '';
    if (!cover) return [];
    var big = /param=\d+y\d+/.test(cover) ? cover.replace(/param=\d+y\d+/, 'param=512y512') : cover;
    return [
      { src: big, sizes: '512x512', type: 'image/jpeg' },
      { src: cover, sizes: '400x400', type: 'image/jpeg' }
    ];
  }

  function updateMediaMeta(song) {
    if (!mediaOk() || typeof window.MediaMetadata !== 'function') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: (song && song.name) || '未知曲目',
        artist: (song && song.artists) || '',
        album: (song && song.album) || '',
        artwork: mediaArtwork(song)
      });
    } catch (e) { /* 造不出 metadata 就跳过，别影响播放 */ }
  }

  /** 锁屏上的播放状态：playing / paused / none */
  function syncMediaState() {
    if (!mediaOk()) return;
    try {
      navigator.mediaSession.playbackState =
        audio.paused ? (currentId == null ? 'none' : 'paused') : 'playing';
    } catch (e) {}
  }

  /** 锁屏进度条：duration 还没拿到时推会抛错，所以先判掉 */
  function updateMediaPosition(force) {
    if (!mediaOk() || typeof navigator.mediaSession.setPositionState !== 'function') return;
    var d = audio.duration;
    if (!isFinite(d) || d <= 0) return;

    var now = Date.now();
    if (!force && now - lastPosPush < 900) return;  // 一秒推一次足够
    lastPosPush = now;

    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: audio.playbackRate || 1,
        // 位置越界（尤其是快进到结尾）会让它抛错，夹一下
        position: Math.min(Math.max(audio.currentTime || 0, 0), d)
      });
    } catch (e) {}
  }

  function seekToMedia(t) {
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    var v = Math.min(Math.max(t, 0), Math.max(audio.duration - 0.25, 0));
    if (typeof audio.fastSeek === 'function') audio.fastSeek(v);
    else audio.currentTime = v;
    updateMediaPosition(true);
  }

  function setupMediaSession() {
    if (!mediaOk()) return;
    var ms = navigator.mediaSession;

    // 各家支持的动作不一样，遇到不认识的会抛，所以一个一个兜住
    function on(name, fn) {
      try { ms.setActionHandler(name, fn); } catch (e) {}
    }

    on('play', function () {
      if (currentId == null) {
        if (songs.length) play(0);
        return;
      }
      audio.play().catch(function () {});
    });

    on('pause', function () { audio.pause(); });
    // 绑上 stop 当暂停，否则部分 Android 会显示一个按了没反应的停止键
    on('stop', function () { audio.pause(); });

    // 锁屏上的「上一首」按系统惯例：播过 3 秒先回本曲开头，再按才切上一首。
    // 页面里的上一首按钮不受影响，仍然是直接切歌。
    on('previoustrack', function () {
      if (audio.currentTime > 3) {
        seekToMedia(0);
        return;
      }
      step(-1);
    });

    on('nexttrack', function () { step(1); });

    on('seekbackward', function (d) {
      seekToMedia((audio.currentTime || 0) - ((d && d.seekOffset) || MEDIA_SKIP));
    });
    on('seekforward', function (d) {
      seekToMedia((audio.currentTime || 0) + ((d && d.seekOffset) || MEDIA_SKIP));
    });
    on('seekto', function (d) {
      if (d && typeof d.seekTime === 'number') seekToMedia(d.seekTime);
    });
  }

  // 状态/进度跟着 <audio> 走；另外挂监听，不动上面已有的那几个
  audio.addEventListener('play', function () { syncMediaState(); updateMediaPosition(true); });
  audio.addEventListener('pause', function () { syncMediaState(); updateMediaPosition(true); });
  audio.addEventListener('timeupdate', function () { updateMediaPosition(false); });
  audio.addEventListener('loadedmetadata', function () { updateMediaPosition(true); });
  audio.addEventListener('seeked', function () { updateMediaPosition(true); });
  // 放完自动切歌时不会触发 pause，状态得自己对齐
  audio.addEventListener('ended', function () { syncMediaState(); updateMediaPosition(true); });

  setupMediaSession();

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
      // 弹出菜单 → 歌词栏 → 歌词页 → 封面页，逐层退
      if (queuePop && !queuePop.hidden) closeQueue();
      else if (drawerOpen) closeLyricDrawer();
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
    apiFetch(API + '/api/url?id=' + encodeURIComponent(song.id) + '&level=' + encodeURIComponent(settings.downloadLevel || 'exhigh') + tk())
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
  var LEVELS = ['standard', 'higher', 'exhigh', 'lossless', 'hires'];
  var darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

  function loadSettings() {
    var out = {
      scheme: 'auto', seed: '', seedPage: 'cover', seedStage: 'cover',
      bgMode: 'none', bgData: '', bgUrl: '', bgBlur: 10, bgRefresh: 'open', bgFetchedAt: 0,
      lyricScale: 1, trans: true, amll: true, bold: false, debug: false, offset: 0,
      sideCollapsed: false, drawerLyric: 'amll',
      stageFx: true,                 // 大屏背景：true = 动态流光，false = 封面高斯模糊
      playLevel: 'exhigh', downloadLevel: 'exhigh'
    };
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var o = JSON.parse(raw) || {};
        if (o.scheme === 'auto' || o.scheme === 'light' || o.scheme === 'dark') out.scheme = o.scheme;
        if (typeof o.seed === 'string' && /^#[0-9a-f]{6}$/i.test(o.seed)) out.seed = o.seed;
        // 旧版本只有 seedMode：split = 主页背景 + 大屏封面
        var legacy = o.seedMode;
        if (o.seedPage === 'cover' || o.seedPage === 'bg' || o.seedPage === 'custom') out.seedPage = o.seedPage;
        else if (legacy === 'bg' || legacy === 'split') out.seedPage = 'bg';
        else if (legacy === 'custom' || out.seed) out.seedPage = 'custom';

        if (o.seedStage === 'cover' || o.seedStage === 'bg') out.seedStage = o.seedStage;
        else if (legacy === 'bg') out.seedStage = 'bg';
        else if (legacy === 'custom' || out.seed) out.seedStage = 'custom';
        if (o.bgMode === 'none' || o.bgMode === 'local' || o.bgMode === 'url') out.bgMode = o.bgMode;
        if (typeof o.bgData === 'string' && /^data:image\//.test(o.bgData)) out.bgData = o.bgData;
        if (typeof o.bgUrl === 'string' && /^https?:\/\//.test(o.bgUrl)) out.bgUrl = o.bgUrl;
        if (typeof o.bgBlur === 'number' && o.bgBlur >= 0 && o.bgBlur <= 40) out.bgBlur = o.bgBlur;
        if (o.bgRefresh === 'open' || o.bgRefresh === 'daily' || o.bgRefresh === 'weekly' || o.bgRefresh === 'never') {
          out.bgRefresh = o.bgRefresh;
        }
        if (typeof o.bgFetchedAt === 'number') out.bgFetchedAt = o.bgFetchedAt;
        if (typeof o.lyricScale === 'number' && o.lyricScale >= 0.8 && o.lyricScale <= 1.5) {
          out.lyricScale = o.lyricScale;
        }
        if (typeof o.trans === 'boolean') out.trans = o.trans;
        if (typeof o.amll === 'boolean') out.amll = o.amll;
        if (typeof o.bold === 'boolean') out.bold = o.bold;
        if (typeof o.debug === 'boolean') out.debug = o.debug;
        if (typeof o.offset === 'number' && Math.abs(o.offset) <= 2000) out.offset = o.offset;
        if (typeof o.sideCollapsed === 'boolean') out.sideCollapsed = o.sideCollapsed;
        if (o.drawerLyric === 'amll' || o.drawerLyric === 'lite') out.drawerLyric = o.drawerLyric;
        if (typeof o.stageFx === 'boolean') out.stageFx = o.stageFx;
        if (LEVELS.indexOf(o.playLevel) >= 0) out.playLevel = o.playLevel;
        if (LEVELS.indexOf(o.downloadLevel) >= 0) out.downloadLevel = o.downloadLevel;
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
    // 大屏背景两套：动态流光 / 封面高斯模糊，CSS 用 data-fx 切
    stage.setAttribute('data-fx', settings.stageFx === false ? 'blur' : 'aurora');
    document.body.classList.toggle('is-debug', settings.debug === true);
    app.classList.toggle('is-side-collapsed', settings.sideCollapsed === true);
    applyBackground();
    applyScheme();
    syncSettingsUI();
  }

  var settingsDlg = $('settings');
  var segScheme = $('seg-scheme');
  var segDrawer = $('seg-drawer');
  var setNav = $('set-nav');
  var setPanes = $('set-panes');
  var setSleep = $('set-sleep');
  var setModeLabel = $('set-mode-label');
  var setStageFx = $('set-stage-fx');
  var setPlayLevel = $('set-play-level');
  var setDlLevel = $('set-dl-level');
  var seedPageCover = $('seed-page-cover');
  var seedPageBg = $('seed-page-bg');
  var seedStageCover = $('seed-stage-cover');
  var seedStageBg = $('seed-stage-bg');
  var seedColor = $('seed-color');
  var segBg = $('seg-bg');
  var bgLocalRow = $('bg-local-row');
  var bgUrlRow = $('bg-url-row');
  var bgBlurRow = $('bg-blur-row');
  var bgNote = $('bg-note');
  var bgFile = $('bg-file');
  var bgLink = $('bg-link');
  var bgRefreshRow = $('bg-refresh-row');
  var bgRefreshSel = $('bg-refresh');
  var bgBlur = $('bg-blur');
  var bgBlurVal = $('bg-blur-val');
  var bgEl = $('site-bg');
  var bgHue = null;
  var setTrans = $('set-trans');
  var setAmll = $('set-amll');
  var amllStatusEl = $('amll-status');
  var amllLoadBtn = $('amll-load');
  var amllHintEl = $('amll-hint');
  var setBold = $('set-bold');
  var setDebug = $('set-debug');
  var setOffset = $('set-offset');
  var setOffsetVal = $('set-offset-val');
  var setSize = $('set-size');
  var setSizeVal = $('set-size-val');

  /**
   * 设置 → 歌词里的「组件状态」：把 AMLL 的真实状态画出来，并决定按钮能不能点。
   * 关掉 AMLL 开关时显示「已关闭」—— 这时候加载也没意义，按钮一并禁用。
   */
  function refreshAmllStatus() {
    if (!amllStatusEl) return;

    var off = !wantAmll();
    var st = amll.status;

    var key;
    var text;
    var hint;
    var canLoad = false;
    var btnText = '加载组件';

    if (off) {
      key = 'off';
      text = '已关闭';
      hint = 'AMLL 开关关着，大屏和歌词栏都用轻量歌词。打开开关后可以在这里手动加载组件。';
    } else if (st === 1) {
      key = 'loading';
      text = '加载中';
      hint = '正在下载 AMLL 组件（约 390KB），首次打开可能要几秒。';
      btnText = '加载中…';
    } else if (st === 2) {
      key = 'ready';
      text = '已就绪';
      hint = '组件已加载' + (amll.src === 'local' ? '（本地副本 /vendor）' : amll.src === 'cdn' ? '（CDN）' : '') +
        '，大屏与歌词栏都是逐字点亮。';
      btnText = '已加载';
    } else if (st === 3) {
      key = 'failed';
      text = '加载失败';
      hint = 'CDN 和本地副本都没取到，可能是网络慢或广告拦截插件挡了脚本。可以点按钮重试。';
      canLoad = true;
      btnText = '重试加载';
    } else {
      key = 'idle';
      text = '未加载';
      hint = '组件还没下载。点下面的按钮立即加载；不管它的话，打开大屏或歌词栏时也会自动加载。';
      canLoad = true;
    }

    amllStatusEl.textContent = text;
    amllStatusEl.setAttribute('data-s', key);
    if (amllHintEl) amllHintEl.textContent = hint;

    if (amllLoadBtn) {
      amllLoadBtn.textContent = btnText;
      amllLoadBtn.disabled = !canLoad;
      amllLoadBtn.setAttribute('aria-busy', st === 1 && !off ? 'true' : 'false');
    }
  }

  if (amllLoadBtn) {
    amllLoadBtn.addEventListener('click', function () {
      if (!wantAmll()) {
        toast('先在设置里打开「AMLL 逐字歌词」');
        return;
      }
      if (amll.status === 1) return;

      // 失败过就把状态机和等待队列清干净，否则 loadAmll() 会直接返回 false
      if (amll.status === 3) {
        amll.status = 0;
        amll.src = '';
        amll.waiters = [];
      }

      var p = loadAmll();
      refreshAmllStatus();

      p.then(function (ok) {
        refreshAmllStatus();
        if (!ok) {
          toast('AMLL 加载失败，可以稍后重试');
          return;
        }
        toast('AMLL 组件已就绪');
        // 正在放歌的话立刻换成逐字歌词，不用重开大屏
        if (lastLyric) applyLyric();
        amllPrefetched = true; // 已经手动下过了，别再触发预取
      });
    });
  }

  function syncSettingsUI() {
    var btns = segScheme.querySelectorAll('button');
    for (var i = 0; i < btns.length; i += 1) {
      btns[i].setAttribute('aria-checked', btns[i].getAttribute('data-v') === settings.scheme ? 'true' : 'false');
    }

    if (setStageFx) setStageFx.checked = settings.stageFx !== false;

    if (segDrawer) {
      var dbtns = segDrawer.querySelectorAll('button');
      for (var d = 0; d < dbtns.length; d += 1) {
        dbtns[d].setAttribute('aria-checked', dbtns[d].getAttribute('data-v') === settings.drawerLyric ? 'true' : 'false');
      }
    }

    var hasBg = !!bgSource();
    seedPageCover.setAttribute('aria-pressed', settings.seedPage === 'cover' ? 'true' : 'false');
    seedPageBg.setAttribute('aria-pressed', settings.seedPage === 'bg' ? 'true' : 'false');
    seedStageCover.setAttribute('aria-pressed', settings.seedStage === 'cover' ? 'true' : 'false');
    seedStageBg.setAttribute('aria-pressed', settings.seedStage === 'bg' ? 'true' : 'false');
    seedPageBg.disabled = !hasBg;
    seedStageBg.disabled = !hasBg;

    var bgBtns = segBg.querySelectorAll('button');
    for (var j = 0; j < bgBtns.length; j += 1) {
      bgBtns[j].setAttribute('aria-checked', bgBtns[j].getAttribute('data-v') === settings.bgMode ? 'true' : 'false');
    }
    bgLocalRow.hidden = settings.bgMode !== 'local';
    bgUrlRow.hidden = settings.bgMode !== 'url';
    bgBlurRow.hidden = settings.bgMode === 'none';
    bgRefreshRow.hidden = settings.bgMode !== 'url';
    bgRefreshSel.value = settings.bgRefresh || 'open';
    bgNote.hidden = settings.bgMode === 'none';
    if (settings.bgMode === 'url') bgLink.value = settings.bgUrl || '';
    bgBlur.value = String(settings.bgBlur || 0);
    bgBlurVal.textContent = (settings.bgBlur || 0) + 'px';

    // 色板预览：自定义色就显示它，否则按当前取色来源算一个
    var hue = activeHue();
    var preview = settings.seedPage === 'custom' && settings.seed
      ? settings.seed
      : (hue ? oklchToHex(toneL(55), hue.c, hue.h) : '#8B5643');
    document.documentElement.style.setProperty('--seed-preview', preview);

    setTrans.checked = settings.trans;
    setAmll.checked = settings.amll !== false;
    refreshAmllStatus();
    setBold.checked = settings.bold === true;
    setDebug.checked = settings.debug === true;
    setOffset.value = String(settings.offset || 0);
    setOffsetVal.textContent = (settings.offset > 0 ? '+' : '') + (settings.offset || 0) + 'ms';
    setSize.value = String(settings.lyricScale);
    setSizeVal.textContent = Math.round(settings.lyricScale * 100) + '%';

    if (setModeLabel) setModeLabel.textContent = MODE_LABEL[mode];
    if (setPlayLevel) setPlayLevel.value = settings.playLevel;
    if (setDlLevel) setDlLevel.value = settings.downloadLevel;
    if (setSleep) setSleep.value = sleepSelectValue();
    refreshLibCount();
  }

  function openSettings() {
    syncSettingsUI();
    if (setNav && !setNav.querySelector('.set-tab.is-on')) setSettingsPanel('look');
    loadAccountPanel();

    // 手机：设置是独立页面（和首页/搜索平级），不是弹窗
    if (isMobileUI()) {
      if (settingsDlg.open) settingsDlg.close();
      go('#/settings');
      return;
    }

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

  if (segDrawer) {
    segDrawer.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      settings.drawerLyric = b.getAttribute('data-v') === 'lite' ? 'lite' : 'amll';
      saveSettings();
      syncSettingsUI();
      // 已经开着歌词栏的话立刻换渲染器
      if (drawerOpen) refreshDrawerRenderer();
    });
  }

  /* 设置分组：桌面左侧竖排，手机是一行横向 chip；切换只切 hidden */
  function setSettingsPanel(name) {
    if (!setNav || !setPanes) return;
    var tabs = setNav.querySelectorAll('.set-tab');
    for (var i = 0; i < tabs.length; i += 1) {
      var on = tabs[i].getAttribute('data-panel') === name;
      tabs[i].classList.toggle('is-on', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var panes = setPanes.querySelectorAll('.group');
    for (var j = 0; j < panes.length; j += 1) {
      panes[j].hidden = panes[j].getAttribute('data-panel') !== name;
    }
  }

  if (setNav) {
    setNav.addEventListener('click', function (e) {
      var b = e.target.closest('.set-tab');
      if (!b) return;
      setSettingsPanel(b.getAttribute('data-panel'));
    });
  }

  /* 侧边栏收起 / 展开（桌面）。状态存本地，换页面也保持 */
  $('side-collapse').addEventListener('click', function () {
    settings.sideCollapsed = true;
    saveSettings();
    app.classList.add('is-side-collapsed');
  });

  $('side-expand').addEventListener('click', function () {
    settings.sideCollapsed = false;
    saveSettings();
    app.classList.remove('is-side-collapsed');
  });

  function pickSeed(scope, mode) {
    if (mode === 'bg' && !bgSource()) {
      toast('先选一张背景图');
      return;
    }
    if (scope === 'page') settings.seedPage = mode;
    else settings.seedStage = mode;
    saveSettings();
    paintTheme();
    syncSettingsUI();
  }

  seedPageCover.addEventListener('click', function () {
    settings.seed = '';
    pickSeed('page', 'cover');
  });

  seedPageBg.addEventListener('click', function () { pickSeed('page', 'bg'); });
  seedStageCover.addEventListener('click', function () { pickSeed('stage', 'cover'); });
  seedStageBg.addEventListener('click', function () { pickSeed('stage', 'bg'); });

  seedColor.addEventListener('input', function () {
    settings.seed = seedColor.value;
    settings.seedPage = 'custom';
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

  /** 网络背景要不要重新拉：open=每次打开，daily/weekly 按时间，never 只手动 */
  function shouldRefreshBg() {
    if (settings.bgMode !== 'url' || !settings.bgUrl) return false;
    if (!/^https?:/i.test(settings.bgUrl)) return false;
    if (settings.bgRefresh === 'open') return true;
    var age = Date.now() - (settings.bgFetchedAt || 0);
    if (settings.bgRefresh === 'daily') return age > 864e5;
    if (settings.bgRefresh === 'weekly') return age > 6048e5;
    return false;
  }

  function bgBustedUrl(url) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
  }

  function applyBackground() {
    var url = bgSource();

    if (url && settings.bgMode === 'url' && shouldRefreshBg()) {
      settings.bgFetchedAt = Date.now();
      saveSettings();
      url = bgBustedUrl(url);
    }
    if (!url) {
      bgEl.style.backgroundImage = '';
      bgEl.classList.remove('is-on');
      bgHue = null;
      paintTheme();
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
      paintTheme();
      syncSettingsUI();
    };
    img.onerror = function () {
      bgHue = null;
      paintTheme();
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
      settings.bgFetchedAt = Date.now();
      saveSettings();
      applyBackground();
      syncSettingsUI();
      toast('背景已更新');
    };
    test.onerror = function () { toast('这张图加载失败'); };
    test.src = u;
  });

  bgRefreshSel.addEventListener('change', function () {
    settings.bgRefresh = bgRefreshSel.value;
    saveSettings();
    if (settings.bgMode === 'url' && settings.bgRefresh !== 'never') {
      settings.bgFetchedAt = 0; // 立刻按新策略拉一次
      applyBackground();
    }
    syncSettingsUI();
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
    if (Object.keys(amllViews).length) applyLyric();
  });

  setOffset.addEventListener('input', function () {
    settings.offset = Number(setOffset.value);
    setOffsetVal.textContent = (settings.offset > 0 ? '+' : '') + settings.offset + 'ms';
    saveSettings();

    // 立刻按新偏移对齐，不用等下一次 timeupdate
    eachAmllView(function (v) {
      if (v.running) v.player.setCurrentTime(lyricMs(), true);
    });
    syncLyrics();
    liteActive = -1;
    syncLiteDrawer(true);
  });

  setStageFx.addEventListener('change', function () {
    settings.stageFx = setStageFx.checked;
    saveSettings();
    applySettings();
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
    refreshAmllStatus();
    saveSettings();
    // 关掉 AMLL 后侧栏就没有渲染器了，直接收起来，别留一屏旧歌词
    if (!settings.amll) closeLyricDrawer();
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
  var pendingSong = null;      // 单曲加入时的待加入歌曲
  var pendingBatch = null;     // 多选批量加入时的歌曲数组
  var newPendingSongs = [];    // 「新建歌单并加入」要带过去的歌（0/1/多）

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

  /* ---------------------------------------------------------- 最近播放 */
  var PLAYED_KEY = 'music-played';
  var PLAYED_MAX = 60;    // 存多少条
  var PLAYED_SHOW = 12;   // 侧栏显示多少条
  var playedCache = [];

  function loadPlayed() {
    try {
      var arr = JSON.parse(localStorage.getItem(PLAYED_KEY) || '[]');
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (x) { return x && x.id && x.name; });
    } catch (e) {
      return [];
    }
  }

  function savePlayed(arr) {
    try { localStorage.setItem(PLAYED_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  function rememberPlayed(song) {
    if (!song || !song.id) return;
    var arr = loadPlayed().filter(function (x) { return String(x.id) !== String(song.id); });
    arr.unshift({
      id: song.id,
      name: song.name || '未知曲目',
      artists: song.artists || '',
      album: song.album || '',
      duration: Number(song.duration) || 0,
      cover: song.cover || '',
      at: Date.now()
    });
    savePlayed(arr.slice(0, PLAYED_MAX));
    renderPlayed();
  }

  function renderPlayed() {
    var ul = $('side-played');
    if (!ul) return;

    var arr = loadPlayed();
    playedCache = arr.slice(0, PLAYED_SHOW);
    ul.innerHTML = '';

    playedCache.forEach(function (song, i) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'side-item side-played-item';
      b.setAttribute('data-pi', String(i));
      b.title = song.name + (song.artists ? ' · ' + song.artists : '');

      var img = document.createElement('img');
      img.className = 'played-cover';
      img.alt = '';
      img.loading = 'lazy';
      if (song.cover) img.src = song.cover;

      var main = document.createElement('span');
      main.className = 'played-main';
      var t = document.createElement('span');
      t.className = 'played-name';
      t.textContent = song.name;
      var a = document.createElement('span');
      a.className = 'played-artist';
      a.textContent = song.artists || '未知艺人';
      main.appendChild(t);
      main.appendChild(a);

      b.appendChild(img);
      b.appendChild(main);
      li.appendChild(b);
      ul.appendChild(li);
    });

    $('played-empty').hidden = playedCache.length > 0;
    markPlayed();
  }

  function markPlayed() {
    var items = document.querySelectorAll('.side-played-item');
    for (var i = 0; i < items.length; i += 1) {
      var idx = Number(items[i].getAttribute('data-pi'));
      var song = playedCache[idx];
      items[i].classList.toggle('is-on', !!(song && currentId != null && String(song.id) === String(currentId)));
    }
  }

  function playFromPlayed(i) {
    var arr = loadPlayed();
    if (!arr[i]) return;
    songs = arr.slice();
    queues.played = songs;
    activeQueue = 'played';
    play(i);
    closeSidebar();
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

  $('side-played').addEventListener('click', function (e) {
    var row = e.target.closest('[data-pi]');
    if (row) playFromPlayed(Number(row.getAttribute('data-pi')));
  });

  $('played-clear').addEventListener('click', function () {
    if (!loadPlayed().length) return;
    savePlayed([]);
    renderPlayed();
    toast('已清空最近播放');
  });

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

  /* 侧边栏底部那个「这个站是怎么做的」：看着像卡片，其实是个按钮 */
  var aboutDlg = $('dlg-about');
  $('about-btn').addEventListener('click', function () {
    closeSidebar();
    if (aboutDlg && !aboutDlg.open) aboutDlg.showModal();
  });
  $('about-close').addEventListener('click', function () {
    if (aboutDlg.open) aboutDlg.close();
  });
  aboutDlg.addEventListener('click', function (e) {
    if (e.target === aboutDlg) aboutDlg.close();
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
      if (!o || !o.exp || o.exp <= Date.now()) return null;
      // 账号密码登录有签名 token；扫码登录只有 musicU（MUSIC_U 只存在本机）——
      // 以前这里死要求 token，导致扫码登录一刷新就掉登录
      if (!o.token && !o.musicU) return null;
      return o;
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
    accInfo = null;
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

  function doLogout() {
    closeSidebar();
    resetPlayback(); // 先停歌：上一个人的歌不该在登录页后面继续响
    saveSession(null);
    accInfo = null; // 账号面板的缓存也要清，否则还显示上一个人
    refreshAccountUI();
    $('login-name').value = '';
    loginMsg.textContent = '';
    if (settingsDlg.open) settingsDlg.close();
    setTimeout(function () { $('login-name').focus(); }, 60);
  }

  $('user-logout').addEventListener('click', doLogout);
  $('set-logout').addEventListener('click', doLogout);

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
      s.src = '/js/qrcode.js?v=20261106c';
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
    accInfo = null;
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
  var views = {
    home: $('view-home'),
    search: $('view-search'),
    playlist: $('view-playlist'),
    settings: $('view-settings')
  };

  function showView(name) {
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
    if (name !== 'search') app.classList.remove('is-searching');
    mainEl.scrollTop = 0;
    markSidebar();
    syncTabbar();
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
    if (h === 'settings') {
      if (!isMobileUI()) {
        // 桌面没有设置页，回首页并弹窗
        showView('home');
        loadHome();
        openSettings();
        return;
      }
      showView('settings');
      return;
    }
    showView('home');
    loadHome();
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  /* -------------------------------------------------------- 手机底部导航 */
  var tabbar = $('tabbar');

  function syncTabbar() {
    if (!tabbar) return;
    var h = location.hash.replace(/^#\/?/, '');
    // 歌单页属于「首页」那条线，不单独占一个 tab
    var tab = h === 'search' ? 'search' : h === 'settings' ? 'settings' : 'home';
    var tabs = tabbar.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i += 1) {
      var on = tabs[i].getAttribute('data-tab') === tab;
      tabs[i].classList.toggle('is-on', on);
      if (on) tabs[i].setAttribute('aria-current', 'page');
      else tabs[i].removeAttribute('aria-current');
    }
  }

  if (tabbar) {
    tabbar.addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (!b) return;
      var tab = b.getAttribute('data-tab');
      if (tab === 'settings') {
        openSettings();
        return;
      }
      go(tab === 'search' ? '#/search' : '#/home');
    });
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
    setSelectMode(false);
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

  /** 歌单骨架屏：等接口的时候先把版面撑起来，别让页面空着抖一下 */
  function renderPlaylistSkeleton() {
    var tracks = $('pl-tracks');
    tracks.innerHTML = '';
    for (var i = 0; i < 8; i += 1) {
      var li = document.createElement('li');
      li.innerHTML =
        '<div class="sk-row"><div class="sk-img xs"></div>' +
        '<div class="sk-stack"><div class="sk-line"></div><div class="sk-line short"></div></div></div>';
      tracks.appendChild(li);
    }
    $('pl-empty').hidden = true;
    $('pl-edit').hidden = true;
    $('pl-import').hidden = true;
    $('pl-sync').hidden = true;
    $('pl-select').hidden = true;
    $('pl-delete').hidden = true;
  }

  function openRemote(id) {
    setSelectMode(false);
    if (!/^\d{3,20}$/.test(id)) {
      go('#/home');
      return;
    }

    $('pl-kicker').textContent = '网易云歌单';
    $('pl-name').textContent = '加载中…';
    $('pl-desc').textContent = '';
    $('pl-cover').src = DEFAULT_COVER;
    renderPlaylistSkeleton();

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

    var localRec = findPlaylist(data.id);
    // 只要是从网易云来的，就带 neteaseId：本地副本靠它判断「能不能同步」
    var neteaseId = data.neteaseId || (localRec && localRec.neteaseId) || '';
    syncNeteaseId = neteaseId ? String(neteaseId) : '';

    $('pl-cover').src = data.cover || DEFAULT_COVER;
    $('pl-name').textContent = data.name;
    $('pl-kicker').textContent = data.source === 'local'
      ? (neteaseId ? '网易云 · 本地副本' : '我的歌单')
      : '网易云 · ' + (data.creator || '');
    $('pl-desc').textContent = data.description || data.tracks.length + ' 首';
    $('pl-edit').hidden = data.source !== 'local';
    $('pl-import').hidden = !(data.source === 'netease' && !localRec);
    // 只有「已经导入到本地」的网易云歌单才谈得上同步：
    // 远端预览页还没导入时，这里只该出现「导入到我的歌单」
    $('pl-sync').hidden = !(neteaseId && findLocalByNetease(neteaseId));
    // 只有能改的本地歌单才给多选删除
    $('pl-select').hidden = data.source !== 'local' || !data.tracks.length;
    $('pl-delete').hidden = data.source !== 'local';
    renderSyncNote();

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
      syncedAt: Date.now(), // 导入的那一刻就等于同步过一次
      tracks: currentPlaylist.tracks.slice()
    };

    var old = findPlaylist(p.id);
    if (old) {
      old.tracks = p.tracks;
      old.name = p.name;
      old.cover = p.cover;
      old.syncedAt = Date.now();
    } else {
      lib.playlists.unshift(p);
    }
    if (!saveLib()) return;

    renderSidebar();
    go('#/pl/' + p.id);
    toast('已导入「' + p.name + '」');
  });

  /* ---------------------------------------------------- 网易云歌单同步 */
  // 当前页面对应的网易云歌单 ID（只有本地副本才有）
  var syncNeteaseId = '';
  var syncingNow = false;

  function findLocalByNetease(id) {
    for (var i = 0; i < lib.playlists.length; i += 1) {
      if (String(lib.playlists[i].neteaseId || '') === String(id)) return lib.playlists[i];
    }
    return null;
  }

  function fmtClock(ts) {
    var d = new Date(ts);
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
      ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  /**
   * 歌单头下面那行小字：没传文字就按当前歌单算。
   * 有 text 时是「同步中 / 同步失败」的即时状态，会带 is-error 变红。
   */
  function renderSyncNote(text, isError) {
    var note = $('pl-sync-note');
    if (!note) return;

    if (text) {
      note.hidden = false;
      note.textContent = text;
      note.classList.toggle('is-error', !!isError);
      return;
    }

    var rec = syncNeteaseId ? findLocalByNetease(syncNeteaseId) : null;
    if (!rec) {
      note.hidden = true;
      note.textContent = '';
      return;
    }

    note.hidden = false;
    note.classList.remove('is-error');
    note.textContent = rec.syncedAt
      ? '上次同步 ' + fmtClock(rec.syncedAt) + ' · 本地 ' + (rec.tracks || []).length + ' 首'
      : '还没同步过，点「同步」能把网易云上新增的歌曲补进来';
  }

  /**
   * 同步：只做加法 —— 把网易云上有、本地没有的歌追加到末尾，本地手动加的歌不动。
   * 本地早期导入可能带重复，顺便按 id 去重（保留第一次出现的位置）。
   */
  function syncFromNetease() {
    if (syncingNow) return;

    var btn = $('pl-sync');
    var remoteId = syncNeteaseId;
    if (!remoteId) return;

    var rec = findLocalByNetease(remoteId);
    if (!rec) {
      toast('这个歌单还没导入，先点「导入到我的歌单」');
      return;
    }
    if (!API) {
      toast('还没配置 Worker 地址，没法同步');
      return;
    }

    syncingNow = true;
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = '同步中…';
    renderSyncNote('正在从网易云拉取最新曲目…');

    apiFetch(withK(API + '/api/playlist?id=' + encodeURIComponent(remoteId)))
      .then(authGuard)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (d.error) throw new Error(d.error);

        var seen = {};
        var merged = [];
        var dup = 0;

        (rec.tracks || []).forEach(function (t) {
          if (!t || t.id == null) return;
          if (seen[t.id]) { dup += 1; return; }
          seen[t.id] = 1;
          merged.push(t);
        });

        var added = 0;
        (d.tracks || []).forEach(function (t) {
          if (!t || t.id == null) return;
          if (seen[t.id]) return;
          seen[t.id] = 1;
          merged.push(t);
          added += 1;
        });

        // 云端删掉的歌不自动删：本地可能还有手动加进去的，
        // 只把名字 / 封面 / 简介对齐到云端，避免下次同步又对不上
        rec.tracks = merged;
        if (d.name) rec.name = d.name;
        if (d.cover) rec.cover = d.cover;
        if (d.description) rec.description = d.description;
        rec.syncedAt = Date.now();

        if (!saveLib()) return;

        renderSidebar();

        // 正看着这个歌单就地刷新（远端预览页本来就显示云端数据，不用动）
        if (currentPlaylist && currentPlaylist.source === 'local' && currentPlaylist.id === rec.id) {
          openLocal(rec.id);
        } else {
          renderSyncNote();
        }

        var msg;
        if (added && dup) msg = '同步完成：新增 ' + added + ' 首，去重 ' + dup + ' 首';
        else if (added) msg = '同步完成：新增 ' + added + ' 首';
        else if (dup) msg = '已是最新（顺手去重 ' + dup + ' 首）';
        else msg = '已是最新，共 ' + merged.length + ' 首';
        toast(msg);
      })
      .catch(function (err) {
        renderSyncNote('同步失败：' + err.message + '（歌单可能已在网易云删除，或登录凭证失效）', true);
        toast('同步失败：' + err.message);
      })
      .then(function () {
        syncingNow = false;
        btn.disabled = false;
        btn.classList.remove('is-loading');
        btn.removeAttribute('aria-busy');
        btn.textContent = '同步';
      });
  }

  $('pl-sync').addEventListener('click', syncFromNetease);

  /* ---------------------------------------------------- 歌单多选删除 */
  var selectMode = false;
  var picked = {};        // songId -> true
  var bulkArmTimer = 0;   // 「确认删除」的两段式计时

  function pickCount() {
    var n = 0;
    for (var k in picked) if (picked[k]) n += 1;
    return n;
  }

  function markPickedRows() {
    var rows = document.querySelectorAll('#pl-tracks .row');
    for (var i = 0; i < rows.length; i += 1) {
      rows[i].classList.toggle('is-picked', !!picked[rows[i].getAttribute('data-id')]);
    }
  }

  function renderBulk() {
    if (!selectMode) return;
    var n = pickCount();
    var total = (currentPlaylist && currentPlaylist.tracks ? currentPlaylist.tracks.length : 0);
    $('pl-bulk-count').textContent = '已选 ' + n + ' / ' + total + ' 首';
    $('pl-bulk-add').disabled = n === 0;
    $('pl-bulk-del').disabled = n === 0;
    $('pl-bulk-all').textContent = n && n === total ? '取消全选' : '全选';
  }

  /** 进出多选：行前面的序号换成勾选圈，头下面出现操作条 */
  function setSelectMode(on) {
    selectMode = !!on;
    if (!selectMode) picked = {};

    var view = $('view-playlist');
    if (view) view.classList.toggle('is-selecting', selectMode);

    var bulk = $('pl-bulk');
    if (bulk) bulk.hidden = !selectMode;

    var btn = $('pl-select');
    if (btn) btn.textContent = selectMode ? '完成' : '多选';

    if (bulkArmTimer) {
      clearTimeout(bulkArmTimer);
      bulkArmTimer = 0;
    }
    var del = $('pl-bulk-del');
    if (del) {
      del.textContent = '删除所选';
      del.classList.remove('is-danger-armed');
    }

    markPickedRows();
    renderBulk();
  }

  function togglePick(id) {
    if (id == null) return;
    if (picked[id]) delete picked[id];
    else picked[id] = true;
    markPickedRows();
    renderBulk();
  }

  $('pl-select').addEventListener('click', function () {
    setSelectMode(!selectMode);
  });

  $('pl-bulk-cancel').addEventListener('click', function () {
    setSelectMode(false);
  });

  $('pl-bulk-all').addEventListener('click', function () {
    var list = (currentPlaylist && currentPlaylist.tracks) || [];
    if (!list.length) return;

    if (pickCount() === list.length) {
      picked = {};
    } else {
      picked = {};
      list.forEach(function (t) { picked[t.id] = true; });
    }
    markPickedRows();
    renderBulk();
  });

  // 删除是两段式：第一次点只是「上膛」，3 秒内再点一次才真的删，
  // 避免误触一下就把整列歌曲清掉（没有撤销）。
  // 多选 → 加入别的歌单：目标不包含当前歌单自己（勾的就是这里的歌，加回去必然全重复）
  $('pl-bulk-add').addEventListener('click', function () {
    var list = (currentPlaylist && currentPlaylist.tracks) || [];
    var songs = list.filter(function (t) { return t && picked[t.id]; });
    if (!songs.length) {
      toast('先勾几首');
      return;
    }
    openAddForSongs(songs, currentPlaylist.id);
  });

  $('pl-bulk-del').addEventListener('click', function () {
    var btn = this;
    var n = pickCount();
    if (!n) return;

    if (!bulkArmTimer) {
      btn.textContent = '确认删除 ' + n + ' 首？';
      btn.classList.add('is-danger-armed');
      bulkArmTimer = setTimeout(function () {
        bulkArmTimer = 0;
        btn.textContent = '删除所选';
        btn.classList.remove('is-danger-armed');
      }, 3000);
      return;
    }

    clearTimeout(bulkArmTimer);
    bulkArmTimer = 0;
    deletePicked();
  });

  function deletePicked() {
    var rec = currentPlaylist && findPlaylist(currentPlaylist.id);
    if (!rec) return;

    var n = pickCount();
    if (!n) return;

    var before = (rec.tracks || []).length;
    rec.tracks = (rec.tracks || []).filter(function (t) { return !picked[t.id]; });
    var removed = before - rec.tracks.length;
    picked = {};

    if (!saveLib()) return;

    renderSidebar();
    openLocal(rec.id);      // openLocal 会退出多选，下面再进回来，方便连续清理
    if (rec.tracks.length) setSelectMode(true);
    toast('已删除 ' + removed + ' 首');
  }

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

  $('import-input').addEventListener('input', function () {
    var raw = $('import-input').value.trim();
    if (!raw) {
      $('import-msg').textContent = '';
      return;
    }
    var found = parsePlaylistId(raw);
    $('import-msg').textContent = found ? '已识别歌单 ID：' + found : '还没认出歌单 ID，贴链接或整段分享文案都行';
  });

  $('import-form').addEventListener('submit', function (e) {
    e.preventDefault();

    var id = parsePlaylistId($('import-input').value);

    if (!id) {
      $('import-msg').textContent = '没认出歌单 ID：贴链接、纯数字或整段分享文案都行';
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
          syncedAt: Date.now(),
          tracks: d.tracks || []
        };

        var old = findPlaylist(p.id);
        if (old) {
          old.name = p.name;
          old.cover = p.cover;
          old.tracks = p.tracks;
          old.syncedAt = Date.now();
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

  /* 设置 → 歌单：导出 / 导入备份文件 */
  $('lib-export').addEventListener('click', exportLib);

  $('lib-import').addEventListener('click', function () {
    $('lib-file').click();
  });

  $('lib-file').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (file) importLibFile(file);
    e.target.value = '';
  });

  $('lib-netease').addEventListener('click', function () {
    // 两个模态框叠着不好看，先收设置
    if (settingsDlg.open) settingsDlg.close();
    $('import-msg').textContent = '';
    $('import-input').value = '';
    openDlg(dlgImport);
    setTimeout(function () { $('import-input').focus(); }, 60);
  });

  $('new-playlist').addEventListener('click', function () {
    closeSidebar();
    newPendingSongs = []; // 从侧边栏进来就是纯新建，别把上一条待加入的歌带进来
    $('new-input').value = '';
    openDlg(dlgNew);
    setTimeout(function () { $('new-input').focus(); }, 60);
  });

  $('new-close').addEventListener('click', function () {
    newPendingSongs = [];
    closeDlg(dlgNew);
  });

  $('new-form').addEventListener('submit', function (e) {
    e.preventDefault();

    var name = $('new-input').value.trim();
    if (!name) return;

    var p = { id: uid('p'), name: name, cover: '', source: 'local', addedAt: Date.now(), tracks: [] };

    // 新建时把待加入的歌一起放进去（单曲 / 多选批量都走这里），批内按 id 去重
    if (newPendingSongs.length) {
      newPendingSongs.forEach(function (t) {
        if (!t || t.id == null) return;
        for (var k = 0; k < p.tracks.length; k += 1) if (p.tracks[k].id === t.id) return;
        p.tracks.push(t);
      });
      newPendingSongs = [];
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
    openAddForSong(arr[Number(row.getAttribute('data-i'))]);
  }

  /**
   * 渲染可选歌单。excludeId 用来把「当前正在看的歌单」自己排除掉 ——
   * 多选是从这个歌单里勾的，加入自己必然是全部重复，不如直接不列出来。
   */
  function renderAddList(excludeId) {
    var ul = $('add-list');
    ul.innerHTML = '';

    var list = lib.playlists.filter(function (p) { return p.id !== excludeId; });

    if (!list.length) {
      var tip = document.createElement('li');
      tip.className = 'sheet-note';
      tip.textContent = lib.playlists.length ? '没有别的歌单可以放，先建一个' : '还没有歌单，先建一个';
      ul.appendChild(tip);
      return;
    }

    list.forEach(function (p) {
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
  }

  /** 打开「加入歌单」：搜索结果行、播放器上的 ＋ 都走这里 */
  function openAddForSong(song) {
    if (!song) return;

    pendingSong = song;
    pendingBatch = null;
    newPendingSongs = [];

    $('add-song').textContent = song.name + ' · ' + (song.artists || '');
    renderAddList('');
    openDlg(dlgAdd);
  }

  /** 多选批量加入：和单曲共用同一个弹窗，只是待加入的是一批 */
  function openAddForSongs(songs, sourceId) {
    if (!songs || !songs.length) return;

    pendingSong = null;
    pendingBatch = songs.slice();
    newPendingSongs = [];

    $('add-song').textContent = '已选 ' + songs.length + ' 首，选一个歌单放进去';
    renderAddList(sourceId || '');
    openDlg(dlgAdd);
  }

  function addSongTo(p) {
    var songs = pendingBatch || (pendingSong ? [pendingSong] : []);
    if (!songs.length) return;

    var before = p.tracks.length;
    var added = 0;
    var dup = 0;

    songs.forEach(function (song) {
      if (!song || song.id == null) return;
      for (var i = 0; i < p.tracks.length; i += 1) {
        if (p.tracks[i].id === song.id) { dup += 1; return; }
      }
      p.tracks.push(song);
      added += 1;
    });

    if (!added) {
      clearPendingAdd();
      closeDlg(dlgAdd);
      toast(dup > 1 ? '这 ' + dup + ' 首都已经在「' + p.name + '」里了' : '「' + p.name + '」里已经有这首了');
      return;
    }

    if (!saveLib()) {
      // 存不下就把刚加进去的整批撤掉，别让内存和本地存的两份不一致
      p.tracks.length = before;
      return;
    }

    clearPendingAdd();
    renderSidebar();
    closeDlg(dlgAdd);

    if (dup) toast('已加入「' + p.name + '」：新增 ' + added + ' 首，跳过重复 ' + dup + ' 首');
    else if (added > 1) toast('已加入「' + p.name + '」：' + added + ' 首');
    else toast('已加入「' + p.name + '」');

    if (currentPlaylist && currentPlaylist.id === p.id) openLocal(p.id);
  }

  function clearPendingAdd() {
    pendingSong = null;
    pendingBatch = null;
    newPendingSongs = [];
  }

  $('add-new').addEventListener('click', function () {
    // 单曲 / 多选都统一成数组带过去，新建完一次性放进去
    newPendingSongs = pendingBatch ? pendingBatch.slice() : (pendingSong ? [pendingSong] : []);
    closeDlg(dlgAdd);
    $('new-input').value = '';
    openDlg(dlgNew);
    setTimeout(function () { $('new-input').focus(); }, 60);
  });

  $('add-close').addEventListener('click', function () {
    clearPendingAdd();
    closeDlg(dlgAdd);
  });

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

  /* ---------------------------------------------------------- 歌单备份文件 */
  function refreshLibCount() {
    var el = $('lib-count');
    if (!el) return;
    var n = lib.playlists.length;
    var tracks = 0;
    lib.playlists.forEach(function (p) { tracks += (p.tracks || []).length; });
    el.textContent = n + ' 个 · ' + tracks + ' 首';
  }

  function exportLib() {
    if (!lib.playlists.length) {
      toast('还没有歌单可导出');
      return;
    }

    var payload = {
      v: 1,
      app: 'PMusic_Box',
      exportedAt: new Date().toISOString(),
      playlists: lib.playlists
    };

    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'pmusic-playlists-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    toast('已导出 ' + lib.playlists.length + ' 个歌单');
  }

  /** 只保留认识的字段，别把来源不明的结构塞进 localStorage */
  function normalizeSong(s) {
    if (!s || s.id == null || !s.name) return null;
    return {
      id: s.id,
      name: String(s.name).slice(0, 120),
      artists: String(s.artists || '').slice(0, 120),
      album: String(s.album || '').slice(0, 120),
      duration: Number(s.duration) || 0,
      cover: typeof s.cover === 'string' ? s.cover : ''
    };
  }

  function importLibFile(file) {
    var reader = new FileReader();

    reader.onload = function () {
      var data;
      try {
        data = JSON.parse(String(reader.result || ''));
      } catch (e) {
        toast('这个文件不是有效的 JSON');
        return;
      }

      var arr = Array.isArray(data) ? data : data && data.playlists;
      if (!Array.isArray(arr)) {
        toast('文件里没有歌单');
        return;
      }

      var added = 0;
      var merged = 0;
      var skipped = 0;

      arr.forEach(function (raw) {
        if (!raw || !raw.name || !Array.isArray(raw.tracks)) {
          skipped += 1;
          return;
        }

        var p = {
          id: String(raw.id || uid('p')),
          neteaseId: raw.neteaseId ? String(raw.neteaseId) : '',
          name: String(raw.name).slice(0, 60),
          cover: typeof raw.cover === 'string' ? raw.cover : '',
          source: raw.source === 'netease' ? 'netease' : 'local',
          addedAt: Number(raw.addedAt) || Date.now(),
          tracks: raw.tracks.map(normalizeSong).filter(Boolean)
        };

        var old = findPlaylist(p.id);
        if (old) {
          var have = {};
          old.tracks.forEach(function (s) { have[s.id] = 1; });
          p.tracks.forEach(function (s) {
            if (!have[s.id]) {
              old.tracks.push(s);
              have[s.id] = 1;
            }
          });
          merged += 1;
        } else {
          lib.playlists.unshift(p);
          added += 1;
        }
      });

      if (!saveLib()) return;

      renderSidebar();
      refreshLibCount();
      toast('导入完成：新增 ' + added + '，合并 ' + merged + (skipped ? '，跳过 ' + skipped : ''));
    };

    reader.readAsText(file);
  }

  /* ------------------------------------------------------ 网易云歌单解析 */
  /** 从「分享歌单: xxx https://music.163.com/m/playlist?id=123&creatorId=456」里抠出 id */
  function parsePlaylistId(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';

    var m = /^(\d{3,20})$/.exec(s);
    if (m) return m[1];

    // playlist?id= / playlistId= / #/playlist?id= / /playlist/123
    m = /(?:playlist[^\d]{0,16}|playlistId=)(\d{3,20})/i.exec(s);
    if (m) return m[1];

    m = /music\.163\.com\/(?:m\/|#\/)?playlist\/(\d{3,20})/i.exec(s);
    return m ? m[1] : '';
  }

  /* ------------------------------------------------------------ 账号面板 */
  var accInfo = null;
  var accInfoLoading = false;

  function loadAccountPanel(force) {
    var nameEl = $('acc-name');
    if (!nameEl) return;

    var acc = currentAccount();
    if (!acc) {
      nameEl.textContent = '未登录';
      $('acc-sub').textContent = '登录后可读取网易云账号信息';
      $('acc-vip').hidden = true;
      $('acc-avatar').textContent = '私';
      $('acc-load').disabled = true;
      $('acc-lists').innerHTML = '';
      $('acc-note').textContent = '当前没有登录账号。';
      $('set-logout').disabled = true;
      return;
    }

    nameEl.textContent = acc.name || '已登录';
    $('acc-avatar').textContent = String(acc.name || '音').slice(0, 1);
    $('set-logout').disabled = false;
    $('acc-load').disabled = true;

    if (accInfo && !force) {
      paintAccount();
      return;
    }
    if (accInfoLoading) return;

    accInfoLoading = true;
    $('acc-note').textContent = '正在读取账号信息…';

    apiFetch(API + '/api/account')
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, d: d || {} }; });
      })
      .then(function (res) {
        if (!res.ok || !res.d.ok) throw new Error(res.d.error || '读取失败');
        accInfo = res.d;
        paintAccount();
      })
      .catch(function (e) {
        accInfo = null;
        $('acc-sub').textContent = '读取不到网易云账号信息';
        $('acc-vip').hidden = true;
        $('acc-load').disabled = true;
        $('acc-note').textContent = '读取失败：' + e.message + '（服务端可能还没更新）';
      })
      .then(function () { accInfoLoading = false; });
  }

  function paintAccount() {
    var d = accInfo || {};
    var bits = [];
    if (d.userId) bits.push('UID ' + d.userId);
    if (d.level) bits.push('Lv.' + d.level);
    $('acc-sub').textContent = bits.length ? bits.join(' · ') : '网易云账号';

    var vipEl = $('acc-vip');
    vipEl.hidden = !d.vipLabel;
    vipEl.textContent = d.vipLabel || '';

    $('acc-load').disabled = !d.bound;
    $('acc-note').textContent = d.bound
      ? '点一首歌单就导入本地；收藏夹里那些「我喜欢的音乐」也能导。'
      : '这个账号没有绑定网易云凭证（MUSIC_U），读不到歌单。';

    if (d.nickname) $('acc-name').textContent = d.nickname;
    if (d.avatar) $('acc-avatar').textContent = String(d.nickname || '音').slice(0, 1);
  }

  function renderAccLists() {
    var ul = $('acc-lists');
    if (!ul) return;
    ul.innerHTML = '';

    if (!accInfo || !accInfo.bound) return;

    if (!accInfo.playlists) {
      ul.innerHTML = '<li class="side-empty">点上面的「读取我的歌单」</li>';
      return;
    }

    if (!accInfo.playlists.length) {
      ul.innerHTML = '<li class="side-empty">这个账号下没有歌单</li>';
      return;
    }

    accInfo.playlists.forEach(function (p) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'acc-item';

      var img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      if (p.cover) img.src = p.cover;

      var name = document.createElement('span');
      name.className = 'acc-item-name';
      name.textContent = p.name;

      var n = document.createElement('span');
      n.className = 'acc-item-n';
      n.textContent = (p.trackCount || 0) + ' 首';

      b.appendChild(img);
      b.appendChild(name);
      b.appendChild(n);
      b.addEventListener('click', function () { importNeteasePlaylist(p.id, b); });
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  function loadMyPlaylists() {
    if (!accInfo || !accInfo.bound) {
      toast('当前账号没有绑定网易云');
      return;
    }

    var btn = $('acc-load');
    btn.disabled = true;
    btn.textContent = '读取中…';
    $('acc-note').textContent = '正在读取歌单列表…';

    apiFetch(API + '/api/myplaylists')
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, d: d || {} }; });
      })
      .then(function (res) {
        if (!res.ok || !res.d.ok) throw new Error(res.d.error || '读取失败');
        accInfo.playlists = res.d.playlists || [];
        $('acc-note').textContent = '共 ' + accInfo.playlists.length + ' 个歌单，点一个导入本地。';
        renderAccLists();
      })
      .catch(function (e) {
        $('acc-note').textContent = '读取失败：' + e.message;
        toast('读取歌单失败：' + e.message);
      })
      .then(function () {
        btn.textContent = '读取我的歌单';
        btn.disabled = false;
      });
  }

  /** 把一个网易云歌单整单拉下来存本地 */
  function importNeteasePlaylist(id, sourceBtn) {
    if (sourceBtn) sourceBtn.classList.add('is-on');

    apiFetch(withK(API + '/api/playlist?id=' + id))
      .then(authGuard)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) throw new Error(d.error);

        var p = {
          id: 'n' + id,
          neteaseId: String(id),
          name: d.name,
          cover: d.cover,
          source: 'netease',
          addedAt: Date.now(),
          syncedAt: Date.now(),
          tracks: d.tracks || []
        };

        var old = findPlaylist(p.id);
        if (old) {
          old.name = p.name;
          old.cover = p.cover;
          old.tracks = p.tracks;
          old.syncedAt = Date.now();
        } else {
          lib.playlists.unshift(p);
        }
        if (!saveLib()) return;

        renderSidebar();
        refreshLibCount();
        toast('已导入「' + p.name + '」' + p.tracks.length + ' 首');
      })
      .catch(function (e) {
        toast('导入失败：' + e.message);
      })
      .then(function () {
        if (sourceBtn) sourceBtn.classList.remove('is-on');
      });
  }

  $('acc-load').addEventListener('click', loadMyPlaylists);

  /* ------------------------------------------------------------ 睡眠定时器 */
  var sleepUntil = 0;
  var sleepMinutes = 0;
  var sleepTimer = null;
  var sleepTrackEnd = false;
  var sleepTick = null;
  var sleepPop = null;

  var fadeRaf = 0;
  var fadeFrom = 1;
  var fadeActive = false;

  function stopSleepFade() {
    if (fadeRaf) cancelAnimationFrame(fadeRaf);
    fadeRaf = 0;
    if (fadeActive) {
      audio.volume = fadeFrom;
      fadeActive = false;
    }
  }

  /** 到点不是「啪」一下静音，先把音量淡下去 */
  function fadeOutAndPause() {
    stopSleepFade();

    fadeFrom = audio.volume;
    fadeActive = true;
    var t0 = performance.now();
    var dur = 900;

    function step(ts) {
      var k = Math.min(1, (ts - t0) / dur);
      audio.volume = Math.max(0, fadeFrom * (1 - k));
      if (k < 1) {
        fadeRaf = requestAnimationFrame(step);
        return;
      }
      fadeRaf = 0;
      fadeActive = false;
      audio.pause();
      audio.volume = fadeFrom;
      vol.value = String(Math.round(fadeFrom * 100));
      fill(vol, fadeFrom);
      toast('睡眠定时到，已暂停');
    }

    fadeRaf = requestAnimationFrame(step);
  }

  function stopSleepTick() {
    if (sleepTick) clearInterval(sleepTick);
    sleepTick = null;
  }

  function startSleepTick() {
    stopSleepTick();
    sleepTick = setInterval(paintSleepUI, 15000);
  }

  function clearSleepAll() {
    if (sleepTimer) clearTimeout(sleepTimer);
    sleepTimer = null;
    sleepUntil = 0;
    sleepMinutes = 0;
    sleepTrackEnd = false;
    stopSleepTick();
  }

  function sleepSelectValue() {
    if (sleepTrackEnd) return 'track';
    return sleepMinutes ? String(sleepMinutes) : '0';
  }

  function sleepLeftMinutes() {
    return Math.max(0, Math.ceil((sleepUntil - Date.now()) / 60000));
  }

  function paintSleepUI() {
    var on = sleepTrackEnd || sleepUntil > 0;
    var label = '睡眠定时器';

    if (sleepTrackEnd) label += '：播完当前这首后暂停';
    else if (sleepUntil > 0) label += '：还剩 ' + sleepLeftMinutes() + ' 分钟';

    ['sleep-btn', 's-sleep'].forEach(function (id) {
      var b = $(id);
      if (!b) return;
      b.classList.toggle('is-on', on);
      b.title = label;
      b.setAttribute('aria-label', label);
    });

    if (setSleep) setSleep.value = sleepSelectValue();

    var note = $('sleep-note');
    if (note) {
      note.textContent = on
        ? (sleepTrackEnd ? '当前这首播完就会淡出暂停。' : '还有 ' + sleepLeftMinutes() + ' 分钟，到点会把音量淡出再暂停。')
        : '到点会先把音量淡出再暂停，不会突然静音。播放器和大屏里也有同一个按钮。';
    }
  }

  function fireSleep() {
    clearSleepAll();
    paintSleepUI();
    if (!audio.paused) fadeOutAndPause();
    else toast('睡眠定时到');
  }

  function setSleepOption(v) {
    clearSleepAll();

    if (v === 'track') {
      sleepTrackEnd = true;
      startSleepTick();
      toast('播完当前这首后暂停');
    } else {
      var m = Number(v) || 0;
      if (m > 0) {
        sleepMinutes = m;
        sleepUntil = Date.now() + m * 60000;
        sleepTimer = setTimeout(fireSleep, m * 60000);
        startSleepTick();
        toast('已设置 ' + m + ' 分钟后暂停');
      } else {
        toast('睡眠定时已关闭');
      }
    }

    paintSleepUI();
  }

  /** 贴在按钮上方/下方，和播放列表面板同一套夹取逻辑 */
  function placeAnchored(el, btn) {
    if (!btn) return;
    var r = btn.getBoundingClientRect();
    var box = el.getBoundingClientRect();
    var vw = (vv && vv.width) || window.innerWidth;
    var vh = (vv && vv.height) || window.innerHeight;
    var gap = 10;

    var left = Math.min(Math.max(10, r.right - box.width), vw - box.width - 10);
    var top = r.top - box.height - gap;
    if (top < 10) top = r.bottom + gap;
    if (top + box.height > vh - 10) top = Math.max(10, vh - box.height - 10);

    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  function buildSleepPop() {
    if (sleepPop) return sleepPop;

    var pop = document.createElement('div');
    pop.className = 'queue-pop sleep-pop';
    pop.id = 'sleep-pop';
    pop.hidden = true;
    pop.innerHTML =
      '<div class="queue-pop-head"><h2>睡眠定时器</h2>' +
      '<button class="icon-btn sm" type="button" data-close aria-label="关闭">×</button></div>' +
      '<div class="sleep-opts"></div>';

    var box = pop.querySelector('.sleep-opts');
    [['0', '关闭'], ['15', '15 分钟'], ['30', '30 分钟'], ['60', '60 分钟'], ['90', '90 分钟'], ['track', '播完当前这首']]
      .forEach(function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'sleep-opt';
        b.setAttribute('data-v', it[0]);
        b.textContent = it[1];
        b.addEventListener('click', function () {
          setSleepOption(b.getAttribute('data-v'));
          closeSleepPop();
        });
        box.appendChild(b);
      });

    pop.querySelector('[data-close]').addEventListener('click', closeSleepPop);
    pop.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    document.body.appendChild(pop);
    sleepPop = pop;
    return pop;
  }

  function openSleepPop(btn) {
    closeQueue();

    var pop = buildSleepPop();
    var anchor = btn || $('sleep-btn');

    if (!pop.hidden && pop.getAttribute('data-anchor') === (anchor && anchor.id)) {
      closeSleepPop();
      return;
    }

    pop.hidden = false;
    pop.setAttribute('data-anchor', anchor && anchor.id);
    document.body.classList.add('is-queue-open');

    if (isMobileUI()) {
      // 手机上用底部面板样式（CSS 里 .queue-pop 那套），不做锚定
      pop.style.left = '';
      pop.style.top = '';
      return;
    }
    placeAnchored(pop, anchor);
  }

  function closeSleepPop() {
    if (!sleepPop) return;
    sleepPop.hidden = true;
    document.body.classList.remove('is-queue-open');
  }

  ['sleep-btn', 's-sleep'].forEach(function (id) {
    var b = $(id);
    if (b) b.addEventListener('click', function () { openSleepPop(this); });
  });

  if (setSleep) {
    setSleep.addEventListener('change', function () {
      setSleepOption(setSleep.value);
    });
  }

  if (setPlayLevel) {
    setPlayLevel.addEventListener('change', function () {
      settings.playLevel = LEVELS.indexOf(setPlayLevel.value) >= 0 ? setPlayLevel.value : 'exhigh';
      saveSettings();
      toast('播放音质：' + setPlayLevel.options[setPlayLevel.selectedIndex].textContent);
    });
  }

  if (setDlLevel) {
    setDlLevel.addEventListener('change', function () {
      settings.downloadLevel = LEVELS.indexOf(setDlLevel.value) >= 0 ? setDlLevel.value : 'exhigh';
      saveSettings();
    });
  }

  document.addEventListener('pointerdown', function (e) {
    if (!sleepPop || sleepPop.hidden) return;
    if (sleepPop.contains(e.target)) return;
    if ($('sleep-btn') && $('sleep-btn').contains(e.target)) return;
    if ($('s-sleep') && $('s-sleep').contains(e.target)) return;
    closeSleepPop();
  });

  /* ------------------------------------------------------------------ 版本号 */
  // 直接读脚本地址上的 ?v=（20261228 → 2026.12.28），
  // 不用在 index.html 和 js 里各维护一个数字，发版永远只有一处要改
  function appVersion() {
    try {
      var el = document.currentScript || document.querySelector('script[src*="music-page.js"]');
      var m = /[?&]v=(\d+)/.exec((el && el.src) || '');
      if (m) {
        var v = m[1];
        if (v.length === 8) return v.slice(0, 4) + '.' + v.slice(4, 6) + '.' + v.slice(6);
        return v;
      }
    } catch (e) { /* 极老的浏览器没有 currentScript */ }
    return 'dev';
  }

  /* ------------------------------------------------------------------ 启动 */
  audio.volume = Number(vol.value) / 100;
  fill(vol, 0.8);
  fill(seek, 0);
  fill(sSeek, 0);

  // 手机：设置内容搬进独立页面；桌面继续用弹窗
  if (isMobileUI()) {
    var setHost = $('settings-host');
    var setBody = settingsDlg.querySelector('.set-body');
    if (setHost && setBody) setHost.appendChild(setBody);
  }

  // 播放条常驻：还没播放时也要有东西看
  player.classList.add('is-empty');
  pCover.src = DEFAULT_COVER;
  $('p-artist').textContent = '选一首歌开始';

  // 封面地址挂了也要有东西看
  $('pl-cover').addEventListener('error', function () {
    this.onerror = null;
    this.src = DEFAULT_COVER;
  });
  var verEl = $('app-version');
  if (verEl) verEl.textContent = appVersion();

  applyMode();
  renderHistory();
  applySettings();
  renderSidebar();
  renderPlayed();
  refreshLibCount();
  paintSleepUI();
  refreshAccountUI();
  syncTabbar();
  route();
  initAuth();

  if (!API) {
    fail('先部署 Worker，再在 source/music/index.html 里填 window.MUSIC_API');
  }
  // 口令门已下线，登录由 #login + /api/login 负责，这里不再探口令
})();
