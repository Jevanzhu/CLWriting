/**
 * 每章 AI 调用预算闸 + 任务维度计量（T5 泛化）。
 *
 * 记账存储在书库 .cache/ai-calls.json；超限阻断自动写章循环烧钱（Q2 甲）。
 * R-5（第十六轮）：同 bookRoot 写操作经 per-bookRoot 互斥队列串行化——定稿摘要后台
 * 钩子（fire-and-forget）与 self-heal 连写已可并发写同书账本，「当前无并行生成场景」
 * 不再成立。损坏时保守阻断。
 *
 * 数据结构（T5 泛化后）：
 *   chapter 块 — 预算闸专用，换章重置（仅 self-heal 记，通过 runTask chapter 参数）
 *   tasks 块   — 按任务类型累计、不重置（runTask 自动记账，7/7 端点覆盖）
 *
 * 与旧版差异：去掉目录锁 / limit_override / stale lock 检测（YAGNI）。
 * 旧格式（flat { chapter, used, ... }）读到即一次性迁移。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
// R30-3（三十轮）：锁等待改异步孪生 + 快路同步尝试——生成收尾路径（SSE/全部接口所在的
// 服务进程）在双进程争用窗口不再被 Atomics.wait 同步微睡冻结事件循环
import { acquireCrossProcessLockAsync, tryAcquireCrossProcessLock } from '../fs/cross-process-lock.js'
import type { BookConfig } from '../format/types.js'
import { GLOBAL_FALLBACK_DEFAULTS } from '../format/global-defaults.js'
import type { TokenUsage } from './provider/types.js'
import { log } from '../log/index.js'

/** chapter 块（预算闸专用） */
interface ChapterUsage {
  num: number
  used: number
  inputTokens: number
  outputTokens: number
  /** D4：cache 记账（可选——旧记录无此字段按 0；端点不下发则不累计） */
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** D3（批 5）：本章金额累计（可选——runTask 按价格表算入；未配价全书不累计=口径不生效）。
   *  币种随价格表 currency（缺省 USD）；数值口径假设全书一致（混币属配置错误） */
  costAccum?: number
  /** A-6（二十九轮）：含估计入账标记——任一次 estimated usage 累入即置位（粘性，
   *  与数值累计同语义：块内数字已是实测/估计混合，标记只说「含估计」）。账实对账
   *  可区分口径；消费方只读数值字段，加性安全 */
  estimated?: boolean
}

/** task 块（全端点覆盖） */
interface TaskUsage {
  used: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** A-6（二十九轮）：同 chapter 块——含估计入账标记（粘性置位） */
  estimated?: boolean
}

/** 磁盘记录格式 */
interface CallRecord {
  chapter: ChapterUsage
  tasks: Record<string, TaskUsage>
}

const FILE = 'ai-calls.json'

function budgetPath(bookRoot: string): string {
  return join(bookRoot, '.cache', FILE)
}

/**
 * 读记录。
 * - 文件缺失 → { rec: null, corrupt: false }（新书，正常）
 * - JSON 损坏 / 形状不对 → { rec: null, corrupt: true }（V-P2-10：预算闸据此保守阻断，
 *   与头注释承诺一致——此前损坏被当「无记录」静默放行归零，恰是自动写章烧钱最不该静默的点）
 * - 旧格式（flat { chapter: number, used: number, ... }）自动迁移。
 */
