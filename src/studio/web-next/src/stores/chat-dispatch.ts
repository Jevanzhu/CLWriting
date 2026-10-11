/**
 * 对话 SSE 事件分发状态机（独立模块）。
 *
 * 为什么独立：这是 chat store 内最厚的一块纯逻辑——`dispatch` 的 11 个 `chat_*` 事件分支
 *（running/在途气泡索引/工具卡片/回合收尾）加上其操作的消息模型与工具卡片状态机
 *（ensureTool/updateTool/trimMessages/clipToolInput）；留在 store 里时每条支路都要
 * setActivePinia + 造 store + 绕过 pinia 状态，直测成本高。抽出后状态机零 pinia 依赖、依赖全经
 * ChatDispatchDeps 注入，可独立单测（test/studio/webnext/chat-dispatch-state-machine.test.ts）。
 *
 * 边界（留在 stores/chat.ts）：网络面（seedHistory/switchBranch/regenerate 的拉取与代次守卫）、
 * store 外壳（defineStore 与对外返回面）、章号语境（chapterMemo/selectedChapter）。
 * 不变量：本模块不 import api 层、不 import chat.ts（单向 chat → chat-dispatch，勿反向，防模块级
 * 循环依赖）。store 内四个可变本地量（currentIdx/pendingReseed/regenPending/regenBook）收进
 * ChatTurnState 句柄，store 与状态机共享同一份，读写口不变。
 *
 * 在途回合目标持消息对象的响应式引用（ChatTurnState.current）而非数组下标——下标是派生信息，
 * 任何裁剪/过滤/截断漏重定位就把增量写进别的消息，且 `!` 断言让越界在类型层不可见；引用天然
 * 跟随消息在数组中的位移，写侧显式判空分支取代全部 `messages.value[turn.currentIdx]!` 形态。
 */
import type { Ref } from 'vue'
import { str } from './sse-guards'
import { CHAT_HISTORY_LIMIT } from '../shared/chat-history'
// -优化：码位计数与截断收编根 src/shared/text.ts 单源（跨包引用对齐
// shared/words.ts 引 format/words 先例；原本地副本删）。
import { codePointLength, clipByCodePoints } from '../../../../shared/text'
// 对话正文闸额度单源（跨包契约底座 src/shared/contract/studio.ts 的显式别名，值锚
// SSE_BACKPRESSURE_LIMIT）：单条消息上限与列表正文总量上限同额（同一锚值）。与 workbench
// MAX_TEXT_OUT 同源同值——两处封的是同一物（一次生成的 AI 正文），否则同一条正文在生成
// 面板可显示、在对话面板被截。计量单位 = 码点（workbench 按 UTF-16 码元，单位不同故不并名）。
// 为什么 chat 侧也要同额：本闸不是常态路径闸（一章正文数千字，离封顶差两个数量级），是
// 极端形态闸——SSE 网关重放/事件风暴致单条气泡无界拼接、或整章正文级回复原样驻留（条数闸
// 只封条数，封不住单条体积；条数 × 单条无界 = 无界）。
import { MAX_TEXT_POINTS } from '../../../../shared/contract/studio'

/** 状态机对外操作面：事件分发 + 工具卡片状态机 + 消息裁剪（store 转发面不变）。 */
export type ToolStatus = 'pending' | 'running' | 'ok' | 'failed' | 'cancelled'

/** 状态机对外操作面：事件分发 + 工具卡片状态机 + 消息裁剪（store 转发面不变）。 */
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
  /** 该消息事件 seq（历史种子化时取 seqs[i][0]；实时 SSE 消息无此字段） */
  seq?: number
  /** 正文本闸截断时被省略的码点数（未截断缺省）——截断标记文案的累计源：
   *  已截断消息的 content 恒 = 保留段 + clipSuffix(clipped)，其后增量只累计本值。 */
  clipped?: number
}

/** 消息列表上限（防长对话内存膨胀；#10：单源 shared/chat-history——原硬编码
 *  200 与 fetchChatHistory 尾窗 limit / ChatMessages 截断提示三处各自为政曾失同步） */
const MAX_MESSAGES = CHAT_HISTORY_LIMIT

/** 正文截断标记（尾部省略 + 原文码点总数）——截断必须可判别：作者/审计不得把保留段
 *  误读为全文。红线段：标记是 clipped 的确定性函数（已截断消息重写标记幂等，
 *  content 恒 = 保留段 + clipSuffix(clipped)），不依赖外部状态。 */
