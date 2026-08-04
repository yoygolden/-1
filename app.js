/* ============================================================
 * SwimTrack - 游泳成绩追踪应用
 * 纯前端实现，数据存储于 localStorage
 * ============================================================ */

/* ==================== 数据存储层 ==================== */
const Store = {
    // 所有数据保存在当前手机的浏览器本地（localStorage），永久存储、不过期、不主动清除。
    // 只要用户不卸载微信 / 不清理微信缓存，数据就会一直留在登录的这部手机上。
    USERS_KEY: 'swimtrack_users',
    SESSION_KEY: 'swimtrack_session',

    // 双写冗余：主 key 与备份 key 各写一份，任一损坏时可回退，进一步保证数据不丢失
    _persist(key, value) {
        try { localStorage.setItem(key, value); localStorage.setItem(key + '_bak', value); } catch (e) {}
    },
    _read(key) {
        let v = localStorage.getItem(key);
        if (v === null) v = localStorage.getItem(key + '_bak');
        return v;
    },
    _remove(key) {
        try { localStorage.removeItem(key); localStorage.removeItem(key + '_bak'); } catch (e) {}
    },

    getUsers() {
        try {
            return JSON.parse(this._read(this.USERS_KEY) || '{}');
        } catch { return {}; }
    },

    saveUsers(users) {
        this._persist(this.USERS_KEY, JSON.stringify(users));
    },

    register(account, password, nickname) {
        const users = this.getUsers();
        if (users[account]) {
            return { ok: false, msg: '该账号已存在' };
        }
        users[account] = {
            account,
            password,
            nickname,
            createdAt: Date.now(),
            records: []
        };
        this.saveUsers(users);
        return { ok: true };
    },

    login(account, password) {
        const users = this.getUsers();
        const user = users[account];
        if (!user) {
            return { ok: false, msg: '账号不存在' };
        }
        if (user.password !== password) {
            return { ok: false, msg: '密码错误' };
        }
        this.setSession(account);
        return { ok: true };
    },

    setSession(account) {
        this._persist(this.SESSION_KEY, account);
    },

    getSession() {
        return this._read(this.SESSION_KEY);
    },

    clearSession() {
        this._remove(this.SESSION_KEY);
    },

    getCurrentUser() {
        const account = this.getSession();
        if (!account) return null;
        const users = this.getUsers();
        return users[account] || null;
    },

    updateUser(updater) {
        const account = this.getSession();
        if (!account) return;
        const users = this.getUsers();
        if (!users[account]) return;
        updater(users[account]);
        this.saveUsers(users);
    },

    addRecord(record) {
        this.updateUser(user => {
            user.records.push(record);
        });
    },

    updateRecord(id, data) {
        this.updateUser(user => {
            const idx = user.records.findIndex(r => r.id === id);
            if (idx >= 0) {
                user.records[idx] = { ...user.records[idx], ...data };
            }
        });
    },

    deleteRecord(id) {
        this.updateUser(user => {
            user.records = user.records.filter(r => r.id !== id);
        });
    },

    getRecords() {
        const user = this.getCurrentUser();
        return user ? user.records : [];
    },

    updateNickname(nickname) {
        this.updateUser(user => {
            user.nickname = nickname;
        });
    },

    // 导入备份：按 id 合并（本地与导入并集，冲突时以导入为准），幂等且不丢本地独有数据
    mergeImported(imported) {
        this.updateUser(user => {
            const map = {};
            user.records.forEach(r => (map[r.id] = r));
            imported.forEach(r => {
                if (r && r.id) map[r.id] = { ...r };
            });
            user.records = Object.values(map);
        });
    },

    // 从云端下载：与本地记录合并（云端优先）
    mergeCloud(cloudRecords) {
        this.updateUser(user => {
            const map = {};
            user.records.forEach(r => (map[r.id] = r));
            cloudRecords.forEach(r => {
                if (r && r.id) map[r.id] = { ...r };
            });
            user.records = Object.values(map);
        });
    },

    // 合并云端全量资料（记录+打卡+盲盒），按各自主键合并
    mergeProfile(p) {
        if (!p) return;
        this.updateUser(user => {
            // 记录：按 id
            const recMap = {};
            user.records.forEach(r => (recMap[r.id] = r));
            (Array.isArray(p.records) ? p.records : []).forEach(r => {
                if (r && r.id) recMap[r.id] = { ...r };
            });
            user.records = Object.values(recMap);
            // 打卡：按 date
            const ckMap = {};
            user.checkins.forEach(c => (ckMap[c.date] = c));
            (Array.isArray(p.checkins) ? p.checkins : []).forEach(c => {
                if (c && c.date) ckMap[c.date] = { ...c };
            });
            user.checkins = Object.values(ckMap);
            // 盲盒：按 id
            const bbMap = {};
            (user.blindBoxes || []).forEach(x => (bbMap[x.id] = x));
            (Array.isArray(p.blindBoxes) ? p.blindBoxes : []).forEach(x => {
                if (x && x.id) bbMap[x.id] = { ...x };
            });
            user.blindBoxes = Object.values(bbMap);
        });
    },

    /* ---------- 打卡 / 积分 / 盲盒 ---------- */
    getCheckins() {
        const u = this.getCurrentUser();
        return u ? (u.checkins || []) : [];
    },
    addCheckin(entry) {
        this.updateUser(u => {
            u.checkins = u.checkins || [];
            u.checkins.push(entry);
        });
    },
    // 积分始终由「打卡 + 记录」派生、盲盒消耗，保证多端一致：
    // 积分 = Σ打卡积分 + Σ记录积分(earnedPoints) − 盲盒数 × 成本
    getPoints() {
        const u = this.getCurrentUser();
        if (!u) return 0;
        const earned = (u.checkins || []).reduce((s, c) => s + (c.points || 0), 0)
                    + (u.records || []).reduce((s, r) => s + (r.earnedPoints || 0), 0);
        const spent = (u.blindBoxes || []).length * BLINDBOX_COST;
        return Math.max(0, earned - spent);
    },
    addPoints(n) {
        // 保留方法以便兼容，实际积分改为派生（见 getPoints）
        this.updateUser(u => { u.points = (u.points || 0) + n; });
    },
    spendPoints(n) {
        this.updateUser(u => { u.points = Math.max(0, (u.points || 0) - n); });
    },
    getBlindBoxes() {
        const u = this.getCurrentUser();
        return u ? (u.blindBoxes || []) : [];
    },
    addBlindBox(item) {
        this.updateUser(u => {
            u.blindBoxes = u.blindBoxes || [];
            u.blindBoxes.push(item);
        });
    }
};

