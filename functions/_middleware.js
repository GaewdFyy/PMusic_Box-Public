// Cloudflare Pages Functions 中间件：按设备把 / 分流到桌面或移动端 HTML。
//
// 为什么要中间件：Pages 是纯静态，同一个 URL 只能吐同一个文件；
// 而「手机只要手机那套 HTML」这件事必须发生在边缘。
//
// 缓存：HTML 一律 no-store，避免 CDN 把桌面版缓存后发给手机（Vary 在 CF 上不可靠）。
// 真正的静态资源（/css /js）仍然走 _headers 里的一日缓存。

const MOBILE_UA = /Android|iPhone|iPod|Mobile|Windows Phone|HarmonyOS|BlackBerry|Opera Mini/i;
const TABLET_UA = /iPad|Tablet|PlayBook|Silk/i;

function isMobile(request) {
  // 客户端提示优先（更准，且不会被 UA 精简影响）
  const hint = request.headers.get('sec-ch-ua-mobile');
  if (hint === '?1') return true;
  if (hint === '?0') return false;

  const ua = request.headers.get('user-agent') || '';
  if (TABLET_UA.test(ua)) return false;
  return MOBILE_UA.test(ua);
}

function htmlHeaders(res, vary) {
  const headers = new Headers(res.headers);
  headers.set('vary', vary);
  headers.set('cache-control', 'private, no-store');
  // 让浏览器以后都带上 Sec-CH-UA-Mobile
  headers.set('accept-ch', 'Sec-CH-UA-Mobile');
  return headers;
}

export const onRequest = async (context) => {
  const url = new URL(context.request.url);

  // 只管首页；其它路径（css/js、/api 之类）原样放行
  if (url.pathname !== '/' && url.pathname !== '/index.html') {
    return context.next();
  }

  if (!isMobile(context.request)) {
    const res = await context.next();
    return new Response(res.body, { status: res.status, headers: htmlHeaders(res, 'User-Agent, Sec-CH-UA-Mobile') });
  }

  // 注意用 /m/ 而不是 /m/index.html：Pages 会把带 .html 的地址 308 到无扩展名路径
  const mobile = new URL('/m/', url);
  const res = await context.env.ASSETS.fetch(new Request(mobile, context.request));
  return new Response(res.body, { status: res.status, headers: htmlHeaders(res, 'User-Agent, Sec-CH-UA-Mobile') });
};
