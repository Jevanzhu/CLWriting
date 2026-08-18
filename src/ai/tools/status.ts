/**
 * chapter_status：全书近况快照（readonly）。读 .cache/index.db + book.yaml，
 * 复用 assembleStatus/formatStatus（与写作链路同一口径）。
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { assembleStatus, formatStatus } from '../../process/assemble.js'
import { readBookConfig } from '../../format/yaml.js'
import { applyGlobalDefaults } from '../../format/global-defaults.js'
import type { ToolContext, ToolResult } from './context.js'

export function chapterStatus(ctx: ToolContext, _input: Record<string, unknown>): ToolResult {
  const cachePath = join(ctx.bookRoot, '.cache', 'index.db')
  if (!existsSync(cachePath)) {
    return { ok: false, summary: '书缓存（.cache/index.db）不存在——无布线短篇或缓存未重建，无法读取章节状态。' }
  }
  let db: DatabaseSync
  try {
    db = new DatabaseSync(cachePath, { readOnly: true })
  } catch (e) {
    return { ok: false, summary: '打开书缓存失败：' + (e instanceof Error ? e.message : String(e)) }
  }
  try {
    const cfg = readBookConfig(join(ctx.bookRoot, 'book.yaml'))
    // 全局托底：volume_size 等喂 assembleStatus 的运行时值——书级未设回落 global.json
    // → 硬编码（与 overview 喂 detectState 同一口径）
    const snapshot = assembleStatus(db, applyGlobalDefaults(cfg.config, ctx.userDataPath))
    return { ok: true, summary: formatStatus(snapshot) }
  } catch (e) {
    return { ok: false, summary: '读取章节状态失败：' + (e instanceof Error ? e.message : String(e)) }
  } finally {
    db.close()
  }
}

