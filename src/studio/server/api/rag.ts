/**
 * RAG 接线端点（cc 评审 P1-8）——buildIndex 从「零生产调用方」变为 GUI 可触发。
 *
 * 引擎（src/rag/*）+ 配置（book.yaml rag 段引用应用级 RAG 提供方）+ 消费方（materials recall）
 * 都已就绪，缺的只是「建索引」触发入口——README 宣称「可检索已有章节」实际端到端
 * 不可达（GUI 无处触发建索引，.rag.db 从未被建，recall 永远空手而归）。本端点补上：
 *
 *   GET  /api/books/:name/rag/status  → 索引状态（是否运行中 / 已索引章数 / 块数 / 模型 / 最近结果 / 生效提供方 / 模型失配标记）
 *   POST /api/books/:name/rag/build   → 后台触发 buildIndex（长任务立即返回，前端轮询 status）
 *   POST /api/books/:name/rag/rebuild → R26-16（二十六轮）：闸内先 resetRagIndex 清空既有索引再触发 buildIndex
 *                                       （修复模型/维度失配后「请重建索引」无程序化出路的死路；任务闸与响应信封与 build 同一套）
 *
 * api_key 不再有书级路由：提供方化后 key 存应用级 providers.json（vault 加密），
 * 由 /api/rag-providers 管理员录入；旧版内联书的 key 仍读 env / .clwriting/rag.secret。
 *
 * 建索引是长任务（200 万字 ≈350 次 embed POST，可能数分钟）：后台跑 + 状态轮询，
 * 避免长 HTTP 请求挂死前端 fetch。任务单飞（同书同一时刻仅一个，重入 409，RB-SV-P2-2）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readRagConfig } from '../../../rag/config.js'
import { resolveRag, type RagProviderRef } from '../../../rag/resolve.js'
import { loadProviders } from '../../../ai/provider/index.js'
import { buildIndex, resetRagIndex, type BuildIndexResult } from '../../../rag/index.js'
import { openRagDb, getRagMeta, ragDbExists } from '../../../rag/store.js'
import { acquireTaskGate } from './task-gate.js'

interface RagCtx {
  workDir: string | null
  userDataPath: string | null
}

/** 后台建索引任务表（bookName → 状态）。同书同一时刻仅一个任务（task-gate 保证）。 */
const ragBuildTasks = new Map<
  string,
  { running: boolean; startedAt: string; lastResult?: BuildIndexResult }
>()

/** 清某书的索引任务表项（dd-P3：删书/改名时调用——任务表挂模块级，不随书清理会留死状态；运行中任务的收尾 set 无害落空） */
export function forgetRagBuildTask(bookName: string): void {
  ragBuildTasks.delete(bookName)
}

/** 应用级 RAG 提供方列表（userDataPath 缺失 → 空，resolveRag 走旧版内联回落） */
function ragProvidersOf(userDataPath: string | null): RagProviderRef[] {
  return userDataPath ? loadProviders(userDataPath).ragProviders : []
}

/**
 * 触发一次后台建索引。返回 ok:true = 已启动；ok:false + reason 由调用方映射状态码。
 * 前置校验：书存在（调用方做）、RAG 配置可解析（启用 + 提供方/旧内联完整）、api_key 就绪。
 * R26-16（二十六轮）：opts.resetIndexFirst = true 时（rebuild 端点），在任务闸内、
 * 前置校验全部通过后、交接后台任务前，同步 resetRagIndex 清空既有索引——闸内执行
 * 保证与运行中的 build 互斥（先清库再建，绝不 truncate 在跑任务的库下）；校验失败
 * （400 出口）不清库，既有索引无损。
 */
