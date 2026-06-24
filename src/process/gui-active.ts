/**
 * GUI 活跃标记（#1.5 单写者协作）。
 *
 * GUI 后端进书时写 工作区/.gui-active（PID + 时间戳），前端心跳续期；
 * CLI 写命令（finalize/check/confirm）检测到且新鲜时打印轻提示，不阻塞（向后兼容老脚本）。
 *
 * 单写者协作：GUI 与 CLI 共享同一份 MD 真源，并发写有冲突风险。
 * 不强制互斥（CLI 永远能跑），只在 GUI 活跃时提醒作者。
 */
import { join } from 'node:path'
import { writeFileSync, readFileSync, rmSync } from 'node:fs'

/** 心跳超过此值视为 GUI 已离开（进程可能崩溃/被杀），不再提醒 */
const STALE_MS = 30_000

/** .gui-active 文件路径：<bookRoot>/工作区/.gui-active */
export function guiActivePath(bookRoot: string): string {
  return join(bookRoot, '工作区', '.gui-active')
}

/** 写 / 续期 .gui-active（GUI 心跳端点调用） */
export function writeGuiActive(bookRoot: string): void {
  try {
    writeFileSync(guiActivePath(bookRoot), JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8')
  } catch {
    // 工作区可能不存在（书未初始化），忽略——心跳是尽力而为
  }
}

/** 清除 .gui-active（GUI 退出 / 切书） */
export function clearGuiActive(bookRoot: string): void {
  try {
    rmSync(guiActivePath(bookRoot), { force: true })
  } catch {
    // ignore
  }
}

/** 读 .gui-active；不存在或损坏返回 null */
export function readGuiActive(bookRoot: string): { pid: number; ts: number } | null {
  try {
    const rec = JSON.parse(readFileSync(guiActivePath(bookRoot), 'utf8')) as { pid?: unknown; ts?: unknown }
    if (typeof rec.pid !== 'number' || typeof rec.ts !== 'number') return null
    return { pid: rec.pid, ts: rec.ts }
  } catch {
    return null
  }
}

/** GUI 是否活跃（.gui-active 存在且心跳未过期） */
export function isGuiActive(bookRoot: string): { active: boolean; pid?: number; ageMs?: number } {
  const rec = readGuiActive(bookRoot)
  if (!rec) return { active: false }
  const ageMs = Date.now() - rec.ts
  return ageMs > STALE_MS ? { active: false, pid: rec.pid, ageMs } : { active: true, pid: rec.pid, ageMs }
}

/** CLI 写命令前调用：若 GUI 活跃，打印轻提示（不阻塞，#1.5） */
export function warnIfGuiActive(bookRoot: string): void {
  const r = isGuiActive(bookRoot)
  if (r.active) {
    console.warn(`⚠ GUI 正在编辑此书（PID ${r.pid}）。继续执行 CLI 写命令，注意并发冲突。`)
  }
}