function readRecord(bookRoot: string): { rec: CallRecord | null; corrupt: boolean } {
  const fp = budgetPath(bookRoot)
  if (!existsSync(fp)) return { rec: null, corrupt: false }
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, unknown>
    // 旧格式检测：raw.chapter 是 number（而非 object）→ 迁移写回
    if (typeof raw['chapter'] === 'number') {
      const migrated = migrateOldFormat(raw as unknown as OldFormat)
      // E-4（第五十三轮）：迁移写改走 serializedWrite 互斥队列——此前裸 writeRecord 发生在
      // read 路径，与在途记账写（已排队的微任务）并发时可交错覆盖丢账。migratedRoots 为
      // 已完成迁移标记：入队写落地前的并发 read 命中标记即短路，不再重复入队（迁移写只写
      // 不读，本身无递归；标记防的是重复入队同一迁移写）。
      // Y-1（第五十七轮）：**已在记账写锁内时不得嵌套 serializedWrite**——serializedWrite
      // 空闲快路不设 writeChains，锁内 readRecord 再入快路会对自持的跨进程锁二次 acquire
      // （持有 pid= 自己、判 held），Atomics.wait 同步自锁至超时 → 丢账 + 谎报「损坏」，
      // 且排队路径的迁移写会用无账快照覆盖刚落盘的记账。锁内改为直接内联迁移：先迁移落盘，
      // 记账叠加其上，两个窗口一并消灭。
      if (inWriteSegment) {
        try {
          writeRecord(bookRoot, migrated)
          migratedRoots.add(bookRoot)
        } catch {
          /* 内联迁移失败不置标记（下次重试）；同源 IO 故障会随后续记账 writeRecord
           * 上抛（writeWithCrossProcessLock → 调用方降级留痕），不会静默吞掉 */
        }
        return { rec: migrated, corrupt: false }
      }
      if (!migratedRoots.has(bookRoot)) {
        migratedRoots.add(bookRoot)
        // N-10（第五十四轮）：写失败时清除标记——此前标记入队即置位，IO 抛错后
        // 迁移永不重试且文件永留旧格式；清除后下次 read 重新入队可重试（排队窗口内
        // 并发 read 仍靠先置位的标记去重，不重复入队）。
        try {
          const inflight = serializedWrite(bookRoot, () => {
            try {
              writeRecord(bookRoot, migrated)
            } catch (err) {
              migratedRoots.delete(bookRoot)
              throw err
            }
          })
          // R30-3（三十轮）：锁被占时 serializedWrite 返回在途 promise（异步轮询等待）——
          // 锁超时等异步失败时 doWrite 未执行、上方内联清标记不生效，这里补清
          //（N-10 口径：锁获取失败与写失败同语义，不清则迁移永不重试）；失败留痕由
          // serializedWrite 旁挂 warn 承担，此处只补标记清理
          if (inflight !== undefined) inflight.catch(() => migratedRoots.delete(bookRoot))
        } catch (err) {
          // N-10 + J7：快路同步抛（J7 锁文件创建 EACCES 等）同样要清标记——
          // 锁获取失败与写失败同语义，不清则迁移永不重试
          migratedRoots.delete(bookRoot)
          throw err
        }
      }
      return { rec: migrated, corrupt: false }
    }
    // 新格式
    const chapter = raw['chapter'] as ChapterUsage | undefined
    if (!chapter || typeof chapter.num !== 'number' || typeof chapter.used !== 'number') {
      return { rec: null, corrupt: true }
    }
    // D4：cache 记账字段可选——存在则必须是数字（与 X-P3a 同口径，坏条目按损坏处理）
    const cacheNum = (v: unknown): number | undefined =>
      v === undefined ? undefined : typeof v === 'number' ? v : NaN
    // X-P3a：tasks 逐条校验形状——盲 cast 遇坏条目（used 非数字）会让后续
    // 累加变 NaN 静默烂账，且绕过「损坏保守阻断」承诺；坏条目按损坏处理
    //（dd-P3：字段存在但非对象〔如被写成字符串〕同样按损坏处理，不静默取空）
    const tasks: Record<string, TaskUsage> = {}
    if (raw['tasks'] !== undefined && raw['tasks'] !== null) {
      if (typeof raw['tasks'] !== 'object') return { rec: null, corrupt: true }
      for (const [k, v] of Object.entries(raw['tasks'] as Record<string, unknown>)) {
        const t = v as Partial<TaskUsage> | null
        if (!t || typeof t.used !== 'number' || typeof t.inputTokens !== 'number' || typeof t.outputTokens !== 'number') {
          return { rec: null, corrupt: true }
        }
        const cr = cacheNum(t.cacheReadTokens)
        const cw = cacheNum(t.cacheWriteTokens)
        if (Number.isNaN(cr) || Number.isNaN(cw)) return { rec: null, corrupt: true }
        tasks[k] = {
          used: t.used,
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
          ...(cr !== undefined ? { cacheReadTokens: cr } : {}),
          ...(cw !== undefined ? { cacheWriteTokens: cw } : {}),
          // A-6（二十九轮）：加性字段原样收（非布尔值按未标记丢弃，不判损坏——
          // 标记不参与数值累计，错型无烂账风险）
          ...(t.estimated === true ? { estimated: true } : {}),
        }
      }
    }
    const chapterCr = cacheNum(chapter.cacheReadTokens)
    const chapterCw = cacheNum(chapter.cacheWriteTokens)
    if (Number.isNaN(chapterCr) || Number.isNaN(chapterCw)) return { rec: null, corrupt: true }
    const chapterCost = cacheNum(chapter.costAccum)
    if (Number.isNaN(chapterCost)) return { rec: null, corrupt: true }
    return {
      rec: {
        chapter: {
          num: chapter.num,
          used: chapter.used,
          inputTokens: typeof chapter.inputTokens === 'number' ? chapter.inputTokens : 0,
          outputTokens: typeof chapter.outputTokens === 'number' ? chapter.outputTokens : 0,
          ...(chapterCr !== undefined ? { cacheReadTokens: chapterCr } : {}),
          ...(chapterCw !== undefined ? { cacheWriteTokens: chapterCw } : {}),
          ...(chapterCost !== undefined ? { costAccum: chapterCost } : {}),
          // A-6（二十九轮）：同 tasks——加性收标记（错型按未标记丢弃，不判损坏）
          ...(chapter.estimated === true ? { estimated: true } : {}),
        },
        tasks,
      },
      corrupt: false,
    }
  } catch {
    return { rec: null, corrupt: true }
  }
}

