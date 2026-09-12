/**
 * draft 落盘端点：driver writer 产出 → 正文区（resolveDraftPath 按章号定位文件）。
 *
 * POST /api/books/:name/draft-save  body {chapter, content}
 *   → 写作/正文/[<卷>/]<章号>-<标题>.md（已有同章号则覆盖）→ {ok, path, words}
 * GET  /api/books/:name/draft-prompt?chapter=N
 *   → 组 prompt(长篇:细纲+备料+章 front matter;短篇:细纲+篇 front matter)→ {prompt}
 *
 * 草稿落盘 + prompt 组装逻辑已下沉 src/process/draft-pipeline.ts（P1-8 架构治理），
 * 此处 re-export 兼容既有调用方（self-heal 已从内核直接 import）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError, parseRequestUrl } from '../http.js'
import { resolveBook, bookMovedFailure } from '../book-context.js'
import { readKind } from '../../../format/kind.js'
import { readBookConfig } from '../../../format/yaml.js'
import { applyGlobalDefaults } from '../../../format/global-defaults.js'
import { saveDraft, buildDraftPrompt, NonUtf8TargetError } from '../../../process/draft-pipeline.js'
import { isSelfHealRunning } from '../../../ai/orchestrate/self-heal.js'
import { recordAuthorSignal } from '../../../ai/author-signal.js'
import { recordAiVersionAsync } from '../../../git/ai-track.js'
import { log } from '../../../log/index.js'

// re-export（P1-8 下沉兼容：既有 import 方零感知）
export { saveDraft, buildDraftPrompt, snapshotBeforeOverwrite } from '../../../process/draft-pipeline.js'

interface DraftCtx {
  workDir: string | null
  userDataPath?: string | null
}

// ── 重评-0912-4 P2-1（2026-09-12 全量重评修复批）：draft-save per-book 串行链 ──
// 此前 draft-save 端点游离于全部排水闸之外：删书/改名排水清单（busyGate → abort →
// awaitOrchestrationsSettled → drainDocumentSaves → drainFilePutChainsUnder →
// drainForeshadowSaveChains）不含本链，在途/迟到 draft-save 在墓地 rename 之后落地，
// saveDraft 的 mkdirSync(recursive) 按旧书路径重建幽灵目录树并返 200（内容不属于任何
// 书）；改名后 stale 客户端续存亦无书注册重验。收编为 files.ts filePutChains（R69-25/
// R70-6）同款范式：per-book Promise 链 + drain 导出（books.ts 删/改名排水段调用）+
// 链内临界段 bookMovedFailure 单源重验（readJson await 窗口内书可被删/改名）。
// 死锁核查（R1010b-SRV-P2-1 同款）：链单元只单向 await saveDraft 的跨进程锁
//（journal save 锁/清单锁）与 git/轨迹收尾，从不反等 books 侧锁；drain 置于既有
// 三 drain 之后不引入环。快照式 drain 的残余窗（drain 快照后新进链不等）由链内
// bookMovedFailure 重验兜底，与 R70-6 收窄口径一致。
type DraftSaveOutcome =
  | { readonly status: number; readonly code: string; readonly error: string }
  | { readonly saved: Awaited<ReturnType<typeof saveDraft>> }

const draftSaveChains = new Map<string, Promise<unknown>>()

function enqueueDraftSave(bookRoot: string, critical: () => Promise<DraftSaveOutcome>): Promise<DraftSaveOutcome> {
  const prev = draftSaveChains.get(bookRoot) ?? Promise.resolve()
  const task = prev.then(critical, critical)
  const settled = task.catch(() => { /* 续链副本吞错；真实结果经 task 传递 */ })
  draftSaveChains.set(bookRoot, settled)
  void settled.then(() => {
    if (draftSaveChains.get(bookRoot) === settled) draftSaveChains.delete(bookRoot)
  })
  return task
}

/** 重评-0912-4 P2-1：等待某书在途 draft-save 串行链排空——books.ts 删书/改名排水段
 *  调用（drainFilePutChainsUnder 同型）：在途 draft-save 的 saveDraft await 窗口跨墓地
 *  renameSync 时 mkdirSync(recursive) 会重建旧书路径目录树（幽灵书目录，无 book.yaml，
 *  repairBooks 不认领）。快照当前键后逐键等待（新进链不等——由链内 bookMovedFailure
 *  重验兜底拒绝）。
 *  链键是 resolveBook 返回的书根本身（无尾分隔符），与 files.ts 的「书根/文件」键不同：
 *  前缀判式必须兼收「恰等于书根」形态，否则 drain 恒 no-op。R71-10 同款 realpath 兜底
 *  前缀（workDir 含 symlink 组件时词法/真实两口径任一命中即 drain）。 */
export async function drainDraftSaveChainsUnder(bookRoot: string): Promise<void> {
  const roots = [bookRoot]
  try {
    const real = realpathSync(bookRoot)
    if (real !== bookRoot) roots.push(real)
  } catch {
    /* 书根不存在（已删）等 → 只用词法口径（与修复前一致） */
  }
  const matches = (k: string): boolean => roots.some((r) => k === r || k.startsWith(r + sep))
  const pending = [...draftSaveChains.keys()].filter(matches)
  if (pending.length === 0) return
  await Promise.allSettled(pending.map((k) => draftSaveChains.get(k)))
}

