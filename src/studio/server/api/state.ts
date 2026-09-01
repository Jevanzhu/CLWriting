/**
 * 状态机端点（#6.8① enter 自动定位）。
 *
 * GET /api/books/:name/state → 判态 + 人话 + 下章号 + kind
 *
 * 工作台进页拉此端点：顶部状态卡显示「现在该写第 N 章」/「第 N 章写到一半续写」，
 * 并自动填章号（态 7→nextChapter，态 4 续写章→chapterNum）。
 * GG-P2-5：内核 enter() 自读原始 book.yaml（无 userDataPath 概念，卷大小回落硬编码 50），
 * 这里在 API 层展开同一串内核件（readBookConfig → detectState → routeState → buildRecap），
 * config 先过 applyGlobalDefaults——书级未设 volume_size 等回落 global.json → 硬编码
 * （与 overview 喂 detectState 同一口径），态 5 卷末判定 / recap 卷号因此吃到生效值。
 * 失败不崩（500 + 错误）。
 */
import { join } from 'node:path'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readBookConfig } from '../../../format/yaml.js'
import { applyGlobalDefaults } from '../../../format/global-defaults.js'
import { readManifest } from '../../../document/manifest.js'
import { detectState, routeState, buildRecap, STATE_NAMES } from '../../../state/state.js'
import { redactSecret } from '../../../ai/provider/redact.js' // P2-4：API 错误脱敏
import { log } from '../../../log/index.js'

interface StateCtx {
  workDir: string | null
  /** APP 级数据目录：状态机入口的全局托底链（GG-P2-5）读 global.json 用 */
  userDataPath: string | null
}

// ── R75-D-P3b（批 D）：/state 结果 5s TTL 缓存 ─────────────────────────
// detectState→routeState→buildRecap 每请求全量读盘（manifest + 布线 rebuild + 近况
// 复述），工作台进页/轮询/反复刷新会反复重建。缓存口径对齐 health.ts styleScanCache
//（书键 Map + FIFO 上限 + 纯 TTL）：写路径不挂即时失效挂点——保存/定稿后最迟 5s 自愈
//（health.ts 先例同款，避免给每个写端点平添 forget 接线的过度设计）；书删除/改名的
// 生命周期清理走 forgetStateCache（R67-15 forgetBookKeyedCaches 家族接线）。
const stateCache = new Map<string, { payload: Record<string, unknown>; ts: number }>()
/** R75-D-P3b：删书/改名失效挂点（books.ts forgetBookKeyedCaches 接线；TTL 5s 兜底自愈）。 */
export function forgetStateCache(bookRoot: string): void {
  stateCache.delete(bookRoot)
}
/** R75-D-P3b 回归观测钩子（先例同 health.ts __styleScanCacheHasForTest）——仅测试用。 */
export function __stateCacheHasForTest(bookRoot: string): boolean {
  return stateCache.has(bookRoot)
}
/** R75-D-P3b：TTL 测试注入口（先例同 health.ts __setStyleScanTtlForTest）——传 null
 *  恢复默认。仅测试用，勿在生产路径调用。 */
let stateTtlMs: number | null = null
export function __setStateTtlForTest(ms: number | null): void {
  stateTtlMs = ms
}
const STATE_TTL = 5000
const STATE_CACHE_MAX = 32

export function registerStateRoutes(ctx: StateCtx): void {
  defineRoute('books.state', {
    method: 'GET',
    path: '/api/books/:name/state',
    handler: ({ params }, _req, res) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)

    const bookRoot = r.bookRoot
    // R75-D-P3b：命中短时缓存则跳过全量判态重建（payload 为纯数据可复用）
    const now = Date.now()
    const ttl = stateTtlMs ?? STATE_TTL // 测试注入优先
    const cached = stateCache.get(bookRoot)
    if (cached && now - cached.ts < ttl) {
      reply(res, 200, cached.payload)
      return
    }
    try {
      // GG-P2-5：enter() 的等价展开（见文件头注释），差异仅在读出的 config 过
      // applyGlobalDefaults——态 5 卷末判定（currentChapter % volume_size）与 recap
      // 卷号用生效值：书级未设时 global.json 书库级默认不再断链
      const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
      // P3-2 同款：book.yaml 损坏时静默降级到默认配置——至少留下诊断痕迹
      if (!cfgResult.ok) {
        log.warn('state', `book.yaml 解析降级: ${cfgResult.error.message}`)
      }
      const config = applyGlobalDefaults(cfgResult.config, ctx.userDataPath)
      const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
      // 与 enter() 同序：判态 → 路由 → 近况复述（manifest 只读一次复用，P2-BE-4）
      const detected = detectState(bookRoot, config, manifest)
      const act = routeState(detected)
      const recap = buildRecap(bookRoot, config, detected, manifest)
      // 下一个该写的章号：态 7→nextChapter；态 4（工作区未完成）→续写那章；其余→recap.nextChapter
      const d = detected
      const nextChapter =
        d.state === 7 ? d.nextChapter : d.state === 4 ? d.chapterNum : recap.nextChapter
      const payload: Record<string, unknown> = {
        state: act.state,
        stateName: STATE_NAMES[act.state],
        humanMsg: act.humanMsg,
        action: act.action,
        nextChapter,
        kind: config.kind ?? 'long',
        // 态 4 续写断点：pre-commit=续写；post-commit-residue=重新定位（前端据此分流按钮）
        resumePoint: d.state === 4 ? d.resumePoint : undefined,
        // kk-P1-4：连写暂停元状态（M6 #34）透传——buildRecap 已产出但此前在响应组装处被
        // 丢弃，前端/AI 工具均零消费，「进书提示连写暂停在第 N 章」无任何用户可见出口
        ...(recap.batchPause ? { batchPause: recap.batchPause } : {}),
      }
      // R75-D-P3b：只缓存成功路径（错误响应不缓存——book.yaml 修复后下次即重算）；
      // FIFO 淘汰同 health.ts（Map 保插入序，超上限丢最旧）
      if (stateCache.size >= STATE_CACHE_MAX) {
        const oldest = stateCache.keys().next().value
        if (oldest !== undefined) stateCache.delete(oldest)
      }
      stateCache.set(bookRoot, { payload, ts: now })
      reply(res, 200, payload)
    } catch (e) {
      // P2-4：API 错误脱敏——SDK 报错 message 可能含 API Key 痕迹
      // R33-61（三十三轮）：500 不直透原始 message（可含文件路径等内部 detail，与
      // index.ts「500 只回泛化文案」口径对齐）；全量诊断经 log.error 留服务端日志。
      log.error('state', `state 聚合失败：${redactSecret(e instanceof Error ? e.message : String(e))}`, e instanceof Error ? e : undefined)
      replyError(res, 500, 'ERROR', '状态聚合失败（详见服务端日志）')
    }
  },
  })
}
