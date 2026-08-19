'use strict';
/**
 * SwimTrack 的 Cloudflare D1 存储后端（Workers 运行时使用）。
 * - 在 Workers 中通过 wrangler.toml 的 [[d1_databases]] binding（默认名 DB）注入；
 * - api.js 通过 configure(env) 把 env.DB 传进来，isConfigured() 判断是否已绑定；
 * - 数据按「账号」拆分存储：每条账号一行（accounts 表），避免单值超过 D1 的 1MB 限制。
 *
 * 本文件只依赖 D1 binding，不依赖 Node 的 fs / process，可在 Workers 中安全运行。
 * Node（本地开发 / Render 回退）下 env.DB 为空 → isConfigured() 为 false → 自动退回本地文件存储。
 */

let db = null;

function configure(env) {
    if (env && env.DB) db = env.DB;
}

function isConfigured() {
    return !!db;
}

// 读取整份 store（{ users: {...} }）为 JSON 字符串；无数据返回 null
async function read() {
    if (!db) return null;
    const res = await db.prepare('SELECT account, data FROM accounts').all();
    const rows = (res && res.results) || [];
    if (rows.length === 0) return null;
    const users = {};
    for (const r of rows) {
        try { users[r.account] = JSON.parse(r.data); } catch (e) { /* 跳过损坏行 */ }
    }
    return JSON.stringify({ users });
}

// 写入整份 store（对象）；按账号 upsert，并删除已不存在的账号行（防御性）
async function write(store) {
    if (!db) return;
    const users = (store && store.users) || {};
    const stmts = [];
    for (const acc of Object.keys(users)) {
        stmts.push(
            db.prepare('INSERT OR REPLACE INTO accounts (account, data) VALUES (?, ?)')
                .bind(acc, JSON.stringify(users[acc]))
        );
    }
    const keep = Object.keys(users);
    if (keep.length) {
        const ph = keep.map(() => '?').join(',');
        const existing = await db.prepare(`SELECT account FROM accounts WHERE account NOT IN (${ph})`).bind(...keep).all();
        for (const e of (existing.results || [])) {
            stmts.push(db.prepare('DELETE FROM accounts WHERE account = ?').bind(e.account));
        }
    }
    if (stmts.length) await db.batch(stmts);
}

module.exports = { configure, isConfigured, read, write };
