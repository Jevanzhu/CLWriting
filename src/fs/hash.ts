/**
 * 文件哈希 —— 文件原始字节 SHA-256（零依赖，node:crypto 内置）。
 *
 * 底座级通用工具，单源：revision（保存协议并发控制）、gate/confirm（确认哈希）、
 * state（态机校验）、review（草稿哈希）共用同一份字节指纹。
 * 从 gate/confirm 下沉至此（M10 G1），消除 document/revision → gate 的反向依赖。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** 算文件原始字节的 SHA-256 哈希（所见即所签）。返回 'sha256:' 前缀的十六进制。 */
export function hashFile(filePath: string): string {
  const buf = readFileSync(filePath)
  return 'sha256:' + createHash('sha256').update(buf).digest('hex')
}