/* ==================== 云端账号 API（多设备同步） ==================== */
const CloudAPI = {
    TOKEN_KEY: 'swimtrack_cloud',
    ACCT_KEY: 'swimtrack_cloud_account',
    NICK_KEY: 'swimtrack_cloud_nick',

    get token() { return localStorage.getItem(this.TOKEN_KEY); },
    set token(t) { t ? localStorage.setItem(this.TOKEN_KEY, t) : localStorage.removeItem(this.TOKEN_KEY); },
    get account() { return localStorage.getItem(this.ACCT_KEY); },
    set account(a) { a ? localStorage.setItem(this.ACCT_KEY, a) : localStorage.removeItem(this.ACCT_KEY); },
    get nickname() { return localStorage.getItem(this.NICK_KEY); },
    set nickname(n) { n ? localStorage.setItem(this.NICK_KEY, n) : localStorage.removeItem(this.NICK_KEY); },
    get connected() { return !!this.token; },

    async request(path, opts = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
        const res = await fetch(path, {
            method: opts.method || 'GET',
            headers,
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        // 读取原始文本，若非 JSON（如静态托管返回 HTML）则提示服务不可用
        const text = await res.text();
        let data = {};
        try { data = JSON.parse(text); } catch (e) {
            throw new Error('云端服务暂不可用（当前访问环境未部署后端服务）');
        }
        if (!res.ok) {
            const err = new Error(data.error || ('请求失败 (' + res.status + ')'));
            err.status = res.status; // 透传状态码，便于识别 401 失效并重连
            throw err;
        }
        return data;
    },

    register(account, password, nickname) {
        return this.request('/api/register', { method: 'POST', body: { account, password, nickname } });
    },
    login(account, password) {
        return this.request('/api/login', { method: 'POST', body: { account, password } });
    },
    // 全量资料：记录 + 打卡 + 盲盒（多端一致）
    getProfile() { return this.request('/api/profile'); },
    syncProfile(profile) { return this.request('/api/sync', { method: 'POST', body: profile }); },
    exportData() { return this.request('/api/export'); },
    importData(records) { return this.request('/api/import', { method: 'POST', body: { records } }); },
    updateNickname(nickname) { return this.request('/api/me', { method: 'PUT', body: { nickname } }); }
};

/* ==================== 统一登录（云端优先 + 本地兜底 + 自动迁移） ==================== */
// 记录变更后，若已登录云端，防抖把本地全量资料（记录+打卡+盲盒）同步到后端（失败静默）
let _syncTimer = null;
let _lastSyncSig = ''; // 最近一次同步后的资料签名（记录+打卡+盲盒数量），用于判断是否需要刷新页面
function syncSignature() {
    return Store.getRecords().length + '|' + Store.getCheckins().length + '|' + Store.getBlindBoxes().length;
}
function buildProfile() {
    return {
        records: Store.getRecords(),
        checkins: Store.getCheckins(),
        blindBoxes: Store.getBlindBoxes()
    };
}
function scheduleCloudSync() {
    if (!CloudAPI.connected) return;
    if (_syncTimer) clearTimeout(_syncTimer);
    _syncTimer = setTimeout(() => {
        CloudAPI.syncProfile(buildProfile()).catch(() => {});
    }, 600);
}

// 把本地账号的会话/数据对齐到云端：写云端会话、建本地用户、双向同步记录
async function bindCloudSession(res, account, fallbackNickname, password) {
    CloudAPI.token = res.token;
    CloudAPI.account = res.account;
    CloudAPI.nickname = res.nickname || fallbackNickname || account;

    const users = Store.getUsers();
    if (!users[account]) {
        users[account] = { account, password: password || '', nickname: CloudAPI.nickname, createdAt: Date.now(), records: [] };
        Store.saveUsers(users);
    } else if (password) {
        // 记住密码，便于 token 失效时静默重连（与本地登录一致，均为明文存储）
        users[account].password = password;
        Store.saveUsers(users);
    }
    Store.setSession(account);

    // 登录后双向同步：先拉云端、再推本地，保证多设备资料一致（含打卡/盲盒/积分）
    await syncNow();
    _lastSyncSig = syncSignature();
}

// 统一登录/注册：优先云端（多设备同步），后端不可用时退回本地
async function unifiedAuth(account, password, isRegister, nickname) {
    let res = null, err = null;
    try {
        res = isRegister
            ? await CloudAPI.register(account, password, nickname)
            : await CloudAPI.login(account, password);
    } catch (e) { err = e; }

    // 后端不可用（静态托管 / 离线）→ 退回纯本地登录
    const unavailable = err && /暂不可用|Failed to fetch|NetworkError|网络/.test(err.message);
    if (!res && unavailable) {
        const lr = isRegister ? Store.register(account, password, nickname || account) : Store.login(account, password);
        if (!lr.ok) return { ok: false, message: lr.msg };
        return { ok: true };
    }

    // 云端明确错误：账号不存在且本地有同名同密码账号 → 自动迁移到云端
    if (!res || !res.token) {
        if (err && /账号不存在/.test(err.message)) {
            const lu = Store.getUsers()[account];
            if (lu && lu.password === password) {
                try { res = await CloudAPI.register(account, password, lu.nickname || nickname || account); }
                catch (e2) { err = e2; }
            }
        }
        if (!res || !res.token) {
            return { ok: false, message: (res && res.error) || (err && err.message) || '登录失败' };
        }
    }

    await bindCloudSession(res, account, nickname, password);
    return { ok: true };
}

// 启动后：若本地已登录但云端未连，尝试用本地存储的密码把账号迁到云端（静默）
async function autoCloudMigrate() {
    if (CloudAPI.connected) return;
    const account = Store.getSession();
    if (!account) return;
    const user = Store.getUsers()[account];
    if (!user || !user.password) return;
    try {
        let res = null, err = null;
        try { res = await CloudAPI.login(account, user.password); }
        catch (e) { err = e; }
        if (!res || !res.token) {
            if (err && /账号不存在/.test(err.message)) {
                try { res = await CloudAPI.register(account, user.password, user.nickname || account); }
                catch (e2) { return; }
            } else return;
        }
        if (!res || !res.token) return;
        CloudAPI.token = res.token;
        CloudAPI.account = res.account;
        CloudAPI.nickname = res.nickname || user.nickname || account;
        if (Array.isArray(user.records) && user.records.length) {
            await CloudAPI.syncProfile(buildProfile());
        }
        try {
            const data = await CloudAPI.getProfile();
            if (data) Store.mergeProfile(data);
        } catch (e) {}
        // 迁移成功后刷新当前页面视图
        const cur = document.querySelector('.page.active');
        if (cur && cur.id === 'home-page') PageHome.render();
        if (cur && cur.id === 'history-page') PageHistory.render();
    } catch (e) {}
}

// 用本地保存的密码静默重新登录（token 失效时恢复云端连接）
async function reauthCloud() {
    const account = Store.getSession();
    if (!account) return false;
    const user = Store.getUsers()[account];
    if (!user || !user.password) return false;
    try {
        const res = await CloudAPI.login(account, user.password);
        if (!res || !res.token) return false;
        CloudAPI.token = res.token;
        CloudAPI.account = res.account;
        CloudAPI.nickname = res.nickname || user.nickname || account;
        return true;
    } catch (e) { return false; }
}

// 双向同步：先拉取云端全量资料合并到本地，再把本地独有资料推送到云端（按主键合并，不丢数据）
// 返回同步后的本地记录数；失败（含重连失败）返回 -1
async function syncNow() {
    if (!CloudAPI.connected) return -1;
    try {
        const data = await CloudAPI.getProfile();
        if (data) Store.mergeProfile(data);
        await CloudAPI.syncProfile(buildProfile());
        return Store.getRecords().length;
    } catch (e) {
        if (e && e.status === 401) {
            const ok = await reauthCloud();
            if (ok) {
                try {
                    const data = await CloudAPI.getProfile();
                    if (data) Store.mergeProfile(data);
                    await CloudAPI.syncProfile(buildProfile());
                    return Store.getRecords().length;
                } catch (_) {}
            }
        }
        return -1;
    }
}

// 回到前台 / 定时：主动从云端拉取最新资料并刷新当前数据页（多设备实时可见）
function onCloudRefresh() {
    if (!CloudAPI.connected) return;
    const authView = document.getElementById('auth-view');
    if (authView && authView.classList.contains('active')) return;
    syncNow().then((n) => {
        if (n < 0) return;
        const sig = syncSignature();
        if (sig !== _lastSyncSig) {
            _lastSyncSig = sig;
            const refreshers = {
                home: () => PageHome.render(),
                history: () => PageHistory.render(),
                analysis: () => PageAnalysis.render()
            };
            if (refreshers[Router.current]) refreshers[Router.current]();
        } else {
            _lastSyncSig = sig;
        }
    });
}

/* ==================== 工具函数 ==================== */
const Utils = {
    uid() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    },

    todayStr() {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    },

    formatDate(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${m}-${day}`;
    },

    formatDateShort(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        return `${d.getMonth() + 1}/${d.getDate()}`;
    },

    // 用时(毫秒) -> 显示字符串
    msToTime(ms) {
        if (ms == null || isNaN(ms)) return '--';
        const totalSec = ms / 1000;
        const min = Math.floor(totalSec / 60);
        const sec = Math.floor(totalSec % 60);
        const cs = Math.floor((ms % 1000) / 10);
        return {
            main: `${min}:${String(sec).padStart(2, '0')}`,
            ms: String(cs).padStart(2, '0'),
            full: `${min}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
        };
    },

    // 分/秒/毫秒输入 -> 总毫秒
    inputsToMs(min, sec, ms) {
        return (parseInt(min) || 0) * 60000 + (parseInt(sec) || 0) * 1000 + (parseInt(ms) || 0) * 10;
    },

    // 时间字符串("1:23.45" 或 "1:23") -> 总毫秒（用于导入备份）
    timeToMs(str) {
        if (str == null) return 0;
        const s = String(str).trim();
        const m = s.match(/^(?:(\d+):)?(\d+)(?:[.:](\d+))?$/);
        if (!m) return 0;
        const min = parseInt(m[1] || '0', 10);
        const sec = parseInt(m[2] || '0', 10);
        const frac = parseInt(m[3] || '0', 10);
        // 小数可能是 2 位(百分秒)或 3 位(毫秒)
        const fracMs = m[3] && m[3].length >= 3 ? parseInt(m[3].slice(0, 3), 10) : (frac * 10);
        return min * 60000 + sec * 1000 + fracMs;
    },

    // 毫秒 -> 分/秒/毫秒
    msToInputs(ms) {
        const min = Math.floor(ms / 60000);
        const sec = Math.floor((ms % 60000) / 1000);
        const cs = Math.floor((ms % 1000) / 10);
        return { min, sec, ms: cs };
    },

    // 总用时(毫秒) -> 小时
    msToHours(ms) {
        return (ms / 3600000).toFixed(1);
    },

    // 距离(米) -> 公里
    mToKm(m) {
        return (m / 1000).toFixed(1);
    },

    strokeColor(stroke) {
        const map = {
            '自由泳': { bg: 'var(--sky-bg)', color: 'var(--sky-deep)', class: 'freestyle', emoji: '🐬', animal: '海豚' },
            '蛙泳': { bg: 'var(--mint-bg)', color: '#059669', class: 'breaststroke', emoji: '🐸', animal: '青蛙' },
            '仰泳': { bg: 'var(--coral-bg)', color: '#EA580C', class: 'backstroke', emoji: '🦦', animal: '水獭' },
            '蝶泳': { bg: 'var(--grape-bg)', color: '#7C3AED', class: 'butterfly', emoji: '🦋', animal: '蝴蝶' },
            '混合泳': { bg: 'var(--rose-bg)', color: '#DB2777', class: 'medley', emoji: '🌈', animal: '全能' },
            '跑步': { bg: 'var(--mint-bg)', color: '#0E7490', class: 'run', emoji: '🏃', animal: '猎豹' },
            '跳绳': { bg: 'var(--grape-bg)', color: '#7C3AED', class: 'rope', emoji: '🤾', animal: '袋鼠' }
        };
        return map[stroke] || map['自由泳'];
    },

    strokeShort(stroke) {
        return stroke.charAt(0);
    },

    // 成绩类型信息
    typeInfo(type) {
        return type === 'competition'
            ? { label: '比赛成绩', short: '比赛', emoji: '🏆' }
            : { label: '训练成绩', short: '训练', emoji: '🏊' };
    },

    greeting() {
        const h = new Date().getHours();
        if (h < 6) return '凌晨好';
        if (h < 12) return '早上好';
        if (h < 14) return '中午好';
        if (h < 18) return '下午好';
        return '晚上好';
    },

    todayDisplay() {
        const d = new Date();
        const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        return `${d.getMonth() + 1}月${d.getDate()}日 ${weekDays[d.getDay()]}`;
    }
};

/* ==================== 路由 ==================== */
const Router = {
    current: 'home',
    editingId: null,
    prevView: 'home',

    navigate(view, opts = {}) {
        // 记录来源页（用于记录页返回）
        if (view === 'record') {
            this.prevView = this.current;
        }

        // 隐藏所有视图
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

        // 显示目标视图
        const target = document.getElementById(view + '-view');
        if (target) {
            target.classList.add('active');
        }

        // 更新底部导航选中状态
        document.querySelectorAll('.bottom-nav').forEach(nav => {
            nav.querySelectorAll('.nav-item').forEach(item => {
                item.classList.toggle('active', item.dataset.nav === view);
            });
        });

        this.current = view;

        // 触发页面渲染
        if (opts.editingId) {
            this.editingId = opts.editingId;
        }

        switch (view) {
            case 'home': PageHome.render(); break;
            case 'record': PageRecord.render(opts.editingId, opts.presetCategory); break;
            case 'history': PageHistory.render(); break;
            case 'analysis': PageAnalysis.render(); break;
            case 'gallery': PageGallery.render(); break;
            case 'profile': PageProfile.render(); break;
        }

        // 滚动到顶部
        const content = target?.querySelector('.page-content');
        if (content) content.scrollTop = 0;
    }
};

/* ==================== Toast ==================== */
const Toast = {
    show(msg, opts = {}) {
        const el = document.getElementById('toast');
        el.className = 'toast';
        if (opts.type) el.classList.add(opts.type);

        let html = '';
        if (opts.type === 'success') {
            html += '<svg class="toast-icon" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="white" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>';
        }
        html += `<div>${msg}</div>`;
        if (opts.sub) {
            html += `<div class="toast-sub">${opts.sub}</div>`;
        }
        el.innerHTML = html;
        el.classList.add('show');

        clearTimeout(this._timer);
        this._timer = setTimeout(() => {
            el.classList.remove('show');
        }, opts.duration || 2500);
    }
};

/* ==================== 确认弹窗 ==================== */
const Confirm = {
    show(msg) {
        return new Promise(resolve => {
            const overlay = document.getElementById('confirm-modal');
            document.getElementById('confirm-message').textContent = msg;
            overlay.classList.add('active');

            const ok = document.getElementById('confirm-ok');
            const cancel = document.getElementById('confirm-cancel');

            const cleanup = () => {
                overlay.classList.remove('active');
                ok.removeEventListener('click', onOk);
                cancel.removeEventListener('click', onCancel);
            };
            const onOk = () => { cleanup(); resolve(true); };
            const onCancel = () => { cleanup(); resolve(false); };

            ok.addEventListener('click', onOk);
            cancel.addEventListener('click', onCancel);
        });
    }
};

/* ==================== 盲盒定义 ==================== */
// 五种稀有度（权重从高到低），随机抽取
const BLINDBOX_RARITIES = [
    { key: 'common',    label: '普通款', weight: 50, color: '#94A3B8', icon: '🐟' },
    { key: 'classic',   label: '经典款', weight: 30, color: '#2E9BFF', icon: '🏅' },
    { key: 'rare',      label: '稀有款', weight: 15, color: '#A855F7', icon: '💎' },
    { key: 'limited',   label: '限量款', weight: 4,  color: '#F59E0B', icon: '🔥' },
    { key: 'collector', label: '典藏款', weight: 1,  color: '#E11D48', icon: '👑' }
];
const BLINDBOX_NAMES = {
    common:   ['小金鱼贴纸', '水滴徽章', '泳圈挂件', '浪花书签', '泡泡贴纸'],
    classic:  ['银色奖牌', '海豚吊坠', '经典泳帽', '蓝鲸摆件', '海星徽章'],
    rare:     ['紫晶泳镜', '流星奖杯', '幻彩鱼尾', '星河徽章', '极光挂坠'],
    limited:  ['烈焰限定卡', '黄金限定章', '霓虹限定牌', '极光限定盒', '星耀限定印'],
    collector:['典藏王冠', '传奇金鳞', '永恒之泳', '创世之冠', '沧海遗珠']
};
const BLINDBOX_COST = 10; // 抽一次消耗积分

