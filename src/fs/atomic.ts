import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { log } from '../log/index.js'
// 存活探测收编单源（原 isPidAlive 私抄副本删除）
// 探测实现拆至零依赖叶子模块 fs/process-alive.ts——此前自
// cross-process-lock.ts 引 isProcessAlive 而后者引本文件的重试原语，互引成环
import { isProcessAlive } from './process-alive.js'

interface AtomicWriteOptions {
  /** 落盘保证：写完 fsync 文件内容 + rename 后 fsync 父目录（元数据）。默认 true
   * （数据安全优先——此前默认 false，崩溃/断电下 rename 元数据未落盘会丢
   *  整个文件）。高频低价值写（诊断/心跳类）可显式传 false 关闭换吞吐。 */
  fsync?: boolean
  /** 新建文件权限位（凭据类文件用 0o600——临时文件即按此 mode 创建后
   *  rename，目标文件全程不存在全局可读窗口；仅 POSIX 生效，Windows 忽略）。 */
  mode?: number
}

/**
 * rename 的 EPERM/EBUSY 小退避重试（win 主战场）。
 * Windows 下杀软实时扫描 / 编辑器占用 / 索引器盯住目标文件时，renameSync(tmp→target)
 * 偶发 EPERM/EBUSY——瞬时占用毫秒级即释放，直接上抛会让高频的保存/定稿在 win 上
 * 无谓失败。3 次重试 × 50ms 指数退避（50/100/200ms，最坏多等 350ms），仍失败才抛
 * （调用方 catch 清 tmp 的语义不变）。仅 EPERM/EBUSY 进重试——ENOENT 等确定性
 * 错误立即上抛，不做无意义等待。rename/sleep 可注入（测试用，不动生产语义）。
 */
interface RenameRetryOptions {
  rename?: (from: string, to: string) => void
  sleep?: (ms: number) => void
  retries?: number
  baseDelayMs?: number
}

/** EPERM/EBUSY 瞬时占用指数退避**单实现**——rmWithRetry /
 *  renameWithRetry（本文件）与 cross-process-lock.rmWithRetryQuiet 的三份手抄循环、
 * 两份 retryable 字面量收敛此处（接管面的退避缺口正是重复导致的视野遗漏）。
 *  退避口径不变：3×50ms 指数，仅集合内错误码重试，其余确定性错误立即终局。 */
const RETRYABLE_FS_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY'])

/** Atomics.wait 同步微睡（Node 主线程合法；单次退避 ≤200ms，不阻塞事件循环可观时长） */
export function fsBackoffSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 参数化退避核心。onExhausted 缺省上抛（throwing 壳语义）；传入则按消费
 *  语义收口（Quiet 壳 warn 后吞，返回值不使用）。
 * 退避留痕——同步 Atomics.wait 静默睡对作者零感知，
 *  单次操作累计退避 ≥ BACKOFF_TRACE_MIN_MS（即默认档进入第 2 档 50+100ms）时按
 *  trace 上下文 log.warn 一次（操作名/目标路径/累计耗时；路径口径与本文件既有
 *  fs warn 一致不额外脱敏）。只加留痕，退避本身逐位不变；不传 trace 零变化
 *  （cross-process-lock 的 Quiet 壳维持仅耗尽告警口径）。 */
const BACKOFF_TRACE_MIN_MS = 100

export function retryOnTransientFsError<T>(
  op: () => T,
  opts: {
    sleep: (ms: number) => void
    retries: number
    baseDelayMs: number
    /** 耗尽后的收口语义：缺省（undefined）上抛；传 null 显式表达「调用方不需要返回值」
     * ——Q8P-2（1.0 前质量）：原签名用 `return undefined as T` 给泛型撒谎，唯一
     *  的 onExhausted 调用方（rmWithRetryQuiet）本就丢弃返回值；现把「吞掉并返回
     *  undefined」的关系写进类型，编译器可拦「拿返回值」的误用。 */
    onExhausted?: ((e: unknown) => void) | null
    /** 留痕上下文（操作名 + 目标路径）。缺省不留痕。 */
    trace?: { op: string; target: string }
  },
): T | undefined {
  let attempt = 0
  let sleptMs = 0
  let traced = false
  for (;;) {
    try {
      return op()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (attempt >= opts.retries || !RETRYABLE_FS_CODES.has(code)) {
        if (opts.onExhausted) {
          opts.onExhausted(e)
          return undefined
        }
        throw e
      }
      const delay = opts.baseDelayMs * 2 ** attempt
      opts.sleep(delay)
      sleptMs += delay
      if (opts.trace && !traced && sleptMs >= BACKOFF_TRACE_MIN_MS) {
        traced = true // 单次操作只留痕一次（退避仍继续到耗尽）
        log.warn(
          'fs',
          `${opts.trace.op} 遭瞬时占用（EPERM/EBUSY）退避重试 ${attempt + 1} 次、累计 ${sleptMs}ms 仍未让出：${opts.trace.target}——频繁出现请检查杀软/同步盘/索引器占用`,
        )
      }
      attempt++
    }
  }
}

