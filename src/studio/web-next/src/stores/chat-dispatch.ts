/**
 * RC 源码重审 B-5（Opus-5.5 轮）：对话 SSE 事件分发状态机独立成模块。
 *
 * 为什么独立：这是 chat store 内最厚的一块纯逻辑——`dispatch` 的 11 个 `chat_*`
 * 事件分支（running/在途气泡索引/工具卡片/回合收尾）加上其操作的消息模型与工具卡片
 * 状态机（ensureTool/updateTool/trimMessages/clipToolInput），原本与历史种子化、分支
 * 切换、重新生成同处一个 758 行 store 文件；事件分支只能经 store 外壳间接行使（每条
 * 支路都要 setActivePinia + 造 store + 绕过 pinia 状态），直测成本高。抽出后状态机
 * 零 pinia 依赖、依赖全经 ChatDispatchDeps 注入，可独立单测
 * （见 test/studio/webnext/chat-dispatch-state-machine.test.ts）。
 *
 * 边界（留在 stores/chat.ts 的职责）：网络面（seedHistory/switchBranch/regenerate
 * 的拉取与代次守卫）、store 外壳（defineStore 与对外返回面）、章号语境
 * （chapterMemo/selectedChapter）。本模块不 import api 层、不 import chat.ts
 * （单向：chat → chat-dispatch，勿反向，防模块级循环依赖）。
 *
 * 语义零变化：代码与注释逐行搬迁，仅把 store 内四个可变本地量
 * （currentIdx/pendingReseed/regenPending/regenBook）收进 ChatTurnState 句柄
 * ——store 与状态机共享同一份，读写口不变。
 */
import type { Ref } from 'vue'
import { str } from './sse-guards'
import { CHAT_HISTORY_LIMIT } from '../shared/chat-history'
// 复审-0914-优化 A2：码位计数收编根 src/shared/text.ts 单源（跨包引用对齐
// shared/words.ts 引 format/words 先例；原本地副本删）。
import { codePointLength } from '../../../../shared/text'

/** 工具卡片状态 */
export type ToolStatus = 'pending' | 'running' | 'ok' | 'failed' | 'cancelled'

/** 工具卡片 */
export interface ToolCard {
  callId: string
  name: string
  input: unknown
  status: ToolStatus
  summary?: string
}

/** 聊天消息气泡（文本 + 关联工具卡片按时序穿插） */
export interface ChatMessage {
  /** 稳定唯一 id（v-for key 用，防裁剪/弹出后索引错位导致动画重播） */
  id: string
  role: 'user' | 'assistant'
  content: string
  done: boolean
  /** 本回合的工具卡片（按时序） */
  tools: ToolCard[]
  /** G1：该消息事件 seq（历史种子化时取 seqs[i][0]；实时 SSE 消息无此字段） */
  seq?: number
}

/** 消息列表上限（防长对话内存膨胀；R0912-3 #10：单源 shared/chat-history——原硬编码
 *  200 与 fetchChatHistory 尾窗 limit / ChatMessages 截断提示三处各自为政曾失同步） */
const MAX_MESSAGES = CHAT_HISTORY_LIMIT

/** 工具入参落存截断上限（码位）。内存闸（2026-08-24 审计 C3）：工具卡 input 是
 *  整章正文级文本（如 write_chapter 的正文入参），原样入 store 常驻——列表上限只
 *  限消息条数不限体积（200 条 × 全文章节 = MB 级驻留）。落存前统一截到 2000 码位
 *  + … 尾标（方案原文写 ToolCard.summary，以实际字段为准 = input）。 */
const TOOL_INPUT_MAX = 2000

/** 码位截断（口径同 src/process/summary.ts clipByCodePoints：Array.from 迭代码点——
 *  String.slice 按 UTF-16 码元会把增补平面字符切成半个代理对） */
function clipByCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('')
}

