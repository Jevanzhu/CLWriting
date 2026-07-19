import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface AtomicWriteOptions {
  /** 落盘保证：写完 fsync 文件内容 + rename 后 fsync 父目录（元数据）。默认 false。 */
  fsync?: boolean
}

/** 同目录临时文件 + rename，避免 JSON/manifest 中断后留下半截目标文件。
 *
 *  - `fsync: false`（默认）：行为与旧调用逐字不变（清单/配置等普通写入）。
 *  - `fsync: true`：额外 fsync 临时文件（内容落盘）+ 父目录（rename 元数据落盘），
 *    用于保存协议等防丢字场景（W0-1 §5.2）。Windows 等不支持 fsync 目录的平台，
 *    目录 fsync best-effort 忽略（文件内容已落盘，元数据靠 rename 原子性兜底）。 */
export function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
  opts?: AtomicWriteOptions,
): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  const doFsync = opts?.fsync === true
  try {
    if (doFsync) {
      // 显式 open + write + fsync + close：内容落盘后再 rename
      const fd = openSync(tmpPath, 'w')
      try {
        writeFileSync(fd, data)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } else {
      writeFileSync(tmpPath, data)
    }
    renameSync(tmpPath, filePath)
    if (doFsync) fsyncDir(dir)
  } catch (e) {
    rmSync(tmpPath, { force: true })
    throw e
  }
}

/** fsync 目录（持久化 rename 的元数据变更）。
 *  POSIX 上 open 目录只读 + fsync；Windows 等不支持的平台抛错 → best-effort 忽略。 */
function fsyncDir(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // 平台不支持（Windows 不能 open 目录 / 不支持 fsync 目录）—— 内容已 fsync
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // best-effort
      }
    }
  }
}
