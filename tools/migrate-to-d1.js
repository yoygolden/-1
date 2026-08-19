'use strict';
/**
 * 一次性迁移工具：把本地 ./data/store.json 导入到 Cloudflare D1（通过 D1 REST API，无需本机安装 wrangler）。
 * 适用于你之前用本地文件 / Render 存过数据、想迁到 Cloudflare D1 的场景。
 *
 * 用法（在本机 swim-tracker 目录下）：
 *   D1_ACCOUNT_ID=xxx D1_DATABASE_ID=yyy CF_API_TOKEN=zzz node tools/migrate-to-d1.js
 *
 * 也可在已部署后，用 Cloudflare 控制台 / wrangler 直接把旧数据 POST 到 /api/restore（需 x-backup-token）。
 */
const fs = require('fs');
const path = require('path');

const ACCOUNT = process.env.D1_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
const DBID = process.env.D1_DATABASE_ID;
const TOKEN = process.env.CF_API_TOKEN || process.env.CF_API_TOKEN;

if (!ACCOUNT || !DBID || !TOKEN) {
    console.error('请先设置环境变量：D1_ACCOUNT_ID / D1_DATABASE_ID / CF_API_TOKEN');
    process.exit(1);
}

async function d1Query(sql, params = []) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DBID}/query`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params })
    });
    const j = await r.json();
    if (!j.success) throw new Error(JSON.stringify(j.errors || j.messages || j));
    return j.result;
}

(async () => {
    const file = path.join(__dirname, '..', 'data', 'store.json');
    if (!fs.existsSync(file)) {
        console.error('未找到本地 data/store.json，无需迁移。');
        process.exit(0);
    }
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    const users = (store && store.users) || {};

    // 确保表存在（与 migrations/0001_init.sql 一致）
    await d1Query('CREATE TABLE IF NOT EXISTS accounts (account TEXT PRIMARY KEY, data TEXT NOT NULL)');

    // 按账号 upsert（与 d1store.write 一致）
    for (const acc of Object.keys(users)) {
        await d1Query(
            'INSERT OR REPLACE INTO accounts (account, data) VALUES (?, ?)',
            [acc, JSON.stringify(users[acc])]
        );
        console.log('  迁移账号:', acc);
    }
    console.log(`✅ 已迁移 ${Object.keys(users).length} 个账号到 Cloudflare D1（swimtrack）。`);
})().catch((e) => { console.error('迁移失败:', e.message); process.exit(1); });
