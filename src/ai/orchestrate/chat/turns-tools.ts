/**
 * chat 相位 d 工具执行族 —— 自 src/ai/orchestrate/chat/turns.ts 缝拆出。
 *
 * （⑤④产品巨件拆分波3）：turns.ts（958 行）纯移动拆分。
 * 本文件承载工具执行缝：等确认闸 waitConfirm（abort/超时释放与重复登记收口）+
 * executeChatTool（注册表分派 + write_chapter/check_chapter/read_chapter/read_skill
 * 内联分支 + 兜底 catch 脱敏）+ 私有格式化两件 formatHealResult/formatCheckResult +
 * 模块级常量六组（READ_CHAPTER_MAX_CHARS/READ_CHAPTER_HEAD_CHARS/
 * READ_CHAPTER_TAIL_CHARS、READ_SKILL_MAX_CHARS、AI_GEN_TOOLS、REWRITE_GATE_TOOLS
 * ——顶层求值常量随族迁此单源，不经 re-export 链外引）。
 * 轮循环骨架（runAgentTurns/lastMessageFingerprint/TurnDeps/
 * MAX_AGENT_TURNS/CHAT_TOOL_NAMES）留 turns.ts、三段实现件在 turns-phases.ts，
 * 二者 re-export 本文件 waitConfirm/executeChatTool（原既有导出面，消费方 import
 * 零改动）；可见性诊断缝见 turns-visibility.ts。
 * 依赖方向单向（无环回引）：本文件 import 既有上游出边（provider/tools/check/
 * format/process/log/node 内建 + ../chat.js、./state.js 类型），不 import turns.ts
 * ——残核单向引本文件。
 * 注释全部原样随迁；行为零变化（纯移动，差异仅 import 行/本头注）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ChatOpts } from '../chat.js'
import { redactSecret } from '../../provider/redact.js' // SSE 错误事件脱敏第二层
// 工具面扩展：注册表分派（book_search/chapter_status/树操作/改写/账本/文风）
import { TOOL_EXECUTORS, type ToolContext } from '../../tools/index.js'
import { isSelfHealRunning, runSelfHeal, abortSelfHeal, type SelfHealOutcome } from '../self-heal.js'
import { isSpawnRunning } from '../spawn-registry.js'
import { runCheckForDocumentAsync, type CheckOutcome } from '../../../check/run.js'
import { resolveDraftPath } from '../../../document/draft-path.js'
// 低-2chat 侧改写与 /rewrite 端点共用同一把 task-gate——闸表在
// studio/server/api/task-gate.ts（纯内存模块、零依赖），从 ai 层引它是共用同一
// 闸表的最小改（闸表搬层需动 src/studio 多文件，本轮禁区）
//
// 注释（§四/§六）——分层债记档，维持最小改不修：
// （b ③ / c）：ai→studio 反向依赖收口——本文件不再直接
// import studio/server/api/task-gate，改经 ai 层端口取闸，真实闸由 stream.ts
// registerStreamRoutes 注册（原债务注释五个触发条件中「第二处反向 import」未出现、
// 但两轮评审同判此项应修，走依赖倒置而非搬层：task-gate 依赖 ai/orchestrate 四个
// 在途态查询，下移会形成 ai←fs 环）。未注册形态（纯 ai 层单测）= no-op 放行。
import { acquireTaskGateViaPort } from '../task-gate-port.js'
// DSH-18：写作技巧包按需加载（read_skill 工具的执行通道）
import { listSkills, loadSkill } from '../../../process/skills.js'
import { log, errMsg } from '../../../log/index.js'
// read_chapter 剥 fm 与 prompts/chat.ts 同源（bodyOf 单源导出复用）
import { bodyOf } from '../../../format/frontmatter-core.js'
import type { ChatRunState } from './state.js'

/** read_chapter 单次返回上限（code points，与 chat 入口消息上限 5 万字符
 *  同量级的安全上限）——数万字整章无上限灌 tool_result 可撑爆上下文 */
const READ_CHAPTER_MAX_CHARS = 20_000
const READ_CHAPTER_HEAD_CHARS = 12_000
const READ_CHAPTER_TAIL_CHARS = 6_000

