// SwimTrack Service Worker —— 让应用可「添加到主屏幕」并离线打开
const CACHE = 'swimtrack-v1';
const APP_SHELL = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    './icons/apple-touch-icon.png'
];

// 安装：预缓存应用外壳
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
    );
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// 拦截请求
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // 1) 页面导航：网络优先，失败回退缓存（保证离线也能打开）
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).then((res) => {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put('./index.html', copy));
                return res;
            }).catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
        );
        return;
    }

    // 2) 同域名静态资源：缓存优先 + 后台更新
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(req).then((cached) => {
                const network = fetch(req).then((res) => {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy));
                    return res;
                }).catch(() => cached);
                return cached || network;
            })
        );
        return;
    }

    // 3) 第三方（如 Chart.js CDN）：运行时缓存，首次联网后离线可用
    event.respondWith(
        caches.match(req).then((cached) => {
            if (cached) return cached;
            return fetch(req).then((res) => {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(req, copy));
                return res;
            }).catch(() => cached);
        })
    );
});
