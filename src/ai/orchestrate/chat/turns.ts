/**
 * chat 相位 d：agent 轮循环（hh §八-16 自 chat.ts runChat 拆出，纯搬家）。
 *
 * 轮首中止三出口 / 快照血缘登记 / generate 流式回调 / !ok 与 max_tokens 出口 /
 * 无工具完成路径（assistant 事件 + 分支激活 Z-P1-2 + 溢出 checkpoint B1+B2）/
 * 工具路径（确认闸 + tool_use/tool_result 事件 + 分支元数据）/ 轮数触顶收尾。
 * 返回 completedOk（E1a：正常完成才续链消费队列）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ChatMsg, ContentBlock, TokenUsage } from '../../provider/types.js'
import { generate } from '../../gen.js'
import { runTask } from '../../runner.js'
import { chatTools, TOOL_RISK } from '../../contract/chat.js'
// 工具面扩展：注册表分派（book_search/chapter_status/树操作/改写/账本/文风）
import { TOOL_EXECUTORS, type ToolContext } from '../../tools/index.js'
import { isSelfHealRunning, runSelfHeal, abortSelfHeal, type SelfHealOutcome } from '../self-heal.js'
import { isSpawnRunning } from '../spawn-registry.js'
import { runCheckForDocument, type CheckOutcome } from '../../../check/run.js'
import { resolveDraftPath } from '../../../format/draft.js'
// 低-2（第十轮）：chat 侧改写与 /rewrite 端点共用同一把 task-gate——闸表在
// studio/server/api/task-gate.ts（纯内存模块、零依赖），从 ai 层引它是共用同一
// 闸表的最小改（闸表搬层需动 src/studio 多文件，本轮禁区）
import { acquireTaskGate } from '../../../studio/server/api/task-gate.js'
// DSH-18：写作技巧包按需加载（read_skill 工具的执行通道）
import { listSkills, loadSkill } from '../../../process/skills.js'
import { sanitizeHistory, visibleInjectionsFromDigests } from '../../prompts/chat.js'
// A1（五十九轮）：read_chapter 剥 fm 与 prompts/chat.ts 同源（bodyOf 单源导出复用）
import { bodyOf } from '../../../format/frontmatter-core.js'
import type { SessionRecorder } from '../../../events/chat-bridge.js'
import { turnStartEvent, turnEndEvent, assistantMessageEvent, toolCallEvent, toolResultEvent } from '../../../events/chat-bridge.js'
import { settingsSnapshotEvent, revisionRefEvent, skillsSnapshotEvent } from '../../../events/chain-bridge.js'
// R65-15：可见性诊断开关直接消费 lineage 校验器（lineage 只依赖 node:crypto 与
// 自身 types，无环）；NewEvent→ChatEvent 形状补齐仅供校验器读取 type/data
import { verifyVisibleRecorded, type VisibleInjection } from '../../../events/lineage.js'
import type { ChatEvent } from '../../../events/types.js'
import type { NewEvent } from '../../../events/store.js'
import type { ChatOpts } from '../chat.js'
import { emit, activeBranchByBook, type ChatRunState } from './state.js'
import { finishTurn, finalizeHistory } from './finish.js'
import type { ChatSeqLedger } from './restore.js'

const MAX_AGENT_TURNS = 5

/** RB-AI-P2-5：read_chapter 单次返回上限（code points，与 chat 入口消息上限 5 万字符
 *  同量级的安全上限）——数万字整章无上限灌 tool_result 可撑爆上下文 */
const READ_CHAPTER_MAX_CHARS = 20_000
const READ_CHAPTER_HEAD_CHARS = 12_000
const READ_CHAPTER_TAIL_CHARS = 6_000

/** M-1（第六轮）：注册表工具里做嵌套 AI 生成的三件——与写稿编排互斥面。
 *  calls.ts 的章预算块按「同书同时只有一路生成」记账（其头注释前提），write_chapter
 *  分支一直有 isSelfHealRunning 闸，这三件走注册表漏配。rewrite 两件传 chapter 按章
 *  记账：并发时章号互覆把对方账块 fresh 重置清零，used/tokens/cost 三口径全部低估，
 *  预算闸被绕过；lead_update 不传 chapter（只进 task 块），但账本推进与 self-heal
 *  并发同样撕裂口径——闸对三件统一防御（P5-AI·第七轮注释校准：原文「三件按章记账」
 *  与 lead-update-draft 的 runSpec 不符）。
 *  M-2（第八轮）：互斥面补上 spawn 手动写稿——草稿互覆与章预算互覆同源，闸统一查
 *  isSelfHealRunning || isSpawnRunning。 */
