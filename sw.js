// SwimTrack Service Worker —— 可「添加到主屏幕」并离线打开
const CACHE = 'swimtrack-v18';
const APP_SHELL = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './vendor/chart.umd.min.js',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    './icons/apple-touch-icon.png'
];

// 安装：预缓存应用外壳，并立即激活新版本（skipWaiting 让更新尽快生效）
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
    );
});

// 激活：清理旧缓存（v1 等），并接管所有已打开的页面
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// 拦截请求：全局「网络优先」
// 在线时永远拉取最新文件，避免旧缓存导致功能异常（例如登录误走本地而非云端）。
// 离线时回退到缓存，保证仍可打开应用。
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return; // 不拦截 POST（/api 写入类请求直接走网络）
    const url = new URL(req.url);

    event.respondWith(
        fetch(req).then((res) => {
            // 仅缓存同源的成功响应，供离线兜底
            if (res && res.ok && url.origin === self.location.origin) {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
        }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
});
