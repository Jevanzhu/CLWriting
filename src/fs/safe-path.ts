/**
 * 共享路径安全校验（P1-3 / D3 defense-in-depth）。
 *
 * manifest 路径（文档清单.jsonl 中 m.path）与 books.jsonl 同属可篡改的本地数据文件，
 * 需统一校验防止 join(bookRoot, m.path) 越出 bookRoot。
 *
 * 本模块还导出 symlink 校验共享函数（isWithinRoot），供 trash.ts / files.ts 等
 * 各 safePath 变体统一引用，确保防护行为一致（fail-closed）。
 */
import { join, relative, isAbsolute } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'

/**
 * symlink realpath 二次校验（防符号链接指向 bookRoot 外）。
 *
 * fail-closed 策略：realpath 失败 → false（拒绝），与 resolveSafePath 一致。
 * 文件不存在（新建场景）→ true（只做路径校验即可）。
 */
export function isWithinRoot(bookRoot: string, abs: string): boolean {
  if (!existsSync(abs)) return true
  try {
    const realRoot = realpathSync(bookRoot)
    const real = realpathSync(abs)
    return !relative(realRoot, real).startsWith('..')
  } catch {
    return false // realpath 失败 → 拒绝（fail-closed）
  }
}

/**
 * 校验 docId 不含路径穿越字符（manifest 可篡改数据面 defense-in-depth）。
 *
 * docId 系统生成（ULID 或 legacy:<hex>），正常不含分隔符。
 * 此函数供内核层（version/analysis）调用，与 API 端点（snapshots.ts）的
 * docId 白名单保持一致：拒绝 `\0` / `/` / `\` / `..`。
 */
export function safeDocId(docId: string): boolean {
  return !docId.includes('\0') && !docId.includes('/') && !docId.includes('\\') && !docId.includes('..')
}

/** 校验 manifest 路径不越出 bookRoot，返回绝对路径或 null（非法）。 */
export function safeManifestPath(bookRoot: string, rel: string): string | null {
  if (!rel || rel.includes('\0') || isAbsolute(rel)) return null
  const abs = join(bookRoot, rel)
  if (relative(bookRoot, abs).startsWith('..')) return null
  // B-P1-4：symlink realpath 二次校验（同 DocumentService.resolveSafePath 模式）。
  // 文件存在时解析符号链接目标，防止 symlink 指向 bookRoot 外；不存在（新建场景）只做路径校验。
  // bookRoot 自身也需 realpath（macOS tmpdir 常是 /var→/private/var 符号链接，否则 relative 误判越出）。
  if (existsSync(abs)) {
    // P1-R2：realpathSync 可能抛（EACCES/ELOOP/断链），须 fail-closed（与 isWithinRoot 一致）
    try {
      const real = realpathSync(abs)
      const realRoot = realpathSync(bookRoot)
      if (relative(realRoot, real).startsWith('..')) return null
      return real
    } catch {
      return null
    }
  }
  return abs
}