function clipSuffix(omitted: number): string {
  return `\n…（正文超长已截断：原文 ${MAX_TEXT_POINTS + omitted} 码点，尾部 ${omitted} 码点已省略）`
}

/** 单条消息正文过闸（种子化 / pushUser / 历史消息路径收口；chat_text 增量见 appendContent）：
 *  未超限原样不动；超限保头 MAX_TEXT_POINTS 码点 + 尾部截断标记。
 *  保留方向取头（与 workbench MAX_TEXT_OUT 的保尾不同）：该处是「一次生成的聚合缓冲」
 *  （头部已滚出视野，最新段才有用），此处是「一条消息的展示文本」（作者从头读起，
 *  头部是正文主体，尾部标记标明何处被省略）；同源的是额度与「超限才截、未超限零改动」
 *  的口径，保留方向按各自展示语义取。 */
function clipContent(m: ChatMessage): void {
  if (m.clipped !== undefined) return
  const points = codePointLength(m.content)
  if (points <= MAX_TEXT_POINTS) return
  const omitted = points - MAX_TEXT_POINTS
  m.clipped = omitted
  m.content = clipByCodePoints(m.content, MAX_TEXT_POINTS) + clipSuffix(omitted)
}

/** 正文增量落存（单条闸唯一收口）：未截断 → 拼接后过闸；已截断 → 保留段不再增长，
 *  增量只累计省略数并重写标记（每次增量恒定代价，不重切大串）。 */
function appendContent(m: ChatMessage, text: string): void {
  if (m.clipped !== undefined) {
    const kept = m.content.slice(0, m.content.length - clipSuffix(m.clipped).length)
    m.clipped += codePointLength(text)
    m.content = kept + clipSuffix(m.clipped)
    return
  }
  const next = m.content + text
  const points = codePointLength(next)
  if (points <= MAX_TEXT_POINTS) {
    m.content = next
    return
  }
  const omitted = points - MAX_TEXT_POINTS
  m.clipped = omitted
  m.content = clipByCodePoints(next, MAX_TEXT_POINTS) + clipSuffix(omitted)
}

/** 工具入参落存截断上限（码位）。内存闸（审计）：工具卡 input 是
 *  整章正文级文本（如 write_chapter 的正文入参），原样入 store 常驻——列表上限只
 *  限消息条数不限体积（200 条 × 全文章节 = MB 级驻留）。落存前统一截到 2000 码位
 *  + … 尾标（方案原文写 ToolCard.summary，以实际字段为准 = input）。 */
const TOOL_INPUT_MAX = 2000

/** 序列化探测：不可序列化（循环引用等）回 null——调用方原样透传，不为此抛错。 */
function serialize(input: unknown): string | null {
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    return null
  }
}

/** 超限才截断（+ … 尾标）；未超限原样返回。 */
function clipOver(text: string, max: number): string {
  return codePointLength(text) > max ? clipByCodePoints(text, max) + '…' : text
}

/** 内存闸（审计质量评审收口）：工具入参落存前截断
 *  ——SSE 两条路（chat_tool_pending 追加 / readonly chat_tool 经 ensureTool 补建）与
 *  历史种子化（seedFromHistory 的 tool_use）三处收口。未超闸一律原形落存。
 *  对象走**字段级**截断：额度按键数均分、键结构完整保留——工具卡摘要按字段取值，
 *  整串截断会把 input 落成半截 JSON 串、摘要整条落空，而超限入参恰是最需要作者核对
 *  的长改写指令 / 整章正文。字段级不成立（无字符串字段可截 / 截断后仍超闸）才退回
 *  整串截断，闸恒为准。 */
export function clipToolInput(input: unknown): unknown {
  const whole = typeof input === 'string' ? input : serialize(input)
  if (whole === null) return input // 循环引用等不可序列化：原样透传（不为此抛错）
  if (codePointLength(whole) <= TOOL_INPUT_MAX) return input
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const fields = clipFields(input as Record<string, unknown>)
    if (fields !== null) return fields
  }
  return clipByCodePoints(whole, TOOL_INPUT_MAX) + '…'
}

/** 字段级截断（额度按键数均分；未发生截断或截断后仍超闸 → null，交调用方整串截断） */
function clipFields(obj: Record<string, unknown>): Record<string, unknown> | null {
  const keys = Object.keys(obj)
  if (keys.length === 0) return null
  const per = Math.max(1, Math.floor(TOOL_INPUT_MAX / keys.length))
  const out: Record<string, unknown> = {}
  let clipped = false
  for (const k of keys) {
    const v = obj[k]
    if (typeof v !== 'string') {
      out[k] = v
      continue
    }
    const c = clipOver(v, per)
    if (c !== v) clipped = true
    out[k] = c
  }
  if (!clipped) return null
  const text = serialize(out)
  return text !== null && codePointLength(text) <= TOOL_INPUT_MAX ? out : null
}