/** （修复批）：read_skill 单次返回上限（code points）——技巧包正文
 *  与整章正文同属模型可控外置内容，无上限灌 tool_result 可撑爆上下文；与 read_chapter
 *  同量级取 2 万字（大多数技巧包远小于此，仅病理长文触发截断）。 */
const READ_SKILL_MAX_CHARS = 20_000

/** 注册表工具里做嵌套 AI 生成的三件——与写稿编排互斥面。
 *  calls.ts 的章预算块按「同书同时只有一路生成」记账（其头注释前提），write_chapter
 *  分支一直有 isSelfHealRunning 闸，这三件走注册表漏配。rewrite 两件传 chapter 按章
 *  记账：并发时章号互覆把对方账块 fresh 重置清零，used/tokens/cost 三口径全部低估，
 *  预算闸被绕过；lead_update 不传 chapter（只进 task 块），但账本推进与 self-heal
 *  并发同样撕裂口径——闸对三件统一防御（注释校准：原文「三件按章记账」
 *  与 lead-update-draft 的 runSpec 不符）。
 *  ：互斥面补上 spawn 手动写稿——草稿互覆与章预算互覆同源，闸统一查
 *  isSelfHealRunning || isSpawnRunning。 */
const AI_GEN_TOOLS = new Set(['rewrite_chapter', 'rewrite_selection', 'lead_update'])

/** 低-2与 studio /rewrite 端点共闸互斥的 chat 改写两件（task-gate 'rewrite' 动作）。
 *  lead_update 不入——其端点对侧是 /lead-updates 的独立闸，非本缺陷面。
 *  ：apply_spill 并入——它同样把全文写进章草稿（rewrite.ts 落盘通道），
 *  此前只靠 sha 落盘前复验压窗（复验后 saveDraft 前的并发写仍是后写赢），执行期持闸
 *  与 rewrite_chapter/write_chapter 四处同口径。 */
const REWRITE_GATE_TOOLS = new Set(['rewrite_chapter', 'rewrite_selection', 'apply_spill'])

// ── 等确认 ────────────────────────────────────────

/** 等作者确认（导出供单测验证 abort 释放语义）。 */
export function waitConfirm(state: ChatRunState, callId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined
    // abort 也释放确认。abortChat 只放行「当时已挂起」的确认，其后循环里再挂起的
    // 确认若不监听 signal 会各空等满超时（默认 2 分钟），期间 running 锁被白占。
    // settle 后再触发一律 no-op（幂等：作者确认与 abort 可能先后到达同一确认）。
    let settled = false
    const onAbort = (): void => {
      // deadline 定时器触发的 abort（chat.ts 先置 timedOut 再 abort）与
      // 确认闸自身超时同归「超时」终局——不补记 confirmTimedOut 则工具结果误报
      // 「作者取消了该操作」（只修了确认超时场景，deadline 场景漏）。
      // 作者手动中断（timedOut 未置位）归因不变，仍报「作者取消」。
      if (state.timedOut) (state.confirmTimedOut ??= new Set<string>()).add(callId)
      finish(false)
    }
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      state.pending.delete(callId)
      state.ctrl.signal.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    timer = setTimeout(() => {
      // 记录超时来源——turn 循环按此区分「确认超时」与「作者取消」
      ;(state.confirmTimedOut ??= new Set<string>()).add(callId)
      finish(false)
    }, timeoutMs)
    // （修复批）：登记前查重——模型退化输出两个同 id
    // tool_use 块时直接 set 会顶掉旧项 resolve：旧确认的作者通道失联（只能干等其超时兜底），
    // 且旧项 timer 到点回调里的 pending.delete(callId) 会误删新项登记。set 前先按本表既有
    // resolve 用法（取消终态）收口旧项——finish 幂等（settled 闸 + clearTimeout +
    // removeEventListener，重复触发 no-op），timer/listener 由其幂等清理——再 log.warn
    // 留痕取代缘，然后登记新项。
    const prev = state.pending.get(callId)
    if (prev) {
      log.warn(
        'chat',
        `确认闸重复登记：tool_use id ${callId} 的挂起确认按「重复 tool_use id，已被同 id 新调用取代」收口`,
      )
      prev(false)
    }
    state.pending.set(callId, finish)
    // abort 先于挂起到达（signal 已 aborted）→ 立即按取消处理，不等超时
    if (state.ctrl.signal.aborted) {
      // 此处也可能是 deadline 定时器先触发（非用户 abort）——同下 onAbort 口径
      if (state.timedOut) (state.confirmTimedOut ??= new Set<string>()).add(callId)
      finish(false)
    } else state.ctrl.signal.addEventListener('abort', onAbort)
  })
}

