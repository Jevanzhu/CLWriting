/**
 * 目录 mtime 签名单源——「被扫目录全集指纹」探针，供 TTL 缓存的 probe 复用。
 *
 * 手法：逐目录 stat 取 mtimeMs 拼串，缺失计 '-'（新增/删除/改名等结构变化即时失效；
 * 目录内就地内容改写不触碰目录 mtime，由各方 TTL 兜底——宁多扫不脏读）。
 * 消费方：search.ts（可搜目录全集）/ foreshadows.ts（设定/伏笔 + 写作/正文）。
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'

/** 目录 mtime 签名（rel 目录名逐条，缺失计 '-'）。调用方须在扫描**前**取值——
 *  扫描期间落盘的变更会使签名失配，下次按失效重扫。 */
export function dirSignature(bookRoot: string, dirs: readonly string[]): string {
  const parts: string[] = []
  for (const dir of dirs) {
    try {
      parts.push(String(statSync(join(bookRoot, dir)).mtimeMs))
    } catch {
      parts.push('-') // 目录不存在
    }
  }
  return parts.join(',')
}
