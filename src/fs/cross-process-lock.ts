/**
 * 跨进程文件锁基建（批次，落地）。
 *
 * proper-lockfile 式语义，但用**文件**而非 mkdir：open 'wx'（O_CREAT|O_EXCL）独占
 * 创建——创建与检查之间无 TOCTOU 窗口。锁文件内容写 { pid, bootTime } 作诊断；
 * 持有进程不存活（process.kill(pid,0) ESRCH）或锁文件损坏（崩溃半写）判 stale，
 * 接管清理后重试一次——崩溃残留不永锁。
 *
 * win 语义评估（任务项）：libuv 对 'wx' 在 Windows 同样保证 O_EXCL 原子性
 * （NtCreateFile FILE_CREATE 语义），跨平台一致；stale 接管的 unlink 在 win 上
 * 对已关闭句柄的文件同样成立（本实现锁文件不长持 fd，创建写 pid 后即关）。
 * EPERM（进程存在但属他人）按存活保守处理——win 上跨用户探测即此形态，不接管。
 *
 * 等待语义：tryAcquire 非阻塞（null = 未拿到）；acquireWithTimeout 以
 * Atomics.wait 同步微睡重试（Node 主线程可用；争用窗口是文件 IO 的微秒~毫秒级，
 * 阻塞时长由调用方超时封顶）。同进程嵌套获取同一锁会自锁——调用方需保证进程内
 * 已有串行化（如 calls.ts 的 writeChains）再进跨进程锁。
 *
 * / （Opus-5.5 轮）：stale 接管的「判定 → 夺锁」残余竞态。原实现
 * 「判 stale → rmWithRetry(锁名) → 重试创建」把删除落在**共享锁名**上，而该删除不可观测
 *（rmSync force 对已不存在的路径静默成功）：两个 contender 先后对同一把死锁判 stale 时，
 * 后到者的 rm 可能删掉先到者刚重建的新锁再自建（双持锁），自己看不出发生过什么。现接管
 * 改为「原子改名认领」——rename(锁名 → 同目录唯一隔离名)：同一源名至多一个赢家，「判
 * stale」与「实际夺走」不再分离；败者只得 ENOENT（源已被赢家取走 / 持有者已自行释放），
 * 此时它不触碰任何文件，落回 create 路径按在位者的活 pid 重新判定——「删共享名 + 自建」
 * 这一对动作对败者已不存在。
 * 残余来源如实记档：① 二次复核与 rename 之间共享名被换（恰在该窗内重建的赢家的新锁会被
 * 夺走）——按名 check-then-act 固有，窗口是复核到 rename 的几条指令（µs 级，proper-lockfile
 * 同款），再收窄需夺取后核验隔离件身份；② 活进程超龄误判（judgeStaleLock 的分支：
 * pid 复用 / SIGSTOP 形态），由持锁方续期兜底（renewIntervalMs——长临界段调用方必须开启，
 * 见 learn 的 LEARN_HARVEST_LOCK_RENEW_MS）。彻底闭合需 lease/fencing token，超出文件锁范畴。
 */
