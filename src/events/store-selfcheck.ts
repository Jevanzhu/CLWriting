/**
 * 事件流在线自检（会话库关闭路径的单轮条数一致性校验）。
 *
 * 缺口：遮蔽区间的写坏（区间内行缺失、区间内混入非 surface 行、start/end 配对失衡）
 * 此前只有离线重放（validateEventStream）才会暴露——生产侧唯一接线是紧凑前的一次
 * 全表扫自检，且它默认关闭。数据坏掉后无人告警，只能事后重放才发现。
 *
 * 本模块在每次「开库 → 引用归零关闭」收尾跑一轮**廉价**校验：只看 seq 尾窗
 * （SELF_CHECK_TAIL_ROWS 行，主键序降序取尾，不物化全表），对窗内的 replace 载体
 * 逐条比对「遮蔽区间内的可见条数 vs 区间跨度」，再按会话比对 session/start 与
 * session/end 的配对计数。不一致只 log.warn 留痕（含库路径、会话键与差异数），不改数据、
 * 不阻断关闭——判据本身复用投影侧的校验步（见下），不另造一套口径。
 *
 * 判据来源（复用既有校验能力，勿另写一份）：
 * - 区间守恒直接用 projection.shadowCoverageStep：它的判词「遮蔽区间 [s,e] 含未可见
 *   seq（区间 x 个，可见仅 y 个）」正是差异数，且与离线重放同一份谓词。本模块只负责
 *   把窗内区间两端的可见集喂进游标（见 buildIntervalCursor）。
 * - 会话配对计数是尾窗内即可判定的局部不变量：单个 session_id 只应有 1 条 session/start
 *   （id 由 createSession 唯一分配），差 0 = 已闭合、差 1 = 进行中或待孤儿修复；差 > 1
 *   （重复 start）或差 < 0（重复 end / 缺 start）都是真异常。
 *
 * 开关：默认开启。env CLWRITING_EVENTS_SELF_CHECK 为强制档——'0' 强制关，其余
 * （含 '1'）强制开；未设走默认开。自检自身异常一律吞成 warn 降级（关闭流程绝不受影响）。
 *
 * 依赖单向（无环回引）：只 import node:sqlite 类型、../log、./projection 与 ./types；
 * store.ts 取 runEventStreamSelfCheck，本文件不 import store.ts。
 */
import type { DatabaseSync } from 'node:sqlite'
import { log, errMsg } from '../log/index.js'
import { createValidateCursor, shadowCoverageStep } from './projection.js'
import { SURFACE_EVENT_TYPES, type ChatEvent, type EventType } from './types.js'

/** 尾窗行数：单轮自检的取行上限（主键序降序，不物化全表）。 */
export const SELF_CHECK_TAIL_ROWS = 512
/** 单轮最多校验的 replace 载体条数：每条约一次小区间查询，上限即单轮成本上限。 */
const SELF_CHECK_MAX_INTERVALS = 8

/** 尾窗行投影（只取判定所需列——不含 data 大字段，自检不解析正文）。 */
interface TailRow {
  seq: number
  session_id: string
  type: string
  shadow_start: number | null
  shadow_end: number | null
}

export interface StreamCheckIssue {
  /** 承载该不一致的会话键（事件行 session_id） */
  sessionId: string
  /** 人话判词（含差异数；区间族判词来自 projection.shadowCoverageStep） */
  message: string
}

export interface StreamCheckResult {
  tailRows: number
  /** 实际参与守恒校验的 replace 载体条数 */
  intervals: number
  issues: StreamCheckIssue[]
}

/** 自检开关：'0' 强制关；其余（含 '1'、未设）为开。参数化 env 值供直测三态。 */
export function isSelfCheckEnabled(raw: string | undefined = process.env['CLWRITING_EVENTS_SELF_CHECK']): boolean {
  return raw !== '0'
}

/** 校验步所需的最小事件：shadowCoverageStep 只读 seq / type / shadowStart / shadowEnd
 *  （判词里的区间与计数全由这四个字段与游标可见集推出）。不取 data 是有意的——自检在
 *  关闭路径上跑，正文大字段（被遮蔽的对话消息）不进内存。 */
function intervalCarrier(r: TailRow): ChatEvent {
  return {
    seq: r.seq,
    sessionId: r.session_id,
    type: r.type as EventType,
    data: {},
    surfaceOp: 'replace',
    shadowStart: r.shadow_start ?? undefined,
    shadowEnd: r.shadow_end ?? undefined,
    replaceGeneration: 0,
    createdAt: 0,
  }
}

/** 区间两端的可见集：区间内「surface 族且 surfaceOp 非空」的行 seq。
 *  谓词与投影侧 advanceVisibleStep 同源（离线重放只把这类行计入可见集）；唯一略去的分支
 *  是空壳 assistant 的载荷判空（要读 data），而录制侧本就把该形态排除在遮蔽位之外
 *  （见 chat-bridge 的 pendingSurfaceIdx 注），故区间内行按本谓词判定与离线口径一致。 */
