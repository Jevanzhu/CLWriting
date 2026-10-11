/**
 * 文档管理 REST 端点（§10）聚合入口。
 *
 * PUT /documents/:docId/content（保存协议）；GET /tree、POST /documents（新建）、
 * PATCH /documents/:docId（move/rename）、DELETE /documents/:docId（软删）；GET /trash、
 * POST /trash/:id/restore、DELETE /trash/:id（永久删）。
 *
 * docId→path 从项目清单解析；DocumentService per-bookRoot 单例（跨请求共享串行队列）。
 * 写端点的 Origin 白名单 + x-studio-token 校验由 server/index.ts 统一拦截（defense-in-depth）。
 * 五站写端点 runX 脚手架（书注册重验→伏笔快照→op→差分→链决策）单源 runBookScopedOp；响应
 * 信封不变。
 * 路由域拆三兄弟文件：documents-save.ts（保存/文件树/定稿确认/批量定稿）、documents-crud.ts
 *（字数日记/W2A 新建/PATCH 移动重命名/copy/软删/回收站）、documents-structure.ts（章节结构
 * 操作 plan/apply/merge-undo）；基建段单源 documents-core.ts。
 * 为什么聚合入口留本文件：路由经 defineRoute 副作用注册进当前活动路由表（schema.ts WeakMap
 * 按表隔离），无路由表数据导出面；registerDocumentRoutes 是 server/index.ts 与
 * documents-write-bookmoved-recheck.test.ts 的既有消费名。基建若留本文件，域文件回引基建 +
 * 本文件 import 域文件即成模块环——vitest 的 vite SSR transform 对环返回未完成模块对象
 *（域文件运行时取 runBookScopedOp 为 undefined），故本文件单向 import 三域与 core，模块图
 * 无环；core 与本文件的全部外部消费名（books.ts/snapshots.ts/graceful-shutdown.ts/测试）经
 * 下方桥逐名再导出，消费方 import 面零改动。
 * 红线：聚合按 save→crud→structure 原文件路由序调用，各域内相对序与路由代码不变——全局注册
 * 序是隐性契约（dispatch 按注册顺序匹配）。
 */
import { registerDocumentsSaveRoutes } from './documents-save.js'
import { registerDocumentsCrudRoutes } from './documents-crud.js'
import { registerDocumentsStructureRoutes } from './documents-structure.js'
import type { DocumentCtx } from './documents-core.js'

// 外部消费名桥——基建段单源迁 documents-core.ts 后逐名再导出（消费方
// import 面零改动；registerDocumentRoutes 为本文件聚合入口）。
export {
  getOrCreateService,
  structStatus,
  __clearDocumentServices,
  forgetService,
  drainDocumentSaves,
  drainForeshadowSaveChains,
  forgetForeshadowSaveChain,
  __foreshadowSaveChainKeysForTest,
  drainStructureChainsUnder,
  __structureChainKeysForTest,
} from './documents-core.js'

export function registerDocumentRoutes(ctx: DocumentCtx): void {
  // 路由段已按域拆出（见头注）；本函数保留为聚合入口（外部
  // 消费面零改动），按原文件路由定义顺序依次注册——save（content/tree/finalize/
  // batch-finalize）→ crud（words-diary×2/新建/PATCH/copy/软删/回收站×3）→
  // structure（plan/apply/merge-undo），各域内相对序与路由代码逐字节不变，
  // 全局注册序零变化（dispatch 按注册顺序匹配——顺序是隐性契约）。
  registerDocumentsSaveRoutes(ctx)
  registerDocumentsCrudRoutes(ctx)
  registerDocumentsStructureRoutes(ctx)
}
