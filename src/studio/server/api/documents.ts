/**
 * 文档管理 REST 端点（§10）。
 *
 * PUT /documents/:docId/content（保存协议）。
 * W2A：GET /tree、POST /documents（新建）、PATCH /documents/:docId（move/rename）、
 *      DELETE /documents/:docId（软删）；GET /trash、POST /trash/:id/restore、DELETE /trash/:id（永久删）。
 *
 * docId→path 从项目清单解析；DocumentService per-bookRoot 单例（跨请求共享串行队列）。
 * 写端点的 Origin 白名单 + x-studio-token 校验由 server/index.ts 统一拦截（defense-in-depth）。
 * 五站写端点 runX 脚手架（书注册重验→伏笔快照→op→差分→
 * 链决策）收编 runBookScopedOp 单源，五站闭包改薄；响应信封逐字节不变。
 * （⑤④产品巨件拆分波4）：路由段按域拆出三个兄弟文件——
 * documents-save.ts（缝 1：保存/文件树/定稿确认/批量定稿）、documents-crud.ts
 * （缝 2：字数日记/W2A 新建/PATCH 移动重命名/copy/软删/回收站）、
 * documents-structure.ts（缝 3：阶段 24 章节结构操作 plan/apply/merge-undo）。
 * 基建段（DocumentService per-bookRoot 缓存族/伏笔事件族与 per-book 串行链/
 * structure 串行链/书注册重验/runBookScopedOp/structureBusyGuarded/structStatus
 * ——收敛的公共底座）内容逐字节零触碰，单源迁 documents-core.ts。
 * 装配实读记档：路由经 defineRoute 副作用注册进当前活动路由表（schema.ts
 * WeakMap 按表隔离），无路由表数据导出面；registerDocumentRoutes 是 server/
 * index.ts 与 documents-write-bookmoved-recheck.test.ts 的既有消费名（消费面零
 * 改动）→ 聚合入口留本文件。基建若留本文件，域文件回引基建 + 本文件 import
 * 域文件即成模块环——vitest 的 vite SSR transform 对环返回未完成模块对象
 * （本批实跑：域文件运行时取 runBookScopedOp 为 undefined），故基建单源
 * documents-core.ts、本文件单向 import 三域与 core，模块图无环；core 与本文件
 * 的全部外部消费名（books.ts/snapshots.ts/graceful-shutdown.ts/测试）经下方
 * 桥逐名再导出，消费方 import 面零改动。聚合按 save→crud→structure 原文件
 * 路由序调用，各域内相对序与路由代码逐字节不变——全局注册序零变化（dispatch
 * 按注册顺序匹配，顺序是隐性契约）。
 */
import { registerDocumentsSaveRoutes } from './documents-save.js'
import { registerDocumentsCrudRoutes } from './documents-crud.js'
import { registerDocumentsStructureRoutes } from './documents-structure.js'
import type { DocumentCtx } from './documents-core.js'

// 外部消费名桥——基建段单源迁 documents-core.ts 后逐名再导出（消费方
// import 面零改动；registerDocumentRoutes 为本文件聚合入口）。
export {
  getOrCreateService,
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
  // 路由段已按域拆出（见头注拆分记档）；本函数保留为聚合入口（外部
  // 消费面零改动），按原文件路由定义顺序依次注册——save（content/tree/finalize/
  // batch-finalize）→ crud（words-diary×2/新建/PATCH/copy/软删/回收站×3）→
  // structure（plan/apply/merge-undo），各域内相对序与路由代码逐字节不变，
  // 全局注册序零变化（dispatch 按注册顺序匹配——顺序是隐性契约）。
  registerDocumentsSaveRoutes(ctx)
  registerDocumentsCrudRoutes(ctx)
  registerDocumentsStructureRoutes(ctx)
}