function startRagBuild(
  bookName: string,
  bookRoot: string,
  workDir: string,
  userDataPath: string | null,
  opts?: { resetIndexFirst?: boolean },
): { ok: true } | { ok: false; reason: string; code: 'BUSY' | 'BAD_INPUT' } {
  const release = acquireTaskGate(bookName, 'rag-build')
  if (!release) return { ok: false, reason: '本书的索引任务已在运行中，请稍候', code: 'BUSY' }
  // R26-61（二十六轮）：收尾回调 set 前复检书仍注册——forgetRagBuildTask（删书/改名
  // 清理，books.ts）把条目清掉之后 buildIndex 才落定的话，无条件 set 会把已清条目
  // 复活成死状态（同名重建书 /rag/status 读到陈旧 lastResult）。以 resolveBook 注册表
  // 判定为准（workDir 由路由 ctx 透传），书已删/改名出注册表则丢弃结果不再 set。
  const bookAlive = (): boolean => !('error' in resolveBook(workDir, bookName))

  // dd 批 4-2 残：拿到闸之后的同步准备段（读配置 → 解析提供方 → 验 key）若中途抛出，
  // 此前闸不释放——该书从此所有 rag-build 永远 409 死锁（重启才能解）。同步段包
  // try/finally：未交接给后台 buildIndex 的一切出口（含正常早退与异常上抛）都在此放闸；
  // 异常由 dispatch 兜底 500（统一 { error } 信封），作者修好配置即可重试。
  let handedOff = false
  try {
    // 全局托底：enabled/provider 书级未设回落 global.json（userDataPath 由 RagCtx 注入）
    const config = readRagConfig(bookRoot, userDataPath)
    if (!config.enabled) {
      return { ok: false, reason: '知识检索未启用：请在「设置 · 本书」页开启', code: 'BAD_INPUT' }
    }
    const resolved = resolveRag(config, ragProvidersOf(userDataPath), workDir)
    if (!resolved) {
      return {
        ok: false,
        code: 'BAD_INPUT',
        reason: config.provider
          ? '所选 RAG 提供方不存在（可能已被删除）：请在「设置 · 本书」页重新选择'
          : 'RAG 未完整配置：请在「设置 · 本书」页选择检索提供方',
      }
    }
    if (!resolved.apiKey) {
      return {
        ok: false,
        code: 'BAD_INPUT',
        reason: resolved.legacy
          ? '未配置 embedding API key：请用环境变量 CLWRITING_RAG_API_KEY，或在 .clwriting/rag.secret 落 key'
          : '所选 RAG 提供方未配置 API Key：请在设置的「服务提供方」页补填',
      }
    }

    // R26-16（二十六轮）：rebuild 语义——闸内先清空既有索引（chunks 全部行 + rag_meta
    // 全部键），后台 buildIndex 以当前配置全新建库，模型/维度失配的死路由此回到可自愈。
    // 清库是同步快操作（两条 DELETE），在交接后台任务前完成，不占额外闸窗。
    if (opts?.resetIndexFirst) resetRagIndex(bookRoot)

    ragBuildTasks.set(bookName, { running: true, startedAt: new Date().toISOString() })
    // R62-27：embed_timeout_ms 从书级 ragConfig 透传（此前字面量漏带，书里配了超时恒不生效）
    void buildIndex(bookRoot, { enabled: true, endpoint: resolved.endpoint, model: resolved.model, embed_timeout_ms: config.embed_timeout_ms }, resolved.apiKey)
      .then((result) => {
        // R26-61：书已删/改名出注册表 → 不复活任务条目（见上方 bookAlive 注释）
        if (bookAlive()) ragBuildTasks.set(bookName, { running: false, startedAt: '', lastResult: result })
      })
      .catch((e) => {
        if (bookAlive()) {
          ragBuildTasks.set(bookName, {
            running: false,
            startedAt: '',
            lastResult: { ok: false, chunkCount: 0, chapterCount: 0, error: `建索引异常：${e instanceof Error ? e.message : String(e)}` },
          })
        }
      })
      .finally(() => {
        release()
      })
    handedOff = true
    return { ok: true }
  } finally {
    // 仅同步段内未交接的出口在此放闸；已交接后台任务的闸由其 .finally 释放（勿双放——
    // release 自身幂等，但语义上闸的生命周期归后台任务管）
    if (!handedOff) release()
  }
}

