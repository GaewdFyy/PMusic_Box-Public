# 部署与配置

从零把这个项目跑起来。只需要一个 Cloudflare 账号，不需要自己的服务器。

## 0. 前置

- Node.js 18+（本地调试与部署脚本）
- Cloudflare 账号（免费版即可）
- 可选：一个域名（Cloudflare Pages / Workers 都提供免费子域）

```bash
git clone <this-repo>
cd PMusic-Box
```

## 1. 先在本机跑通

```bash
# 终端 A：Worker 跑在 Node 上，监听 8787
node worker/dev-server.mjs

# 终端 B：静态站点
npx serve site -l 8080
```

打开 <http://localhost:8080>，按 F12 看 Network：如果请求打到了
`https://YOUR-WORKER.workers.dev`，把它改成本地地址：

```html
<!-- site/index.html 末尾，<script src="/js/music-page.js"> 附近 -->
<script>window.MUSIC_API = 'http://127.0.0.1:8787';</script>
```

`worker/dev-server.mjs` 会把当前 shell 的 `MUSIC_U`、`API_TOKEN`、`ACCOUNTS_JSON`、
`SESSION_SECRET`、`REQUIRE_LOGIN`、`REQUIRE_PASS`、`PASSWORD` 透传给 Worker，方便本地切组合。

冒烟测试（不需要 wrangler，也不需要 Cloudflare 账号）：

```bash
cd worker
node test.mjs 起风了
```

## 2. 部署 Worker

```bash
cd worker
npm i -g wrangler        # 或者直接用 npx wrangler
wrangler login
wrangler deploy
```

`worker/wrangler.toml` 里的名字默认是 `netease-api`，可以改成自己的。部署成功后会得到一个
`https://<name>.<subdomain>.workers.dev` 地址。

### 可选 Secret

都不是必需的；不配就只能播放匿名可听的曲目。

```bash
wrangler secret put MUSIC_U        # 网易云 MUSIC_U cookie（VIP 曲目直链需要）
wrangler secret put API_TOKEN      # 之后所有接口都要带 ?k=<token>
wrangler secret put ACCOUNTS_JSON  # 多账号表
wrangler secret put SESSION_SECRET # 登录态签名密钥
```

`MUSIC_U` 的获取：登录网页版网易云 → F12 → Application → Cookies → 复制 `MUSIC_U` 的值。
它等同于账号密码，**只放 Secret，不要写进仓库**。

### CORS

`worker/wrangler.toml` 里的 `ALLOWED_ORIGIN` 需要填你实际的前端域名，逗号分隔：

```toml
[vars]
ALLOWED_ORIGIN = "https://your-site.pages.dev"
```

本地调试可以直接用 `*`。

## 3. 部署前端（Cloudflare Pages）

### 方式 A：Git 集成（推荐）

1. 把仓库推到 GitHub
2. Cloudflare Dashboard → Pages → Create project → 连接仓库
3. 构建命令留空，**输出目录填 `site`**
4. 部署完成后，`functions/` 会自动作为 Pages Functions 生效

### 方式 B：命令行

```bash
wrangler pages deploy site --project-name pmusic-box
```

仓库根目录的 `wrangler.toml` 写了 `pages_build_output_dir = "site"`，也可以直接用
`wrangler pages dev` / `wrangler pages deploy` 而不带参数。

### 部署后必须做的一步

把 `site/index.html` 里的 API 地址改成你自己的 Worker，然后**重新生成移动版**：

```bash
# site/index.html
window.MUSIC_API = 'https://netease-api.your-subdomain.workers.dev';

node scripts/gen-mobile.mjs
```

`site/m/index.html` 是由桌面版生成的，不重新生成的话手机端还会指向旧地址。

## 4. 账号与访问控制

两种门可以各自开关，顺序是：**先口令，后账号**。

| REQUIRE_PASS | REQUIRE_LOGIN | 表现 |
|---|---|---|
| false | false | 直接进站（默认） |
| false | true | 只弹账号登录 |
| true | true | 先口令，再账号 |
| true | false | 只弹口令 |

