// ピアノ音ゲー Service Worker
// 方針:
//  - HTML と songs/*.json（曲リスト・譜面）は「ネットワーク優先、失敗時キャッシュ」
//    → 曲の追加・更新が次回起動時に反映される。オフラインでは最後に取れた内容で動く。
//  - それ以外（JS・CSS・manifest・アイコン）は「キャッシュ優先」。
//  - キャッシュ名にバージョン番号を入れ、activate で古いキャッシュを消す。
//  - songs/index.json に載っている曲は install 時にまとめて先読みキャッシュする。

const CACHE_VERSION = 'v5';
const CACHE_NAME = `piano-game-${CACHE_VERSION}`;

const SCOPE_URL = new URL(self.registration.scope);
const BASE_PATH = SCOPE_URL.pathname; // 例: "/piano/"

const CORE_ASSETS = [
  '',
  'index.html',
  'piano-logic.js',
  'manifest.webmanifest',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'songs/index.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // コアアセットを先読み
    await cache.addAll(CORE_ASSETS.map((p) => BASE_PATH + p));
    // songs/index.json に載っている曲の譜面JSONも先読みする
    try {
      const res = await fetch(BASE_PATH + 'songs/index.json');
      const data = await res.json();
      const songUrls = (data.songs || []).map((s) => `${BASE_PATH}songs/${s.id}.json`);
      await cache.addAll(songUrls);
    } catch (e) {
      // オフライン初回インストール等では失敗しうる。致命的ではないので無視。
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

function isNetworkFirst(url) {
  // HTML本体（ナビゲーションリクエスト含む）と songs/*.json はネットワーク優先
  if (url.pathname.endsWith('/index.html') || url.pathname === BASE_PATH) return true;
  if (/\/songs\/.*\.json$/.test(url.pathname)) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部通信はしない方針（仕様どおり）

  // ナビゲーション（アドレスバー直打ち・ホーム画面起動）も index.html と同じ扱いにする
  const networkFirst = req.mode === 'navigate' || isNetworkFirst(url);

  if (networkFirst) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await cache.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const indexCached = await cache.match(BASE_PATH + 'index.html');
          if (indexCached) return indexCached;
        }
        throw e;
      }
    })());
    return;
  }

  // それ以外はキャッシュ優先
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch (e) {
      return cached || Response.error();
    }
  })());
});
