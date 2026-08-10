/**
 * GUI 活跃标记（W0-2 §5 第一层）。
 *
 * .gui-active = { pid, ts, editing_workdir? }：
 * - pid/ts：GUI 后端心跳（heartbeat 端点续期）。
 * - editing_workdir：编辑器打开工作区草稿/细纲时置位（W0-2 §5 互斥第一层）。
 *
 * 沿用 STALE_MS=30s：editing_workdir 新鲜 = 标记在 + ts 未过期。
 */
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'
import { atomicWriteFile } from '../fs/atomic.js'

/** 心跳超过此值视为已离开（进程可能崩溃/被杀）。 */
export const STALE_MS = 30_000

/** .gui-active 完整记录。editing_workdir 是工作区编辑锁（W0-2 §5）。 */
export interface GuiActiveRecord {
  pid: number
  ts: number
  /** 工作区编辑锁：编辑器打开工作区草稿/细纲时置位（W0-2 §5 互斥第一层）。 */
  editing_workdir?: boolean
}

/** .gui-active 文件路径：<bookRoot>/工作区/.gui-active */
export function guiActivePath(bookRoot: string): string {
  return join(bookRoot, '工作区', '.gui-active')
}

/** GUI 心跳写 / 续期（合并写：保留同进程设的 editing_workdir）。 */
export function writeGuiActive(bookRoot: string): void {
  const existing = readGuiActive(bookRoot)
  const rec: GuiActiveRecord = { pid: process.pid, ts: Date.now() }
  // 心跳续期不应清掉本进程的工作区编辑锁
  if (existing?.editing_workdir === true && existing.pid === process.pid) {
    rec.editing_workdir = true
  }
  try {
    atomicWriteFile(guiActivePath(bookRoot), JSON.stringify(rec))
  } catch {
    // 工作区可能不存在（书未初始化）—— 心跳尽力而为
  }
}

/** 清除 .gui-active（GUI 退出 / 切书）。 */
export function clearGuiActive(bookRoot: string): void {
  try {
    rmSync(guiActivePath(bookRoot), { force: true })
  } catch {
    // ignore
  }
}

/** 读 .gui-active；不存在或损坏返回 null。 */
export function readGuiActive(bookRoot: string): GuiActiveRecord | null {
  try {
    const rec = JSON.parse(readFileSync(guiActivePath(bookRoot), 'utf8')) as Partial<GuiActiveRecord>
    if (typeof rec.pid !== 'number' || typeof rec.ts !== 'number') return null
    const out: GuiActiveRecord = { pid: rec.pid, ts: rec.ts }
    if (rec.editing_workdir === true) out.editing_workdir = true
    return out
  } catch {
    return null
  }
}