/** Q8P-2：同目录 tmp 写入 + fsync + close 单点——atomicWriteFile 与 createFileExclusive
 * 两处逐字重复的块收编（改一处漏一处即两条写路径落盘保证分叉）。 */
function writeTmpFile(tmpPath: string, data: string | Uint8Array, mode: number | undefined, doFsync: boolean): void {
  if (doFsync) {
    // 显式 open + write + fsync + close：内容落盘后再 rename
    const fd = openSync(tmpPath, 'w', mode)
    try {
      writeFileSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return
  }
  writeFileSync(tmpPath, data, mode !== undefined ? { mode } : undefined)
}

/**
 * （win 平台专项）：清理路径 rmSync 防护——删除「刚关闭的 tmp」恰是
 * 杀软/索引器瞬时锁定窗口（EBUSY/EPERM），裸 rmSync 抛错会把成功写反转为失败
 * （createFileExclusive 的 finally 抛错吞掉 return 'created' → 调用方报 WRITE_ERROR、
 * 作者重试撞 ALREADY_EXISTS），或掩盖 catch 分支的原始错误。本原语静默放弃：
 * 残留 tmp 命名匹配 ABANDONED_TMP_RE，交 sweepAbandonedTmpFiles 兜底清扫，可自愈。
 */
export function rmQuietly(path: string, opts?: { rm?: (p: string) => void }): void {
  const doRm = opts?.rm ?? ((p: string) => rmSync(p, { force: true }))
  try {
    doRm(path)
  } catch {
    /* 瞬时占用/权限等：残留交 sweep 清扫（宁残留勿反转成功语义） */
  }
}

/** /19：删除数据文件的 EPERM/EBUSY 小退避重试——renameWithRetry
 * 收编了 rename 面，rm 面此前只有两个「放弃型」原语：rmQuietly（不重试、
 *  静默，面向可残留自愈的 tmp）与 cross-process-lock 的 rmWithRetryQuiet（重试后
 *  静默放弃 + 锁文件清扫文案）。「确实要删」的删源点（回收站还原删 .trash 源/
 *  伏笔归档清理/永久删）瞬时锁下静默放弃会留不可回收的孤儿残迹或误报成功，需要
 *  退避后仍失败**上抛**的变体：交调用方既有错误收口（WRITE_ERROR 信封等），语义
 *  与该调用点裸 rmSync 时代完全一致，仅消掉毫秒级瞬时占用直败。退避口径与
 *  renameWithRetry 同款（3×50ms 指数退避，仅 EPERM/EBUSY 进重试，ENOENT 等确定性
 * 错误立即上抛，不做无意义等待。rename/sleep 可注入（测试用，不动生产语义）。
 *
 * recursive 档——目录树删源点（回收站
 *  purge 版本目录连删）同享退避。为 true 时默认 rm 换 rmSync({ force, recursive })，
 *  rm 注入口优先级不变（注入即完全接管，测试语义不动）；缺省非递归形态原样保留
 *  （目录传入恒 EISDIR 上抛，防误用既有防线）。 */
export function rmWithRetry(
  path: string,
  opts?: {
    rm?: (p: string) => void
    sleep?: (ms: number) => void
    retries?: number
    baseDelayMs?: number
    recursive?: boolean
  },
): void {
  const doRm =
    opts?.rm ?? ((p: string) => rmSync(p, opts?.recursive ? { force: true, recursive: true } : { force: true }))
  // 退避循环收编 retryOnTransientFsError 单实现（口径不变：3×50ms 指数，
  // 仅 EPERM/EBUSY 重试，其余上抛）；带留痕上下文
  retryOnTransientFsError(() => doRm(path), {
    sleep: opts?.sleep ?? fsBackoffSleep,
    retries: opts?.retries ?? 3,
    baseDelayMs: opts?.baseDelayMs ?? 50,
    trace: { op: 'rm', target: path },
  })
}

export function renameWithRetry(from: string, to: string, opts?: RenameRetryOptions): void {
  const doRename = opts?.rename ?? ((src: string, dst: string) => renameSync(src, dst))
  // 退避循环收编 retryOnTransientFsError 单实现（同 rmWithRetry 注）；
  // 仅 EPERM/EBUSY 重试，其余上抛）；带留痕上下文
  retryOnTransientFsError(() => doRename(from, to), {
    sleep: opts?.sleep ?? fsBackoffSleep,
    retries: opts?.retries ?? 3,
    baseDelayMs: opts?.baseDelayMs ?? 50,
    trace: { op: 'rename', target: `${from} → ${to}` },
  })
}

/** 同目录临时文件 + rename，避免 JSON/manifest 中断后留下半截目标文件。
 *
 * - `fsync: true`（默认）：fsync 临时文件（内容落盘）+ 父目录（rename 元数据
 *    落盘）——数据安全优先，防崩溃/断电丢整个文件。Windows 等不支持 fsync 目录的
 *    平台，目录 fsync best-effort 忽略（文件内容已落盘，元数据靠 rename 原子性兜底）。
 *  - `fsync: false`：显式关闭（高频低价值写——诊断日志/心跳类，丢一次无妨，换吞吐）。 */
export function atomicWriteFile(filePath: string, data: string | Uint8Array, opts?: AtomicWriteOptions): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  // 默认 true（数据安全优先）；仅显式 fsync:false 才走快速路径
  const doFsync = opts?.fsync !== false
  try {
    writeTmpFile(tmpPath, data, opts?.mode, doFsync)
    renameWithRetry(tmpPath, filePath)
    if (doFsync) fsyncDir(dir)
  } catch (e) {
    rmQuietly(tmpPath)
    throw e
  }
}

