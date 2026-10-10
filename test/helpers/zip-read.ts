/**
 * 测试用 ZIP 读取器（store 模式子集）——与 src/diagnostics/zip.ts 对称的写读对。
 *
 * 独立实现（不 import 被测模块的任何函数）：CRC 校验自带表驱动实现，
 * 用被测模块同一个 crc32 当判据等于自证。写入端字段错位/标志位漏置时，
 * 本读取器按自己的规则解析同样会错——两边同时错到自洽的概率远低于单边。
 */

/** CRC-32（IEEE 802.3，多项式 0xEDB88320 反射实现）——独立于被测模块的实现 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32Independent(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ReadEntry {
  name: string
  data: Buffer
  crc: number
  /** 通用位标志（bit 11 = UTF-8 条目名） */
  flags: number
  /** 压缩方法（0 = store） */
  method: number
  /** 本地文件头偏移（中央目录记录值） */
  localOffset: number
  /** 中央目录里声明的解压后大小 */
  size: number
}

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

/** 解析 store 模式 ZIP（不支持 zip64/压缩/多盘；不满足即抛，测试据此判红）。 */
export function readZipStore(buf: Buffer): ReadEntry[] {
  // EOCD 定长 22 字节（本仓写入器注释长度恒 0，且无归档注释）——末 22 字节即它
  if (buf.length < 22) throw new Error('zip 太短')
  const eocd = buf.length - 22
  if (buf.readUInt32LE(eocd) !== EOCD_SIG) throw new Error('EOCD 签名不符')
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) throw new Error('多盘归档不支持')
  const count = buf.readUInt16LE(eocd + 10)
  if (buf.readUInt16LE(eocd + 8) !== count) throw new Error('条目数（本盘/总数）不一致')
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (buf.readUInt16LE(eocd + 20) !== 0) throw new Error('归档注释长度非 0')
  if (cdOffset + cdSize !== eocd) throw new Error(`中央目录未紧邻 EOCD（${cdOffset}+${cdSize} ≠ ${eocd}）`)

  const out: ReadEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`第 ${i} 条中央目录项签名不符`)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    if (flags !== 0x0800) throw new Error(`第 ${i} 条 UTF-8 标志位未置（flags=0x${flags.toString(16)}）`)
    if (method !== 0) throw new Error(`第 ${i} 条不是 store 模式（method=${method}）`)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8')

    if (buf.readUInt32LE(localOffset) !== LOC_SIG) throw new Error(`${name}: 本地头签名不符`)
    const lFlags = buf.readUInt16LE(localOffset + 6)
    const lMethod = buf.readUInt16LE(localOffset + 8)
    const lCrc = buf.readUInt32LE(localOffset + 14)
    const lSize = buf.readUInt32LE(localOffset + 18)
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const lName = buf.subarray(localOffset + 30, localOffset + 30 + lNameLen).toString('utf-8')
    if (lName !== name) throw new Error(`本地头条目名 ${lName} ≠ 中央目录 ${name}`)
    if (flags !== lFlags || method !== lMethod || crc !== lCrc || size !== lSize) {
      throw new Error(`${name}: 本地头与中央目录字段不一致`)
    }
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const data = buf.subarray(dataStart, dataStart + lSize)
    if (crc32Independent(data) !== crc) throw new Error(`${name}: CRC 校验失败`)

    out.push({ name, data: Buffer.from(data), crc, flags, method, localOffset, size })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}