/** 旧格式（flat record） */
interface OldFormat {
  chapter: number
  used: number
  inputTokens?: number
  outputTokens?: number
}

/** 旧格式 → 新格式迁移 */
function migrateOldFormat(old: OldFormat): CallRecord {
  return {
    chapter: {
      num: old.chapter,
      used: old.used,
      inputTokens: old.inputTokens ?? 0,
      outputTokens: old.outputTokens ?? 0,
    },
    tasks: {},
  }
}

/** E-4（第五十三轮）：旧格式迁移已完成的书库标记（防迁移写落地前并发 read 重复入队） */
const migratedRoots = new Set<string>()

/** 原子写记录（atomicWriteFile + fsync；mode 0600 随临时文件创建即生效——
 *  CC-P2-3：此前先默认权限写再补 chmodSync，既有短暂全局可读窗口，且裸调用无防护、
 *  成功路径同步抛错可反转 GEN_FAIL；mode 选项两问同解，chmodSync 删除） */
function writeRecord(bookRoot: string, rec: CallRecord): void {
  const fp = budgetPath(bookRoot)
  atomicWriteFile(fp, JSON.stringify(rec, null, 2) + '\n', { fsync: true, mode: 0o600 })
}

// R-5（第十六轮复审）：ai-calls.json 读改写串行化（per-bookRoot 互斥队列）——
// 定稿摘要后台钩子与 self-heal 连写并发写同书账本时，无锁的 load→mutate→write
// 序列可能后写覆盖前写丢账。写操作排入 `chain = chain.then(doWrite)` 显式串行化；
// 跨 bookRoot 各自独立链互不阻塞；读路径（checkAiCallBudget 等）保持快照语义不变。
// 队列空闲时同步直行（doWrite 全同步 IO，JS 单线程内该段原子完成）——既有同步调用方
// 「记完即读」语义保持不变；存在在途段时排队为微任务执行，杜绝交错覆盖。
// J7（2026-08-23）：本互斥队列之上叠加跨进程真锁（见下 AI_CALLS_MUTEX_SCOPE_NOTE），
// 多进程（CLI+桌面）同书并发写已闭合。
const writeChains = new Map<string, Promise<unknown>>()

/** Y-1（第五十七轮）：当前是否处于某次记账写段（writeWithCrossProcessLock 的 doWrite）
 *  执行中。readRecord 的旧格式迁移据此感知「已在锁内」——锁内迁移直接内联写，
 *  不得嵌套 serializedWrite（见 readRecord Y-1 注）。 */
let inWriteSegment = false

/** J7（2026-08-23 落地）：跨进程互斥为真锁——serializedWrite 的每次写段在
 * bookRoot/.cache/ai-calls.lock 上做限时跨进程文件锁（O_EXCL + pid 存活探测
 * + 崩溃接管，见 fs/cross-process-lock.ts）。E-7 的「进程内前提」声明就此废止；
 * 超时（默认 5s，持有进程活着但迟迟不放——理论上是文件 IO 级毫秒争用）上抛由
 * 调用方降级（runner recordUsageSafe warn 留痕，少记一次由预算闸保守口径兜底）。
 * R30-3（三十轮）：锁等待改异步轮询（争用窗口事件循环不冻结），无争用快路保持
 * 同步直行（见 writeWithCrossProcessLock 注）。 */
