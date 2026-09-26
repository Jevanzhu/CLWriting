/**
 * 事件库行读取族（行类型 + 行→事件映射）—— 自 src/events/store.ts 缝 B 拆出。
 *
 * （⑤④产品巨件拆分波3）：store.ts（1355 行）三缝纯移动拆分。
 * 本文件承载缝 B：sessions 行类型 SessionRow + events 行类型 Row + rowToEvent/
 * safeRowToEvent（坏行降级）原样随迁（零行为变化，历史注释原样随代码迁移）。
 * 实读偏差记档：侦察口径的 rows 缝（约 85 行）含 prepared 语句缓存族——该族
 * closeEventsDb 被 test/events/store-prepared-cache-release.test.ts 结构契约钉在 store.ts
 * 源文本（正则匹配函数本体「先 preparedByDb.delete 再 db.close」），缓存族整体留
 * 残核、本缝收窄为行族 44 行。
 * 依赖方向单向（无环回引）：只 import ./types.js（ChatEvent/SurfaceOp 类型）与
 * ../log/index.js（safeRowToEvent 坏行 warn），不 import events/store.ts；残核自本
 * 文件取 safeRowToEvent/Row/SessionRow，SessionRow 经残核桥再导出
 * （verbatimModuleSyntax 走 export type），全库消费方 import 面零改动。原模块私有
 * 而残核跨文件消费项（Row/safeRowToEvent）就此导出，rowToEvent 保持私有。
 * firstOpenStore（残核巨型对象字面量，重设计立案件）本批零触碰。
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

export interface Row {
  seq: number; session_id: string; turn: number | null; step: number | null;
  type: string; data: string; surface_op: string | null;
  shadow_start: number | null; shadow_end: number | null;
  source_seqs: string | null; replace_generation: number; created_at: number;
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