// ── 工具执行 ──────────────────────────────────────

/** 导出供单测直测兜底 catch 脱敏（仿 waitConfirm「导出供单测」先例）。 */
export async function executeChatTool(
  call: { id: string; name: string; input: unknown },
  opts: ChatOpts,
  ctrl: AbortSignal,
): Promise<{ ok: boolean; summary: string }> {
  // input 空值/非对象守卫——与契约侧 assembleChapter
  // （contract/chapter.ts「产出为空或非对象」）同款口径。模型可能产出
  // input: null（工具 args 为字符串 "null" 等 JSON 解析产物）或字符串/数字等
  // 非对象形态，此前 as Record 直接断言：null/undefined 在 switch 分支抛
  // TypeError 落兜底 catch，回填「执行失败：Cannot read properties of null」
  // ——模型与作者均不可诊断。此处显式拒收并给可诊断文案（含工具名与实际
  // input 类型，模型可据此按 schema 重发对象形入参）；数组按契约侧口径放行
  // （typeof 'object'，走各工具字段校验，守卫层不二次成形）。结果走既有
  // { ok:false, summary } 路径，经轮循环 toolResultEvent 回填留痕（input
  // 原文已由 toolCallEvent 事先登记），不新造记录通道。
  if (!call.input || typeof call.input !== 'object') {
    return {
      ok: false,
      summary: `工具入参为空或非对象（${call.name} 的 input 为 ${call.input === null ? 'null' : typeof call.input}），无法执行。`,
    }
  }
  const input = call.input as Record<string, unknown>
  // check_chapter / read_chapter 共享前置单源——章号解析
  // 回落（AI 常省略 chapter 入参，回落作者选定章，均缺才报错）→ forRead 只读
  // 路径解析（机检/取回定稿章合法，不吃「拒绝覆盖写」写防线）→ 存在性校验。
  // error 分支 = 两处原样 {ok:false, summary} 文案。
  const resolveChapterForRead = (
    toolInput: Record<string, unknown>,
  ): { error: string } | { chapter: number; draftRel: string; draftPath: string } => {
    const chapter = Number(toolInput['chapter'] ?? opts.chapter)
    if (!Number.isInteger(chapter) || chapter < 1) return { error: '章号需为正整数。' }
    const draftRel = resolveDraftPath(opts.bookRoot, chapter, undefined, { forRead: true }).relPath
    const draftPath = join(opts.bookRoot, draftRel)
    if (!existsSync(draftPath)) return { error: `第${chapter}章草稿不存在。` }
    return { chapter, draftRel, draftPath }
  }
  try {
    // 工具面扩展：注册表分派（read_chapter/read_skill 等既有分支不走注册表）
    // hasOwn 守卫——普通对象按模型给出的 name 直索引时，
    // 'toString'/'constructor' 等原型链继承键命中执行体/风险表，绕过未知工具拒收
    // 与 write 确认闸（无代码执行风险，但防线语义被穿透）。
    const executor = Object.hasOwn(TOOL_EXECUTORS, call.name) ? TOOL_EXECUTORS[call.name] : undefined
    if (executor) {
      // + 嵌套 AI 生成 + 章记账的工具与两路写稿编排互斥
      // （write_chapter 同款闸）——self-heal 之外，spawn 手动写稿同样流式产出互覆草稿、
      // rewrite 两件按章记账与 spawn 并发同样互覆章预算块
      if (AI_GEN_TOOLS.has(call.name) && (isSelfHealRunning(opts.bookName) || isSpawnRunning(opts.bookName))) {
        return { ok: false, summary: '本书正在写稿（手动或全自动），无法同时改写或生成账本推进——请等本轮写完再试。' }
      }
      const tctx: ToolContext = {
        bookRoot: opts.bookRoot,
        bookName: opts.bookName,
        userDataPath: opts.userDataPath ?? null,
        // 编排级中断信号下发工具层——嵌套 AI 生成（rewrite/lead_update）据此
        // 同步中止，不再跑到各自的总超时；本地工具（tree/search 等）忽略之
        signal: ctrl,
      }
      // 低-2chat 侧改写与 studio /rewrite 端点（task-gate 'rewrite'）
      // 共闸互斥——此前两侧各自为政：AI 改写与端点改写并发时基于同一基线各产一份全文，
      // 后写赢先写（端点 rewritten 由作者在编辑器保存、chat 侧 spill→apply_spill 落盘，
      // 两条确认通道互不知晓对方已改基线）。拿不到闸 fail-closed 拒绝并说明在途原因；
      // 闸在整个工具执行期持有，反向同样拦（chat 改写在途时端点重复点击同闸 409）。
      if (REWRITE_GATE_TOOLS.has(call.name)) {
        const release = acquireTaskGateViaPort(opts.bookName, 'rewrite')
        if (!release) {
          // apply_spill 是确认落盘（非发起改写），文案单列防误导
          const busyMsg =
            call.name === 'apply_spill'
              ? '本书正在改写中（编辑器改写请求在途），无法同时落盘改写稿——请等本轮改写完成后再试。'
              : '本书正在改写中（编辑器改写请求在途），无法同时发起 AI 改写——请等本轮改写完成后再试。'
          return { ok: false, summary: busyMsg }
        }
        try {
          return await executor(tctx, input)
        } finally {
          release()
        }
      }
      return await executor(tctx, input)
    }
    switch (call.name) {
      case 'write_chapter': {
        if (isSelfHealRunning(opts.bookName) || isSpawnRunning(opts.bookName)) {
          return { ok: false, summary: '本书正在写稿（手动或全自动），无法同时再起一轮。' }
        }
        const chapter = Number(input['chapter'])
        if (!Number.isInteger(chapter) || chapter < 1) {
          return { ok: false, summary: '章号需为正整数。' }
        }
        // write_chapter 覆写旧章与编辑器 /rewrite 端点只各查各的布尔、
        // 闸不互通，可并发改稿——写章全程持有同把 task-gate 'rewrite'（与 REWRITE_GATE_TOOLS
        // 同语义）：编辑器改写在途时此处 fail-closed 拒绝；反向 chat 写章持闸期间端点
        // acquireTaskGate 得 null 回 409——两侧经同一把闸真正互斥，非两把独立锁。
        const releaseWrite = acquireTaskGateViaPort(opts.bookName, 'rewrite')
        if (!releaseWrite) {
          return { ok: false, summary: '本书正在改写中（编辑器改写请求在途），无法同时写章——请等本轮改写完成后再试。' }
        }
        // chat 中断时同步中断 self-heal（abortChat 只 abort chat ctrl，self-heal 独立 ctrl 须显式桥接）
        const onAbort = (): void => {
          abortSelfHeal(opts.bookName)
        }
        ctrl.addEventListener('abort', onAbort)
        // 四轮-A402（四轮修复批）：嵌入式写章以独立 owner
        // （`self-heal:<书名>`，非 `chat:` 前缀）登记编排级 ctrl——修复前不传 register
        //（单槽登记时代的顾虑：再登记触发 「同槽换新先 abort 旧」误伤外层
        // 对话； owner 分槽后跨 owner 互不 abort，顾虑不再成立），E002 收窄口径下
        // （cc.isWriterRunning 只排除 `chat:` 前缀槽）SSE sync 快照在写章全程假空闲。
        // 与 /auto-write 端点（stream.ts）同型：settle 后 finally 注销（——不注销
        // 则快照写手腿在途不复位）；编排级 ctrl 全程同一个，逐轮生成重复登记经 cc 幂等
        // 跳过；/interrupt 的 abortAllCtrls 全停语义不变（多一本在册账，直接 abort 本编排
        // ctrl，与 abortChat→abortSelfHeal 桥接殊途同归）。
        let registered: AbortController | null = null
        try {
          const r: SelfHealOutcome = await runSelfHeal({
            driver: opts.driver,
            mainSession: opts.mainSession,
            userDataPath: opts.userDataPath,
            cwd: opts.bookRoot,
            bookRoot: opts.bookRoot,
            bookName: opts.bookName,
            chapter,
            // 标记对话嵌套写章——chat 入口闸（stream.ts）据此放行 steer 入队
            //（当前轮 = 本工具执行期，作者追加的话在写章结束后续链），不再误 409。
            embedded: true,
            // 四轮-A402：owner 登记（owner 字串对齐 review:<书>/bg-summary:<书> 的 <书名> 后缀形）
            register: (c) => {
              registered = c
              opts.driver.registerCtrl?.(opts.mainSession, c, `self-heal:${opts.bookName}`)
            },
          })
          return {
            // escalate 时章已生成落盘，不应标记 isError（ok=false 会让 AI 误判失败重复写章）
            ok: r.outcome === 'pass' || r.outcome === 'escalate',
            summary: formatHealResult(r),
          }
        } finally {
          releaseWrite()
          ctrl.removeEventListener('abort', onAbort)
          // 四轮-A402：settle 注销（registered 为 null = 编排未触达生成期即失败，无从注销）
          if (registered) opts.driver.unregisterCtrl?.(opts.mainSession, registered)
        }
      }
      case 'check_chapter': {
        // 共享前置（章号回落 / forRead / 存在性）见 resolveChapterForRead
        const pre = resolveChapterForRead(input)
        if ('error' in pre) return { ok: false, summary: pre.error }
        const outcome = await runCheckForDocumentAsync(opts.bookRoot, pre.draftPath, opts.userDataPath)
        return formatCheckResult(outcome)
      }
      case 'read_chapter': {
        // spill 取回通道：读完整正文回填（上下文里被外置省略的全文由此取回）。
        // 章号回落与 check_chapter 同口径；结果不再二次 spill（防 read→spill→read 环）
        const pre = resolveChapterForRead(input)
        if ('error' in pre) return { ok: false, summary: pre.error }
        const { chapter, draftRel } = pre
        const raw = readFileSync(pre.draftPath, 'utf-8')
        // 剥 front matter 与 prompts/chat.ts 同源走 bodyOf（口径）——
        // 旧宽松正则会把「无 fm 但正文含两处 --- 分隔线」的手写稿吞掉中段；且下方 spill
        // 哈希须与 buildChatContext 的 writeSpillFile（对 bodyOf(raw) 哈希）同源，fullAt 才能命中
        const body = bodyOf(raw)
        if (!body.trim()) return { ok: false, summary: `第${chapter}章正文为空。` }
        // 超上限截断到头尾保留 + 注明截断量与正文文件路径（全文在草稿文件，
        // 作者可查）。不外置 spill：read_chapter 是 spill 取回通道，二次外置会 read→spill→read
        // 环（spill.ts 防环不变量）——上限取「能覆盖绝大多数整章、又不至数万字爆上下文」
        // 粗判先行——body.length（UTF-16 码元）≥ 码点数，未超限
        // 直接返回，免 `Array.from` 全量物化（病理超长章瞬态巨型码点数组）；仅当码元
        // 长度可能超限时才物化判精确值（语义等价，码点口径不变）
        if (body.length <= READ_CHAPTER_MAX_CHARS) return { ok: true, summary: body }
        const chars = Array.from(body)
        if (chars.length <= READ_CHAPTER_MAX_CHARS) return { ok: true, summary: body }
        const kept = READ_CHAPTER_HEAD_CHARS + READ_CHAPTER_TAIL_CHARS
        // 低-4截断口径如实化——本工具并不总能「取回全文」（上方上限），
        // 通知如实写明截断 + 全文去处：spill 暂存存在时优先指它（上下文注入外置的
        // 同一份全文，内容寻址同名——与 buildChatContext 的 writeSpillFile 同 hash 口径）；
        // 无 spill（未经上下文注入直接读）只报草稿路径，不虚指。spill.ts 的「已省略」
        // 通知行归 src/process（本轮禁区），契约描述（contract/chat.ts）已同步如实。
        const spillHash = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16)
        const spillRel = `工作区/spills/${spillHash}.md`
        const fullAt = existsSync(join(opts.bookRoot, spillRel))
          ? `全文暂存 ${spillRel}（草稿文件 ${draftRel} 同为此全文）`
          : `全文在草稿文件 ${draftRel}`
        return {
          ok: true,
          summary:
            chars.slice(0, READ_CHAPTER_HEAD_CHARS).join('') +
            `\n\n（全章 ${chars.length} 字超出单次读取上限，已截断至 ${kept} 字（开头 + 结尾）。${fullAt}。）\n\n` +
            chars.slice(chars.length - READ_CHAPTER_TAIL_CHARS).join(''),
        }
      }
      case 'read_skill': {
        // DSH-18 按需加载通道：system prompt 索引只给元信息，正文用时才取
        //（三根 rank 覆盖序与 listSkills 一致：项目 > 用户 > 捆绑）
        const skill = loadSkill(String(input['name'] ?? ''), {
          bookRoot: opts.bookRoot,
          userDataPath: opts.userDataPath,
        })
        if (!skill) {
          const names = listSkills({ bookRoot: opts.bookRoot, userDataPath: opts.userDataPath })
            .map((m) => m.name)
            .join('、')
          return { ok: false, summary: `未找到该技巧包。可用：${names}` }
        }
        // 正文有界返回——与 read_chapter 同款纪律：code point
        // 安全裁切 + 截断通知。粗判先行（UTF-16 码元 ≥ 码点数，未超限直接返回），
        // 仅超限才 Array.from 物化精确码点（同款，语义等价）
        if (skill.content.length <= READ_SKILL_MAX_CHARS) return { ok: true, summary: skill.content }
        const skillChars = Array.from(skill.content)
        if (skillChars.length <= READ_SKILL_MAX_CHARS) return { ok: true, summary: skill.content }
        return {
          ok: true,
          summary:
            skillChars.slice(0, READ_SKILL_MAX_CHARS).join('') +
            `\n\n（技巧包 ${skillChars.length} 字超出单次读取上限，已截断至 ${READ_SKILL_MAX_CHARS} 字。）`,
        }
      }
      default:
        return { ok: false, summary: `未知工具：${call.name}` }
    }
  } catch (e) {
    // 兜底错误文案过 redactSecret——此处 summary 经 chat_tool_result
    // SSE 直达前端并回填模型上下文，上游异常 message 可能携带 URL query param / Bearer /
    // 裸 key 形态的凭据痕迹（与 :507 onRetry 的先例同款口径，全链最后一个
    // 未脱敏错误出口补齐）。
    return { ok: false, summary: `执行失败：${redactSecret(errMsg(e))}` }
  }
}

