/**
 * 连写暂停元状态（M6 #34）：工作区/待定稿/.auto-batch.json 的 paused 字段读写。
 *
 * 读侧：state.ts buildRecap 叠加在态 4/8 之上——进书近况提示「连写暂停在第 N 章（原因）」。
 * 写侧（驱动侧接线）：self-heal orchestrateBatch 中途停（escalate/failed/aborted）落暂停记录，
 * 重新开批即清除——文件存在 ⇔ 上次连写未跑完且此后未再开批。
 * 观测性元数据：读写失败静默降级，绝不挡写稿主线（与备料 best-effort 同口径）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'

/** 暂停记录：atChapter=停在第几章，reason=停法（escalate/failed/aborted），detail=人话细节 */
export interface BatchPause {
  atChapter: number
  reason: string
  detail: string
}

function pausePath(bookRoot: string): string {
  return join(bookRoot, '工作区', '待定稿', '.auto-batch.json')
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
}

/** 清暂停记录：还有其他键则保留改写，只剩 paused 则删文件；无暂停记录 no-op */
export function clearBatchPause(bookRoot: string): void {
  const fp = pausePath(bookRoot)
  if (!existsSync(fp)) return
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>
  } catch {
    rmSync(fp, { force: true }) // 坏文件视作只剩暂停记录 → 直接删
    return
  }
  if (!('paused' in obj)) return
  delete obj.paused
  if (Object.keys(obj).length > 0) atomicWriteFile(fp, JSON.stringify(obj, null, 2) + '\n')
  else rmSync(fp, { force: true })
}