const AI_GEN_TOOLS = new Set(['rewrite_chapter', 'rewrite_selection', 'lead_update'])

/** 低-2（第十轮）：与 studio /rewrite 端点共闸互斥的 chat 改写两件（task-gate 'rewrite' 动作）。
 *  lead_update 不入——其端点对侧是 /lead-updates 的独立闸，非本缺陷面。
 *  R69-13（十七轮）：apply_spill 并入——它同样把全文写进章草稿（rewrite.ts 落盘通道），
 *  此前只靠 sha 落盘前复验压窗（复验后 saveDraft 前的并发写仍是后写赢），执行期持闸
 *  与 rewrite_chapter/write_chapter 四处同口径。 */
const REWRITE_GATE_TOOLS = new Set(['rewrite_chapter', 'rewrite_selection', 'apply_spill'])

// ── 等确认 ────────────────────────────────────────

/** 等作者确认（导出供单测验证 abort 释放语义）。 */
export function waitConfirm(state: ChatRunState, callId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    // Z-P1-1：abort 也释放确认。abortChat 只放行「当时已挂起」的确认，其后循环里再挂起的
    // 确认若不监听 signal 会各空等满超时（默认 2 分钟），期间 running 锁被白占。
    // settle 后再触发一律 no-op（幂等：作者确认与 abort 可能先后到达同一确认）。
    let settled = false
    const onAbort = (): void => {
      // M-6（第十一轮）：deadline 定时器触发的 abort（chat.ts 先置 timedOut 再 abort）与
      // 确认闸自身超时同归「超时」终局——不补记 confirmTimedOut 则工具结果误报
      // 「作者取消了该操作」（P5-AI·第七轮只修了确认超时场景，deadline 场景漏）。
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
      // P5-AI（第七轮）：记录超时来源——turn 循环按此区分「确认超时」与「作者取消」
      ;(state.confirmTimedOut ??= new Set<string>()).add(callId)
      finish(false)
    }, timeoutMs)
    state.pending.set(callId, finish)
    // abort 先于挂起到达（signal 已 aborted）→ 立即按取消处理，不等超时
    if (state.ctrl.signal.aborted) {
      // M-6（第十一轮）：此处也可能是 deadline 定时器先触发（非用户 abort）——同下 onAbort 口径
      if (state.timedOut) (state.confirmTimedOut ??= new Set<string>()).add(callId)
      finish(false)
    } else state.ctrl.signal.addEventListener('abort', onAbort)
  })
}

// ── 工具执行 ──────────────────────────────────────