export const AI_CALLS_MUTEX_SCOPE_NOTE =
  'ai-calls.json 互斥为进程内队列 + 跨进程文件锁（J7 已落地，fs/cross-process-lock.ts；R30-3 等待改异步轮询）：写段在 bookRoot/.cache/ai-calls.lock 上限时互斥，超时上抛由调用方降级留痕'

/** 读改写互斥队列（per-bookRoot）。返回 undefined = 已同步完成；Promise = 在途写段
 *  （R30-3：锁被占时的异步等待，调用方无需 await——失败由旁挂 warn 留痕） */
function serializedWrite(bookRoot: string, doWrite: () => void): void | Promise<void> {
  const prev = writeChains.get(bookRoot)
  if (prev === undefined) {
    // 空闲快路：无争用时同步原子完成（J7：跨进程锁内执行——load→mutate→write 整段互斥，
    // 双进程同书记账不再交错覆盖丢账；同步错误同步上抛，rag recordEmbedUsage / runner
    // recordUsageSafe 的既有同步 try/catch 口径不变）。R30-3（三十轮）：锁被占时
    // writeWithCrossProcessLock 返回在途 promise（异步轮询等待）——此处临时入链让后续
    // 写者排队其后（保调用序 = 落盘序），失败走下方旁挂留痕（调用方拿不到同步 throw）。
    const r = writeWithCrossProcessLock(bookRoot, doWrite)
    if (r === undefined) return
    writeChains.set(bookRoot, r)
    const cleanupInflight = (): void => {
      if (writeChains.get(bookRoot) === r) writeChains.delete(bookRoot)
    }
    // R61-7（第六十一轮）口径沿用：在途写段失败旁挂 warn 留痕（少记一次可从日志发现）；
    // 旁挂 rejection handler 同时向运行时标记「已处理」，防 unhandled rejection
    void r.then(cleanupInflight, (e: unknown) => {
      log.warn('ai-calls', `记账写段等待跨进程锁后失败（本轮账目缺失）：${e instanceof Error ? e.message : String(e)}`)
      cleanupInflight()
    })
    return
  }
  const next = prev.catch(() => {}).then(() => writeWithCrossProcessLock(bookRoot, doWrite))
  writeChains.set(bookRoot, next)
  const cleanup = (): void => {
    if (writeChains.get(bookRoot) === next) writeChains.delete(bookRoot)
  }
  // R61-7（第六十一轮）：排队写段失败此前被 cleanup 静默吞（快路同步抛可见、排队路
  // 不可见）——补 warn 留痕对齐 runner recordUsageSafe 口径，丢账可从日志发现
  void next.then(cleanup, (e: unknown) => {
    log.warn('ai-calls', `排队记账写段失败（本轮账目缺失）：${e instanceof Error ? e.message : String(e)}`)
    cleanup()
  })
}

/** J7 锁等待超时（毫秒）——可注入缩短保测试快；争用为文件 IO 级毫秒，5s 已极保守。 */
export let AI_CALLS_LOCK_TIMEOUT_MS = 5_000

/** 测试注入钩子（生产零调用）。 */
export function __setAiCallsLockTimeoutForTest(ms: number): void {
  AI_CALLS_LOCK_TIMEOUT_MS = ms
}

/** R30-3（三十轮）：跨进程锁获取——无争用快路同步持锁直行（tryAcquire 即得，写段为
 *  文件 IO 级毫秒，同步原子完成后返回 undefined，既有「记完即读」语义逐位不变）；
 *  锁被占时改用 acquireCrossProcessLockAsync 异步轮询等待（setTimeout 微睡、事件循环
 *  不阻塞）——CLI+桌面双进程争用时承载 SSE/全部接口的服务进程不再被 Atomics.wait
 *  同步微睡冻结至超时。同步/异步获取对同一把锁互通互斥（fs/cross-process-lock.ts 同源
 *  tryAcquireCrossProcessLock）。返回 undefined = 已同步完成（含同步抛错）；Promise =
 *  在途写段（超时/写失败以 rejection 表达， serializedWrite 旁挂留痕）。
 *  inWriteSegment 进程内串行化语义不变：标志在 doWrite 同步执行段两侧置/清，等待期
 *  （标志为 false）与执行段（标志为 true）对 readRecord 的可观测口径与旧实现一致。 */
