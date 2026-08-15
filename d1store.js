'use strict';
/**
 * Cloudflare D1 存储后端（零依赖：使用 fetch 直连 D1 REST API）
 *
 * 配置来源（优先级）：
 *   1) configure(env) 注入（Cloudflare Workers 中从 handler 的 env 读取，见 worker.js）
 *   2) process.env（Node 本地 server.js 运行时）
 * 仅当 D1_ACCOUNT_ID / D1_DATABASE_ID / CF_API_TOKEN 三者齐备才启用 D1，
 * 否则回落到本地文件（api.js 中由 fs 分支处理）。
 *
 * 数据模型：整份应用状态以单个 JSON 文本存入 store 表的一行（k='store'），
 * 这样可 100% 复用原有逻辑（账号 / token / 记录 / 打卡 / 盲盒 / 墓碑），
 * 只是把「读写这个 JSON」从本地文件换成 D1 单行。
 */

// Worker 运行时 process 可能不存在 → 用 typeof 守卫，避免模块加载即崩溃
const _env = (typeof process !== 'undefined' && process.env) ? process.env : {};
let ACCOUNT_ID = _env.D1_ACCOUNT_ID;
let DATABASE_ID = _env.D1_DATABASE_ID;
let API_TOKEN = _env.CF_API_TOKEN;

// 由调用方（Worker handler）注入运行时环境变量
function configure(env) {
    if (env) {
        if (env.D1_ACCOUNT_ID) ACCOUNT_ID = env.D1_ACCOUNT_ID;
        if (env.D1_DATABASE_ID) DATABASE_ID = env.D1_DATABASE_ID;
        if (env.CF_API_TOKEN) API_TOKEN = env.CF_API_TOKEN;
    }
}

function isConfigured() {
    return Boolean(ACCOUNT_ID && DATABASE_ID && API_TOKEN);
}

// endpoint 延迟计算：configure 之后才可能拿到真实账号/库 ID
function endpoint() {
    if (ACCOUNT_ID && DATABASE_ID) {
        return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;
    }
    return null;
}

let tableReady = false;

// 执行一条 D1 SQL（支持 ? 占位符的 bindings）
async function query(sql, bindings = []) {
    const ENDPOINT = endpoint();
    if (!ENDPOINT) throw new Error('D1 未配置（缺少 D1_ACCOUNT_ID / D1_DATABASE_ID / CF_API_TOKEN）');
    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql, bindings }),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.success) {
        throw new Error('D1 query failed: ' + JSON.stringify(json.errors || json));
    }
    return json.result || [];
}

// 幂等建表（多实例同时启动也安全）
async function ensureTable() {
    if (tableReady) return;
    await query('CREATE TABLE IF NOT EXISTS store (k TEXT PRIMARY KEY, v TEXT)');
    tableReady = true;
}

// 读取整份 store JSON（无数据则返回 null）
async function read() {
    await ensureTable();
    const rows = await query("SELECT v FROM store WHERE k = 'store'");
    const first = rows[0] && rows[0].results && rows[0].results[0];
    return first ? first.v : null;
}

// 覆盖写入整份 store JSON（INSERT 或 UPDATE 单行，原子操作）
async function write(value) {
    await ensureTable();
    await query(
        'INSERT INTO store (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
        ['store', value]
    );
}

module.exports = { configure, isConfigured, read, write, ensureTable };
