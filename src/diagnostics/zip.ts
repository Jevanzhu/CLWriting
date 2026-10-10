/**
 * 诊断包 ZIP 写入器（store 模式，手写，零新依赖）。
 *
 * 为什么不引 zip 库：本仓唯一的打包需求就是诊断包，为它引一个第三方 zip 实现
 * （含传递依赖与供应链面）不划算；store（不压缩）模式的字节结构简单到可逐字段
 * 审计，而诊断包体量本就是 MB 级（近 7 天 JSONL 日志），不压缩的代价可接受。
 *
 * 三条记录足矣（ZIP 的最小可解压子集，APPNOTE 4.3.6/4.3.7/4.3.12/4.3.16）：
 * 本地文件头 + 数据 / 中央目录项 / 中央目录结束记录。
 *
 * 中文条目名必须置 UTF-8 标志位（通用位标志 bit 11 = 0x0800）：不置位时解压端按
 * 非 UTF-8 的 OEM 码页解码条目名，`日志/app-20260101.jsonl` 在 win 资源管理器 / 7z /
 * unzip 下逐端各按各的默认表解成乱码——包是给作者/开发者人工看的，条目名不可读即废。
 *
 * 未实现（登记边界，诊断包规模用不到，超限即抛）：zip64（>4GiB 或 >65535 条目）、
 * 压缩方法 8、加密、数据描述符、归档注释、条目注释、时间戳精度（DOS 时间 2 秒粒度）。
 */
import { crc32 } from 'node:zlib'

export interface ZipEntry {
  /** 包内路径（`/` 分隔；中文用 UTF-8 原样），不校验唯一性 */
  name: string
  data: Buffer | string
}

/** UTF-8 条目名标志位（通用位标志 bit 11） */
const FLAG_UTF8 = 0x0800
/** 需要的解压版本 2.0（store 模式最低要求） */
const VERSION = 20
/** 版本来源：host 3 = UNIX（配合下方外部属性给出常规文件权限位） */
const VERSION_MADE_BY = (3 << 8) | VERSION
/** 外部属性：常规文件 rw-r--r--（unix 权限位左移 16 位；0 会让部分解压端按 000 处理）。
 *  `>>> 0` 必须——JS 位运算是 32 位有符号，`0o100644 << 16` 出来是负数，writeUInt32LE 直接抛。 */
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0
const MAX_ENTRIES = 0xffff
const MAX_UINT32 = 0xffffffff

/** DOS 时间/日期对（本地时区；1980 年前按 1980-01-01 收口） */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(d.getFullYear(), 1980)
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/** 组一个 store 模式 ZIP（返回完整字节）。entries 顺序即包内顺序。 */
export function buildZipStore(entries: readonly ZipEntry[], opts: { mtime?: Date } = {}): Buffer {
  const mtime = opts.mtime ?? new Date()
  const { time, date } = dosDateTime(mtime)
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`诊断包条目数超上限（${entries.length} > ${MAX_ENTRIES}），需 zip64——本写入器不实现`)
  }
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf-8')
    const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf-8') : e.data
    if (data.length > MAX_UINT32 || offset > MAX_UINT32) {
      throw new Error('诊断包体积超 4GiB，需 zip64——本写入器不实现')
    }
    const sum = crc32(data) >>> 0

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(VERSION, 4)
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(0, 8) // 压缩方法 0 = store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(data.length, 18) // 压缩后大小（store 恒等于原始大小）
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // 扩展字段长度
    name.copy(local, 30)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(VERSION_MADE_BY, 4)
    central.writeUInt16LE(VERSION, 6)
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(sum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // 扩展字段
    central.writeUInt16LE(0, 32) // 条目注释
    central.writeUInt16LE(0, 34) // 起始磁盘号
    central.writeUInt16LE(0, 36) // 内部属性
    central.writeUInt32LE(EXTERNAL_ATTRS, 38)
    central.writeUInt32LE(offset, 42) // 本地头偏移
    name.copy(central, 46)

    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4) // 本磁盘号
  end.writeUInt16LE(0, 6) // 中央目录起始磁盘号
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // 归档注释长度
  return Buffer.concat([...locals, centralBuf, end])
}
