/**
 * 共享 Zod Schema 的占位模板。
 *
 * 如果你的 Tool 有跨多个文件复用的复杂 schema（例如单测与多个 handler 共用
 * 输入类型），把 schema 放在本文件，再从 `tool.ts` re-export。
 *
 * 参考：
 *   - `backend/src/tools/calculator/tool.ts` 把 schema 内联，没有 schema.ts。
 *   - 当 Tool 需要递归 schema 时，拆出 schema.ts 能避免 tool.ts 与辅助模块
 *     之间的循环 import。
 *
 * 不需要时可以删掉本文件。
 */
export {};