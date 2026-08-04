#!/usr/bin/env node
/**
 * SwimTrack 云端账号后端（零依赖 Node.js）
 * - 静态文件服务（同域名托管前端）
 * - 账号注册 / 登录（scrypt 密码哈希 + Bearer Token）
 * - 成绩记录同步 CRUD / 导入导出
 * 数据持久化到 ./data/store.json
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
// 数据目录：默认 ./data；在 Railway/Render 挂了持久磁盘时，把 DATA_DIR 指到挂载点（如 /data）即可永久保存
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

// ---------- 数据持久化 ----------
function loadStore() {
    try {
        const s = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
        // 兼容旧数据：token(字符串) → tokens(数组)，支持同一账号多设备同时登录
        if (s && s.users) {
            for (const acc in s.users) {
                const u = s.users[acc];
                if (u && typeof u.token === 'string') { u.tokens = [u.token]; delete u.token; }
                if (!Array.isArray(u.tokens)) u.tokens = [];
            }
        }
        return s;
    } catch {
        return { users: {} }; // users[account] = { account, salt, hash, tokens:[], nickname, records: [] }
    }
}
let store = loadStore();
let saveTimer = null;
function saveStore() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
        } catch (e) {
            console.error('保存失败', e);
        }
    }, 200);
}

// ---------- 工具 ----------
function hashPassword(password, salt) {
    salt = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { salt, hash };
}
function newToken() {
    return crypto.randomBytes(24).toString('hex');
}
const BLINDBOX_COST = 10; // 抽一次盲盒消耗的积分（需与前端一致）
// 积分始终由「打卡+记录」派生，盲盒消耗，保证多端一致：
// 积分 = Σ打卡积分 + Σ记录积分 − 盲盒数×成本
function computePoints(u) {
    const earned = (u.checkins || []).reduce((s, c) => s + (c.points || 0), 0)
                + (u.records || []).reduce((s, r) => s + (r.earnedPoints || 0), 0);
    const spent = (u.blindBoxes || []).length * BLINDBOX_COST;
    return Math.max(0, earned - spent);
}
function send(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => {
            try { resolve(data ? JSON.parse(data) : {}); }
            catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}
function getUserByToken(req) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return null;
    for (const acc in store.users) {
        const u = store.users[acc];
        if (Array.isArray(u.tokens) && u.tokens.includes(token)) return u;
    }
    return null;
}

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
    // 防目录穿越
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

// ---------- API ----------
async function handleApi(req, res, url) {
    const method = req.method;
    const p = url.pathname; // /api/...

    // 注册
    if (p === '/api/register' && method === 'POST') {
        const b = await readBody(req);
        if (!b.account || !b.password) return send(res, 400, { error: '账号和密码不能为空' });
        if (store.users[b.account]) return send(res, 409, { error: '该账号已存在' });
        const { salt, hash } = hashPassword(b.password);
        const token = newToken();
        store.users[b.account] = {
            account: b.account,
            salt, hash,
            tokens: [token],
            nickname: b.nickname || b.account,
            records: [],
            checkins: [],
            blindBoxes: []
        };
        saveStore();
        return send(res, 200, { token, nickname: store.users[b.account].nickname, account: b.account });
    }

    // 登录
    if (p === '/api/login' && method === 'POST') {
        const b = await readBody(req);
        const u = store.users[b.account];
        if (!u) return send(res, 401, { error: '账号不存在' });
        const { hash } = hashPassword(b.password, u.salt);
        if (hash !== u.hash) return send(res, 401, { error: '密码错误' });
        // 追加新 token，不覆盖旧设备会话（多设备同时在线同步）
        u.tokens = Array.isArray(u.tokens) ? u.tokens : [];
        const token = newToken();
        u.tokens.push(token);
        if (u.tokens.length > 5) u.tokens = u.tokens.slice(-5); // 保留最近 5 台设备的会话
        saveStore();
        return send(res, 200, { token: token, nickname: u.nickname, account: u.account });
    }

    // 以下接口需要登录
    const user = getUserByToken(req);
    if (!user) return send(res, 401, { error: '未登录或登录已过期' });

    // 当前用户信息
    if (p === '/api/me' && method === 'GET') {
        return send(res, 200, { account: user.account, nickname: user.nickname });
    }
    if (p === '/api/me' && method === 'PUT') {
        const b = await readBody(req);
        if (b.nickname) user.nickname = b.nickname;
        saveStore();
        return send(res, 200, { account: user.account, nickname: user.nickname });
    }

    // 记录列表
    if (p === '/api/records' && method === 'GET') {
        return send(res, 200, { records: user.records });
    }

    // 新增记录
    if (p === '/api/records' && method === 'POST') {
        const b = await readBody(req);
        const rec = b.record || b;
        if (!rec.id || !rec.stroke) {
            return send(res, 400, { error: '记录不完整' });
        }
        const now = Date.now();
        const item = {
            id: rec.id || crypto.randomBytes(8).toString('hex'),
            stroke: rec.stroke,
            distance: rec.distance,
            timeMs: rec.timeMs,
            date: rec.date || new Date().toISOString().slice(0, 10),
            type: rec.type || 'training',
            eventName: rec.eventName || '',
            note: rec.note || '',
            createdAt: rec.createdAt || now
        };
        user.records.push(item);
        saveStore();
        return send(res, 200, { record: item });
    }

    // 更新 / 删除单条（/api/records/:id）
    const m = p.match(/^\/api\/records\/([\w-]+)$/);
    if (m) {
        const id = m[1];
        const idx = user.records.findIndex((r) => r.id === id);
        if (method === 'PUT') {
            if (idx < 0) return send(res, 404, { error: '记录不存在' });
            const b = await readBody(req);
            user.records[idx] = { ...user.records[idx], ...b.record, id };
            saveStore();
            return send(res, 200, { record: user.records[idx] });
        }
        if (method === 'DELETE') {
            if (idx < 0) return send(res, 404, { error: '记录不存在' });
            user.records.splice(idx, 1);
            saveStore();
            return send(res, 200, { ok: true });
        }
    }

    // 同步全量资料（记录+打卡+盲盒），按各自主键合并，返回最新全量（多端一致）
    if (p === '/api/sync' && method === 'POST') {
        const b = await readBody(req);
        // 记录：按 id 合并
        const recMap = {};
        user.records.forEach((r) => (recMap[r.id] = r));
        (Array.isArray(b.records) ? b.records : []).forEach((r) => {
            if (r && r.id) recMap[r.id] = { ...r };
        });
        user.records = Object.values(recMap);
        // 打卡：按 date 合并（每日一条）
        const ckMap = {};
        user.checkins.forEach((c) => (ckMap[c.date] = c));
        (Array.isArray(b.checkins) ? b.checkins : []).forEach((c) => {
            if (c && c.date) ckMap[c.date] = { ...c };
        });
        user.checkins = Object.values(ckMap);
        // 盲盒：按 id 合并
        const bbMap = {};
        user.blindBoxes.forEach((x) => (bbMap[x.id] = x));
        (Array.isArray(b.blindBoxes) ? b.blindBoxes : []).forEach((x) => {
            if (x && x.id) bbMap[x.id] = { ...x };
        });
        user.blindBoxes = Object.values(bbMap);
        saveStore();
        return send(res, 200, {
            records: user.records,
            checkins: user.checkins,
            blindBoxes: user.blindBoxes,
            points: computePoints(user)
        });
    }

    // 拉取全量资料（记录+打卡+盲盒+积分），用于多端同步
    if (p === '/api/profile' && method === 'GET') {
        return send(res, 200, {
            records: user.records,
            checkins: user.checkins,
            blindBoxes: user.blindBoxes,
            points: computePoints(user)
        });
    }

    // 导出（完整备份）
    if (p === '/api/export' && method === 'GET') {
        return send(res, 200, {
            app: 'SwimTrack',
            version: 1,
            account: user.account,
            nickname: user.nickname,
            exportedAt: new Date().toISOString(),
            records: user.records
        });
    }

    // 导入（用备份覆盖云端记录）
    if (p === '/api/import' && method === 'POST') {
        const b = await readBody(req);
        const recs = Array.isArray(b.records) ? b.records : [];
        user.records = recs.map((r) => ({
            id: r.id || crypto.randomBytes(8).toString('hex'),
            stroke: r.stroke,
            distance: r.distance,
            timeMs: r.timeMs,
            date: r.date,
            type: r.type || 'training',
            eventName: r.eventName || '',
            note: r.note || '',
            createdAt: r.createdAt || Date.now()
        }));
        saveStore();
        return send(res, 200, { ok: true, count: user.records.length });
    }

    return send(res, 404, { error: '接口不存在' });
}

// ---------- 服务器 ----------
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
        handleApi(req, res, url).catch((e) => {
            console.error(e);
            send(res, 500, { error: '服务器错误' });
        });
        return;
    }
    serveStatic(req, res, url.pathname);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`SwimTrack server running on http://0.0.0.0:${PORT}`);
});
