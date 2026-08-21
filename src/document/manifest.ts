/**
 * 项目清单（W0-1 §4.2）—— `项目/文档清单.jsonl`。
 *
 * 只存身份/排序/状态/标签投影，不存正文/标题。行序无语义，按 id 幂等合并。
 * - 读：jsonl 解析，header 取 version，entry 按 id 存 Map（后写覆盖）；非法行跳过降级。
 * - 写：原子重写整文件（追加 + 重写，atomicWriteFile）。
 * - order：章由文件名编号派生顺序，**省略 order 字段**；自由区文档与文件夹才有 order。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'

/** 清单条目：身份 + 排序投影。folder 无 status。 */
export interface ManifestEntry {
  id: string
  nodeType: 'document' | 'folder'
  path: string
  parentId: string | null
  /** 排序值；编号派生文档（章）省略此字段（order 与编号不双真相）。 */
  order?: number
  /** 文档状态投影（folder 无）；可从磁盘 + git 重建。 */
  status?: string
  tags?: string[]
  // ── 定稿基线（去 git 版本系统用）──────────────
  /** 最后一次定稿的内容指纹（`sha256:xxx`）；无/不存在 = 从未定稿。 */
  finalizedRevision?: string
  /** 最后一次定稿时间（ISO 时间戳）。 */
  finalizedAt?: string
}

/** 清单：version + 按 id 幂等合并的条目集。 */
export interface Manifest {
  version: number
  entries: Map<string, ManifestEntry>
}

const HEADER_TYPE = 'header'
const DEFAULT_VERSION = 1

/** jsonl 一行的宽松形状（解析后逐字段校验）。 */
type RawLine = { [k: string]: unknown }

/** 读清单（W0-1 §4.2）。
 *  - 文件不存在 → 空清单（version 默认 1）。
 *  - 非法 JSON 行 / 缺关键字段的行跳过（损坏降级，不阻断）。 */
export function readManifest(filePath: string): Manifest {
  const entries = new Map<string, ManifestEntry>()
  if (!existsSync(filePath)) return { version: DEFAULT_VERSION, entries }
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch {
    return { version: DEFAULT_VERSION, entries }
  }
  let version = DEFAULT_VERSION
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let obj: RawLine
    try {
      obj = JSON.parse(line) as RawLine
    } catch {
      continue // 非法行跳过（损坏降级）
    }
    if (obj.type === HEADER_TYPE && typeof obj.version === 'number') {
      version = obj.version
      continue
    }
    if (typeof obj.id === 'string' && (obj.nodeType === 'document' || obj.nodeType === 'folder')) {
      entries.set(obj.id, parseEntry(obj))
    }
  }
  return { version, entries }
}

function parseEntry(obj: RawLine): ManifestEntry {
  const entry: ManifestEntry = {
    id: obj.id as string,
    nodeType: obj.nodeType as 'document' | 'folder',
    path: typeof obj.path === 'string' ? obj.path : '',
    parentId: typeof obj.parentId === 'string' ? obj.parentId : null,
  }
  if (typeof obj.order === 'number') entry.order = obj.order
  if (typeof obj.status === 'string') entry.status = obj.status
  if (typeof obj.finalizedRevision === 'string') entry.finalizedRevision = obj.finalizedRevision
  if (typeof obj.finalizedAt === 'string') entry.finalizedAt = obj.finalizedAt
  if (Array.isArray(obj.tags)) {
    const tags = obj.tags.filter((t): t is string => typeof t === 'string')
    if (tags.length > 0) entry.tags = tags
  }
  return entry
}

/** 幂等合并：同 id 后写覆盖（清单行序无语义）。 */
/** 已定稿路径集合（V-P2-2 导出 / learn 收割 H-1 共用的单一判定）：
 *  文档条目且有 finalizedRevision（曾定稿）→ 其 path 入集合。
 *  旧书无清单 / 清单无任何文档条目（损坏降级）→ null（无法判定，调用方保持全量，
 *  与历史行为一致）。路径为 manifest 口径的正斜杠相对路径。 */
export function finalizedPathSet(bookRoot: string): Set<string> | null {
  const entries = [...readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.values()]
  const docs = entries.filter((e) => e.nodeType === 'document')
  if (docs.length === 0) return null
  const set = new Set<string>()
  for (const e of docs) if (e.finalizedRevision) set.add(e.path)
  return set
}

/** 已定稿章号集合（低级项·第六轮：assembleStatus currentChapter 口径收口的共享判定）：
 *  文档条目且有 finalizedRevision（曾定稿）→ 按文件名前缀数值取章号（定稿改名 3/4 位
 *  补零均命中，与 state.ts skipFinalizedChapters 同一口径）。 */
export function finalizedChapterNumbers(m: Manifest): Set<number> {
  const out = new Set<number>()
  for (const e of m.entries.values()) {
    if (e.nodeType !== 'document' || !e.finalizedRevision) continue
    const base = e.path.split('/').pop() ?? ''
    const g = base.match(/^(\d+)-/)
    if (g) out.add(Number(g[1]))
  }
  return out
}

/** PL-2（第七轮）：书级定稿章号集合——清单缺失 → undefined（无清单的旧书/测试夹具
 *  保持全量口径），清单在册 → 实际集合（可为空集 = 新书零定稿，assembleStatus 据此
 *  得 currentChapter=0，不再回落「含草稿全量」——此前空集与缺省同走全量分支，
 *  清单在册零定稿的新书会把写作中草稿计进「已定稿最新章号」）。 */
export function finalizedChapterSetOfBook(bookRoot: string): Set<number> | undefined {
  const fp = join(bookRoot, '项目', '文档清单.jsonl')
  if (!existsSync(fp)) return undefined
  return finalizedChapterNumbers(readManifest(fp))
}

export function upsertEntry(manifest: Manifest, entry: ManifestEntry): void {
  manifest.entries.set(entry.id, entry)
}

/** 按 id 删除条目。 */
export function removeEntry(manifest: Manifest, id: string): boolean {
  return manifest.entries.delete(id)
}

/** 原子写回整文件（追加 + 重写整文件原子替换，W0-1 §4.2）。 */
export function writeManifest(filePath: string, manifest: Manifest): void {
  const lines: string[] = [JSON.stringify({ version: manifest.version, type: HEADER_TYPE })]
  for (const e of manifest.entries.values()) {
    lines.push(JSON.stringify(e))
  }
  atomicWriteFile(filePath, lines.join('\n') + '\n', { fsync: true })
}