/** 内存闸（2026-08-24 审计 C3）：工具入参落存前截断——SSE 两条路（chat_tool_pending
 *  追加 / readonly chat_tool 经 ensureTool 补建）与历史种子化（seedFromHistory 的
 *  tool_use）三处收口。字符串超限 → 截断 + …；对象序列化后超限才替换为截断串
 *  （小对象原形落存，不动既有展示与断言口径）；其余类型原样透传。 */
export function clipToolInput(input: unknown): unknown {
  let text: string
  if (typeof input === 'string') {
    text = input
  } else {
    try {
      text = JSON.stringify(input) ?? ''
    } catch {
      return input // 循环引用等不可序列化：原样透传（不为此抛错）
    }
  }
  return codePointLength(text) > TOOL_INPUT_MAX ? clipByCodePoints(text, TOOL_INPUT_MAX) + '…' : input
}

/** 自增序列——生成稳定消息 id（不用 crypto.randomUUID 避免 happy-dom 兼容问题） */
let _msgSeq = 0

/** 取下一个稳定消息 id（`m<N>` 格式与计数器单源：本模块与 store 的 pushUser/
 *  seedFromHistory 共用一个序列，防两处各自起号撞 id）。 */
export function nextMsgId(): string {
  return `m${_msgSeq++}`
}

/** RC 源码重审 B-5：在途回合的宿主状态——原 chat store setup 内的四个可变本地量
 *  （currentIdx/pendingReseed/regenPending/regenBook）随事件分发状态机迁入本类型；
 *  store 与状态机共享同一实例（读写口与原本地量逐位等价）。 */
export interface ChatTurnState {
  /** 当前正在填充的 assistant 气泡索引（chat_text 追加目标） */
  currentIdx: number
  /** Y-P2-5：待补种书名（Q-8/R70-30 登记，回合收尾 running 翻 false 后补种） */
  pendingReseed: string | null
  /** G1：重新生成进行中（防重入；POST 成功后保持 true 直到 chat_done/chat_error 复位） */
  regenPending: boolean
  /** G1：重新生成的书名（chat_done 时 best-effort 刷新分支列表用） */
  regenBook: string | null
}

/** 建初始回合状态（默认值单源——原四个本地量的初值：currentIdx=-1、其余空） */
export function createChatTurnState(): ChatTurnState {
  return { currentIdx: -1, pendingReseed: null, regenPending: false, regenBook: null }
}

/** 事件分发状态机的宿主依赖面（store 注入；本模块不自行取 store/pinia）。
 *  注：在途回合状态（ChatTurnState）由 store 与状态机共享同一份（见该类型注）。 */
export interface ChatDispatchDeps {
  /** 消息列表（store 对外暴露的同一 ref） */
  messages: Ref<ChatMessage[]>
  /** 对话进行中 */
  running: Ref<boolean>
  /** 最近一次错误 */
  error: Ref<string | null>
  /** 最近一次失败回合作者原文（chat_error echo 字段） */
  errorEcho: Ref<string | null>
  /** 非错误提示（如「消息已入队，当前对话结束后处理」） */
  notice: Ref<string | null>
  /** 在途回合宿主状态（与 store 共享） */
  turn: ChatTurnState
  // R70-30：sync 事件不带书名——延迟取 workspace store 当前书（pinia 惰性激活防循环引用）
  wsBookName: () => string | null
  /** G1：best-effort 刷新分支列表（chat_done 收尾用） */
  refreshBranches: (bookName: string, gen: number) => void
  /** 观测现行种子化代（store 的 seedGen.current()——regenPending 复位后刷分支用） */
  currentGen: () => number
}

/** 状态机对外操作面：事件分发 + 工具卡片状态机 + 消息裁剪（store 转发面不变）。 */
export interface ChatDispatch {
  /** 分派一条 chat_* SSE 事件 */
  dispatch(ev: { type: string; [k: string]: unknown }): void
  /** 确保工具卡片存在（readonly 工具不经 pending，chat_tool 时补建） */
  ensureTool(callId: string, name: string, input: unknown): void
  /** 更新工具卡片状态 */
  updateTool(callId: string, patch: Partial<ToolCard>): void
  /** 裁剪最旧消息，保持列表不超过上限（在 push / chat_done 后调） */
  trimMessages(): void
}

