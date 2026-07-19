/**
 * 稳定 ID（W0-1 §4.1）—— 文档的持久身份，path 变化不影响。
 *
 * - 正式 ID：`doc_` / `folder_` + 26 位 Crockford base32 ULID（48bit ms + 80bit 随机）。
 * - legacy：旧文件无 ID 时运行期用 `legacy:<sha256(path)[:16]>` 临时 ID；首次结构性操作时落盘。
 *
 * 0 运行时依赖红线（package.json 无 dependencies）：ULID 自实现，不引包。
 */
import { createHash, randomBytes } from 'node:crypto'

/** Crockford base32 字母表（剔除 I/L/O/U 防混淆）。 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 把 bigint 编码为定长 Crockford base32（高位在前，不足前导 0）。 */
function encodeCrockford(value: bigint, length: number): string {
  const chars: string[] = []
  let v = value
  for (let i = 0; i < length; i++) {
    chars.push(CROCKFORD[Number(v & 0x1fn)]!)
    v >>= 5n
  }
  return chars.reverse().join('')
}

/** 生成 26 字符 Crockford base32 ULID：10 字符时间戳（48bit ms）+ 16 字符随机（80bit）。 */
export function ulid(): string {
  const time = BigInt(Date.now())
  const rand = randomBytes(10) // 80bit 随机
  let randVal = 0n
  for (const b of rand) randVal = (randVal << 8n) | BigInt(b)
  return encodeCrockford(time, 10) + encodeCrockford(randVal, 16)
}

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
