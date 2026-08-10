/* ============================================================
 * SwimTrack - 游泳成绩追踪应用 (v14 · 全新 UI)
 * 纯前端 + 零依赖 Node 后端，数据存储于 localStorage / IndexedDB
 * ============================================================ */

/* ==================== 数据存储层 ==================== */
const Store = {
    USERS_KEY: 'swimtrack_users',
    SESSION_KEY: 'swimtrack_session',

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
        try { return JSON.parse(this._read(this.USERS_KEY) || '{}'); } catch { return {}; }
    },
    saveUsers(users) { this._persist(this.USERS_KEY, JSON.stringify(users)); },

    register(account, password, nickname) {
        const users = this.getUsers();
        if (users[account]) return { ok: false, msg: '该账号已存在' };
        users[account] = { account, password, nickname, createdAt: Date.now(), records: [] };
        this.saveUsers(users);
        return { ok: true };
    },
    login(account, password) {
        const users = this.getUsers();
        const user = users[account];
        if (!user) return { ok: false, msg: '账号不存在' };
        if (user.password !== password) return { ok: false, msg: '密码错误' };
        this.setSession(account);
        return { ok: true };
    },
    setSession(account) { this._persist(this.SESSION_KEY, account); },
    getSession() { return this._read(this.SESSION_KEY); },
    clearSession() { this._remove(this.SESSION_KEY); },
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
    addRecord(record) { this.updateUser(user => { user.records.push(record); }); },
    updateRecord(id, data) {
        this.updateUser(user => {
            const idx = user.records.findIndex(r => r.id === id);
            if (idx >= 0) user.records[idx] = { ...user.records[idx], ...data, updatedAt: Date.now() };
        });
    },
    deleteRecord(id) {
        this.updateUser(user => {
            user.records = user.records.filter(r => r.id !== id);
            // 墓碑：记下已删 id，否则云端/其他设备会把这条同步回来
            if (!Array.isArray(user.deletedIds)) user.deletedIds = [];
            if (!user.deletedIds.includes(id)) user.deletedIds.push(id);
        });
    },
    getDeletedIds() { const user = this.getCurrentUser(); return (user && Array.isArray(user.deletedIds)) ? user.deletedIds : []; },
    getRecords() { const user = this.getCurrentUser(); return user ? normalizeRecords(user.records) : []; },
    updateNickname(nickname) { this.updateUser(user => { user.nickname = nickname; }); },

    mergeImported(imported) {
        this.updateUser(user => {
            const map = {};
            user.records.forEach(r => (map[r.id] = r));
            imported.forEach(r => { if (r && r.id) map[r.id] = { ...r }; });
            user.records = Object.values(map);
        });
    },
    mergeCloud(cloudRecords) {
        this.updateUser(user => {
            const dead = new Set(Array.isArray(user.deletedIds) ? user.deletedIds : []);
            const map = {};
            user.records.forEach(r => { if (!dead.has(r.id)) map[r.id] = r; });
            cloudRecords.forEach(r => { if (r && r.id && !dead.has(r.id)) map[r.id] = { ...r }; });
            user.records = Object.values(map);
        });
    },
    mergeProfile(p) {
        if (!p) return;
        this.updateUser(user => {
            if (!Array.isArray(user.deletedIds)) user.deletedIds = [];
            // 合并云端墓碑，保证任一设备删除后全端一致
            (Array.isArray(p.deletedIds) ? p.deletedIds : []).forEach(id => {
                if (id && !user.deletedIds.includes(id)) user.deletedIds.push(id);
            });
            const dead = new Set(user.deletedIds);
            const recMap = {};
            user.records.forEach(r => { if (!dead.has(r.id)) recMap[r.id] = r; });
            (Array.isArray(p.records) ? p.records : []).forEach(r => { if (r && r.id && !dead.has(r.id)) recMap[r.id] = { ...r }; });
            user.records = Object.values(recMap);
            const ckMap = {};
            (user.checkins || []).forEach(c => (ckMap[c.date] = c));
            (Array.isArray(p.checkins) ? p.checkins : []).forEach(c => { if (c && c.date) ckMap[c.date] = { ...c }; });
            user.checkins = Object.values(ckMap);
            const bbMap = {};
            (user.blindBoxes || []).forEach(x => (bbMap[x.id] = x));
            (Array.isArray(p.blindBoxes) ? p.blindBoxes : []).forEach(x => { if (x && x.id) bbMap[x.id] = { ...x }; });
            user.blindBoxes = Object.values(bbMap);
        });
    },

    /* ---------- 打卡 / 积分 / 盲盒 ---------- */
    getCheckins() { const u = this.getCurrentUser(); return u ? (u.checkins || []) : []; },
    addCheckin(entry) { this.updateUser(u => { u.checkins = u.checkins || []; u.checkins.push(entry); }); },
    getPoints() {
        const u = this.getCurrentUser();
        if (!u) return 0;
        const earned = (u.checkins || []).reduce((s, c) => s + (c.points || 0), 0)
                    + (u.records || []).reduce((s, r) => s + (r.earnedPoints || 0), 0);
        const spent = (u.blindBoxes || []).length * BLINDBOX_COST;
        return Math.max(0, earned - spent);
    },
    addPoints(n) { this.updateUser(u => { u.points = (u.points || 0) + n; }); },
    spendPoints(n) { this.updateUser(u => { u.points = Math.max(0, (u.points || 0) - n); }); },
    getBlindBoxes() { const u = this.getCurrentUser(); return u ? (u.blindBoxes || []) : []; },
    addBlindBox(item) { this.updateUser(u => { u.blindBoxes = u.blindBoxes || []; u.blindBoxes.push(item); }); }
};

/* ==================== 云端账号 API（多设备同步） ==================== */
const CloudAPI = {
    TOKEN_KEY: 'swimtrack_cloud',
    ACCT_KEY: 'swimtrack_cloud_account',
    NICK_KEY: 'swimtrack_cloud_nick',
    OFF_KEY: 'swimtrack_cloud_disabled',
    TIMEOUT_MS: 15000,

    get token() { return localStorage.getItem(this.TOKEN_KEY); },
    set token(t) { t ? localStorage.setItem(this.TOKEN_KEY, t) : localStorage.removeItem(this.TOKEN_KEY); },
    get account() { return localStorage.getItem(this.ACCT_KEY); },
    set account(a) { a ? localStorage.setItem(this.ACCT_KEY, a) : localStorage.removeItem(this.ACCT_KEY); },
    get nickname() { return localStorage.getItem(this.NICK_KEY); },
    set nickname(n) { n ? localStorage.setItem(this.NICK_KEY, n) : localStorage.removeItem(this.NICK_KEY); },
    // 用户主动“退出云端”后置位，避免后台任务偷偷把会话又连回去
    get disabled() { return localStorage.getItem(this.OFF_KEY) === '1'; },
    set disabled(v) { v ? localStorage.setItem(this.OFF_KEY, '1') : localStorage.removeItem(this.OFF_KEY); },
    get connected() { return !!this.token && !this.disabled; },

    async request(path, opts = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
        // 超时保护：弱网下 fetch 可能长时间挂起，导致登录界面一直转圈
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), this.TIMEOUT_MS) : null;
        let res;
        try {
            res = await fetch(path, {
                method: opts.method || 'GET', headers,
                body: opts.body ? JSON.stringify(opts.body) : undefined,
                signal: ctrl ? ctrl.signal : undefined
            });
        } catch (e) {
            if (e && e.name === 'AbortError') throw new Error('云端连接超时，请检查网络后重试');
            throw new Error('云端服务暂不可用（网络异常或后端未启动）');
        } finally { if (timer) clearTimeout(timer); }
        const text = await res.text();
        let data = {};
        try { data = JSON.parse(text); } catch (e) { throw new Error('云端服务暂不可用（当前访问环境未部署后端服务）'); }
        if (!res.ok) { const err = new Error(data.error || ('请求失败 (' + res.status + ')')); err.status = res.status; throw err; }
        return data;
    },
    register(account, password, nickname) { return this.request('/api/register', { method: 'POST', body: { account, password, nickname } }); },
    login(account, password) { return this.request('/api/login', { method: 'POST', body: { account, password } }); },
    getProfile() { return this.request('/api/profile'); },
    syncProfile(profile) { return this.request('/api/sync', { method: 'POST', body: profile }); },
    exportData() { return this.request('/api/export'); },
    importData(records) { return this.request('/api/import', { method: 'POST', body: { records } }); },
    updateNickname(nickname) { return this.request('/api/me', { method: 'PUT', body: { nickname } }); }
};

/* ==================== 统一登录 + 双向同步 ==================== */
let _syncTimer = null;
let _syncing = false;
let _lastSyncSig = '';
function syncSignature() {
    const recSig = Store.getRecords().map(r => r.id + ':' + (r.updatedAt || r.createdAt || '')).sort().join(',');
    const ckSig = Store.getCheckins().map(c => c.date + ':' + (c.points || 0)).sort().join(',');
    const bbSig = Store.getBlindBoxes().map(b => b.id).sort().join(',');
    return recSig + '|' + ckSig + '|' + bbSig;
}
function buildProfile() { return { records: Store.getRecords(), checkins: Store.getCheckins(), blindBoxes: Store.getBlindBoxes(), deletedIds: Store.getDeletedIds() }; }
function scheduleCloudSync() {
    if (!CloudAPI.connected) return;
    if (_syncTimer) clearTimeout(_syncTimer);
    _syncTimer = setTimeout(() => { onCloudRefresh(); }, 600);
}
async function bindCloudSession(res, account, fallbackNickname, password) {
    CloudAPI.disabled = false; // 重新登录即恢复云端同步
    CloudAPI.token = res.token;
    CloudAPI.account = res.account;
    CloudAPI.nickname = res.nickname || fallbackNickname || account;
    const users = Store.getUsers();
    if (!users[account]) {
        users[account] = { account, password: password || '', nickname: CloudAPI.nickname, createdAt: Date.now(), records: [] };
        Store.saveUsers(users);
    } else if (password) { users[account].password = password; Store.saveUsers(users); }
    Store.setSession(account);
    await syncNow();
    _lastSyncSig = syncSignature();
    // 云端数据到位后强制重绘当前页，避免异地登录后界面还停留在空数据
    try {
        if (Router.current === 'home') PageHome.render();
        else if (Router.current === 'history') PageHistory.render();
        else if (Router.current === 'analysis' && typeof PageAnalysis !== 'undefined') PageAnalysis.render();
    } catch (e) {}
}
async function unifiedAuth(account, password, isRegister, nickname) {
    let res = null, err = null;
    try { res = isRegister ? await CloudAPI.register(account, password, nickname) : await CloudAPI.login(account, password); }
    catch (e) { err = e; }
    const unavailable = err && /暂不可用|超时|Failed to fetch|NetworkError|网络/.test(err.message);
    if (!res && unavailable) {
        if (isRegister) {
            // 注册时后端不可达：先在本地建账号，等联网后由 autoCloudMigrate 迁移上云
            const lr = Store.register(account, password, nickname || account);
            if (!lr.ok) return { ok: false, message: lr.msg };
            return { ok: true, offline: true };
        }
        // 登录时后端不可达：只有本机确实存过这个账号才允许离线进入，
        // 否则必须报错——异地登录时静默放行会让用户看到一个空账号，误以为数据丢了
        const localUser = Store.getUsers()[account];
        if (!localUser) {
            return { ok: false, message: '未能获取云端账号：当前网络连不上服务器，且本机没有该账号的数据。请检查网络后重试。' };
        }
        const lr = Store.login(account, password);
        if (!lr.ok) return { ok: false, message: lr.msg };
        return { ok: true, offline: true };
    }
    if (!res || !res.token) {
        if (err && /账号不存在/.test(err.message)) {
            const lu = Store.getUsers()[account];
            if (lu && lu.password === password) {
                try { res = await CloudAPI.register(account, password, lu.nickname || nickname || account); } catch (e2) { err = e2; }
            }
        }
        if (!res || !res.token) return { ok: false, message: (res && res.error) || (err && err.message) || '登录失败' };
    }
    await bindCloudSession(res, account, nickname, password);
    return { ok: true };
}
async function autoCloudMigrate() {
    if (CloudAPI.disabled) return; // 用户已主动退出云端，不再自动连回
    if (CloudAPI.connected) return;
    const account = Store.getSession();
    if (!account) return;
    const user = Store.getUsers()[account];
    if (!user || !user.password) return;
    try {
        let res = null, err = null;
        try { res = await CloudAPI.login(account, user.password); } catch (e) { err = e; }
        if (!res || !res.token) {
            if (err && /账号不存在/.test(err.message)) { try { res = await CloudAPI.register(account, user.password, user.nickname || account); } catch (e2) { return; } }
            else return;
        }
        if (!res || !res.token) return;
        CloudAPI.token = res.token; CloudAPI.account = res.account; CloudAPI.nickname = res.nickname || user.nickname || account;
        if (Array.isArray(user.records) && user.records.length) await CloudAPI.syncProfile(buildProfile());
        try { const data = await CloudAPI.getProfile(); if (data) Store.mergeProfile(data); } catch (e) {}
        if (Router.current === 'home') PageHome.render();
        else if (Router.current === 'history') PageHistory.render();
    } catch (e) {}
}
async function reauthCloud() {
    if (CloudAPI.disabled) return false; // 已退出云端，不静默重连
    const account = Store.getSession();
    if (!account) return false;
    const user = Store.getUsers()[account];
    if (!user || !user.password) return false;
    try {
        const res = await CloudAPI.login(account, user.password);
        if (!res || !res.token) return false;
        CloudAPI.token = res.token; CloudAPI.account = res.account; CloudAPI.nickname = res.nickname || user.nickname || account;
        return true;
    } catch (e) { return false; }
}
async function syncNow() {
    if (!CloudAPI.connected) return -1;
    if (_syncing) return Store.getRecords().length;
    _syncing = true;
    try {
        const data = await CloudAPI.getProfile();
        if (data) Store.mergeProfile(data);
        await CloudAPI.syncProfile(buildProfile());
        return Store.getRecords().length;
    } catch (e) {
        if (e && e.status === 401) {
            const ok = await reauthCloud();
            if (ok) {
                try { const data = await CloudAPI.getProfile(); if (data) Store.mergeProfile(data); await CloudAPI.syncProfile(buildProfile()); return Store.getRecords().length; } catch (_) {}
            }
        }
        return -1;
    } finally { _syncing = false; }
}
function onCloudRefresh() {
    if (!CloudAPI.connected) return;
    const authView = document.getElementById('auth-view');
    if (authView && authView.classList.contains('active')) return;
    syncNow().then((n) => {
        if (n < 0) return;
        const sig = syncSignature();
        if (sig !== _lastSyncSig) {
            _lastSyncSig = sig;
            const refreshers = { home: () => PageHome.render(), history: () => PageHistory.render(), analysis: () => PageAnalysis.render(), gallery: () => PageGallery.render(), blindbox: () => PageBlindbox.render(), profile: () => PageProfile.render() };
            if (refreshers[Router.current]) refreshers[Router.current]();
        } else { _lastSyncSig = sig; }
    });
}

