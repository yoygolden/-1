'use strict';
/**
 * 迁移工具：把本地 ./data/store.json 导入到 Cloudflare D1。
 * 仅在你之前用本地文件存过数据、且已配置好 D1 环境变量时使用。
 *
 * 用法（在本机 swim-tracker 目录下）：
 *   D1_ACCOUNT_ID=xxx D1_DATABASE_ID=yyy CF_API_TOKEN=zzz node tools/migrate-to-d1.js
 */
const fs = require('fs');
const path = require('path');
const d1 = require('../d1store');

(async () => {
    if (!d1.isConfigured()) {
        console.error('请先设置环境变量：D1_ACCOUNT_ID / D1_DATABASE_ID / CF_API_TOKEN');
        process.exit(1);
    }
    const file = path.join(__dirname, '..', 'data', 'store.json');
    if (!fs.existsSync(file)) {
        console.error('未找到本地 data/store.json，无需迁移。');
        process.exit(0);
    }
    const data = fs.readFileSync(file, 'utf8');
    await d1.write(data);
    console.log('✅ 已把本地 store.json 迁移到 Cloudflare D1（单 JSON 行覆盖写入）。');
    console.log('   之后 Zeabur 会从 D1 读取，多设备数据自动共享。');
})();
