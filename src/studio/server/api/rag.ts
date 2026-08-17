/**
 * RAG 接线端点（cc 评审 P1-8）——buildIndex 从「零生产调用方」变为 GUI 可触发。
 *
 * 引擎（src/rag/*）+ 配置（book.yaml rag 段引用应用级 RAG 提供方）+ 消费方（materials recall）
 * 都已就绪，缺的只是「建索引」触发入口——README 宣称「可检索已有章节」实际端到端
 * 不可达（GUI 无处触发建索引，.rag.db 从未被建，recall 永远空手而归）。本端点补上：
 *
 *   GET  /api/books/:name/rag/status → 索引状态（是否运行中 / 已索引章数 / 块数 / 模型 / 最近结果 / 生效提供方）
 *   POST /api/books/:name/rag/build  → 后台触发 buildIndex（长任务立即返回，前端轮询 status）
 *
 * api_key 不再有书级路由：提供方化后 key 存应用级 providers.json（vault 加密），
 * 由 /api/rag-providers 管理员录入；旧版内联书的 key 仍读 env / .clwriting/rag.secret。
 *
 * 建索引是长任务（200 万字 ≈350 次 embed POST，可能数分钟）：后台跑 + 状态轮询，
 * 避免长 HTTP 请求挂死前端 fetch。任务单飞（同书同一时刻仅一个，重入 409，RB-SV-P2-2）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readRagConfig } from '../../../rag/config.js'
import { resolveRag, type RagProviderRef } from '../../../rag/resolve.js'
import { loadProviders } from '../../../ai/provider/index.js'
import { buildIndex, type BuildIndexResult } from '../../../rag/index.js'
import { openRagDb, getRagMeta } from '../../../rag/store.js'
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
 */
function startRagBuild(
  bookName: string,
  bookRoot: string,
  workDir: string,
  userDataPath: string | null,
): { ok: true } | { ok: false; reason: string } {
  const release = acquireTaskGate(bookName, 'rag-build')
  if (!release) return { ok: false, reason: '本书的索引任务已在运行中，请稍候' }

  const config = readRagConfig(bookRoot)
  if (!config.enabled) {
    release()
    return { ok: false, reason: '知识检索未启用：请在设置的「AI 功能」页开启' }
  }
  const resolved = resolveRag(config, ragProvidersOf(userDataPath), workDir)
  if (!resolved) {
    release()
    return {
      ok: false,
      reason: config.provider
        ? '所选 RAG 提供方不存在（可能已被删除）：请在设置的「AI 功能」页重新选择'
        : 'RAG 未完整配置：请在设置的「AI 功能」页选择检索提供方',
    }
  }
  if (!resolved.apiKey) {
    release()
    return {
      ok: false,
      reason: resolved.legacy
        ? '未配置 embedding API key：请用环境变量 CLWRITING_RAG_API_KEY，或在 .clwriting/rag.secret 落 key'
        : '所选 RAG 提供方未配置 API Key：请在设置的「AI 提供方」页补填',
    }
  }

  ragBuildTasks.set(bookName, { running: true, startedAt: new Date().toISOString() })
  void buildIndex(bookRoot, { enabled: true, endpoint: resolved.endpoint, model: resolved.model }, resolved.apiKey)
    .then((result) => {
      ragBuildTasks.set(bookName, { running: false, startedAt: '', lastResult: result })
    })
    .catch((e) => {
      ragBuildTasks.set(bookName, {
        running: false,
        startedAt: '',
        lastResult: { ok: false, chunkCount: 0, chapterCount: 0, error: `建索引异常：${e instanceof Error ? e.message : String(e)}` },
      })
    })
    .finally(() => {
      release()
    })
  return { ok: true }
}

export function registerRagRoutes(ctx: RagCtx): void {
  route('GET', '/api/books/:name/rag/status', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const bookRoot = join(ctx.workDir, entry.path)
    const task = ragBuildTasks.get(params['name']!)
    const running = task?.running ?? false

    // 读 .rag.db 现状（可能从未建过 → 全零）。块数用 COUNT 而非全表 BLOB 读回，
    // 大库（3.5 万块）下 status 轮询也不做重活。
    let indexedChapters = 0
    let chunkCount = 0
    let model: string | null = null
    if (existsSync(join(bookRoot, '.rag.db'))) {
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
    // 生效提供方回显（provider 缺失 → null + legacy 标记，前端据此引导重选）
    const ragConfig = readRagConfig(bookRoot)
    const resolved = resolveRag(ragConfig, ragProvidersOf(ctx.userDataPath), ctx.workDir)
    reply(res, 200, {
      running,
      indexedChapters,
      chunkCount,
      model,
      ragConfig,
      providerName: resolved?.providerName ?? null,
      legacy: resolved?.legacy ?? false,
      lastResult: task?.lastResult ?? null,
    })
  })

  route('POST', '/api/books/:name/rag/build', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const bookRoot = join(ctx.workDir, entry.path)
    const start = startRagBuild(params['name']!, bookRoot, ctx.workDir, ctx.userDataPath)
    if (!start.ok) {
      // 运行中 → 409（与 /spawn、batch-finalize 闸同口径）；配置/缺 key → 400
      const status = start.reason.includes('运行中') ? 409 : 400
      return reply(res, status, { error: start.reason })
    }
    reply(res, 200, { started: true })
  })
}