/** 流式原子写（内存闸审计）：大产物（全书导出合并稿）不再整串驻留
 *  内存——调用方在回调内逐段 append（writeFileSync 直写 fd），落盘语义与 atomicWriteFile
 *  一致（同目录 tmp + fsync + rename + 目录 fsync，tmp 命名沿用 sweep 兼容模式）。
 *  回调抛错时清 tmp 不落半截目标。
 * 可选 publish 裁定——写入完成后、发布（rename）前回调一次，
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
  // mode 透传——与 atomicWriteFile 的 opts.mode 对齐（受限权限
  // 文件流式产出需要；mode 仅在 tmp 创建时生效，rename 沿用）。当前调用方无需求，
  // 防御性补齐。
  const fd = openSync(tmpPath, 'w', opts?.mode)
  try {
    // writeSync 允许部分写（RLIMIT_FSIZE/信号中断），丢弃返回
    // 字节数会静默发布截断文件——改 writeFileSync（内部循环写满，同 atomicWriteFile）
    write((s) => writeFileSync(fd, s))
    fsyncSync(fd)
  } catch (e) {
    try {
      closeSync(fd)
    } catch {
      /* best-effort */
    }
    rmQuietly(tmpPath)
    throw e
  }
  // closeSync 并入错误清理——close 抛错（EIO 等罕见态）时原实现
  // 裸抛且 tmp 残留；现清 tmp 后上抛（数据未落目标，无半截可见）
  try {
    closeSync(fd)
  } catch (e) {
    rmQuietly(tmpPath)
    throw e
  }
  try {
    // 发布裁定——回调方判零产出时删 tmp 不 rename（目标不落盘）
    if (opts?.publish && !opts.publish()) {
      rmQuietly(tmpPath)
      return
    }
    renameWithRetry(tmpPath, filePath)
    fsyncDir(dir)
  } catch (e) {
    rmQuietly(tmpPath)
    throw e
  }
}

