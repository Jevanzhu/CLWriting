/**
 * 书级上下文读取（P1-8 架构下沉：readKind 已下沉 src/format/kind.ts）。
 * 本文件保留为兼容层，re-export 内核实现，既有 import 方零感知。
 *
 * resolveBook：解析书 entry → bookRoot（health / files / documents 及各 docId 线端点共用，
 * 消除「workDir 判空 + readBooks().find + 404」复制粘贴）。
 * resolveDocEntry：docId → 文档清单条目（check / review / rewrite / analysis 等直读线共用，
 * 消除 readManifest(join(...,'文档清单.jsonl')).entries.get(docId) 样板）。
 */
import { join } from 'node:path'
import { readBooks, type BookEntry } from '../../install/books.js'
import { readManifest, type ManifestEntry } from '../../document/manifest.js'

export { readKind } from '../../format/kind.js'

/** 解析书：找 entry → bookRoot；workDir 缺 / 书不存在 → error 联合。
 *  hh §八-12：error 分支带机器码（调用方直送 replyError，信封统一 {code,error}）。 */
export function resolveBook(
  workDir: string | null,
  name: string | undefined,
): { bookRoot: string; entry: BookEntry } | { error: string; status: number; code: string } {
  if (!workDir) return { error: '未定位到工作目录', status: 400, code: 'NO_WORKDIR' }
  if (!name) return { error: '缺少书名', status: 400, code: 'BAD_INPUT' }
  const entry = readBooks(workDir).find((b) => b.name === name)
  if (!entry) return { error: `没有这本书：${name}`, status: 404, code: 'NOT_FOUND' }
  return { bookRoot: join(workDir, entry.path), entry }
}

/** docId → 文档清单条目；未登记 / 清单缺失 → null（调用方按 NOT_FOUND 语义回复）。 */
export function resolveDocEntry(bookRoot: string, docId: string): ManifestEntry | null {
  return readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId) ?? null
}
