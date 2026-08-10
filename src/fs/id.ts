/**
 * ID 生成（ULID）—— 纯函数，只用 node:crypto，无上层依赖。
 *
 * 从 document/stable-id.ts 下沉到 fs/ 层（format/style-candidate.ts 等叶子层可直接 import，
 * 不再向上依赖 document/）。
 *
 * 26 字符 Crockford base32 ULID：48bit ms + 80bit 随机。
 */
import { randomBytes } from 'node:crypto'

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

/**
 * 解出 ULID 前 10 字符编码的毫秒时间戳（48bit，JS number 可安全表示）。
 * 快照清理按时间分桶用——比逐个读文件 front matter 便宜。
 * 非法字符返回 0（调用方按"最旧"处理）。
 */
export function decodeUlidTime(id: string): number {
  let v = 0
  for (const c of id.slice(0, 10)) {
    const i = CROCKFORD.indexOf(c)
    if (i < 0) return 0
    v = v * 32 + i
  }
  return v
}
