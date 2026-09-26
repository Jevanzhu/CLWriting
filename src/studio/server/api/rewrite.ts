/**
 * rewrite 改写端点(2.5 + M12 B2.1):局部改写 + 整章返修 + diff,docId 直读。
 *
 * POST /api/books/:name/documents/:docId/rewrite  body {instruction, selection?, append?}
 *   → 读正文(strip fm body)→ 组 prompt → generateTool(submit_text)→ produced
 *   → local:replace(selection, produced);whole:produced 即整稿;append:原文+续写
 *   → lineDiff(原, 改)→ {ok, mode, original, rewritten, diff}
 *
 * POST /api/books/:name/documents/:docId/ai-version  body {content}
 * → 作者接受改写时上报 AI 版全文 → 旁路 ref(文风轨迹,不碰正文)
 *
 * 改写走 generateTool(submit_text);apply 不走后端,前端拿 rewritten 进编辑器由作者 ⌘S 保存。
 * diff 行级 LCS 自写(YAGNI,~50 行)。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBookOrReply, resolveDocFile } from '../book-context.js' // docId→正文解析链单源（本端点只走到存在性，读稿无守卫为既有语义）
import { readKind } from '../../../format/kind.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { REWRITE_SPEC } from '../../../ai/tasks/specs.js'
import { readDraft } from '../../../format/draft.js'
import { recordAiVersionAsync } from '../../../git/ai-track.js'
import { buildRewritePrompt, buildAppendPrompt, appendRewritten, lineDiff } from '../../../process/rewrite-prompt.js'
import { replyGenerationFailure, type TaskGateInjected } from './task-gate.js' // 长任务门控包装 + 生成失败状态映射单源（走 ctx.gate 实例）

// re-export（下沉兼容：既有 import 方零感知）
export {
  buildRewritePrompt,
  buildAppendPrompt,
  appendRewritten,
  lineDiff,
  type DiffLine,
} from '../../../process/rewrite-prompt.js'

interface RewriteCtx extends TaskGateInjected {
  workDir: string | null
  userDataPath: string | null
}

/** 跑一次 writer 改写（runSpec 统一编排；mock 与真实同走 decode）。
 * -①：ctrl 透传 runSpec——外部中断（/interrupt 经 driver abort）同步中止生成。 */