function formatHealResult(r: SelfHealOutcome): string {
  switch (r.outcome) {
    case 'pass':
      // 用 r.chapter（章号）而非 r.docId（稳定 ID，如 legacy:9f8e7d6c）
      return r.yellows && r.yellows.length > 0
        ? `第${r.chapter}章已生成，机检全绿。仍有 ${r.yellows.length} 条文风建议未采纳。`
        : `第${r.chapter}章已生成，机检全绿。`
    case 'escalate':
      return `第${r.chapter}章已生成但有 ${r.reds.length} 个红项未能自动修复，需要手动处理。`
    case 'aborted':
      return '写章已中断。'
    case 'failed':
      return `写章失败：${r.error}`
  }
}

function formatCheckResult(outcome: CheckOutcome): { ok: boolean; summary: string } {
  if (!outcome.ok) {
    return { ok: false, summary: outcome.error }
  }
  if (!outcome.hasRed) {
    return { ok: true, summary: '机检全绿，无红项。' }
  }
  // 提取所有红项/黄项
  const items = outcome.report.sections.flatMap((s) => s.items)
  const reds = items.filter((i) => i.level === 'red')
  const yellows = items.filter((i) => i.level === 'yellow')
  const parts: string[] = []
  if (reds.length) parts.push(`${reds.length} 个红项`)
  if (yellows.length) parts.push(`${yellows.length} 个黄项`)
  const detail = items
    .slice(0, 5)
    .map((i) => `- [${i.level}] ${i.message}`)
    .join('\n')
  return {
    ok: reds.length === 0,
    summary: parts.length ? `${parts.join('，')}：\n${detail}` : '机检通过',
  }
}