function rollBlindBox() {
    const total = BLINDBOX_RARITIES.reduce((s, r) => s + r.weight, 0);
    let x = Math.random() * total;
    let chosen = BLINDBOX_RARITIES[0];
    for (const r of BLINDBOX_RARITIES) {
        if (x < r.weight) { chosen = r; break; }
        x -= r.weight;
    }
    const names = BLINDBOX_NAMES[chosen.key];
    const name = names[Math.floor(Math.random() * names.length)];
    return { rarity: chosen.key, label: chosen.label, color: chosen.color, icon: chosen.icon, name };
}

// 记录兑换积分：游泳每 250 米约 1 分、跑步每公里 1 分、跳绳每 200 次 1 分，保底 1 分
function pointsForRecord(r) {
    if (r.category === 'rope') return 1 + Math.floor((r.count || 0) / 200);
    const dist = r.distance || 0;
    if (r.category === 'run') return Math.max(1, Math.round(dist / 1000));
    return Math.max(1, Math.round(dist / 250));
}

/* ==================== 页面：首页 ==================== */
const PageHome = {
    render() {
        const user = Store.getCurrentUser();
        if (!user) return;

        document.getElementById('home-greeting-text').textContent = Utils.greeting();
        document.getElementById('home-user-name').textContent = user.nickname;
        document.getElementById('home-date').textContent = Utils.todayDisplay();

        const records = Store.getRecords();

        // 打卡 / 积分 / 盲盒
        this.renderCheckin();

        // 进步情况分析
        this.renderProgressOverview(records);

        // 本月统计
        const now = new Date();
        const monthRecords = records.filter(r => {
            const d = new Date(r.date);
            return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
        });
        const monthDistance = monthRecords.reduce((s, r) => s + r.distance, 0);
        document.getElementById('home-month-count').textContent = monthRecords.length;
        document.getElementById('home-month-distance').innerHTML = `${Utils.mToKm(monthDistance)}<span class="stat-unit">km</span>`;

        // 三大运动项目卡片
        this.renderCategoryCards(records);
    },

    _dateStr(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },

    // 渲染打卡卡片（打卡天数、连续天数、积分、抽盲盒入口）
    renderCheckin() {
        const el = document.getElementById('checkin-card');
        if (!el) return;
        const today = Utils.todayStr();
        const checkins = Store.getCheckins();
        const doneToday = checkins.some(c => c.date === today);
        const total = checkins.length;
        const points = Store.getPoints();
        const canDraw = points >= BLINDBOX_COST;

        // 计算当前连续天数（截至今天）
        let streak = 0;
        const set = new Set(checkins.map(c => c.date));
        const d = new Date();
        while (set.has(this._dateStr(d))) {
            streak++;
            d.setDate(d.getDate() - 1);
        }

        el.innerHTML = `
            <div class="checkin-top">
                <div class="checkin-title">📅 每日打卡</div>
                <div class="checkin-streak">🔥 连续 <b>${streak}</b> 天 · 累计 <b>${total}</b> 次</div>
            </div>
            <div class="checkin-points">
                <span class="checkin-points-value">${points}</span>
                <span class="checkin-points-label">积分（${BLINDBOX_COST} 分抽一次盲盒）</span>
            </div>
            <div class="checkin-actions">
                <button class="btn-primary ${doneToday ? 'is-done' : ''}" id="checkin-btn" ${doneToday ? 'disabled' : ''}>
                    ${doneToday ? '✅ 今日已打卡' : '☀️ 立即打卡 +积分'}
                </button>
                <button class="btn-secondary ${canDraw ? '' : 'is-disabled'}" id="draw-blindbox-btn" ${canDraw ? '' : 'disabled'}>
                    🎁 抽盲盒（${BLINDBOX_COST}分）
                </button>
            </div>
            ${doneToday ? '' : '<div class="checkin-tip">每天打卡都能获得积分，连续打卡积分更多，攒够 10 分就能抽盲盒 🎉</div>'}
        `;

        const btn = el.querySelector('#checkin-btn');
        if (btn && !doneToday) btn.addEventListener('click', () => this.checkIn());
        const drawBtn = el.querySelector('#draw-blindbox-btn');
        if (drawBtn && canDraw) drawBtn.addEventListener('click', () => this.drawBlindBox());
    },

    // 打卡：次数越多（连续+累计）积分越多
    checkIn() {
        const today = Utils.todayStr();
        const checkins = Store.getCheckins();
        if (checkins.some(c => c.date === today)) {
            Toast.show('今天已经打卡啦～');
            return;
        }
        // 连续天数（截至昨天）
        const set = new Set(checkins.map(c => c.date));
        let streak = 1;
        const d = new Date();
        d.setDate(d.getDate() - 1);
        while (set.has(this._dateStr(d))) { streak++; d.setDate(d.getDate() - 1); }
        // 累计越多、连续越长，本次积分越多
        const points = 5 + Math.floor(checkins.length / 5) + Math.min(streak - 1, 5);
        Store.addCheckin({ date: today, points, streak });
        Toast.show('打卡成功 +' + points + ' 积分', { type: 'success', sub: '连续打卡 ' + streak + ' 天' });
        this.renderCheckin();
        this.render();
    },

    // 抽盲盒：消耗积分，随机稀有度
    drawBlindBox() {
        const points = Store.getPoints();
        if (points < BLINDBOX_COST) {
            Toast.show('积分不足，先去打卡攒积分吧～');
            return;
        }
        const rb = rollBlindBox();
        const item = {
            id: Utils.uid(),
            account: Store.getSession(),
            rarity: rb.rarity,
            label: rb.label,
            color: rb.color,
            icon: rb.icon,
            name: rb.name,
            date: Utils.todayStr(),
            createdAt: Date.now()
        };
        Store.addBlindBox(item);
        this.renderCheckin();
        this.showBlindBoxResult(item);
    },

    // 展示抽中结果（弹窗）
    showBlindBoxResult(item) {
        const modal = document.getElementById('blindbox-result-modal');
        if (!modal) return;
        const isTop = (item.rarity === 'limited' || item.rarity === 'collector');
        modal.querySelector('.blindbox-result-icon').textContent = item.icon;
        modal.querySelector('.blindbox-result-name').textContent = item.name;
        const tag = modal.querySelector('.blindbox-result-tag');
        tag.textContent = item.label;
        tag.style.background = item.color;
        const card = modal.querySelector('.blindbox-result-card');
        card.style.borderColor = item.color;
        card.style.boxShadow = '0 10px 40px ' + item.color + '55';
        modal.querySelector('.blindbox-result-sub').textContent = isTop
            ? '🎉 欧气爆棚！抽中高品质款式！'
            : '已收入奖状墙「盲盒」分类';
        modal.classList.add('active');
    },

    // 通用进步度量：游泳/跑步用时越少越好；跳绳次数越多越好（取负便于统一比较）
    _metricOf(r) {
        return (r.category === 'rope') ? -(r.count || 0) : (r.timeMs || 0);
    },

    computeProgressOverview(records) {
        const groups = {};
        records.forEach(r => {
            const key = r.stroke + '|' + r.distance;
            (groups[key] = groups[key] || []).push(r);
        });
        const sortByDate = arr => arr.slice().sort((a, b) =>
            a.date === b.date ? (a.createdAt || 0) - (b.createdAt || 0) : a.date.localeCompare(b.date));

        let improve = 0, regress = 0, same = 0, rateSum = 0, rateCount = 0;

        Object.values(groups).forEach(g => {
            const s = sortByDate(g);
            if (s.length < 2) return;
            const prev = s[s.length - 2], latest = s[s.length - 1];
            const diff = this._metricOf(latest) - this._metricOf(prev); // 度量变小 = 进步
            if (diff < 0) {
                improve++;
                const base = Math.abs(this._metricOf(prev)) || 1;
                rateSum += Math.abs(diff) / base * 100; rateCount++;
            } else if (diff > 0) {
                regress++;
            } else {
                same++;
            }
        });

        const avgRate = rateCount > 0 ? rateSum / rateCount : 0;

        // 最近一条记录的同项趋势
        const allSorted = sortByDate(records);
        let lastTrend = null;
        if (allSorted.length >= 2) {
            const latest = allSorted[allSorted.length - 1];
            const g = sortByDate(groups[latest.stroke + '|' + latest.distance] || []);
            if (g.length >= 2) {
                const prev = g[g.length - 2];
                const diff = this._metricOf(latest) - this._metricOf(prev);
                const isRope = latest.category === 'rope';
                let desc;
                if (isRope) {
                    const d = Math.abs((latest.count || 0) - (prev.count || 0));
                    desc = `${latest.stroke} 次数${diff < 0 ? '增加' : '减少'} ${d} 次`;
                } else {
                    const dT = Utils.msToTime(Math.abs(this._metricOf(latest) - this._metricOf(prev)));
                    const dist = latest.distance >= 1000 ? (latest.distance / 1000).toFixed(1) + 'km' : latest.distance + '米';
                    desc = `${latest.stroke} ${dist} ${diff < 0 ? '快了' : '慢了'} ${dT.main}.${dT.ms}`;
                }
                lastTrend = { type: diff < 0 ? 'improve' : (diff > 0 ? 'regress' : 'same'), desc };
            }
        }
        return { improve, regress, same, avgRate, lastTrend, series: improve + regress + same };
    },

    renderProgressOverview(records) {
        const el = document.getElementById('home-progress-overview');
        if (!el) return;

        if (records.length < 2) {
            el.innerHTML = `<div class="progress-ov-empty">记录达到 2 条后，这里会显示你的进步情况分析 📈</div>`;
            return;
        }

        const s = this.computeProgressOverview(records);
        const rateTxt = s.avgRate.toFixed(1) + '%';
        const overallUp = s.improve >= s.regress;

        let summary = '';
        if (s.lastTrend) {
            const t = s.lastTrend;
            if (t.type === 'improve') {
                summary = `<div class="progress-ov-summary">
                    <span class="progress-arrow improve"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg></span>
                    <span>最近一次 <b>${t.desc}</b> 进步 ↑</span>
                </div>`;
            } else if (t.type === 'regress') {
                summary = `<div class="progress-ov-summary">
                    <span class="progress-arrow regress"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg></span>
                    <span>最近一次 <b>${t.desc}</b> 退步 ↓</span>
                </div>`;
            } else {
                summary = `<div class="progress-ov-summary">
                    <span class="progress-arrow same"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/></svg></span>
                    <span>最近一次 <b>${t.desc}</b> 成绩持平</span>
                </div>`;
            }
        }

        el.innerHTML = `
            <div class="progress-ov-grid">
                <div class="progress-ov-item">
                    <div class="progress-ov-value improve">${s.improve}</div>
                    <div class="progress-ov-label">进步次数</div>
                </div>
                <div class="progress-ov-item">
                    <div class="progress-ov-value regress">${s.regress}</div>
                    <div class="progress-ov-label">退步次数</div>
                </div>
                <div class="progress-ov-item">
                    <div class="progress-ov-value ${overallUp ? 'improve' : 'regress'}">${rateTxt}</div>
                    <div class="progress-ov-label">平均进步率</div>
                </div>
            </div>
            ${summary}
        `;
    },


    renderCategoryCards(records) {
        const container = document.getElementById('home-category-cards');
        if (!container) return;

        const cats = [
            { key: 'swim', name: '游泳', emoji: '🏊', cls: 'cat-swim' },
            { key: 'run', name: '跑步', emoji: '🏃', cls: 'cat-run' },
            { key: 'rope', name: '跳绳', emoji: '🤾', cls: 'cat-rope' }
        ];

        container.innerHTML = cats.map(c => {
            const list = records.filter(r => r.category === c.key);
            const count = list.length;

            let sub1Val, sub1Label, sub2Val, sub2Label;
            if (c.key === 'rope') {
                const totalCount = list.reduce((s, r) => s + (r.count || 0), 0);
                let best = 0;
                list.forEach(r => { if ((r.count || 0) > best) best = r.count || 0; });
                sub1Val = totalCount + ' 次';
                sub1Label = '累计次数';
                sub2Val = best + ' 次';
                sub2Label = '最佳次数';
            } else {
                const totalDist = list.reduce((s, r) => s + (r.distance || 0), 0);
                let bestTime = null;
                list.forEach(r => { if (r.timeMs > 0 && (bestTime == null || r.timeMs < bestTime)) bestTime = r.timeMs; });
                sub1Val = Utils.mToKm(totalDist) + ' km';
                sub1Label = '累计距离';
                sub2Val = bestTime != null ? Utils.msToTime(bestTime).main : '—';
                sub2Label = '最快成绩';
            }

            return `
                <div class="cat-card ${c.cls}" data-category="${c.key}">
                    <div class="cat-card-header">
                        <span class="cat-emoji">${c.emoji}</span>
                        <span class="cat-name">${c.name}</span>
                    </div>
                    <div class="cat-count"><span class="cat-count-num">${count}</span><span class="cat-count-unit">次</span></div>
                    <div class="cat-count-label">总次数</div>
                    <div class="cat-sub">
                        <div class="cat-sub-item">
                            <div class="cat-sub-val">${sub1Val}</div>
                            <div class="cat-sub-label">${sub1Label}</div>
                        </div>
                        <div class="cat-sub-item">
                            <div class="cat-sub-val">${sub2Val}</div>
                            <div class="cat-sub-label">${sub2Label}</div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.cat-card').forEach(card => {
            card.addEventListener('click', () => {
                Router.navigate('record', { presetCategory: card.dataset.category });
            });
        });
    }
};

/* ==================== 页面：记录成绩 ==================== */
const PageRecord = {
    selectedCategory: 'swim',
    selectedStroke: null,
    selectedDistance: null,
    selectedType: 'training',
    editingId: null,

    render(editingId, presetCategory) {
        this.editingId = editingId || null;
        document.getElementById('record-page-title').textContent = editingId ? '编辑成绩' : '记录成绩';

        if (editingId) {
            const records = Store.getRecords();
            const record = records.find(r => r.id === editingId);
            if (record) {
                this.selectedCategory = record.category || 'swim';
                this.selectedStroke = record.stroke;
                this.selectedDistance = record.distance;
                this.selectedType = record.type || 'training';
                const inputs = Utils.msToInputs(record.timeMs);
                document.getElementById('time-min').value = inputs.min;
                document.getElementById('time-sec').value = inputs.sec;
                document.getElementById('time-ms').value = inputs.ms;
                document.getElementById('record-date').value = record.date;
                document.getElementById('record-note').value = record.note || '';
                document.getElementById('event-name').value = record.eventName || '';
                document.getElementById('custom-distance').value = '';
                document.getElementById('run-distance').value = this.selectedCategory === 'run' ? record.distance : '';
                document.getElementById('rope-count').value = this.selectedCategory === 'rope' ? (record.count || '') : '';
            }
        } else {
            this.selectedCategory = presetCategory || 'swim';
            this.selectedStroke = null;
            this.selectedDistance = null;
            this.selectedType = 'training';
            document.getElementById('time-min').value = '';
            document.getElementById('time-sec').value = '';
            document.getElementById('time-ms').value = '';
            document.getElementById('record-date').value = Utils.todayStr();
            document.getElementById('record-note').value = '';
            document.getElementById('event-name').value = '';
            document.getElementById('custom-distance').value = '';
            document.getElementById('run-distance').value = '';
            document.getElementById('rope-count').value = '';
        }

        // 更新运动项目按钮高亮
        document.querySelectorAll('#category-options .option-btn').forEach(btn => {
            btn.classList.toggle('selected', btn.dataset.category === this.selectedCategory);
        });
        this.updateCategoryUI();
        this.updateStrokeUI();
        this.updateDistanceUI();
        this.updateTypeUI();
    },

    // 根据运动项目切换可见字段
    updateCategoryUI() {
        const isSwim = this.selectedCategory === 'swim';
        const isRun = this.selectedCategory === 'run';
        const isRope = this.selectedCategory === 'rope';
        document.getElementById('swim-fields').style.display = isSwim ? 'block' : 'none';
        document.getElementById('run-fields').style.display = isRun ? 'block' : 'none';
        document.getElementById('rope-fields').style.display = isRope ? 'block' : 'none';
        // 成绩类型仅游泳/跑步可选；跳绳统一为训练
        document.getElementById('type-section').style.display = isRope ? 'none' : 'block';
        if (isRope) this.selectedType = 'training';
    },

    updateStrokeUI() {
        document.querySelectorAll('#stroke-options .option-btn').forEach(btn => {
            btn.classList.toggle('selected', btn.dataset.stroke === this.selectedStroke);
        });
    },

    updateDistanceUI() {
        document.querySelectorAll('#distance-options .option-btn').forEach(btn => {
            btn.classList.toggle('selected', parseInt(btn.dataset.distance) === this.selectedDistance);
        });
    },

    updateTypeUI() {
        document.querySelectorAll('#type-options .option-btn').forEach(btn => {
            btn.classList.toggle('selected', btn.dataset.type === this.selectedType);
        });
        const evSection = document.getElementById('event-name-section');
        evSection.style.display = (this.selectedCategory === 'swim' && this.selectedType === 'competition') ? 'block' : 'none';
    },

    // 读取当前表单构建一条记录（含 category / 展示标签 / 积分）
    buildRecordBase() {
        const date = document.getElementById('record-date').value;
        const note = document.getElementById('record-note').value.trim();
        const type = this.selectedType;
        const eventName = (this.selectedCategory === 'swim' && type === 'competition')
            ? document.getElementById('event-name').value.trim() : '';

        const base = {
            date, note, type, eventName,
            category: this.selectedCategory,
            stroke: '',
            distance: 0,
            count: 0,
            timeMs: 0,
            createdAt: Date.now()
        };

        if (this.selectedCategory === 'swim') {
            base.stroke = this.selectedStroke;
            let distance = this.selectedDistance;
            const customDist = document.getElementById('custom-distance').value.trim();
            if (customDist) distance = parseInt(customDist);
            base.distance = distance;
            const min = document.getElementById('time-min').value.trim();
            const sec = document.getElementById('time-sec').value.trim();
            const ms = document.getElementById('time-ms').value.trim();
            base.timeMs = Utils.inputsToMs(min, sec, ms);
        } else if (this.selectedCategory === 'run') {
            base.stroke = '跑步';
            base.distance = parseInt(document.getElementById('run-distance').value.trim()) || 0;
            const min = document.getElementById('time-min').value.trim();
            const sec = document.getElementById('time-sec').value.trim();
            const ms = document.getElementById('time-ms').value.trim();
            base.timeMs = Utils.inputsToMs(min, sec, ms);
        } else if (this.selectedCategory === 'rope') {
            base.stroke = '跳绳';
            base.count = parseInt(document.getElementById('rope-count').value.trim()) || 0;
            const min = document.getElementById('time-min').value.trim();
            const sec = document.getElementById('time-sec').value.trim();
            const ms = document.getElementById('time-ms').value.trim();
            base.timeMs = Utils.inputsToMs(min, sec, ms); // 可选，不填则为 0
        }
        base.earnedPoints = pointsForRecord(base);
        return base;
    },

    save() {
        // 验证
        if (this.selectedCategory === 'swim') {
            if (!this.selectedStroke) { Toast.show('请选择泳姿'); return; }
            let distance = this.selectedDistance;
            const customDist = document.getElementById('custom-distance').value.trim();
            if (customDist) distance = parseInt(customDist);
            if (!distance || distance <= 0) { Toast.show('请选择或输入距离'); return; }
            const t = Utils.inputsToMs(
                document.getElementById('time-min').value.trim(),
                document.getElementById('time-sec').value.trim(),
                document.getElementById('time-ms').value.trim()
            );
            if (t <= 0) { Toast.show('请输入有效的用时'); return; }
        } else if (this.selectedCategory === 'run') {
            const d = parseInt(document.getElementById('run-distance').value.trim());
            if (!d || d <= 0) { Toast.show('请输入跑步距离'); return; }
            const t = Utils.inputsToMs(
                document.getElementById('time-min').value.trim(),
                document.getElementById('time-sec').value.trim(),
                document.getElementById('time-ms').value.trim()
            );
            if (t <= 0) { Toast.show('请输入跑步用时'); return; }
        } else if (this.selectedCategory === 'rope') {
            const c = parseInt(document.getElementById('rope-count').value.trim());
            if (!c || c <= 0) { Toast.show('请输入跳绳次数'); return; }
        }

        const date = document.getElementById('record-date').value;
        if (!date) { Toast.show('请选择日期'); return; }

        const base = this.buildRecordBase();

        if (this.editingId) {
            Store.updateRecord(this.editingId, base);
            scheduleCloudSync();
            Toast.show('成绩已更新', { type: 'success' });
            setTimeout(() => Router.navigate('history'), 800);
        } else {
            const newRecord = { id: Utils.uid(), ...base };
            Store.addRecord(newRecord);
            scheduleCloudSync();

            // 破最佳提示（仅游泳/跑步按用时判定）
            let sub = `获得 ${newRecord.earnedPoints} 积分`;
            if (this.selectedCategory !== 'rope') {
                const all = Store.getRecords();
                const same = all.filter(r =>
                    r.category === this.selectedCategory && r.stroke === newRecord.stroke &&
                    r.distance === newRecord.distance && (r.type || 'training') === newRecord.type &&
                    r.id !== newRecord.id);
                const prevBest = same.length ? Math.min(...same.map(r => r.timeMs)) : null;
                if (prevBest !== null && newRecord.timeMs < prevBest) {
                    const diffT = Utils.msToTime(prevBest - newRecord.timeMs);
                    sub = `比最佳快了 ${diffT.main}.${diffT.ms}，并获 ${newRecord.earnedPoints} 积分`;
                }
            }
            Toast.show('成绩已记录！', { type: 'success', sub });

            // 停留在记录页，方便连续录入：保留项目/类型，仅清空本次输入
            this.editingId = null;
            document.getElementById('record-page-title').textContent = '记录成绩';
            document.getElementById('time-min').value = '';
            document.getElementById('time-sec').value = '';
            document.getElementById('time-ms').value = '';
            document.getElementById('record-note').value = '';
            document.getElementById('event-name').value = '';
            document.getElementById('custom-distance').value = '';
            document.getElementById('run-distance').value = '';
            document.getElementById('rope-count').value = '';
            this.selectedStroke = null;
            this.selectedDistance = null;
            this.updateStrokeUI();
            this.updateDistanceUI();
            this.updateTypeUI();
        }
    }
};

/* ==================== 页面：历史记录 ==================== */
const PageHistory = {
    render() {
        const records = Store.getRecords();
        const filterStroke = document.getElementById('filter-stroke').value;
        const filterDistance = document.getElementById('filter-distance').value;
        const filterType = document.querySelector('#history-type-chips .chip.active')?.dataset.type || '';

        let filtered = records;
        if (filterStroke) filtered = filtered.filter(r => r.stroke === filterStroke);
        if (filterDistance) filtered = filtered.filter(r => r.distance === parseInt(filterDistance));
        if (filterType) filtered = filtered.filter(r => (r.type || 'training') === filterType);

        // 按泳姿、距离分组排列（同组按日期倒序，最新在前）
        const STROKE_ORDER = { '自由泳': 0, '蛙泳': 1, '仰泳': 2, '蝶泳': 3, '混合泳': 4 };
        filtered.sort((a, b) => {
            const so = (STROKE_ORDER[a.stroke] ?? 99) - (STROKE_ORDER[b.stroke] ?? 99);
            if (so !== 0) return so;
            if (a.distance !== b.distance) return a.distance - b.distance;
            if (b.date !== a.date) return b.date.localeCompare(a.date);
            return b.createdAt - a.createdAt;
        });

        document.getElementById('history-count').textContent = `共 ${filtered.length} 条记录`;

        const container = document.getElementById('history-list');

        if (filtered.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#cbd5e1" stroke-width="1.5"><path d="M9 11l3 3 8-8M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
                    <p>暂无记录</p>
                    <button class="empty-action" id="history-empty-add">＋ 去记录第一条成绩</button>
                </div>
            `;
            const emptyAdd = document.getElementById('history-empty-add');
            if (emptyAdd) emptyAdd.addEventListener('click', () => Router.navigate('record'));
            return;
        }

        // 找各项目最佳（按 泳姿+距离+类型）
        const bestMap = {};
        records.forEach(r => {
            const key = `${r.stroke}-${r.distance}-${r.type || 'training'}`;
            if (!bestMap[key] || r.timeMs < bestMap[key].timeMs) {
                bestMap[key] = r;
            }
        });

        container.innerHTML = filtered.map(r => {
            const sc = Utils.strokeColor(r.stroke);
            const isPB = bestMap[`${r.stroke}-${r.distance}-${r.type || 'training'}`]?.id === r.id;
            const ti = Utils.typeInfo(r.type);
            // 展示文案：跳绳显示次数；跑步/游泳显示距离（≥1000米显示为 km）
            let detailText;
            if (r.category === 'rope') detailText = `<strong>${sc.emoji}${r.stroke}</strong> · ${r.count} 次`;
            else detailText = `<strong>${sc.emoji}${r.stroke}</strong> · ${r.distance >= 1000 ? (r.distance / 1000).toFixed(1) + 'km' : r.distance + '米'}`;
            let timeText = '';
            if (r.timeMs > 0) { const t = Utils.msToTime(r.timeMs); timeText = `${t.main}<span class="ms-part">.${t.ms}</span>`; }
            return `
                <div class="history-item ${isPB ? 'history-item-pb' : ''}" data-id="${r.id}">
                    ${isPB ? `
                        <div class="history-trophy">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19 5h-2V3H7v2H5a2 2 0 00-2 2v3a4 4 0 003.5 3.97V18a2 2 0 002 2h2v1h4v-1h2a2 2 0 002-2v-4.03A4 4 0 0021 10V7a2 2 0 00-2-2zM5 10V7h2v5.83A2 2 0 015 10zm14 0a2 2 0 01-2 2.83V7h2v3z"/></svg>
                        </div>
                    ` : '<div style="width:28px;"></div>'}
                    <div class="history-stroke" style="background:${sc.bg};color:${sc.color}">${sc.emoji}</div>
                    <div class="history-info">
                        <div class="history-date">${Utils.formatDate(r.date)}</div>
                        <div class="history-detail">${detailText}</div>
                        <div class="history-tags">
                            <span class="record-type-badge type-${r.type || 'training'}">${ti.emoji}${ti.short}</span>
                            ${(r.type === 'competition' && r.eventName) ? `<span class="history-event">${ModalDetail.escapeHtml(r.eventName)}</span>` : ''}
                        </div>
                    </div>
                    <div class="history-time">${timeText}</div>
                    <svg class="history-arrow" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.history-item').forEach(item => {
            item.addEventListener('click', () => {
                ModalDetail.show(item.dataset.id);
            });
        });
    }
};

/* ==================== 页面：成绩分析 ==================== */
const PageAnalysis = {
    chart: null,
    currentStroke: '自由泳',
    currentDistance: 100,
    currentRange: '1m',
    currentType: '',

    setProject(stroke, distance) {
        this.currentStroke = stroke;
        this.currentDistance = parseInt(distance);
    },

    // 跳绳按次数衡量（越多越好），其余按用时（越少越好）
    _isCountProject() { return this.currentStroke === '跳绳'; },
    _metricOf(r) { return this._isCountProject() ? (r.count || 0) : (r.timeMs || 0); },
    _isBetter(a, b) {
        if (this._isCountProject()) return (a.count || 0) > (b.count || 0);
        return (a.timeMs || 0) < (b.timeMs || 0);
    },
    _bestOf(records) {
        let best = records[0];
        records.forEach(r => { if (this._isBetter(r, best)) best = r; });
        return best;
    },

    render() {
        // 同步选择器
        document.getElementById('analysis-stroke').value = this.currentStroke;
        document.getElementById('analysis-distance').value = this.currentDistance;
        // 跑步/跳绳距离不固定，隐藏距离筛选
        const distEl = document.getElementById('analysis-distance');
        if (distEl) distEl.style.display = this._isCountProject() || this.currentStroke === '跑步' ? 'none' : 'block';

        // 时间范围
        document.querySelectorAll('.range-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.range === this.currentRange);
        });

        // 类型筛选
        document.querySelectorAll('#analysis-type-chips .chip').forEach(c => {
            c.classList.toggle('active', (c.dataset.type || '') === this.currentType);
        });

        this.updateChart();
    },

    getFilteredRecords() {
        const records = Store.getRecords();
        const isCount = this._isCountProject();
        const isRun = this.currentStroke === '跑步';
        let filtered = records.filter(r => r.stroke === this.currentStroke);
        // 跑步/跳绳距离不固定，不做距离筛选
        if (!isCount && !isRun) filtered = filtered.filter(r => r.distance === this.currentDistance);
        if (this.currentType) filtered = filtered.filter(r => (r.type || 'training') === this.currentType);

        // 时间范围筛选
        if (this.currentRange !== 'all') {
            const months = parseInt(this.currentRange);
            const cutoff = new Date();
            cutoff.setMonth(cutoff.getMonth() - months);
            filtered = filtered.filter(r => new Date(r.date) >= cutoff);
        }

        // 按日期正序排列
        filtered.sort((a, b) => {
            if (a.date !== b.date) return a.date.localeCompare(b.date);
            return a.createdAt - b.createdAt;
        });

        return filtered;
    },

    updateChart() {
        const records = this.getFilteredRecords();
        const chartEl = document.getElementById('trend-chart');
        const noDataEl = document.getElementById('no-data-chart');

        if (records.length === 0) {
            chartEl.parentElement.style.display = 'none';
            noDataEl.style.display = 'block';
            document.getElementById('progress-card').innerHTML = '';
            document.getElementById('data-summary').innerHTML = '';
            return;
        }

        chartEl.parentElement.style.display = 'block';
        noDataEl.style.display = 'none';

        // 找最佳成绩（跳绳取次数最多，其余取用时最短）
        const bestRecord = this._bestOf(records);

        // 绘制图表
        const labels = records.map(r => Utils.formatDateShort(r.date));
        const isCount = this._isCountProject();
        const data = records.map(r => isCount ? (r.count || 0) : r.timeMs / 1000); // 次数 或 秒

        // 点颜色：最佳用金色
        const pointColors = records.map(r => r.id === bestRecord.id ? '#f59e0b' : '#0ea5e9');
        const pointRadii = records.map(r => r.id === bestRecord.id ? 7 : 5);

        if (this.chart) {
            this.chart.destroy();
        }

        const ctx = chartEl.getContext('2d');
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    borderColor: '#0ea5e9',
                    borderWidth: 2.5,
                    fill: true,
                    backgroundColor: (context) => {
                        const chart = context.chart;
                        const {ctx, chartArea} = chart;
                        if (!chartArea) return null;
                        const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                        gradient.addColorStop(0, 'rgba(14,165,233,0.2)');
                        gradient.addColorStop(1, 'rgba(14,165,233,0.01)');
                        return gradient;
                    },
                    tension: 0.3,
                    pointBackgroundColor: pointColors,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    pointRadius: pointRadii,
                    pointHoverRadius: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                if (isCount) return `次数: ${ctx.raw} 次`;
                                const ms = ctx.raw * 1000;
                                const t = Utils.msToTime(ms);
                                return `用时: ${t.full}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { font: { size: 11 }, color: '#94a3b8', maxRotation: 0 }
                    },
                    y: {
                        reverse: !isCount,
                        grid: { color: '#f1f5f9' },
                        ticks: {
                            font: { size: 11 },
                            color: '#94a3b8',
                            callback: (val) => {
                                if (isCount) return val + ' 次';
                                const ms = val * 1000;
                                const t = Utils.msToTime(ms);
                                return t.main + '.' + t.ms;
                            }
                        },
                        title: {
                            display: true,
                            text: isCount ? '次数（越多越好）' : '用时（越低越好）',
                            font: { size: 11 },
                            color: '#94a3b8'
                        }
                    }
                }
            }
        });

        // 进步状态
        this.renderProgress(records, bestRecord);

        // 数据摘要
        this.renderSummary(records, bestRecord);
    },

    renderProgress(records, bestRecord) {
        const container = document.getElementById('progress-card');
        const latest = records[records.length - 1];
        const isCount = this._isCountProject();
        const m = r => this._metricOf(r);

        let html = `<div class="progress-title">最近一次成绩对比</div>`;

        if (records.length < 2) {
            html += `
                <div class="progress-main">
                    <div class="progress-arrow same">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="4"/></svg>
                    </div>
                    <div class="progress-text">
                        <div class="progress-status same">首次记录</div>
                        <div class="progress-desc">这是该项目的第一条记录，继续加油！</div>
                    </div>
                </div>
            `;
            html += `
                <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-light);">
                    <div class="progress-title">与历史最佳对比</div>
                    <div class="progress-main">
                        <div class="progress-arrow same">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>
                        </div>
                        <div class="progress-text">
                            <div class="progress-status same" style="color:var(--gold)">当前即最佳</div>
                            <div class="progress-desc">恭喜！这是你的历史最好成绩</div>
                        </div>
                    </div>
                </div>
            `;
        } else {
            const prev = records[records.length - 2];
            const diff = m(latest) - m(prev);
            const base = Math.abs(m(prev)) || 1;
            const rate = Math.abs(diff) / base * 100;
            const rateTxt = rate.toFixed(1) + '%';
            const improved = isCount ? diff > 0 : diff < 0;

            const deltaTxt = () => {
                if (isCount) return Math.abs(diff) + ' 次';
                const t = Utils.msToTime(Math.abs(diff));
                return `${t.main}.${t.ms}`;
            };

            if (improved) {
                html += `
                    <div class="progress-main">
                        <div class="progress-arrow improve">
                            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
                        </div>
                        <div class="progress-text">
                            <div class="progress-status improve">进步 ${rateTxt} ↑</div>
                            <div class="progress-desc">${isCount ? '比上一次多了 ' + deltaTxt() : '比上一次快了 ' + deltaTxt()}</div>
                        </div>
                    </div>
                `;
            } else if (diff === 0) {
                html += `
                    <div class="progress-main">
                        <div class="progress-arrow same">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/></svg>
                        </div>
                        <div class="progress-text">
                            <div class="progress-status same">成绩持平</div>
                            <div class="progress-desc">与上一次成绩相同</div>
                        </div>
                    </div>
                `;
            } else {
                html += `
                    <div class="progress-main">
                        <div class="progress-arrow regress">
                            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
                        </div>
                        <div class="progress-text">
                            <div class="progress-status regress">退步 ${rateTxt} ↓</div>
                            <div class="progress-desc">${isCount ? '比上一次少了 ' + deltaTxt() : '比上一次慢了 ' + deltaTxt()}</div>
                        </div>
                    </div>
                `;
            }

            // 与历史最佳对比
            const bestDiff = m(latest) - m(bestRecord);
            if (bestDiff === 0) {
                html += `
                    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-light);">
                        <div class="progress-title">与历史最佳对比</div>
                        <div class="progress-main">
                            <div class="progress-arrow same" style="background:var(--gold-bg);color:var(--gold);">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>
                            </div>
                            <div class="progress-text">
                                <div class="progress-status" style="color:var(--gold)">当前即最佳</div>
                                <div class="progress-desc">恭喜！这是你的历史最好成绩</div>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                const bestRate = Math.abs(bestDiff) / (Math.abs(m(bestRecord)) || 1) * 100;
                const bestRateTxt = bestRate.toFixed(1) + '%';
                const bestGap = isCount ? Math.abs(bestDiff) + ' 次' : Utils.msToTime(Math.abs(bestDiff)).full;
                html += `
                    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-light);">
                        <div class="progress-title">与历史最佳对比</div>
                        <div class="progress-main">
                            <div class="progress-arrow regress">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
                            </div>
                            <div class="progress-text">
                                <div class="progress-status regress">退步 ${bestRateTxt} ↓</div>
                                <div class="progress-desc">距历史最佳成绩还差 ${bestGap}</div>
                            </div>
                        </div>
                    </div>
                `;
            }
        }

        container.innerHTML = html;
    },

    renderSummary(records, bestRecord) {
        const container = document.getElementById('data-summary');
        const isCount = this._isCountProject();
        let bestTxt, avgTxt;
        if (isCount) {
            bestTxt = (bestRecord.count || 0) + ' 次';
            const avg = Math.round(records.reduce((s, r) => s + (r.count || 0), 0) / records.length);
            avgTxt = avg + ' 次';
        } else {
            const bestT = Utils.msToTime(bestRecord.timeMs);
            const avgMs = records.reduce((s, r) => s + r.timeMs, 0) / records.length;
            const avgT = Utils.msToTime(Math.round(avgMs));
            bestTxt = `${bestT.main}<span class="ms-part">.${bestT.ms}</span>`;
            avgTxt = `${avgT.main}<span class="ms-part">.${avgT.ms}</span>`;
        }

        container.innerHTML = `
            <div class="summary-item best">
                <div class="summary-value">${bestTxt}</div>
                <div class="summary-label">${isCount ? '最多次数' : '最佳成绩'}</div>
            </div>
            <div class="summary-item">
                <div class="summary-value">${avgTxt}</div>
                <div class="summary-label">${isCount ? '平均次数' : '平均成绩'}</div>
            </div>
            <div class="summary-item">
                <div class="summary-value">${records.length}</div>
                <div class="summary-label">总记录数</div>
            </div>
        `;
    }
};

/* ==================== 页面：个人中心 ==================== */
const PageProfile = {
    render() {
        const user = Store.getCurrentUser();
        if (!user) return;

        document.getElementById('profile-nickname').textContent = user.nickname;
        document.getElementById('profile-account').textContent = '账号: ' + user.account;
        document.getElementById('profile-avatar').textContent = user.nickname.charAt(0).toUpperCase();

        const records = Store.getRecords();
        const totalDistance = records.reduce((s, r) => s + r.distance, 0);
        const totalTime = records.reduce((s, r) => s + r.timeMs, 0);

        document.getElementById('profile-total-count').textContent = records.length;
        document.getElementById('profile-total-distance').textContent = Utils.mToKm(totalDistance);
        document.getElementById('profile-total-time').textContent = Utils.msToHours(totalTime);

        this.renderCloud();
    },

    renderCloud() {
        const card = document.getElementById('cloud-card');
        if (!card) return;
        if (CloudAPI.connected) {
            card.innerHTML = `
                <div class="cloud-title">☁️ 云端同步</div>
                <div class="cloud-desc">已登录云端：<b>${ModalDetail.escapeHtml(CloudAPI.nickname || CloudAPI.account)}</b>（${ModalDetail.escapeHtml(CloudAPI.account)}）</div>
                <div class="cloud-btn-row">
                    <button class="btn-primary" id="cloud-upload">⬆️ 上传到云端</button>
                    <button class="btn-secondary" id="cloud-download">⬇️ 从云端下载</button>
                    <button class="btn-secondary" id="cloud-sync">🔄 同步</button>
                </div>
                <button class="cloud-logout" id="cloud-logout">退出云端账号</button>
                <div class="cloud-msg" id="cloud-msg"></div>
            `;
            card.querySelector('#cloud-upload').addEventListener('click', () => this.cloudUpload(card));
            card.querySelector('#cloud-download').addEventListener('click', () => this.cloudDownload(card));
            card.querySelector('#cloud-sync').addEventListener('click', () => this.cloudSync(card));
            card.querySelector('#cloud-logout').addEventListener('click', () => {
                CloudAPI.token = null; CloudAPI.account = null; CloudAPI.nickname = null;
                Toast.show('已退出云端', { type: 'success' });
                this.renderCloud();
            });
        } else {
            card.innerHTML = `
                <div class="cloud-title">☁️ 云端同步</div>
                <div class="cloud-desc">登录云端账号后，可在其他手机登录同一账号查看成绩</div>
                <input class="cloud-input" id="cloud-account" placeholder="账号（如手机号）" autocomplete="username">
                <input class="cloud-input" id="cloud-password" type="password" placeholder="密码" autocomplete="current-password">
                <input class="cloud-input" id="cloud-nickname" placeholder="昵称（仅注册时填写）">
                <div class="cloud-btn-row">
                    <button class="btn-primary" id="cloud-register">注册并登录</button>
                    <button class="btn-secondary" id="cloud-login">登录</button>
                </div>
                <div class="cloud-msg" id="cloud-msg"></div>
            `;
            card.querySelector('#cloud-register').addEventListener('click', () => this.cloudAuth(card, true));
            card.querySelector('#cloud-login').addEventListener('click', () => this.cloudAuth(card, false));
        }
    },

    cloudMsg(card, text, isError) {
        const el = card.querySelector('#cloud-msg');
        if (el) { el.textContent = text; el.className = 'cloud-msg' + (isError ? ' error' : ' success'); }
    },

    async cloudAuth(card, isRegister) {
        const account = card.querySelector('#cloud-account').value.trim();
        const password = card.querySelector('#cloud-password').value;
        const nickname = card.querySelector('#cloud-nickname').value.trim();
        if (!account || !password) { this.cloudMsg(card, '请填写账号和密码', true); return; }
        if (isRegister && !nickname) { this.cloudMsg(card, '注册请填写昵称', true); return; }
        try {
            const res = isRegister
                ? await CloudAPI.register(account, password, nickname)
                : await CloudAPI.login(account, password);
            CloudAPI.token = res.token;
            CloudAPI.account = res.account;
            CloudAPI.nickname = res.nickname;
            Toast.show(isRegister ? '注册成功，已登录云端' : '已登录云端', { type: 'success' });
            this.renderCloud();
        } catch (e) {
            this.cloudMsg(card, e.message || '操作失败', true);
        }
    },

    async cloudUpload(card) {
        try {
            const p = buildProfile();
            await CloudAPI.syncProfile(p);
            this.cloudMsg(card, `已上传 ${p.records.length} 条记录、${p.checkins.length} 次打卡、${p.blindBoxes.length} 个盲盒到云端`, false);
            Toast.show('已同步到云端', { type: 'success' });
        } catch (e) {
            this.cloudMsg(card, e.message || '上传失败', true);
        }
    },

    async cloudDownload(card) {
        try {
            const data = await CloudAPI.getProfile();
            Store.mergeProfile(data);
            const recs = (data.records || []);
            this.cloudMsg(card, `已从云端下载 ${recs.length} 条记录、${ (data.checkins||[]).length } 次打卡、${ (data.blindBoxes||[]).length } 个盲盒`, false);
            Toast.show('已从云端同步', { type: 'success' });
        } catch (e) {
            this.cloudMsg(card, e.message || '下载失败', true);
        }
    },

    async cloudSync(card) {
        this.cloudMsg(card, '同步中…');
        const n = await syncNow();
        if (n < 0) { this.cloudMsg(card, '同步失败，请检查网络或重新登录', true); return; }
        _lastSyncSig = syncSignature();
        this.cloudMsg(card, `同步完成，当前共 ${n} 条记录`, false);
        Toast.show('已与云端同步', { type: 'success' });
        // 刷新当前数据页，立即看到另一端的最新记录
        if (Router.current === 'home') PageHome.render();
        else if (Router.current === 'history') PageHistory.render();
        else if (Router.current === 'analysis') PageAnalysis.render();
    }
};

/* ==================== 详情弹窗 ==================== */
const ModalDetail = {
    currentId: null,

    show(id) {
        const records = Store.getRecords();
        const record = records.find(r => r.id === id);
        if (!record) return;

        this.currentId = id;
        const sc = Utils.strokeColor(record.stroke);
        const t = Utils.msToTime(record.timeMs);

        // 检查是否是最佳（跳绳按次数，其余按用时）
        const sameProject = records.filter(r => r.stroke === record.stroke && r.distance === record.distance);
        let isPB;
        if (record.category === 'rope') {
            const maxCount = sameProject.length ? Math.max(...sameProject.map(r => r.count || 0)) : (record.count || 0);
            isPB = (record.count || 0) === maxCount;
        } else {
            const bestMs = Math.min(...sameProject.map(r => r.timeMs));
            isPB = record.timeMs === bestMs;
        }

        const body = document.getElementById('detail-body');
        const ti = Utils.typeInfo(record.type);
        body.innerHTML = `
            <div style="text-align:center;margin-bottom:16px;">
                <span class="stroke-tag ${sc.class}-bg" style="display:inline-block;">${sc.emoji}${record.stroke}</span>
                <span class="detail-type-badge type-${record.type || 'training'}">${ti.emoji}${ti.label}</span>
                ${isPB ? '<span class="detail-pb-badge"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M19 5h-2V3H7v2H5a2 2 0 00-2 2v3a4 4 0 003.5 3.97V18a2 2 0 002 2h2v1h4v-1h2a2 2 0 002-2v-4.03A4 4 0 0021 10V7a2 2 0 00-2-2zM5 10V7h2v5.83A2 2 0 015 10zm14 0a2 2 0 01-2 2.83V7h2v3z"/></svg> 个人最佳</span>' : ''}
            </div>
            <div class="detail-section">
                <div class="detail-label">成绩类型</div>
                <div class="detail-value">${ti.emoji} ${ti.label}</div>
            </div>
            ${record.type === 'competition' && record.eventName ? `
                <div class="detail-section">
                    <div class="detail-label">赛事名称</div>
                    <div class="detail-note">${this.escapeHtml(record.eventName)}</div>
                </div>
            ` : ''}
            ${record.category === 'rope' ? `
                <div class="detail-section">
                    <div class="detail-label">次数</div>
                    <div class="detail-value">${record.count} 次</div>
                </div>
            ` : `
                <div class="detail-section">
                    <div class="detail-label">距离</div>
                    <div class="detail-value">${record.distance >= 1000 ? (record.distance / 1000).toFixed(1) + ' km' : record.distance + ' 米'}</div>
                </div>
            `}
            ${record.timeMs > 0 ? `
                <div class="detail-section" style="text-align:center;">
                    <div class="detail-label">用时</div>
                    <div class="detail-time-large">${t.main}<span class="ms-part">.${t.ms}</span></div>
                </div>
            ` : ''}
            <div class="detail-section">
                <div class="detail-label">日期</div>
                <div class="detail-value">${Utils.formatDate(record.date)}</div>
            </div>
            ${record.note ? `
                <div class="detail-section">
                    <div class="detail-label">备注</div>
                    <div class="detail-note">${this.escapeHtml(record.note)}</div>
                </div>
            ` : ''}
        `;

        document.getElementById('detail-modal').classList.add('active');
    },

    hide() {
        document.getElementById('detail-modal').classList.remove('active');
        this.currentId = null;
    },

    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
};

/* ==================== 图片压缩（上传前处理，减小体积） ==================== */
function compressImage(file, maxDim, quality) {
    maxDim = maxDim || 1280;
    quality = quality || 0.82;
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                if (width > maxDim || height > maxDim) {
                    if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim; }
                    else { width = Math.round(width * maxDim / height); height = maxDim; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width; canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = () => reject(new Error('图片加载失败'));
            img.src = reader.result;
        };
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsDataURL(file);
    });
}

/* ==================== 奖状墙：IndexedDB 图库 ==================== */
// 图片体积较大，单独存到 IndexedDB：同样保存在登录的这部手机本地、永久、不过期，
// 与成绩文本数据（localStorage）分离存储，互不干扰。
const GalleryDB = {
    DB_NAME: 'swimtrack_gallery_db',
    STORE: 'gallery',
    _db: null,
    open() {
        return new Promise((resolve, reject) => {
            if (this._db) return resolve(this._db);
            if (!window.indexedDB) return reject(new Error('当前环境不支持图片存储'));
            const req = indexedDB.open(this.DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE)) {
                    db.createObjectStore(this.STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
            req.onerror = (e) => reject(e.target.error);
        });
    },
    async getAll(account) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE, 'readonly');
            const req = tx.objectStore(this.STORE).getAll();
            req.onsuccess = () => {
                const items = (req.result || []).filter(i => i.account === account);
                items.sort((a, b) => b.createdAt - a.createdAt);
                resolve(items);
            };
            req.onerror = () => reject(req.error);
        });
    },
    async add(item) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE, 'readwrite');
            tx.objectStore(this.STORE).put(item);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
    async delete(id) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE, 'readwrite');
            tx.objectStore(this.STORE).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
};

/* ==================== 页面：奖状墙 ==================== */
const PageGallery = {
    items: [],
    currentKind: '',
    previewId: null,
    _pendingData: null,

    async render() {
        const account = Store.getSession();
        if (!account) return;

        // 同步分类标签
        document.querySelectorAll('#gallery-tabs .chip').forEach(c => {
            c.classList.toggle('active', (c.dataset.kind || '') === this.currentKind);
        });

        // 盲盒分类：来源为本地收藏（非图片），且不允许上传
        const isBlind = this.currentKind === 'blindbox';
        const addBtn = document.getElementById('gallery-add-btn');
        if (addBtn) addBtn.style.display = isBlind ? 'none' : '';

        let list;
        if (isBlind) {
            list = Store.getBlindBoxes().slice().sort((a, b) => b.createdAt - a.createdAt);
        } else {
            try {
                this.items = await GalleryDB.getAll(account);
            } catch (e) {
                this.items = [];
            }
            list = this.currentKind ? this.items.filter(i => i.kind === this.currentKind) : this.items;
        }

        const container = document.getElementById('gallery-grid');
        const countEl = document.getElementById('gallery-count');
        countEl.textContent = `共 ${list.length} 张`;

        if (list.length === 0) {
            if (isBlind) {
                container.innerHTML = `
                    <div class="empty-state">
                        <div style="font-size:46px;margin-bottom:8px;">🎁</div>
                        <p>还没有盲盒，去首页打卡攒积分抽取吧～</p>
                        <button class="empty-action" id="gallery-empty-gohome">☀️ 去首页打卡</button>
                    </div>`;
                const goBtn = document.getElementById('gallery-empty-gohome');
                if (goBtn) goBtn.addEventListener('click', () => Router.navigate('home'));
            } else {
                container.innerHTML = `
                    <div class="empty-state">
                        <div style="font-size:46px;margin-bottom:8px;">🏆</div>
                        <p>${this.currentKind === 'cert' ? '还没有奖状' : this.currentKind === 'photo' ? '还没有照片' : '奖状墙还是空的'}</p>
                        <button class="empty-action" id="gallery-empty-add">＋ 上传第一张</button>
                    </div>
                `;
                const aBtn = document.getElementById('gallery-empty-add');
                if (aBtn) aBtn.addEventListener('click', () => this.openUpload());
            }
            return;
        }

        if (isBlind) {
            container.innerHTML = list.map(it => `
                <div class="blindbox-item" data-id="${it.id}" style="--rc:${it.color}">
                    <div class="blindbox-item-icon" style="color:${it.color}">${it.icon}</div>
                    <div class="blindbox-item-tag" style="background:${it.color}">${it.label}</div>
                    <div class="blindbox-item-name">${ModalDetail.escapeHtml(it.name)}</div>
                    <div class="blindbox-item-date">${Utils.formatDate(it.date)}</div>
                </div>
            `).join('');
            container.querySelectorAll('.blindbox-item').forEach(el => {
                el.addEventListener('click', () => this.openBlindBoxPreview(el.dataset.id));
            });
            return;
        }

        container.innerHTML = list.map(it => {
            const badge = it.kind === 'cert' ? '🏆 奖状' : '📷 照片';
            return `
                <div class="gallery-item" data-id="${it.id}">
                    <img src="${it.data}" alt="${it.title || ''}" loading="lazy">
                    <div class="gallery-item-overlay">
                        <span class="gallery-item-badge">${badge}</span>
                        ${it.title ? `<span class="gallery-item-title">${ModalDetail.escapeHtml(it.title)}</span>` : ''}
                    </div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.gallery-item').forEach(el => {
            el.addEventListener('click', () => this.openPreview(el.dataset.id));
        });
    },

    openBlindBoxPreview(id) {
        const item = Store.getBlindBoxes().find(i => i.id === id);
        if (item) PageHome.showBlindBoxResult(item);
    },

    openUpload() {
        this._pendingData = null;
        document.getElementById('upload-title').value = '';
        document.getElementById('upload-file').value = '';
        const preview = document.getElementById('upload-preview');
        preview.classList.add('hidden');
        preview.innerHTML = '';
        document.querySelectorAll('#upload-type-options .option-btn').forEach(b => {
            b.classList.toggle('selected', b.dataset.ukind === 'cert');
        });
        document.getElementById('gallery-upload-modal').classList.add('active');
    },

    closeUpload() {
        document.getElementById('gallery-upload-modal').classList.remove('active');
    },

    async onFilePicked(file) {
        if (!file) return;
        try {
            const data = await compressImage(file, 1280, 0.82);
            this._pendingData = data;
            const preview = document.getElementById('upload-preview');
            preview.innerHTML = `<img src="${data}" alt="预览">`;
            preview.classList.remove('hidden');
        } catch (e) {
            Toast.show('图片处理失败，请重试');
        }
    },

    async saveUpload() {
        const account = Store.getSession();
        if (!account) return;
        if (!this._pendingData) {
            Toast.show('请先选择一张图片');
            return;
        }
        const kind = document.querySelector('#upload-type-options .option-btn.selected')?.dataset.ukind || 'cert';
        const title = document.getElementById('upload-title').value.trim();
        const item = {
            id: Utils.uid(),
            account,
            kind,
            title,
            data: this._pendingData,
            createdAt: Date.now()
        };
        try {
            await GalleryDB.add(item);
            this.closeUpload();
            Toast.show('已添加到奖状墙', { type: 'success' });
            this.render();
        } catch (e) {
            Toast.show('保存失败：' + (e.message || '未知错误'));
        }
    },

    openPreview(id) {
        const item = this.items.find(i => i.id === id);
        if (!item) return;
        this.previewId = id;
        document.getElementById('preview-img').src = item.data;
        const kindLabel = item.kind === 'cert' ? '🏆 奖状' : '📷 照片';
        document.getElementById('preview-title').textContent = kindLabel;
        const d = new Date(item.createdAt);
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        document.getElementById('preview-meta').innerHTML = `
            ${item.title ? `<div class="preview-title-text">${ModalDetail.escapeHtml(item.title)}</div>` : ''}
            <div class="preview-date">添加于 ${Utils.formatDate(ds)}</div>
        `;
        document.getElementById('gallery-preview-modal').classList.add('active');
    },

    closePreview() {
        document.getElementById('gallery-preview-modal').classList.remove('active');
        this.previewId = null;
    },

    async deletePreview() {
        if (!this.previewId) return;
        const ok = await Confirm.show('确定要删除这张吗？\n删除后不可恢复。');
        if (!ok) return;
        try {
            await GalleryDB.delete(this.previewId);
            this.closePreview();
            Toast.show('已删除', { type: 'success' });
            this.render();
        } catch (e) {
            Toast.show('删除失败');
        }
    }
};