/* ==================== 工具函数 ==================== */
const Utils = {
    uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); },
    todayStr() { const d = new Date(); const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0'); return `${y}-${m}-${day}`; },
    // "2026-08-10" 用 new Date() 解析会被当成 UTC，东八区会偏到前一天，这里按本地时间构造
    parseLocalDate(s) {
        if (s instanceof Date) return s;
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
        if (!m) { const d = new Date(s); return isNaN(d.getTime()) ? new Date() : d; }
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    },
    // Date → "YYYY-MM-DD"（本地时区，不用 toISOString 以免整体偏移一天）
    localDateStr(d) {
        const x = (d instanceof Date) ? d : new Date(d);
        return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    },
    formatDate(dateStr) { if (!dateStr) return ''; const d = this.parseLocalDate(dateStr); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0'); return `${d.getFullYear()}-${m}-${day}`; },
    formatDateShort(dateStr) { if (!dateStr) return ''; const d = this.parseLocalDate(dateStr); return `${d.getMonth() + 1}/${d.getDate()}`; },
    msToTime(ms) {
        if (ms == null || isNaN(ms)) return { main: '--', ms: '00', full: '--' };
        const totalSec = ms / 1000; const min = Math.floor(totalSec / 60); const sec = Math.floor(totalSec % 60); const cs = Math.floor((ms % 1000) / 10);
        return { main: `${min}:${String(sec).padStart(2, '0')}`, ms: String(cs).padStart(2, '0'), full: `${min}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}` };
    },
    inputsToMs(min, sec, ms) { return (parseInt(min) || 0) * 60000 + (parseInt(sec) || 0) * 1000 + (parseInt(ms) || 0) * 10; },
    timeToMs(str) {
        if (str == null) return 0;
        const s = String(str).trim(); const m = s.match(/^(?:(\d+):)?(\d+)(?:[.:](\d+))?$/);
        if (!m) return 0;
        const min = parseInt(m[1] || '0', 10); const sec = parseInt(m[2] || '0', 10); const frac = parseInt(m[3] || '0', 10);
        const fracMs = m[3] && m[3].length >= 3 ? parseInt(m[3].slice(0, 3), 10) : (frac * 10);
        return min * 60000 + sec * 1000 + fracMs;
    },
    msToInputs(ms) { const min = Math.floor(ms / 60000); const sec = Math.floor((ms % 60000) / 1000); const cs = Math.floor((ms % 1000) / 10); return { min, sec, ms: cs }; },
    msToHours(ms) { return (ms / 3600000).toFixed(1); },
    mToKm(m) { return (m / 1000).toFixed(1); },
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
    strokeShort(stroke) { return stroke.charAt(0); },
    typeInfo(type) { return type === 'competition' ? { label: '比赛成绩', short: '比赛', emoji: '🏆' } : { label: '训练成绩', short: '训练', emoji: '🏊' }; },
    greeting() { const h = new Date().getHours(); if (h < 6) return '凌晨好'; if (h < 12) return '早上好'; if (h < 14) return '中午好'; if (h < 18) return '下午好'; return '晚上好'; },
    todayDisplay() { const d = new Date(); const w = ['周日','周一','周二','周三','周四','周五','周六']; return `${d.getMonth() + 1}月${d.getDate()}日 ${w[d.getDay()]}`; }
};

/* ==================== 路由（5 标签全局导航） ==================== */
const NAV_TO_VIEW = { home: 'home', record: 'record', analysis: 'analysis', blindbox: 'blindbox', me: 'profile' };
const VIEW_TO_TAB = { home: 'home', record: 'record', history: 'record', analysis: 'analysis', blindbox: 'blindbox', gallery: 'me', profile: 'me' };
const Router = {
    current: 'home', editingId: null, prevView: 'home',
    navigate(view, opts = {}) {
        if (view === 'record') this.prevView = this.current;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const target = document.getElementById(view + '-view');
        if (target) target.classList.add('active');
        const tab = VIEW_TO_TAB[view] || view;
        document.querySelectorAll('#main-nav .nav-item').forEach(it => it.classList.toggle('active', it.dataset.nav === tab));
        this.current = view;
        if (opts.editingId) this.editingId = opts.editingId;
        switch (view) {
            case 'home': PageHome.render(); break;
            case 'record': PageRecord.render(opts.editingId, opts.presetCategory); break;
            case 'history': PageHistory.render(); break;
            case 'analysis': PageAnalysis.render(); break;
            case 'gallery': PageGallery.render(); break;
            case 'blindbox': PageBlindbox.render(); break;
            case 'profile': PageProfile.render(); break;
        }
        const content = target && target.querySelector('.page-content');
        if (content) content.scrollTop = 0;
    }
};

/* ==================== Toast / Confirm ==================== */
// HTML 转义：昵称、泳姿、盲盒名、图片标题等都可能来自用户输入或云端，拼进 innerHTML 前必须过一遍
function esc(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// 颜色白名单：只允许 #hex / rgb() / 常见颜色名，防止 style 属性注入
function safeColor(c, fallback = '#888') {
    const s = String(c == null ? '' : c).trim();
    return /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|[a-zA-Z]{3,20})$/.test(s) ? s : fallback;
}
const Toast = {
    show(msg, opts = {}) {
        const el = document.getElementById('toast'); el.className = 'toast'; if (opts.type) el.classList.add(opts.type);
        let html = '';
        if (opts.type === 'success') html += '<svg class="toast-icon" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="white" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>';
        html += `<div>${esc(msg)}</div>`; if (opts.sub) html += `<div class="toast-sub">${esc(opts.sub)}</div>`;
        el.innerHTML = html; el.classList.add('show');
        clearTimeout(this._timer); this._timer = setTimeout(() => el.classList.remove('show'), opts.duration || 2500);
    }
};
const Confirm = {
    show(msg) {
        return new Promise(resolve => {
            const overlay = document.getElementById('confirm-modal');
            document.getElementById('confirm-message').textContent = msg;
            overlay.classList.add('active');
            const ok = document.getElementById('confirm-ok'), cancel = document.getElementById('confirm-cancel');
            const cleanup = () => { overlay.classList.remove('active'); ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel); };
            const onOk = () => { cleanup(); resolve(true); }, onCancel = () => { cleanup(); resolve(false); };
            ok.addEventListener('click', onOk); cancel.addEventListener('click', onCancel);
        });
    }
};

/* ==================== 盲盒定义 ==================== */
const BLINDBOX_RARITIES = [
    { key: 'common', label: '普通款', weight: 50, color: '#94A3B8', icon: '🐟' },
    { key: 'classic', label: '经典款', weight: 30, color: '#2E9BFF', icon: '🏅' },
    { key: 'rare', label: '稀有款', weight: 15, color: '#A855F7', icon: '💎' },
    { key: 'limited', label: '限量款', weight: 4, color: '#F59E0B', icon: '🔥' },
    { key: 'collector', label: '典藏款', weight: 1, color: '#E11D48', icon: '👑' }
];
const BLINDBOX_NAMES = {
    common: ['小金鱼贴纸', '水滴徽章', '泳圈挂件', '浪花书签', '泡泡贴纸'],
    classic: ['银色奖牌', '海豚吊坠', '经典泳帽', '蓝鲸摆件', '海星徽章'],
    rare: ['紫晶泳镜', '流星奖杯', '幻彩鱼尾', '星河徽章', '极光挂坠'],
    limited: ['烈焰限定卡', '黄金限定章', '霓虹限定牌', '极光限定盒', '星耀限定印'],
    collector: ['典藏王冠', '传奇金鳞', '永恒之泳', '创世之冠', '沧海遗珠']
};
const BLINDBOX_COST = 10;
function rollBlindBox() {
    const total = BLINDBOX_RARITIES.reduce((s, r) => s + r.weight, 0);
    let x = Math.random() * total, chosen = BLINDBOX_RARITIES[0];
    for (const r of BLINDBOX_RARITIES) { if (x < r.weight) { chosen = r; break; } x -= r.weight; }
    const names = BLINDBOX_NAMES[chosen.key];
    return { rarity: chosen.key, label: chosen.label, color: chosen.color, icon: chosen.icon, name: names[Math.floor(Math.random() * names.length)] };
}
function drawBlindBoxNow() {
    const points = Store.getPoints();
    if (points < BLINDBOX_COST) { Toast.show('积分不足，先去打卡攒积分吧～'); return null; }
    const rb = rollBlindBox();
    const item = { id: Utils.uid(), account: Store.getSession(), rarity: rb.rarity, label: rb.label, color: rb.color, icon: rb.icon, name: rb.name, date: Utils.todayStr(), createdAt: Date.now() };
    Store.addBlindBox(item);
    scheduleCloudSync();
    return item;
}
// 老版本记录没有 category 字段，分析页按 category 过滤会整批漏掉它们，这里按内容兜底推断
function inferCategory(r) {
    if (!r) return 'swim';
    if (r.category) return r.category;
    const s = String(r.stroke || '');
    if (s.includes('跳绳') || (Number(r.count) > 0 && !Number(r.distance))) return 'rope';
    if (s.includes('跑') || s.toLowerCase().includes('run')) return 'run';
    return 'swim';
}
// 读取时统一补齐 category，保证分析页统计完整
function normalizeRecords(list) {
    return (Array.isArray(list) ? list : []).map(r => (r && !r.category) ? { ...r, category: inferCategory(r) } : r);
}
function pointsForRecord(r) {
    if (r.category === 'rope') return 1 + Math.floor((r.count || 0) / 200);
    const dist = r.distance || 0;
    if (r.category === 'run') return Math.max(1, Math.round(dist / 1000));
    return Math.max(1, Math.round(dist / 250));
}