/** 自增序列——生成稳定消息 id（不用 crypto.randomUUID 避免 happy-dom 兼容问题） */
let _msgSeq = 0

/** 取下一个稳定消息 id（`m<N>` 格式与计数器单源：本模块与 store 的 pushUser/
 *  seedFromHistory 共用一个序列，防两处各自起号撞 id）。 */
export function nextMsgId(): string {
  return `m${_msgSeq++}`
}

/** RC：在途回合的宿主状态——原 chat store setup 内的四个可变本地量
 *  （currentIdx/pendingReseed/regenPending/regenBook）随事件分发状态机迁入本类型；
 *  store 与状态机共享同一实例（读写口与原本地量逐位等价）。
 * currentIdx（数组下标）改持在途回合气泡的响应式对象引用（current）
 *  ——裁剪/过滤/截断后目标自动跟随，不再依赖各变动点手工重定位。 */
export interface ChatTurnState {
  /** 当前正在填充的 assistant 气泡（chat_text/工具卡的追加目标）。持响应式引用
   *  （须与 messages 数组内元素同一代理，否则增量写绕开深层代理不触达 UI）；
   *  chat_turn 建立，chat_done/chat_error/sync 收尾置 null。目标若被移除而未复位，
   *  写侧判空分支使增量落入已出列的僵尸对象——只丢不串（改前下标越界是写进别的消息）。 */
  current: ChatMessage | null
  /** 待补种书名（登记，回合收尾 running 翻 false 后补种） */
  pendingReseed: string | null
  /** 重新生成进行中（防重入；POST 成功后保持 true 直到 chat_done/chat_error 复位） */
  regenPending: boolean
  /** 重新生成的书名（chat_done 时 best-effort 刷新分支列表用） */
  regenBook: string | null
}

