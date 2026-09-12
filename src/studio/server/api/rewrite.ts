/**
 * rewrite 改写端点(2.5 + M12 B2.1):局部改写 + 整章返修 + diff,docId 直读。
 *
 * POST /api/books/:name/documents/:docId/rewrite  body {instruction, selection?, append?}
 *   → 读正文(strip fm body)→ 组 prompt → generateTool(submit_text)→ produced
 *   → local:replace(selection, produced);whole:produced 即整稿;append:原文+续写
 *   → lineDiff(原, 改)→ {ok, mode, original, rewritten, diff}
 *
 * POST /api/books/:name/documents/:docId/ai-version  body {content}
 *   → 作者接受改写时上报 AI 版全文 → 旁路 ref(文风S2 轨迹,不碰正文)
 *
 * 改写走 generateTool(submit_text);apply 不走后端,前端拿 rewritten 进编辑器由作者 ⌘S 保存。
 * diff 行级 LCS 自写(YAGNI,~50 行)。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { safeManifestPath } from '../../../fs/safe-path.js'
import { resolveBook, resolveDocEntry } from '../book-context.js'
import { readKind } from '../../../format/kind.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { REWRITE_SPEC } from '../../../ai/tasks/specs.js'
import { readDraft } from '../../../format/draft.js'
import { isSelfHealRunning } from '../../../ai/orchestrate/self-heal.js'
import { isSpawnRunning } from '../../../ai/orchestrate/spawn-registry.js'
import { recordAiVersionAsync } from '../../../git/ai-track.js'
import {
  buildRewritePrompt,
  buildAppendPrompt,
  appendRewritten,
  lineDiff,
} from '../../../process/rewrite-prompt.js'
import { acquireTaskGate, orchestrationBusyFor } from './task-gate.js' // RB-SV-P2-2：长任务并发闸
import { getDriver, ensureSession } from '../../../driver/index.js' // R0912-P2-①：中断通道注册面
import type { Session } from '../../../driver/types.js'

// re-export（P1-8 下沉兼容：既有 import 方零感知）
export { buildRewritePrompt, buildAppendPrompt, appendRewritten, lineDiff, type DiffLine } from '../../../process/rewrite-prompt.js'

interface RewriteCtx {
  workDir: string | null
  userDataPath: string | null
}

/** 跑一次 writer 改写（runSpec 统一编排；mock 与真实同走 decode）。
 *  R0912-P2-①：ctrl 透传 runSpec——外部中断（/interrupt 经 driver abort）同步中止生成。 */
async function runRewriter(
  userDataPath: string | null,
  prompt: string,
  bookRoot?: string,
  chapter?: number,
  promptFiles?: string[],
  ctrl?: AbortController,
): Promise<{ ok: true; produced: string } | { ok: false; code: string; error: string }> {
  // Z-1（第五十八轮）：正文注入源登记（铁律①——chat 侧 tools/rewrite.ts 已修，端点侧漏网）
  // Z-4（第五十八轮）：chapter 透传 runSpec → runTask chapter 记账块——编辑器侧整章改写
  // 与 chat 侧同受章预算三口径熔断（P3-8 口径，此前端点侧绕过）
  const out = await runSpec(REWRITE_SPEC, { userDataPath, bookRoot, userPrompt: prompt, ...(chapter !== undefined ? { chapter } : {}), promptFiles, ctrl })
  // R43-24（四十三轮）：code 透传（不再坍缩 'GEN_FAIL'）——NO_PROVIDER/NO_MODEL 等
  // 配置缺失族此前被 500 GEN_FAIL 掩蔽成因，路由按 code 映射状态码
  if (!out.ok) return { ok: false, code: out.code, error: out.error }
  const { input, text } = out.data
  // tool_use 产出 → input.正文
  if (input && typeof input === 'object') {
    const produced = String((input as Record<string, unknown>)['正文'] ?? '').trim()
    if (produced) return { ok: true, produced }
  }
  // 降级：tool_use 未命中 → 直接用 text
  if (text.trim()) return { ok: true, produced: text.trim() }
  return { ok: false, code: 'EMPTY_OUTPUT', error: 'writer 产出为空' }
}