/** RC 源码重审 B-5：建事件分发状态机。全部外部状态经 deps 注入（零 pinia 依赖，
 *  便于脱离 store 直测）；内部实现 = 原 stores/chat.ts 的 dispatch/ensureTool/
 *  updateTool/trimMessages 逐行搬迁（各支路沿革注释随迁）。 */
export function createChatDispatch(deps: ChatDispatchDeps): ChatDispatch {
  const { messages, running, error, errorEcho, notice, turn, wsBookName, refreshBranches, currentGen } = deps

  /** 分派一条 chat_* SSE 事件 */
  function dispatch(ev: { type: string; [k: string]: unknown }): void {
    switch (ev.type) {
      case 'sync': {
        // 连接快照（SSE 重连补发）：同步后端真实 chat 运行态，防断连错过 chat_done 致永久锁死
        running.value = ev['chatRunning'] === true
        // 重评2-P2-1（2026-09-09 全量重评 GLM-5.3）修复：重连快照 chatRunning=false = 后端
        // 已收尾该回合，是前端漏收 chat_done/chat_error 的兜底信号——对齐 chat_error 的
        // R-7 口径收尾在途气泡（done + 复位索引），防永久「生成中」+ 后续文本错位；同时
        // 守住 P2-9 前提「未完成气泡只属于在途回合」（否则此后新回合 + 错过 chat_turn 的
        // 重连会把新回合文本追加进旧气泡，跨回合并文）。
        if (!running.value && turn.currentIdx >= 0) {
          messages.value[turn.currentIdx]!.done = true
          turn.currentIdx = -1
        }
        // AA-P3-8：regenPending 陷阱态恢复——regenPending 只由 chat_done/chat_error 复位，
        // 若 SSE 全断且这两者都没到，防重入标志永久卡死「重新生成」。重连的 sync 是权威
        // 快照：后端不在跑对话（chatRunning=false）→ 那次 regenerate 的回合要么从未启动、
        // 要么已结束（chat_done 已消费掉但前端没收到）→ 必须复位标志，允许再次触发。
        if (!running.value && turn.regenPending) {
          turn.regenPending = false
          turn.regenBook = null
        }
        // P2-9：重连时 sync 只补发 chatRunning（0918独立重评修复批 E001 起：chat 腿活跃时
        // 服务端另发 chat_replay_begin + ring 回放重建在途回合，见该分支）——若旧 currentIdx
        // 已随回合结束失效，找到最后一个未 done 的 assistant 气泡重建索引（否则 chat_text
        // 追加到错误气泡或被静默丢弃）
        if (running.value && (turn.currentIdx < 0 || messages.value[turn.currentIdx]?.done)) {
          // 反向找最后一个未 done 的 assistant 气泡（lib=ES2022 无 findLastIndex，手写循环）
          let lastUndone = -1
          for (let i = messages.value.length - 1; i >= 0; i--) {
            const m = messages.value[i]
            if (m && m.role === 'assistant' && !m.done) {
              lastUndone = i
              break
            }
          }
          turn.currentIdx = lastUndone
          // R70-30（十八轮）：running=true 但无可续气泡（seedHistory 先于 sync 到达的
          // 时序边界）——在途回合的 chat_text 会因 currentIdx=-1 全部被丢且 chat_done
          // 后无人补种（Q-8 只覆盖「clear 时在跑」反向序）；登记 pendingReseed 由
          // 回合收尾补种（事件库无损，此处纯展示缺口的自愈）
          if (lastUndone === -1 && wsBookName()) turn.pendingReseed = wsBookName()
        }
        break
      }
      case 'chat_replay_begin': {
        // 0918独立重评修复批（E001）：SSE 重连回放序列头锚（无载荷）——服务端仅在 chat 腿
        // 活跃且 ring 非空时、于回放数组最前发一次（每个新消费者各得一次），随后重放 chat 腿
        // ring（chat_start/chat_turn/chat_text/... 可能从头重建整回合）。此前 chat_turn 无条件
        // push 新气泡：重连回放会在断连前已存在的在途气泡之后再 push 一条 → 气泡重复；ring
        // 截断（cap 溢出）时孤儿气泡永久滞留。rebuild 模式：移除未 done 的 assistant 在途
        // 气泡（不动 done 历史与 user 消息）+ 复位 currentIdx + 登记 pendingReseed（复用
        // R70-30/Q-8 既有自愈通道——回合收尾 chat_done/chat_error 后 running 翻 false 触发
        // seedHistory(replace:true) 从事件库重播种；ring 截断导致的回合展示不全由此自愈，
        // 与刷新路径同口径）。设计意图：重连后视图状态 = 等价新连接（历史保留，在途回合
        // 由回放重建）。
        for (let i = messages.value.length - 1; i >= 0; i--) {
          const m = messages.value[i]!
          if (m.role === 'assistant' && !m.done) {
            messages.value.splice(i, 1)
            break // P2-9 不变式「未完成气泡只属于在途回合」：至多一条，命中即止
          }
        }
        turn.currentIdx = -1
        const replayBook = wsBookName()
        if (replayBook) turn.pendingReseed = replayBook
        break
      }
      case 'chat_start': {
        running.value = true
        error.value = null
        errorEcho.value = null
        notice.value = null
        break
      }
      case 'chat_turn': {
        // 新回合 = 新 assistant 气泡
        messages.value.push({ id: nextMsgId(), role: 'assistant', content: '', done: false, tools: [] })
        turn.currentIdx = messages.value.length - 1
        // 0918二轮修复批（E103）：推新气泡即修剪——原 trimMessages 只挂在 chat_done /
        // pushUser / seedFromHistory 三处收尾，单次长跑（多回合工具链连转）超上限要等
        // 整跑结束才裁剪，期间消息条数无界膨胀。trimMessages 只裁头部并同步偏移
        // currentIdx，刚 push 的在途回合气泡恒在尾部不受影响（上限 ≥1 时裁剪永远够不到）。
        trimMessages()
        break
      }
      case 'chat_text': {
        const text = str(ev['text'])
        if (text && turn.currentIdx >= 0) {
          messages.value[turn.currentIdx]!.content += text
        }
        break
      }
      case 'chat_tool_pending': {
        const callId = str(ev['callId'])
        const name = str(ev['name'])
        if (callId && name && turn.currentIdx >= 0) {
          // C3：入参落存前截断（整章正文级 input 不得原样常驻）
          messages.value[turn.currentIdx]!.tools.push({
            callId,
            name,
            input: clipToolInput(ev['input']),
            status: 'pending',
          })
        }
        break
      }
      case 'chat_tool': {
        // readonly 工具不经 pending 直接 tool → 创建卡片
        const callId = str(ev['callId'])
        const name = str(ev['name'])
        if (callId && name) {
          ensureTool(callId, name, ev['input'])
          updateTool(callId, { status: 'running' })
        }
        break
      }
      case 'chat_tool_result': {
        const callId = str(ev['callId'])
        if (callId) {
          // R-6（十五轮登记销账）：失败结果标 failed 对齐种子化路径同口径；
          // cancelled 仅保留给「无 tool_result 回填」的兜底语义（异常中断 ≠ 工具执行失败）
          updateTool(callId, {
            status: ev['ok'] === true ? 'ok' : 'failed',
            ...(str(ev['summary']) ? { summary: str(ev['summary']) } : {}),
          })
        }
        break
      }
      case 'chat_reset': {
        // 重试防拼接：清当前回合的文本和工具卡片（旧工具结果不残留）
        if (turn.currentIdx >= 0) {
          messages.value[turn.currentIdx]!.content = ''
          messages.value[turn.currentIdx]!.tools = []
        }
        break
      }
      case 'chat_done': {
        running.value = false
        if (turn.currentIdx >= 0) {
          messages.value[turn.currentIdx]!.done = true
        }
        // P2-9：回合结束即失效 currentIdx——旧索引指向已 done 气泡会让后续 chat_text
        //（含重连回放重建的新回合）追加错误位置
        turn.currentIdx = -1
        trimMessages()
        // G1：重新生成的回合结束 → 复位进行中标志 + best-effort 刷新分支列表（变体计数更新）
        if (turn.regenPending) {
          turn.regenPending = false
          const book = turn.regenBook
          turn.regenBook = null
          if (book) refreshBranches(book, currentGen())
        }
        break
      }
      case 'chat_error': {
        running.value = false
        error.value = str(ev['error']) ?? '未知错误'
        // 0918三拍板批（A006 轻量档）：回显作者原文（服务端回滚后仅存于此，供复制重发；
        // regenerate 回合无 echo 字段——原文本就在历史尾气泡里）
        errorEcho.value = str(ev['echo']) || null
        // 0918独立重评修复批（E005）：对齐 chat_start「error+notice 双清」口径——回合异常
        // 中断时旧 notice（如「已入队」）随之失效，不得残挂在错误态旁。chat_done 不清：
        // 正常收尾下 notice 可能是刚提示的「已入队，当前对话结束后处理」，清掉会让它在
        // done → 下一回合 chat_start 的间隙提前消失（chat_start 开跑时自清）
        notice.value = null
        // R-7（第十六轮）：收尾在途气泡（对齐 chat_done 口径）——异常中断时 currentIdx
        // 指向的未完成 assistant 气泡置 done + 复位索引，防永久「生成中」+ 后续文本错位
        if (turn.currentIdx >= 0) {
          messages.value[turn.currentIdx]!.done = true
        }
        turn.currentIdx = -1
        // G1：重新生成回合异常中断 → 复位防重入标志（防永久锁死，可再次触发）
        if (turn.regenPending) {
          turn.regenPending = false
          turn.regenBook = null
        }
        break
      }
      case 'notice': {
        // AA-P3-1：队列超容丢弃最旧消息等非错误提示（与「已加入队列」同通道展示）
        const msg = str(ev['message'])
        if (msg) notice.value = msg
        break
      }
    }
  }

  /** 确保工具卡片存在（readonly 工具不经 pending，chat_tool 时补建） */
  function ensureTool(callId: string, name: string, input: unknown): void {
    if (turn.currentIdx < 0) return
    const tools = messages.value[turn.currentIdx]!.tools
    if (!tools.some((t) => t.callId === callId)) {
      // C3：readonly 工具补建卡片同样走截断收口
      tools.push({ callId, name, input: clipToolInput(input), status: 'pending' })
    }
  }

  /** 更新工具卡片状态 */
  function updateTool(callId: string, patch: Partial<ToolCard>): void {
    // R62-19：反向遍历取最近的同 callId 卡——SSE 的 updateTool 与种子化 applySeedToolResult
    // 原先一个正向首个、一个反向最近，callId 跨回合重复时同事件打在两张卡上（状态错乱）。
    // 统一反向：新回合的事件精确落回本回合卡片（旧回合卡是历史只读呈现）。
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const tool = messages.value[i]!.tools.find((t) => t.callId === callId)
      if (tool) {
        Object.assign(tool, patch)
        return
      }
    }
  }

  /** 裁剪最旧消息，保持列表不超过上限（在 push / chat_done 后调） */
  function trimMessages(): void {
    if (messages.value.length > MAX_MESSAGES) {
      const cut = messages.value.length - MAX_MESSAGES
      messages.value.splice(0, cut)
      // 防御性修正：splice 从头部删后 currentIdx 偏移
      if (turn.currentIdx >= 0) turn.currentIdx = Math.max(-1, turn.currentIdx - cut)
    }
  }

  return { dispatch, ensureTool, updateTool, trimMessages }
}
