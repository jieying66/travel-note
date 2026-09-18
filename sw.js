// ============================================================
// Service Worker：让应用没网也能打开
//
// 策略：
//   应用自己的文件（HTML/CSS/JS/图标）—— 缓存优先，装好后完全离线可用。
//   地图瓦片 —— 网络优先，成功了顺手缓存；没网就用缓存过的那片区域。
//     （所以走过一遍的地方，之后没网也能看到底图）
//   高德接口 —— 不缓存，搜索结果没有离线的意义。
//
// 改版本号会让旧缓存失效，用户刷新就拿到新代码。
// ============================================================

// 改了任何 js/css 都要动这个版本号，否则用户浏览器一直用旧缓存，
// 看不到新功能（很难察觉：文件在服务器上是新的，浏览器却不取）。
const VERSION = "v4";
const SHELL = `tn-shell-${VERSION}`;
const TILES = `tn-tiles-${VERSION}`;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/app.css",
  "./js/app.js",
  "./js/model.js",
  "./js/store.js",
  "./js/media.js",
  "./js/map.js",
  "./js/search.js",
  "./js/coord.js",
  "./js/ui.js",
  "./js/config.js",
  "./js/stopEdit.js",
  "./js/export.js",
  "./js/share.js",
  "./vendor/leaflet.js",
  "./vendor/leaflet.css",
  "./vendor/jszip.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL).then(async (c) => {
      // 逐个加，某个文件 404 不至于让整个安装失败
      await Promise.all(
        SHELL_FILES.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {}))
      );
      self.skipWaiting();
    })
  );
});

// 页面让新版本立刻接管（配合 index.html 里的更新检测）
self.addEventListener("message", (e) => {
  if (e.data?.type === "SKIP_WAITING") self.skipWaiting();
  // 页面每次启动都请一次清理。不能只依赖 activate：
  // SW 已在运行且版本没变时，activate 不会再触发，旧缓存就留着了。
  if (e.data?.type === "CLEAN_CACHES") {
    e.waitUntil?.(dropOldCaches());
    dropOldCaches().catch(() => {});
  }
});

/** 删掉所有非当前版本的缓存。旧版本留着只会白占几十兆。 */
async function dropOldCaches() {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((k) => k.startsWith("tn-") && k !== SHELL && k !== TILES)
      .map((k) => caches.delete(k).catch(() => {}))
  );
}

self.addEventListener("activate", (e) => {
  e.waitUntil(dropOldCaches().then(() => self.clients.claim()));
});

// 每次 SW 被唤醒也扫一遍 —— activate 只在版本切换时跑一次，
// 万一那次错过了（比如浏览器提前终止 SW），旧缓存会永久留着。
dropOldCaches().catch(() => {});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // 高德接口不缓存
  if (url.hostname.includes("restapi.amap.com")) return;

  // 地图瓦片：网络优先，顺手缓存
  if (
    url.hostname.includes("is.autonavi.com") ||
    url.hostname.includes("tile.openstreetmap.org")
  ) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(TILES).then((c) => c.put(req, copy).catch(() => {}));
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || Response.error()))
    );
    return;
  }

  // 同源文件：缓存优先
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req)
            .then((res) => {
              if (res.ok && res.type === "basic") {
                const copy = res.clone();
                caches.open(SHELL).then((c) => c.put(req, copy).catch(() => {}));
              }
              return res;
            })
            .catch(() => caches.match("./index.html"))
      )
    );
  }
});