/**
 * 独占创建文件（tmp + linkSync）。
 * atomicWriteFile 的 rename 语义会静默覆盖已存在的目标——调用方先 existsSync 再落盘
 * 的模式存在跨进程双建窄窗（检查与落盘之间无互斥）：双进程同路径并发新建时后到者
 * 覆盖先到者内容且双方返回成功。link 不覆盖：目标已存在时 EEXIST → 返回 'exists'
 *（调用方判 ALREADY_EXISTS），创建成功返回 'created'。tmp 命名沿用 atomicWriteFile
 * 模式（崩溃残留清扫兼容）；link 成功后 unlink tmp（同一 inode，目标全程无
 * 半截可见窗口），可见性语义与 rename 同为单步原子。
 * 落位改走 linkOrRenameExclusive——exFAT/FAT32/部分 SMB 等不支
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
    writeTmpFile(tmpPath, data, opts?.mode, doFsync)
    // EEXIST → 'exists'；EPERM/ENOSYS/EACCES → rename 降级（含 warn）
    const placed = linkOrRenameExclusive(tmpPath, filePath)
    if (placed === 'exists') return 'exists'
    if (doFsync) fsyncDir(dir)
    return 'created'
  } finally {
    // link 成功：tmp 是目标的硬链接，unlink 后仅剩目标；link 失败/EEXIST/降级 rename
    // 成功（tmp 已搬走）：rmQuietly 对已不存在路径为 no-op，仅清真残留。
    // 改 rmQuietly——finally 内清理抛错会吞掉上方 return 'created'（目标已
    // 成功建成却对调用方报失败，重试撞 ALREADY_EXISTS）；瞬时占用残留交 sweep 清扫。
    rmQuietly(tmpPath)
  }
}

/**
 * 硬链接落位（独占、不覆盖）+ 非 NTFS 形态降级。
 * link 不覆盖——目标已存在 EEXIST → 'exists'，创建成功 → 'created'（与
 * createFileExclusive 的独占探测语义一致，调用方据此判 ALREADY_EXISTS/OCCUPIED）。
 * exFAT/FAT32 式 U 盘/部分 SMB 等不支持硬链接的文件系统上 linkSync 抛
 * EPERM/ENOSYS/EACCES（win 非 NTFS 典型形态；EACCES 覆盖 win FAT 权限变体）——
 * 此前调用方各自特判 EEXIST、其余上抛，新建/移动落位/回收站还原在这些卷上全线失败。
 * 降级语义（逐点论证）：目标已存在 → 'exists'（放弃独占探测，existsSync→rename 之间
 * 存在窄窗竞态——宁窄窗回归 rename 旧语义，不可整域不可用）；否则 rename 落位
 * （tmp 场景等价原子写；源文件场景等价移动，调用方后续 rmSync force 对已搬走源为
 * no-op）。降级发生时 log.warn 一次留痕（诊断「为何无硬链接保障」）。其余错误码
 * （ENOENT/EIO 等）原样上抛，不扩大降级面。
 * 降级 rename 走 renameWithRetry——降级分支恰发生在 exFAT/SMB 等杀软/占用
 * 高发环境，此前裸 renameSync 无 EPERM/EBUSY 退避（主路径 atomicWriteFile 已有）。
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
    renameWithRetry(src, dst)
    return 'created'
  }
}

/** fsync 目录（持久化 rename 的元数据变更）。
 *  POSIX 上 open 目录只读 + fsync；Windows 可 open 目录（只读句柄合法），但
 *  FlushFileBuffers 拒绝无写访问权的句柄——fsyncSync 抛 EPERM → best-effort 忽略。
 * 注释校正：原「Windows 不能 open 目录」与实测不符
 *  （openSync(dir,'r') 成功，fsyncSync 才抛）。 */
function fsyncDir(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (e) {
    // 平台不支持 fsync 目录（win：fsyncSync EPERM，非 open 失败）—— 内容已 fsync，
    // 静默忽略（文档化口径）。
    // （§四.8）前提核校：本 catch 原本就吞掉包括 EIO
    // 在内的全部错误，评审所述「rename 成功后 fsyncDir 抛非 EPERM 上抛 → 目标已写入
    // 却报假失败」在现行代码不成立（证伪留档；测试锁定「不抛 + 目标在」防回归）。
    // 真实缺口是零留痕：EIO 类真实耐久性降级与平台限制同被静默吞掉。处置 = 非 EPERM
    // 失败补 log.warn 留痕（log 模块仅依赖 node 内置，与 src/fs 无循环依赖；本文件
    // 已有 log.warn('fs') 先例，故不用 console.warn），仍不抛——目录条目耐久性
    // best-effort（文件内容已 fsync），抛出反而把已成功写入反转成假失败、诱发调用方
    // 误判 WRITE_ERROR 重复写。
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') {
      log.warn(
        'fs',
        `目录 fsync 失败（${(e as NodeJS.ErrnoException).code ?? '未知错误'}），rename 元数据耐久性降级为 best-effort（文件内容已 fsync，不判失败）：${dir}`,
      )
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // best-effort（文件内容已 fsync），抛出反而把已成功写入反转成假失败、诱发调用方
      }
    }
  }
}

