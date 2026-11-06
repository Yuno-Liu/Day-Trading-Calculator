/* 台股當沖・融資融券計算機 — Service Worker
 * - 只處理 GET；其他方法一律交給瀏覽器（不快取）。
 * - 導覽請求：network-first（3 秒逾時）→ 退回快取的 index.html。
 * - 鎖版 CDN：cache-first（版本號寫死在網址中，內容不會變，命中後不再重抓）。只快取經 CORS 驗證的成功回應；
 *   不支援 CORS 的 CDN（如 Tailwind）才存 opaque。若快取意外存到錯誤回應，頁面偵測到全域物件缺失後
 *   會送 CDN_PURGE 訊息，由本檔清除該筆快取，頁面再重新載入一次（自我修復，平時零額外流量）。
 * - 同源靜態檔：stale-while-revalidate。
 * - 快取名稱含版本；activate 時刪除本 App 的舊版快取。
 */
'use strict';

const CACHE_PREFIX = 'twcalc-';
const CACHE = 'twcalc-v2.0.0';
const NAV_TIMEOUT_MS = 3000;

const LOCAL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon.svg',
];

const CDN_ASSETS = [
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@8.1.1/babel.min.js',
  'https://cdn.tailwindcss.com/3.4.17',
];
const CDN_SET = new Set(CDN_ASSETS);

const INDEX_URL = new URL('./index.html', self.registration.scope).href;
const ROOT_URL = new URL('./', self.registration.scope).href;

// 被轉址的回應不能拿來回應導覽請求（Safari 會報錯），存入前重新包裝。
async function cleanResponse(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function precacheLocal(cache) {
  await Promise.all(LOCAL_ASSETS.map(async (path) => {
    const req = new Request(path, { cache: 'reload' });
    const res = await fetch(req);
    if (!res.ok) throw new Error(`precache ${path}: HTTP ${res.status}`);
    await cache.put(req, await cleanResponse(res));
  }));
}

// CDN 先試 CORS（可檢查狀態碼、無 opaque 配額膨脹）。CORS 有回應但非 2xx 時直接視為失敗（不可退回 no-cors 繞過檢查）；
// 只有 CORS 請求本身拋出例外（如 Tailwind 沒有 ACAO 標頭）才退回 no-cors（opaque，狀態無法驗證）。
// <script> 不帶 crossorigin（no-cors 請求）時，兩種回應皆可使用。
async function fetchCdn(url) {
  let res;
  try {
    res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'reload' });
  } catch (_) {
    res = await fetch(url, { mode: 'no-cors', credentials: 'omit', cache: 'reload' });
    if (res.type === 'opaque' || res.ok) return res;
  }
  if (res.ok) return res;
  throw new Error(`CDN ${url}: HTTP ${res.status}`);
}

// 重新抓取 CDN 並寫入快取；失敗時保留既有項目。
async function refreshCdn(url, cache) {
  const res = await fetchCdn(url);
  await (cache || await caches.open(CACHE)).put(url, res);
}

async function precacheCdn(cache) {
  // CDN 為盡力預快取：失敗不讓 install 失敗，之後線上使用時由 cache-first 補齊。
  // 已有經驗證（非 opaque）的項目才略過；既有 opaque 項目可能是錯誤回應，一律重抓。
  const results = await Promise.allSettled(CDN_ASSETS.map(async (url) => {
    const cached = await cache.match(url, { ignoreVary: true });
    if (cached && cached.type !== 'opaque') return;
    await refreshCdn(url, cache);
  }));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn('[sw] CDN 預快取失敗', CDN_ASSETS[i], r.reason);
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await precacheLocal(cache);
    await precacheCdn(cache);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

// 回應成功時先同步 clone，再寫入快取（clone 必須在主體被頁面讀取前完成）。
// 回傳的 promise 由呼叫端「同步」交給 event.waitUntil，避免事件結束後才呼叫而丟出 InvalidStateError。
function cacheWhen(network, key, accept) {
  return network.then((res) => {
    if (!accept(res)) return undefined;
    const copy = res.clone();
    return caches.open(CACHE).then((c) => c.put(key, copy));
  }).catch(() => {});
}

const isBasicOk = (res) => res.ok && res.type === 'basic';

const OFFLINE_HTML = '<!doctype html><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>離線</title>'
  + '<p style="font:17px system-ui;padding:24px">目前離線，且尚未有可用的快取。請連線後重新開啟。</p>';

async function matchNavigation(request) {
  const cache = await caches.open(CACHE);
  return (await cache.match(request, { ignoreSearch: true }))
    || (await cache.match(INDEX_URL))
    || (await cache.match(ROOT_URL));
}

function handleNavigation(event) {
  const { request } = event;
  const network = fetch(request);
  event.waitUntil(cacheWhen(network, request, isBasicOk));
  return (async () => {
    try {
      return await Promise.race([network, timeout(NAV_TIMEOUT_MS)]);
    } catch (_) {
      const cached = await matchNavigation(request);
      if (cached) return cached;
      try {
        return await network; // 無快取：繼續等網路
      } catch (_) {
        return new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    }
  })();
}

// 命中快取：直接回應（鎖版網址內容不變，不重抓，避免每次開啟多耗流量，也避免暫時性錯誤覆蓋可用的快取）。
// 未命中：頁面照舊用自己的請求取得回應；快取只寫入 fetchCdn 取得的回應（CORS 驗證過，或 CDN 不支援 CORS 時的 opaque），
// 不存頁面的 opaque 回應。快取若意外是錯誤回應，由頁面送 CDN_PURGE 清除（見下方 message 處理）。
function handleCdn(event) {
  const { request } = event;
  const url = request.url;
  const lookup = caches.open(CACHE).then((c) => c.match(url, { ignoreVary: true }));
  // 背景工作必須在事件處理期間同步交給 waitUntil。
  event.waitUntil(lookup.then((cached) => {
    if (cached) return undefined;
    return refreshCdn(url).catch((e) => console.warn('[sw] CDN 快取失敗', url, e));
  }, () => {}));
  return lookup.then((cached) => cached || fetch(request), () => fetch(request));
}

// 頁面回報 CDN 全域物件缺失 → 清除對應快取（只接受白名單內的鎖版 CDN 網址），完成後回覆頁面以便重新載入。
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'CDN_PURGE' || !Array.isArray(data.urls)) return;
  const urls = data.urls.filter((u) => typeof u === 'string' && CDN_SET.has(u));
  const port = event.ports && event.ports[0];
  const reply = () => { if (port) port.postMessage({ ok: true, purged: urls.length }); };
  event.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(urls.map((u) => c.delete(u, { ignoreVary: true }))))
    .then(reply, reply));
});

function handleSameOrigin(event) {
  const { request } = event;
  const network = fetch(request);
  event.waitUntil(cacheWhen(network, request, isBasicOk)); // 背景更新（stale-while-revalidate）
  return (async () => {
    const cached = await caches.match(request, { cacheName: CACHE });
    return cached || network;
  })();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // 不快取、不攔截非 GET
  // Chrome DevTools 的 only-if-cached 跨來源請求會丟錯，直接略過
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
  } else if (CDN_SET.has(url.href)) {
    event.respondWith(handleCdn(event));
  } else if (url.origin === self.location.origin && !request.headers.has('range')) {
    event.respondWith(handleSameOrigin(event));
  }
  // 其他跨來源請求：不攔截
});
