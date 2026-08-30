import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { log } from '../log/index.js'

export interface AtomicWriteOptions {
  /** 落盘保证：写完 fsync 文件内容 + rename 后 fsync 父目录（元数据）。默认 true
   *  （T2-5：数据安全优先——此前默认 false，崩溃/断电下 rename 元数据未落盘会丢
   *  整个文件）。高频低价值写（诊断/心跳类）可显式传 false 关闭换吞吐。 */
  fsync?: boolean
  /** 新建文件权限位（RB-IF-P2-6：凭据类文件用 0o600——临时文件即按此 mode 创建后
   *  rename，目标文件全程不存在全局可读窗口；仅 POSIX 生效，Windows 忽略）。 */
  mode?: number
}

/**
 * R77-3（二十五轮批 D）：rename 的 EPERM/EBUSY 小退避重试（win 主战场）。
 * Windows 下杀软实时扫描 / 编辑器占用 / 索引器盯住目标文件时，renameSync(tmp→target)
 * 偶发 EPERM/EBUSY——瞬时占用毫秒级即释放，直接上抛会让高频的保存/定稿在 win 上
 * 无谓失败。3 次重试 × 50ms 指数退避（50/100/200ms，最坏多等 350ms），仍失败才抛
 * （调用方 catch 清 tmp 的语义不变）。仅 EPERM/EBUSY 进重试——ENOENT 等确定性
 * 错误立即上抛，不做无意义等待。rename/sleep 可注入（测试用，不动生产语义）。
 */
export interface RenameRetryOptions {
  rename?: (from: string, to: string) => void
  sleep?: (ms: number) => void
  retries?: number
  baseDelayMs?: number
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY'])

export function renameWithRetry(from: string, to: string, opts?: RenameRetryOptions): void {
  const doRename = opts?.rename ?? ((src: string, dst: string) => renameSync(src, dst))
  // Atomics.wait 同步微睡（Node 主线程合法；单次退避 ≤200ms，不阻塞事件循环可观时长）
  const sleep =
    opts?.sleep ?? ((ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms))
  const retries = opts?.retries ?? 3
  const base = opts?.baseDelayMs ?? 50
  let attempt = 0
  for (;;) {
    try {
      return doRename(from, to)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (attempt >= retries || !RETRYABLE_RENAME_CODES.has(code)) throw e
      sleep(base * 2 ** attempt)
      attempt++
    }
  }
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
    renameWithRetry(tmpPath, filePath)
    if (doFsync) fsyncDir(dir)
  } catch (e) {
    rmSync(tmpPath, { force: true })
    throw e
  }
}

/** 流式原子写（内存闸 2026-08-24 审计 A1）：大产物（全书导出合并稿）不再整串驻留
 *  内存——调用方在回调内逐段 append（writeFileSync 直写 fd），落盘语义与 atomicWriteFile
 *  一致（同目录 tmp + fsync + rename + 目录 fsync，tmp 命名沿用 sweep 兼容模式）。
 *  回调抛错时清 tmp 不落半截目标。
 *  R26-53（二十六轮）：可选 publish 裁定——写入完成后、发布（rename）前回调一次，
 *  返回 false 则删除 tmp 直接返回（不发布）。供「零成功产物不落盘」场景：调用方在
 *  回调里累计实际写出量，零产出时目标文件连空壳都不出现（此前会落一个空文件在盘）。 */
export function atomicWriteStream(
  filePath: string,
  write: (append: (s: string) => void) => void,
  opts?: { mode?: number; publish?: () => boolean },
): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  // R64-22（十二轮）：mode 透传——与 atomicWriteFile 的 opts.mode 对齐（受限权限
  // 文件流式产出需要；mode 仅在 tmp 创建时生效，rename 沿用）。当前调用方无需求，
  // 防御性补齐。
  const fd = openSync(tmpPath, 'w', opts?.mode)
  try {
    // R61-9（第六十一轮）：writeSync 允许部分写（RLIMIT_FSIZE/信号中断），丢弃返回
    // 字节数会静默发布截断文件——改 writeFileSync（内部循环写满，同 atomicWriteFile）
    write((s) => writeFileSync(fd, s))
    fsyncSync(fd)
  } catch (e) {
    try {
      closeSync(fd)
    } catch {
      /* best-effort */
    }
    rmSync(tmpPath, { force: true })
    throw e
  }
  // R72-6（二十轮 B-7）：closeSync 并入错误清理——close 抛错（EIO 等罕见态）时原实现
  // 裸抛且 tmp 残留；现清 tmp 后上抛（数据未落目标，无半截可见）
  try {
    closeSync(fd)
  } catch (e) {
    rmSync(tmpPath, { force: true })
    throw e
  }
  try {
    // R26-53（二十六轮）：发布裁定——回调方判零产出时删 tmp 不 rename（目标不落盘）
    if (opts?.publish && !opts.publish()) {
      rmSync(tmpPath, { force: true })
      return
    }
    renameWithRetry(tmpPath, filePath)
    fsyncDir(dir)
  } catch (e) {
    rmSync(tmpPath, { force: true })
    throw e
  }
}

