/**
 * 文档 revision 前端算法（T1.4 对拍 src/document/revision.ts + src/fs/hash.ts）。
 *
 * 服务端 revision = sha256(文件原始字节)（hashFile: readFileSync→buffer→sha256）；
 * /file 返回 content = readFileSync(path,'utf-8')（Node utf-8 解码不剥 BOM，﻿ 留串首）。
 * 前端 TextEncoder.encode(content) UTF-8 编码回字节 = 原始字节（round-trip 恒等，含 BOM）→ sha256。
 * 边界：文件含非法 UTF-8 字节时 Node 解码替成 U+FFFD，round-trip 不恒等——.md 正常不触发，
 * T1.4 对拍若发现差异以服务端 hashFile 口径为准调整。
 */

const encoder = new TextEncoder()

/** 算 content 字符串的 revision（基线/保存期望值）。 */
export async function sha256Revision(content: string): Promise<`sha256:${string}`> {
  const bytes = encoder.encode(content)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `sha256:${hex}`
}

/** 幂等 operationId（保存请求去重，服务端按此判重）。 */
export function newOperationId(): string {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
