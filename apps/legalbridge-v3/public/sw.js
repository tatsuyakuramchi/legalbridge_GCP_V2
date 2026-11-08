/*
 * LegalBridge V3 の service worker（PWA。docs/v3-local-app-cloud-db.md §7）。
 *
 * ねらいは「ホーム画面・デスクトップにアプリとして置ける」ことと、回線が切れたときに白い画面ではなく
 * 直前の画面の殻を出すこと。台帳の中身（/api）は一切持たない。古い版の画面が残る事故を避けるため、
 * index.html はいつもネットワークを先に見る（配信側も no-cache。server/app.ts）。
 *
 *   /api /health /internal /auth … 触らない（ブラウザがそのまま取りに行く）
 *   画面の遷移（index.html）    … ネットワーク優先。切れていれば置いてある殻
 *   /assets/（名前にハッシュ）   … キャッシュ優先。名前が変われば別物なので長く持ってよい
 *   それ以外（アイコン・manifest）… 置いてあるものを返しつつ裏で取り直す
 *
 * 版（VERSION）を上げると、次に開いたときに古いキャッシュを捨てる。新しい版が入ったら画面に知らせ、
 * 人が「再読み込み」を押したときだけ入れ替える（入力中の内容を勝手に消さない。client/pwa.ts）。
 */
const VERSION = "2026-11-08a";
const SHELL = `lb-shell-${VERSION}`;
const ASSETS = `lb-assets-${VERSION}`;
const STATIC = `lb-static-${VERSION}`;
const KEEP = new Set([SHELL, ASSETS, STATIC]);
const SHELL_URL = "/";
const PASS_THROUGH = [/^\/api(\/|$)/, /^\/health$/, /^\/internal(\/|$)/, /^\/auth(\/|$)/];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // 殻は配信側の no-cache に合わせ、ブラウザのキャッシュを飛ばして取る。
    try { await cache.add(new Request(SHELL_URL, { cache: "reload" })); } catch { /* オフラインで入ったときは次の機会に */ }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("lb-") && !KEEP.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// 画面側の「再読み込み」で入れ替える（client/pwa.ts）。
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (PASS_THROUGH.some((re) => re.test(url.pathname))) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        // 取れた殻を置き直す（オフラインのときに出すのはいつも最新の殻）。
        if (fresh.ok) { const cache = await caches.open(SHELL); cache.put(SHELL_URL, fresh.clone()).catch(() => undefined); }
        return fresh;
      } catch {
        const cached = await caches.match(SHELL_URL);
        return cached ?? new Response("オフラインです。回線がつながってから開き直してください。",
          { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSETS);
      const hit = await cache.match(request);
      if (hit) return hit;
      const fresh = await fetch(request);
      if (fresh.ok) cache.put(request, fresh.clone()).catch(() => undefined);
      return fresh;
    })());
    return;
  }

  // アイコン・manifest・sw.js 自身など。置いてあるものを先に返し、裏で取り直す。
  event.respondWith((async () => {
    const cache = await caches.open(STATIC);
    const hit = await cache.match(request);
    const refresh = fetch(request).then((fresh) => {
      if (fresh.ok) cache.put(request, fresh.clone()).catch(() => undefined);
      return fresh;
    });
    if (hit) { refresh.catch(() => undefined); return hit; }
    return refresh;
  })());
});