export function registerRewriteRoutes(ctx: RewriteCtx): void {
  // 改写直读（M12 B2.1，O-a）：docId → 正文（strip fm 的 body）→ generateTool(submit_text) → lineDiff
  // apply 不走后端：前端拿 rewritten 进编辑器 buffer 由作者 ⌘S 保存（最纯提案模型，AI 永不直接落盘正文）
  // M2 续写解选区：body {instruction, append:true}（无 selection）→ 全文作语境只产续写部分 → 原文 + 续写
  defineRoute('books.documents.rewrite', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/rewrite',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    // R66-2（十四轮）：反向互斥面——端点持 'rewrite' 闸但此前不查 self-heal 运行标记，
    // 全自动写章在途时编辑器整章改写可并发起跑（双份费用 + 过期基线改写产出）。chat 侧
    // write_chapter 已同持此闸（turns.ts），本检查补齐 self-heal ↔ 端点互斥
    if (isSelfHealRunning(params['name']!)) {
      return replyError(res, 409, 'BUSY', '本书正在全自动写章，先等它跑完或中断再发起改写')
    }
    // R70-3（十八轮）：spawn 面——全库互斥矩阵其余各面（chat 工具/spawn/auto-write/
    // chat.send）均纳入 spawn，唯本端点漏（R66-2 只补了 self-heal 面）：手动写稿在途
    // 时编辑器改写放行 = 双倍费用 + 过期基线 + 后写赢顶掉 spawn 产出。
    if (isSpawnRunning(params['name']!)) {
      return replyError(res, 409, 'BUSY', '本书正在手动写稿，先等它跑完或中断再发起改写')
    }
    // 重评-0912-2 P2-1（2026-09-12 全量重评修复批）：补 chat/后台收尾互斥面——同族生成端点
    // （analyze/outline/onboard-ai/relations.mine/lead-updates）入口均走 orchestrationBusyFor
    // （含 isChatRunning + hasBackgroundTasks），本端点此前只有 self-heal（R66-2）/spawn（R70-3）
    // 两个单独补查面：纯文本对话在途时编辑器整章改写仍可并发起跑（双份 LLM 费用 + 过期基线
    // 提案）——反方向已封（chat.send/auto-write/chat.clear 用 allHeldTaskGatesFor，'rewrite'
    // 闸在持时对话 409），唯正向漏，矩阵不对称。组合方式照 lead-updates 先例：与前两面覆盖
    // 重叠（self-heal/spawn）时上方既有检查先命中，既有文案语义不变。
    const busyOrch = orchestrationBusyFor(params['name']!)
    if (busyOrch) return replyError(res, 409, 'BUSY', busyOrch)
    // RB-SV-P2-2：长任务并发闸（整章改写分钟级，重复点击=双倍费用）
    const release = acquireTaskGate(params['name']!, 'rewrite')
    if (!release) return replyError(res, 409, 'BUSY', '本书已在改写中，请等待完成后再试')
    // R0912-P2-①（2026-09-11 重评-0911c 修复批）：接入中断通道——此前 runSpec 未接 driver
    // ctrl 注册面，/interrupt 对在途改写完全无效且 driver.isRunning 假空闲（假成功）。接法
    // 照抄 stream.ts spawn/self-heal 的 register/unregister 形态：编排段新建 ctrl →
    // driver.registerCtrl（owner='rewrite:<书名>'，含书名使跨书并发互不误伤；同书重入已被
    // 任务闸 409 挡住，同 owner 串行换新安全）→ settle（外层 finally）统一注销。
    // 中断收口：runTask 中断返 ABORTED → 下方既有 ABORTED→499 分支即活，无需新增映射。
    const driver = getDriver()
    let registeredSession: Session | null = null
    let registeredCtrl: AbortController | null = null
    try {
      const session = await ensureSession(params['name']!, ctx.workDir!)
      registeredSession = session
      const ctrl = new AbortController()
      driver.registerCtrl?.(session, ctrl, `rewrite:${params['name']!}`)
      registeredCtrl = ctrl
      const reqBody = await readJson(req)
      const instruction = String(reqBody['instruction'] ?? '').trim()
      if (!instruction) return replyError(res, 400, 'BAD_INPUT', 'instruction(改写指令)必填')
      // X-P2-13：选区保持原样（不 trim）参与定位——首尾空白是作者选区的一部分，
      // trim 后匹配可能落到正文另一处；纯空白选区仍视为整章改写
      const selectionRaw = typeof reqBody['selection'] === 'string' ? (reqBody['selection'] as string) : ''
      const append = reqBody['append'] === true

      const bookRoot = r.bookRoot
      const docId = params['docId'] ?? ''
      const m = resolveDocEntry(bookRoot, docId)
      if (!m) return replyError(res, 404, 'NOT_FOUND', `文档ID未登记：${docId}`)
      const absPath = safeManifestPath(bookRoot, m.path)
      if (!absPath) return replyError(res, 400, 'BAD_PATH', '文档路径非法')
      if (!existsSync(absPath)) return replyError(res, 404, 'NOT_FOUND', `文档不存在：${m.path}`)

      const draft = readDraft(absPath)
      if (!draft.ok) return replyError(res, 400, 'NOT_CHAPTER', draft.reason)
      const original = draft.body
      // append(M2)：无靶点纯追加；否则 选区空 → 整 body 改写（whole）；非空 → 选段改写（local）。改写统一走 local prompt（body 语境，不涉 fm）
      const selection = selectionRaw || original
      const mode: 'local' | 'whole' | 'append' = append ? 'append' : selectionRaw.trim() ? 'local' : 'whole'
      // X-P2-13：显式定位选区（indexOf 取位置 + 唯一性校验）——String.replace 只换首个出现，
      // 同文多处时作者选的可能不是第一处；出现多次时无法定位，报错让作者扩大选区
      let selStart = -1
      if (mode === 'local') {
        selStart = original.indexOf(selectionRaw)
        if (selStart < 0) {
          return replyError(res, 400, 'BAD_INPUT', 'selection 不在正文内')
        }
        if (original.indexOf(selectionRaw, selStart + 1) >= 0) {
          return replyError(res, 400, 'AMBIGUOUS_SELECTION', 'selection 在正文中出现多次，无法定位（请扩大选区带上前后文再试）')
        }
      }

      const prompt = append
        ? buildAppendPrompt(original, instruction)
        : buildRewritePrompt('local', original, selection, instruction, [], draft.chapter.章号, readKind(bookRoot))
      const result = await runRewriter(ctx.userDataPath, prompt, bookRoot, draft.chapter.章号, [m.path], ctrl)
      // R43-24（四十三轮）：按透传 code 映射状态——NO_* 族（NO_USERDATA/NO_PROVIDER/
      // NO_MODEL，配置缺失）是客户端可处置的 400；ABORTED（用户中断）回 499（请求被
      // 取消语义；api/ 无既有先例，错误信封 {code,error} 形状不变）；其余（GEN_FAIL/
      // TIMEOUT_TOTAL/EMPTY_OUTPUT 等）维持 500 + 透传 code。错误文案一律不变
      if (!result.ok) {
        if (result.code.startsWith('NO_')) return replyError(res, 400, result.code, result.error)
        if (result.code === 'ABORTED') return replyError(res, 499, result.code, result.error)
        return replyError(res, 500, result.code, result.error)
      }
      const produced = result.produced
      // 按定位替换（保留选区外首尾空白；替代 replace 的首个出现语义）
      const rewritten =
        mode === 'append' ? appendRewritten(original, produced)
        : mode === 'local' ? original.slice(0, selStart) + produced + original.slice(selStart + selectionRaw.length)
        : produced
      if (rewritten === original) {
        // 第五轮：AI 产出与原文相同是正常业务结果（模型未改动），非服务端故障——
        // 5xx 会走前端「内部错误」通用路径，改 422 语义（客户端可处理的业务态）
        return replyError(res, 422, 'NO_CHANGE', '改写产出与原文相同（未发生变化）')
      }
      reply(res, 200, { ok: true, mode, original, rewritten, diff: lineDiff(original, rewritten) })
    } finally {
      // R0912-P2-①：settle（成功/失败/中断）统一注销——isRunning 归 false（cc X-P2-11 口径）；
      // ensureSession 失败（未注册）时跳过。ai-version 无 AI 生成段，不接线。
      if (registeredCtrl && registeredSession) driver.unregisterCtrl?.(registeredSession, registeredCtrl)
      release()
    }
  },
  })

  // 改稿轨迹采集（文风S2）：作者接受改写时前端上报 AI 版全文 → 旁路 ref。
  // 只写 ref 不碰正文（「AI 永不落盘正文」红线不破）；失败静默——轨迹是旁路证据，不阻断接受。
  defineRoute('books.documents.ai-version', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/ai-version',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const reqBody = await readJson(req)
    const content = typeof reqBody['content'] === 'string' ? (reqBody['content'] as string) : ''
    if (!content.trim()) return replyError(res, 400, 'BAD_INPUT', 'content 为空')
    // R36-5（三十六轮）：recordAiVersion 迁异步孪生——同步 spawnSync git 在请求
    // 事件循环上可冻 15s×2（git 无响应）；异步版失败 resolve null，语义不变（轨迹
    // 是旁路证据，失败静默，不阻断「接受改写」）
    const ref = await recordAiVersionAsync(r.bookRoot, params['docId'] ?? '', content)
    reply(res, 200, { ok: true, recorded: ref !== null })
  },
  })
}