function buildIntervalCursor(db: DatabaseSync, start: number, end: number): ReturnType<typeof createValidateCursor> {
  const cur = createValidateCursor()
  const ph = [...SURFACE_EVENT_TYPES].map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT seq FROM events WHERE seq >= ? AND seq <= ? AND surface_op IS NOT NULL AND type IN (${ph})`)
    .all(start, end, ...SURFACE_EVENT_TYPES) as Array<{ seq: number }>
  for (const r of rows) cur.visibleSeqs.add(r.seq)
  return cur
}

/**
 * 单轮一致性校验（纯查询，不改库、不抛业务错：查询失败由 runEventStreamSelfCheck 收成降级）。
 * 语句一律现编译（db.prepare）——本面低频（每次关闭一轮），不进连接级 prepared 缓存。
 */
export function checkEventStreamIntegrity(db: DatabaseSync, tail = SELF_CHECK_TAIL_ROWS): StreamCheckResult {
  const rows = db
    .prepare('SELECT seq, session_id, type, shadow_start, shadow_end FROM events ORDER BY seq DESC LIMIT ?')
    .all(tail) as unknown as TailRow[]
  if (rows.length === 0) return { tailRows: 0, intervals: 0, issues: [] }
  // 尾窗最旧行的 seq：区间起点在它之前时区间被窗口切掉，窗内守恒判定不成立 → 跳过该载体
  const windowFloorSeq = rows[rows.length - 1]!.seq
  const issues: StreamCheckIssue[] = []
  let intervals = 0
  for (const r of rows) {
    if (r.type !== 'compaction/end') continue
    if (r.shadow_start === null || r.shadow_end === null) {
      issues.push({
        sessionId: r.session_id,
        message: `compaction/end（seq=${r.seq}）缺 shadowStart/shadowEnd 端点——遮蔽区间无法判定`,
      })
      continue
    }
    if (r.shadow_start > r.shadow_end) {
      issues.push({
        sessionId: r.session_id,
        message: `compaction/end（seq=${r.seq}）区间倒置 [${r.shadow_start},${r.shadow_end}]`,
      })
      continue
    }
    if (r.shadow_start < windowFloorSeq) continue
    if (intervals >= SELF_CHECK_MAX_INTERVALS) break
    intervals++
    const carrier = intervalCarrier(r)
    const cur = buildIntervalCursor(db, r.shadow_start, r.shadow_end)
    for (const issue of shadowCoverageStep(carrier, cur)) {
      issues.push({ sessionId: r.session_id, message: issue.message })
    }
  }
  // 会话配对计数：按升序遍历尾窗（首个见到的行即该会话在窗内的首行）
  const perSession = new Map<string, { first: string; starts: number; ends: number }>()
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    let s = perSession.get(r.session_id)
    if (!s) {
      s = { first: r.type, starts: 0, ends: 0 }
      perSession.set(r.session_id, s)
    }
    if (r.type === 'session/start') s.starts++
    else if (r.type === 'session/end') s.ends++
  }
  for (const [sessionId, s] of perSession) {
    // 窗口边界前提：会话首行不在窗内时窗内计数不可比（start 被切在窗外会让差恒为负），
    // 跳过——宁可漏报不误报（工作区会话本就没有 session/start，同走此分支）。
    if (s.first !== 'session/start') continue
    const diff = s.starts - s.ends
    if (diff > 1 || diff < 0) {
      issues.push({
        sessionId,
        message: `session/start ${s.starts} 条与 session/end ${s.ends} 条配对失衡（差 ${diff}；进行中会话的正常态是差 1）`,
      })
    }
  }
  return { tailRows: rows.length, intervals, issues }
}

/**
 * 关闭路径的自检入口：开关闸 → 校验 → 不一致留痕（含库路径、会话键与差异数）。
 * **本函数不抛**：开关关、校验抛错都只留痕返回 null——自检是收尾期的旁路观察，
 * 任何自身故障都不得影响关闭流程（调用方在引用归零后才调用）。
 */
export function runEventStreamSelfCheck(
  db: DatabaseSync,
  dbPath: string,
  rawEnv: string | undefined = process.env['CLWRITING_EVENTS_SELF_CHECK'],
): StreamCheckResult | null {
  if (!isSelfCheckEnabled(rawEnv)) return null
  try {
    const result = checkEventStreamIntegrity(db)
    if (result.issues.length > 0) {
      const detail = result.issues.map((i) => `会话 ${i.sessionId}：${i.message}`).join('；')
      log.warn(
        'events',
        `事件流自检发现 ${result.issues.length} 处不一致（库=${dbPath}，尾窗 ${result.tailRows} 行，区间 ${result.intervals} 个）：${detail}`,
      )
    }
    return result
  } catch (e) {
    log.warn('events', `事件流自检降级（库=${dbPath}）：${errMsg(e)}——关闭流程照常`)
    return null
  }
}
