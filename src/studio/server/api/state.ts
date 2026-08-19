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
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { applyGlobalDefaults } from '../../../format/global-defaults.js'
import { readManifest } from '../../../document/manifest.js'
import { detectState, routeState, buildRecap, STATE_NAMES } from '../../../state/state.js'
import { redactSecret } from '../../../ai/provider/redact.js' // P2-4：API 错误脱敏

interface StateCtx {
  workDir: string | null
  /** APP 级数据目录：状态机入口的全局托底链（GG-P2-5）读 global.json 用 */
  userDataPath: string | null
}

export function registerStateRoutes(ctx: StateCtx): void {
  route('GET', '/api/books/:name/state', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const name = params['name']
    const entry = readBooks(ctx.workDir).find((b) => b.name === name)
    if (!entry) return reply(res, 404, { error: `没有这本书：${name}` })

    const bookRoot = join(ctx.workDir, entry.path)
    try {
      // GG-P2-5：enter() 的等价展开（见文件头注释），差异仅在读出的 config 过
      // applyGlobalDefaults——态 5 卷末判定（currentChapter % volume_size）与 recap
      // 卷号用生效值：书级未设时 global.json 书库级默认不再断链
      const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
      // P3-2 同款：book.yaml 损坏时静默降级到默认配置——至少留下诊断痕迹
      if (!cfgResult.ok) {
        console.warn(`[state] book.yaml 解析降级: ${cfgResult.error.message}`)
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
      reply(res, 200, {
        state: act.state,
        stateName: STATE_NAMES[act.state],
        humanMsg: act.humanMsg,
        action: act.action,
        nextChapter,
        kind: config.kind ?? 'long',
        // 态 4 续写断点：pre-commit=续写；post-commit-residue=重新定位（前端据此分流按钮）
        resumePoint: d.state === 4 ? d.resumePoint : undefined,
      })
    } catch (e) {
      // P2-4：API 错误脱敏——SDK 报错 message 可能含 API Key 痕迹
      reply(res, 500, { error: redactSecret(e instanceof Error ? e.message : String(e)) })
    }
  })
}
