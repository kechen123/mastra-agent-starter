/**
 * 路由聚合：把 ask / stop / regenerate 三条消息路由统一从这里导出。
 * `server/bootstrap.ts` 只 import 本文件，避免路由列表散落在多处。
 */
export { askRoute } from './ask.js';
export { stopMessageRoute } from './stop.js';
export { regenerateMessageRoute } from './regenerate.js';
