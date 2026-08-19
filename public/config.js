/* SwimTrack 部署配置（先于 app.js 加载）
 * cloudEnabled:
 *   true  -> 使用云端后端（Cloudflare Workers + D1），支持多设备同步
 *   false -> 纯本机模式（GitHub Pages 等无后端部署），数据仅存浏览器
 */
window.__SWIM_CONFIG__ = { cloudEnabled: true };
