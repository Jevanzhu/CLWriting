import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface AtomicWriteOptions {
  /** 落盘保证：写完 fsync 文件内容 + rename 后 fsync 父目录（元数据）。默认 true
   *  （T2-5：数据安全优先——此前默认 false，崩溃/断电下 rename 元数据未落盘会丢
   *  整个文件）。高频低价值写（诊断/心跳类）可显式传 false 关闭换吞吐。 */
  fsync?: boolean
  /** 新建文件权限位（RB-IF-P2-6：凭据类文件用 0o600——临时文件即按此 mode 创建后
   *  rename，目标文件全程不存在全局可读窗口；仅 POSIX 生效，Windows 忽略）。 */
  mode?: number
}

/** 同目录临时文件 + rename，避免 JSON/manifest 中断后留下半截目标文件。
 *
 *  - `fsync: true`（默认，T2-5）：fsync 临时文件（内容落盘）+ 父目录（rename 元数据
 *    落盘）——数据安全优先，防崩溃/断电丢整个文件。Windows 等不支持 fsync 目录的
 *    平台，目录 fsync best-effort 忽略（文件内容已落盘，元数据靠 rename 原子性兜底）。
 *  - `fsync: false`：显式关闭（高频低价值写——诊断日志/心跳类，丢一次无妨，换吞吐）。 */
export function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
  opts?: AtomicWriteOptions,
): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  // T2-5：默认 true（数据安全优先）；仅显式 fsync:false 才走快速路径
  const doFsync = opts?.fsync !== false
  try {
    if (doFsync) {
      // 显式 open + write + fsync + close：内容落盘后再 rename
      const fd = openSync(tmpPath, 'w', opts?.mode)
      try {
        writeFileSync(fd, data)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } else {
      writeFileSync(tmpPath, data, opts?.mode !== undefined ? { mode: opts.mode } : undefined)
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