export function registerRagRoutes(ctx: RagCtx): void {
  defineRoute('books.rag.status', {
    method: 'GET',
    path: '/api/books/:name/rag/status',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const bookRoot = r.bookRoot
    const task = ragBuildTasks.get(params['name']!)
    const running = task?.running ?? false

    // 读 RAG 库现状（可能从未建过 → 全零）。块数用 COUNT 而非全表 BLOB 读回，
    // 大库（3.5 万块）下 status 轮询也不做重活。
    let indexedChapters = 0
    let chunkCount = 0
    let model: string | null = null
    // hh §八-11：库已迁 .cache/rag.db；存在性探测走 openRagDb 同源 helper——
    // 旧库还在未迁移时也不误报「未建索引」（随后 openRagDb 内完成迁移）
    if (ragDbExists(bookRoot)) {
      const db = openRagDb(bookRoot)
      try {
        chunkCount = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n
        model = getRagMeta(db, 'embedding_model')
        const maxCh = getRagMeta(db, 'indexed_max_chapter')
        indexedChapters = maxCh ? Number(maxCh) : 0
      } finally {
        db.close()
      }
    }
    // 生效提供方回显（provider 缺失 → null + legacy 标记，前端据此引导重选）。
    // 全局托底：读生效配置（enabled/provider 书级未设回落 global.json）
    const ragConfig = readRagConfig(bookRoot, ctx.userDataPath)
    const resolved = resolveRag(ragConfig, ragProvidersOf(ctx.userDataPath), ctx.workDir!)
    // R26-16（二十六轮）：失配透出——已建索引的 embedding 模型与当前生效配置模型不一致
    // 时标 true（从未建过索引 model=null 不算失配），消费方据此引导走 POST /rag/rebuild；
    // 维度失配（模型同名但向量维度变过）配置侧无从比对，仍由 buildIndex 错误信封透出。
    const indexModelMismatch = model !== null && resolved !== null && resolved.model !== model
    reply(res, 200, {
      running,
      indexedChapters,
      chunkCount,
      model,
      ragConfig,
      providerName: resolved?.providerName ?? null,
      legacy: resolved?.legacy ?? false,
      indexModelMismatch,
      lastResult: task?.lastResult ?? null,
    })
  },
  })

  defineRoute('books.rag.build', {
    method: 'POST',
    path: '/api/books/:name/rag/build',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const bookRoot = r.bookRoot
    const start = startRagBuild(params['name']!, bookRoot, ctx.workDir!, ctx.userDataPath)
    if (!start.ok) {
      // 运行中 → 409 BUSY（与 /spawn、batch-finalize 闸同口径）；配置/缺 key → 400 BAD_INPUT。
      // 低级项（第六轮）：状态码由结构化 code 判定——原按文案子串 includes('运行中') 判，
      // 文案一改即误判（文案属人机交互资产，不该承担协议语义）
      return replyError(res, start.code === 'BUSY' ? 409 : 400, start.code, start.reason)
    }
    reply(res, 200, { started: true })
  },
  })

  // R26-16（二十六轮）：重建索引端点——与 build 同一套任务闸（'rag-build'，运行中 409）
  // 与响应信封，差异仅在闸内前置校验通过后先 resetRagIndex 清空既有索引再建。清库发生在
  // 同步段（交接后台任务前），后台 buildIndex 从干净库以当前配置全新建起。
  defineRoute('books.rag.rebuild', {
    method: 'POST',
    path: '/api/books/:name/rag/rebuild',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const start = startRagBuild(params['name']!, r.bookRoot, ctx.workDir!, ctx.userDataPath, { resetIndexFirst: true })
    if (!start.ok) return replyError(res, start.code === 'BUSY' ? 409 : 400, start.code, start.reason)
    reply(res, 200, { started: true, reset: true })
  },
  })
}