> 注意：`REQUIRE_PASS = true` 但 `PASSWORD` 为空时，等于**没有防护**（代码会跳过口令校验）。
> 要么把 `PASSWORD` 填上，要么把 `REQUIRE_PASS` 关掉。

### 账号来源（优先级从高到低）

1. **KV 绑定 `ACCOUNTS`**

   ```bash
   wrangler kv namespace create ACCOUNTS
   # 把输出的 id 写进 worker/wrangler.toml：
   # [[kv_namespaces]]
   # binding = "ACCOUNTS"
   # id = "<namespace id>"
   ```

   key = 账号名，value = `{"password":"明文"}` 或 `{"passwordHash":"<sha256 hex>"}`，
   可附加 `"musicU":"..."` 让该账号使用自己的网易云 Cookie：

   ```bash
   wrangler kv key put --binding=ACCOUNTS alice '{"password":"***","musicU":"***"}'
   ```

2. **Secret `ACCOUNTS_JSON`**

   ```json
   [{"name": "alice", "password": "***", "musicU": "***"}]
   ```

3. **代码里的 `BUILTIN_ACCOUNTS`**：公开版本默认是空数组 `[]`，不要把密码写进仓库。

登录态是 HMAC-SHA256 签名的 token，存在 `localStorage`，默认 30 天。
删除账号后该账号的旧 token 会立即失效。

### 扫码登录（仅本机）

登录弹窗里的「扫码登录」走 Worker 的 `/api/qr/*`，只在当前浏览器保存 `MUSIC_U`，不写入账号表。
适合临时用一下 VIP 曲库。

## 5. 自定义域名

Pages 和 Worker 都可以绑定自己的域名：

- Pages：Settings → Custom domains → 添加 `music.example.com`
- Worker：Settings → Triggers → Custom Domains → 添加 `api.example.com`

绑定后记得同步两处：

1. `worker/wrangler.toml` 的 `ALLOWED_ORIGIN` 加上前端域名
2. `site/index.html` 的 `window.MUSIC_API` 改成 Worker 域名，并重新生成移动版

## 6. 常见问题

**接口 401 / 401 带 `needPassword`**
口令门开着但浏览器没存口令，或 `PASSWORD` 为空。检查 `/api/health` 的返回。

**能搜到歌但播放失败**
多半是 VIP / 版权受限：需要配置 `MUSIC_U`。Worker 日志里能看到网易云返回的码。

**手机打开还是桌面版**
Pages 缓存或 UA 判断问题。确认 `functions/_middleware.js` 已随 Pages 部署（`wrangler pages deploy site`
只上传静态文件，`functions/` 目录要在项目根）；HTML 响应应为 `Cache-Control: private, no-store`。

**移动版 404 / 被重定向**
Pages 会把 `/m/index.html` 308 到 `/m/`，中间件里请求的是 `/m/`，不要改回带 `.html` 的路径。

**歌词没有逐字高亮**
`/api/lyric` 需要返回 `yrc`（`/weapi/song/lyric/v1`）。旧版 Worker 只返回 `lrc`，会退化成整行高亮。
可以在设置里打开「显示歌曲 ID」调试，标记会显示「逐字 / 整行」。

**AMLL 加载失败**
默认从本站 `/vendor/` 加载；如果配置了 `AMLL_CDN` 而 CDN 不可用，会自动回退。两边都失败时降级为轻量歌词。

## 7. AMLL 与许可证

`site/vendor/amll-core.js` 是 [AMLL](https://github.com/amll-dev/applemusic-like-lyrics) 的打包产物，
**AGPL-3.0-only**。因为它随项目分发，本项目整体按 AGPL-3.0 发布：

- 站点公开可访问时，必须向访问者提供完整源码（本仓库地址即可）
- 修改后的源码也需要以 AGPL 发布

不想受此约束，就移除 `site/vendor/` 和 `site/js/music-page.js` 里 AMLL 相关代码，
退回自带的轻量歌词渲染器（功能会少掉逐字点亮和弹性滚动）。
