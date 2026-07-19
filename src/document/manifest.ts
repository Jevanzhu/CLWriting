/**
 * 项目清单（W0-1 §4.2）—— `项目/文档清单.jsonl`。
 *
 * 只存身份/排序/状态/标签投影，不存正文/标题。行序无语义，按 id 幂等合并。
 * - 读：jsonl 解析，header 取 version，entry 按 id 存 Map（后写覆盖）；非法行跳过降级。
 * - 写：原子重写整文件（追加 + 重写，atomicWriteFile）。
 * - order：章/篇由文件名编号派生顺序，**省略 order 字段**；自由区文档与文件夹才有 order。
 */
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteFile } from '../fs/atomic.js'

/** 清单条目：身份 + 排序投影。folder 无 status。 */
export interface ManifestEntry {
  id: string
  nodeType: 'document' | 'folder'
  path: string
  parentId: string | null
  /** 排序值；编号派生文档（章/篇）省略此字段（order 与编号不双真相）。 */
  order?: number
  /** 文档状态投影（folder 无）；可从磁盘 + git 重建。 */
  status?: string
  tags?: string[]
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
  if (Array.isArray(obj.tags)) {
    const tags = obj.tags.filter((t): t is string => typeof t === 'string')
    if (tags.length > 0) entry.tags = tags
  }
  return entry
}

/** 幂等合并：同 id 后写覆盖（清单行序无语义）。 */
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
  atomicWriteFile(filePath, lines.join('\n') + '\n')
}
