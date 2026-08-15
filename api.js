'use strict';
/**
 * SwimTrack 核心逻辑（运行时无关：同时供 Node http 服务与 Cloudflare Workers 复用）
 * - 账号注册 / 登录（scrypt 密码哈希 + Bearer Token）
 * - 成绩记录同步 CRUD / 导入导出
 * - 积分服务端重算（不信任客户端上报）
 * 持久化：默认本地文件；配置 Cloudflare D1 环境变量后改用 D1（跨设备共享同一份数据）
 *
 * 本文件不依赖 http / 静态文件服务，只导出可被子进程 / Worker 复用的函数。
 */
const crypto = require('crypto');

// 惰性加载 fs/path：Workers 运行时无 fs，但生产用 D1 不会走到本地文件分支
let fs = null, path = null;
try { fs = require('fs'); path = require('path'); } catch (e) {}

const ROOT = __dirname;
const DATA_DIR = (typeof process !== 'undefined' && process.env && process.env.DATA_DIR)
    || (path ? path.join(ROOT, 'data') : '/tmp');
const STORE_FILE = path ? path.join(DATA_DIR, 'store.json') : '/tmp/store.json';

// ---------- 数据持久化 ----------
const d1 = require('./d1store');
let store = { users: {} };

// 旧数据兼容：token(字符串) → tokens(数组)，并补齐各数组字段，支持多设备同时登录
function normalizeStore(s) {
    if (s && s.users) {
        for (const acc in s.users) {
            const u = s.users[acc];
            if (u && typeof u.token === 'string') { u.tokens = [u.token]; delete u.token; }
            if (!Array.isArray(u.tokens)) u.tokens = [];
            if (!Array.isArray(u.deletedIds)) u.deletedIds = [];
            if (!Array.isArray(u.records)) u.records = [];
            if (!Array.isArray(u.checkins)) u.checkins = [];
            if (!Array.isArray(u.blindBoxes)) u.blindBoxes = [];
        }
    }
    return s || { users: {} };
}

async function loadStore() {
    if (d1.isConfigured()) {
        try {
            const v = await d1.read(); // 从 D1 读取整份 JSON
            if (v) { store = normalizeStore(JSON.parse(v)); return store; }
        } catch (e) {
            console.error('[store] D1 读取失败，回退空存储:', e.message);
        }
        store = { users: {} };
        return store;
    }
    try {
        if (fs) { store = normalizeStore(JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))); return store; }
    } catch { /* 无本地文件 → 空存储 */ }
    store = { users: {} };
    return store;
}

let saveTimer = null;
function saveStore() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        const data = JSON.stringify(store, null, 2);
        if (d1.isConfigured()) {
            d1.write(data).catch(e => console.error('[store] D1 写入失败:', e.message));
        } else if (fs && path) {
            try {
                fs.mkdirSync(DATA_DIR, { recursive: true });
                fs.writeFileSync(STORE_FILE, data);
            } catch (e) {
                console.error('保存失败', e);
            }
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
// 服务端按记录内容重算积分，不信任客户端上报的 earnedPoints（规则需与前端 pointsForRecord 一致）
function derivePoints(r) {
    if (!r) return 0;
    if (r.category === 'rope') return 1 + Math.floor((Number(r.count) || 0) / 200);
    const dist = Number(r.distance) || 0;
    if (r.category === 'run') return Math.max(1, Math.round(dist / 1000));
    return Math.max(1, Math.round(dist / 250));
}
// 过滤掉已软删除的记录，避免其他设备把删掉的记录同步回来（“删除复活”）
function liveRecords(u) {
    const dead = new Set(Array.isArray(u.deletedIds) ? u.deletedIds : []);
    return (u.records || []).filter((r) => r && !dead.has(r.id));
}
// 打卡积分同样服务端重算，规则与前端一致：5 + floor(此前累计数/5) + min(连续天数-1, 5)
function deriveCheckinTotal(checkins) {
    const list = (checkins || []).filter((c) => c && c.date)
        .map((c) => c.date).sort();
    const uniq = [...new Set(list)];
    let total = 0, streak = 0, prev = null;
    uniq.forEach((date, i) => {
        if (prev && (Date.parse(date + 'T00:00:00Z') - Date.parse(prev + 'T00:00:00Z')) === 86400000) streak += 1;
        else streak = 1;
        total += 5 + Math.floor(i / 5) + Math.min(streak - 1, 5);
        prev = date;
    });
    return total;
}
// 积分始终由「打卡+记录」派生，盲盒消耗，保证多端一致：
// 积分 = Σ打卡积分 + Σ记录积分 − 盲盒数×成本
function computePoints(u) {
    const earned = deriveCheckinTotal(u.checkins)
                + liveRecords(u).reduce((s, r) => s + derivePoints(r), 0);
    const spent = (u.blindBoxes || []).length * BLINDBOX_COST;
    return Math.max(0, earned - spent);
}

// 统一响应对象（不再直接写 res，交给各运行时适配层）
function json(status, obj) {
    return { status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj) };
}
// 解析请求体；空串返回 {}，非法 JSON 抛 SyntaxError（由 handleApi 捕获 → 400）
function parseBody(text) {
    if (!text) return {};
    return JSON.parse(text);
}
function getUserByToken(req) {
    const auth = (req.headers && req.headers['authorization']) || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return null;
    for (const acc in store.users) {
        const u = store.users[acc];
        if (Array.isArray(u.tokens) && u.tokens.includes(token)) return u;
    }
    return null;
}

