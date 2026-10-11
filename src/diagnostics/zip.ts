/**
 * 诊断包 ZIP 写入器（store 模式，手写，零新依赖）。
 *
 * 为什么不引 zip 库：本仓唯一的打包需求就是诊断包，为它引一个第三方 zip 实现（含传递依赖与供应链
 * 面）不划算；store（不压缩）模式的字节结构简单到可逐字段审计，而诊断包体量本就是 MB 级（近 7 天
 * JSONL 日志），不压缩的代价可接受。
 *
 * 三条记录足矣（ZIP 的最小可解压子集，APPNOTE 4.3.6/4.3.7/4.3.12/4.3.16）：本地文件头 + 数据 /
 * 中央目录项 / 中央目录结束记录。
 *
 * 中文条目名必须置 UTF-8 标志位（通用位标志 bit 11 = 0x0800）：不置位时解压端按非 UTF-8 的 OEM
 * 码页解码条目名，`日志/app-20260101.jsonl` 在 win 资源管理器 / 7z / unzip 下逐端各按各的默认表
 * 解成乱码——包是给作者/开发者人工看的，条目名不可读即废。
 *
 * 超限策略（原「超限即抛」在诊断包侧是死路——包没生成、用户拿不到排查件）：
 * - `buildZipStoreVolumes`：单卷上限（条目数 / 本地段累计字节）内打包；超限按**条目边界**切多卷
 *   （每卷都是独立可解压的完整 ZIP，文件名由调用方按卷序区分）；单条自身超单卷上限无法切分 →
 *   截断省略并列入 droppedNames（调用方据此给用户提示，不静默丢）。
 * - `buildZipStore`：单卷 API 保留 fail-loud 语义（超限抛错，不产坏包）——既有调用/测试契约。
 *
 * 未实现（登记边界）：zip64（本写入器以分卷规避其触发面）、压缩方法 8、加密、数据描述符、
 * 归档注释、条目注释、时间戳精度（DOS 时间 2 秒粒度）。
 */
import { crc32 } from 'node:zlib'

export interface ZipEntry {
  /** 包内路径（`/` 分隔；中文用 UTF-8 原样），不校验唯一性 */
  name: string
  data: Buffer | string
}

/** 单卷容量上限。生产缺省 = ZIP 格式硬上限；测试注入窄限可直接验分卷/截断路径
 *  （真造 4GiB 数据不可行的可测性口，同 mtime 注入先例）。 */
export interface ZipStoreLimits {
  /** 单卷最大条目数（EOCD 条目数字段 uint16） */
  maxEntries: number
  /** 单卷本地段累计字节上限（保守口径：中央目录起始偏移为 uint32，本地段累计须收敛） */
  maxArchiveBytes: number
}

const DEFAULT_ZIP_LIMITS: ZipStoreLimits = { maxEntries: 0xffff, maxArchiveBytes: 0xffffffff }

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

/** 编码后的条目标记（utf-8 名 + 字节数据，尺寸预检与写卷共用） */
interface EncodedEntry {
  name: Buffer
  data: Buffer
}

function encodeEntry(e: ZipEntry): EncodedEntry {
  return {
    name: Buffer.from(e.name, 'utf-8'),
    data: typeof e.data === 'string' ? Buffer.from(e.data, 'utf-8') : e.data,
  }
}

/** 写「一卷」store 模式 ZIP（返回完整字节）。entries 顺序即包内顺序。
 *  本函数保留格式级 fail-loud 双检（调用方已按 limits 切卷/截断，此处是纵深防御）。 */
function writeArchive(entries: readonly EncodedEntry[], mtime: Date): Buffer {
  const { time, date } = dosDateTime(mtime)
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`诊断包条目数超上限（${entries.length} > ${MAX_ENTRIES}），需 zip64——本写入器不实现`)
  }
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const data = e.data
    const name = e.name
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

/** 分卷打包结果 */
export interface ZipVolumePack {
  /** 每卷一个完整 store 模式 ZIP（卷序 = 条目序；空输入 = 零卷） */
  volumes: Buffer[]
  /** 实际入卷的条目名（按输入序；= 输入减去 droppedNames） */
  packedNames: string[]
  /** 单条自身超单卷上限、无法切分而被截断省略的条目名（按输入序；调用方须提示） */
  droppedNames: string[]
}

/**
 * 分卷打包：条目按输入序贪心装箱，单卷限 maxEntries 条 / maxArchiveBytes 本地段累计字节；
 * 放不下的开新卷（条目边界切分，绝不切条目）——每卷独立可解压。单条自身超上限 → 省略留痕。
 * 诊断包入口用本函数；单卷 fail-loud 语义见 buildZipStore。
 */
export function buildZipStoreVolumes(
  entries: readonly ZipEntry[],
  opts: { mtime?: Date; limits?: Partial<ZipStoreLimits> } = {},
): ZipVolumePack {
  const mtime = opts.mtime ?? new Date()
  const limits: ZipStoreLimits = { ...DEFAULT_ZIP_LIMITS, ...opts.limits }
  const volumes: Buffer[] = []
  const packedNames: string[] = []
  const droppedNames: string[] = []
  let current: EncodedEntry[] = []
  let currentBytes = 0
  const flush = (): void => {
    if (current.length === 0) return
    volumes.push(writeArchive(current, mtime))
    current = []
    currentBytes = 0
  }
  for (const e of entries) {
    const encoded = encodeEntry(e)
    const localBytes = 30 + encoded.name.length + encoded.data.length
    if (localBytes > limits.maxArchiveBytes) {
      droppedNames.push(e.name)
      continue
    }
    if (current.length >= limits.maxEntries || currentBytes + localBytes > limits.maxArchiveBytes) flush()
    current.push(encoded)
    currentBytes += localBytes
    packedNames.push(e.name)
  }
  flush()
  return { volumes, packedNames, droppedNames }
}

/** 组一个 store 模式 ZIP（返回完整字节）。entries 顺序即包内顺序。
 *  单卷语义：超上限（>65535 条目或本地段累计 >4GiB）抛出（fail-loud，不产坏包）——
 *  诊断包侧改用 buildZipStoreVolumes 分卷（见文件头注）。 */
export function buildZipStore(entries: readonly ZipEntry[], opts: { mtime?: Date } = {}): Buffer {
  const mtime = opts.mtime ?? new Date()
  const pack = buildZipStoreVolumes(entries, { mtime })
  if (pack.droppedNames.length > 0) {
    throw new Error('诊断包体积超 4GiB，需 zip64——本写入器不实现')
  }
  if (pack.volumes.length > 1) {
    throw new Error(`诊断包条目数超上限（${entries.length} > ${MAX_ENTRIES}），需 zip64——本写入器不实现`)
  }
  return pack.volumes[0] ?? writeArchive([], mtime)
}