/* ==================== 页面：首页 ==================== */
const PageHome = {
    render() {
        const user = Store.getCurrentUser(); if (!user) return;
        document.getElementById('home-greeting-text').textContent = Utils.greeting();
        document.getElementById('home-user-name').textContent = user.nickname;
        document.getElementById('home-date').textContent = Utils.todayDisplay();
        const records = Store.getRecords();
        this.renderCheckin();
        this.renderProgressOverview(records);
        const now = new Date();
        const monthRecords = records.filter(r => { const d = Utils.parseLocalDate(r.date); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); });
        const monthDistance = monthRecords.reduce((s, r) => s + (r.distance || 0), 0);
        const monthTime = monthRecords.reduce((s, r) => s + (r.timeMs || 0), 0);
        document.getElementById('home-month-count').textContent = monthRecords.length;
        document.getElementById('home-month-distance').innerHTML = `${Utils.mToKm(monthDistance)}<span class="stat-unit">km</span>`;
        document.getElementById('home-month-time').innerHTML = `${Utils.msToHours(monthTime)}<span class="stat-unit">h</span>`;
        this.renderCategoryCards(records);
    },
    _dateStr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
    renderCheckin() {
        const el = document.getElementById('hero-card'); if (!el) return;
        const today = Utils.todayStr();
        const checkins = Store.getCheckins();
        const doneToday = checkins.some(c => c.date === today);
        const total = checkins.length;
        const points = Store.getPoints();
        const canDraw = points >= BLINDBOX_COST;
        let streak = 0; const set = new Set(checkins.map(c => c.date)); const d = new Date();
        while (set.has(this._dateStr(d))) { streak++; d.setDate(d.getDate() - 1); }
        el.innerHTML = `
            <div class="hero-top">
                <div class="hero-title">📅 每日打卡</div>
                <div class="hero-streak">🔥 连续 <b>${streak}</b> 天 · 累计 <b>${total}</b> 次</div>
            </div>
            <div class="hero-points"><b>${points}</b><small>可用积分（${BLINDBOX_COST} 分抽一次盲盒）</small></div>
            <div class="hero-actions">
                <button class="hero-btn-soft" id="checkin-btn" ${doneToday ? 'disabled style="opacity:.7"' : ''}>${doneToday ? '✅ 今日已打卡' : '☀️ 立即打卡 +积分'}</button>
                <button class="hero-btn-ghost" id="draw-blindbox-btn" ${canDraw ? '' : 'disabled style="opacity:.6"'}>🎁 抽盲盒</button>
            </div>
            ${doneToday ? '' : '<div class="hero-tip">每天打卡都能获得积分，连续打卡积分更多，攒够 10 分就能抽盲盒 🎉</div>'}
        `;
        const btn = el.querySelector('#checkin-btn');
        if (btn && !doneToday) btn.addEventListener('click', () => this.checkIn());
        const drawBtn = el.querySelector('#draw-blindbox-btn');
        if (drawBtn && canDraw) drawBtn.addEventListener('click', () => this.drawBlindBox());
    },
    checkIn() {
        const today = Utils.todayStr();
        const checkins = Store.getCheckins();
        if (checkins.some(c => c.date === today)) { Toast.show('今天已经打卡啦～'); return; }
        const set = new Set(checkins.map(c => c.date)); let streak = 1; const d = new Date(); d.setDate(d.getDate() - 1);
        while (set.has(this._dateStr(d))) { streak++; d.setDate(d.getDate() - 1); }
        const points = 5 + Math.floor(checkins.length / 5) + Math.min(streak - 1, 5);
        Store.addCheckin({ date: today, points, streak });
        Toast.show('打卡成功 +' + points + ' 积分', { type: 'success', sub: '连续打卡 ' + streak + ' 天' });
        this.render(); scheduleCloudSync();
    },
    drawBlindBox() {
        const it = drawBlindBoxNow();
        if (it) { this.renderCheckin(); this.showBlindBoxResult(it); }
    },
    showBlindBoxResult(item) {
        const modal = document.getElementById('blindbox-result-modal'); if (!modal) return;
        const isTop = (item.rarity === 'limited' || item.rarity === 'collector');
        modal.querySelector('.blindbox-result-icon').textContent = item.icon;
        modal.querySelector('.blindbox-result-name').textContent = item.name;
        const tag = modal.querySelector('.blindbox-result-tag'); tag.textContent = item.label; tag.style.background = item.color;
        const card = modal.querySelector('.blindbox-result-card'); card.style.borderColor = item.color; card.style.boxShadow = '0 10px 40px ' + item.color + '55';
        modal.querySelector('.blindbox-result-sub').textContent = isTop ? '🎉 欧气爆棚！抽中高品质款式！' : '已收入奖状墙「盲盒」分类';
        modal.classList.add('active');
    },
    _metricOf(r) { return (r.category === 'rope') ? -(r.count || 0) : (r.timeMs || 0); },
    computeProgressOverview(records) {
        const groups = {};
        records.forEach(r => { const key = r.stroke + '|' + r.distance; (groups[key] = groups[key] || []).push(r); });
        const sortByDate = arr => arr.slice().sort((a, b) => a.date === b.date ? (a.createdAt || 0) - (b.createdAt || 0) : a.date.localeCompare(b.date));
        let improve = 0, regress = 0, same = 0, rateSum = 0, rateCount = 0;
        Object.values(groups).forEach(g => {
            const s = sortByDate(g); if (s.length < 2) return;
            const prev = s[s.length - 2], latest = s[s.length - 1];
            const diff = this._metricOf(latest) - this._metricOf(prev);
            if (diff < 0) { improve++; const base = Math.abs(this._metricOf(prev)) || 1; rateSum += Math.abs(diff) / base * 100; rateCount++; }
            else if (diff > 0) regress++; else same++;
        });
        const avgRate = rateCount > 0 ? rateSum / rateCount : 0;
        const allSorted = sortByDate(records);
        let lastTrend = null;
        if (allSorted.length >= 2) {
            const latest = allSorted[allSorted.length - 1];
            const g = sortByDate(groups[latest.stroke + '|' + latest.distance] || []);
            if (g.length >= 2) {
                const prev = g[g.length - 2]; const diff = this._metricOf(latest) - this._metricOf(prev); const isRope = latest.category === 'rope'; let desc;
                if (isRope) { const d = Math.abs((latest.count || 0) - (prev.count || 0)); desc = `${latest.stroke} 次数${diff < 0 ? '增加' : '减少'} ${d} 次`; }
                else { const dT = Utils.msToTime(Math.abs(this._metricOf(latest) - this._metricOf(prev))); const dist = latest.distance >= 1000 ? (latest.distance / 1000).toFixed(1) + 'km' : latest.distance + '米'; desc = `${latest.stroke} ${dist} ${diff < 0 ? '快了' : '慢了'} ${dT.main}.${dT.ms}`; }
                lastTrend = { type: diff < 0 ? 'improve' : (diff > 0 ? 'regress' : 'same'), desc };
            }
        }
        return { improve, regress, same, avgRate, lastTrend, series: improve + regress + same };
    },
    renderProgressOverview(records) {
        const el = document.getElementById('home-progress-overview'); if (!el) return;
        if (records.length < 2) { el.innerHTML = `<div class="progress-ov-empty">记录达到 2 条后，这里会显示你的进步情况分析 📈</div>`; return; }
        const s = this.computeProgressOverview(records); const rateTxt = s.avgRate.toFixed(1) + '%'; const overallUp = s.improve >= s.regress;
        let summary = '';
        if (s.lastTrend) {
            const t = s.lastTrend;
            if (t.type === 'improve') summary = `<div class="progress-ov-summary"><span class="progress-arrow improve"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg></span><span>最近一次 <b>${t.desc}</b> 进步 ↑</span></div>`;
            else if (t.type === 'regress') summary = `<div class="progress-ov-summary"><span class="progress-arrow regress"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg></span><span>最近一次 <b>${t.desc}</b> 退步 ↓</span></div>`;
            else summary = `<div class="progress-ov-summary"><span class="progress-arrow same"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/></svg></span><span>最近一次 <b>${t.desc}</b> 成绩持平</span></div>`;
        }
        el.innerHTML = `
            <div class="progress-ov-grid">
                <div class="progress-ov-item"><div class="progress-ov-value improve">${s.improve}</div><div class="progress-ov-label">进步次数</div></div>
                <div class="progress-ov-item"><div class="progress-ov-value regress">${s.regress}</div><div class="progress-ov-label">退步次数</div></div>
                <div class="progress-ov-item"><div class="progress-ov-value ${overallUp ? 'improve' : 'regress'}">${rateTxt}</div><div class="progress-ov-label">平均进步率</div></div>
            </div>${summary}`;
    },
    renderCategoryCards(records) {
        const container = document.getElementById('home-category-cards'); if (!container) return;
        const cats = [
            { key: 'swim', name: '游泳', emoji: '🏊', cls: 'cat-swim' },
            { key: 'run', name: '跑步', emoji: '🏃', cls: 'cat-run' },
            { key: 'rope', name: '跳绳', emoji: '🤾', cls: 'cat-rope' }
        ];
        container.innerHTML = cats.map(c => {
            const list = records.filter(r => r.category === c.key); const count = list.length;
            let sub1Val, sub1Label, sub2Val, sub2Label;
            if (c.key === 'rope') {
                const totalCount = list.reduce((s, r) => s + (r.count || 0), 0); let best = 0; list.forEach(r => { if ((r.count || 0) > best) best = r.count || 0; });
                sub1Val = totalCount + ' 次'; sub1Label = '累计次数'; sub2Val = best + ' 次'; sub2Label = '最佳次数';
            } else {
                const totalDist = list.reduce((s, r) => s + (r.distance || 0), 0); let bestTime = null;
                list.forEach(r => { if (r.timeMs > 0 && (bestTime == null || r.timeMs < bestTime)) bestTime = r.timeMs; });
                sub1Val = Utils.mToKm(totalDist) + ' km'; sub1Label = '累计距离'; sub2Val = bestTime != null ? Utils.msToTime(bestTime).main : '—'; sub2Label = '最快成绩';
            }
            return `
                <div class="cat-card ${c.cls}" data-category="${c.key}">
                    <div class="cat-card-header"><span class="cat-emoji">${c.emoji}</span><span class="cat-name">${c.name}</span></div>
                    <div class="cat-count"><span class="cat-count-num">${count}</span><span class="cat-count-unit">次</span></div>
                    <div class="cat-count-label">总次数</div>
                    <div class="cat-sub">
                        <div class="cat-sub-item"><div class="cat-sub-val">${sub1Val}</div><div class="cat-sub-label">${sub1Label}</div></div>
                        <div class="cat-sub-item"><div class="cat-sub-val">${sub2Val}</div><div class="cat-sub-label">${sub2Label}</div></div>
                    </div>
                </div>`;
        }).join('');
        container.querySelectorAll('.cat-card').forEach(card => card.addEventListener('click', () => Router.navigate('record', { presetCategory: card.dataset.category })));
    }
};

