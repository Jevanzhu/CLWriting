/**
 * 连写暂停元状态（M6 #34）：工作区/待定稿/.auto-batch.json 的 paused 字段读写。
 *
 * 读侧：state.ts buildRecap 叠加在态 4/8 之上——进书近况提示「连写暂停在第 N 章（原因）」。
 * 写侧（驱动侧接线）：self-heal orchestrateBatch 中途停（escalate/failed/aborted）落暂停记录，
 * 重新开批即清除——文件存在 ⇔ 上次连写未跑完且此后未再开批。
 * 观测性元数据：读写失败静默降级，绝不挡写稿主线（与备料 best-effort 同口径）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { acquireCrossProcessLockWithTimeout } from '../fs/cross-process-lock.js'
import { log } from '../log/index.js'

/** 暂停记录：atChapter=停在第几章，reason=停法（escalate/failed/aborted），detail=人话细节 */
export interface BatchPause {
  atChapter: number
  reason: string
  detail: string
}

function pausePath(bookRoot: string): string {
  return join(bookRoot, '工作区', '待定稿', '.auto-batch.json')
}

/** R73-41 锁等待档（毫秒）：观测元数据，短等即降级（绝不挡写稿主线）。
 *  R30-18（三十轮）：常量化——export let 可被任一 import 方静默改写（同 events/store.ts
 *  R26-105 的收口认定），改 const + 内部可变生效值；测试只能经注入钩子改档，生产恒用常量。 */
export const PAUSE_LOCK_TIMEOUT_MS = 2_000

/** 生效值（模块内可变）：初值 = 常量；仅注入钩子可改。 */
let pauseLockTimeoutMs = PAUSE_LOCK_TIMEOUT_MS

/** 测试注入钩子（生产零调用）。 */
export function __setBatchPauseLockTimeoutForTest(ms: number): void {
  pauseLockTimeoutMs = ms
}

/**
 * R73-41（二十一轮）：.auto-batch.json 的读改写（write/clear 两路都是「读全量 → 改键 →
 * 原子重写」）此前无跨进程互斥——GUI self-heal 链与 CLI 批处理并发暂停/清暂停时，
 * 后写者以自己的全量镜像整文件重写，吞掉先写者刚落的键（如清暂停与落暂停交错 →
 * 暂停标记丢失，近况复述口径错）。现 RMW 段套按文件跨进程锁（J7 原语）；拿不到锁
 * 降级裸写 + warn 留痕——本文件是观测性元数据（读写失败本就静默降级），丢一次更新
 * 可接受，不阻断主流程。
 */
function withPauseLock<T>(bookRoot: string, fn: () => T): T {
  const lockPath = pausePath(bookRoot) + '.lock'
  const release = acquireCrossProcessLockWithTimeout(lockPath, pauseLockTimeoutMs)
  if (!release) {
    log.warn('batch-pause', `.auto-batch 锁超时，降级无锁读改写（${lockPath}）——并发窗口回到后写胜口径`)
    return fn()
  }
  try {
    return fn()
  } finally {
    release()
  }
}

/** 读 paused 字段；无文件/无暂停/坏 JSON → undefined（读侧永不抛） */
export function readBatchPause(bookRoot: string): BatchPause | undefined {
  const fp = pausePath(bookRoot)
  if (!existsSync(fp)) return undefined
  try {
    const obj = JSON.parse(readFileSync(fp, 'utf-8')) as {
      paused?: { at_chapter?: number; reason?: string; detail?: string } | null
    }
    const p = obj.paused
    if (!p || typeof p.at_chapter !== 'number' || typeof p.reason !== 'string') return undefined
    return { atChapter: p.at_chapter, reason: p.reason, detail: String(p.detail ?? '') }
  } catch {
    return undefined
  }
}

/** 落暂停记录（覆盖写 paused 键；文件里可能存在的其他键保留） */
export function writeBatchPause(bookRoot: string, p: BatchPause): void {
  withPauseLock(bookRoot, () => {
    const fp = pausePath(bookRoot)
    let obj: Record<string, unknown> = {}
    try {
      obj = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>
    } catch {
      // 无文件/坏 JSON → 从空对象重建（坏文件本就没有可保留的键）
    }
    obj.paused = { at_chapter: p.atChapter, reason: p.reason, detail: p.detail }
    mkdirSync(join(bookRoot, '工作区', '待定稿'), { recursive: true })
    atomicWriteFile(fp, JSON.stringify(obj, null, 2) + '\n')
  })
}

/** 清暂停记录：还有其他键则保留改写，只剩 paused 则删文件；无暂停记录 no-op */
export function clearBatchPause(bookRoot: string): void {
  withPauseLock(bookRoot, () => {
    const fp = pausePath(bookRoot)
    if (!existsSync(fp)) return
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>
    } catch {
      // R29-n/C-7（二十九轮）：坏文件不再直接删——先把原文件改名保留为 <名>.corrupt
      // 留证（同名已存在则追加时间戳，不覆盖前证），再写全新 { paused: false }。
      // 原 rmSync 会把文件里除 paused 外的其他键（未来扩展的批处理进度等）无痕丢掉；
      // 保留原文既留排查证据也不销毁未知数据。改名失败（占用等）退回旧口径删除重建
      // （观测性元数据，绝不挡主线）。
      const corruptPath = existsSync(`${fp}.corrupt`) ? `${fp}.corrupt-${Date.now()}` : `${fp}.corrupt`
      let preserved = false
      try {
        renameSync(fp, corruptPath)
        preserved = true
        log.warn('batch-pause', `.auto-batch.json 解析失败，原文件已保留为 ${corruptPath}（留证），重建全新暂停记录`)
      } catch {
        log.warn('batch-pause', '.auto-batch.json 解析失败且留证改名失败，按旧口径删除重建')
      }
      if (!preserved) rmSync(fp, { force: true })
      atomicWriteFile(fp, JSON.stringify({ paused: false }, null, 2) + '\n')
      return
    }
    if (!('paused' in obj)) return
    delete obj.paused
    if (Object.keys(obj).length > 0) atomicWriteFile(fp, JSON.stringify(obj, null, 2) + '\n')
    else rmSync(fp, { force: true })
  })
}
