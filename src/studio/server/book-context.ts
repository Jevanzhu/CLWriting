/**
 * 书级上下文读取（P1-8 架构下沉：readKind 已下沉 src/format/kind.ts）。
 * 本文件保留为兼容层，re-export 内核实现，既有 import 方零感知。
 *
 * resolveBook：解析书 entry → bookRoot（health / files / documents 共用，消除复制粘贴）。
 */
import { join } from 'node:path'
import { readBooks } from '../../install/books.js'

export { readKind } from '../../format/kind.js'

/** 解析书：找 entry → bookRoot；workDir 缺 / 书不存在 → error 联合 */
export function resolveBook(
  workDir: string | null,
  name: string | undefined,
): { bookRoot: string } | { error: string; status: number } {
  if (!workDir) return { error: '未定位到工作目录', status: 400 }
  if (!name) return { error: '缺少书名', status: 400 }
  const entry = readBooks(workDir).find((b) => b.name === name)
  if (!entry) return { error: `没有这本书：${name}`, status: 404 }
  return { bookRoot: join(workDir, entry.path) }
}