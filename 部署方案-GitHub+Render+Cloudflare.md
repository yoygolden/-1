# 部署方案：GitHub + Render + Cloudflare（SwimTrack）

> 目标：免费、数据不丢、多设备共享、账号同步。代码已就绪，下面是你（或我）在控制台点几下即可上线的步骤。

## 一、架构

```
GitHub(main) ──自动部署──▶ Render(免费档, Node server.js)
                                  │
用户 ──▶ Cloudflare(域名/SSL/CDN) ──代理──▶ Render
            │                              │
            └── Cron 每5分钟访问 /api/health ┘ （保活，免休眠冷启动）

数据：Render 本地临时盘(store.json) ──每日──▶ GitHub 仓库 backups/store.json
      Render 启动时若本地为空，自动从 BOOTSTRAP_URL 拉回最新备份（自愈）
```

## 二、为什么选这套

- **Render 免费档**：15 分钟无访问自动休眠，但 Cloudflare Cron 每 5 分钟探一次 `/api/health` 即可保持在线，访问顺滑。
- **Cloudflare**：把你自己的域名（或 `onrender.com`）橙云代理，免费 SSL + 边缘缓存 + 保活。
- **数据不丢**：免费档无持久磁盘，所以靠「每日 GitHub 备份 + 启动自愈」两道防线，最多丢一天（极端情况），正常零丢失。

## 三、控制台操作步骤

### 1. Render（跑应用）
1. 打开 https://dashboard.render.com → **New → Web Service**。
2. 连接 GitHub → 选仓库 **`yoygolden/-1`**，分支 **`main`**。
3. Render 自动识别 `render.yaml`；确认：
   - Runtime: Node
   - Build: `npm install`
   - Start: `npm start`
   - Health Check Path: `/api/health`
4. 展开 **Environment**，手动添加两个变量：
   - `EXPORT_TOKEN` = 一段你自己定的随机串（例如 `openssl rand -hex 24` 的输出），**记下来**，下一步 GitHub 要用同一个值。
   - `BOOTSTRAP_URL` = 你仓库 `backups/store.json` 的 **raw 地址**，形如：
     `https://raw.githubusercontent.com/yoygolden/-1/main/backups/store.json`
     （仓库若为私有，改用带 PAT 的地址：`https://<PAT>@raw.githubusercontent.com/yoygolden/-1/main/backups/store.json`）
5. 点 **Create Web Service**，等首次部署完成，得到 `https://swimtrack-xxx.onrender.com`。

### 2. Cloudflare（域名 / SSL / 保活）
1. 域名已接入 Cloudflare：添加一条记录（CNAME 或 A）指向 `swimtrack-xxx.onrender.com`，并**开启橙色代理(Proxy)**。
2. SSL/TLS → Overview：模式选 **Full**（Render 自带证书）。
3. 保活（关键，免休眠）：Cloudflare 左侧 **Workers & Pages → 新建 Worker**，内容如下（把 URL 换成你的）：
   ```js
   export default {
     async scheduled(event, env) {
       await fetch('https://你的.onrender.com/api/health');
     }
   }
   ```
   绑定 **Triggers → Cron** 为 `*/5 * * * *`（每 5 分钟）。保存即生效。
   > 若没有自定义域名，也可直接用 Render 默认 `onrender.com` 地址 + 上面的 Worker 保活，只是没自有域名。

### 3. GitHub Secrets（每日备份）
仓库 `yoygolden/-1` → Settings → Secrets and variables → Actions → New repository secret：
- `APP_URL` = `https://swimtrack-xxx.onrender.com`（或你的自定义域名）
- `EXPORT_TOKEN` = 与 Render 里 `EXPORT_TOKEN` **完全相同**的值

加好后，Actions 里的 **Daily backup** 会在每天 UTC 16:23 自动跑一次，把整库存进 `backups/store.json`。

## 四、上线后验证
1. 打开你的域名，注册一个账号、录一条成绩 → 积分正确。
2. 换设备/换浏览器登录同一账号 → 数据同步、积分一致。
3. 第二天看 GitHub 的 `backups/store.json` 是否更新（说明自动备份生效）。
4. 故意重部署一次 Render → 启动后数据仍在（说明 BOOTSTRAP_URL 自愈生效）。

## 五、灾难恢复
若 Render 数据被清空且 `backups/store.json` 最新：重启实例即可自愈。
如需手动恢复：对线上 `POST /api/restore`（带 `x-backup-token`）发送某份 `store.json` 全量即可。

## 六、费用
- Render 免费档：0 元（绑定支付方式即可，不扣费）。
- Cloudflare 免费版：0 元。
- GitHub 私有仓库 Actions：免费额度内 0 元。