/** 重评-0912-4 P2-1：测试观测钩子（files.ts __filePutChainKeysForTest 同款）——当前
 *  在途链键只读快照（drain 等待性测试用；快照时点在途，settle 后自清理）。 */
export function __draftSaveChainKeysForTest(): readonly string[] {
  return [...draftSaveChains.keys()]
}

export function registerDraftRoutes(ctx: DraftCtx): void {
  defineRoute('books.draft-save', {
    method: 'POST',
    path: '/api/books/:name/draft-save',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)

    // R27-61（二十七轮）：编排互斥补齐——self-heal 写章在途时同章 draft-save 放行
    // = 后写赢覆盖自愈产物（有 snapshotBeforeOverwrite 留底故定级 P3）。对齐 rewrite.ts
    // R66-2/R70-3 同款双查口径；draft-save 是 writer 产出的落盘通道，spawn 侧经
    // driver 内部走同函数不经本端点，故只查 self-heal 面
    if (isSelfHealRunning(params['name']!)) {
      return replyError(res, 409, 'BUSY', '本书正在全自动写章，先等它跑完或中断再保存草稿')
    }

    const body = await readJson(req)
    const chapter = Number(body['chapter'])
    if (!Number.isInteger(chapter) || chapter < 1) {
      return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')
    }
    const content = typeof body['content'] === 'string' ? (body['content'] as string) : ''
    if (!content.trim()) return replyError(res, 400, 'BAD_INPUT', 'content 为空')

    const bookRoot = r.bookRoot
    // 重评-0912-4 P2-1：落盘入 per-book 串行链（上方头注）——临界段先 bookMovedFailure
    // 单源重验（readJson await 窗口内书可能已删/改名，裸写旧 bookRoot = 幽灵目录 + 假成功）
    // 再 saveDraft。非 UTF-8 存量覆盖拒绝（NonUtf8TargetError）透传 400 + 转码指引，
    // 不再 generic 化成 500「落盘失败」（P1-1 同族口径）。
    const outcome = await enqueueDraftSave(bookRoot, async (): Promise<DraftSaveOutcome> => {
      const moved = bookMovedFailure(ctx.workDir, params['name'], bookRoot)
      if (moved) return { status: 409, code: moved.code, error: moved.reason }
      try {
        // R32-5：saveDraft/recordAuthorSignal 已异步化（保存锁等待不再冻结事件循环）
        const saved = await saveDraft(bookRoot, chapter, content, { userDataPath: ctx.userDataPath })
        // 文风改稿轨迹（P1-ARCH-1：从 saveDraft 内部提取到调用方，消除 process→ai 向上依赖）
        await recordAuthorSignal(bookRoot, saved.docId, content, 'draft-save', ctx.userDataPath ?? undefined)
        // R36-5（三十六轮）：recordAiVersion 迁异步孪生——原同步 spawnSync git 两连
        // （hash-object+update-ref）在 git 无响应时拖住事件循环最长 15s×2（R32-5 注释
        // 宣称异步化的同 try 块漏网点现收口）；失败 resolve null 不阻断落盘
        await recordAiVersionAsync(bookRoot, saved.docId, content)
        return { saved }
      } catch (e) {
        if (e instanceof NonUtf8TargetError) {
          return { status: 400, code: 'NOT_UTF8_TARGET', error: e.message }
        }
        log.error('api', `落盘失败（章 ${chapter}）`, e)
        return { status: 500, code: 'IO_ERROR', error: '落盘失败' }
      }
    })
    if ('status' in outcome) return replyError(res, outcome.status, outcome.code, outcome.error)
    reply(res, 200, {
      ok: true,
      path: outcome.saved.relPath,
      words: outcome.saved.words,
      docId: outcome.saved.docId,
      snapshotted: outcome.saved.snapshotted,
    })
  },
  })

  // 组 draft prompt(读细纲+备料,长短篇分支,方案 6.6)——前端 draftWrite 拉取后 POST /spawn
  defineRoute('books.draft-prompt', {
    method: 'GET',
    path: '/api/books/:name/draft-prompt',
    handler: ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    // R-19（第十六轮）：parseRequestUrl 统一解析（Q-1/N-3 口径）——畸形 URL → 400 BAD_INPUT
    const url = parseRequestUrl(req)
    if (!url) return replyError(res, 400, 'BAD_INPUT', 'bad request')
    const chapter = Number(url.searchParams.get('chapter') ?? '1')
    if (!Number.isInteger(chapter) || chapter < 1) return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')
    const bookRoot = r.bookRoot
    // P1 接线：过全局托底合并后喂 buildDraftPrompt——每章字数与文风注入档随配置生效
    // R50-C-2（五十轮）：book.yaml 损坏静默降级留痕（对齐 state.ts P3-2 口径——
    // readBookConfig 错误分支带 DEFAULT_CONFIG 骨架，未判 ok 直接用 .config 无声回落）
    const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
    if (!cfgResult.ok) {
      log.warn('draft', `book.yaml 解析降级: ${cfgResult.error.message}`)
    }
    const config = applyGlobalDefaults(cfgResult.config, ctx.userDataPath ?? null)
    // Q-5（第十五轮）：files = prompt 实际注入源清单——前端随 prompt 回传 POST /spawn
    // 透传进 promptMeta.files，「模型可见⟺已记录」文件级溯源闭合
    const d = buildDraftPrompt(bookRoot, chapter, readKind(bookRoot), config)
    reply(res, 200, { prompt: d.prompt, files: d.files })
  },
  })
}
