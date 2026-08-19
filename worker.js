// SwimTrack Cloudflare Workers 入口
// 职责：/api/* 交给 api.js 的 handleApi 处理（D1 持久化）；其余请求交给 Workers Assets 提供静态资源。
// 与 Node server.js 共享同一套核心逻辑（api.js），只换了一层「请求适配」。
import api from './api.js';

const { handleApi, loadStore, configureD1 } = api;

let ready = null; // 每个 Worker 实例只加载一次存储（D1 读取 + 内存预热）

export default {
    async fetch(request, env, ctx) {
        // 首次请求：注入 D1 binding 并加载存储
        if (!ready) {
            if (typeof configureD1 === 'function') configureD1(env);
            ready = loadStore();
        }
        await ready;

        const url = new URL(request.url);

        // API 路由
        if (url.pathname.startsWith('/api/')) {
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

        // 静态资源（index.html / app.js / styles.css / vendor / icons ...）
        // 未匹配的文件回退到 index.html（SPA 模式，由 wrangler.toml 的 not_found_handling 控制）
        return env.ASSETS.fetch(request);
    }
};
