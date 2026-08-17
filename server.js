#!/usr/bin/env node
/**
 * SwimTrack Node 入口（Railway / 本地开发 / 灾备）
 * 同进程托管前端静态文件（serveStatic）+ /api 后端（api.js 核心逻辑）。
 * Railway 部署直接 `npm start` 即可，数据落在 DATA_DIR（建议挂持久化卷 /data）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApi, loadStore, getStoreMode } = require('./api');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

// ---------- 静态文件 ----------
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};
function serveStatic(req, res, urlPath) {
    let filePath = decodeURIComponent(urlPath);
    if (filePath === '/' || filePath === '') filePath = '/index.html';
    const full = path.normalize(path.join(ROOT, filePath));
    if (!full.startsWith(ROOT)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(full, (err, buf) => {
        if (err) {
            // SPA 回退到 index.html
            fs.readFile(path.join(ROOT, 'index.html'), (e2, idx) => {
                if (e2) { res.writeHead(404); res.end('Not found'); }
                else { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(idx); }
            });
            return;
        }
        const ext = path.extname(full).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(buf);
    });
}

// ---------- 服务器 ----------
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
        let body = '';
        for await (const c of req) body += c;
        try {
            const response = await handleApi({
                method: req.method,
                pathname: url.pathname,
                query: url.search.slice(1),
                headers: req.headers,
                bodyText: body
            });
            res.writeHead(response.status, response.headers);
            res.end(response.body);
        } catch (e) {
            console.error(e);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: '服务器错误' }));
        }
        return;
    }
    serveStatic(req, res, url.pathname);
});

// 启动前先加载存储（D1 或本地文件），保证请求处理前 store 已就绪
(async () => {
    await loadStore();
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`SwimTrack server running on http://0.0.0.0:${PORT} (store: ${getStoreMode()})`);
    });
})();
