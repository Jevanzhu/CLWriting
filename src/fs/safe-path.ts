/**
 * 共享路径安全校验（P1-3 / D3 defense-in-depth）。
 *
 * manifest 路径（文档清单.jsonl 中 m.path）与 books.jsonl 同属可篡改的本地数据文件，
 * 需统一校验防止 join(bookRoot, m.path) 越出 bookRoot。
 */
import { join, relative, isAbsolute } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'

/** 校验 manifest 路径不越出 bookRoot，返回绝对路径或 null（非法）。 */
export function safeManifestPath(bookRoot: string, rel: string): string | null {
  if (!rel || rel.includes('\0') || isAbsolute(rel)) return null
  const abs = join(bookRoot, rel)
  if (relative(bookRoot, abs).startsWith('..')) return null
  // B-P1-4：symlink realpath 二次校验（同 DocumentService.resolveSafePath 模式）。
  // 文件存在时解析符号链接目标，防止 symlink 指向 bookRoot 外；不存在（新建场景）只做路径校验。
  // bookRoot 自身也需 realpath（macOS tmpdir 常是 /var→/private/var 符号链接，否则 relative 误判越出）。
  if (existsSync(abs)) {
    const real = realpathSync(abs)
    const realRoot = realpathSync(bookRoot)
    if (relative(realRoot, real).startsWith('..')) return null
    return real
  }
  return abs
}
