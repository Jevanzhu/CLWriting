/**
 * 阶段 55：便携包解压（yauzl 解析 + 本模块落盘）。
 *
 * 输入是**远端下载的包**，故解压面自持而非交给成品解压器（后者对包内符号链接条目
 * 普遍不设防：跟随链接写盘 = 任意位置落文件）。本模块只做两件事：yauzl 负责条目解析
 * 与解压流，写盘与路径判定全在这里：
 *  - 条目名一律按 `/` 与 `\` 双分隔符切段，含 `..` 段 / 盘符形态 / 空名 → 整体失败；
 *  - 符号链接条目（unix 模式位 S_IFLNK）→ 整体失败，不跟随；
 *  - 落盘前再按解析后的绝对路径复核一次「在目标目录内」（双保险，防归一化绕过）；
 *  - 只放行常规文件与目录；加密条目与非常规压缩方法（只支持 0 与 8）→ 整体失败。
 *
 * 失败一律抛错并**不清理**目标目录：调用方（更新助手）按 `extract-failed` 收口时
 * 会整目录删掉半成品。
 */
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { openPromise, type Entry, type ZipFile } from 'yauzl'

/** unix 文件类型位（`externalFileAttributes` 高 16 位） */
const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

/** 条目 unix 模式位（宿主非 unix 造的包没有可信模式位 → null = 按常规文件对待） */
function unixModeOf(entry: Entry): number | null {
  if (entry.versionMadeBy >> 8 !== 3) return null
  return (entry.externalFileAttributes >>> 16) & 0xffff
}

/**
 * 条目名 → 目标目录内的绝对路径；非法（空名 / 含 `..` 段 / 盘符 / 归一化后越界）→ null。
 * 目录条目名以分隔符结尾，这里不特殊对待（切段会滤掉空段）。
 */
export function resolveEntryPath(destDir: string, name: string): string | null {
  if (!name || name.includes('\0')) return null
  const parts = name.split(/[\\/]+/).filter((p) => p !== '' && p !== '.')
  if (parts.length === 0) return null
  if (parts.some((p) => p === '..')) return null
  if (/^[A-Za-z]:/.test(parts[0]!)) return null
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

/** 把 zip 解压到 destDir（目录不存在则建）；任何条目不合规即抛错，已落盘的部分由调用方清理 */
export async function extractZipTo(zipPath: string, destDir: string): Promise<void> {
  const zip = await openPromise(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true })
  try {
    for await (const entry of zip.eachEntry()) {
      await extractEntry(zip, entry, destDir)
    }
  } finally {
    zip.close()
  }
}
