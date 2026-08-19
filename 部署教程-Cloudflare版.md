# SwimTrack 部署教程（小鱼游泳 · 多设备云同步 · Cloudflare 版）

> 目标：把整个项目部署到 Cloudflare，得到一个**固定网址**。手机用这个网址打开，就能注册 / 登录账号，在任何设备上查看同一份游泳成绩。
> 全程免费、数据不丢失、永不休眠。

---

## 一、原理（1 分钟看懂）

- `worker.js` 是 Cloudflare Workers 的入口：它把 `public/` 下的网页（`index.html`、`app.js` 等）交给 Cloudflare 的静态资源服务，把 `/api/*` 请求转给 `api.js` 处理账号与成绩。
- 前端 `app.js` 使用相对路径 `/api/...`，所以**前端和后端在同一个网址下、同源**，多设备登录直接能用，不用改任何代码。
- 数据存在 **Cloudflare D1**（托管版 SQLite 数据库），不是本地文件，也不是 R2 对象存储。

```
你手机  ──打开网址──▶  Cloudflare Workers（swimtrack.<子域>.workers.dev）
                           ├── Workers Assets：返回 public/ 下的网页
                           └── /api/* ──▶ api.js ──▶ D1 数据库（账号 + 成绩 + 打卡 + 盲盒）
```

注意：本方案**不用 R2**。SwimTrack 的数据全是结构化文字（账号 / 成绩 / 打卡 / 盲盒），D1 比把 JSON 塞进 R2 更合适；只有将来要存用户上传的图片 / 视频时才需要 R2，现在没有这个需求。

---

## 二、准备：代码已在 GitHub

代码已推到仓库 `yoygolden/-1` 的 `main` 分支，里面需要包含：
- `worker.js`（Workers 入口）
- `wrangler.toml`（已写死 Cloudflare `account_id`、D1 `database_id`、`database_name = swimtrack-db`）
- `d1store.js`、`migrations/0001_init.sql`（D1 存储层与建表脚本）
- `public/`（前端网页与静态资源）
- `.github/workflows/deploy.yml`（自动部署）、`backup.yml`（每日备份）

---

## 三、Cloudflare 控制台准备（一次性，约 5 分钟）

### 1. 建 D1 数据库
1. 登录 https://dash.cloudflare.com
2. 左侧 **Workers & Pages → D1** → **Create database**
3. 名字填 `swimtrack-db`，点创建
4. 创建后页面会显示 **database_id**（形如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`），先记下来
   - 本项目 `wrangler.toml` 已经把 `account_id`、`database_id`、`database_name` 都填好了，所以你只需在控制台建好这个库，配置不用再动。

### 2. 建 API Token（只需两项权限）
1. 右上角头像 → **My Profile → API Tokens → Create Token** → **Create Custom Token**
2. Permissions 加两项（**务必选 Account 维度，不要选 Zone**）：
   - `Account · D1 · Edit`
   - `Account · Cloudflare Workers · Edit`
3. 其余默认 → **Continue to summary → Create Token**
4. 复制生成的 Token 值（只显示这一次，形如 `cfr_...` / `cfut_...`）

> 之前那次 `cfat_...` 三项权限全报 10000，就是因为建 Token 时选了 Zone 而非 Account 作用域。这次一定在 **Account** 维度勾选。

### 3.（可选）在 GitHub 放 Secrets 启用自动部署 / 备份
仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加：
- `CF_DEPLOY_TOKEN` = 上面的 Token
- `CF_ACCOUNT_ID` = Cloudflare 账号 ID（My Profile 里有）
- `D1_DATABASE_ID` = 上面的 database_id

因为 `wrangler.toml` 已写死 account 和 database，CI 实际上只要 `CF_DEPLOY_TOKEN` 就能跑通；三个都填更稳妥，也能让 `backup.yml` 的每日备份正常工作。

---

## 四、部署上线（两种方式）

### 方式 A：本地用 wrangler（本项目已帮你执行过）
```bash
wrangler d1 migrations apply swimtrack-db --remote   # 建 accounts 表
wrangler deploy                                      # 上线
```
部署完成会得到固定网址，例如：
`https://swimtrack.2277163335.workers.dev`

### 方式 B：GitHub Actions 自动部署
在仓库 push 一次（或到 **Actions → Deploy to Cloudflare → Run workflow** 手动触发），`deploy.yml` 会：
1. 先 `wrangler d1 migrations apply` 建表
2. 再 `wrangler deploy` 上线

---

## 五、使用

- 手机浏览器打开固定网址 → 「我的」页注册一个账号（如 `xiaoming` + 密码）
- 在另一台手机 / 电脑打开**同一个网址**，用同一账号**登录**
- 任意一端新增成绩，另一端刷新即可看到 → 多设备同步 OK
- 想放桌面快捷方式：手机浏览器菜单 →「添加到主屏幕」

---

## 六、数据备份（三道防线，防丢）

1. **D1 多副本冗余**：Cloudflare 自动维护，不用你管。
2. **每日 GitHub 备份**：`backup.yml` 每天 `wrangler d1 export` 把整库导出到 `backups/store.sql` 并提交进仓库（需在 GitHub Secrets 配置好上面三个变量）。
3. **旧数据迁移**：若你之前用本地文件 / 其它平台存过数据，本地跑：
   ```bash
   D1_ACCOUNT_ID=xxx D1_DATABASE_ID=yyy CF_API_TOKEN=zzz node tools/migrate-to-d1.js
   ```
   或部署后直接 `POST /api/restore`（带 `x-backup-token`）整体覆盖。

---

## 七、本地调试 / 回退

- 本地直接 `node server.js` 仍可用（走本地文件存储，`DATA_DIR` 控制路径），用于开发联调，不会动线上 D1。
- 想换回 Railway / Render 等 Node 平台也可以：`server.js` + 本地文件 / 挂盘即可，代码同一份。

---

## 八、常见问题

**Q：打开网页显示「云端服务暂不可用」？**
A：说明前端没和后端同源。请确认你打开的是 Cloudflare 给的固定网址（`*.workers.dev` 或你绑的自定义域名），而不是旧的 CloudStudio / Railway 链接。整套一起部署时前后端同域，不会出现这个提示。

**Q：多设备不同步？**
A：确认两端用的是**同一个账号**、且打开的是**同一个固定网址**。任一端加记录后，另一端刷新即见；若仍不见，检查部署日志是否出现 `store: Cloudflare D1`（若显示 `local file` 说明 D1 绑定没生效）。

**Q：忘记密码怎么办？**
A：目前后端没有「找回密码」。可在「我的」页「导出」备份，然后重新注册一个账号再「导入」。

**Q：数据存在哪里最安全？**
A：三层保险——(1) 每台手机本地 `localStorage`；(2) 云端 D1 账号；(3) 每日 GitHub 自动备份 `backups/store.sql`。

**Q：微信里打不开 `*.workers.dev`？**
A：建议绑一个你自己域名（在 Cloudflare 里给 Worker 添加 Custom Domain），通过率最高；`*.workers.dev` 一般也能打开，个别微信版本会拦。

**Q：想换平台 / 删掉重来？**
A：在 Cloudflare 控制台删掉 Worker / D1 即可，不影响你手机本地的数据。