/** 建初始回合状态（默认值单源——原四个本地量的初值：current 空、其余空） */
export function createChatTurnState(): ChatTurnState {
  return { current: null, pendingReseed: null, regenPending: false, regenBook: null }
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
  // sync 事件不带书名——延迟取 workspace store 当前书（pinia 惰性激活防循环引用）
  wsBookName: () => string | null
  /** best-effort 刷新分支列表（chat_done 收尾用） */
  refreshBranches: (bookName: string, gen: number) => void
  /** 观测现行种子化代（store 的 seedGen.current——regenPending 复位后刷分支用） */
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

/** RC：建事件分发状态机。全部外部状态经 deps 注入（零 pinia 依赖，
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
        // 修复：重连快照 chatRunning=false = 后端
        // 已收尾该回合，是前端漏收 chat_done/chat_error 的兜底信号——对齐 chat_error 的
        // 口径收尾在途气泡（done + 复位引用），防永久「生成中」+ 后续文本错位；同时
        // 守住前提「未完成气泡只属于在途回合」（否则此后新回合 + 错过 chat_turn 的
        // 重连会把新回合文本追加进旧气泡，跨回合并文）。
        if (!running.value && turn.current) {
          turn.current.done = true
          turn.current = null
        }
        // regenPending 陷阱态恢复——regenPending 只由 chat_done/chat_error 复位，
        // 若 SSE 全断且这两者都没到，防重入标志永久卡死「重新生成」。重连的 sync 是权威
        // 快照：后端不在跑对话（chatRunning=false）→ 那次 regenerate 的回合要么从未启动、
        // 要么已结束（chat_done 已消费掉但前端没收到）→ 必须复位标志，允许再次触发。
        if (!running.value && turn.regenPending) {
          turn.regenPending = false
          turn.regenBook = null
        }
        // 重连时 sync 只补发 chatRunning（起：chat 腿活跃时
        // 服务端另发 chat_replay_begin + ring 回放重建在途回合，见该分支）——若回合引用
        // 已随回合结束失效，找到最后一个未 done 的 assistant 气泡重建引用（否则 chat_text
        // 增量追加到错误气泡或被静默丢弃）
        if (running.value && (!turn.current || turn.current.done)) {
          // 反向找最后一个未 done 的 assistant 气泡（lib=ES2022 无 findLastIndex，手写循环）
          let lastUndone: ChatMessage | null = null
          for (let i = messages.value.length - 1; i >= 0; i--) {
            const m = messages.value[i]
            if (m && m.role === 'assistant' && !m.done) {
              lastUndone = m
              break
            }
          }
          turn.current = lastUndone
          // running=true 但无可续气泡（seedHistory 先于 sync 到达的
          // 时序边界）——在途回合的 chat_text 会因目标为空全部被丢且 chat_done 后无人
          // 补种（只覆盖「clear 时在跑」反向序）；登记 pendingReseed 由回合收尾补种
          //（事件库无损，此处纯展示缺口的自愈）
          if (!lastUndone && wsBookName()) turn.pendingReseed = wsBookName()
        }
        break
      }
      case 'chat_replay_begin': {
        // SSE 重连回放序列头锚（无载荷）——服务端仅在 chat 腿
        // 活跃且 ring 非空时、于回放数组最前发一次（每个新消费者各得一次），随后重放 chat 腿
        // ring（chat_start/chat_turn/chat_text/... 可能从头重建整回合）。此前 chat_turn 无条件
        // push 新气泡：重连回放会在断连前已存在的在途气泡之后再 push 一条 → 气泡重复；ring
        // 截断（cap 溢出）时孤儿气泡永久滞留。rebuild 模式：移除未 done 的 assistant 在途
        // 气泡（不动 done 历史与 user 消息）+ 复位回合引用 + 登记 pendingReseed（复用
        // 既有自愈通道——回合收尾 chat_done/chat_error 后 running 翻 false 触发
        // seedHistory(replace:true) 从事件库重播种；ring 截断导致的回合展示不全由此自愈，
        // 与刷新路径同口径）。设计意图：重连后视图状态 = 等价新连接（历史保留，在途回合
        // 由回放重建）。
        for (let i = messages.value.length - 1; i >= 0; i--) {
          const m = messages.value[i]
          if (m && m.role === 'assistant' && !m.done) {
            messages.value.splice(i, 1)
            break // 不变式「未完成气泡只属于在途回合」：至多一条，命中即止
          }
        }
        // 被移除的正是在途回合气泡——回合引用一并作废（原 currentIdx=-1 同口径）
        turn.current = null
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
        const bubble: ChatMessage = { id: nextMsgId(), role: 'assistant', content: '', done: false, tools: [] }
        messages.value.push(bubble)
        // 持数组内读回的响应式代理而非 push 前的原始对象——增量写须
        // 穿过 messages 的深层代理才触达 UI（Vue 对同元素只包一层，两条读路同引用）
        turn.current = messages.value[messages.value.length - 1] ?? null
        // 推新气泡即修剪——原 trimMessages 只挂在 chat_done /
        // pushUser / seedFromHistory 三处收尾，单次长跑（多回合工具链连转）超上限要等
        // 整跑结束才裁剪，期间消息条数无界膨胀。trimMessages 只裁头部（在途回合目标
        // 持对象引用，位移自动跟随），刚 push 的在途回合气泡恒在尾部不受影响。
        trimMessages()
        break
      }
      case 'chat_text': {
        const text = str(ev['text'])
        const cur = turn.current
        if (text && cur) {
          // 增量落存前过单条正文闸（内存闸：单条气泡正文无界拼接是长会话膨胀的主形态）
          appendContent(cur, text)
        }
        break
      }
      case 'chat_tool_pending': {
        const callId = str(ev['callId'])
        const name = str(ev['name'])
        const cur = turn.current
        if (callId && name && cur) {
          // 入参落存前截断（整章正文级 input 不得原样常驻）
          cur.tools.push({
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
          // 失败结果标 failed 对齐种子化路径同口径；
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
        const cur = turn.current
        if (cur) {
          cur.content = ''
          // 截断账一并归零——否则清空后首条增量会走「已截断」分支（保留段为空，
          // 只挂标记不落正文），重试回合的正文被整段吞掉
          cur.clipped = undefined
          cur.tools = []
        }
        break
      }
      case 'chat_done': {
        running.value = false
        if (turn.current) {
          turn.current.done = true
        }
        // 回合结束即失效回合引用——旧引用指向已 done 气泡会让后续 chat_text
        //（含重连回放重建的新回合）追加错误位置
        turn.current = null
        trimMessages()
        // 重新生成的回合结束 → 复位进行中标志 + best-effort 刷新分支列表（变体计数更新）
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
        // （轻量档）：回显作者原文（服务端回滚后仅存于此，供复制重发
        // regenerate 回合无 echo 字段——原文本就在历史尾气泡里）
        errorEcho.value = str(ev['echo']) || null
        // 对齐 chat_start「error+notice 双清」口径——回合异常
        // 中断时旧 notice（如「已入队」）随之失效，不得残挂在错误态旁。chat_done 不清：
        // 正常收尾下 notice 可能是刚提示的「已入队，当前对话结束后处理」，清掉会让它在
        // done → 下一回合 chat_start 的间隙提前消失（chat_start 开跑时自清）
        notice.value = null
        // 收尾在途气泡（对齐 chat_done 口径）——异常中断时回合引用
        // 指向的未完成 assistant 气泡置 done + 复位引用，防永久「生成中」+ 后续文本错位
        if (turn.current) {
          turn.current.done = true
        }
        turn.current = null
        // 重新生成回合异常中断 → 复位防重入标志（防永久锁死，可再次触发）
        if (turn.regenPending) {
          turn.regenPending = false
          turn.regenBook = null
        }
        break
      }
      case 'notice': {
        // 队列超容丢弃最旧消息等非错误提示（与「已加入队列」同通道展示）
        const msg = str(ev['message'])
        if (msg) notice.value = msg
        break
      }
    }
  }

  /** 确保工具卡片存在（readonly 工具不经 pending，chat_tool 时补建） */
  function ensureTool(callId: string, name: string, input: unknown): void {
    const cur = turn.current
    if (!cur) return
    if (!cur.tools.some((t) => t.callId === callId)) {
      // readonly 工具补建卡片同样走截断收口
      cur.tools.push({ callId, name, input: clipToolInput(input), status: 'pending' })
    }
  }

  /** 更新工具卡片状态 */
  function updateTool(callId: string, patch: Partial<ToolCard>): void {
    // 反向遍历取最近的同 callId 卡——SSE 的 updateTool 与种子化 applySeedToolResult
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

  /** 裁剪最旧消息，保持列表不超过上限（在 push / chat_done 后调）。
   *  顺序固定（不可反，两维闸的取舍都从头部走）：
   *  ① 条数闸——超 MAX_MESSAGES 即头部裁剪（既有逻辑逐位不变）；
   *  ② 单条正文闸——逐条过 MAX_TEXT_POINTS（种子化 / pushUser 的历史消息入口；
   *     chat_text 增量路径在 appendContent 内已过闸，此处幂等）；
   *  ③ 列表正文总量闸——正文总量超 MAX_TEXT_POINTS 时继续从头部丢最旧。
   *  为什么这个顺序：整条丢弃是收益最大的一步（旧回合整体出列），先按条数裁完再对
   *  幸存者过单条闸，避免为即将出列的消息做白工；总量闸放最后，因为它依赖前两步
   *  定型的正文量。 */
  function trimMessages(): void {
    if (messages.value.length > MAX_MESSAGES) {
      const cut = messages.value.length - MAX_MESSAGES
      messages.value.splice(0, cut)
      // 在途回合目标持对象引用——头部裁剪后引用自动跟随，原
      // 「currentIdx 防御性减 cut」的手工偏移随之退役（漏偏移即增量写错位的根源形态）
    }
    trimContent()
  }

  /** 正文两维闸（②③）。计量口径 = 气泡正文码点（与 workbench MAX_TEXT_OUT 的正文
   *  口径对称；工具卡载文另受 TOOL_INPUT_MAX 单卡落存闸）。整条丢弃与条数闸同取舍
   *  （保最新对话）：作者取回全文有两条正路——整条：刷新/切分支经 seedHistory 从
   *  事件库重播种，或审计视图；气泡内截断：尾部标记直接标明原文码点数。恒保留至少
   *  一条，故列表正文总量有界于 MAX_TEXT_POINTS + 标记长度（单条闸恒保证任一条 ≤
   *  该界）；绝不丢在途回合目标（引用身份比对——裁剪只许丢最旧，在途气泡正常居尾，
   *  此断言防未来不变式漂移）。 */
  function trimContent(): void {
    for (const m of messages.value) clipContent(m)
    let total = 0
    for (const m of messages.value) total += codePointLength(m.content)
    let cut = 0
    while (total > MAX_TEXT_POINTS && messages.value.length - cut > 1) {
      const m = messages.value[cut]
      if (!m || m === turn.current) break
      total -= codePointLength(m.content)
      cut++
    }
    if (cut > 0) messages.value.splice(0, cut)
  }

  return { dispatch, ensureTool, updateTool, trimMessages }
}
