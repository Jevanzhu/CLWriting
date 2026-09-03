/**
 * 文档 revision —— 文件原始字节 SHA-256（W0-1 §5）。
 *
 * revision 是保存协议的并发控制依据（不以 mtime 为唯一判据）。
 * 字节指纹单源于 fs/hash.ts（M10 G1 下沉），与 gate/confirm 的确认哈希同源——
 * 防伪哈希与 revision 共用同一份字节指纹，不重复实现。
 */
import { hashBytes, hashFile } from '../fs/hash.js'

/** revision 类型：文件字节 SHA-256，或 null（新建/无基线）。 */
export type Revision = `sha256:${string}` | null

/** 算文件当前字节的 revision（W0-1 §5）。文件不存在会抛——调用方负责存在性校验。 */
export function computeRevision(filePath: string): `sha256:${string}` {
  return hashFile(filePath) as `sha256:${string}`
}

/** R39-11（三十九轮）：内存字节版 revision——调用方已整读 Buffer（executeSave 单读
 * 派生：rev/UTF-8 闸/旧文/快照四产物同源）时与 hashFile 同算法免二次读盘。 */
export function computeRevisionBytes(data: Buffer): `sha256:${string}` {
  return hashBytes(data) as `sha256:${string}`
}