function writeWithCrossProcessLock(bookRoot: string, doWrite: () => void): void | Promise<void> {
  const lockPath = `${budgetPath(bookRoot)}.lock`
  const fast = tryAcquireCrossProcessLock(lockPath)
  if (fast) {
    try {
      inWriteSegment = true
      doWrite()
      return
    } finally {
      inWriteSegment = false
      fast()
    }
  }
  return acquireCrossProcessLockAsync(lockPath, AI_CALLS_LOCK_TIMEOUT_MS).then((release) => {
    if (!release) {
      throw new Error(`ai-calls 跨进程锁获取超时（${lockPath}）——本轮账目未记，避免与其他进程交错覆盖丢账`)
    }
    try {
      inWriteSegment = true
      doWrite()
    } finally {
      inWriteSegment = false
      release()
    }
  })
}

/** 预算判定（D3 批 5 起三口径：次数 / tokens / cost）：任一超限 → ok=false + 人话提示
 *  （三条出路在文档 §五）；损坏 → 保守阻断（V-P2-10）。
 *  - tokens 口径 = input+output+cacheRead+cacheWrite 全口径累计（长上下文章正是拦截对象）；
 *  - cost 口径仅当已配价格表（记账里有 costAccum）才生效——未配价静默不拦截
 *   （与信息差未配置静默跳过同语义，不做半吊子拦截，P10-①）。 */
/** 判别联合：ok=false 必带 reason（调用方 narrowing 后 reason 恒为 string，零改动消费） */
export type BudgetCheckResult =
  | {
      ok: true
      used: number
      limit: number
      /** D3：token 口径用量/上限（未设预算时 undefined） */
      usedTokens?: number
      limitTokens?: number
      /** D3：cost 口径用量/上限（未配价或未设预算时 undefined） */
      usedCost?: number
      limitCost?: number
    }
  | {
      ok: false
      used: number
      limit: number
      reason: string
      usedTokens?: number
      limitTokens?: number
      usedCost?: number
      limitCost?: number
    }