// ---------- API ----------
// req 为归一化请求：{ method, pathname, query, headers, bodyText }
async function handleApi(req) {
    const method = req.method;
    const p = req.pathname;
    try {
        // 注册
        if (p === '/api/register' && method === 'POST') {
            const b = parseBody(req.bodyText);
            if (!b.account || !b.password) return json(400, { error: '账号和密码不能为空' });
            if (store.users[b.account]) return json(409, { error: '该账号已存在' });
            const { salt, hash } = hashPassword(b.password);
            const token = newToken();
            store.users[b.account] = {
                account: b.account,
                salt, hash,
                tokens: [token],
                nickname: b.nickname || b.account,
                records: [],
                checkins: [],
                blindBoxes: [],
                deletedIds: []
            };
            saveStore();
            return json(200, { token, nickname: store.users[b.account].nickname, account: b.account });
        }

        // 登录
        if (p === '/api/login' && method === 'POST') {
            const b = parseBody(req.bodyText);
            const u = store.users[b.account];
            if (!u) return json(401, { error: '账号不存在' });
            const { hash } = hashPassword(b.password, u.salt);
            if (hash !== u.hash) return json(401, { error: '密码错误' });
            u.tokens = Array.isArray(u.tokens) ? u.tokens : [];
            const token = newToken();
            u.tokens.push(token);
            if (u.tokens.length > 10) u.tokens = u.tokens.slice(-10); // 保留最近 10 台设备的会话
            saveStore();
            return json(200, { token: token, nickname: u.nickname, account: u.account });
        }

        // 以下接口需要登录
        const user = getUserByToken(req);
        if (!user) return json(401, { error: '未登录或登录已过期' });

        // 当前用户信息
        if (p === '/api/me' && method === 'GET') {
            return json(200, { account: user.account, nickname: user.nickname });
        }
        if (p === '/api/me' && method === 'PUT') {
            const b = parseBody(req.bodyText);
            if (b.nickname) user.nickname = b.nickname;
            saveStore();
            return json(200, { account: user.account, nickname: user.nickname });
        }

        // 记录列表
        if (p === '/api/records' && method === 'GET') {
            return json(200, { records: liveRecords(user) });
        }

        // 新增记录
        if (p === '/api/records' && method === 'POST') {
            const b = parseBody(req.bodyText);
            const rec = b.record || b;
            if (!rec.id || !rec.stroke) {
                return json(400, { error: '记录不完整' });
            }
            const now = Date.now();
            const item = {
                id: rec.id || crypto.randomBytes(8).toString('hex'),
                stroke: rec.stroke,
                category: rec.category || 'swim',
                distance: Number(rec.distance) || 0,
                count: Number(rec.count) || 0,
                timeMs: Number(rec.timeMs) || 0,
                date: rec.date || new Date().toISOString().slice(0, 10),
                type: rec.type || 'training',
                eventName: rec.eventName || '',
                note: rec.note || '',
                route: rec.route || null,
                createdAt: rec.createdAt || now
            };
            item.earnedPoints = derivePoints(item); // 服务端重算，忽略客户端上报值
            user.records.push(item);
            saveStore();
            return json(200, { record: item });
        }

        // 更新 / 删除单条（/api/records/:id）
        const m = p.match(/^\/api\/records\/([\w-]+)$/);
        if (m) {
            const id = m[1];
            const idx = user.records.findIndex((r) => r.id === id);
            if (method === 'PUT') {
                if (idx < 0) return json(404, { error: '记录不存在' });
                const b = parseBody(req.bodyText);
                const merged = { ...user.records[idx], ...b.record, id };
                merged.earnedPoints = derivePoints(merged); // 编辑后重算积分
                user.records[idx] = merged;
                saveStore();
                return json(200, { record: merged });
            }
            if (method === 'DELETE') {
                if (idx < 0) return json(404, { error: '记录不存在' });
                user.records.splice(idx, 1);
                if (!Array.isArray(user.deletedIds)) user.deletedIds = [];
                if (!user.deletedIds.includes(id)) user.deletedIds.push(id);
                saveStore();
                return json(200, { ok: true });
            }
        }

        // 同步全量资料（记录+打卡+盲盒），按各自主键合并，返回最新全量（多端一致）
        if (p === '/api/sync' && method === 'POST') {
            const b = parseBody(req.bodyText);
            if (!Array.isArray(user.deletedIds)) user.deletedIds = [];
            (Array.isArray(b.deletedIds) ? b.deletedIds : []).forEach((id) => {
                if (id && !user.deletedIds.includes(id)) user.deletedIds.push(id);
            });
            const dead = new Set(user.deletedIds);
            const recMap = {};
            user.records.forEach((r) => { if (r && !dead.has(r.id)) recMap[r.id] = r; });
            (Array.isArray(b.records) ? b.records : []).forEach((r) => {
                if (r && r.id && !dead.has(r.id)) recMap[r.id] = { ...r, earnedPoints: derivePoints(r) };
            });
            user.records = Object.values(recMap);
            const ckMap = {};
            user.checkins.forEach((c) => (ckMap[c.date] = c));
            (Array.isArray(b.checkins) ? b.checkins : []).forEach((c) => {
                if (c && c.date) ckMap[c.date] = { ...c };
            });
            user.checkins = Object.values(ckMap);
            const bbMap = {};
            user.blindBoxes.forEach((x) => (bbMap[x.id] = x));
            (Array.isArray(b.blindBoxes) ? b.blindBoxes : []).forEach((x) => {
                if (x && x.id) bbMap[x.id] = { ...x };
            });
            user.blindBoxes = Object.values(bbMap);
            saveStore();
            return json(200, {
                records: liveRecords(user),
                checkins: user.checkins,
                blindBoxes: user.blindBoxes,
                deletedIds: user.deletedIds,
                points: computePoints(user)
            });
        }

        // 拉取全量资料（记录+打卡+盲盒+积分），用于多端同步
        if (p === '/api/profile' && method === 'GET') {
            return json(200, {
                records: liveRecords(user),
                checkins: user.checkins,
                blindBoxes: user.blindBoxes,
                deletedIds: Array.isArray(user.deletedIds) ? user.deletedIds : [],
                points: computePoints(user)
            });
        }

        // 导出（完整备份）
        if (p === '/api/export' && method === 'GET') {
            return json(200, {
                app: 'SwimTrack',
                version: 1,
                account: user.account,
                nickname: user.nickname,
                exportedAt: new Date().toISOString(),
                records: liveRecords(user),
                checkins: user.checkins || [],
                blindBoxes: user.blindBoxes || []
            });
        }

        // 导入（用备份覆盖云端记录）
        if (p === '/api/import' && method === 'POST') {
            const b = parseBody(req.bodyText);
            const recs = Array.isArray(b.records) ? b.records : [];
            user.records = recs.map((r) => {
                const item = {
                    id: r.id || crypto.randomBytes(8).toString('hex'),
                    stroke: r.stroke,
                    category: r.category || 'swim',
                    distance: Number(r.distance) || 0,
                    count: Number(r.count) || 0,
                    timeMs: Number(r.timeMs) || 0,
                    date: r.date,
                    type: r.type || 'training',
                    eventName: r.eventName || '',
                    note: r.note || '',
                    route: r.route || null,
                    createdAt: r.createdAt || Date.now()
                };
                item.earnedPoints = derivePoints(item);
                return item;
            });
            user.deletedIds = []; // 导入整体覆盖，墓碑清空避免挡住重新导入
            saveStore();
            return json(200, { ok: true, count: user.records.length });
        }

        return json(404, { error: '接口不存在' });
    } catch (e) {
        if (e && e instanceof SyntaxError) return json(400, { error: '请求体格式错误' });
        console.error(e);
        return json(500, { error: '服务器错误' });
    }
}

function getStoreMode() { return d1.isConfigured() ? 'Cloudflare D1' : 'local file'; }
function getStoreSnapshot() { return JSON.stringify(store, null, 2); }

module.exports = { handleApi, loadStore, getStoreMode, getStoreSnapshot, configureD1: d1.configure };