/** 崩溃残留 tmp 的命名模式（`.<name>.<pid>.<uuid>.tmp`）。
 *  带 mtime 年龄判据使用——见 sweepAbandonedTmpFiles。
 * 捕获组 1 = pid 段（紧贴 uuid 前的数字段）——sweep 据此做
 *  持有进程存活探测，防误清他进程在途写。 */
const ABANDONED_TMP_RE = /^\..+\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

/** 进程存活探测——收编单源（原私抄同语义副本）；
 * 实现迁 fs/process-alive.ts，atomic↔lock 的文件级互引环就此消除。 */

/** 清扫 atomicWriteFile 崩溃残留的 tmp 文件（rename 前进程崩溃时 catch 清理
 *  不可达，`.<name>.<pid>.<uuid>.tmp` 永久留盘累积占空间）。
 * 扩两件：① 陈锁清扫（`.lock` 分支——持有 pid 已死且超龄的
 *  跨进程锁文件，孤儿锁不再永久堆积）；② 递归跳过 .git/node_modules（纯空扫性能损耗）。
 *
 *  年龄门槛 5 分钟：原子写的 tmp 寿命是毫秒级（创建→rename 同步相邻），超龄可断定
 *  非他进程在途写——误删在途 tmp 会把对方写入变成 rename 失败，宁慢勿错。
 * 年龄门防不住 CLI/GUI 双进程下他进程的**长时间**大文件在途
 *  写（超 5 分钟即误清）——tmp 命名自带 pid 段，pid 仍存活则永不清（进程在 = 写仍
 *  在途或将由其自身 catch 清理）；pid 已死才交给年龄门（无 pid 段/解析异常维持
 *  5 分钟年龄门原口径）。
 *  返回清除数（调用方留痕用）。best-effort：目录不可读/文件不可删逐项跳过。 */
/** 递归跳过表——.git（对象库成百上千文件）/ node_modules
 *  （依赖树）只可能藏 tmp 于自身写入习惯之外，本仓原子写从不落位其间，纯空扫性能
 *  损耗；书内正文/工作区/.版本 照扫（atomicWriteFile 的 tmp 就落目标文件同目录）。 */
const SWEEP_SKIP_DIRS = new Set(['.git', 'node_modules'])

/** 跨进程锁文件年龄门槛（毫秒）——与 cross-process-lock MAX_HELD_MS 同口径
 *  （10 分钟），超龄且持有 pid 已死才清（见 sweepAbandonedTmpFiles 的 .lock 分支）。 */
const STALE_LOCK_MIN_AGE_MS = 10 * 60_000

/** 自身 pid 名下 tmp 的废弃年龄门（毫秒）——导出 worker terminate
 *  后 tmp 逃逸（worker_threads 与主进程共享 pid，pid 存活守卫对自身 pid 恒真，会话期
 *  内永不清）；导出超时上限 120s < 5min，本进程名下的合法原子写（创建→rename 毫秒级
 *  相邻）不可能超龄，超龄只可能是逃逸残留。独立常量不复用可注入的 minAge，防测试
 *  注入缩小年龄门时连带给自身 pid 判定放水。 */
const SELF_TMP_MIN_AGE_MS = 5 * 60_000

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
    // 陈锁清扫——跨进程锁文件（{pid,bootTime} JSON 指纹）持有
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
        if (isProcessAlive(holder.pid)) continue
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
      // pid 仍存活 → 他进程在途写（年龄门外的双进程保护），永不清
      const pid = Number(ABANDONED_TMP_RE.exec(ent.name)?.[1])
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        // 例外——pid == 自身且超 5 分钟也视为废弃（机理见
        // SELF_TMP_MIN_AGE_MS 常量注：worker terminate 逃逸 tmp 与主进程共享 pid，
        // 守卫对自身恒真；合法写者不可能超龄）。他进程 pid 维持永不清口径。
        if (pid !== process.pid || now - Math.floor(st.mtimeMs) < SELF_TMP_MIN_AGE_MS) continue
      }
      rmSync(full, { force: true })
      removed++
    } catch {
      /* 单项失败跳过（并发消失/权限/半写不可解析） */
    }
  }
  return removed
}
