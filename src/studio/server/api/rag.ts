/**
 * RAG 接线端点（cc 评审 P1-8）——buildIndex 从「零生产调用方」变为 GUI 可触发。
 *
 * 引擎（src/rag/*）+ 配置（book.yaml rag 段 + rag.secret）+ 消费方（materials recall）
 * 都已就绪，缺的只是「建索引」触发入口——README 宣称「可检索已有章节」实际端到端
 * 不可达（GUI 无处触发建索引，.rag.db 从未被建，recall 永远空手而归）。本端点补上：
 *
 *   GET  /api/books/:name/rag/status → 索引状态（是否运行中 / 已索引章数 / 块数 / 模型 / 最近结果）
 *   POST /api/books/:name/rag/build  → 后台触发 buildIndex（长任务立即返回，前端轮询 status）
 *   POST /api/books/:name/rag/key    → 写 api_key 到 .clwriting/rag.secret（H1：绝不进 book.yaml）
 *
 * 建索引是长任务（200 万字 ≈350 次 embed POST，可能数分钟）：后台跑 + 状态轮询，
 * 避免长 HTTP 请求挂死前端 fetch。任务单飞（同书同一时刻仅一个，重入 409，RB-SV-P2-2）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readRagConfig, readApiKey, writeApiKey } from '../../../rag/config.js'
import { buildIndex, type BuildIndexResult } from '../../../rag/index.js'
import { openRagDb, getRagMeta } from '../../../rag/store.js'
import { acquireTaskGate } from './task-gate.js'

interface RagCtx {
  workDir: string | null
}

/** 后台建索引任务表（bookName → 状态）。同书同一时刻仅一个任务（task-gate 保证）。 */
const ragBuildTasks = new Map<
  string,
  { running: boolean; startedAt: string; lastResult?: BuildIndexResult }
>()

/**
 * 触发一次后台建索引。返回 ok:true = 已启动；ok:false + reason 由调用方映射状态码。
 * 前置校验：书存在（调用方做）、RAG 完整配置（enabled/endpoint/model）、api_key 就绪。
 */
function startRagBuild(bookName: string, bookRoot: string, workDir: string): { ok: true } | { ok: false; reason: string } {
  const release = acquireTaskGate(bookName, 'rag-build')
  if (!release) return { ok: false, reason: '本书的索引任务已在运行中，请稍候' }

  const config = readRagConfig(bookRoot)
  if (!config.enabled || !config.endpoint || !config.model) {
    release()
    return { ok: false, reason: 'RAG 未完整配置：需在设置里启用并填写嵌入服务地址与模型' }
  }
  const apiKey = readApiKey(workDir)
  if (!apiKey) {
    release()
    return { ok: false, reason: '未配置 embedding API key：请在设置里填写，或用环境变量 CLWRITING_RAG_API_KEY' }
  }

  ragBuildTasks.set(bookName, { running: true, startedAt: new Date().toISOString() })
  void buildIndex(bookRoot, config, apiKey)
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
    reply(res, 200, {
      running,
      indexedChapters,
      chunkCount,
      model,
      ragConfig: readRagConfig(bookRoot),
      lastResult: task?.lastResult ?? null,
    })
  })

  route('POST', '/api/books/:name/rag/build', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const bookRoot = join(ctx.workDir, entry.path)
    const start = startRagBuild(params['name']!, bookRoot, ctx.workDir)
    if (!start.ok) {
      // 运行中 → 409（与 /spawn、batch-finalize 闸同口径）；配置/缺 key → 400
      const status = start.reason.includes('运行中') ? 409 : 400
      return reply(res, status, { error: start.reason })
    }
    reply(res, 200, { started: true })
  })

  route('POST', '/api/books/:name/rag/key', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const body = await readJson(req)
    const apiKey = typeof body['apiKey'] === 'string' ? body['apiKey'].trim() : ''
    if (!apiKey) return reply(res, 400, { error: 'apiKey 必填' })
    // H1：key 落 .clwriting/rag.secret（gitignore 区，0600），绝不进 book.yaml
    writeApiKey(ctx.workDir, apiKey)
    reply(res, 200, { ok: true })
  })
}
