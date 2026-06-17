/**
 * 体检周期标记 —— 依据 #15 第 6 节态 6（体检周期）。
 *
 * 存「上次体检章号」供状态机判体检周期是否到期（距当前章 ≥ 阈值）。
 *
 * 为什么独立文件而非 index.db 的 meta：
 * rebuild（#4 第 5 节）每次进门会 clearAllTables 清空 meta，meta 存的状态会被自身清掉。
 * 故用独立 JSON 文件 `.cache/health-check.json`，不受 rebuild 影响，语义稳定。
 * （#15 原文说「存 .cache meta」，实现时发现 rebuild 清 meta 的冲突，改独立文件更稳健。）
 *
 * 文件格式：{ "last_check_chapter": <章号>, "last_check_at": <ISO> }
 * 文件不存在视为「从未体检」，第 1 章起即可能到期（按阈值判）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** 体检周期文件名（.cache/ 下，机器域） */
const HEALTH_CHECK_FILE = 'health-check.json'

/** 体检周期默认阈值（章）：距上次体检超过此值则到期。
 *  #15 第 6 节「默认每卷体检一次（可配）」；这里取 30 章（比卷大小 50 更频繁，
 *  对长篇安全；book.yaml 暂无此配置字段，先用常量，M4 可接入 config）。 */
export const DEFAULT_HEALTH_CHECK_INTERVAL = 30

/** 体检记录 */
export interface HealthCheckRecord {
  /** 上次体检时的已定稿章号 */
  last_check_chapter: number
  /** 上次体检时间（ISO 8601） */
  last_check_at: string
}

/** 体检记录文件路径（.cache/health-check.json） */
export function healthCheckPath(bookRoot: string): string {
  return join(bookRoot, '.cache', HEALTH_CHECK_FILE)
}

/** 读体检记录（文件不存在返回 null = 从未体检） */
export function readHealthCheck(bookRoot: string): HealthCheckRecord | null {
  const fp = healthCheckPath(bookRoot)
  if (!existsSync(fp)) return null
  try {
    const data = JSON.parse(readFileSync(fp, 'utf-8')) as Partial<HealthCheckRecord>
    if (typeof data.last_check_chapter !== 'number') return null
    return {
      last_check_chapter: data.last_check_chapter,
      last_check_at: typeof data.last_check_at === 'string' ? data.last_check_at : '',
    }
  } catch {
    return null // 坏文件视为从未体检（容错不崩）
  }
}

/** 写体检记录（体检完成后调用，标记体检做到第几章） */
export function writeHealthCheck(bookRoot: string, chapter: number): void {
  const fp = healthCheckPath(bookRoot)
  const dir = dirname(fp)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const rec: HealthCheckRecord = {
    last_check_chapter: chapter,
    last_check_at: new Date().toISOString(),
  }
  writeFileSync(fp, JSON.stringify(rec, null, 2), 'utf-8')
}

/**
 * 判体检周期是否到期（#15 第 6 节态 6 判定）。
 *
 * @param bookRoot 书仓库根
 * @param currentChapter 当前已定稿章号
 * @param interval 阈值（章），默认 30
 * @returns 到期则返回距上次体检的章数（chaptersSince）；未到期返回 null
 */
export function checkHealthDue(
  bookRoot: string,
  currentChapter: number,
  interval: number = DEFAULT_HEALTH_CHECK_INTERVAL,
): number | null {
  const rec = readHealthCheck(bookRoot)
  const lastChapter = rec?.last_check_chapter ?? 0
  const chaptersSince = currentChapter - lastChapter
  return chaptersSince >= interval ? chaptersSince : null
}
