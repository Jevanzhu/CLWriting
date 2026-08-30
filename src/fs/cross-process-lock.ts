/**
 * 跨进程文件锁基建（批次 J7，2026-08-23 落地）。
 *
 * proper-lockfile 式语义，但用**文件**而非 mkdir：open 'wx'（O_CREAT|O_EXCL）独占
 * 创建——创建与检查之间无 TOCTOU 窗口。锁文件内容写 { pid, bootTime } 作诊断；
 * 持有进程不存活（process.kill(pid,0) ESRCH）或锁文件损坏（崩溃半写）判 stale，
 * 接管清理后重试一次——崩溃残留不永锁。
 *
 * win 语义评估（J7 任务项）：libuv 对 'wx' 在 Windows 同样保证 O_EXCL 原子性
 * （NtCreateFile FILE_CREATE 语义），跨平台一致；stale 接管的 unlink 在 win 上
 * 对已关闭句柄的文件同样成立（本实现锁文件不长持 fd，创建写 pid 后即关）。
 * EPERM（进程存在但属他人）按存活保守处理——win 上跨用户探测即此形态，不接管。
 *
 * 等待语义：tryAcquire 非阻塞（null = 未拿到）；acquireWithTimeout 以
 * Atomics.wait 同步微睡重试（Node 主线程可用；争用窗口是文件 IO 的微秒~毫秒级，
 * 阻塞时长由调用方超时封顶）。同进程嵌套获取同一锁会自锁——调用方需保证进程内
 * 已有串行化（如 calls.ts 的 writeChains）再进跨进程锁。
 *
 * X-4（第五十六轮）：stale 接管的「判定 → rmSync」窗口残余竞态——双 contender
 * 先后判同一死 pid stale 时，后到者的 rmSync 可能删掉先到者刚创建的新锁（双持锁）。
 * 缓解：接管前随机 jitter（去相关化并发轮询者）+ rmSync 前二次复核（重判仍 stale
 * 才删，窗口收窄到 µs 级）。残余窗口如实记档：POSIX 无 inode 级条件删除，二次复核
 * 与 rmSync 之间锁文件仍可能被换（proper-lockfile 同款已知语义）；彻底闭合需
 * lease/fencing token，超出文件锁范畴。
 */
import { mkdirSync, openSync, writeSync, closeSync, rmSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { dirname } from 'node:path'

/** 本进程启动时刻（epoch ms，由 uptime 反推）——锁文件诊断字段（未来 pid 复用判别依据）。
 *  R71-24（十九轮）导出复用：events 开口标记内容同样落 pid+bootTime。 */
export function processBootTime(): number {
  return Date.now() - Math.round(process.uptime() * 1000)
}

/** 进程存活探测：process.kill(pid, 0) 不发信号只做权限/存在性检查；ESRCH = 不存在
 *  （stale）。EPERM（存在但属他人）按存活处理——保守不接管。
 *  R67-2（十五轮）导出复用：events 句柄标记的 pid 探测与锁共用同一存活口径。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface CrossProcessLockOptions {
  /** 进程存活判定（测试注入用）；缺省 process.kill(pid,0) 探测。 */
  isProcessAlive?: (pid: number) => boolean
  /** 不可读锁（创建后 pid 未写完/空文件）视为存活的年龄宽限（毫秒）——
   *  见下方 STALE_GRACE_MS 注释；测试注入 0 可关掉宽限。 */
  staleGraceMs?: number
  /** X-4：stale 接管前的随机 jitter 上限（毫秒，睡 [0, 上限) 均匀值）——去相关化并发
   *  轮询者，降低「双 contender 同拍判 stale、后到者删掉先到者新锁」概率；测试注入 0
   *  关掉。只睡一次（首轮判 stale 后），不叠加 acquireWithTimeout 的轮询间隔。 */
  staleTakeoverJitterMs?: number
  /** Z-19：活 pid 超龄判 stale 的门槛（毫秒）——pid 复用防护；注入 0 关闭。 */
  maxHeldMs?: number
  /** N6（五十九轮）：持锁方续期周期（毫秒）——>0 时占锁成功即起定时器定期
   *  utimes 刷新锁文件 mtime（持锁段超过 maxHeldMs 的长任务借此声明「还活着」，
   *  防被 SIGSTOP/挂起误接管为 stale → 双持锁）；release 时停表。注入用最小周期
   *  保测试快（生产调用方按持锁段上界选择是否启用，毫秒级持锁段无需续期）。 */
  renewIntervalMs?: number
}

/** open 'wx' 成功 → writeSync(pid) 之间存在微秒级窗口：对手 EEXIST 后读到空锁，
 *  若判 stale 会删掉在持锁文件接管 → 双持锁互斥失效（真双进程回归实测复现）。
 *  不可读锁在创建后 STALE_GRACE_MS 内视为「写 pid 在途」按存活处理；超龄仍不可读
 *  （创建即崩溃的半写）才接管清理。 */
const STALE_GRACE_MS = 500

/** X-4：stale 接管 jitter 上限缺省值（毫秒）。 */
const STALE_TAKEOVER_JITTER_MS = 25

