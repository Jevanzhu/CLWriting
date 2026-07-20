/**
 * GUI 活跃标记 + 工作区编辑锁（W0-2 §5 第一层）。
 *
 * .gui-active = { pid, ts, editing_workdir? }：
 * - pid/ts：GUI 后端心跳（heartbeat 端点续期），CLI 写命令据此轻提示（#1.5，不阻塞）。
 * - editing_workdir：编辑器打开工作区草稿/细纲时置位（mutex 第一层）——
 *   batch 每章前检查，新鲜时连写暂停（不跳章），过期/清除时双方进入。
 *
 * 沿用 STALE_MS=30s：editing_workdir 新鲜 = 标记在 + ts 未过期。
 */
import { join } from 'node:path'
import { writeFileSync, readFileSync, rmSync } from 'node:fs'

/** 心跳超过此值视为已离开（进程可能崩溃/被杀）。 */
export const STALE_MS = 30_000

/** .gui-active 完整记录。editing_workdir 是工作区编辑锁（W0-2 §5）。 */
export interface GuiActiveRecord {
  pid: number
  ts: number
  /** 工作区编辑锁：编辑器打开工作区草稿/细纲时置位（mutex 第一层）。 */
  editing_workdir?: boolean
}

/** .gui-active 文件路径：<bookRoot>/工作区/.gui-active */
export function guiActivePath(bookRoot: string): string {
  return join(bookRoot, '工作区', '.gui-active')
}

/** GUI 心跳写 / 续期（合并写：保留同进程设的 editing_workdir，心跳不清锁）。 */
export function writeGuiActive(bookRoot: string): void {
  const existing = readGuiActive(bookRoot)
  const rec: GuiActiveRecord = { pid: process.pid, ts: Date.now() }
  // 心跳续期不应清掉本进程的工作区编辑锁
  if (existing?.editing_workdir === true && existing.pid === process.pid) {
    rec.editing_workdir = true
  }
  try {
    writeFileSync(guiActivePath(bookRoot), JSON.stringify(rec), 'utf8')
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

/** GUI 是否活跃（.gui-active 存在且心跳未过期）。 */
export function isGuiActive(bookRoot: string): { active: boolean; pid?: number; ageMs?: number } {
  const rec = readGuiActive(bookRoot)
  if (!rec) return { active: false }
  const ageMs = Date.now() - rec.ts
  return ageMs > STALE_MS ? { active: false, pid: rec.pid, ageMs } : { active: true, pid: rec.pid, ageMs }
}

/** CLI 写命令前：若 GUI 活跃，打印轻提示（不阻塞，#1.5）。 */
export function warnIfGuiActive(bookRoot: string): void {
  const r = isGuiActive(bookRoot)
  if (r.active) {
    console.warn(`⚠ GUI 正在编辑此书（PID ${r.pid}）。继续执行 CLI 写命令，注意并发冲突。`)
  }
}

// ── 工作区编辑锁（W0-2 §5 第一层，mutex 调用）──────────

/** 置工作区编辑锁：editing_workdir=true + 续 ts。编辑器打开工作区草稿/细纲时调。 */
export function acquireEditingWorkdir(bookRoot: string): boolean {
  const rec: GuiActiveRecord = { pid: process.pid, ts: Date.now(), editing_workdir: true }
  try {
    writeFileSync(guiActivePath(bookRoot), JSON.stringify(rec), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 清工作区编辑锁：editing_workdir 移除，保留 pid/ts（GUI 仍活跃，只是不在编辑工作区）。 */
export function releaseEditingWorkdir(bookRoot: string): void {
  const existing = readGuiActive(bookRoot)
  if (!existing) return
  try {
    writeFileSync(guiActivePath(bookRoot), JSON.stringify({ pid: existing.pid, ts: Date.now() }), 'utf8')
  } catch {
    // ignore
  }
}

/** 工作区编辑锁是否新鲜（editing_workdir=true + ts 未过期）。batch 每章前检查。 */
export function isEditingWorkdirActive(bookRoot: string): boolean {
  const rec = readGuiActive(bookRoot)
  if (!rec || rec.editing_workdir !== true) return false
  return Date.now() - rec.ts <= STALE_MS
}