export function checkAiCallBudget(bookRoot: string, chapter: number, config: BookConfig): BudgetCheckResult {
  // 全局托底：calls_per_chapter 已可选化——常规路径（self-heal orchestrate）传入的 config
  // 已过 applyGlobalDefaults，这里是直调/测试路径的最终回落（8 与 global.json 缺省一致）
  // R72-12（二十轮 A-2）超额取舍记档：本函数是锁外快照读（:208），与 consume 的
  // 锁内记账构成 check-then-act 窗口——并发写者数为上界的少量超额是**既定取舍**
  // （预算闸防「无限烧」，不承诺精确配额；锁内预记回滚会把 consume 事务复杂化一档，
  // 收益不成比例），不按 bug 处理。
  // R73-8（二十一轮 A-8，裁定维持）：check 与 record 天然被分钟级生成隔开——预算检查
  // 并入记账锁内同事务只能「生成后核对」，挡不住本次生成本身的消耗；锁粒度（短写锁）
  // 不允许跨生成持有，预占/退款方案需在 5 条失败出口（abort/超时/终态失败/Retry-After
  // 终态/成功）补退款事务，错误面扩大不成比例。维持锁外快照读 + 保守口径（超额上界 =
  // 并发写者数），签名保持同步（锁外读消费方 review.ts effectiveRemainingCalls 在 A 域外）。
  const limit = config.budget.calls_per_chapter ?? GLOBAL_FALLBACK_DEFAULTS.callsPerChapter
  const limitTokens = config.budget.tokens_per_chapter
  const limitCost = config.budget.cost_per_chapter
  const { rec, corrupt } = readRecord(bookRoot)

  if (corrupt) {
    return {
      ok: false,
      used: 0,
      limit,
      reason: 'AI 调用记账文件 .cache/ai-calls.json 损坏，已保守阻断。可删除该文件重试（计数从零开始），但请先确认磁盘健康。',
    }
  }
  if (!rec || rec.chapter.num !== chapter) {
    // 无记录或已换章 → 计数从零开始
    return { ok: true, used: 0, limit }
  }
  if (rec.chapter.used >= limit) {
    return {
      ok: false,
      used: rec.chapter.used,
      limit,
      reason: `本章已调用 ${rec.chapter.used} 次（上限 ${limit}）。可临时提高 book.yaml 的 budget.calls_per_chapter，或降低重写次数`,
    }
  }
  // D3：token 口径（全口径累计：input+output+cache 读写）
  if (limitTokens !== undefined) {
    const usedTokens =
      rec.chapter.inputTokens +
      rec.chapter.outputTokens +
      (rec.chapter.cacheReadTokens ?? 0) +
      (rec.chapter.cacheWriteTokens ?? 0)
    if (usedTokens >= limitTokens) {
      return {
        ok: false,
        used: rec.chapter.used,
        limit,
        usedTokens,
        limitTokens,
        reason: `本章已消耗 ${usedTokens} tokens（上限 ${limitTokens}，一次长上下文调用可能顶普通章十次）。可临时提高 book.yaml 的 budget.tokens_per_chapter，或收紧本章备料`,
      }
    }
  }
  // D3：cost 口径（记账有 costAccum = 已配价格表才拦）
  if (limitCost !== undefined && rec.chapter.costAccum !== undefined && rec.chapter.costAccum >= limitCost) {
    return {
      ok: false,
      used: rec.chapter.used,
      limit,
      usedCost: rec.chapter.costAccum,
      limitCost,
      reason: `本章已消耗 ${rec.chapter.costAccum.toFixed(4)}（上限 ${limitCost}，按价格表计）。可临时提高 book.yaml 的 budget.cost_per_chapter，或降低重写次数`,
    }
  }
  // 放行：带三口径用量（effectiveRemainingCalls 折算最紧档用）
  const totalTokens =
    rec.chapter.inputTokens +
    rec.chapter.outputTokens +
    (rec.chapter.cacheReadTokens ?? 0) +
    (rec.chapter.cacheWriteTokens ?? 0)
  return {
    ok: true,
    used: rec.chapter.used,
    limit,
    ...(limitTokens !== undefined ? { usedTokens: totalTokens, limitTokens } : {}),
    ...(limitCost !== undefined && rec.chapter.costAccum !== undefined ? { usedCost: rec.chapter.costAccum, limitCost } : {}),
  }
}

/**
 * D3（批 5）：三审降档用的「有效剩余调用数」——三口径（次数/tokens/cost）各算
 * 已用比例，取最紧（最高比例）的一档折算剩余次数。未设/未配的口径不参与。
 * 三口径都未设 → 返回次数上限（与旧行为一致）。
 */
export function effectiveRemainingCalls(bookRoot: string, chapter: number, config: BookConfig): number {
  const limit = config.budget.calls_per_chapter ?? GLOBAL_FALLBACK_DEFAULTS.callsPerChapter
  // limit ≤ 0（病态配置 calls_per_chapter: 0）→ 0：0/0 会产出 NaN，下游一切比较恒
  // false 等同额度无限；次数上限本身就是「不可调用」，直接归 0
  if (limit <= 0) return 0
  const check = checkAiCallBudget(bookRoot, chapter, config)
  // 超限/损坏 → 保守剩余 0（与 checkAiCallBudget 的拦截语义一致；此前误提前返回
  // 满额 limit——预算耗尽时三审降档反而拿到「额度充足」不降档）
  if (!check.ok) return 0
  const ratios: number[] = [check.used / limit]
  if (check.limitTokens !== undefined && check.usedTokens !== undefined) {
    ratios.push(check.usedTokens / check.limitTokens)
  }
  if (check.limitCost !== undefined && check.usedCost !== undefined) {
    ratios.push(check.usedCost / check.limitCost)
  }
  const tightest = Math.max(...ratios)
  return Math.max(0, Math.ceil((1 - tightest) * limit))
}

/**
 * 记一次 chapter 维度 AI 调用（预算闸用；换章重置）。
 *
 * 由 runTask 在 self-heal 场景（传了 chapter 参数）自动调用。
 * D3（批 5）：costUsd 由 runner 按价格表现算传入（未配价不传——cost 口径静默不生效）。
 */
