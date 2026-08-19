# SwimTrack 部署方案（GitHub + Cloudflare Workers + D1，不用 R2）

> 目标：全部免费；**数据不丢失**、**多设备同步**、**永不休眠**。
> 结论先行：**只用 Cloudflare D1 存数据，不需要 R2。** SwimTrack 的全是结构化文本（账号/成绩/打卡/盲盒），D1（托管 SQLite）比塞 JSON 进 R2 更合适；R2 仅在你将来要存用户上传的图片/视频时才需要，现在没有这个需求。

---

## 一、架构总览

```
            GitHub (yoygolden/-1 的 main 分支)
                    │  push 触发
                    ▼
        GitHub Actions ── wrangler deploy ──▶ Cloudflare Workers（运行时）
                                                  │
                              ┌───────────────────┼───────────────────┐
                              ▼                                       ▼
                        Cloudflare D1                          Workers Assets（静态资源）
                      （账号/记录/打卡/盲盒）                    public/ 下的前端文件
                      托管 SQLite，多副本冗余                     index.html / app.js / ...
                              │
                              ▼
                    用户（微信内置浏览器 / 任意浏览器）
                    客户端 PWA：IndexedDB 离线缓存 + /api/sync 拉取
```

- **没有 R2**，没有对象存储，没有额外计费项。
- 静态资源放 `public/`，由 Workers Assets 直接提供；服务端代码（api.js / worker.js / d1store.js）**不对外暴露**。

---

## 二、为什么可以不用 R2

| 数据 | 形态 | 落点 |
|------|------|------|
| 账号、密码哈希、Token | 结构化 | D1 ✅ |
| 游泳/跳绳/跑步记录 | 结构化 JSON | D1 ✅ |
| 打卡、盲盒、积分 | 结构化 | D1 ✅ |
| 用户上传的图片/视频 | 二进制 blob | 暂无需求；将来才有，到时再加 R2 |

D1 单值上限 1MB——文本数据随便用，且本方案**按账号拆分存储**（每条账号一行），单账号数据远小于 1MB，完全无压力。

---

## 三、你需要做的（约 10 分钟，不花钱）

### 1. 准备 Cloudflare Token（只需两项权限，比之前少一项）
账号 → **My Profile → API Tokens → Create Token**（选 Custom Token）：
- `Account · D1 · Edit`
- `Account · Cloudflare Workers · Edit`
- （**不要**选 R2）
- 复制生成的 token（仅显示一次）。

> 之前那次 `cfat_...` 三项全报 10000，是因为建 Token 时选了 Zone 而非 Account 作用域。这次务必在 **Account** 维度勾选。

### 2. 建 D1 数据库（本地一次性）
```bash
npm install -g wrangler
wrangler login            # 浏览器登录 Cloudflare
wrangler d1 create swimtrack
```
记下输出里的 **database_id**（形如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）。

### 3. 在 GitHub 放三个 Secret
仓库 **Settings → Secrets and variables → Actions → New repository secret**，添加：
- `CF_DEPLOY_TOKEN` = 步骤 1 的 token
- `CF_ACCOUNT_ID` = Cloudflare 账号 ID（右上角 My Profile 里有）
- `D1_DATABASE_ID` = 步骤 2 的 database_id

### 4. 推送，自动部署
```bash
git push origin main
```
GitHub Actions 会：① 应用 D1 表结构迁移（建 `accounts` 表）② `wrangler deploy`。
完成后得到 `https://swimtrack.<你的子域>.workers.dev`，可选在 Cloudflare 控制台绑自定义域名。

---

## 四、验证清单

- 部署日志出现 `store: Cloudflare D1` → 已接 D1（若显示 `local file` 说明绑定没生效，不可用）。
- 手机 + 电脑各登同一账号，任一端加记录，另一端刷新即见 → 多设备同步 OK。
- 断网本地加记录，恢复后 `/api/sync` 自动合并 → 上传下载顺畅 OK。

---

## 五、数据备份与恢复（防丢三道防线）

1. **D1 多副本冗余**：Cloudflare 自动维护，不用你管。
2. **每日 GitHub 备份**：`.github/workflows/backup.yml` 每天 UTC 16:23 `wrangler d1 export` 整库到 `backups/store.sql` 提交进仓库。
3. **旧数据迁移**：若你之前用本地文件 / Render 存过数据，本地跑：
   ```bash
   D1_ACCOUNT_ID=xxx D1_DATABASE_ID=yyy CF_API_TOKEN=zzz node tools/migrate-to-d1.js
   ```
   或已部署后直接 `POST /api/restore`（带 `x-backup-token`）整体覆盖。

---

## 六、回退 / 本地调试

- 本地直接 `node server.js` 仍可用（走本地文件存储，`DATA_DIR` 控制路径），用于开发联调，不动线上 D1。
- 想回 Render 等也行：保持 `server.js` + 本地文件 / 挂盘即可，代码同一份。

---

## 七、风险与边界

- **D1 并发 last-write-wins**：个人多设备极罕见；已用「拉取合并 + 软删除墓碑」缓解。需要强一致时再升级为行级表（每记录一行）。
- **Workers 免费 10 万次请求/天**：个人使用远超够。
- **微信内打开**：建议绑自定义域名，通过率最高；`*.workers.dev` 一般也能开。
