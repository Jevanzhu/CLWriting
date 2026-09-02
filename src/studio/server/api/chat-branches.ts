/**
 * G1 分支列表只读端点：事件库分支树 → 前端分支切换 UI 的数据源。
 *
 * GET /api/books/:name/chat/branches → { branches: BranchInfo[], activeBranchId: string | null }
 *
 * - branches：listBranches（最新组在前，isDefault 标记每个 parent 下最新一组）；
 * - activeBranchId：默认分支（最新一组）；无分支元数据的线性书 → null；
 * - userData 为空（无事件库）→ 空列表，不报错；
 * - 纯只读（分支树重建纯函数），不产生副作用。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { openSessionStoreAsync, type SessionStore } from '../../../events/store.js'
import { buildBranchTree, listBranches, defaultBranchId, type BranchInfo } from '../../../events/branch-tree.js'

interface ChatBranchesCtx {
  workDir: string | null
  userDataPath: string | null
}

/** 分支视图（纯函数——route 薄接线 + 单测直喂 store；BranchInfo 已是可 JSON 化普通对象） */
export function buildBranchesView(
  store: SessionStore,
  bookName: string,
): { branches: BranchInfo[]; activeBranchId: string | null } {
  const tree = buildBranchTree(store.listEvents(bookName))
  return { branches: listBranches(tree), activeBranchId: defaultBranchId(tree) }
}

export function registerChatBranchesRoutes(ctx: ChatBranchesCtx): void {
  // E2 增量纪律：新路由一律 defineRoute；GET 无 body，parse 省略（input 恒 undefined）
  defineRoute('chat.branches', {
    method: 'GET',
    path: '/api/books/:name/chat/branches',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const bookName = params['name']!
      const bookRoot = r.bookRoot
      // userData 为空（无事件库）→ 无分支，不报错（分支 UI 留空，与 history 空视图口径一致）
      if (!ctx.userDataPath) return reply(res, 200, { branches: [], activeBranchId: null })

      // userDataPath 非空已确认 → store 必建库（openSessionStoreAsync 非惰性）
      // R62-43：userDataPath 空返回 null（上方已分流）；极端下仍可能 null → 显式错误
      // 信封（不再 ! 断言，此前静默 TypeError 崩路由）
      // IR-8（独立重评 2026-09-02）勘误：库损坏/权限等首开失败是**抛错**不是返回 null
      //（原注释失实，裸抛落 defineRoute 兜底 500 泛化文案）→ 显式收编结构化 500，
      // e.message 人话透传（含 IR-2 损坏分类的可行动指引；经统一脱敏出口）
      // R34D-19（三十四轮）：开库走异步孪生（首开锁等待不阻塞服务事件循环）
      let store: SessionStore | null
      try {
        store = await openSessionStoreAsync(ctx.userDataPath, bookRoot)
      } catch (e) {
        return replyError(
          res,
          500,
          'STORE_UNAVAILABLE',
          `事件库不可用（无法打开会话存储）：${e instanceof Error ? e.message : String(e)}`,
        )
      }
      if (!store) return replyError(res, 500, 'STORE_UNAVAILABLE', '事件库不可用（无法打开会话存储）')
      try {
        reply(res, 200, buildBranchesView(store, bookName))
      } finally {
        store.close()
      }
    },
  })
}
