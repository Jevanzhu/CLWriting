/**
 * 稳定 ID（W0-1 §4.1）—— 文档的持久身份，path 变化不影响。
 *
 * - 正式 ID：`doc_` / `folder_` + 26 位 Crockford base32 ULID（48bit ms + 80bit 随机）。
 * - legacy：旧文件无 ID 时运行期用 `legacy:<sha256(path)[:16]>` 临时 ID；首次结构性操作时落盘。
 *
 * ULID 实现已下沉到 fs/id.ts（format 层等叶子层可直接 import，不向上依赖 document/）。
 * 此处 re-export 保持既有 import 路径兼容。
 */
import { createHash } from 'node:crypto'
import { ulid } from '../fs/id.js'

// re-export 供既有 import { ulid, decodeUlidTime } from '.../stable-id.js' 的调用方
export { ulid, decodeUlidTime } from '../fs/id.js'

/** 生成文档稳定 ID：`doc_` + 26 ULID。 */
export function generateDocId(): string {
  return 'doc_' + ulid()
}

/** 生成文件夹稳定 ID：`folder_` + 26 ULID。 */
export function generateFolderId(): string {
  return 'folder_' + ulid()
}

/** 旧文件无 ID 时的运行期临时 ID：`legacy:` + sha256(path) 前 16 位 hex。 */
export function legacyId(path: string): string {
  const hash = createHash('sha256').update(path, 'utf-8').digest('hex')
  return 'legacy:' + hash.slice(0, 16)
}