export function recordAiCall(bookRoot: string, chapter: number, usage: TokenUsage | null, costUsd?: number): void {
  // R-5（第十六轮）：整段读改写经 per-bookRoot 队列串行化（并发写不丢账）
  serializedWrite(bookRoot, () => recordAiCallLocked(bookRoot, chapter, usage, costUsd))
}

function recordAiCallLocked(bookRoot: string, chapter: number, usage: TokenUsage | null, costUsd?: number): void {
  const { rec, corrupt } = readRecord(bookRoot)
  // W-P2-8：损坏不重置——静默覆盖等于绕过 checkAiCallBudget 的保守阻断；
  // 只允许人工删除文件恢复计数（阻断提示里已写明出路）
  if (corrupt) {
    log.error('calls', '.cache/ai-calls.json 损坏，本次记账跳过（保守阻断保持）')
    return
  }
  if (!rec || rec.chapter.num !== chapter) {
    const fresh: CallRecord = { chapter: { num: chapter, used: 0, inputTokens: 0, outputTokens: 0 }, tasks: rec?.tasks ?? {} }
    applyCall(fresh, usage, costUsd)
    writeRecord(bookRoot, fresh)
    return
  }
  applyCall(rec, usage, costUsd)
  writeRecord(bookRoot, rec)
}

/** chapter 计数 +1 并累计 tokens（原 recordAiCall 主体；D4 含 cache 字段；D3 含 cost；
 *  A-6 含 estimated 粘性标记） */
function applyCall(rec: CallRecord, usage: TokenUsage | null, costUsd?: number): void {
  rec.chapter.used += 1
  if (usage) {
    rec.chapter.inputTokens += usage.inputTokens
    rec.chapter.outputTokens += usage.outputTokens
    if (usage.cacheReadTokens !== undefined) {
      rec.chapter.cacheReadTokens = (rec.chapter.cacheReadTokens ?? 0) + usage.cacheReadTokens
    }
    if (usage.cacheWriteTokens !== undefined) {
      rec.chapter.cacheWriteTokens = (rec.chapter.cacheWriteTokens ?? 0) + usage.cacheWriteTokens
    }
    // A-6（二十九轮）：估计口径留痕——账面数字照常累计，标记置位供对账区分实测/估计
    if (usage.estimated) rec.chapter.estimated = true
  }
  // D3（批 5）：金额累计（costUsd 仅在配价时由 runner 传入）
  if (typeof costUsd === 'number' && Number.isFinite(costUsd)) {
    rec.chapter.costAccum = Math.round(((rec.chapter.costAccum ?? 0) + costUsd) * 1e10) / 1e10
  }
}

/**
 * 记一次 task 维度 AI 调用（全端点覆盖；不重置）。
 *
 * 由 runTask 末尾自动调用（有 bookRoot + task 时）。
 */
export function recordTaskUsage(bookRoot: string, task: string, usage: TokenUsage | null): void {
  // R-5（第十六轮）：与 recordAiCall 同队列串行化（chapter/tasks 两块同文件，互斥同一链）
  serializedWrite(bookRoot, () => recordTaskUsageLocked(bookRoot, task, usage))
}

function recordTaskUsageLocked(bookRoot: string, task: string, usage: TokenUsage | null): void {
  const { rec, corrupt } = readRecord(bookRoot)
  // W-P2-8：与 recordAiCall 同口径——损坏不重置，保守阻断保持
  if (corrupt) {
    log.error('calls', '.cache/ai-calls.json 损坏，本次记账跳过（保守阻断保持）')
    return
  }
  const base: CallRecord = rec ?? { chapter: { num: 0, used: 0, inputTokens: 0, outputTokens: 0 }, tasks: {} }
  const t = base.tasks[task] ?? { used: 0, inputTokens: 0, outputTokens: 0 }
  t.used += 1
  if (usage) {
    t.inputTokens += usage.inputTokens
    t.outputTokens += usage.outputTokens
    if (usage.cacheReadTokens !== undefined) {
      t.cacheReadTokens = (t.cacheReadTokens ?? 0) + usage.cacheReadTokens
    }
    if (usage.cacheWriteTokens !== undefined) {
      t.cacheWriteTokens = (t.cacheWriteTokens ?? 0) + usage.cacheWriteTokens
    }
    // A-6（二十九轮）：同 applyCall——估计口径粘性标记
    if (usage.estimated) t.estimated = true
  }
  base.tasks[task] = t
  writeRecord(bookRoot, base)
}
