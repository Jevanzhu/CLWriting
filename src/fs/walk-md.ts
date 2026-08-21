/**
 * L-P1（第八轮）：带 symlink 环剪枝 + 根界约束的 .md 深度优先查找器。
 *
 * book-search.walkMd（第六轮）修复的同族收口：summary/materials/leads 三处递归找章
 * 此前无 visited（书内 a→b→a symlink 环深递归，靠帧内 try/catch 兜 RangeError 整项
 * 退化 + 大量无效 IO）、也无根界（书内指向书外的 symlink 被跟随，引文命中/摘要正文
 * 会整读外部文件）。统一抽此共享实现：
 * - 环剪枝：realpath 去重（visited），二次到访即剪；
 * - 根界 = startDir 自身：查找器都从书内子目录起遍（写作/正文 等），越出即拒
 *   （fail-closed，与 safe-path 同向）；
 * - onFile 返回非 undefined 即短路返回（找第一个命中）。
 */
import { readdirSync, realpathSync, type Dirent } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'

const ESCAPE_SEGMENT_RE = /^\.\.([\\/]|$)/

export function walkMdFind<T>(
  startDir: string,
  onFile: (abs: string, name: string) => T | undefined,
): T | undefined {
  let realRoot: string
  try {
    realRoot = realpathSync(startDir)
  } catch {
    return undefined
  }
  const visited = new Set<string>()
  const walk = (dir: string): T | undefined => {
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      return undefined // 断链/不可读 → 跳过
    }
    if (visited.has(real)) return undefined // 环剪枝
    visited.add(real)
    const rel = relative(realRoot, real)
    if (rel !== '' && (ESCAPE_SEGMENT_RE.test(rel) || isAbsolute(rel))) return undefined // 越出起遍目录 → 拒
    let entries: Dirent[]
    try {
      entries = readdirSync(real, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const e of entries) {
      if (e.name.startsWith('._')) continue // macOS 资源分叉噪声
      const fp = join(real, e.name)
      if (e.isDirectory()) {
        const found = walk(fp)
        if (found !== undefined) return found
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const found = onFile(fp, e.name)
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  return walk(startDir)
}