async function executeChatTool(
  call: { id: string; name: string; input: unknown },
  opts: ChatOpts,
  ctrl: AbortSignal,
): Promise<{ ok: boolean; summary: string }> {
  const input = call.input as Record<string, unknown>
  try {
    // 工具面扩展：注册表分派（read_chapter/read_skill 等既有分支不走注册表）
    const executor = TOOL_EXECUTORS[call.name]
    if (executor) {
      // M-1（第六轮）+ M-2（第八轮）：嵌套 AI 生成 + 章记账的工具与两路写稿编排互斥
      // （write_chapter 同款闸）——self-heal 之外，spawn 手动写稿同样流式产出互覆草稿、
      // rewrite 两件按章记账与 spawn 并发同样互覆章预算块
      if (AI_GEN_TOOLS.has(call.name) && (isSelfHealRunning(opts.bookName) || isSpawnRunning(opts.bookName))) {
        return { ok: false, summary: '本书正在写稿（手动或全自动），无法同时改写或生成账本推进——请等本轮写完再试。' }
      }
      const tctx: ToolContext = {
        bookRoot: opts.bookRoot,
        bookName: opts.bookName,
        userDataPath: opts.userDataPath ?? null,
        // Z-P1-1：编排级中断信号下发工具层——嵌套 AI 生成（rewrite/lead_update）据此
        // 同步中止，不再跑到各自的总超时；本地工具（tree/search 等）忽略之
        signal: ctrl,
      }
      // 低-2（第十轮）：chat 侧改写与 studio /rewrite 端点（task-gate 'rewrite'，RB-SV-P2-2）
      // 共闸互斥——此前两侧各自为政：AI 改写与端点改写并发时基于同一基线各产一份全文，
      // 后写赢先写（端点 rewritten 由作者在编辑器保存、chat 侧 spill→apply_spill 落盘，
      // 两条确认通道互不知晓对方已改基线）。拿不到闸 fail-closed 拒绝并说明在途原因；
      // 闸在整个工具执行期持有，反向同样拦（chat 改写在途时端点重复点击同闸 409）。
      if (REWRITE_GATE_TOOLS.has(call.name)) {
        const release = acquireTaskGate(opts.bookName, 'rewrite')
        if (!release) {
          // R69-13：apply_spill 是确认落盘（非发起改写），文案单列防误导
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
        // R66-2（十四轮）：write_chapter 覆写旧章与编辑器 /rewrite 端点只各查各的布尔、
        // 闸不互通，可并发改稿——写章全程持有同把 task-gate 'rewrite'（与 REWRITE_GATE_TOOLS
        // 同语义）：编辑器改写在途时此处 fail-closed 拒绝；反向 chat 写章持闸期间端点
        // acquireTaskGate 得 null 回 409——两侧经同一把闸真正互斥，非两把独立锁。
        const releaseWrite = acquireTaskGate(opts.bookName, 'rewrite')
        if (!releaseWrite) {
          return { ok: false, summary: '本书正在改写中（编辑器改写请求在途），无法同时写章——请等本轮改写完成后再试。' }
        }
        // chat 中断时同步中断 self-heal（abortChat 只 abort chat ctrl，self-heal 独立 ctrl 须显式桥接）
        const onAbort = (): void => { abortSelfHeal(opts.bookName) }
        ctrl.addEventListener('abort', onAbort)
        try {
          const r: SelfHealOutcome = await runSelfHeal({
            driver: opts.driver,
            mainSession: opts.mainSession,
            userDataPath: opts.userDataPath,
            cwd: opts.bookRoot,
            bookRoot: opts.bookRoot,
            bookName: opts.bookName,
            chapter,
            // R76-12：标记对话嵌套写章——chat 入口闸（stream.ts）据此放行 steer 入队
            //（当前轮 = 本工具执行期，作者追加的话在写章结束后续链），不再误 409。
            embedded: true,
          })
          return {
            // B-P1-6：escalate 时章已生成落盘，不应标记 isError（ok=false 会让 AI 误判失败重复写章）
            ok: r.outcome === 'pass' || r.outcome === 'escalate',
            summary: formatHealResult(r),
          }
        } finally {
          releaseWrite()
          ctrl.removeEventListener('abort', onAbort)
        }
      }
      case 'check_chapter': {
        // X-P2-12：AI 常省略 chapter 入参——回落到作者选定章（均缺才报错；此前 NaN 直接被拒）
        const chapter = Number(input['chapter'] ?? opts.chapter)
        if (!Number.isInteger(chapter) || chapter < 1) {
          return { ok: false, summary: '章号需为正整数。' }
        }
        // R68-1：forRead 只读口径——机检定稿章合法，不吃「拒绝覆盖写」写防线
        const draftRel = resolveDraftPath(opts.bookRoot, chapter, undefined, { forRead: true }).relPath
        const draftPath = join(opts.bookRoot, draftRel)
        if (!existsSync(draftPath)) {
          return { ok: false, summary: `第${chapter}章草稿不存在。` }
        }
        const outcome = runCheckForDocument(opts.bookRoot, draftPath, opts.userDataPath)
        return formatCheckResult(outcome)
      }
      case 'read_chapter': {
        // B3 spill 取回通道：读完整正文回填（上下文里被外置省略的全文由此取回）。
        // 章号回落与 check_chapter 同口径（X-P2-12）；结果不再二次 spill（防 read→spill→read 环）
        const chapter = Number(input['chapter'] ?? opts.chapter)
        if (!Number.isInteger(chapter) || chapter < 1) {
          return { ok: false, summary: '章号需为正整数。' }
        }
        // R68-1：forRead 只读口径——取回定稿章全文合法，不吃「拒绝覆盖写」写防线
        const draftRel = resolveDraftPath(opts.bookRoot, chapter, undefined, { forRead: true }).relPath
        const draftPath = join(opts.bookRoot, draftRel)
        if (!existsSync(draftPath)) {
          return { ok: false, summary: `第${chapter}章草稿不存在。` }
        }
        const raw = readFileSync(draftPath, 'utf-8')
        // A1（五十九轮）：剥 front matter 与 prompts/chat.ts 同源走 bodyOf（P-6 口径）——
        // 旧宽松正则会把「无 fm 但正文含两处 --- 分隔线」的手写稿吞掉中段；且下方 spill
        // 哈希须与 buildChatContext 的 writeSpillFile（对 bodyOf(raw) 哈希）同源，fullAt 才能命中
        const body = bodyOf(raw)
        if (!body.trim()) return { ok: false, summary: `第${chapter}章正文为空。` }
        // RB-AI-P2-5：超上限截断到头尾保留 + 注明截断量与正文文件路径（全文在草稿文件，
        // 作者可查）。不外置 spill：read_chapter 是 spill 取回通道，二次外置会 read→spill→read
        // 环（spill.ts 防环不变量）——上限取「能覆盖绝大多数整章、又不至数万字爆上下文」
        const chars = Array.from(body)
        if (chars.length <= READ_CHAPTER_MAX_CHARS) return { ok: true, summary: body }
        const kept = READ_CHAPTER_HEAD_CHARS + READ_CHAPTER_TAIL_CHARS
        // 低-4（第十轮）：截断口径如实化——本工具并不总能「取回全文」（上方上限），
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
        return { ok: true, summary: skill.content }
      }
      default:
        return { ok: false, summary: `未知工具：${call.name}` }
    }
  } catch (e) {
    return { ok: false, summary: `执行失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

function formatHealResult(r: SelfHealOutcome): string {
  switch (r.outcome) {
    case 'pass':
      // B-P1-2：用 r.chapter（章号）而非 r.docId（稳定 ID，如 legacy:9f8e7d6c）
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
  const detail = items.slice(0, 5).map((i) => `- [${i.level}] ${i.message}`).join('\n')
  return {
    ok: reds.length === 0,
    summary: parts.length ? `${parts.join('，')}：\n${detail}` : '机检通过',
  }
}

// ── 轮循环 ────────────────────────────────────────

/** Q-11（第十五轮）：当轮末条消息指纹——多轮 agent 循环每轮实际发送的末条消息
 *  （首轮 user 文本 / 工具轮 tool_result blocks），序列化后进 llm/call promptMeta 哈希。
 *  此前恒用 opts.message（首轮 user 文本），同组多轮 hash 全同，「本次实际输入指纹」审计失义 */
export function lastMessageFingerprint(history: ChatMsg[]): string {
  const last = history[history.length - 1]
  if (!last) return ''
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
}


export interface TurnDeps {
  opts: ChatOpts
  state: ChatRunState
  confirmTimeout: number
  history: ChatMsg[]
  baseLen: number
  recorder: SessionRecorder
  sys: string
  /** Z-P1-2：本回合分支元数据（来自 restore 相位） */
  turnBranch: { parentSeq?: number; branchId?: string } | undefined
  /** P3 血缘：注入快照指纹（来自 restore 相位） */
  digests: { settings: string; revision?: string; skills?: string }
  /** T2-1：prompt 注入文件清单（来自 restore 相位）——llm/call promptMeta.files 登记 */
  promptFiles: string[]
  /** T2-1：章正文注入路径（来自 restore 相位）——revision/ref 的 path 字段 */
  revisionPath: string | undefined
  seqs: ChatSeqLedger
  /** chat_done 发出当口回调置 completedOk——此后 finalizeHistory 若抛异常，
   *  续链口径与拆分前一致（正常完成已广播，队列照常消费，不因收尾压缩失败丢弃） */
  markCompleted: () => void
}

/** R65-15（总六十五轮）：CLW_VERIFY_VISIBLE=1 诊断开关——llm/call 落库后对本回合
 *  注入清单抽样跑 verifyVisibleRecorded（「模型可见 ⟺ 已记录」生产侧抽查）。可见清单
 *  经 visibleInjectionsFromDigests 单源组装（R66-9；revision→chapter、skills→skills
 *  的字段映射在本函数）：
 *  recorded 传本回合已登记的三种血缘事件（settings/snapshot + revision/ref +
 *  skills/snapshot，与 recorder 收到的同物）。违约只 console.warn（不抛、不进事件库、
 *  不影响主流程）；flag 关闭首行即返回，零开销。 */
export function verifyVisibleSampled(
  digests: { settings: string; revision?: string; skills?: string },
  recorded: NewEvent[],
): void {
  if (process.env['CLW_VERIFY_VISIBLE'] !== '1') return
  try {
    // R66-9（十四轮）：可见清单改由 visibleInjectionsFromDigests 单源组装（此前手工
    // 镜像 visibleInjections 形状——两侧改拼接源即失配，恰是本开关要抓的漂移）
    const visible: VisibleInjection[] = visibleInjectionsFromDigests({
      settings: digests.settings,
      ...(digests.revision !== undefined ? { chapter: digests.revision } : {}),
      ...(digests.skills !== undefined ? { skills: digests.skills } : {}),
    })
    // 校验器只读 type/data——NewEvent 补齐 ChatEvent 必填字段（seq 用批内序号占位）
    const events: ChatEvent[] = recorded.map((ev, i) => ({
      seq: i,
      sessionId: '',
      type: ev.type,
      data: ev.data,
      replaceGeneration: 0,
      createdAt: 0,
    }))
    const check = verifyVisibleRecorded(visible, events)
    if (check.missing.length > 0) {
      console.warn(
        `[CLW_VERIFY_VISIBLE] 模型可见注入未登记（${check.missing.length}/${visible.length}）：` +
          check.missing.map((m) => `${m.scope}:${m.digest}`).join(', '),
      )
    }
  } catch {
    /* 诊断通道自身异常不外溢——不影响主流程是开关的硬约束 */
  }
}

/** 相位 d：轮循环 + 轮数触顶收尾。返回 completedOk（E1a 续链口径：正常完成才 true）。 */
export async function runAgentTurns(deps: TurnDeps): Promise<boolean> {
  const { opts, state, confirmTimeout, history, baseLen, recorder, sys, turnBranch, seqs } = deps
  const { settings: settingsDigest, revision: revisionDigest, skills: skillsDigest } = deps.digests


  /** M-1（第十一轮）：回合 commit 点 flush 异常收编 finishTurn——磁盘满/血缘校验越界时
   *  recorder.flush() 抛错直穿 runAgentTurns（chat.ts 只有 try/finally 无 catch），既无
   *  历史回滚也无 surface 遮蔽，已 push 消息留驻内存 histories 而事件未落库，下次对话
   *  模型可见但不可回溯（restore 仅内存空才读库）——DB 故障路径破铁律①。三处 commit
   *  点统一经本助手收编为失败出口（回滚 + 遮蔽 + chat_error，与六失败出口同口径），
   *  返回 false 终止轮循环。 */
  const flushTurnEvents = (): boolean => {
    try {
      seqs.commitPendingMsgSeqs(recorder.flush())
      return true
    } catch (e) {
      finishTurn(opts, history, baseLen, recorder, {
        error: `事件记录落库失败，本回合已回滚（检查磁盘/事件库后重发）：${e instanceof Error ? e.message : String(e)}`,
      })
      return false
    }
  }

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    if (state.ctrl.signal.aborted) {
      // P1-S4 回滚 + F1-P1 遮蔽在 finishTurn 内；CC-P2-2：deadline 定时器触发的 abort
      // 报「超时」（含嵌套 self-heal / 确认闸期间），用户中断报「已中断」
      finishTurn(opts, history, baseLen, recorder, state.timedOut ? 'timeout' : 'interrupted')
      return false
    }
    if (Date.now() > state.deadline) {
      finishTurn(opts, history, baseLen, recorder, 'timeout')
      return false
    }

    recorder.add(turnStartEvent(turn))
    // P3 血缘：登记本轮注入快照（settings/snapshot + revision/ref + skills/snapshot），assistant 事件引用
    const lineageIdx: number[] = []
    // R65-15：本回合登记的血缘事件同留一份供 CLW_VERIFY_VISIBLE 抽样校验（与
    // recorder 收到的同物；flag 关时收集成本 = 数组 push，可忽略）
    const lineageRecorded: NewEvent[] = []
    const addLineage = (ev: NewEvent): number => {
      lineageRecorded.push(ev)
      return recorder.add(ev)
    }
    lineageIdx.push(addLineage(settingsSnapshotEvent({ scope: 'settings', digest: settingsDigest })))
    if (revisionDigest !== undefined) {
      // T2-1：path 记章正文实际注入源（spill locator 或草稿路径），此前恒空串断链
      lineageIdx.push(addLineage(revisionRefEvent({ chapter: opts.chapter ?? 0, revision: revisionDigest, path: deps.revisionPath ?? '' })))
    }
    // G2-2：技巧包索引注入（DSH-18）补登记——skillsIndex 非空才注入，同条件才登记
    if (skillsDigest !== undefined) {
      lineageIdx.push(addLineage(skillsSnapshotEvent({ digest: skillsDigest })))
    }
    emit(opts, { type: 'chat_turn', turn })

    const out = await runTask<{
      text: string
      toolCalls: { id: string; name: string; input: unknown }[]
      stopReason: string
      usage: TokenUsage
      reasoning: string
      /** Q-13（第十五轮）：resolve 后上线输出上限——runner 提取落 llm/call */
      resolvedMaxTokens?: number
      /** Responses 线缺口 11：加密推理项随 reasoning 块入历史，下轮回传维持推理状态 */
      reasoningEncrypted?: string
      reasoningItemId?: string
    }>({
      userDataPath: opts.userDataPath,
      tierKind: 'chat',
      task: 'chat',
      bookRoot: opts.bookRoot,
      // B-P2-2：trace hash 纳入 system prompt——chat 的 system prompt 稳定（设定+职责），
      // 不带则同 user 消息不同书 hash 冲突
      systemPrompt: sys,
      // Q-11（第十五轮）：每轮取当轮末条消息（tool_result 轮为 blocks 序列化），
      // 同组多轮 hash 各异，恢复「本次实际输入指纹」审计语义
      promptText: lastMessageFingerprint(history),
      // T2-1：注入文件清单（章正文/spill）进 llm/call promptMeta.files——与写稿链
      //（self-heal promptFiles）同口径：记 hash+chars+files，不落 prompt 全文
      promptFiles: deps.promptFiles,
      ctrl: state.ctrl,
      // M-1（第八轮）：owner='chat:<book>'——driver 分槽防跨编排抢占（此前单槽「换新先
      // abort 旧」会掐断在途写稿）。R69-11（十七轮）注释校准：chat 与 self-heal/spawn 的并发
      // 由入口互斥闸管（stream.ts chat.send/regenerate 对写稿在途 409，R-9），本处不承
      // 担并发许可；下方 AI_GEN_TOOLS/write_chapter 闸是工具层二道防线。
      // R71-19（十九轮）：owner 带书维度——sendChatMessage 锁按书分键（chat.ts running
      // map），两本书共享同一 mainSession 的形态下，后书对话注册同 owner 'chat' 触发
      // P2-6「换新先 abort 旧」掐断前书在途 ctrl。`chat:<bookName>` 分槽后跨书并发
      // 互不抢占；同书 turns 与 finish 同槽同 ctrl，幂等 no-op 不变。
      register: (c) => opts.driver.registerCtrl?.(opts.mainSession, c, `chat:${opts.bookName}`),
      onReset: () => emit(opts, { type: 'chat_reset' }),
      // P1-R3：provider 429/5xx 重试时推 warning（与 self-heal.ts:496 对齐，Bug C 同类补齐）
      onRetry: (attempt, error) =>
        emit(opts, { type: 'warning', message: `AI 响应异常（${error}），第 ${attempt + 1} 次重试中…` }),
      run: async (provider, signal, tier) => {
        // 发送前历史消毒（§6.4 第二道防线）：多轮 tool 往返/中断回滚后历史可能
        // 出现非法序列（空 content / 连续同 role / 孤儿 tool_result / 首条非 user）→ 400。
        // 消毒产副本，不污染累积的 history（回滚仍按 baseLen 精确）。
        const sanitized = sanitizeHistory(history)
        const r = await generate(
          provider,
          {
            systemPrompt: sys,
            messages: sanitized,
            tools: chatTools,
            toolChoice: 'auto',
            effort: tier.effort,
          },
          signal,
          (delta) => emit(opts, { type: 'chat_text', text: delta }),
        )
        return {
          text: r.text,
          toolCalls: r.toolCalls,
          stopReason: r.stopReason,
          usage: r.usage,
          reasoning: r.reasoning,
          resolvedMaxTokens: r.resolvedMaxTokens,
          // B-2（第六十轮）：降级参数面标记透传（extractDegraded 落 llm/call，铁律②重放口径）
          degraded: r.degraded,
          reasoningEncrypted: r.reasoningEncrypted,
          reasoningItemId: r.reasoningItemId,
        }
      },
    })

    // R65-15：llm/call 已落库（成败两路都落 trace）——对注入清单抽样校验（flag 开时；
    // 违约仅 warn，先于失败出口收口，失败回合的注入同样受查）
    verifyVisibleSampled(deps.digests, lineageRecorded)

    if (!out.ok) {
      // CC-P2-2：deadline 定时器在 generate 期间触发 → 按超时收口（与轮首 aborted 分支同文案）
      finishTurn(opts, history, baseLen, recorder, state.timedOut ? 'timeout' : { error: out.error })
      return false
    }

    const { text, toolCalls, stopReason, reasoning, reasoningEncrypted, reasoningItemId } = out.data

    // max_tokens → 工具入参可能被截断，绝不执行；半截文本不入 history（K12）；
    // P1-R1a：回滚 user 消息（与 !out.ok 路径一致），防下次对话连续 user → Anthropic 400
    if (stopReason === 'max_tokens') {
      finishTurn(opts, history, baseLen, recorder, 'max-tokens')
      return false
    }

    // 无工具调用 → 对话结束
    if (toolCalls.length === 0) {
      // P2-AI-1：reasoning 非空时入历史（与工具路径一致——DeepSeek/Kimi 多轮带 tools 硬要求）
      let asstContent: string | ContentBlock[]
      if (reasoning) {
        const blocks: ContentBlock[] = []
        if (text) blocks.push({ type: 'text', text })
        // Responses 线缺口 11：加密推理项随 reasoning 块入历史，下轮回传维持推理状态
        blocks.push({
          type: 'reasoning',
          text: reasoning,
          ...(reasoningEncrypted ? { encrypted: reasoningEncrypted, ...(reasoningItemId ? { itemId: reasoningItemId } : {}) } : {}),
        })
        asstContent = blocks
      } else {
        asstContent = text
      }
      history.push({ role: 'assistant', content: asstContent })
      // F1-P1：记录 assistant 事件 + 回合收尾 + 落库
      seqs.pendingMsgSeqs.push(recorder.add(assistantMessageEvent(asstContent, out.usage ?? undefined, stopReason, lineageIdx, turnBranch)))
      recorder.add(turnEndEvent(turn, 'completed'))
      if (!flushTurnEvents()) return false
      emit(opts, {
        type: 'chat_done',
        ...(out.usage ? { inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens } : {}),
      })
      deps.markCompleted()
      // Z-P1-2：regenerate 成功才激活新分支（失败/中断的半截组已被遮蔽，激活会归因到幽灵组）
      if (opts.regenerate) activeBranchByBook.set(opts.bookName, opts.regenerate.branchId)
      // B1+B2：溢出 → checkpoint 压缩优先（chat_done 先发，不被摘要调用拖住）
      await finalizeHistory(opts, history, seqs.msgSeqs, recorder, sys, state, deps.promptFiles)
      return true
    }

    // 有工具调用 → assistant 消息按 block 结构入历史
    // reasoning 块保留回传（DeepSeek/Kimi 多轮带 tools 硬要求，方案 §4.2）
    const asstBlocks: ContentBlock[] = []
    if (text) asstBlocks.push({ type: 'text', text })
    if (reasoning) {
      // Responses 线缺口 11：加密推理项随 reasoning 块入历史（同无工具路径）
      asstBlocks.push({
        type: 'reasoning',
        text: reasoning,
        ...(reasoningEncrypted ? { encrypted: reasoningEncrypted, ...(reasoningItemId ? { itemId: reasoningItemId } : {}) } : {}),
      })
    }
    for (const c of toolCalls) {
      asstBlocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
    }
    history.push({ role: 'assistant', content: asstBlocks })
    // F1-P1：assistant 事件（tool_use 在载荷里）+ tool/call 审计事件
    seqs.pendingMsgSeqs.push(recorder.add(assistantMessageEvent(asstBlocks, out.usage ?? undefined, stopReason, lineageIdx, turnBranch)))
    for (const c of toolCalls) recorder.add(toolCallEvent(c.id, c.name, c.input))

    // 执行工具 + 结果按 tool_result block 回填
    const results: ContentBlock[] = []
    for (const call of toolCalls) {
      // R76-13（二十四轮 A 域）：未注册工具直接 isError 回填——TOOL_RISK 缺名时原先
      // 默认 'write' 从严弹确认卡，作者确认的却是一个必然失败的调用（executeChatTool
      // default 分支「未知工具」），确认卡失实。改为不弹卡直接回错误结果（风险面不变：
      // 未知工具本就无执行体；未知工具事件已在上方 toolCallEvent 全量登记，审计不缺）。
      if (TOOL_RISK[call.name] === undefined) {
        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: `未知工具：${call.name}（未注册，无法执行）`,
          isError: true,
        })
        emit(opts, { type: 'chat_tool_result', callId: call.id, summary: `未知工具 ${call.name}`, ok: false })
        continue
      }
      const risk = TOOL_RISK[call.name] ?? 'write'
      if (risk === 'write') {
        emit(opts, { type: 'chat_tool_pending', callId: call.id, name: call.name, input: call.input })
        const ok = await waitConfirm(state, call.id, confirmTimeout)
        if (!ok) {
          // P5-AI（第七轮）：超时与人工取消分开归因——原先 deadline 触发的超时也回
          // 「作者取消了该操作」，对模型归因误导（随后 chat_error 才给正确文案）
          const timedOut = state.confirmTimedOut?.has(call.id) ?? false
          results.push({
            type: 'tool_result',
            toolUseId: call.id,
            content: timedOut ? '确认超时，本次操作未执行（可重发指令）。' : '作者取消了该操作。',
            isError: true,
          })
          emit(opts, { type: 'chat_tool_result', callId: call.id, summary: timedOut ? '确认超时' : '已取消', ok: false })
          continue
        }
      }
      emit(opts, { type: 'chat_tool', callId: call.id, name: call.name, input: call.input })
      const r = await executeChatTool(call, opts, state.ctrl.signal)
      results.push({ type: 'tool_result', toolUseId: call.id, content: r.summary, isError: !r.ok })
      emit(opts, { type: 'chat_tool_result', callId: call.id, summary: r.summary, ok: r.ok })
    }
    history.push({ role: 'user', content: results })
    // F1-P1：tool/result 事件（每条 tool_result block 一个事件，合成一条 user 消息的 seqs）
    // F1-P4：regenerate 回合同样带分支元数据——否则 tool/result 无 branchId 会落在组外，
    // selectBranch 只保留组内+祖先链，带工具调用的变体在分支视图里丢工具往返
    const resultIdxs: number[] = []
    for (const rb of results) {
      if (rb.type === 'tool_result') {
        resultIdxs.push(recorder.add(toolResultEvent(rb.toolUseId, rb.content, rb.isError, turnBranch)))
      }
    }
    seqs.pendingMsgSeqs.push(resultIdxs)
    recorder.add(turnEndEvent(turn, 'completed'))
    if (!flushTurnEvents()) return false
  }

  // 轮数触顶——补固定收尾文案
  emit(opts, { type: 'chat_turn', turn: MAX_AGENT_TURNS })
  const closingMsg = '已达到单次对话的工具调用上限，先到这里——你可以基于以上结果继续提问。'
  emit(opts, { type: 'chat_text', text: closingMsg })
  // P1-R1b：收尾文案入历史（防末尾 user(tool_result) + 下次 user → 连续 user → Anthropic 400）
  history.push({ role: 'assistant', content: closingMsg })
  // F1-P1：事件记录 + 落库 + trim 遮蔽（与无工具完成路径一致）
  // F1-P4：收尾 assistant 也进同一变体组（regenerate 轮数触顶时整回合不丢出分支视图）
  seqs.pendingMsgSeqs.push(recorder.add(assistantMessageEvent(closingMsg, undefined, undefined, undefined, turnBranch)))
  // CC-P2-1：触顶收尾记 turn 5 的终态（与上方 chat_turn emit 的 turn=MAX_AGENT_TURNS 同口径）——
  // 此前记 MAX_AGENT_TURNS-1 会把循环内已记 completed 的最后一轮再关一次，同轮双终态
  recorder.add(turnEndEvent(MAX_AGENT_TURNS, 'max-turns'))
  if (!flushTurnEvents()) return false
  emit(opts, { type: 'chat_done' })
  deps.markCompleted()
  // Z-P1-2：轮数触顶收尾也属正常完成——同口径激活新分支
  if (opts.regenerate) activeBranchByBook.set(opts.bookName, opts.regenerate.branchId)
  // B1+B2：溢出 → checkpoint 压缩优先（同无工具完成路径）
  await finalizeHistory(opts, history, seqs.msgSeqs, recorder, sys, state, deps.promptFiles)
  return true
}
