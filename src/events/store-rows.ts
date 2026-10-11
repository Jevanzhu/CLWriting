/**
 * 事件库行读取族（行类型 + 行→事件映射）。
 *
 * 内容：sessions 行类型 SessionRow + events 行类型 Row + rowToEvent/
 * safeRowToEvent（坏行降级）。
 * prepared 语句缓存族留 events/store.ts 残核——closeEventsDb 被
 * test/events/store-prepared-cache-release.test.ts 结构契约钉在 store.ts
 * 源文本（正则匹配函数本体「先 preparedByDb.delete 再 db.close」）。
 * 依赖方向单向（无环回引）：只 import ./types.js（ChatEvent/SurfaceOp 类型）与
 * ../log/index.js（safeRowToEvent 坏行 warn），不 import events/store.ts；残核自本
 * 文件取 safeRowToEvent/Row/SessionRow，SessionRow 经残核桥再导出
 * （verbatimModuleSyntax 走 export type），全库消费方 import 面零改动。原模块私有
 * 而残核跨文件消费项（Row/safeRowToEvent）就此导出，rowToEvent 保持私有。
 * firstOpenStore（残核巨型对象字面量）留残核。
 */
import type { ChatEvent, SurfaceOp } from './types.js'
import { log, errMsg } from '../log/index.js'

export interface SessionRow {
  session_id: string
  format_version: number
  book: string
  header: string
  created_at: number
  updated_at: number
}

/** 本版应用支持的唯一会话行格式版本。写入侧恒写该值（createSession /
 *  workspaceSession 两条 INSERT），读取侧校验也只认该值——「写 1 读 1」是全流程
 *  （含迁移中间态、墓碑/回滚路径：二者只搬库文件与改 book 键，不触碰本列）的
 *  单一不变量。升级方式：新增一版时同步把本常量抬到新值并补齐读写两侧语义，
 *  届时旧进程读新库由下方 fail-closed 拒止。 */
export const SESSION_FORMAT_VERSION = 1

/** 会话行格式版本不可解释（该行由更新版本的应用写入，本应用不认识其语义）。
 *  与 SqliteSchemaTooNewError（user_version 阶梯的 DDL 面）同族：类型化是为了让
 *  调用方按类型分派——区别于库损坏 / 锁 / IO 故障（那三类可重试或可删重建），
 *  本类只能升级应用版本。 */
export class SessionFormatUnsupportedError extends Error {
  readonly sessionId: string
  readonly found: number
  readonly supported: number

  constructor(sessionId: string, found: number, supported: number) {
    super(
      `事件库会话行格式版本超前（session_id=${sessionId}，format_version=${found}，` +
        `本应用支持到 v${supported}）——该行由更新版本的应用写入，以旧语义读写会静默` +
        `损坏对话史/审计数据，故拒绝打开；请升级应用版本后重试`,
    )
    this.name = 'SessionFormatUnsupportedError'
    this.sessionId = sessionId
    this.found = found
    this.supported = supported
  }
}

/** 会话行格式校验（fail-closed）：未知版本抛 SessionFormatUnsupportedError，绝不按
 *  v1 解析。非正整数（NULL/字符串/0/负数）同拒——列定义 NOT NULL DEFAULT 1，能落到
 *  此处即库被外力改写，按不可解释态处理比猜一个版本安全。 */
export function assertSessionFormatVersion(formatVersion: number, sessionId: string): void {
  if (!Number.isInteger(formatVersion) || formatVersion !== SESSION_FORMAT_VERSION) {
    throw new SessionFormatUnsupportedError(sessionId, formatVersion, SESSION_FORMAT_VERSION)
  }
}

/** sessions 行 → 校验后的行（唯一「取整行再解释语义」的映射口）。
 *  调用方拿到即意味着该行已过格式闸，可按下标语义读取各列。 */
export function sessionRowOf(r: SessionRow): SessionRow {
  assertSessionFormatVersion(r.format_version, r.session_id)
  return r
}

export interface Row {
  seq: number
  session_id: string
  turn: number | null
  step: number | null
  type: string
  data: string
  surface_op: string | null
  shadow_start: number | null
  shadow_end: number | null
  source_seqs: string | null
  replace_generation: number
  created_at: number
}

function rowToEvent(r: Row): ChatEvent {
  return {
    seq: r.seq,
    sessionId: r.session_id,
    turn: r.turn ?? undefined,
    step: r.step ?? undefined,
    type: r.type as ChatEvent['type'],
    data: JSON.parse(r.data) as Record<string, unknown>,
    surfaceOp: (r.surface_op as SurfaceOp | null) ?? undefined,
    shadowStart: r.shadow_start ?? undefined,
    shadowEnd: r.shadow_end ?? undefined,
    sourceSeqs: r.source_seqs ? (JSON.parse(r.source_seqs) as number[]) : undefined,
    replaceGeneration: r.replace_generation,
    createdAt: r.created_at,
  }
}

/**
 * 坏行降级共用（从 listEvents 内联闭包提取，供迭代读同享）：
 * 单行 data/source_seqs JSON 损坏时 rowToEvent 抛错，直穿会炸整个读路径；逐行
 * try/catch 跳过坏行 + warn 留行 seq 与病因（log.warn 未 init 时即镜像 console.warn），
 * 好行完整返回。label 只影响 warn 文案（便于定位读侧入口）。
 */
export function safeRowToEvent(r: Row, label: string): ChatEvent | null {
  try {
    return rowToEvent(r)
  } catch (e) {
    log.warn('events', `${label} 跳过坏行 seq=${r.seq}（${errMsg(e)}）`)
    return null
  }
}