async function runRewriter(
  userDataPath: string | null,
  prompt: string,
  bookRoot?: string,
  chapter?: number,
  promptFiles?: string[],
  ctrl?: AbortController,
): Promise<{ ok: true; produced: string } | { ok: false; code: string; error: string }> {
  // 正文注入源登记（铁律①——chat 侧 tools/rewrite.ts 已修，端点侧漏网）
  // chapter 透传 runSpec → runTask chapter 记账块——编辑器侧整章改写
  // 与 chat 侧同受章预算三口径熔断（口径，此前端点侧绕过）
  const out = await runSpec(REWRITE_SPEC, {
    userDataPath,
    bookRoot,
    userPrompt: prompt,
    ...(chapter !== undefined ? { chapter } : {}),
    promptFiles,
    ctrl,
  })
  // code 透传（不再坍缩 'GEN_FAIL'）——NO_PROVIDER/NO_MODEL 等
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
  // 续写解选区：body {instruction, append:true}（无 selection）→ 全文作语境只产续写部分 → 原文 + 续写
  defineRoute('books.documents.rewrite', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/rewrite',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      // 写稿系编排面互斥：全自动写章/手动写稿在途时本端点并发起跑 = 双份费用 +
      // 过期基线改写产出（后写赢顶掉写手产物）。文案与判定序从忙闸矩阵单源出
      // （busyReason 的 'rewrite' 行 = self-heal → spawn，逐字同迁出前）；
      // chat/后台收尾两面由下方 runGatedGeneration 的 generate 预查兜住，不在此重复查。
      const writeBusy = ctx.gate.busyReason(params['name']!, 'rewrite')
      if (writeBusy) return replyError(res, 409, 'BUSY', writeBusy)
      // 长任务并发闸（自持 action 重入文案）+ 中断通道注册（owner='rewrite:<书名>'，
      // 中断收口经 runTask ABORTED → 下方 replyGenerationFailure 分支即活）——十段
      // 复制收编 runGatedGeneration 单源（接法头注见 task-gate.ts）。
      return ctx.gate.runGatedGeneration(
        res,
        {
          book: params['name']!,
          workDir: ctx.workDir!,
          action: 'rewrite',
          busyText: '本书已在改写中，请等待完成后再试',
        },
        async (ctrl) => {
          const reqBody = await readJson(req)
          const instruction = String(reqBody['instruction'] ?? '').trim()
          if (!instruction) return replyError(res, 400, 'BAD_INPUT', 'instruction(改写指令)必填')
          // 选区保持原样（不 trim）参与定位——首尾空白是作者选区的一部分，
          // trim 后匹配可能落到正文另一处；纯空白选区仍视为整章改写
          const selectionRaw = typeof reqBody['selection'] === 'string' ? (reqBody['selection'] as string) : ''
          const append = reqBody['append'] === true

          const bookRoot = r.bookRoot
          const docId = params['docId'] ?? ''
          // 清单/路径/存在性解析收编 resolveDocFile 单源
          //（文案 variant『文档路径非法』为原字面量逐位保留；读稿无 TOCTOU 守卫为既有
          // 语义——守卫化会改失败档响应字节，红线不越）
          const f = resolveDocFile(bookRoot, docId, { badPathText: '文档路径非法' })
          if (!f.ok) return replyError(res, f.status, f.code, f.message)
          const m = f.entry
          const draft = readDraft(f.absPath)
          if (!draft.ok) return replyError(res, 400, 'NOT_CHAPTER', draft.reason)
          const original = draft.body
          // append：无靶点纯追加；否则 选区空 → 整 body 改写（whole）；非空 → 选段改写（local）。改写统一走 local prompt（body 语境，不涉 fm）
          const selection = selectionRaw || original
          const mode: 'local' | 'whole' | 'append' = append ? 'append' : selectionRaw.trim() ? 'local' : 'whole'
          // 显式定位选区（indexOf 取位置 + 唯一性校验）——String.replace 只换首个出现，
          // 同文多处时作者选的可能不是第一处；出现多次时无法定位，报错让作者扩大选区
          let selStart = -1
          if (mode === 'local') {
            selStart = original.indexOf(selectionRaw)
            if (selStart < 0) {
              return replyError(res, 400, 'BAD_INPUT', 'selection 不在正文内')
            }
            if (original.indexOf(selectionRaw, selStart + 1) >= 0) {
              return replyError(
                res,
                400,
                'AMBIGUOUS_SELECTION',
                'selection 在正文中出现多次，无法定位（请扩大选区带上前后文再试）',
              )
            }
          }

          const prompt = append
            ? buildAppendPrompt(original, instruction)
            : buildRewritePrompt('local', original, selection, instruction, [], draft.chapter.章号, readKind(bookRoot))
          const result = await runRewriter(ctx.userDataPath, prompt, bookRoot, draft.chapter.章号, [m.path], ctrl)
          // 按透传 code 映射状态——NO_* 族（NO_USERDATA/NO_PROVIDER/
          // NO_MODEL，配置缺失）是客户端可处置的 400；ABORTED（用户中断）回 499（请求被
          // 取消语义；api/ 无既有先例，错误信封 {code,error} 形状不变）；其余（GEN_FAIL/
          // TIMEOUT_TOTAL/EMPTY_OUTPUT 等）维持 500 + 透传 code。错误文案一律不变。
          // 三行映射收编 replyGenerationFailure 单源。
          if (!result.ok) return replyGenerationFailure(res, result)
          const produced = result.produced
          // 按定位替换（保留选区外首尾空白；替代 replace 的首个出现语义）
          const rewritten =
            mode === 'append'
              ? appendRewritten(original, produced)
              : mode === 'local'
                ? original.slice(0, selStart) + produced + original.slice(selStart + selectionRaw.length)
                : produced
          if (rewritten === original) {
            // AI 产出与原文相同是正常业务结果（模型未改动），非服务端故障——
            // 5xx 会走前端「内部错误」通用路径，改 422 语义（客户端可处理的业务态）
            return replyError(res, 422, 'NO_CHANGE', '改写产出与原文相同（未发生变化）')
          }
          reply(res, 200, { ok: true, mode, original, rewritten, diff: lineDiff(original, rewritten) })
        },
      )
    },
  })

  // 改稿轨迹采集（文风）：作者接受改写时前端上报 AI 版全文 → 旁路 ref。
  // 只写 ref 不碰正文（「AI 永不落盘正文」红线不破）；失败静默——轨迹是旁路证据，不阻断接受。
  defineRoute('books.documents.ai-version', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/ai-version',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      const reqBody = await readJson(req)
      const content = typeof reqBody['content'] === 'string' ? (reqBody['content'] as string) : ''
      if (!content.trim()) return replyError(res, 400, 'BAD_INPUT', 'content 为空')
      // recordAiVersion 迁异步孪生——同步 spawnSync git 在请求
      // 事件循环上可冻 15s×2（git 无响应）；异步版失败 resolve null，语义不变（轨迹
      // 是旁路证据，失败静默，不阻断「接受改写」）
      const ref = await recordAiVersionAsync(r.bookRoot, params['docId'] ?? '', content)
      reply(res, 200, { ok: true, recorded: ref !== null })
    },
  })
}
