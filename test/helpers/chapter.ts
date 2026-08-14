/**
 * 章节文件测试造章工具 —— 迁自 src/format/chapters.ts 的 writeChapter（P2-1）。
 *
 * 生产代码写章统一走 document/service.ts（原子写 + 账本联动），writeChapter 仅测试造章用，
 * 故迁到 test/helpers 消除 src 里的 dead export。实现与原先逐字一致（chapterToMap + stringifyFlat + writeFile）。
 */

import { writeFile, stringifyFlat } from '../../src/format/frontmatter.js'
import type { ChapterMeta } from '../../src/format/types.js'

/** ChapterMeta → front matter Map */
function chapterToMap(ch: ChapterMeta): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('章号', ch.章号)
  map.set('标题', ch.标题)
  map.set('钩子类型', ch.钩子类型)
  map.set('钩子强弱', ch.钩子强弱)
  map.set('情绪定位', ch.情绪定位)
  if (ch.时间锚点) map.set('时间锚点', ch.时间锚点)
  if (ch.场景) map.set('场景', ch.场景)
  if (ch.字数目标 !== undefined) map.set('字数目标', ch.字数目标)
  if (ch.目标情绪) map.set('目标情绪', ch.目标情绪)
  if (ch.核心反转) map.set('核心反转', ch.核心反转)
  if (ch._raw) {
    for (const [k, v] of Object.entries(ch._raw)) {
      if (!map.has(k)) map.set(k, v)
    }
  }
  return map
}

/** 写入章节 md（测试造章用，签名与原 writeChapter 一致） */
export function writeChapter(filePath: string, ch: ChapterMeta, body: string): void {
  writeFile(filePath, stringifyFlat(chapterToMap(ch)), body)
}