import { mkdirSync, openSync, writeSync, closeSync, rmSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { log } from '../log/index.js'
import { rmWithRetry, renameWithRetry, rmQuietly, retryOnTransientFsError, fsBackoffSleep } from './atomic.js'
// 存活探测拆零依赖叶子模块（原定义在本文件）——fs/atomic.ts 只为取它
// 而 import 本模块、本模块又 import atomic 的重试原语，互引成环；拆后环消除。
// isProcessAlive 继续自本模块 re-export：events/store-open-markers 与
// studio/server/api/task-gate 的既有 import 面（口径）不动。
import { isProcessAlive } from './process-alive.js'
export { isProcessAlive } from './process-alive.js'

/** 本进程启动时刻（epoch ms，由 uptime 反推）——锁文件诊断字段（未来 pid 复用判别依据）。
 *  导出复用：events 开口标记内容同样落 pid+bootTime。 */
export function processBootTime(): number {
  return Date.now() - Math.round(process.uptime() * 1000)
}

interface CrossProcessLockOptions {
  /** 进程存活判定（测试注入用）；缺省 process.kill(pid,0) 探测。 */
  isProcessAlive?: (pid: number) => boolean
  /** 不可读锁（创建后 pid 未写完/空文件）视为存活的年龄宽限（毫秒）——
   *  见下方 STALE_GRACE_MS 注释；测试注入 0 可关掉宽限。 */
  staleGraceMs?: number
  /** stale 接管前的随机 jitter 上限（毫秒，睡 [0, 上限) 均匀值）——去相关化并发
   *  轮询者，降低「双 contender 同拍判 stale、后到者删掉先到者新锁」概率；测试注入 0
   *  关掉。只睡一次（首轮判 stale 后），不叠加 acquireWithTimeout 的轮询间隔。 */
  staleTakeoverJitterMs?: number
  /** 活 pid 超龄判 stale 的门槛（毫秒）——pid 复用防护；注入 0 关闭。 */
  maxHeldMs?: number
  /** 持锁方续期周期（毫秒）——>0 时占锁成功即起定时器定期
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

/** stale 接管 jitter 上限缺省值（毫秒）。 */
const STALE_TAKEOVER_JITTER_MS = 25

/** 锁文件「活 pid 超龄」判 stale 的年龄门槛（毫秒）——本仓锁持有段为毫秒级，
 *  10 分钟已极保守；注入 0 可关闭。 */
const MAX_HELD_MS = 10 * 60_000

/**
 * 收口（全量偶挂实测）：open 'wx' 的 win 瞬态重试包裹。
 *
 * 对手进程 rmSync 释放锁文件（正常释放或 stale 接管）后，Windows 的删除在途窗口
 * （DELETE_PENDING）内对同路径的 'wx' 创建**不报 EEXIST 而报 EPERM/EACCES**；
 * 杀软/索引器/备份扫描瞬时握住新文件同型（既有登记）。此前 EPERM 落
 * 「非冲突类故障上抛」分支——calls-cross-process 双进程回归的子进程直接崩
 * （worker 退出码 1），事件库首开/登记等全部锁调用方同面暴露。
 *
 * 处置：EPERM/EACCES 短微睡重试（总窗 ~50ms，远小于任何调用方超时档）——
 * delete-pending 数十 µs~ms 级即消散，重试即得；窗口耗尽仍 EPERM 才上抛
 * （真权限故障不吞，与既有「非冲突类故障原样上抛」语义兼容：只是把**瞬态**
 * EPERM 与**持久** EPERM 分流）。EEXIST 照旧直抛给调用方的 stale 判定分支。
 * 微睡用 Atomics.wait（本模块同步原语既有口径）。
 */
const OPEN_TRANSIENT_RETRY_MAX = 10
const OPEN_TRANSIENT_RETRY_INTERVAL_MS = 5

function openExclusiveWithTransientRetry(lockPath: string): number {
  let lastErr: unknown
  for (let i = 0; i < OPEN_TRANSIENT_RETRY_MAX; i++) {
    try {
      return openSync(lockPath, 'wx')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES') throw e
      lastErr = e
      fsBackoffSleep(OPEN_TRANSIENT_RETRY_INTERVAL_MS)
    }
  }
  throw lastErr
}

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
    // 活 pid + 超龄 → stale 接管（pid 复用防护）——本仓所有锁的
    // 持有段都是文件 IO 级毫秒，超龄（缺省 10min，可注入）仍「活着」只可能是原持有者
    // 已死、pid 被系统复用给长命进程（bootTime 已落盘但无跨进程查询 API，年龄是可用
    // 判据）。残余风险如实记档：持锁进程被 SIGSTOP 挂起超龄的极端形态会被误接管。
    // 接管条件收紧为「超龄且 mtime 无续期」——长持锁方用
    // renewIntervalMs 定期 utimes 刷新 mtime，活着且在续期 → age 恒小于门槛，不接管；
    // 只有「超龄且期间无任何续期 touch」（真死进程 pid 复用 / SIGSTOP 后无人续期）
    // 才判 stale。判据本身仍是 mtime 年龄（utimes 续期即重置），无需新增状态位。
    if (maxHeldMs !== undefined && maxHeldMs > 0) {
      try {
        const age = Date.now() - Math.floor(statSync(lockPath).mtimeMs)
        if (age > maxHeldMs) return 'stale'
      } catch {
        /* 注释修正：stat 失败（刚被释放）→ 穿落到下方 return
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
    // （中件组批）：win 时钟粒度下刚落盘文件的 mtime 可整体超前 Date.now
    // 读数（负年龄，负载重时内核 tick 粗粒化更频）——钳 0 防「年轻空锁」把
    // staleGraceMs:0 的接管面误判 held（陈锁接管测试因此抖假红）；grace>0 语义不变
    //（未来 mtime 视同 age 0，仍在宽限内判 held）
    if (Number.isFinite(mtime) && Math.max(0, Date.now() - Math.floor(mtime)) < graceMs) return 'held'
  }
  return 'stale'
}

/**
 * 只读锁状态查询——复用 judgeStaleLock 的完整陈锁判定语义（活 pid +
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
      fd = openExclusiveWithTransientRetry(lockPath)
      // ①：writeSync 单次调用可短写（ENOSPC 磁盘满/信号中断），
      // 半写残 JSON 锁文件会被对手判「坏锁」接管（双持锁）——循环写满为止
      const payload = JSON.stringify({ pid: process.pid, bootTime: processBootTime() })
      const buf = Buffer.from(payload, 'utf8')
      for (let off = 0; off < buf.length; ) {
        off += writeSync(fd, buf, off, buf.length - off)
      }
      let released = false
      // 续期定时器——周期 utimes 刷锁文件 mtime（best-effort：锁文件被外部清理/
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
        // ②：释放前校验「仍是我创建的那把锁」——读锁文件内容与写入串逐字节
        // 一致（pid+bootTime 即自身）才删；不一致 = 双 contender 双持锁残余窗口
        // 里锁已被他人重建（无条件 rmSync 会删掉他人在位的新锁）。读失败（含已不在
        // 盘）同样不删——删错他人锁的代价高于残留（残留由 stale 接管路径收口）。
        try {
          if (readFileSync(lockPath, 'utf-8') !== payload) return
        } catch {
          return
        }
        // 改 rmWithRetryQuiet——瞬时占用（杀软/索引器锁定刚关闭的锁文件）下
        // 裸 rmSync 抛错会从调用方 finally 反噬已成功的受锁操作；残留自愈路径见函数注
        rmWithRetryQuiet(lockPath)
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        // （§四.10）：open 'wx' 成功后 writeSync 失败
        //（ENOSPC 半写等）——fd 在手 = 锁文件是本 attempt 刚创建的残锁，原样上抛后
        // 残留依赖 STALE_GRACE_MS 500ms 宽限（宽限期内对不可读锁判 held，调用方无谓
        // 空转重试到超时）+ 陈锁接管自愈，且零留痕。best-effort 删刚创建的残锁（删除
        // 自身失败仍走既有宽限/接管自愈，不掩盖原始错误）+ warn 留痕后**原样上抛**
        //（不吞错：权限/磁盘类故障语义仍由调用方定——与「非冲突类故障上抛」口径一致）。
        if (fd !== undefined) {
          let cleaned = true
          try {
            rmWithRetry(lockPath)
          } catch {
            cleaned = false // 清理失败：残留锁仍带活 pid（本进程），走宽限/接管自愈
          }
          log.warn(
            'fs',
            `锁文件写入 pid 失败（${code ?? '未知错误'}）${cleaned ? '，已清理刚创建的残锁' : '，残锁清理失败（残留交 500ms 宽限 + 陈锁接管自愈）'}：${lockPath}`,
          )
        }
        throw e // 非冲突类故障（权限/磁盘）上抛，由调用方定语义
      }
      const first = judgeStaleLock(lockPath, isAlive, grace, maxHeld)
      if (first === 'held') return null
      if (first === 'gone') continue // 刚被释放——下轮重试创建
      // 接管前随机 jitter（去相关化并发轮询者——双 contender 同拍判 stale 时，
      // 后到者的夺锁动作会落在先到者刚重建的新锁上 → 双持锁）；注入 0 可关。本 jitter
      // 与下方二次复核在改名认领后仍保留：它们把「判 stale」与「实际夺走」的间隔
      // 压到极限（残余窗口见模块头注①）。
      if (jitterMax > 0) fsBackoffSleep(Math.floor(Math.random() * jitterMax))
      // 夺锁前二次复核——判 stale 与夺取之间，锁文件可能已被其他接管者清理并
      // 重建（新持有者在位 / 年轻空锁）。重判仍 stale 才继续；判定翻转 → 放弃本轮重来
      // （下轮重试创建，按新持有者重新评估）。窗口收窄到 µs 级，残余窗口见模块头注。
      if (judgeStaleLock(lockPath, isAlive, grace, maxHeld) !== 'stale') continue
      // 陈锁接管留痕——持有进程已死/超龄不可读的锁被接管清理此前零 warn
      //（自愈发生但无迹可查，双 contender/崩溃恢复场景无从诊断）；带原持有 pid（读取
      // 失败容错为「pid 不可读」）。
      const staleHolderPid = readHolderPid(lockPath)
      // （Opus-5.5 轮）：接管 = 「原子改名认领」——夺锁动作不再落在共享
      // 名上（旧实现 rmWithRetry(lockPath) 删共享名，且 force 删除不可观测：两个 contender
      // 先后判同一把死锁 stale 时，后到者的 rm 落在先到者刚重建的新锁上也照样"成功"）。
      // 改名后同一源名至多一个赢家，输的那方拿到 ENOENT ——它不触碰任何文件，落回 create
      // 路径：① 赢家已重建 → 撞 EEXIST → 按在位者活 pid 判定（活着不接管，见下方 null）；
      // ② 赢家还没重建 → 直接建成自己的锁。两条路都不会出现「删掉他人新锁再自建」。
      // win 杀软/索引器对死进程遗留锁文件的瞬时锁定（EPERM/EBUSY）由 renameWithRetry 的
      // 3×50ms 指数退避吸收（原口径）；退避后仍失败照旧上抛——接管语义不吞错，
      // 调用方超时降级面不变。
      const quarantinePath = join(
        dirname(lockPath),
        // 同目录（rename 需同卷才原子）+ 唯一（本进程 pid + uuid，无他人可争用）；后缀形态
        // 匹配 fs/atomic.ts 的 ABANDONED_TMP_RE → 删除失败留下的残迹交官方 sweep 自愈
        //（本进程存活时走 SELF_TMP_MIN_AGE_MS 5min 自身年龄门，绝不被误当在途写清掉）
        `.${basename(lockPath)}.${process.pid}.${randomUUID()}.tmp`,
      )
      try {
        renameWithRetry(lockPath, quarantinePath)
      } catch (e) {
        // ENOENT = 源名已空（他人已改名认领，或持有者恰在此刻自行释放）——本 contender 不
        // 触碰任何文件，落 create 路径与在位者公平竞争（与旧实现 for 两次尝试语义等价）；
        // 其余（EPERM/EBUSY 退避耗尽、权限类）原样上抛。
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw e
      }
      log.warn(
        'fs',
        `陈锁接管：持有进程${staleHolderPid !== null ? `（pid=${staleHolderPid}）` : '（pid 不可读——超龄半写/损坏）'}已死或超龄，已改名隔离并重试创建：${lockPath}`,
      )
      // 隔离文件（死锁原件）删除 best-effort：名字唯一、无他人争用，删除失败仅留隔离残迹
      //（交 sweep 自愈，见上方 quarantinePath 注释），不因清理失败反噬接管本身。
      rmQuietly(quarantinePath)
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
    // 同步微睡（Node 主线程合法；争用为文件 IO 级毫秒，不会久驻）
    fsBackoffSleep(Math.min(poll, deadline - Date.now()))
  }
}

/**
 * 限时占锁的异步孪生——轮询等待改用 setTimeout（事件循环不阻塞），
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

/**
 * （win 平台专项）：锁文件释放删除的瞬时占用防护。release 普遍在
 * 调用方 finally 中执行——锁文件「创建+关闭」后的杀软/索引器瞬时锁定（EBUSY/EPERM）
 * 会让裸 rmSync 抛错反噬已成功的受锁操作（保存成功却回 500）。EPERM/EBUSY 按
 * renameWithRetry 同款 3×50ms 指数退避重试；仍失败（含 EACCES 等确定性错误）
 * 静默放弃 + warn 留痕：残留锁带本进程活 pid 判 held，超龄（MAX_HELD_MS 无续期）
 * 走 stale 接管、进程死后由 sweepAbandonedTmpFiles 的 .lock 分支清扫——可自愈，
 * 绝不反噬调用方。rm/sleep 可注入（测试用，不动生产语义）。
 * 循环体收编 atomic.retryOnTransientFsError 单实现（薄壳，
 * 口径逐位不变；接管面同批接入本函数）。
 */
export function rmWithRetryQuiet(
  path: string,
  opts?: {
    rm?: (p: string) => void
    sleep?: (ms: number) => void
    retries?: number
    baseDelayMs?: number
  },
): void {
  const doRm = opts?.rm ?? ((p: string) => rmSync(p, { force: true }))
  retryOnTransientFsError(() => doRm(path), {
    sleep: opts?.sleep ?? fsBackoffSleep,
    retries: opts?.retries ?? 3,
    baseDelayMs: opts?.baseDelayMs ?? 50,
    onExhausted: () => {
      log.warn('fs', `锁文件释放删除失败（已放弃，残留交陈锁接管/清扫路径自愈）：${path}`)
    },
  })
}
