/**
 * 阶段 55：便携包解压（yauzl 解析 + 本模块落盘）。
 *
 * 输入是**远端下载的包**，故解压面自持而非交给成品解压器（后者对包内符号链接条目
 * 普遍不设防：跟随链接写盘 = 任意位置落文件）。本模块只做两件事：yauzl 负责条目解析
 * 与解压流，写盘与路径判定全在这里：
 *  - 条目名一律按 `/` 与 `\` 双分隔符切段，含 `..` 段 / 盘符形态 / 空名 → 整体失败；
 *  - 段级还须过 Windows 形态判据（保留设备名 / 尾点尾空格 / `:` 数据流 / 非法字符）——
 *    这些名字在 win 上写出的不是「一个正常文件」，见 resolveEntryPath 头注；
 *  - 符号链接条目（unix 模式位 S_IFLNK）→ 整体失败，不跟随；
 *  - 落盘前再按解析后的绝对路径复核一次「在目标目录内」（双保险，防归一化绕过）；
 *  - 只放行常规文件与目录；加密条目与非常规压缩方法（只支持 0 与 8）→ 整体失败；
 *  - **条目数与解压总字节有上限**（`resolveExtractLimits`）：「包有多大」由远端说了算，
 *    无上限等于把磁盘交给对方（高压缩比包 = 解压炸弹）。上限是红线，调用方只能收紧。
 *
 * 失败一律抛错并**不清理**目标目录：调用方（更新助手）按 `extract-failed` 收口时
 * 会整目录删掉半成品。
 */
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { openPromise, type Entry, type ZipFile } from 'yauzl'
import { isWinUnsafePathSegment } from '../fs/safe-path.js'

/** unix 文件类型位（`externalFileAttributes` 高 16 位） */
const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

/** 绝对上限：条目数（正常 Electron 便携包数千条目） */
export const EXTRACT_MAX_ENTRIES = 20_000
/** 绝对上限：解压后总字节（正常便携包解压后与包体同量级） */
export const EXTRACT_MAX_TOTAL_BYTES = 3 * 1024 ** 3

export interface ExtractLimits {
  maxEntries: number
  maxTotalBytes: number
}

/**
 * 合并调用方限额与绝对上限：逐项取小——上限是红线，调用方只能在红线之下收紧。
 * 非正 / 非有限值按绝对上限处理，避免 `0` 这类退化入参把正常包全判失败。
 */
export function resolveExtractLimits(limits?: Partial<ExtractLimits>): ExtractLimits {
  const pick = (given: number | undefined, hard: number): number =>
    typeof given === 'number' && Number.isFinite(given) && given > 0 ? Math.min(given, hard) : hard
  return {
    maxEntries: pick(limits?.maxEntries, EXTRACT_MAX_ENTRIES),
    maxTotalBytes: pick(limits?.maxTotalBytes, EXTRACT_MAX_TOTAL_BYTES),
  }
}

/** 条目 unix 模式位（宿主非 unix 造的包没有可信模式位 → null = 按常规文件对待） */
function unixModeOf(entry: Entry): number | null {
  if (entry.versionMadeBy >> 8 !== 3) return null
  return (entry.externalFileAttributes >>> 16) & 0xffff
}

/**
 * 条目名 → 目标目录内的绝对路径；非法（空名 / 含 `..` 段 / 盘符 / 归一化后越界 /
 * 段级 Windows 形态不可用）→ null。目录条目名以分隔符结尾，这里不特殊对待（切段会滤掉空段）。
 *
 * 段级判据走 fs/safe-path 的 isWinUnsafePathSegment 单源：保留设备名（写设备而非文件）、
 * 尾点尾空格（落盘被 FS 静默归一后与既有名撞名）、`:`（NTFS 备用数据流，盘上看不见）三者
 * 在 win 上都不会创建出「一个正常文件」，只判穿越与符号链接等于把这三条留给运行时静默
 * 走样。包体虽经 sha256 锚定（同源发布者），判据仍须自持——头注宣称的不该只是穿越面。
 */
export function resolveEntryPath(destDir: string, name: string): string | null {
  if (!name || name.includes('\0')) return null
  const parts = name.split(/[\\/]+/).filter((p) => p !== '' && p !== '.')
  if (parts.length === 0) return null
  if (parts.some((p) => p === '..')) return null
  if (/^[A-Za-z]:/.test(parts[0]!)) return null
  if (parts.some((seg) => isWinUnsafePathSegment(seg))) return null
  const root = resolve(destDir)
  const abs = resolve(root, ...parts)
  return abs === root || abs.startsWith(root + sep) ? abs : null
}

/** 单个条目落盘（目录条目建目录；其余写文件 + 建父目录） */
async function extractEntry(zip: ZipFile, entry: Entry, destDir: string): Promise<void> {
  const name = entry.fileName
  const target = resolveEntryPath(destDir, name)
  if (!target) throw new Error(`包内条目路径越界：${name}`)
  if (entry.isEncrypted()) throw new Error(`包内条目已加密，无法解压：${name}`)
  const mode = unixModeOf(entry)
  const typeBits = mode === null ? 0 : mode & S_IFMT
  if (typeBits === S_IFLNK) throw new Error(`包内符号链接条目被拒绝：${name}`)
  const isDirEntry = /[\\/]$/.test(name) || typeBits === S_IFDIR
  if (isDirEntry) {
    await mkdir(target, { recursive: true })
    return
  }
  if (mode !== null && typeBits !== 0 && typeBits !== S_IFREG) {
    throw new Error(`包内条目不是常规文件，已拒绝：${name}`)
  }
  if (!entry.canDecodeFileData()) {
    throw new Error(`包内条目压缩方式不支持（method ${entry.compressionMethod}）：${name}`)
  }
  await mkdir(dirname(target), { recursive: true })
  const src = await zip.openReadStreamPromise(entry)
  await pipeline(src, createWriteStream(target, { mode: 0o644 }))
}

/**
 * 把 zip 解压到 destDir（目录不存在则建）；任何条目不合规或**超出上限**即抛错，
 * 已落盘的部分由调用方清理。
 *
 * 累计口径 = 条目的**声明解压尺寸**：`validateEntrySizes: true` 会让 yauzl 校验实际
 * 解压流长度与声明一致（不符即抛），故声明值即实际写入量的上界；超限条目在落盘前就被
 * 拦下（不会先写满盘再报错）。
 */
export async function extractZipTo(zipPath: string, destDir: string, limits?: Partial<ExtractLimits>): Promise<void> {
  const cap = resolveExtractLimits(limits)
  const zip = await openPromise(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true })
  let entries = 0
  let totalBytes = 0
  try {
    for await (const entry of zip.eachEntry()) {
      entries += 1
      if (entries > cap.maxEntries) {
        throw new Error(`包内条目数超过上限（${cap.maxEntries}），已中止解压`)
      }
      totalBytes += entry.uncompressedSize
      if (totalBytes > cap.maxTotalBytes) {
        throw new Error(`包内解压总字节超过上限（${cap.maxTotalBytes}），已中止解压`)
      }
      await extractEntry(zip, entry, destDir)
    }
  } finally {
    zip.close()
  }
}
