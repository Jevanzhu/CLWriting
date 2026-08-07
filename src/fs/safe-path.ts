/**
 * 共享路径安全校验（P1-3 / D3 defense-in-depth）。
 *
 * manifest 路径（文档清单.jsonl 中 m.path）与 books.jsonl 同属可篡改的本地数据文件，
 * 需统一校验防止 join(bookRoot, m.path) 越出 bookRoot。
 */
import { join, relative, isAbsolute } from 'node:path'

/** 校验 manifest 路径不越出 bookRoot，返回绝对路径或 null（非法）。 */
export function safeManifestPath(bookRoot: string, rel: string): string | null {
  if (isAbsolute(rel)) return null
  const abs = join(bookRoot, rel)
  if (relative(bookRoot, abs).startsWith('..')) return null
  return abs
}