/**
 * B-6（第六十轮）：独占创建文件（tmp + linkSync）。
 * atomicWriteFile 的 rename 语义会静默覆盖已存在的目标——调用方先 existsSync 再落盘
 * 的模式存在跨进程双建窄窗（检查与落盘之间无互斥）：双进程同路径并发新建时后到者
 * 覆盖先到者内容且双方返回成功。link 不覆盖：目标已存在时 EEXIST → 返回 'exists'
 *（调用方判 ALREADY_EXISTS），创建成功返回 'created'。tmp 命名沿用 atomicWriteFile
 * 模式（Y-24 崩溃残留清扫兼容）；link 成功后 unlink tmp（同一 inode，目标全程无
 * 半截可见窗口），可见性语义与 rename 同为单步原子。
 * R26-7（二十六轮）：落位改走 linkOrRenameExclusive——exFAT/FAT32/部分 SMB 等不支
 * 持硬链接的卷上 linkSync 抛 EPERM/ENOSYS/EACCES（此前仅特判 EEXIST，其余上抛 =
 * 新建在这些卷上全线不可用），现降级 rename 落位（见该函数注）。
 */
export function createFileExclusive(
  filePath: string,
  data: string | Uint8Array,
  opts?: AtomicWriteOptions,
): 'created' | 'exists' {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  const doFsync = opts?.fsync !== false
  try {
    if (doFsync) {
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
    // R26-7（二十六轮）：EEXIST → 'exists'；EPERM/ENOSYS/EACCES → rename 降级（含 warn）
    const placed = linkOrRenameExclusive(tmpPath, filePath)
    if (placed === 'exists') return 'exists'
    if (doFsync) fsyncDir(dir)
    return 'created'
  } finally {
    // link 成功：tmp 是目标的硬链接，unlink 后仅剩目标；link 失败/EEXIST/降级 rename
    // 成功（tmp 已搬走）：rmSync force 对已不存在路径为 no-op，仅清真残留
    rmSync(tmpPath, { force: true })
  }
}

/**
 * R26-7（二十六轮）：硬链接落位（独占、不覆盖）+ 非 NTFS 形态降级。
 * link 不覆盖——目标已存在 EEXIST → 'exists'，创建成功 → 'created'（与
 * createFileExclusive 的独占探测语义一致，调用方据此判 ALREADY_EXISTS/OCCUPIED）。
 * exFAT/FAT32 式 U 盘/部分 SMB 等不支持硬链接的文件系统上 linkSync 抛
 * EPERM/ENOSYS/EACCES（win 非 NTFS 典型形态；EACCES 覆盖 win FAT 权限变体）——
 * 此前调用方各自特判 EEXIST、其余上抛，新建/移动落位/回收站还原在这些卷上全线失败。
 * 降级语义（逐点论证）：目标已存在 → 'exists'（放弃独占探测，existsSync→rename 之间
 * 存在窄窗竞态——宁窄窗回归 rename 旧语义，不可整域不可用）；否则 renameSync 落位
 * （tmp 场景等价原子写；源文件场景等价移动，调用方后续 rmSync force 对已搬走源为
 * no-op）。降级发生时 log.warn 一次留痕（诊断「为何无硬链接保障」）。其余错误码
 * （ENOENT/EIO 等）原样上抛，不扩大降级面。
 */
export function linkOrRenameExclusive(src: string, dst: string): 'created' | 'exists' {
  try {
    linkSync(src, dst)
    return 'created'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return 'exists'
    if (code !== 'EPERM' && code !== 'ENOSYS' && code !== 'EACCES') throw e
    if (existsSync(dst)) return 'exists'
    log.warn('fs', `当前文件系统不支持硬链接（link ${code}），已降级为非原子创建（无独占探测保障）：${dst}`)
    renameSync(src, dst)
    return 'created'
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

/** Y-24（第五十七轮）：崩溃残留 tmp 的命名模式（`.<name>.<pid>.<uuid>.tmp`）。
 *  带 mtime 年龄判据使用——见 sweepAbandonedTmpFiles。
 *  R65-37（第六十五轮）：捕获组 1 = pid 段（紧贴 uuid 前的数字段）——sweep 据此做
 *  持有进程存活探测，防误清他进程在途写。 */
const ABANDONED_TMP_RE = /^\..+\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

/** R65-37：进程存活探测（与 fs/cross-process-lock.ts 同口径）——process.kill(pid,0)
 *  不发信号只查存在性：ESRCH=死；EPERM=存在但属他人，按存活保守处理。 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Y-24：清扫 atomicWriteFile 崩溃残留的 tmp 文件（rename 前进程崩溃时 catch 清理
 *  不可达，`.<name>.<pid>.<uuid>.tmp` 永久留盘累积占空间）。
 *  R76-27（二十四轮 C 域）扩两件：① 陈锁清扫（`.lock` 分支——持有 pid 已死且超龄的
 *  跨进程锁文件，孤儿锁不再永久堆积）；② 递归跳过 .git/node_modules（纯空扫性能损耗）。
 *
 *  年龄门槛 5 分钟：原子写的 tmp 寿命是毫秒级（创建→rename 同步相邻），超龄可断定
 *  非他进程在途写——误删在途 tmp 会把对方写入变成 rename 失败，宁慢勿错。
 *  R65-37（第六十五轮）：年龄门防不住 CLI/GUI 双进程下他进程的**长时间**大文件在途
 *  写（超 5 分钟即误清）——tmp 命名自带 pid 段，pid 仍存活则永不清（进程在 = 写仍
 *  在途或将由其自身 catch 清理）；pid 已死才交给年龄门（无 pid 段/解析异常维持
 *  5 分钟年龄门原口径）。
 *  返回清除数（调用方留痕用）。best-effort：目录不可读/文件不可删逐项跳过。 */
/** R76-27（二十四轮 C 域）：递归跳过表——.git（对象库成百上千文件）/ node_modules
 *  （依赖树）只可能藏 tmp 于自身写入习惯之外，本仓原子写从不落位其间，纯空扫性能
 *  损耗；书内正文/工作区/.版本 照扫（atomicWriteFile 的 tmp 就落目标文件同目录）。 */
const SWEEP_SKIP_DIRS = new Set(['.git', 'node_modules'])

/** R76-27：跨进程锁文件年龄门槛（毫秒）——与 cross-process-lock MAX_HELD_MS 同口径
 *  （10 分钟），超龄且持有 pid 已死才清（见 sweepAbandonedTmpFiles 的 .lock 分支）。 */
const STALE_LOCK_MIN_AGE_MS = 10 * 60_000

export function sweepAbandonedTmpFiles(rootDir: string, opts?: { now?: number; minAgeMs?: number }): number {
  const now = opts?.now ?? Date.now()
  const minAge = opts?.minAgeMs ?? 5 * 60_000
  let removed = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(rootDir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const ent of entries) {
    const full = join(rootDir, ent.name)
    if (ent.isDirectory()) {
      if (SWEEP_SKIP_DIRS.has(ent.name)) continue
      removed += sweepAbandonedTmpFiles(full, opts)
      continue
    }
    if (!ent.isFile()) continue
    // R76-27（二十四轮 C 域）：陈锁清扫——跨进程锁文件（{pid,bootTime} JSON 指纹）持有
    // 进程已死且超龄时清掉：锁的正常生命周期由获取方 release/接管清理，但「锁的主人
    // （journal 等）已被 purge」后该锁再无获取者，孤儿锁永久堆积。判据三重收紧防误删：
    // ① 内容必须是合法锁指纹（{pid:正整数} JSON——作者手放的同名 .md/.lock 杂物不匹配
    // 即不动）；② 持有 pid 仍活不动（删在持锁 = 互斥失效）；③ mtime 未超龄不动（与
    // cross-process-lock 的 MAX_HELD_MS 接管门槛同口径，覆盖 pid 复用形态）。任一读取/
    // 解析失败跳过（fail-closed to residue，宁残留勿误删）。
    if (ent.name.endsWith('.lock')) {
      try {
        const holder = JSON.parse(readFileSync(full, 'utf-8')) as { pid?: unknown }
        if (typeof holder.pid !== 'number' || !Number.isInteger(holder.pid) || holder.pid <= 0) continue
        if (isPidAlive(holder.pid)) continue
        if (now - Math.floor(statSync(full).mtimeMs) < STALE_LOCK_MIN_AGE_MS) continue
        rmSync(full, { force: true })
        removed++
      } catch {
        /* 单项失败跳过（并发消失/权限/半写不可解析） */
      }
      continue
    }
    if (!ABANDONED_TMP_RE.test(ent.name)) continue
    try {
      const st = statSync(full)
      if (now - Math.floor(st.mtimeMs) < minAge) continue // 可能在途——不动
      // R65-37：pid 仍存活 → 他进程在途写（年龄门外的双进程保护），永不清
      const pid = Number(ABANDONED_TMP_RE.exec(ent.name)?.[1])
      if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) continue
      rmSync(full, { force: true })
      removed++
    } catch {
      /* 单项失败跳过（并发消失/权限） */
    }
  }
  return removed
}
