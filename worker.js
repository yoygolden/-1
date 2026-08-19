// SwimTrack Cloudflare Workers 入口
// 职责：/api/* 交给 api.js 的 handleApi 处理（D1 持久化）；其余请求交给 Workers Assets 提供静态资源。
// 设计要点：静态资源（首页/JS/CSS）与 D1 完全解耦——即使 D1 偶发异常，首页与前端资源仍能正常打开，
// 只有打到 /api/* 时才懒加载 D1，避免「D1 报错连累整站打不开」的脆弱结构。
// 与 Node server.js 共享同一套核心逻辑（api.js），只换了一层「请求适配」。
import api from './api.js';

const { handleApi, loadStore, configureD1 } = api;

let d1Ready = null; // D1 存储初始化（每个 Worker 实例只做一次，且只在用到 API 时触发）

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // ---- API 路由：需要 D1 ----
        if (url.pathname.startsWith('/api/')) {
            if (!d1Ready) {
                if (typeof configureD1 === 'function') configureD1(env);
                d1Ready = loadStore();
            }
            try {
                await d1Ready;
            } catch (e) {
                // 初始化失败：重置，下次请求可重试；不要让 D1 异常阻断 API 之外的逻辑
                d1Ready = null;
                console.error('[store] D1 初始化失败:', e && e.message);
            }
            let body = '';
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                body = await request.text();
            }
            const resp = await handleApi({
                method: request.method,
                pathname: url.pathname,
                query: url.search.slice(1),
                headers: Object.fromEntries(request.headers),
                bodyText: body
            });
            return new Response(resp.body, {
                status: resp.status,
                headers: resp.headers
            });
        }

        // ---- 静态资源（index.html / app.js / styles.css / vendor / icons ...）----
        // 不依赖 D1，直接返回；not_found_handling=single-page-application 已交由 ASSETS 处理未知路径回退。
        try {
            return await env.ASSETS.fetch(request);
        } catch (e) {
            return new Response('Static asset error: ' + (e && e.message ? e.message : e), {
                status: 500,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }
    }
};