/** Z-19：锁文件「活 pid 超龄」判 stale 的年龄门槛（毫秒）——本仓锁持有段为毫秒级，
 *  10 分钟已极保守；注入 0 可关闭。 */
const MAX_HELD_MS = 10 * 60_000

/**
 * 锁状态判定（单次完整评估）：'held' = 活进程持有 / 年轻空锁（写 pid 在途），
 * 'stale' = 持有进程已死或超龄仍不可读，'gone' = 文件已不在（刚被释放——上层重试创建）。
 */
function judgeStaleLock(
  lockPath: string,
  isAlive: (pid: number) => boolean,
  graceMs: number,
  maxHeldMs?: number,
): 'held' | 'stale' | 'gone' {
  const holder = readHolderPid(lockPath)
  if (holder !== null && isAlive(holder)) {
    // Z-19（第五十八轮）：活 pid + 超龄 → stale 接管（pid 复用防护）——本仓所有锁的
    // 持有段都是文件 IO 级毫秒，超龄（缺省 10min，可注入）仍「活着」只可能是原持有者
    // 已死、pid 被系统复用给长命进程（bootTime 已落盘但无跨进程查询 API，年龄是可用
    // 判据）。残余风险如实记档：持锁进程被 SIGSTOP 挂起超龄的极端形态会被误接管。
    // N6（五十九轮）：接管条件收紧为「超龄且 mtime 无续期」——长持锁方用
    // renewIntervalMs 定期 utimes 刷新 mtime，活着且在续期 → age 恒小于门槛，不接管；
    // 只有「超龄且期间无任何续期 touch」（真死进程 pid 复用 / SIGSTOP 后无人续期）
    // 才判 stale。判据本身仍是 mtime 年龄（utimes 续期即重置），无需新增状态位。
    if (maxHeldMs !== undefined && maxHeldMs > 0) {
      try {
        const age = Date.now() - Math.floor(statSync(lockPath).mtimeMs)
        if (age > maxHeldMs) return 'stale'
      } catch {
        /* R72-6（二十轮 B-6）注释修正：stat 失败（刚被释放）→ 穿落到下方 return
           'held'——活 pid 在手时判 held 保守（下次轮询重判），并不交上层重试创建 */
      }
    }
    return 'held'
  }
  if (holder === null) {
    // 空锁/坏锁：写 pid 在途（年轻）按存活；超龄半写才 stale（见 STALE_GRACE_MS）
    let mtime = Number.NaN
    try {
      mtime = statSync(lockPath).mtimeMs
    } catch {
      return 'gone' // 刚被释放/删除——上层重试创建，不在这里删
    }
    // mtimeMs 带亚毫秒小数且时钟源独立——floor 对齐后计龄，避免同毫秒内出现负年龄
    if (Number.isFinite(mtime) && Date.now() - Math.floor(mtime) < graceMs) return 'held'
  }
  return 'stale'
}

/**
 * R75-5（批 D）：只读锁状态查询——复用 judgeStaleLock 的完整陈锁判定语义（活 pid +
 * 未超龄 / 年轻空锁 = held；死 pid、超龄半写、活 pid 超龄且无续期 = stale 不算在持），
 * 供 task-gate 的跨进程 busyGate 查询用：只取锁状态、绝不取锁、绝不清理（stale 锁的
 * 接管清理仍归 acquire 路径独有，查询侧误删会在持锁文件 = 互斥失效）。锁文件不存在
 * （'gone'）同样不算在持。缺省参数与 tryAcquireCrossProcessLock 同源（grace/超龄门槛
 * /存活探测），保证「查询判 held ⟺ acquire 会拿到 null」两侧口径一致。
 */
export function queryLockHeld(
  lockPath: string,
  opts?: { isProcessAlive?: (pid: number) => boolean; staleGraceMs?: number; maxHeldMs?: number },
): boolean {
  return (
    judgeStaleLock(
      lockPath,
      opts?.isProcessAlive ?? isProcessAlive,
      opts?.staleGraceMs ?? STALE_GRACE_MS,
      opts?.maxHeldMs ?? MAX_HELD_MS,
    ) === 'held'
  )
}

/**
 * 非阻塞占锁：成功返回 release（幂等）；锁被活进程持有（或等待超时语义外的调用方
 * 自行决策）返回 null。EEXIST 时做 stale 判定与接管（至多重试一次，防竞态循环）。
 */
