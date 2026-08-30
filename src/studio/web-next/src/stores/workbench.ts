import { defineStore } from 'pinia'
import { ref } from 'vue'
import { str, strArr, isSseEvent, isHealPhaseEvent, isHealResultEvent } from './sse-guards'

/**
 * 工作台 store（细案 T3.1 地基）：SSE 事件日志缓冲 + running/connected。
 * T3.2 扩展态机（八阶段/草稿/审稿/rebook 等），T3.1 只做事件分派基础。
 */

/** driver SSE 事件（松类型，按 type 分支取字段；对齐 driver/types.ts DriverEvent）。 */
export interface SseEvent {
  type: string
  _ts: string
  [k: string]: unknown
}

/** 全自动写章终局（self_heal_result）。 */
export interface HealResult {
  outcome: 'pass' | 'escalate' | 'aborted' | 'failed'
  reds?: string[]
  /** pass 时终稿黄项复查：仍命中的规则违规（message 列表，空 = 已收敛） */
  yellows?: string[]
  docId?: string
  path?: string
  error?: string
}
/** F-P1-4：SSE 事件字段白名单（拒绝非预期值；白名单常量集中在 sse-guards.ts 的守卫里） */

/** 全自动写章进度（self_heal_progress：第 attempt/maxAttempts 次重写 + 剩余红项）。 */
export interface HealProgress {
  attempt: number
  maxAttempts: number
  remaining: string[]
}

function ts(): string {
  return new Date().toLocaleTimeString('zh-CN')
}

/** 事件日志上限：SSE 长会话只 push 不裁剪会内存膨胀，超出即丢弃最旧条目。 */
const MAX_LOG = 500

/**
 * R30-27（三十轮）：事件日志 type 白名单——空串/未知名事件此前照进 workbench.log，
 * 事件流里渲染为裸 type 噪声（未知 type 对作者无意义）。集合口径 = 既有事件处理分支
 * 的全集：dispatch 状态分支（role_spawn / init / done / interrupted / error / text /
 * self_heal 系列 / warning）∪ 事件流渲染分支（WbAdvanced evLabel 的
 * tool_use / usage / review-progress）。
 * 只过滤日志入库，不改分发：未知/空 type 事件照常走 dispatch（无命中分支自然 no-op），
 * chat_* 与 sync 的路由在 useSse 层本就不依赖本表。新增事件 type 时须同步补录本表。
 */
const WORKBENCH_LOG_TYPES: ReadonlySet<string> = new Set([
  'role_spawn',
  'init',
  'done',
  'interrupted',
  'error',
  'text',
  'self_heal_reset',
  'text_reset',
  'self_heal_phase',
  'self_heal_progress',
  'self_heal_result',
  'self_heal_batch',
  'self_heal_batch_progress',
  'warning',
  // 事件流渲染分支（WbAdvanced evLabel）独有、dispatch 无状态分支的展示型事件
  'tool_use',
  'usage',
  'review-progress',
])

/** R30-27（三十轮）：未知/空 type 事件日志丢弃计数（debug 观测口径——只丢日志不丢
 *  事件，分发行为不变；计数经 console.debug 留痕，便于排查服务端新增事件漏录白名单） */
let droppedLogCount = 0

