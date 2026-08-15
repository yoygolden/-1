// Cloudflare Workers 入口
// 仅处理 /api/*；其余请求委托给 Workers Assets 静态资源（SPA 回退到 index.html）。
// 每天定时（triggers.crons）把整份数据快照写入 R2（MEDIA 绑定）做异地备份，保证数据不丢失。
import api from './api.js';

const { handleApi, loadStore, getStoreMode, getStoreSnapshot, configureD1 } = api;

// 惰性初始化：首次请求 / 定时任务时，用运行时 env 注入 D1 配置并加载存储。
// 模块加载阶段拿不到 env，必须在 handler 里配置。
let ready = null;
function ensureReady(env) {
    if (!ready) {
        configureD1(env);          // 从 Worker env 注入 D1 凭证（[vars]）
        ready = (async () => { await loadStore(); })();
    }
    return ready;
}

export default {
    async fetch(request, env) {
        await ensureReady(env);
        const url = new URL(request.url);

        // API 请求：交给运行时无关的核心逻辑处理
        if (url.pathname.startsWith('/api/')) {
            const bodyText = await request.text();
            const response = await handleApi({
                method: request.method,
                pathname: url.pathname,
                query: url.search.slice(1),
                headers: Object.fromEntries(request.headers),
                bodyText,
            });
            return new Response(response.body, {
                status: response.status,
                headers: response.headers,
            });
        }

        // 静态资源（index.html / app.js / styles.css / vendor / icons …）由 Workers Assets 托管，
        // 未知路径回退到 index.html（SPA）。未命中则返回 404。
        return env.ASSETS.fetch(request);
    },

    // 定时备份：把当前内存中的整份 store 写入 R2（仅当绑定了 MEDIA 桶）
    async scheduled(event, env) {
        await ensureReady(env);
        try {
            const snap = getStoreSnapshot();
            if (snap && env && env.MEDIA) {
                const key = `backup/${new Date().toISOString().slice(0, 10)}.json`;
                await env.MEDIA.put(key, snap, {
                    httpMetadata: { contentType: 'application/json' },
                });
                console.log('[backup] written', key);
            } else {
                console.log('[backup] skipped (no MEDIA binding or empty snapshot)');
            }
        } catch (e) {
            console.error('[backup] failed', e);
        }
    },
};

console.log('SwimTrack worker module loaded');