/* ==================== 事件绑定 ==================== */
function bindEvents() {

    /* --- 认证 --- */
    // Tab 切换
    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
            tab.classList.add('active');
            const target = tab.dataset.tab;
            document.getElementById(target + '-form').classList.add('active');
            document.getElementById('login-error').textContent = '';
            document.getElementById('register-error').textContent = '';
        });
    });

    // 登录（云端优先，自动同步多设备）
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const account = document.getElementById('login-account').value.trim();
        const password = document.getElementById('login-password').value;
        const errEl = document.getElementById('login-error');
        errEl.textContent = '';

        if (!account) { errEl.textContent = '请输入账号'; return; }
        if (!password) { errEl.textContent = '请输入密码'; return; }

        errEl.textContent = '登录中…';
        const r = await unifiedAuth(account, password, false, '');
        if (r.ok) { enterApp(); return; }
        errEl.textContent = r.message;
    });

    // 注册（云端优先，自动同步多设备）
    document.getElementById('register-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nickname = document.getElementById('reg-nickname').value.trim();
        const account = document.getElementById('reg-account').value.trim();
        const password = document.getElementById('reg-password').value;
        const errEl = document.getElementById('register-error');
        errEl.textContent = '';

        if (!nickname) { errEl.textContent = '请输入昵称'; return; }
        if (!account) { errEl.textContent = '请输入账号'; return; }
        if (!password || password.length < 4) { errEl.textContent = '密码至少4位'; return; }

        errEl.textContent = '注册中…';
        const r = await unifiedAuth(account, password, true, nickname);
        if (r.ok) { enterApp(); return; }
        errEl.textContent = r.message;
    });

    /* --- 底部导航 --- */
    document.querySelectorAll('.bottom-nav').forEach(nav => {
        nav.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => {
                Router.navigate(item.dataset.nav);
            });
        });
    });

    // 历史页新增记录入口
    document.getElementById('history-add-btn').addEventListener('click', () => Router.navigate('record'));

    // 奖状墙：上传 / 预览 / 删除
    document.getElementById('gallery-add-btn').addEventListener('click', () => PageGallery.openUpload());
    document.querySelectorAll('#upload-type-options .option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#upload-type-options .option-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
    });
    document.getElementById('upload-file').addEventListener('change', (e) => {
        PageGallery.onFilePicked(e.target.files[0]);
    });
    document.getElementById('gallery-upload-close').addEventListener('click', () => PageGallery.closeUpload());
    document.getElementById('gallery-upload-cancel').addEventListener('click', () => PageGallery.closeUpload());
    document.getElementById('gallery-upload-save').addEventListener('click', () => PageGallery.saveUpload());
    document.getElementById('gallery-preview-close').addEventListener('click', () => PageGallery.closePreview());
    document.getElementById('gallery-preview-close-btn').addEventListener('click', () => PageGallery.closePreview());
    document.getElementById('gallery-preview-delete').addEventListener('click', () => PageGallery.deletePreview());
    document.querySelectorAll('#gallery-tabs .chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('#gallery-tabs .chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            PageGallery.currentKind = chip.dataset.kind || '';
            PageGallery.render();
        });
    });

    // 抽盲盒结果弹窗
    document.getElementById('blindbox-result-close').addEventListener('click', () => {
        document.getElementById('blindbox-result-modal').classList.remove('active');
    });
    document.getElementById('blindbox-result-goto').addEventListener('click', () => {
        document.getElementById('blindbox-result-modal').classList.remove('active');
        PageGallery.currentKind = 'blindbox';
        Router.navigate('gallery');
    });

    // 首页右上角个人中心
    document.getElementById('go-profile-btn').addEventListener('click', () => Router.navigate('profile'));

    /* --- 记录页 --- */
    // 运动项目切换
    document.querySelectorAll('#category-options .option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            PageRecord.selectedCategory = btn.dataset.category;
            document.querySelectorAll('#category-options .option-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            PageRecord.updateCategoryUI();
            PageRecord.updateTypeUI();
        });
    });

    // 泳姿选择
    document.querySelectorAll('#stroke-options .option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            PageRecord.selectedStroke = btn.dataset.stroke;
            PageRecord.updateStrokeUI();
        });
    });

    // 成绩类型选择
    document.querySelectorAll('#type-options .option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            PageRecord.selectedType = btn.dataset.type;
            PageRecord.updateTypeUI();
        });
    });

    // 距离选择
    document.querySelectorAll('#distance-options .option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            PageRecord.selectedDistance = parseInt(btn.dataset.distance);
            PageRecord.updateDistanceUI();
            // 清空自定义输入
            document.getElementById('custom-distance').value = '';
        });
    });

    // 自定义距离输入
    document.getElementById('custom-distance').addEventListener('input', () => {
        PageRecord.selectedDistance = null;
        PageRecord.updateDistanceUI();
    });

    // 返回/取消
    document.getElementById('record-back-btn').addEventListener('click', () => {
        Router.navigate(Router.prevView || 'home');
    });
    document.getElementById('record-cancel-btn').addEventListener('click', () => {
        Router.navigate(Router.prevView || 'home');
    });

    // 保存
    document.getElementById('record-save-btn').addEventListener('click', () => {
        PageRecord.save();
    });

    /* --- 历史页筛选 --- */
    document.getElementById('filter-stroke').addEventListener('change', () => PageHistory.render());
    document.getElementById('filter-distance').addEventListener('change', () => PageHistory.render());
    document.querySelectorAll('#history-type-chips .chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('#history-type-chips .chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            PageHistory.render();
        });
    });

    /* --- 分析页 --- */
    document.getElementById('analysis-stroke').addEventListener('change', (e) => {
        PageAnalysis.currentStroke = e.target.value;
        PageAnalysis.updateChart();
    });
    document.getElementById('analysis-distance').addEventListener('change', (e) => {
        PageAnalysis.currentDistance = parseInt(e.target.value);
        PageAnalysis.updateChart();
    });
    document.querySelectorAll('.range-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            PageAnalysis.currentRange = tab.dataset.range;
            document.querySelectorAll('.range-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            PageAnalysis.updateChart();
        });
    });
    document.querySelectorAll('#analysis-type-chips .chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('#analysis-type-chips .chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            PageAnalysis.currentType = chip.dataset.type || '';
            PageAnalysis.updateChart();
        });
    });

    /* --- 个人中心 --- */
    document.getElementById('edit-nickname-btn').addEventListener('click', () => {
        const user = Store.getCurrentUser();
        document.getElementById('nickname-input').value = user.nickname;
        document.getElementById('nickname-modal').classList.add('active');
    });
    document.getElementById('nickname-cancel').addEventListener('click', () => {
        document.getElementById('nickname-modal').classList.remove('active');
    });
    document.getElementById('nickname-save').addEventListener('click', () => {
        const val = document.getElementById('nickname-input').value.trim();
        if (!val) { Toast.show('昵称不能为空'); return; }
        Store.updateNickname(val);
        document.getElementById('nickname-modal').classList.remove('active');
        PageProfile.render();
        Toast.show('昵称已更新', { type: 'success' });
    });

    // 退出登录
    document.getElementById('logout-btn').addEventListener('click', async () => {
        const ok = await Confirm.show('确定要退出登录吗？');
        if (ok) {
            Store.clearSession();
            document.getElementById('main-app').classList.add('hidden');
            document.getElementById('auth-view').classList.add('active');
            // 清空表单
            document.getElementById('login-account').value = '';
            document.getElementById('login-password').value = '';
            document.getElementById('reg-nickname').value = '';
            document.getElementById('reg-account').value = '';
            document.getElementById('reg-password').value = '';
        }
    });

    // 数据导出
    document.getElementById('export-data-btn').addEventListener('click', () => {
        const user = Store.getCurrentUser();
        if (!user) return;
        const records = user.records;
        if (records.length === 0) {
            Toast.show('暂无数据可导出');
            return;
        }
        const data = {
            nickname: user.nickname,
            account: user.account,
            exportDate: new Date().toISOString(),
            totalRecords: records.length,
            records: records.map(r => ({
                id: r.id,
                date: r.date,
                stroke: r.stroke,
                distance: r.distance,
                type: r.type || 'training',
                eventName: r.eventName || '',
                timeMs: r.timeMs,
                time: Utils.msToTime(r.timeMs).full,
                note: r.note || ''
            }))
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `swimtrack_${user.nickname}_${Utils.todayStr()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        Toast.show('数据已导出', { type: 'success' });
    });

    // 数据导入（将导出的备份 JSON 重新导入本地）
    document.getElementById('import-data-btn').addEventListener('click', () => {
        document.getElementById('import-file').click();
    });
    document.getElementById('import-file').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = ''; // 允许重复选择同一文件
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                // 兼容两种备份格式：{records:[...]} 或 {app, records:[...]}
                const raw = Array.isArray(data) ? data : (data.records || []);
                if (!Array.isArray(raw) || raw.length === 0) {
                    Toast.show('文件中没有可导入的记录');
                    return;
                }
                const imported = raw.map(r => ({
                    id: r.id || Utils.uid(),
                    stroke: r.stroke,
                    distance: Number(r.distance) || 0,
                    timeMs: (r.timeMs != null) ? Number(r.timeMs) : Utils.timeToMs(r.time),
                    date: r.date || Utils.todayStr(),
                    type: r.type || 'training',
                    eventName: r.eventName || '',
                    note: r.note || '',
                    createdAt: r.createdAt || Date.now()
                })).filter(r => r.stroke && r.distance && r.timeMs >= 0);
                if (imported.length === 0) { Toast.show('没有有效的记录可导入'); return; }
                if (confirm(`确定导入 ${imported.length} 条记录吗？\n（与本地记录按编号合并，不会丢失本地已有数据）`)) {
                    Store.mergeImported(imported);
                    scheduleCloudSync();
                    Toast.show(`已导入 ${imported.length} 条记录`, { type: 'success' });
                    if (document.getElementById('history-view').classList.contains('active')) PageHistory.render();
                    if (document.getElementById('analysis-view')) PageAnalysis.render();
                }
            } catch (err) {
                Toast.show('文件解析失败，请检查是否为正确的备份文件');
            }
        };
        reader.readAsText(file);
    });

    // 关于
    document.getElementById('about-btn').addEventListener('click', () => {
        document.getElementById('about-modal').classList.add('active');
    });
    document.getElementById('about-close').addEventListener('click', () => {
        document.getElementById('about-modal').classList.remove('active');
    });

    // 反馈
    document.getElementById('feedback-btn').addEventListener('click', () => {
        document.getElementById('feedback-text').value = '';
        document.getElementById('feedback-modal').classList.add('active');
    });
    document.getElementById('feedback-close').addEventListener('click', () => {
        document.getElementById('feedback-modal').classList.remove('active');
    });
    document.getElementById('feedback-submit').addEventListener('click', () => {
        const text = document.getElementById('feedback-text').value.trim();
        if (!text) { Toast.show('请输入反馈内容'); return; }
        document.getElementById('feedback-modal').classList.remove('active');
        Toast.show('感谢反馈！', { type: 'success', sub: '你的意见对我们很重要' });
    });

    /* --- 详情弹窗 --- */
    document.getElementById('detail-close').addEventListener('click', () => ModalDetail.hide());
    document.getElementById('detail-modal').addEventListener('click', (e) => {
        if (e.target.id === 'detail-modal') ModalDetail.hide();
    });
    document.getElementById('detail-edit-btn').addEventListener('click', () => {
        const id = ModalDetail.currentId;
        ModalDetail.hide();
        Router.prevView = Router.current;
        Router.navigate('record', { editingId: id });
    });
    document.getElementById('detail-delete-btn').addEventListener('click', async () => {
        const id = ModalDetail.currentId;
        const ok = await Confirm.show('确定要删除这条成绩记录吗？\n删除后不可恢复。');
        if (ok) {
            Store.deleteRecord(id);
            scheduleCloudSync();
            ModalDetail.hide();
            Toast.show('记录已删除', { type: 'success' });
            // 刷新当前页面
            switch (Router.current) {
                case 'home': PageHome.render(); break;
                case 'history': PageHistory.render(); break;
                case 'analysis': PageAnalysis.updateChart(); break;
                case 'profile': PageProfile.render(); break;
            }
        }
    });

    /* --- 弹窗背景关闭 --- */
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.classList.remove('active');
            }
        });
    });
}

/* ==================== 进入应用 ==================== */
function enterApp() {
    document.getElementById('auth-view').classList.remove('active');
    document.getElementById('main-app').classList.remove('hidden');
    Router.navigate('home');
}

/* ==================== 初始化 ==================== */
function init() {
    bindEvents();

    // 注册 Service Worker（支持「添加到主屏幕」与离线打开）
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').then(() => {
            console.log('[SW] 已注册');
        }).catch((err) => {
            console.warn('[SW] 注册失败', err);
        });
    }

    // 检查登录状态
    const user = Store.getCurrentUser();
    if (user) {
        enterApp();
        // 已本地登录但云端未连：后台尝试把账号迁移到云端（多设备同步）
        autoCloudMigrate();
    } else {
        document.getElementById('auth-view').classList.add('active');
    }

    // 多设备同步：回到前台 / 窗口聚焦 / 每 30 秒主动从云端拉取最新记录
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') onCloudRefresh();
    });
    window.addEventListener('focus', onCloudRefresh);
    setInterval(onCloudRefresh, 30000);
}

// DOM 就绪后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