export const useWorkbenchStore = defineStore('workbench', () => {
  /** 事件日志（按序追加，右栏事件流消费）。 */
  const log = ref<SseEvent[]>([])
  /** 生成正文聚合（text 事件拼接，草稿保存源）。init/role_spawn 清空（新生成）。 */
  const textOut = ref('')
  /** 生成中（init/role_spawn→true，done/interrupted/error→false）。 */
  const running = ref(false)
  /** F4（五十九轮）：textOut 不完整水印——SSE 断连窗口内的 text 事件无补发，重连后
   *  sync(running=true) 说明生成在途但期间事件已丢，textOut 可能残缺；置位期间阻止
   *  直接保存残文（最小闭环，不做事件重投影）。本轮事件收尾（done/interrupted/error）
   *  时清除——终稿落盘前作者本就会过目，且 .版本 快照可兜底找回。 */
  const textIncomplete = ref(false)
  /** SSE 连接态。 */
  const connected = ref(false)
  /** 全自动写章：当前阶段 / 重写进度 / 终局（null = 未在跑或已清）。 */
  const healPhase = ref<'drafting' | 'checking' | 'rewriting' | 'chapter_start' | 'chapter_done' | null>(null)
  const healProgress = ref<HealProgress | null>(null)
  const healResult = ref<HealResult | null>(null)
  /** P2-3 批量连写进度：total / 已完成章数 / 中途停下的章号（null = 单章或未在跑） */
  const batchProgress = ref<{ done: number; total: number; stoppedAt: number | null } | null>(null)
  /** 非致命警告（如 max_tokens 截断）——UI watch 后 toast。null = 无。 */
  const warning = ref<string | null>(null)

  /** 分派一条 SSE 事件：追加日志 + 维护 running + 聚合正文。JSON.parse 已由 useSse 完成。 */
  function dispatch(ev: unknown): void {
    // P2-2：type guard 基础守卫（取代手写 typeof + as Record）
    if (!isSseEvent(ev)) return
    // 连接快照（服务端连接建立即发）：校正 running（刷新/新标签错过 init 的补救），不入事件日志
    if (ev.type === 'sync') {
      running.value = ev['running'] === true
      // F4（五十九轮）：重连快照 running=true ⇔ 断连窗口内有事件丢失（SSE 无补发），
      // textOut 可能残缺——置不完整水印；running=false 说明生成已收尾，按收尾口径清除
      textIncomplete.value = running.value
      // Q-4（第十五轮）：sync 只回 running 布尔——断线重连时若批次已在断连窗口内
      // 收尾（self_heal_result 丢失），healPhase/batchProgress 原样残留会让界面永久
      // 卡「正在写稿…」（M-12 只处理了 running 复位）。running=false 且自愈态残留 →
      // 连带复位 + 中断提示（终局未知，引导从文章树查看）。
      if (
        !running.value &&
        (healPhase.value !== null || healProgress.value !== null || batchProgress.value !== null)
      ) {
        healPhase.value = null
        healProgress.value = null
        batchProgress.value = null
        warning.value = '连接中断，写章结果未知——请从文章树查看最新草稿状态'
      }
      return
    }
    const e = { ...ev, _ts: ts() } as SseEvent
    // R30-27（三十轮）：日志落库前按白名单过滤——未知/空 type 只跳过入库（计数 +
    // console.debug 留痕），后续状态分支照常执行（分发行为零改动）
    if (!WORKBENCH_LOG_TYPES.has(e.type)) {
      droppedLogCount++
      console.debug(`[workbench] 未入库日志：未知事件 type="${e.type}"（累计丢弃 ${droppedLogCount} 条）`)
    } else {
      log.value.push(e)
      if (log.value.length > MAX_LOG) log.value.splice(0, log.value.length - MAX_LOG)
    }
    if (e.type === 'role_spawn') {
      // 生成开始（provider 直连路径即以此事件声明生成在途）
      running.value = true
      textOut.value = '' // 新生成清空旧正文
      healPhase.value = null
      healProgress.value = null
      healResult.value = null
      batchProgress.value = null
    } else if (e.type === 'init') {
      // 会话建连元数据（mock driver 每次连接都发）——不代表生成在途，不置 running
      textOut.value = ''
      healPhase.value = null
      healProgress.value = null
      healResult.value = null
      batchProgress.value = null
    } else if (e.type === 'done' || e.type === 'interrupted' || e.type === 'error') {
      running.value = false
      textIncomplete.value = false // F4（五十九轮）：本轮生成收尾，水印解除
    }
    if (e.type === 'text' && typeof e.text === 'string') textOut.value += e.text
    // 整章重写 / 流式重试前清正文缓冲，不清会把多轮正文首尾拼接
    else if (e.type === 'self_heal_reset' || e.type === 'text_reset') textOut.value = ''
    else if (e.type === 'self_heal_phase') {
      // F-P1-4：白名单校验在 isHealPhaseEvent 守卫内（防 SSE 非预期值致 UI 渲染异常）
      if (isHealPhaseEvent(e)) healPhase.value = e.phase
    } else if (e.type === 'self_heal_progress') {
      // R72-11（二十轮 F-6）：attempt/maxAttempts 过有限数守卫——NaN/非数值原样直入
      // UI（sse-guards 白名单纪律同 isHealPhaseEvent 口径）
      const attempt = Number(e.attempt ?? 0)
      const maxAttempts = Number(e.maxAttempts ?? 0)
      healProgress.value = {
        attempt: Number.isFinite(attempt) ? attempt : 0,
        maxAttempts: Number.isFinite(maxAttempts) ? maxAttempts : 0,
        remaining: strArr(e.remaining) ?? [],
      }
    } else if (e.type === 'self_heal_result') {
      if (isHealResultEvent(e)) {
        healResult.value = {
          outcome: e.outcome,
          ...(strArr(e.reds) ? { reds: strArr(e.reds) } : {}),
          ...(strArr(e.yellows) ? { yellows: strArr(e.yellows) } : {}),
          ...(str(e.docId) ? { docId: str(e.docId) } : {}),
          ...(str(e.path) ? { path: str(e.path) } : {}),
          ...(str(e.error) ? { error: str(e.error) } : {}),
        }
        healPhase.value = null
        healProgress.value = null
      }
    } else if (e.type === 'self_heal_batch') {
      // P2-3：批量开跑
      // R26-76（二十六轮）：total 过有限数守卫（对齐下方 progress 分支）——NaN/Infinity
      // 等非法值不写入 UI 态（进度条/「第 N/共 M 章」文案渲染异常）
      const total = Number(e.total ?? 0)
      batchProgress.value = { done: 0, total: Number.isFinite(total) && total > 0 ? total : 0, stoppedAt: null }
    } else if (e.type === 'self_heal_batch_progress') {
      // P2-3：批量中途停（escalate/预算超限）
      // R26-76（二十六轮）：done/total/stoppedAt 过有限数守卫——SSE 脏值（字符串数字/
      // NaN/Infinity）原样直入会让批量进度条与终局文案渲染异常（R72-11 同款口径）
      const done = Number(e.done ?? 0)
      const total = Number(e.total ?? 0)
      const stoppedAt = e.stoppedAt !== undefined && e.stoppedAt !== null ? Number(e.stoppedAt) : null
      batchProgress.value = {
        done: Number.isFinite(done) ? done : 0,
        total: Number.isFinite(total) ? total : 0,
        stoppedAt: stoppedAt !== null && Number.isFinite(stoppedAt) ? stoppedAt : null,
      }
    } else if (e.type === 'warning') {
      const msg = str(e.message)
      if (msg) warning.value = msg
    }
  }

  function clear(): void {
    log.value = []
    textOut.value = ''
    healPhase.value = null
    healProgress.value = null
    healResult.value = null
    batchProgress.value = null
    warning.value = null
    // M-12：running 一并复位——切书时不带走旧书在途标志（旧实现残留 true 让新书
    // 工作台无限显示「生成中」；新书 SSE connect 快照会按服务端真实状态校正）
    running.value = false
    textIncomplete.value = false // F4（五十九轮）：水印随正文一起清
  }
  function setConnected(v: boolean): void {
    connected.value = v
  }

  return {
    log,
    textOut,
    textIncomplete,
    running,
    connected,
    healPhase,
    healProgress,
    healResult,
    batchProgress,
    warning,
    dispatch,
    clear,
    setConnected,
  }
})