/* ==================== 页面：记录成绩（游泳/跑步/跳绳） ==================== */
const PageRecord = {
    selectedCategory: 'swim',
    selectedStroke: null,
    editingId: null,
    // 跑步 GPS 状态
    runWatchId: null, runPoints: [], runDistVal: 0, runResultDist: 0, runRoute: null, runOn: false,
    // 跳绳状态
    ropeMode: '1', ropeStream: null, ropeTimerID: null, ropeCount: 0, ropeLimit: 60, ropeRunning: false, ropeDone: false, ropeStartTs: 0,

    render(editingId, presetCategory) {
        this.editingId = editingId || null;
        document.getElementById('record-page-title').textContent = editingId ? '编辑成绩' : '记录成绩';
        this.stopRun(true); this.resetRope(true);
        if (editingId) {
            const record = Store.getRecords().find(r => r.id === editingId);
            if (record) {
                this.selectedCategory = record.category || 'swim';
                this.selectedStroke = record.stroke && record.category !== 'run' && record.category !== 'rope' ? record.stroke : null;
                document.getElementById('record-date').value = record.date || Utils.todayStr();
                const ti = Utils.msToInputs(record.timeMs || 0);
                document.getElementById('t-min').value = ti.min; document.getElementById('t-sec').value = ti.sec; document.getElementById('t-cs').value = ti.ms;
                document.getElementById('distance-custom').value = '';
                if (record.category === 'run') {
                    document.getElementById('run-time').value = record.timeMs ? Utils.msToTime(record.timeMs).full : '';
                    this.runResultDist = record.distance || 0;
                } else if (record.category === 'rope') {
                    document.getElementById('rope-count-input').value = record.count || '';
                }
            }
        } else {
            this.selectedCategory = presetCategory || 'swim'; this.selectedStroke = null;
            document.getElementById('record-date').value = Utils.todayStr();
            document.getElementById('t-min').value = ''; document.getElementById('t-sec').value = ''; document.getElementById('t-cs').value = '';
            document.getElementById('distance-custom').value = ''; document.getElementById('run-time').value = ''; document.getElementById('rope-count-input').value = '';
            this.runResultDist = 0;
        }
        // 分段控件高亮
        document.querySelectorAll('#cat-seg button').forEach(b => b.classList.toggle('active', b.dataset.cat === this.selectedCategory));
        // 泳姿下拉默认值
        const sel = document.getElementById('stroke-select');
        if (this.selectedStroke) sel.value = this.selectedStroke; else if (!sel.value) sel.value = '自由泳';
        this.setCatUI();
        this.renderRecent();
    },
    setCat(cat) { this.selectedCategory = cat; document.querySelectorAll('#cat-seg button').forEach(b => b.classList.toggle('active', b.dataset.cat === cat)); this.setCatUI(); },
    setCatUI() {
        const isSwim = this.selectedCategory === 'swim', isRun = this.selectedCategory === 'run', isRope = this.selectedCategory === 'rope';
        document.getElementById('f-stroke').style.display = isSwim ? '' : 'none';
        document.getElementById('f-distance').style.display = isSwim ? '' : 'none';
        document.getElementById('f-swimtime').style.display = isSwim ? '' : 'none';
        document.getElementById('f-runtime').style.display = isRun ? '' : 'none';
        document.getElementById('f-runmap').style.display = isRun ? '' : 'none';
        document.getElementById('f-count').style.display = isRope ? '' : 'none';
        document.getElementById('ropeModule').style.display = isRope ? '' : 'none';
        document.getElementById('recordSave').style.display = isRope ? 'none' : '';
        if (isRun) this.resetRunUI();
        if (isRope) this.resetRopeUI();
    },
    getDistance() {
        const sel = document.getElementById('distance-select');
        if (sel.value === 'custom') return parseInt(document.getElementById('distance-custom').value) || 0;
        return parseInt(sel.value) || 0;
    },
    buildRecordBase() {
        const date = document.getElementById('record-date').value || Utils.todayStr();
        const base = { date, category: this.selectedCategory, stroke: '', distance: 0, count: 0, timeMs: 0, note: '', type: 'training', eventName: '', createdAt: Date.now() };
        if (this.selectedCategory === 'swim') {
            base.stroke = document.getElementById('stroke-select').value;
            base.distance = this.getDistance();
            base.timeMs = Utils.inputsToMs(document.getElementById('t-min').value, document.getElementById('t-sec').value, document.getElementById('t-cs').value);
        } else if (this.selectedCategory === 'run') {
            base.stroke = '跑步'; base.distance = this.runResultDist || 0;
            base.timeMs = Utils.timeToMs(document.getElementById('run-time').value);
        } else if (this.selectedCategory === 'rope') {
            base.stroke = '跳绳'; base.count = this.ropeCount || 0; base.timeMs = Utils.inputsToMs('', '', '') || 0;
        }
        base.earnedPoints = pointsForRecord(base);
        return base;
    },
    save() {
        if (this.selectedCategory === 'swim') {
            const stroke = document.getElementById('stroke-select').value;
            const distance = this.getDistance();
            const t = Utils.inputsToMs(document.getElementById('t-min').value, document.getElementById('t-sec').value, document.getElementById('t-cs').value);
            if (!distance || distance <= 0) { Toast.show('请选择或输入距离'); return; }
            if (t <= 0) { Toast.show('请输入有效的用时'); return; }
            const newRecord = { id: Utils.uid(), stroke, distance, timeMs: t, category: 'swim', count: 0, type: 'training', eventName: '', note: '', date: document.getElementById('record-date').value, createdAt: Date.now() };
            newRecord.earnedPoints = pointsForRecord(newRecord); this.commit(newRecord, '游泳');
        } else if (this.selectedCategory === 'run') {
            let distance = this.runResultDist || 0;
            const fb = document.getElementById('run-distance-fallback').value;
            if (!distance && fb) distance = parseInt(fb) || 0;
            if (!distance || distance <= 0) { Toast.show('请先开始 GPS 记录，或在下方手动填写距离'); return; }
            const t = Utils.timeToMs(document.getElementById('run-time').value);
            const newRecord = { id: Utils.uid(), stroke: '跑步', distance, timeMs: t, category: 'run', count: 0, type: 'training', eventName: '', note: '', date: document.getElementById('record-date').value, createdAt: Date.now(), route: this.runRoute };
            newRecord.earnedPoints = pointsForRecord(newRecord); this.commit(newRecord, '跑步');
        }
    },
    commit(newRecord, label) {
        // 编辑态：更新原记录，不能新增，否则一编辑就多出一条重复数据
        if (this.editingId) {
            const id = this.editingId;
            const patch = { ...newRecord }; delete patch.id; delete patch.createdAt;
            Store.updateRecord(id, patch);
            this.editingId = null; Router.editingId = null;
            scheduleCloudSync();
            Toast.show(label + '已更新！', { type: 'success', sub: `积分调整为 ${newRecord.earnedPoints}` });
            document.getElementById('record-page-title').textContent = '记录成绩';
            this.clearInputs();
            if (Router.prevView && Router.prevView !== 'record') { Router.navigate(Router.prevView); return; }
            if (Router.current === 'home') PageHome.render();
            this.renderRecent();
            return;
        }
        Store.addRecord(newRecord); scheduleCloudSync();
        let sub = `获得 ${newRecord.earnedPoints} 积分`;
        if (newRecord.category !== 'rope') {
            const all = Store.getRecords();
            const same = all.filter(r => r.category === newRecord.category && r.stroke === newRecord.stroke && r.distance === newRecord.distance && r.id !== newRecord.id);
            const prevBest = same.length ? Math.min(...same.map(r => r.timeMs)) : null;
            if (prevBest !== null && newRecord.timeMs > 0 && newRecord.timeMs < prevBest) { const diffT = Utils.msToTime(prevBest - newRecord.timeMs); sub = `比最佳快了 ${diffT.main}.${diffT.ms}，并获 ${newRecord.earnedPoints} 积分`; }
        }
        Toast.show(label + '已记录！', { type: 'success', sub });
        this.clearInputs();
        if (Router.current === 'home') PageHome.render();
        this.renderRecent();
    },
    // 清空本次输入，方便连续录入
    clearInputs() {
        const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        setVal('t-min', ''); setVal('t-sec', ''); setVal('t-cs', '');
        setVal('distance-custom', ''); setVal('run-time', '');
        setVal('rope-count-input', ''); setVal('run-distance-fallback', '');
        this.selectedStroke = null; this.runResultDist = 0; this.runRoute = null; this.resetRunUI();
    },
    /* ---- 跑步 GPS ---- */
    resetRunUI() {
        this.runPoints = []; this.runDistVal = 0; this.runResultDist = 0; this.runRoute = null;
        const path = document.getElementById('runRoute'); if (path) path.setAttribute('d', '');
        const pin = document.getElementById('gpsPin'); if (pin) { pin.style.left = '8%'; pin.style.top = '88%'; }
        document.getElementById('runDist').textContent = '0.00';
        document.getElementById('runState').textContent = '待开始';
        const btn = document.getElementById('runBtn'); if (btn) { btn.classList.remove('stop'); btn.textContent = '▶ 开始记录'; }
        document.getElementById('runFallback').style.display = 'none';
    },
    stopRun(silent) {
        if (this.runWatchId != null && navigator.geolocation) { try { navigator.geolocation.clearWatch(this.runWatchId); } catch (e) {} this.runWatchId = null; }
        this.runOn = false;
        if (!silent) { const btn = document.getElementById('runBtn'); if (btn) { btn.classList.remove('stop'); btn.textContent = '▶ 开始记录'; } }
    },
    toggleRun() {
        if (!this.runOn) {
            this.startRun();
        } else {
            this.stopRun();
            const total = this.runDistVal || this.runResultDist || 0;
            this.runResultDist = total;
            document.getElementById('runState').textContent = '已记录 ' + (total / 1000).toFixed(2) + ' km';
            Toast.show('本次跑步 ' + (total / 1000).toFixed(2) + ' km', { type: 'success' });
        }
    },
    startRun() {
        const btn = document.getElementById('runBtn');
        const state = document.getElementById('runState');
        const distEl = document.getElementById('runDist');
        this.runPoints = []; this.runDistVal = 0; this.runResultDist = 0; this.runRoute = null;
        document.getElementById('runFallback').style.display = 'none';
        if (!navigator.geolocation) { this.useRunFallback(); return; }
        state.textContent = '定位中…'; btn.classList.add('stop'); btn.textContent = '■ 结束记录'; this.runOn = true;
        try {
            this.runWatchId = navigator.geolocation.watchPosition(
                (pos) => {
                    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                    if (this.runPoints.length >= 1) {
                        const prev = this.runPoints[this.runPoints.length - 1];
                        this.runDistVal += haversine(prev, p);
                    }
                    this.runPoints.push(p);
                    this.drawRunTrack();
                    this.runResultDist = this.runDistVal;
                    distEl.textContent = (this.runDistVal / 1000).toFixed(2);
                    if (this.runDistVal > 1) state.textContent = '记录中…';
                },
                (err) => { this.stopRun(true); this.useRunFallback(); Toast.show('GPS 不可用，可手动填写距离'); },
                { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
            );
        } catch (e) { this.useRunFallback(); }
    },
    useRunFallback() {
        this.runOn = false;
        const btn = document.getElementById('runBtn'); if (btn) { btn.classList.remove('stop'); btn.textContent = '▶ 开始记录'; }
        document.getElementById('runState').textContent = '手动模式';
        document.getElementById('runFallback').style.display = '';
    },
    drawRunTrack() {
        if (this.runPoints.length < 1) return;
        const pts = this.runPoints;
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        pts.forEach(p => { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng); });
        const W = 320, H = 200, pad = 24;
        const spanLat = (maxLat - minLat) || 1e-6, spanLng = (maxLng - minLng) || 1e-6;
        const toXY = (p) => {
            let x = pad + (p.lng - minLng) / spanLng * (W - 2 * pad);
            let y = pad + (maxLat - p.lat) / spanLat * (H - 2 * pad); // 纬度越大越靠上
            if (pts.length === 1) { x = W / 2; y = H / 2; }
            return [x, y];
        };
        const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + toXY(p)[0].toFixed(1) + ',' + toXY(p)[1].toFixed(1)).join(' ');
        const path = document.getElementById('runRoute'); path.setAttribute('d', d); path.classList.add('show');
        const last = toXY(pts[pts.length - 1]);
        const pin = document.getElementById('gpsPin'); pin.style.left = (last[0] / W * 100) + '%'; pin.style.top = (last[1] / H * 100) + '%';
        // 保存归一化路线供分析页使用
        this.runRoute = pts.map(p => toXY(p));
    },
    /* ---- 跳绳：摄像头 + 5秒准备 + 计时/目标 ---- */
    setRopeMode(m) {
        this.ropeMode = m;
        document.querySelectorAll('#rope-seg button').forEach(b => b.classList.toggle('active', b.dataset.rm === m));
        document.getElementById('ropeCountTarget').style.display = (m === 'count') ? '' : 'none';
        // 手动 +1 按钮在计时过程中统一作为「自动计数不可用时的兜底」，不再按模式隐藏
        if (!this.ropeRunning) document.getElementById('ropeCountBtn').style.display = 'none';
    },
    resetRopeUI() {
        document.getElementById('ropeStartBtn').textContent = '开始跳绳（开启摄像头）';
        document.getElementById('ropeStartBtn').onclick = () => this.startRope();
        document.getElementById('ropeStartBtn').disabled = false;
        document.getElementById('ropeTimer').textContent = '00:00';
        document.getElementById('ropeTimerSub').textContent = '准备开始';
        document.getElementById('ropeStatus').style.display = 'none';
        document.getElementById('ropePh').style.display = '';
        document.getElementById('ropeCount').classList.remove('show');
        document.getElementById('ropeCountBtn').style.display = 'none';
        this.exitRopeFullscreen();
    },
    resetRope(silent) { this.stopRopeStream(); this.ropeRunning = false; this.ropeDone = false; this.ropeCount = 0; if (!silent) this.resetRopeUI(); },
    stopRopeStream() { if (this.ropeStream) { this.ropeStream.getTracks().forEach(t => t.stop()); this.ropeStream = null; } },
    startRope() {
        if (this.ropeMode === 'count') this.ropeLimit = parseInt(document.getElementById('ropeTargetInput').value) || 100;
        else this.ropeLimit = parseInt(this.ropeMode) * 60;
        // 点开始后请求全屏（用户手势内触发，浏览器允许授权）；失败则忽略，不影响计时
        this.requestRopeFullscreen();
        const ph = document.getElementById('ropePh'), status = document.getElementById('ropeStatus');
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 720 }, height: { ideal: 1280 } }, audio: false }).then(stream => {
                this.ropeStream = stream; const v = document.getElementById('ropeVideo'); v.srcObject = stream; ph.style.display = 'none'; status.style.display = 'block';
                RopePose.init(v, () => this.onRopeAutoCount()); // 初始化姿态检测用于「脚落地自动计数」
            }).catch(() => { ph.innerHTML = '📷 摄像头不可用<br>仍可计时（无画面）'; });
        } else { ph.innerHTML = '📷 摄像头不可用<br>仍可计时（无画面）'; }
        const btn = document.getElementById('ropeStartBtn'); btn.disabled = true; btn.textContent = '准备中…';
        const ov = document.getElementById('ropeCount'), num = document.getElementById('ropeCountNum'); ov.classList.add('show');
        let c = 5;
        const cd = setInterval(() => {
            c--; num.textContent = c;
            if (c <= 0) { clearInterval(cd); ov.classList.remove('show'); this.beginRopeTiming(); btn.disabled = false; btn.textContent = '■ 结束'; btn.onclick = () => this.finishRope(); }
        }, 1000);
    },
    beginRopeTiming() {
        this.ropeRunning = true; this.ropeDone = false; this.ropeCount = 0; this.ropeStartTs = Date.now();
        document.getElementById('ropeTimerSub').textContent = (this.ropeMode === 'count') ? ('目标 ' + this.ropeLimit + ' 个') : ('目标 ' + fmt(this.ropeLimit));
        // 显示手动兜底按钮（自动计数不可用时点击 +1）
        const mbtn = document.getElementById('ropeCountBtn'); mbtn.style.display = ''; mbtn.textContent = '👆 手动 +1（自动计数异常时用）';
        // 启动姿态检测自动计数（MediaPipe 可用时）
        RopePose.start();
        this.ropeTimerID = setInterval(() => {
            const el = (Date.now() - this.ropeStartTs) / 1000;
            if (this.ropeMode === 'count') {
                document.getElementById('ropeTimer').textContent = this.ropeCount + '';
                if (this.ropeCount >= this.ropeLimit) this.finishRope();
            } else {
                document.getElementById('ropeTimer').textContent = fmt(el);
                // 计时模式也展示实时自动计数
                document.getElementById('ropeTimerSub').textContent = '目标 ' + fmt(this.ropeLimit) + ' · 已跳 ' + this.ropeCount + ' 个';
                if (el >= this.ropeLimit) this.finishRope();
            }
        }, 200);
    },
    ropeTap() {
        if (!this.ropeRunning) return;
        this.ropeCount++;
        if (this.ropeMode === 'count') document.getElementById('ropeTimer').textContent = this.ropeCount + '';
        else document.getElementById('ropeTimerSub').textContent = '目标 ' + fmt(this.ropeLimit) + ' · 已跳 ' + this.ropeCount + ' 个';
    },
    // MediaPipe 自动识别到「脚落地」时回调
    onRopeAutoCount() {
        if (!this.ropeRunning) return;
        this.ropeCount++;
        if (this.ropeMode === 'count') document.getElementById('ropeTimer').textContent = this.ropeCount + '';
        else document.getElementById('ropeTimerSub').textContent = '目标 ' + fmt(this.ropeLimit) + ' · 已跳 ' + this.ropeCount + ' 个';
    },
    requestRopeFullscreen() {
        const el = document.getElementById('ropeModule');
        const fn = el && (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen);
        if (fn) { try { (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen).call(el); } catch (e) {} }
    },
    exitRopeFullscreen() {
        const fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
        if (fn && (document.fullscreenElement || document.webkitFullscreenElement)) { try { fn.call(document); } catch (e) {} }
    },
    finishRope() {
        if (!this.ropeRunning && this.ropeDone) return;
        this.ropeRunning = false; this.ropeDone = true; clearInterval(this.ropeTimerID);
        RopePose.stop(); this.exitRopeFullscreen();
        document.getElementById('ropeStatus').style.display = 'none'; this.stopRopeStream();
        const res = (this.ropeMode === 'count') ? (this.ropeCount + ' 个') : (fmt((Date.now() - this.ropeStartTs) / 1000));
        document.getElementById('ropeTimerSub').textContent = '完成！本次 ' + res;
        const btn = document.getElementById('ropeStartBtn'); btn.textContent = '✓ 保存记录（' + res + '）'; btn.onclick = () => this.saveRope();
        Toast.show('🤾 跳绳完成 · ' + res);
    },
    saveRope() {
        const res = (this.ropeMode === 'count') ? (this.ropeCount + ' 个') : (fmt((Date.now() - this.ropeStartTs) / 1000));
        const elapsedMs = (Date.now() - this.ropeStartTs);
        const newRecord = { id: Utils.uid(), stroke: '跳绳', count: this.ropeCount, timeMs: elapsedMs, category: 'rope', distance: 0, type: 'training', eventName: '', note: '', date: document.getElementById('record-date').value, createdAt: Date.now() };
        newRecord.earnedPoints = pointsForRecord(newRecord);
        this.commit(newRecord, '跳绳');
        this.resetRopeUI();
    },
    renderRecent() {
        const wrap = document.getElementById('record-recent'); if (!wrap) return;
        const list = Store.getRecords().slice().sort((a, b) => b.date === a.date ? (b.createdAt || 0) - (a.createdAt || 0) : b.date.localeCompare(a.date)).slice(0, 5);
        if (list.length === 0) { wrap.style.display = 'none'; return; }
        wrap.style.display = '';
        const container = document.getElementById('record-recent-list');
        const STROKE_ORDER = { '自由泳': 0, '蛙泳': 1, '仰泳': 2, '蝶泳': 3, '混合泳': 4 };
        list.sort((a, b) => { const so = (STROKE_ORDER[a.stroke] ?? 99) - (STROKE_ORDER[b.stroke] ?? 99); if (so !== 0) return so; if (a.distance !== b.distance) return a.distance - b.distance; if (b.date !== a.date) return b.date.localeCompare(a.date); return b.createdAt - a.createdAt; });
        container.innerHTML = list.map(r => {
            const sc = Utils.strokeColor(r.stroke);
            const ti = Utils.typeInfo(r.type);
            let detailText = (r.category === 'rope') ? `<strong>${esc(sc.emoji)}${esc(r.stroke)}</strong> · ${r.count} 次` : `<strong>${esc(sc.emoji)}${esc(r.stroke)}</strong> · ${r.distance >= 1000 ? (r.distance / 1000).toFixed(1) + 'km' : r.distance + '米'}`;
            let timeText = '';
            if (r.timeMs > 0) { const t = Utils.msToTime(r.timeMs); timeText = `${t.main}<span class="ms-part">.${t.ms}</span>`; }
            return `<div class="history-item" data-id="${r.id}">
                <div style="width:28px;"></div>
                <div class="history-stroke" style="background:${sc.bg};color:${sc.color}">${sc.emoji}</div>
                <div class="history-info"><div class="history-date">${Utils.formatDate(r.date)}</div><div class="history-detail">${detailText}</div></div>
                <div class="history-time">${timeText}</div>
                <svg class="history-arrow" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
            </div>`;
        }).join('');
        container.querySelectorAll('.history-item').forEach(item => item.addEventListener('click', () => ModalDetail.show(item.dataset.id)));
    }
};
function haversine(a, b) {
    const R = 6371000, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}