export function tryAcquireCrossProcessLock(
  lockPath: string,
  opts?: CrossProcessLockOptions,
): (() => void) | null {
  const isAlive = opts?.isProcessAlive ?? isProcessAlive
  const grace = opts?.staleGraceMs ?? STALE_GRACE_MS
  const jitterMax = opts?.staleTakeoverJitterMs ?? STALE_TAKEOVER_JITTER_MS
  const maxHeld = opts?.maxHeldMs ?? MAX_HELD_MS
  mkdirSync(dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined
    try {
      fd = openSync(lockPath, 'wx')
      // R65-35①（第六十五轮）：writeSync 单次调用可短写（ENOSPC 磁盘满/信号中断），
      // 半写残 JSON 锁文件会被对手判「坏锁」接管（双持锁）——循环写满为止
      const payload = JSON.stringify({ pid: process.pid, bootTime: processBootTime() })
      const buf = Buffer.from(payload, 'utf8')
      for (let off = 0; off < buf.length; ) {
        off += writeSync(fd, buf, off, buf.length - off)
      }
      let released = false
      // N6：续期定时器——周期 utimes 刷锁文件 mtime（best-effort：锁文件被外部清理/
      // 磁盘异常时静默跳过，release 照常删文件）。release 幂等 + 停表。
      const renewMs = opts?.renewIntervalMs ?? 0
      let renewTimer: ReturnType<typeof setInterval> | null = null
      if (renewMs > 0) {
        renewTimer = setInterval(() => {
          try {
            utimesSync(lockPath, new Date(), new Date())
          } catch {
            /* best-effort：锁文件已不在（异常态）→ 停止续期，防定时器空转 */
            if (renewTimer) clearInterval(renewTimer)
          }
        }, renewMs)
        renewTimer.unref()
      }
      return () => {
        if (released) return
        released = true
        if (renewTimer) clearInterval(renewTimer)
        // R65-35②：释放前校验「仍是我创建的那把锁」——读锁文件内容与写入串逐字节
        // 一致（pid+bootTime 即自身）才删；不一致 = X-4 双 contender 双持锁残余窗口
        // 里锁已被他人重建（无条件 rmSync 会删掉他人在位的新锁）。读失败（含已不在
        // 盘）同样不删——删错他人锁的代价高于残留（残留由 stale 接管路径收口）。
        try {
          if (readFileSync(lockPath, 'utf-8') !== payload) return
        } catch {
          return
        }
        rmSync(lockPath, { force: true })
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw e // 非冲突类故障（权限/磁盘）上抛，由调用方定语义
      const first = judgeStaleLock(lockPath, isAlive, grace, maxHeld)
      if (first === 'held') return null
      if (first === 'gone') continue // 刚被释放——下轮重试创建
      // X-4：接管前随机 jitter（去相关化并发轮询者——双 contender 同拍判 stale 时，
      // 后到者的 rmSync 会删掉先到者刚重建的新锁 → 双持锁）；注入 0 可关。
      if (jitterMax > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(Math.random() * jitterMax))
      }
      // X-4：rmSync 前二次复核——判 stale 与删除之间，锁文件可能已被其他接管者清理并
      // 重建（新持有者在位 / 年轻空锁）。重判仍 stale 才删；判定翻转 → 放弃本轮重来
      // （下轮重试创建，按新持有者重新评估）。窗口收窄到 µs 级，残余窗口见模块头注。
      if (judgeStaleLock(lockPath, isAlive, grace, maxHeld) !== 'stale') continue
      // 持有进程已死（或超龄仍不可读——创建即崩溃的半写兜底）：接管清理重试
      rmSync(lockPath, { force: true })
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* best-effort */
        }
      }
    }
  }
  return null
}

/**
 * 限时阻塞占锁：每 pollIntervalMs 微睡重试至 timeoutMs。超时返回 null（调用方定
 * 超时语义——丢账类应上抛/留痕，数据类可降级裸写，best-effort 类可直接放弃）。
 */
export function acquireCrossProcessLockWithTimeout(
  lockPath: string,
  timeoutMs: number,
  opts?: CrossProcessLockOptions & { pollIntervalMs?: number },
): (() => void) | null {
  const poll = opts?.pollIntervalMs ?? 5
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const release = tryAcquireCrossProcessLock(lockPath, opts)
    if (release) return release
    if (Date.now() >= deadline) return null
    // Atomics.wait 同步微睡（Node 主线程合法；争用为文件 IO 级毫秒，不会久驻）
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(poll, deadline - Date.now()))
  }
}

/**
 * R30-6（三十轮）：限时占锁的异步孪生——轮询等待改用 setTimeout（事件循环不阻塞），
 * 供承载 SSE/全部接口的服务进程调用链（executeSave/finalize/记账写段）在双进程争用
 * 窗口内保持可响应；同步版（Atomics.wait 微睡）保留给 CLI 侧与无异步上下文的内部点。
 * 语义与同步版逐位对齐：超时返回 null、release 幂等、锁文件机制同源
 * （tryAcquireCrossProcessLock）——同步/异步获取者对同一把锁互通互斥。
 * 同进程嵌套获取同一锁同样自锁（异步形态表现为轮询到超时）——调用方约束不变。
 */
export async function acquireCrossProcessLockAsync(
  lockPath: string,
  timeoutMs: number,
  opts?: CrossProcessLockOptions & { pollIntervalMs?: number },
): Promise<(() => void) | null> {
  const poll = opts?.pollIntervalMs ?? 20
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const release = tryAcquireCrossProcessLock(lockPath, opts)
    if (release) return release
    const remain = deadline - Date.now()
    if (remain <= 0) return null
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(poll, remain)))
  }
}

/** 读锁文件持有者 pid；损坏/缺字段返回 null（视同 stale，崩溃半写兜底）。 */
function readHolderPid(lockPath: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown }
    return typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null
  } catch {
    return null
  }
}
