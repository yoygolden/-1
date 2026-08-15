# SwimTrack 部署与访问方案（GitHub + Cloudflare + 运行时）

> 目标：全部免费；**数据不丢失**、**上传/下载顺畅**、**账号多设备同步**。
> 当前代码已具备 D1 持久层（`d1store.js` + `server.js` 自动切换），本方案把它收敛为「Cloudflare 一家承载数据 + 永不休眠运行时」，并补上自动备份，彻底消除之前 Zeabur 临时盘 / 冷启动的隐患。

---

## 一、你的三个要求 → 怎么被满足

| 要求 | 采用方案 | 为什么有效 |
|------|----------|------------|
| **数据不丢失** | Cloudflare **D1**（托管 SQLite，多副本冗余）+ **每日自动备份到 R2** | 不再依赖任何容器的临时文件系统；即使误删/损坏也能从 R2 回滚 |
| **上传/下载顺畅** | 运行时用 **Cloudflare Workers**（永不休眠、边缘就近执行）+ D1 同区域读写为亚 50ms | 无冷启动等待；`/api/sync` 全量合并 + 内容签名防冲突 |
| **账号同步** | D1 作为**唯一真相源** + Token 多设备并存（≤10 台） | 任一端改动，其他端刷新即见，天然多设备共享 |

---

## 二、架构总览

```
                 GitHub (main 分支，代码源)
                          │  push 触发
                          ▼
              GitHub Actions ── wrangler deploy ──▶ Cloudflare Workers（运行时 / "其他"）
                                                          │
                              ┌───────────────────────────┼───────────────────────────┐
                              ▼                           ▼                          ▼
                        Cloudflare D1              Cloudflare R2              Cloudflare CDN
                      （账号/记录/打卡/盲盒）        （gallery 图片等媒体）      + 自定义域名(可选)
                      托管 SQLite，多副本            出 CF 免流量费              全球加速 / 微信友好
                              │
                              ▼
                    用户（微信内置浏览器 / 任意浏览器）
                    客户端 PWA：IndexedDB 离线缓存 + 定时 /api/sync 拉取
```

---

## 三、三层职责

1. **GitHub**：唯一代码源；push `main` 即自动部署（无需手动 CI 配置心智负担）。
2. **Cloudflare**（四个角色，全是免费额度）：
   - **D1**：主数据库（账号、token、成绩记录、打卡、盲盒、删除墓碑），托管 SQLite，自动冗余。
   - **R2**：媒体存储（跳绳/相册图片），出 Cloudflare 网络免流量费。
   - **CDN + 自定义域名**：全球加速、HTTPS、对微信内置浏览器通过率高。
   - **Workers**：运行时（即你提到的"其他"= 计算/访问层），永不休眠、边缘低延迟、免费 10 万次请求/天。
3. **客户端**：PWA 离线优先，断网时本地 IndexedDB 兜底，联网后 `/api/sync` 拉取合并。

---

## 四、需要改的代码（基础已就绪，可立即做）

- `server.js` 的 `http` 监听 → 包成 **Worker 的 `fetch` handler**（或保留 Node 版用于本地调试 / 灾备）。`d1store.js` 已用 `fetch` 直连 D1 REST，**无需改动**。
- **新增每日备份**：用 Worker Cron（或定时脚本）把 D1 整份 JSON 导出到 R2（带日期前缀），防单点损坏。
- **媒体走 R2**：gallery 图片上传经 Worker 代理写入 R2，下载走 R2 公链 / 签名 URL。
- **新增配置**：`wrangler.toml`（绑定 D1 / R2）、`.github/workflows/deploy.yml`（`wrangler deploy`）。

> 关键：D1 持久化逻辑（`d1.read/read/write`）已经是 env 驱动，运行时从 Node 切到 Worker 对业务代码零侵入。

---

## 五、你只需在控制台做（约 10 分钟，不涉及付费）

1. **Cloudflare**：
   - D1：新建 `swimtrack-db`，记下 **Account ID** 与 **Database ID**。
   - R2：新建存储桶（如 `swimtrack-media`）。
   - API Token：账号 → My Profile → API Tokens → Create Token（Custom）：
     - `Account → D1 → Edit`
     - `Account → R2 → Edit`
     - 复制生成的 token（仅显示一次）。
2. **部署凭证**（二选一）：
   - 本地装 `wrangler` 登录后部署；或
   - 在 GitHub 仓库 **Settings → Secrets** 放：`CF_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`R2_BUCKET`。
3. **连仓库部署**：Cloudflare Workers 控制台「Create → Connect Git」选 `yoygolden/-1`，填写上述变量 → 部署 → 得到 `*.workers.dev` 域名（或后绑自定义域名）。

---

## 六、验证清单

- 启动/部署日志出现 `store: Cloudflare D1` 即已接 D1；若为 `local file` 说明变量未生效（不可用）。
- 手机 + 电脑各登同一账号，任一端新增记录，另一端刷新即见 → 账号同步 OK。
- 断网在本地加记录，恢复网络后 `/api/sync` 自动合并 → 上传下载顺畅 OK。
- R2 桶出现 `backup/YYYY-MM-DD.json` → 自动备份生效 → 数据不丢兜底 OK。

---

## 七、"其他"平台的可选冗余（灾备）

- 若想要**非 Cloudflare** 的备用入口：保留 **Zeabur / Render** 连**同一个 D1**（共享库），作灾备域名；主用 Workers。数据始终在 D1，切换无感。
- 或**完全一家 Cloudflare**（Workers + D1 + R2），最省心、无跨厂商一致性问题。

---

## 八、风险与注意

- **D1 单行走 blob 的并发 last-write-wins**：个人多设备极罕见；已用 `pull-then-push` + 内容签名缓解。如需强一致，后续可升级为行级表（每用户/每记录一行）。
- **Workers 免费 10 万次请求/天**：个人使用远超够；超量再加 CDN 缓存或付费。
- **微信内打开**：建议绑自定义域名 + Cloudflare 橙云代理，通过率最高；`*.workers.dev` 一般也能开，但个别环境会拦。
- **唯一真付费风险点**：Cloudflare 全免费；任何 PaaS（Zeabur/Render）免费版都可能休眠，所以主用 Workers 最稳。

---

## 九、与上一版（Zeabur）的差异

| 维度 | 上一版 Zeabur + D1 | 本版 Cloudflare Workers + D1 + R2 |
|------|-------------------|-----------------------------------|
| 运行时是否休眠 | 是（冷启动数秒） | 否（永不休眠） |
| 数据落点 | D1（OK） | D1 + R2 备份（更稳） |
| 媒体存储 | 无（仅 IndexedDB 本地） | R2（可跨设备持久） |
| 访问域名 | `*.zeabur.app` | `*.workers.dev` / 自定义域名 |
| 数据丢失风险 | 取决于是否接 D1 | D1 多副本 + 每日备份，双重保险 |
