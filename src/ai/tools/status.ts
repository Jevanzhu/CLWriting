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
import { finalizedChapterSetOfBook } from '../../document/manifest.js'
import type { ToolContext, ToolResult } from './context.js'

export function chapterStatus(ctx: ToolContext, _input: Record<string, unknown>): ToolResult {
  const cachePath = join(ctx.bookRoot, '.cache', 'index.db')
  if (!existsSync(cachePath)) {
    return { ok: false, summary: '书缓存（.cache/index.db）不存在——无布线短篇或缓存未重建，无法读取章节状态。' }
  }
  let db: DatabaseSync
  try {
    db = new DatabaseSync(cachePath, { readOnly: true })
    // R65-11（总六十五轮）：readOnly 连接同样设 busy_timeout——与域内其他连接口径一致
    //（events/store、cache/rebuild、check 均 5s）：写尖峰（rebuild/机检并发）下即时读
    // 抛 SQLITE_BUSY，等锁而非失败。busy_timeout 是连接级设置，只读连接可设
    db.exec('PRAGMA busy_timeout = 5000')
  } catch (e) {
    return { ok: false, summary: '打开书缓存失败：' + (e instanceof Error ? e.message : String(e)) }
  }
  try {
    const cfg = readBookConfig(join(ctx.bookRoot, 'book.yaml'))
    // GG-P2-6 全局托底：config 过 applyGlobalDefaults 后 book.volume_size 已是生效值
    // （书级未设回落 global.json → 硬编码，与 overview 喂 detectState 同一口径）；
    // T2 批（参数显式 resolve）：第三参不再缺省穿透 assembleStatus 内部回落——
    // 此处显式 resolve 出最终值（生效配置 → 硬编码 50），重放时可精确重建
    // 低级项（第六轮）：currentChapter 只数定稿章（缓存 chapters 表含写作中的草稿），
    // 与判态/近况复述/备料同口径
    const eff = applyGlobalDefaults(cfg.config, ctx.userDataPath)
    const snapshot = assembleStatus(
      db,
      eff,
      eff.book.volume_size ?? 50,
      finalizedChapterSetOfBook(ctx.bookRoot),
    )
    return { ok: true, summary: formatStatus(snapshot) }
  } catch (e) {
    return { ok: false, summary: '读取章节状态失败：' + (e instanceof Error ? e.message : String(e)) }
  } finally {
    db.close()
  }
}