function fmt(s) { const m = Math.floor(s / 60), ss = Math.floor(s % 60); return (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss; }

/* ==================== 跳绳：脚落地自动计数（MediaPipe Pose） ==================== */
/* 原理：取双脚踝 landmarks 的竖直坐标（归一化 0=顶部 1=底部），做平滑后检测
   一次「起跳→落地」周期：脚离地上升(vel<0) → 顶点 → 下落(vel>0) → 触地(vel 由正转负)
   在 vel 由正转负的瞬间计 1 次（带 300ms 不应期，避免抖动误判）。
   MediaPipe 脚本由 index.html 以 defer 加载，CDN 不可达时 Pose 为 undefined，自动回退手动计数。 */
const RopePose = {
    pose: null, video: null, running: false, raf: null, ready: false,
    prevY: null, prevVel: 0, airborne: false, lastCountTs: 0, ema: null, onCount: null,
    init(video, onCount) {
        this.video = video; this.onCount = onCount;
        if (typeof Pose === 'undefined') { console.warn('[RopePose] MediaPipe Pose 未加载，自动计数不可用，回退手动'); return; }
        try {
            this.pose = new Pose({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5/${f}` });
            this.pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
            this.pose.onResults((res) => this.onResults(res));
            this.ready = true;
        } catch (e) { console.warn('[RopePose] 初始化失败，回退手动', e); }
    },
    start() {
        if (!this.ready) return;
        this.running = true; this.prevY = null; this.prevVel = 0; this.airborne = false; this.lastCountTs = 0; this.ema = null;
        this.pump();
    },
    pump() {
        if (!this.running) return;
        const v = this.video;
        if (v && v.readyState >= 2) { this.pose.send({ image: v }).catch(() => {}); }
        this.raf = requestAnimationFrame(() => this.pump());
    },
    onResults(res) {
        if (!this.running) return;
        const lm = res.poseLandmarks;
        if (!lm || lm.length < 29) return;
        const lA = lm[27], rA = lm[28]; // 左/右踝
        if (!lA || !rA || (lA.visibility != null && (lA.visibility < 0.3 || rA.visibility < 0.3))) return;
        const y = (lA.y + rA.y) / 2; // 0 顶部 .. 1 底部
        if (this.ema == null) this.ema = y; else this.ema = this.ema * 0.8 + y * 0.2; // 平滑
        if (this.prevY != null) {
            const vel = this.ema - this.prevY; // >0 脚在下落
            if (vel < -0.002) this.airborne = true; // 脚在上升 => 离地过
            // 落地瞬间：此前在下落(vel>0) 且 此刻转为上升(vel<=0)，并确曾离地
            if (this.airborne && this.prevVel > 0.002 && vel <= 0) {
                const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                if (now - this.lastCountTs > 300) { this.lastCountTs = now; this.airborne = false; if (this.onCount) this.onCount(); }
            }
            this.prevVel = vel;
        }
        this.prevY = this.ema;
    },
    stop() { this.running = false; if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }
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
        const STROKE_ORDER = { '自由泳': 0, '蛙泳': 1, '仰泳': 2, '蝶泳': 3, '混合泳': 4 };
        filtered.sort((a, b) => {
            const so = (STROKE_ORDER[a.stroke] ?? 99) - (STROKE_ORDER[b.stroke] ?? 99);
            if (so !== 0) return so; if (a.distance !== b.distance) return a.distance - b.distance;
            if (b.date !== a.date) return b.date.localeCompare(a.date); return b.createdAt - a.createdAt;
        });
        document.getElementById('history-count').textContent = `共 ${filtered.length} 条记录`;
        const container = document.getElementById('history-list');
        if (filtered.length === 0) {
            container.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#cbd5e1" stroke-width="1.5"><path d="M9 11l3 3 8-8M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg><p>暂无记录</p><button class="empty-action" id="history-empty-add">＋ 去记录第一条成绩</button></div>`;
            const a = document.getElementById('history-empty-add'); if (a) a.addEventListener('click', () => Router.navigate('record')); return;
        }
        const bestMap = {};
        records.forEach(r => { const key = `${r.stroke}-${r.distance}-${r.type || 'training'}`; if (!bestMap[key] || r.timeMs < bestMap[key].timeMs) bestMap[key] = r; });
        container.innerHTML = filtered.map(r => {
            const sc = Utils.strokeColor(r.stroke); const isPB = bestMap[`${r.stroke}-${r.distance}-${r.type || 'training'}`]?.id === r.id; const ti = Utils.typeInfo(r.type);
            let detailText = (r.category === 'rope') ? `<strong>${esc(sc.emoji)}${esc(r.stroke)}</strong> · ${r.count} 次` : `<strong>${esc(sc.emoji)}${esc(r.stroke)}</strong> · ${r.distance >= 1000 ? (r.distance / 1000).toFixed(1) + 'km' : r.distance + '米'}`;
            let timeText = ''; if (r.timeMs > 0) { const t = Utils.msToTime(r.timeMs); timeText = `${t.main}<span class="ms-part">.${t.ms}</span>`; }
            return `<div class="history-item ${isPB ? 'history-item-pb' : ''}" data-id="${r.id}">
                ${isPB ? `<div class="history-trophy"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19 5h-2V3H7v2H5a2 2 0 00-2 2v3a4 4 0 003.5 3.97V18a2 2 0 002 2h2v1h4v-1h2a2 2 0 002-2v-4.03A4 4 0 0021 10V7a2 2 0 00-2-2zM5 10V7h2v5.83A2 2 0 015 10zm14 0a2 2 0 01-2 2.83V7h2v3z"/></svg></div>` : '<div style="width:28px;"></div>'}
                <div class="history-stroke" style="background:${sc.bg};color:${sc.color}">${sc.emoji}</div>
                <div class="history-info"><div class="history-date">${Utils.formatDate(r.date)}</div><div class="history-detail">${detailText}</div><div class="history-tags"><span class="record-type-badge type-${r.type || 'training'}">${ti.emoji}${ti.short}</span></div></div>
                <div class="history-time">${timeText}</div>
                <svg class="history-arrow" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
            </div>`;
        }).join('');
        container.querySelectorAll('.history-item').forEach(item => item.addEventListener('click', () => ModalDetail.show(item.dataset.id)));
    }
};

/* ==================== 页面：成绩分析（按项目分开展示） ==================== */
const PageAnalysis = {
    currentProj: 'swim',
    currentPeriod: 'all', // 默认展示全部数据，避免用户以为记录没被统计到
    currentSwimStroke: 'all',
    currentSwimDist: 'all',
    runChart: null, ropeChart: null,
    setProj(p) {
        this.currentProj = p;
        document.querySelectorAll('#proj-seg button').forEach(b => b.classList.toggle('active', b.dataset.proj === p));
        document.querySelectorAll('#analysis-view .an-content').forEach(c => c.classList.remove('show'));
        document.getElementById('an-' + p).classList.add('show');
        this.render();
    },
    setPeriod(p) {
        this.currentPeriod = p;
        document.querySelectorAll('#an-period-toggle button').forEach(b => b.classList.toggle('active', b.dataset.period === p));
        this.render();
    },
    setSwimStroke(s) {
        this.currentSwimStroke = s;
        document.querySelectorAll('#an-swim-stroke-seg button').forEach(b => b.classList.toggle('active', b.dataset.sw === s));
        // 切换泳姿后，可用距离随该泳姿的记录动态变化；保留当前距离选择（若仍有效），否则回退到「全部距离」
        this.populateSwimDistSeg();
        this.renderSwim();
    },
    setSwimDist(d) {
        this.currentSwimDist = d;
        document.querySelectorAll('#an-swim-dist-seg button').forEach(b => b.classList.toggle('active', String(b.dataset.dist) === String(d)));
        this.renderSwim();
    },
    // 根据当前选中泳姿的记录，动态生成「距离」选项（每个泳姿只展示它实际游过的距离）
    populateSwimDistSeg() {
        const all = this._swimBase();
        const stroke = this.currentSwimStroke;
        const pool = stroke === 'all' ? all : all.filter(r => r.stroke === stroke);
        const dists = Array.from(new Set(pool.map(r => Math.round(r.distance)))).sort((a, b) => a - b);
        const seg = document.getElementById('an-swim-dist-seg');
        if (!seg) return;
        const cur = this.currentSwimDist;
        const active = (cur === 'all' || dists.includes(Number(cur))) ? cur : 'all';
        this.currentSwimDist = active;
        let html = `<button class="${active === 'all' ? 'active' : ''}" data-dist="all">全部距离</button>`;
        html += dists.map(d => `<button class="${String(d) === String(active) ? 'active' : ''}" data-dist="${d}" title="${d} 米">${d}m</button>`).join('');
        seg.innerHTML = html;
        seg.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => this.setSwimDist(btn.dataset.dist)));
    },
    filterByPeriod(records) {
        if (this.currentPeriod === 'all') return records.slice(); // 全部：不做时间裁剪
        const now = new Date();
        let from = new Date(0);
        if (this.currentPeriod === 'week') from = new Date(now.getTime() - 7 * 86400000);
        else if (this.currentPeriod === 'month') from = new Date(now.getTime() - 30 * 86400000);
        else if (this.currentPeriod === 'year') from = new Date(now.getTime() - 365 * 86400000);
        const fromStr = Utils.localDateStr(from); // 本地时区，避免边界日被误裁掉
        return records.filter(r => r.date >= fromStr);
    },
    periodLabel() { return this.currentPeriod === 'all' ? '全部' : this.currentPeriod === 'week' ? '近 7 天' : this.currentPeriod === 'month' ? '近 30 天' : '近 1 年'; },
    render() {
        if (this.currentProj === 'swim') this.renderSwim();
        else if (this.currentProj === 'run') this.renderRun();
        else this.renderRope();
    },
    _swimBase() {
        return Store.getRecords().filter(r => r.category === 'swim' && r.distance > 0 && r.timeMs > 0 && r.stroke);
    },
    renderSwim() {
        this.populateSwimDistSeg();
        const all = this._swimBase();
        // 距离维度：currentSwimDist==='all' 表示不限距离，否则只取等于该距离的记录
        const distFilter = r => this.currentSwimDist === 'all' ? true : Math.round(r.distance) === Number(this.currentSwimDist);
        const allF = all.filter(distFilter);
        const records = this.filterByPeriod(allF);
        const strokesAll = ['自由泳', '蛙泳', '仰泳', '蝶泳', '混合泳'];
        const colors = { '自由泳': '#7fe0ff', '蛙泳': '#ffd166', '仰泳': '#c39bff', '蝶泳': '#ff8fab', '混合泳': '#ffa94d' };
        // 当前选中的泳姿（全部 or 单泳姿）
        const sel = this.currentSwimStroke;
        const activeStrokes = sel === 'all' ? strokesAll : [sel];
        const series = {}; const counts = {};
        activeStrokes.forEach(s => {
            const rs = allF.filter(r => r.stroke === s).sort((a, b) => a.date === b.date ? (a.createdAt || 0) - (b.createdAt || 0) : a.date.localeCompare(b.date));
            series[s] = rs.map(r => ({ t: new Date(r.date + 'T00:00:00').getTime(), pace: r.timeMs / r.distance * 100 }));
            counts[s] = rs.length;
        });
        // 进退步率基于「周期内的记录」计算
        const periodSeries = {};
        activeStrokes.forEach(s => {
            periodSeries[s] = records.filter(r => r.stroke === s).sort((a, b) => a.date === b.date ? (a.createdAt || 0) - (b.createdAt || 0) : a.date.localeCompare(b.date)).map(r => r.timeMs / r.distance * 100);
        });
        const allPaces = []; activeStrokes.forEach(s => series[s].forEach(p => allPaces.push(p.pace)));
        if (allPaces.length === 0) { document.getElementById('a-swim-summary').textContent = this.periodLabel() + ' · 暂无游泳记录'; document.getElementById('a-swim-line').innerHTML = '<div style="color:#8b93c7;font-size:12px;padding:20px 0;text-align:center">记录游泳成绩后，这里会按时间展示各泳姿进步折线图</div>'; document.getElementById('a-swim-legend').innerHTML = ''; document.getElementById('a-swim-rates').innerHTML = ''; document.getElementById('a-swim-stats').innerHTML = ''; document.getElementById('a-swim-dist').innerHTML = ''; return; }
        // y 轴 = 每100m配速(秒)
        let yMin = Math.min(...allPaces), yMax = Math.max(...allPaces); const ypad = (yMax - yMin) * 0.15 || 10; yMin = Math.max(0, yMin - ypad); yMax = yMax + ypad;
        // x 轴 = 时间（按最早/最晚日期横向铺开）
        let tMin = Infinity, tMax = -Infinity;
        activeStrokes.forEach(s => series[s].forEach(p => { if (p.t < tMin) tMin = p.t; if (p.t > tMax) tMax = p.t; }));
        if (tMax - tMin < 86400000) { const mid = (tMin + tMax) / 2; tMin = mid - 43200000; tMax = mid + 43200000; }
        const L = 30, R = 312, T = 10, B = 150, W = 320, H = 162;
        const xAt = t => L + (tMax === tMin ? 0.5 : (t - tMin) / (tMax - tMin)) * (R - L);
        const yAt = v => T + (v - yMin) / (yMax - yMin) * (B - T);
        let svg = `<svg width="100%" height="160" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
        // 横向网格 + 日期刻度
        const ticks = 3;
        for (let i = 0; i <= ticks; i++) {
            const t = tMin + (tMax - tMin) * i / ticks;
            const x = xAt(t);
            const dt = new Date(t);
            const label = (dt.getMonth() + 1) + '/' + dt.getDate();
            svg += `<line x1="${x.toFixed(1)}" y1="${T}" x2="${x.toFixed(1)}" y2="${B}" stroke="rgba(255,255,255,.06)"/><text x="${x.toFixed(1)}" y="${B + 14}" fill="rgba(205,211,240,.55)" font-size="9" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}">${label}</text>`;
        }
        [Math.ceil(yMin / 20) * 20, (yMin + yMax) / 2, Math.floor(yMax / 20) * 20].forEach(v => { const y = yAt(v); svg += `<line x1="${L}" y1="${y.toFixed(1)}" x2="${R}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.08)"/><text x="${L - 4}" y="${(y + 3).toFixed(1)}" fill="rgba(205,211,240,.6)" font-size="9" text-anchor="end">${Math.round(v)}</text>`; });
        activeStrokes.forEach(s => {
            const d = series[s]; if (!d.length) return;
            const pts = d.map(p => `${xAt(p.t).toFixed(1)},${yAt(p.pace).toFixed(1)}`).join(' ');
            svg += `<polyline points="${pts}" fill="none" stroke="${colors[s]}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity=".95"/>`;
            d.forEach(p => { svg += `<circle cx="${xAt(p.t).toFixed(1)}" cy="${yAt(p.pace).toFixed(1)}" r="2.6" fill="${colors[s]}"/>`; });
        });
        svg += '</svg>';
        document.getElementById('a-swim-line').innerHTML = svg;
        document.getElementById('a-swim-legend').innerHTML = activeStrokes.filter(s => series[s].length).map(s => `<span class="lg"><i style="background:${colors[s]}"></i>${s}</span>`).join('');
        // 进退步率（基于周期内记录的前半段 vs 后半段）
        let up = 0, down = 0, rows = '';
        activeStrokes.forEach(s => {
            const d = periodSeries[s]; if (d.length < 2) return;
            const half = Math.floor(d.length / 2);
            const ea = d.slice(0, half).reduce((a, b) => a + b, 0) / half;
            const la = d.slice(half).reduce((a, b) => a + b, 0) / (d.length - half);
            const rate = (ea - la) / ea * 100; const improving = rate >= 0;
            if (improving) up++; else down++;
            rows += `<div class="rate-row"><span class="rdot" style="background:${colors[s]}"></span><div class="rinfo"><div class="rn">${s}</div><div class="rs">每100m ${ea.toFixed(1)}→${la.toFixed(1)}s</div></div><div class="rv ${improving ? 'up' : 'down'}">${improving ? '▲ 进步' : '▼ 退步'} ${Math.abs(rate).toFixed(1)}%</div></div>`;
        });
        document.getElementById('a-swim-rates').innerHTML = rows;
        const totalTrain = activeStrokes.reduce((s, k) => s + series[k].length, 0);
        const distLabel = this.currentSwimDist === 'all' ? '全部距离' : (this.currentSwimDist + 'm');
        document.getElementById('a-swim-summary').textContent = `${sel === 'all' ? '全部泳姿' : sel} · ${distLabel} · ${this.periodLabel()} · ${totalTrain} 次训练 · ${up} 项进步 ${down} 项退步`;
        // 统计
        const recAll = allF.filter(r => sel === 'all' || r.stroke === sel);
        const totalCount = recAll.length;
        const totalDist = recAll.reduce((s, r) => s + r.distance, 0);
        const totalTime = recAll.reduce((s, r) => s + r.timeMs, 0);
        let best = null; recAll.forEach(r => { if (!best || r.timeMs < best) best = r.timeMs; });
        document.getElementById('a-swim-stats').innerHTML = `
            <div class="an-stat"><div class="k">总次数</div><div class="v">${totalCount}<span>次</span></div></div>
            <div class="an-stat"><div class="k">总距离</div><div class="v">${Utils.mToKm(totalDist)}<span>km</span></div></div>
            <div class="an-stat"><div class="k">总时长</div><div class="v">${Utils.msToHours(totalTime)}<span>h</span></div></div>
            <div class="an-stat"><div class="k">最佳单程</div><div class="v">${best != null ? Utils.msToTime(best).main : '—'}</div></div>`;
        // 泳姿分布
        const maxC = Math.max(1, ...strokesAll.map(s => counts[s] || 0));
        document.getElementById('a-swim-dist').innerHTML = strokesAll.map(s => `<div class="bar"><div class="bn">${s}</div><div class="bt"><div class="bf" style="width:${((counts[s] || 0) / maxC * 100).toFixed(0)}%;background:linear-gradient(90deg,${colors[s]},${colors[s]})"></div></div><div class="bv">${counts[s] || 0} 次</div></div>`).join('');
    },
    renderRun() {
        const records = this.filterByPeriod(Store.getRecords().filter(r => r.category === 'run' && r.distance > 0)).sort((a, b) => a.date === b.date ? (a.createdAt || 0) - (b.createdAt || 0) : a.date.localeCompare(b.date));
        const totalDist = records.reduce((s, r) => s + r.distance, 0);
        document.getElementById('a-run-total').textContent = Utils.mToKm(totalDist) + ' km';
        if (records.length === 0) { document.getElementById('a-run-sub').textContent = this.periodLabel() + ' · 暂无跑步记录'; this._emptyRun(); return; }
        document.getElementById('a-run-sub').textContent = `${this.periodLabel()} · 共 ${records.length} 次 · 最佳配速 ${this.bestPace(records)}/km`;
        // 折线图（距离趋势）
        const labels = records.map(r => Utils.formatDateShort(r.date));
        const data = records.map(r => r.distance / 1000);
        this._lineChart('a-run-chart', 'runChart', labels, data, '#5fe3b0', 'km');
        // 统计
        const bestPace = this.bestPace(records);
        const longest = Math.max(...records.map(r => r.distance));
        document.getElementById('a-run-stats').innerHTML = `
            <div class="an-stat"><div class="k">总次数</div><div class="v">${records.length}<span>次</span></div></div>
            <div class="an-stat"><div class="k">总距离</div><div class="v">${Utils.mToKm(totalDist)}<span>km</span></div></div>
            <div class="an-stat"><div class="k">最佳配速</div><div class="v">${bestPace}<span>/km</span></div></div>
            <div class="an-stat"><div class="k">最长单次</div><div class="v">${Utils.mToKm(longest)}<span>km</span></div></div>`;
        // 近 6 次距离
        const recent = records.slice(-6); const maxD = Math.max(1, ...recent.map(r => r.distance));
        document.getElementById('a-run-bars').innerHTML = recent.map(r => `<div class="bar"><div class="bn">${Utils.formatDateShort(r.date)}</div><div class="bt"><div class="bf" style="width:${(r.distance / maxD * 100).toFixed(0)}%;background:linear-gradient(90deg,#12b886,#5fe3b0)"></div></div><div class="bv">${Utils.mToKm(r.distance)} km</div></div>`).join('');
        // 最近路线
        const withRoute = records.filter(r => r.route && r.route.length).pop();
        const path = document.getElementById('a-run-route'); const pin = document.getElementById('a-run-pin');
        if (withRoute) {
            path.setAttribute('d', withRoute.route.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')); path.classList.add('show');
            const last = withRoute.route[withRoute.route.length - 1];
            pin.style.left = (last[0] / 320 * 100) + '%'; pin.style.top = (last[1] / 200 * 100) + '%';
            document.getElementById('a-run-route-dist').textContent = Utils.mToKm(withRoute.distance);
            document.getElementById('a-run-route-sub').textContent = Utils.formatDate(withRoute.date);
        } else { path.setAttribute('d', ''); path.classList.remove('show'); document.getElementById('a-run-route-dist').textContent = '0.00'; document.getElementById('a-run-route-sub').textContent = '暂无路线（GPS 记录后显示）'; }
    },
    bestPace(records) {
        let best = null;
        records.forEach(r => { if (r.distance > 0 && r.timeMs > 0) { const p = r.timeMs / r.distance * 1000; if (!best || p < best) best = p; } });
        if (!best) return '—';
        const sec = Math.round(best); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    },
    _lineChart(canvasId, key, labels, data, color, unit) {
        const el = document.getElementById(canvasId); if (!el) return;
        if (this[key]) this[key].destroy();
        const ctx = el.getContext('2d');
        this[key] = new Chart(ctx, {
            type: 'line',
            data: { labels, datasets: [{ data, borderColor: color, borderWidth: 2.5, fill: true, backgroundColor: (c) => { const a = c.chart.chartArea; if (!a) return null; const g = c.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom); g.addColorStop(0, color + '33'); g.addColorStop(1, color + '05'); return g; }, tension: 0.3, pointBackgroundColor: color, pointBorderColor: '#fff', pointBorderWidth: 2, pointRadius: 4, pointHoverRadius: 6 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.raw + ' ' + unit } } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#94a3b8' } }, y: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 }, color: '#94a3b8' } } } }
        });
    },
    _emptyRun() {
        const c = document.getElementById('a-run-chart'); if (c && this.runChart) { this.runChart.destroy(); this.runChart = null; }
        document.getElementById('a-run-stats').innerHTML = ''; document.getElementById('a-run-bars').innerHTML = '';
        document.getElementById('a-run-route').setAttribute('d', ''); document.getElementById('a-run-route').classList.remove('show');
        document.getElementById('a-run-route-dist').textContent = '0.00'; document.getElementById('a-run-route-sub').textContent = '暂无路线';
    },
    renderRope() {
        const records = this.filterByPeriod(Store.getRecords().filter(r => r.category === 'rope' && r.count > 0)).sort((a, b) => a.date === b.date ? (a.createdAt || 0) - (b.createdAt || 0) : a.date.localeCompare(b.date));
        const totalCount = records.reduce((s, r) => s + (r.count || 0), 0);
        document.getElementById('a-rope-total').textContent = totalCount + ' 次';
        if (records.length === 0) { document.getElementById('a-rope-sub').textContent = this.periodLabel() + ' · 暂无跳绳记录'; this._emptyRope(); return; }
        const best = Math.max(...records.map(r => r.count || 0));
        document.getElementById('a-rope-sub').textContent = `${this.periodLabel()} · 共 ${records.length} 次 · 最佳 ${best} 次`;
        const labels = records.map(r => Utils.formatDateShort(r.date));
        const data = records.map(r => r.count || 0);
        this._lineChart('a-rope-chart', 'ropeChart', labels, data, '#c084fc', '次');
        const kcal = Math.round(totalCount * 0.12);
        document.getElementById('a-rope-stats').innerHTML = `
            <div class="an-stat"><div class="k">总次数</div><div class="v">${records.length}<span>次</span></div></div>
            <div class="an-stat"><div class="k">累计次数</div><div class="v">${totalCount}</div></div>
            <div class="an-stat"><div class="k">最佳单次</div><div class="v">${best}<span>次</span></div></div>
            <div class="an-stat"><div class="k">消耗</div><div class="v">~${kcal}<span>kcal</span></div></div>`;
        const recent = records.slice(-7); const maxC = Math.max(1, ...recent.map(r => r.count || 0));
        document.getElementById('a-rope-bars').innerHTML = recent.map(r => `<div class="bar"><div class="bn">${Utils.formatDateShort(r.date)}</div><div class="bt"><div class="bf" style="width:${(r.count / maxC * 100).toFixed(0)}%;background:linear-gradient(90deg,#8b5cf6,#c084fc)"></div></div><div class="bv">${r.count} 次</div></div>`).join('');
    },
    _emptyRope() {
        const c = document.getElementById('a-rope-chart'); if (c && this.ropeChart) { this.ropeChart.destroy(); this.ropeChart = null; }
        document.getElementById('a-rope-stats').innerHTML = ''; document.getElementById('a-rope-bars').innerHTML = '';
    }
};

/* ==================== 页面：积分盲盒 ==================== */
const PageBlindbox = {
    render() {
        const points = Store.getPoints();
        document.getElementById('bb-points').textContent = points;
        const boxes = document.getElementById('bb-grid');
        const collected = Store.getBlindBoxes();
        let html = '';
        for (let i = 0; i < 9; i++) {
            if (i < collected.length) {
                const it = collected[i];
                html += `<div class="box opened" title="${esc(it.name)}"><div class="emo">${esc(it.icon)}</div><span class="tag">${esc(it.label)}</span></div>`;
            } else {
                html += `<div class="box" data-draw="1"><div class="shine"></div><div class="emo">🎁</div><span class="tag">待开启</span></div>`;
            }
        }
        boxes.innerHTML = html;
        boxes.querySelectorAll('.box[data-draw]').forEach(b => b.addEventListener('click', () => this.draw()));
        // 页面底部那颗“消耗 10 积分抽一次”按钮此前没有绑定过事件，点了没反应
        const drawBtn = document.getElementById('bb-draw');
        if (drawBtn && !drawBtn.dataset.bound) {
            drawBtn.dataset.bound = '1';
            drawBtn.addEventListener('click', () => this.draw());
        }
        if (drawBtn) {
            const enough = points >= 10;
            drawBtn.disabled = !enough;
            drawBtn.style.opacity = enough ? '' : '.55';
            drawBtn.textContent = enough ? '🎁 消耗 10 积分抽一次' : `🎁 积分不足（${points}/10）`;
        }
        // 荣誉墙
        const wall = document.getElementById('bb-wall');
        const items = collected.slice().sort((a, b) => b.createdAt - a.createdAt);
        if (items.length === 0) { wall.innerHTML = '<div style="color:var(--ink-faint);font-size:13px;padding:8px 0">抽中盲盒后会展示在这里 🏆</div>'; return; }
        const rkLabel = { common: '普通', classic: '经典', rare: '稀有', limited: '限定', collector: '典藏' };
        const rkClass = { common: 'normal', classic: 'normal', rare: 'rare', limited: 'limited', collector: 'limited' };
        wall.innerHTML = items.map(it => `<div class="wcard"><div class="em">${esc(it.icon)}</div><div class="nm">${esc(it.name)}</div><div class="rk ${rkClass[it.rarity] || 'normal'}">${esc(rkLabel[it.rarity] || '普通')}</div></div>`).join('');
    },
    draw() {
        const it = drawBlindBoxNow();
        if (it) { this.render(); PageHome.showBlindBoxResult(it); }
    }
};

/* ==================== 页面：个人中心 ==================== */
const PageProfile = {
    render() {
        const user = Store.getCurrentUser(); if (!user) return;
        document.getElementById('profile-nickname').textContent = user.nickname;
        document.getElementById('profile-account').textContent = '账号: ' + user.account;
        document.getElementById('profile-avatar').textContent = user.nickname.charAt(0).toUpperCase();
        const records = Store.getRecords();
        const totalDistance = records.reduce((s, r) => s + (r.distance || 0), 0);
        const totalTime = records.reduce((s, r) => s + (r.timeMs || 0), 0);
        document.getElementById('profile-total-count').textContent = records.length;
        document.getElementById('profile-total-distance').textContent = Utils.mToKm(totalDistance);
        document.getElementById('profile-total-time').textContent = Utils.msToHours(totalTime);
        this.renderCloud();
    },
    renderCloud() {
        const card = document.getElementById('cloud-card'); if (!card) return;
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
                <div class="cloud-msg" id="cloud-msg"></div>`;
            card.querySelector('#cloud-upload').addEventListener('click', () => this.cloudUpload(card));
            card.querySelector('#cloud-download').addEventListener('click', () => this.cloudDownload(card));
            card.querySelector('#cloud-sync').addEventListener('click', () => this.cloudSync(card));
            card.querySelector('#cloud-logout').addEventListener('click', () => {
                const acc = CloudAPI.account;
                CloudAPI.token = null; CloudAPI.account = null; CloudAPI.nickname = null;
                CloudAPI.disabled = true; // 置位，防止后台任务用本地保存的密码自动登录回去
                // 清掉本地留存的明文密码，否则“退出”形同虚设
                if (acc) { const us = Store.getUsers(); if (us[acc]) { us[acc].password = ''; Store.saveUsers(us); } }
                Toast.show('已退出云端', { type: 'success', sub: '本机数据保留，重新登录可恢复同步' });
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
                <div class="cloud-msg" id="cloud-msg"></div>`;
            card.querySelector('#cloud-register').addEventListener('click', () => this.cloudAuth(card, true));
            card.querySelector('#cloud-login').addEventListener('click', () => this.cloudAuth(card, false));
        }
    },
    cloudMsg(card, text, isError) { const el = card.querySelector('#cloud-msg'); if (el) { el.textContent = text; el.className = 'cloud-msg' + (isError ? ' error' : ' success'); } },
    async cloudAuth(card, isRegister) {
        const account = card.querySelector('#cloud-account').value.trim(); const password = card.querySelector('#cloud-password').value; const nickname = card.querySelector('#cloud-nickname').value.trim();
        if (!account || !password) { this.cloudMsg(card, '请填写账号和密码', true); return; }
        if (isRegister && !nickname) { this.cloudMsg(card, '注册请填写昵称', true); return; }
        this.cloudMsg(card, isRegister ? '注册中…' : '登录中…', false);
        try {
            const res = isRegister ? await CloudAPI.register(account, password, nickname) : await CloudAPI.login(account, password);
            if (!res || !res.token) throw new Error('未能获取云端账号，请稍后重试');
            // 走统一入口：清除退出标记、写入本地账号、立刻拉取云端数据并重绘
            await bindCloudSession(res, account, nickname, password);
            Toast.show(isRegister ? '注册成功，已登录云端' : '已登录云端', { type: 'success', sub: '已拉取云端数据' });
            this.renderCloud();
        }
        catch (e) { this.cloudMsg(card, e.message || '操作失败', true); }
    },
    async cloudUpload(card) { try { const p = buildProfile(); await CloudAPI.syncProfile(p); this.cloudMsg(card, `已上传 ${p.records.length} 条记录、${p.checkins.length} 次打卡、${p.blindBoxes.length} 个盲盒到云端`, false); Toast.show('已同步到云端', { type: 'success' }); } catch (e) { this.cloudMsg(card, e.message || '上传失败', true); } },
    async cloudDownload(card) { try { const data = await CloudAPI.getProfile(); Store.mergeProfile(data); const recs = (data.records || []); this.cloudMsg(card, `已从云端下载 ${recs.length} 条记录`, false); Toast.show('已从云端同步', { type: 'success' }); } catch (e) { this.cloudMsg(card, e.message || '下载失败', true); } },
    async cloudSync(card) {
        this.cloudMsg(card, '同步中…'); const n = await syncNow();
        if (n < 0) { this.cloudMsg(card, '同步失败，请检查网络或重新登录', true); return; }
        _lastSyncSig = syncSignature(); this.cloudMsg(card, `同步完成，当前共 ${n} 条记录`, false); Toast.show('已与云端同步', { type: 'success' });
        if (Router.current === 'home') PageHome.render(); else if (Router.current === 'history') PageHistory.render(); else if (Router.current === 'analysis') PageAnalysis.render(); else if (Router.current === 'blindbox') PageBlindbox.render(); else if (Router.current === 'profile') PageProfile.render();
    }
};

/* ==================== 详情弹窗 ==================== */
const ModalDetail = {
    currentId: null,
    show(id) {
        const records = Store.getRecords(); const record = records.find(r => r.id === id); if (!record) return;
        this.currentId = id; const sc = Utils.strokeColor(record.stroke); const t = Utils.msToTime(record.timeMs);
        const sameProject = records.filter(r => r.stroke === record.stroke && r.distance === record.distance);
        let isPB; if (record.category === 'rope') { const maxCount = sameProject.length ? Math.max(...sameProject.map(r => r.count || 0)) : (record.count || 0); isPB = (record.count || 0) === maxCount; }
        else { const bestMs = Math.min(...sameProject.map(r => r.timeMs)); isPB = record.timeMs === bestMs; }
        const body = document.getElementById('detail-body'); const ti = Utils.typeInfo(record.type);
        body.innerHTML = `
            <div style="text-align:center;margin-bottom:16px;">
                <span class="stroke-tag ${sc.class}-bg" style="display:inline-block;">${sc.emoji}${record.stroke}</span>
                <span class="detail-type-badge type-${record.type || 'training'}">${ti.emoji}${ti.label}</span>
                ${isPB ? '<span class="detail-pb-badge"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M19 5h-2V3H7v2H5a2 2 0 00-2 2v3a4 4 0 003.5 3.97V18a2 2 0 002 2h2v1h4v-1h2a2 2 0 002-2v-4.03A4 4 0 0021 10V7a2 2 0 00-2-2zM5 10V7h2v5.83A2 2 0 015 10zm14 0a2 2 0 01-2 2.83V7h2v3z"/></svg> 个人最佳</span>' : ''}
            </div>
            <div class="detail-section"><div class="detail-label">成绩类型</div><div class="detail-value">${ti.emoji} ${ti.label}</div></div>
            ${record.category === 'rope' ? `<div class="detail-section"><div class="detail-label">次数</div><div class="detail-value">${record.count} 次</div></div>` : `<div class="detail-section"><div class="detail-label">距离</div><div class="detail-value">${record.distance >= 1000 ? (record.distance / 1000).toFixed(1) + ' km' : record.distance + ' 米'}</div></div>`}
            ${record.timeMs > 0 ? `<div class="detail-section" style="text-align:center;"><div class="detail-label">用时</div><div class="detail-time-large">${t.main}<span class="ms-part">.${t.ms}</span></div></div>` : ''}
            <div class="detail-section"><div class="detail-label">日期</div><div class="detail-value">${Utils.formatDate(record.date)}</div></div>`;
        document.getElementById('detail-modal').classList.add('active');
    },
    hide() { document.getElementById('detail-modal').classList.remove('active'); this.currentId = null; },
    escapeHtml(str) { const div = document.createElement('div'); div.textContent = str; return div.innerHTML; }
};

/* ==================== 图片压缩 / 奖状墙图库 ==================== */
function compressImage(file, maxDim, quality) {
    maxDim = maxDim || 1280; quality = quality || 0.82;
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                if (width > maxDim || height > maxDim) { if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim; } else { width = Math.round(width * maxDim / height); height = maxDim; } }
                const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = () => reject(new Error('图片加载失败')); img.src = reader.result;
        };
        reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file);
    });
}
const GalleryDB = {
    DB_NAME: 'swimtrack_gallery_db', STORE: 'gallery', _db: null,
    open() { return new Promise((resolve, reject) => { if (this._db) return resolve(this._db); if (!window.indexedDB) return reject(new Error('当前环境不支持图片存储')); const req = indexedDB.open(this.DB_NAME, 1); req.onupgradeneeded = (e) => { const db = e.target.result; if (!db.objectStoreNames.contains(this.STORE)) db.createObjectStore(this.STORE, { keyPath: 'id' }); }; req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); }; req.onerror = (e) => reject(e.target.error); }); },
    async getAll(account) { const db = await this.open(); return new Promise((resolve, reject) => { const tx = db.transaction(this.STORE, 'readonly'); const req = tx.objectStore(this.STORE).getAll(); req.onsuccess = () => { resolve((req.result || []).filter(i => i.account === account).sort((a, b) => b.createdAt - a.createdAt)); }; req.onerror = () => reject(req.error); }); },
    async add(item) { const db = await this.open(); return new Promise((resolve, reject) => { const tx = db.transaction(this.STORE, 'readwrite'); tx.objectStore(this.STORE).put(item); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); },
    async delete(id) { const db = await this.open(); return new Promise((resolve, reject) => { const tx = db.transaction(this.STORE, 'readwrite'); tx.objectStore(this.STORE).delete(id); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }
};
const PageGallery = {
    items: [], currentKind: '', previewId: null, _pendingData: null,
    async render() {
        const account = Store.getSession(); if (!account) return;
        document.querySelectorAll('#gallery-tabs .chip').forEach(c => c.classList.toggle('active', (c.dataset.kind || '') === this.currentKind));
        const isBlind = this.currentKind === 'blindbox';
        const addBtn = document.getElementById('gallery-add-btn'); if (addBtn) addBtn.style.display = isBlind ? 'none' : '';
        let list;
        if (isBlind) { list = Store.getBlindBoxes().slice().sort((a, b) => b.createdAt - a.createdAt); }
        else { try { this.items = await GalleryDB.getAll(account); } catch (e) { this.items = []; } list = this.currentKind ? this.items.filter(i => i.kind === this.currentKind) : this.items; }
        const container = document.getElementById('gallery-grid'); const countEl = document.getElementById('gallery-count');
        countEl.textContent = `共 ${list.length} 张`;
        if (list.length === 0) {
            if (isBlind) { container.innerHTML = `<div class="empty-state"><div style="font-size:46px;margin-bottom:8px;">🎁</div><p>还没有盲盒，去首页打卡攒积分抽取吧～</p><button class="empty-action" id="gallery-empty-gohome">☀️ 去首页打卡</button></div>`; const g = document.getElementById('gallery-empty-gohome'); if (g) g.addEventListener('click', () => Router.navigate('home')); }
            else { container.innerHTML = `<div class="empty-state"><div style="font-size:46px;margin-bottom:8px;">🏆</div><p>${this.currentKind === 'cert' ? '还没有奖状' : this.currentKind === 'photo' ? '还没有照片' : '奖状墙还是空的'}</p><button class="empty-action" id="gallery-empty-add">＋ 上传第一张</button></div>`; const a = document.getElementById('gallery-empty-add'); if (a) a.addEventListener('click', () => this.openUpload()); }
            return;
        }
        if (isBlind) {
            container.innerHTML = list.map(it => { const c = safeColor(it.color); return `<div class="blindbox-item" data-id="${esc(it.id)}" style="--rc:${c}"><div class="blindbox-item-icon" style="color:${c}">${esc(it.icon)}</div><div class="blindbox-item-tag" style="background:${c}">${esc(it.label)}</div><div class="blindbox-item-name">${esc(it.name)}</div><div class="blindbox-item-date">${esc(Utils.formatDate(it.date))}</div></div>`; }).join('');
            container.querySelectorAll('.blindbox-item').forEach(el => el.addEventListener('click', () => this.openBlindBoxPreview(el.dataset.id)));
            return;
        }
        container.innerHTML = list.map(it => `<div class="gallery-item" data-id="${esc(it.id)}"><img src="${esc(it.data)}" alt="${esc(it.title || '')}" loading="lazy"><div class="gallery-item-overlay"><span class="gallery-item-badge">${it.kind === 'cert' ? '🏆 奖状' : '📷 照片'}</span>${it.title ? `<span class="gallery-item-title">${esc(it.title)}</span>` : ''}</div></div>`).join('');
        container.querySelectorAll('.gallery-item').forEach(el => el.addEventListener('click', () => this.openPreview(el.dataset.id)));
    },
    openBlindBoxPreview(id) { const item = Store.getBlindBoxes().find(i => i.id === id); if (item) PageHome.showBlindBoxResult(item); },
    openUpload() { this._pendingData = null; document.getElementById('upload-title').value = ''; document.getElementById('upload-file').value = ''; const p = document.getElementById('upload-preview'); p.classList.add('hidden'); p.innerHTML = ''; document.querySelectorAll('#upload-type-options .option-btn').forEach(b => b.classList.toggle('selected', b.dataset.ukind === 'cert')); document.getElementById('gallery-upload-modal').classList.add('active'); },
    closeUpload() { document.getElementById('gallery-upload-modal').classList.remove('active'); },
    async onFilePicked(file) { if (!file) return; try { const data = await compressImage(file, 1280, 0.82); this._pendingData = data; const p = document.getElementById('upload-preview'); p.innerHTML = `<img src="${data}" alt="预览">`; p.classList.remove('hidden'); } catch (e) { Toast.show('图片处理失败，请重试'); } },
    async saveUpload() {
        const account = Store.getSession(); if (!account) return; if (!this._pendingData) { Toast.show('请先选择一张图片'); return; }
        const kind = document.querySelector('#upload-type-options .option-btn.selected')?.dataset.ukind || 'cert'; const title = document.getElementById('upload-title').value.trim();
        const item = { id: Utils.uid(), account, kind, title, data: this._pendingData, createdAt: Date.now() };
        try { await GalleryDB.add(item); this.closeUpload(); Toast.show('已添加到奖状墙', { type: 'success' }); this.render(); } catch (e) { Toast.show('保存失败：' + (e.message || '未知错误')); }
    },
    openPreview(id) { const item = this.items.find(i => i.id === id); if (!item) return; this.previewId = id; document.getElementById('preview-img').src = item.data; const kindLabel = item.kind === 'cert' ? '🏆 奖状' : '📷 照片'; document.getElementById('preview-title').textContent = kindLabel; const d = new Date(item.createdAt); const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; document.getElementById('preview-meta').innerHTML = `${item.title ? `<div class="preview-title-text">${ModalDetail.escapeHtml(item.title)}</div>` : ''}<div class="preview-date">添加于 ${Utils.formatDate(ds)}</div>`; document.getElementById('gallery-preview-modal').classList.add('active'); },
    closePreview() { document.getElementById('gallery-preview-modal').classList.remove('active'); this.previewId = null; },
    async deletePreview() { if (!this.previewId) return; const ok = await Confirm.show('确定要删除这张吗？\n删除后不可恢复。'); if (!ok) return; try { await GalleryDB.delete(this.previewId); this.closePreview(); Toast.show('已删除', { type: 'success' }); this.render(); } catch (e) { Toast.show('删除失败'); } }
};

/* ==================== 事件绑定 ==================== */
function bindEvents() {
    document.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => {
        document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active')); document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
        tab.classList.add('active'); const target = tab.dataset.tab; document.getElementById(target + '-form').classList.add('active');
        document.getElementById('login-error').textContent = ''; document.getElementById('register-error').textContent = '';
    }));
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault(); const account = document.getElementById('login-account').value.trim(); const password = document.getElementById('login-password').value; const errEl = document.getElementById('login-error'); errEl.textContent = '';
        if (!account) { errEl.textContent = '请输入账号'; return; } if (!password) { errEl.textContent = '请输入密码'; return; }
        errEl.textContent = '登录中…'; const r = await unifiedAuth(account, password, false, ''); if (r.ok) { enterApp(); if (r.offline) Toast.show('离线模式：未连上云端', { type: 'warn', sub: '仅显示本机数据，联网后会自动同步' }); return; } errEl.textContent = r.message;
    });
    document.getElementById('register-form').addEventListener('submit', async (e) => {
        e.preventDefault(); const nickname = document.getElementById('reg-nickname').value.trim(); const account = document.getElementById('reg-account').value.trim(); const password = document.getElementById('reg-password').value; const errEl = document.getElementById('register-error'); errEl.textContent = '';
        if (!nickname) { errEl.textContent = '请输入昵称'; return; } if (!account) { errEl.textContent = '请输入账号'; return; } if (!password || password.length < 4) { errEl.textContent = '密码至少4位'; return; }
        errEl.textContent = '注册中…'; const r = await unifiedAuth(account, password, true, nickname); if (r.ok) { enterApp(); if (r.offline) Toast.show('离线注册成功', { type: 'warn', sub: '联网后会自动同步到云端' }); return; } errEl.textContent = r.message;
    });

    // 全局导航（底部导航 + data-nav 链接）
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-nav]'); if (!el) return;
        const v = el.dataset.nav;
        if (v === 'gallery-blind') { PageGallery.currentKind = 'blindbox'; Router.navigate('gallery'); return; }
        const view = NAV_TO_VIEW[v] || v; Router.navigate(view);
    });

    document.getElementById('history-add-btn').addEventListener('click', () => Router.navigate('record'));
    document.getElementById('gallery-add-btn').addEventListener('click', () => PageGallery.openUpload());
    document.querySelectorAll('#upload-type-options .option-btn').forEach(btn => btn.addEventListener('click', () => { document.querySelectorAll('#upload-type-options .option-btn').forEach(b => b.classList.remove('selected')); btn.classList.add('selected'); }));
    document.getElementById('upload-file').addEventListener('change', (e) => PageGallery.onFilePicked(e.target.files[0]));
    document.getElementById('gallery-upload-close').addEventListener('click', () => PageGallery.closeUpload());
    document.getElementById('gallery-upload-cancel').addEventListener('click', () => PageGallery.closeUpload());
    document.getElementById('gallery-upload-save').addEventListener('click', () => PageGallery.saveUpload());
    document.getElementById('gallery-preview-close').addEventListener('click', () => PageGallery.closePreview());
    document.getElementById('gallery-preview-close-btn').addEventListener('click', () => PageGallery.closePreview());
    document.getElementById('gallery-preview-delete').addEventListener('click', () => PageGallery.deletePreview());
    document.querySelectorAll('#gallery-tabs .chip').forEach(chip => chip.addEventListener('click', () => { document.querySelectorAll('#gallery-tabs .chip').forEach(c => c.classList.remove('active')); chip.classList.add('active'); PageGallery.currentKind = chip.dataset.kind || ''; PageGallery.render(); }));

    document.getElementById('blindbox-result-close').addEventListener('click', () => document.getElementById('blindbox-result-modal').classList.remove('active'));
    document.getElementById('blindbox-result-goto').addEventListener('click', () => { document.getElementById('blindbox-result-modal').classList.remove('active'); PageGallery.currentKind = 'blindbox'; Router.navigate('gallery'); });
    document.getElementById('go-profile-btn').addEventListener('click', () => Router.navigate('profile'));

    /* 记录页 */
    document.querySelectorAll('#cat-seg button').forEach(btn => btn.addEventListener('click', () => PageRecord.setCat(btn.dataset.cat)));
    document.getElementById('stroke-select').addEventListener('change', (e) => { PageRecord.selectedStroke = e.target.value; });
    document.getElementById('record-back-btn').addEventListener('click', () => Router.navigate(Router.prevView || 'home'));
    document.getElementById('recordSave').addEventListener('click', () => PageRecord.save());
    document.getElementById('runBtn').addEventListener('click', () => PageRecord.toggleRun());
    document.querySelectorAll('#rope-seg button').forEach(btn => btn.addEventListener('click', () => { PageRecord.setRopeMode(btn.dataset.rm); }));
    document.getElementById('ropeCountBtn').addEventListener('click', () => PageRecord.ropeTap());

    /* 历史页筛选 */
    document.getElementById('filter-stroke').addEventListener('change', () => PageHistory.render());
    document.getElementById('filter-distance').addEventListener('change', () => PageHistory.render());
    document.querySelectorAll('#history-type-chips .chip').forEach(chip => chip.addEventListener('click', () => { document.querySelectorAll('#history-type-chips .chip').forEach(c => c.classList.remove('active')); chip.classList.add('active'); PageHistory.render(); }));

    /* 分析页 */
    document.querySelectorAll('#proj-seg button').forEach(btn => btn.addEventListener('click', () => PageAnalysis.setProj(btn.dataset.proj)));
    document.querySelectorAll('#an-period-toggle button').forEach(btn => btn.addEventListener('click', () => PageAnalysis.setPeriod(btn.dataset.period)));
    document.querySelectorAll('#an-swim-stroke-seg button').forEach(btn => btn.addEventListener('click', () => PageAnalysis.setSwimStroke(btn.dataset.sw)));

    /* 个人中心 */
    document.getElementById('edit-nickname-btn').addEventListener('click', () => { const u = Store.getCurrentUser(); document.getElementById('nickname-input').value = u.nickname; document.getElementById('nickname-modal').classList.add('active'); });
    document.getElementById('nickname-cancel').addEventListener('click', () => document.getElementById('nickname-modal').classList.remove('active'));
    document.getElementById('nickname-save').addEventListener('click', () => { const val = document.getElementById('nickname-input').value.trim(); if (!val) { Toast.show('昵称不能为空'); return; } Store.updateNickname(val); document.getElementById('nickname-modal').classList.remove('active'); PageProfile.render(); Toast.show('昵称已更新', { type: 'success' }); });
    document.getElementById('logout-btn').addEventListener('click', async () => { const ok = await Confirm.show('确定要退出登录吗？'); if (ok) { Store.clearSession(); document.getElementById('main-app').classList.add('hidden'); document.getElementById('auth-view').classList.add('active'); document.getElementById('login-account').value = ''; document.getElementById('login-password').value = ''; document.getElementById('reg-nickname').value = ''; document.getElementById('reg-account').value = ''; document.getElementById('reg-password').value = ''; } });
    document.getElementById('export-data-btn').addEventListener('click', () => { const user = Store.getCurrentUser(); if (!user) return; const records = user.records; if (records.length === 0) { Toast.show('暂无数据可导出'); return; } const data = { nickname: user.nickname, account: user.account, exportDate: new Date().toISOString(), totalRecords: records.length, records: records.map(r => ({ id: r.id, date: r.date, category: r.category || 'swim', stroke: r.stroke, distance: r.distance || 0, count: r.count || 0, type: r.type || 'training', eventName: r.eventName || '', timeMs: r.timeMs, time: Utils.msToTime(r.timeMs).full, note: r.note || '', route: r.route || null, earnedPoints: r.earnedPoints || 0, createdAt: r.createdAt || null })), checkins: user.checkins || [], blindBoxes: user.blindBoxes || [] }; const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `swimtrack_${user.nickname}_${Utils.todayStr()}.json`; a.click(); URL.revokeObjectURL(url); Toast.show('数据已导出', { type: 'success' }); });
    document.getElementById('import-data-btn').addEventListener('click', () => document.getElementById('import-file').click());
    document.getElementById('import-file').addEventListener('change', (e) => { const file = e.target.files && e.target.files[0]; e.target.value = ''; if (!file) return; const reader = new FileReader(); reader.onload = () => { try { const data = JSON.parse(reader.result); const raw = Array.isArray(data) ? data : (data.records || []); if (!Array.isArray(raw) || raw.length === 0) { Toast.show('文件中没有可导入的记录'); return; } const imported = raw.map(r => { const rec = { id: r.id || Utils.uid(), stroke: r.stroke, category: r.category || inferCategory(r), distance: Number(r.distance) || 0, count: Number(r.count) || 0, timeMs: (r.timeMs != null) ? Number(r.timeMs) : Utils.timeToMs(r.time), date: r.date || Utils.todayStr(), type: r.type || 'training', eventName: r.eventName || '', note: r.note || '', route: r.route || null, createdAt: r.createdAt || Date.now() }; rec.earnedPoints = pointsForRecord(rec); return rec; })
                    // 跳绳距离为 0，旧版这里用 r.distance 做真值判断会把跳绳记录整批丢掉
                    .filter(r => r.stroke && r.timeMs >= 0 && (r.distance > 0 || r.count > 0)); if (imported.length === 0) { Toast.show('没有有效的记录可导入'); return; } if (confirm(`确定导入 ${imported.length} 条记录吗？\n（与本地记录按编号合并，不会丢失本地已有数据）`)) { Store.mergeImported(imported); scheduleCloudSync(); Toast.show(`已导入 ${imported.length} 条记录`, { type: 'success' }); if (document.getElementById('history-view').classList.contains('active')) PageHistory.render(); if (document.getElementById('analysis-view')) PageAnalysis.render(); } } catch (err) { Toast.show('文件解析失败，请检查是否为正确的备份文件'); } }; reader.readAsText(file); });
    document.getElementById('about-btn').addEventListener('click', () => document.getElementById('about-modal').classList.add('active'));
    document.getElementById('about-close').addEventListener('click', () => document.getElementById('about-modal').classList.remove('active'));
    document.getElementById('feedback-btn').addEventListener('click', () => { document.getElementById('feedback-text').value = ''; document.getElementById('feedback-modal').classList.add('active'); });
    document.getElementById('feedback-close').addEventListener('click', () => document.getElementById('feedback-modal').classList.remove('active'));
    document.getElementById('feedback-submit').addEventListener('click', () => { const text = document.getElementById('feedback-text').value.trim(); if (!text) { Toast.show('请输入反馈内容'); return; } document.getElementById('feedback-modal').classList.remove('active'); Toast.show('感谢反馈！', { type: 'success', sub: '你的意见对我们很重要' }); });

    /* 详情弹窗 */
    document.getElementById('detail-close').addEventListener('click', () => ModalDetail.hide());
    document.getElementById('detail-modal').addEventListener('click', (e) => { if (e.target.id === 'detail-modal') ModalDetail.hide(); });
    document.getElementById('detail-edit-btn').addEventListener('click', () => { const id = ModalDetail.currentId; ModalDetail.hide(); Router.prevView = Router.current; Router.navigate('record', { editingId: id }); });
    document.getElementById('detail-delete-btn').addEventListener('click', async () => { const id = ModalDetail.currentId; const ok = await Confirm.show('确定要删除这条成绩记录吗？\n删除后不可恢复。'); if (ok) { Store.deleteRecord(id); scheduleCloudSync(); ModalDetail.hide(); Toast.show('记录已删除', { type: 'success' }); switch (Router.current) { case 'home': PageHome.render(); break; case 'history': PageHistory.render(); break; case 'analysis': PageAnalysis.render(); break; case 'profile': PageProfile.render(); break; case 'record': PageRecord.renderRecent(); break; case 'blindbox': PageBlindbox.render(); break; } } });

    /* 弹窗背景关闭 */
    document.querySelectorAll('.modal-overlay').forEach(overlay => overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); }));
}

window.App = { toggleCustom(sel) { document.getElementById('distance-custom').style.display = (sel.value === 'custom') ? '' : 'none'; } };

/* ==================== 进入应用 ==================== */
function enterApp() { document.getElementById('auth-view').classList.remove('active'); document.getElementById('main-app').classList.remove('hidden'); Router.navigate('home'); }

/* ==================== 初始化 ==================== */
function init() {
    bindEvents();
    if ('serviceWorker' in navigator) { navigator.serviceWorker.register('./sw.js').then(() => console.log('[SW] 已注册')).catch((err) => console.warn('[SW] 注册失败', err)); }
    const user = Store.getCurrentUser();
    if (user) { enterApp(); autoCloudMigrate(); }
    else { document.getElementById('auth-view').classList.add('active'); }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onCloudRefresh(); });
    window.addEventListener('focus', onCloudRefresh);
    setInterval(onCloudRefresh, 30000);
    const flushOnHide = () => { if (!CloudAPI.connected) return; if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; } CloudAPI.syncProfile(buildProfile()).catch(() => {}); };
    window.addEventListener('pagehide', flushOnHide);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushOnHide(); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
