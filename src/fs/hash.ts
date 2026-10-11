/**
 * 文件哈希 —— 文件原始字节 SHA-256（零依赖，node:crypto 内置）。
 *
 * 底座级通用工具，单源：revision（保存协议并发控制）、gate/confirm（确认哈希）、
 * state（态机校验）、review（草稿哈希）共用同一份字节指纹。
 * 从 gate/confirm 下沉至此（M10），消除 document/revision → gate 的反向依赖。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** 算文件原始字节的 SHA-256 哈希（所见即所签）。返回 'sha256:' 前缀的十六进制。 */
export function hashFile(filePath: string): string {
  const buf = readFileSync(filePath)
  return 'sha256:' + createHash('sha256').update(buf).digest('hex')
}

/** 字节指纹（内存字节版）：与 hashFile 同算法。调用方已持字节
 *  （如定稿锁内一次读）时免二次读盘，保证指纹与内容严格同源。 */
export function hashBytes(data: Buffer): string {
  return 'sha256:' + createHash('sha256').update(data).digest('hex')
}

/** 文件变更指纹（stat 版，非内容哈希）：`${mtimeNs}:${size}`。
 *
 *  单源化：此串此前在 format/style-entry、format/iron-rules、
 *  check/run-tree-issues、check/tree-issues-cache、process/skills 五处各手抄一份。
 *  调用方须以 `statSync(p, { bigint: true })` 取 stat（ns 级精度，同毫秒内「改回
 *  同长内容」不漏判——ms 档有该漏网）；stat 失败/文件不存在的 'absent' 等缺省值由
 *  调用方自决（各处语义不同：'no-entries' / 'unstable-…' / null），不入本函数。
 *  process/skills 原分隔符为逗号（纯进程内 Map 键、无落盘）：收敛后统一冒号，
 *  行为等价（仅在升级当次致一次冷读）。
 *
 *  两种不入本函数的变体（登记理由，勿再「顺手统一」）：
 *  - document/manifest.ts `${size}:${mtimeNs}`：字段顺序相反，且与
 *    fs/mtime-precision.isCoarseMtimeNs 降级策略绑定（低精度卷返回 null 绕缓存），
 *    是「指纹 + 精度判定」的复合语义；
 *  - studio/server/api/rhythm.ts `${size}:${mtimeMs}`：HTTP 历史签名面，Number 毫秒
 *    且保留亚毫秒小数位（snapshots/search 同族），换 ns 会变签名口径。 */
export function statFingerprint(st: { mtimeNs: bigint; size: bigint }): string {
  return `${st.mtimeNs}:${st.size}`
}
