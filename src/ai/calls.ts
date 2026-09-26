/**
 * 每章 AI 调用预算闸 + 任务维度计量（泛化）。
 *
 * 记账存储在书库 .cache/ai-calls.json；超限阻断自动写章循环烧钱（甲）。
 * 同 bookRoot 写操作经 per-bookRoot 互斥队列串行化——定稿摘要后台
 * 钩子（fire-and-forget）与 self-heal 连写已可并发写同书账本，「当前无并行生成场景」
 * 不再成立。损坏时保守阻断。
 *
 * 数据结构（泛化后）：
 *   chapter 块 — 预算闸专用，换章重置（仅 self-heal 记，通过 runTask chapter 参数）
 *   tasks 块   — 按任务类型累计、不重置（runTask 自动记账，7/7 端点覆盖）
 *
 * 与旧版差异：去掉目录锁 / limit_override / stale lock 检测（YAGNI）。
 * 旧格式（flat { chapter, used, ... }）读到即一次性迁移。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
// 写链队列 + 跨进程锁的写段原语迁 src/fs/lock-file.ts——记账模块不再
// 承载 fs 锁原语（provider/store.ts 与设置域改为直引 fs 层，不经记账模块借用）；
// 的锁等待异步孪生语义随实现整体迁至该文件（本文件只留记账职责）
import { serializedLockedWrite } from '../fs/lock-file.js'
import type { BookConfig } from '../format/types.js'
import { GLOBAL_FALLBACK_DEFAULTS } from '../format/global-defaults.js'
import type { TokenUsage } from './provider/types.js'
import { log } from '../log/index.js'
import { testableConst } from '../shared/testable.js'

/** chapter 块（预算闸专用） */
interface ChapterUsage {
  num: number
  used: number
  inputTokens: number
  outputTokens: number
  /** cache 记账（可选——旧记录无此字段按 0；端点不下发则不累计） */
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** 本章金额累计（可选——runTask 按价格表算入；未配价全书不累计=口径不生效）。
   *  币种随价格表 currency（缺省 USD）；数值口径假设全书一致（混币属配置错误） */
  costAccum?: number
  /** 含估计入账标记——任一次 estimated usage 累入即置位（粘性，
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
  /** 同 chapter 块——含估计入账标记（粘性置位） */
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
 * - JSON 损坏 / 形状不对 → { rec: null, corrupt: true }（预算闸据此保守阻断，
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
      // 迁移写改走 serializedWrite 互斥队列——此前裸 writeRecord 发生在
      // read 路径，与在途记账写（已排队的微任务）并发时可交错覆盖丢账。migratedRoots 为
      // 已完成迁移标记：入队写落地前的并发 read 命中标记即短路，不再重复入队（迁移写只写
      // 不读，本身无递归；标记防的是重复入队同一迁移写）。
      // **已在记账写锁内时不得嵌套 serializedWrite**——serializedWrite
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
        // 写失败时清除标记——此前标记入队即置位，IO 抛错后
        // 迁移永不重试且文件永留旧格式；清除后下次 read 重新入队可重试（排队窗口内
        // 并发 read 仍靠先置位的标记去重，不重复入队）。
        try {
          const inflight = serializedWrite(bookRoot, () => {
            try {
              // 段内重读文件，仅当仍是旧格式才落盘迁移——原闭包写
              // enqueue 前的 migrated@ 无账快照；锁外 read（checkAiCallBudget 等）入队
              // 的迁移写排在先行记账写 A 之后时（链 [A, M]），A 段内已内联迁移+记账落盘，
              // M 用快照覆盖 A 刚落的账（丢一次账）。 消灭的是「锁内 readRecord
              // 再嵌套入队」那半，此处闭合「锁外读入队」的另一半。
              const cur = JSON.parse(readFileSync(budgetPath(bookRoot), 'utf8')) as Record<string, unknown>
              if (typeof cur['chapter'] === 'number') {
                writeRecord(bookRoot, migrateOldFormat(cur as unknown as OldFormat))
              }
            } catch (err) {
              migratedRoots.delete(bookRoot)
              throw err
            }
          })
          // 锁被占时 serializedWrite 返回在途 promise（异步轮询等待）——
          // 锁超时等异步失败时 doWrite 未执行、上方内联清标记不生效，这里补清
          //（口径：锁获取失败与写失败同语义，不清则迁移永不重试）；失败留痕由
          // serializedWrite 旁挂 warn 承担，此处只补标记清理
          if (inflight !== undefined) inflight.catch(() => migratedRoots.delete(bookRoot))
        } catch (err) {
          // + 快路同步抛（锁文件创建 EACCES 等）同样要清标记——
          // 锁获取失败与写失败同语义，不清则迁移永不重试
          migratedRoots.delete(bookRoot)
          throw err
        }
      }
      return { rec: migrated, corrupt: false }
    }
    // 新格式
    const chapter = raw['chapter'] as ChapterUsage | undefined
    // inputTokens/outputTokens 坏值与 tasks 块同判 corrupt（此前静默归 0，
    // 与 tasks 块判损坏的读校验不对称——坏值归 0 是静默烂账）
    if (
      !chapter ||
      typeof chapter.num !== 'number' ||
      typeof chapter.used !== 'number' ||
      typeof chapter.inputTokens !== 'number' ||
      typeof chapter.outputTokens !== 'number'
    ) {
      return { rec: null, corrupt: true }
    }
    // cache 记账字段可选——存在则必须是数字（与同口径，坏条目按损坏处理）
    const cacheNum = (v: unknown): number | undefined => (v === undefined ? undefined : typeof v === 'number' ? v : NaN)
    // tasks 逐条校验形状——盲 cast 遇坏条目（used 非数字）会让后续
    // 累加变 NaN 静默烂账，且绕过「损坏保守阻断」承诺；坏条目按损坏处理
    //（dd-字段存在但非对象〔如被写成字符串〕同样按损坏处理，不静默取空）
    const tasks: Record<string, TaskUsage> = {}
    if (raw['tasks'] !== undefined && raw['tasks'] !== null) {
      if (typeof raw['tasks'] !== 'object') return { rec: null, corrupt: true }
      for (const [k, v] of Object.entries(raw['tasks'] as Record<string, unknown>)) {
        const t = v as Partial<TaskUsage> | null
        if (
          !t ||
          typeof t.used !== 'number' ||
          typeof t.inputTokens !== 'number' ||
          typeof t.outputTokens !== 'number'
        ) {
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
          // 加性字段原样收（非布尔值按未标记丢弃，不判损坏——
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
          inputTokens: chapter.inputTokens,
          outputTokens: chapter.outputTokens,
          ...(chapterCr !== undefined ? { cacheReadTokens: chapterCr } : {}),
          ...(chapterCw !== undefined ? { cacheWriteTokens: chapterCw } : {}),
          ...(chapterCost !== undefined ? { costAccum: chapterCost } : {}),
          // 同 tasks——加性收标记（错型按未标记丢弃，不判损坏）
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

/** 旧格式迁移已完成的书库标记（防迁移写落地前并发 read 重复入队） */
const migratedRoots = new Set<string>()

/** 删书/改名失效挂点（books.ts forgetBookKeyedCaches 家族，同
 *  forgetSettingCache 口径）——migratedRoots 只增不减：删书重建同名书（或还原旧格式
 * 备份）后旧标记会让旧格式迁移在本进程内永不重试（read 每次都走旧格式分支但被标记
 * 去重短路，写回永不再入队）。键即 bookRoot 本身，精确删除即可。 */
export function forgetMigratedRoots(bookRoot: string): void {
  migratedRoots.delete(bookRoot)
}

/** 原子写记录（atomicWriteFile + fsync；mode 0600 随临时文件创建即生效——
 *  ：此前先默认权限写再补 chmodSync，既有短暂全局可读窗口，且裸调用无防护、
 *  成功路径同步抛错可反转 GEN_FAIL；mode 选项两问同解，chmodSync 删除） */
function writeRecord(bookRoot: string, rec: CallRecord): void {
  const fp = budgetPath(bookRoot)
  atomicWriteFile(fp, JSON.stringify(rec, null, 2) + '\n', { fsync: true, mode: 0o600 })
}

// ai-calls.json 读改写串行化（per-bookRoot 互斥队列）——
// 定稿摘要后台钩子与 self-heal 连写并发写同书账本时，无锁的 load→mutate→write
// 序列可能后写覆盖前写丢账。写操作排入 `chain = chain.then(doWrite)` 显式串行化；
// 跨 bookRoot 各自独立链互不阻塞；读路径（checkAiCallBudget 等）保持快照语义不变。
// 队列空闲时同步直行（doWrite 全同步 IO，JS 单线程内该段原子完成）——既有同步调用方
// 「记完即读」语义保持不变；存在在途段时排队为微任务执行，杜绝交错覆盖。
// 本互斥队列之上叠加跨进程真锁（见下 AI_CALLS_MUTEX_SCOPE_NOTE），
// 多进程（CLI+桌面）同书并发写已闭合。
// 原判断已被 作废，（
// 修复批 #3）现状再校正：时点锁获取还是 Atomics.wait 同步阻塞，「排队为
// 微任务」分支确不可达，排队代码按「未来异步化接管面」保留；锁等待改异步轮询
// 后，锁被占时 writeWithCrossProcessLock 返回在途 Promise 并紧随 writeChains.set
//（见 fs/lock-file.ts 的 serializedLockedWrite 快路段，-单源移位；
// 起该原语居其新家）——排队分支已在役（保调用序 = 落盘序），非保留代码。
const writeChains = new Map<string, Promise<unknown>>()

/** 当前是否处于某次记账写段（writeWithCrossProcessLock 的 doWrite）
 *  执行中。readRecord 的旧格式迁移据此感知「已在锁内」——锁内迁移直接内联写，
 *  不得嵌套 serializedWrite（见 readRecord 注）。 */
let inWriteSegment = false

/** （落地）：跨进程互斥为真锁——serializedWrite 的每次写段在
 * bookRoot/.cache/ai-calls.lock 上做限时跨进程文件锁（O_EXCL + pid 存活探测
 * + 崩溃接管，见 fs/cross-process-lock.ts）。 的「进程内前提」声明就此废止；
 * 超时（默认 5s，持有进程活着但迟迟不放——理论上是文件 IO 级毫秒争用）上抛由
 * 调用方降级（runner recordUsageSafe warn 留痕，少记一次由预算闸保守口径兜底）。
 * 锁等待改异步轮询（争用窗口事件循环不冻结），无争用快路保持
 * 同步直行（见 writeWithCrossProcessLock 注）。 */
export const AI_CALLS_MUTEX_SCOPE_NOTE =
  'ai-calls.json 互斥为进程内队列 + 跨进程文件锁（J7 已落地，fs/cross-process-lock.ts；R30-3 等待改异步轮询）：写段在 bookRoot/.cache/ai-calls.lock 上限时互斥，超时上抛由调用方降级留痕'

/** 读改写互斥队列（per-bookRoot）薄壳。返回 undefined = 已同步完成（本侧历史口径：
 *  在途段也返回 undefined，调用方拿不到 promise——失败由 fs/lock-file.ts 的
 *  serializedLockedWrite 旁挂 warn 留痕；readRecord 迁移写的 inflight 兜底分支
 *  在此口径下不可达，保留作未来异步化返回面）。-：快/慢双路、
 *  在途入链、cleanup 身份比对、旁挂 warn 防未处理 rejection 全部收编 serializedLockedWrite
 *  单源（provider/store.ts saveProviders 同构薄壳），机制语义逐位不变。 */
function serializedWrite(bookRoot: string, doWrite: () => void): void | Promise<void> {
  const lockPath = `${budgetPath(bookRoot)}.lock`
  return serializedLockedWrite(writeChains, bookRoot, lockPath, doWrite, {
    warnTag: 'ai-calls',
    fastWarn: (m) => `记账写段等待跨进程锁后失败（本轮账目缺失）：${m}`,
    queuedWarn: (m) => `排队记账写段失败（本轮账目缺失）：${m}`,
    lockTimeoutMs: () => getAiCallsLockTimeoutMs(),
    lockTimeoutMsg: `ai-calls 跨进程锁获取超时（${lockPath}）——本轮账目未记，避免与其他进程交错覆盖丢账`,
    segmentFlag: (on) => {
      inWriteSegment = on
    },
    returnInflight: false,
  })
}

/**
 * 锁等待超时（毫秒）——可注入缩短保测试快；争用为文件 IO 级毫秒，5s 已极保守。
 *  收口口径：export let 可被任一 import 方静默改写（同
 * events/store.ts 的收口认定；manifest/lead-finalize 等六处于已收口，
 * 本处漏网）——改 const + 内部可变生效值，测试只能经注入钩子改档，生产恒用常量。
 */
export const AI_CALLS_LOCK_TIMEOUT_MS = 5_000

/** 三件套换装 testableConst 工厂：生效值 getter（消费点显式调用）+ 测试注入 setter 元组第二位（原名原签名，测试面零感知）。 */
export const [getAiCallsLockTimeoutMs, __setAiCallsLockTimeoutForTest] = testableConst(AI_CALLS_LOCK_TIMEOUT_MS)

// ── ：写链队列 + 跨进程锁的写段原语已迁 src/fs/lock-file.ts ─────────
// serializedLockedWrite / crossProcessLockedWrite（-单源）原定义
// 于此，被 provider/store.ts 借用（记账模块被动承载 fs 锁职责）；现由两域各自直引
// fs 层，本文件只留记账职责（预算判定 / 用量累计 / 落盘读写）。
/** 预算判定（批 5 起三口径：次数 / tokens / cost）：任一超限 → ok=false + 人话提示
 *  （三条出路在文档 §五）；损坏 → 保守阻断。
 *  - tokens 口径 = input+output+cacheRead+cacheWrite 全口径累计（长上下文章正是拦截对象）；
 *  - cost 口径仅当已配价格表（记账里有 costAccum）才生效——未配价静默不拦截
 *   （与信息差未配置静默跳过同语义，不做半吊子拦截，0-①）。 */
/** 判别联合：ok=false 必带 reason（调用方 narrowing 后 reason 恒为 string，零改动消费） */
type BudgetCheckResult =
  | {
      ok: true
      used: number
      limit: number
      /** token 口径用量/上限（未设预算时 undefined） */
      usedTokens?: number
      limitTokens?: number
      /** cost 口径用量/上限（未配价或未设预算时 undefined） */
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
  // 超额取舍记档：本函数是锁外快照读（208），与 consume 的
  // 锁内记账构成 check-then-act 窗口——并发写者数为上界的少量超额是**既定取舍**
  // （预算闸防「无限烧」，不承诺精确配额；锁内预记回滚会把 consume 事务复杂化一档，
  // 收益不成比例），不按 bug 处理。
  // （二十一轮，裁定维持）：check 与 record 天然被分钟级生成隔开——预算检查
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
      reason:
        'AI 调用记账文件 .cache/ai-calls.json 损坏，已保守阻断。可删除该文件重试（计数从零开始），但请先确认磁盘健康。',
    }
  }
  // 显式 0/负数 = 「一次都不许调」——`??` 全局托底只兜 undefined/null
  // （0 非 nullish 原样透传），首调路径（无记录/换章重置）此前早于 used>=limit 判定放行，
  // 与常量语义分叉。fail-loud 可读文案（镜像下方超限文案风格），病态配置显式拒绝。
  if (limit <= 0) {
    const used = rec && rec.chapter.num === chapter ? rec.chapter.used : 0
    return {
      ok: false,
      used,
      limit,
      reason: `本章 AI 调用上限为 ${limit}（budget.calls_per_chapter），按「一次都不许调」拦截。如需恢复调用请把 book.yaml 的 budget.calls_per_chapter 调回正数`,
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
  // token 口径（全口径累计：input+output+cache 读写）
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
  // cost 口径（记账有 costAccum = 已配价格表才拦）
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
    ...(limitCost !== undefined && rec.chapter.costAccum !== undefined
      ? { usedCost: rec.chapter.costAccum, limitCost }
      : {}),
  }
}

/**
 * 三审降档用的「有效剩余调用数」——三口径（次数/tokens/cost）各算
 * 已用比例，取最紧（最高比例）的一档折算剩余次数。未设/未配的口径不参与。
 * 三口径都未设 → 返回次数上限（与旧行为一致）。
 */
export function effectiveRemainingCalls(bookRoot: string, chapter: number, config: BookConfig): number {
  const limit = config.budget.calls_per_chapter ?? GLOBAL_FALLBACK_DEFAULTS.callsPerChapter
  // limit ≤ 0（病态配置 calls_per_chapter: 0）→ 0：0/0 会产出 NaN，下游一切比较恒
  // false 等同额度无限；次数上限本身就是「不可调用」，直接归 0。起
  // checkAiCallBudget 同口径首调即拦（可读文案），此处守卫语义保持——防 ratios 除法
  // NaN 的最后防线，不依赖上游闸的先验
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
 * 头注如实化（合并批收编，指向 dev 侧同题实现）：生产路径已由 recordUsageBoth 取代（合并后
 * runner 单锁记账），本函数生产零调用，保留为测试记账辅助入口（8 个测试文件在用，
 * 删除需改写约 40 处调用不成比例）。
 * costUsd 由 runner 按价格表现算传入（未配价不传——cost 口径静默不生效）。
 */
export function recordAiCall(bookRoot: string, chapter: number, usage: TokenUsage | null, costUsd?: number): void {
  // 整段读改写经 per-bookRoot 队列串行化（并发写不丢账）
  serializedWrite(bookRoot, () => recordAiCallLocked(bookRoot, chapter, usage, costUsd))
}

function recordAiCallLocked(bookRoot: string, chapter: number, usage: TokenUsage | null, costUsd?: number): void {
  const { rec, corrupt } = readRecord(bookRoot)
  // 损坏不重置——静默覆盖等于绕过 checkAiCallBudget 的保守阻断；
  // 只允许人工删除文件恢复计数（阻断提示里已写明出路）
  if (corrupt) {
    log.error('calls', '.cache/ai-calls.json 损坏，本次记账跳过（保守阻断保持）')
    return
  }
  if (!rec || rec.chapter.num !== chapter) {
    const fresh: CallRecord = {
      chapter: { num: chapter, used: 0, inputTokens: 0, outputTokens: 0 },
      tasks: rec?.tasks ?? {},
    }
    applyCall(fresh, usage, costUsd)
    writeRecord(bookRoot, fresh)
    return
  }
  applyCall(rec, usage, costUsd)
  writeRecord(bookRoot, rec)
}

/** chapter 计数 +1 并累计 tokens（原 recordAiCall 主体；含 cache 字段；含 cost；
 * 含 estimated 粘性标记） */
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
    // 估计口径留痕——账面数字照常累计，标记置位供对账区分实测/估计
    if (usage.estimated) rec.chapter.estimated = true
  }
  // 金额累计（costUsd 仅在配价时由 runner 传入）
  if (typeof costUsd === 'number' && Number.isFinite(costUsd)) {
    rec.chapter.costAccum = Math.round(((rec.chapter.costAccum ?? 0) + costUsd) * 1e10) / 1e10
  }
}

/**
 * 任务维度预算闸（chat 按书次数闸用，runner runTask 入口调）。
 *
 * 判定优先序与 checkAiCallBudget 逐条镜像：
 * - limit undefined = 未配（无闸，直接放行——缺省零行为变化，连账本都不读）；
 * - 账本损坏 → 保守阻断（同款文案）；
 * - limit ≤ 0 → 「一次都不许调」（同语义；parse 面 fail-closed 落 0 也走此臂）；
 * - tasks 块 used ≥ limit → 拦截（次数口径读 tasks[task].used——runTask 每 attempt
 *   均按次入账〔/〕，重试/失败调用不漏）。
 *
 * cost 口径不设：tasks 块历史不累计金额（cost 仅 chapter 块记），无现成机制可复用，
 * 按「不强造」口径本闸只做次数上限。
 *
 * （六轮修复批）：文案参数化——本闸签名通用（任意
 * task），但两条 reason 原写死「chat 调用上限 / 本书对话 / 降低对话/压缩频率 /
 * budget.chat_max_calls」；当前唯一调用方（runner.ts:510）恒传 'chat' 故无实害，第二类
 * 任务复用本闸时文案会指错配置键、误导作者去改无关的 book.yaml 项。
 * 三个文案参均带**缺省值**，缺省调用输出字符串与原实现逐字节相同（免动调用点、免动既有
 * 测试钉值）：
 *  - `taskLabel`（'chat'）——句首任务名（「chat 调用上限为 …」）；
 *  - `taskNoun`（'对话'）——中文名词位（「如需恢复对话」「本书对话已调用」）；
 *  - `rateHint`（'对话/压缩'）——末句降频提示位（「或降低对话/压缩频率」）。
 *  批内自纠如实记：初版只加 taskLabel/configKey 两参且直接改写句尾（「或降低调用频率」），
 *  缺省输出与原文不逐字节相同（漏空格 + 句尾改字）——缺省契约是「零行为变化」，故补第三参
 *  并把措辞回退到原文，回归用例钉死两条缺省 reason 的完整字符串。
 */
export function checkAiTaskCallBudget(
  bookRoot: string,
  task: string,
  limit: number | undefined,
  taskLabel = 'chat',
  configKey = 'budget.chat_max_calls',
  taskNoun = '对话',
  rateHint = '对话/压缩',
): { ok: true; used: number } | { ok: false; used: number; reason: string } {
  if (limit === undefined) return { ok: true, used: 0 }
  const { rec, corrupt } = readRecord(bookRoot)
  if (corrupt) {
    return {
      ok: false,
      used: 0,
      reason:
        'AI 调用记账文件 .cache/ai-calls.json 损坏，已保守阻断。可删除该文件重试（计数从零开始），但请先确认磁盘健康。',
    }
  }
  const used = rec?.tasks[task]?.used ?? 0
  if (limit <= 0) {
    return {
      ok: false,
      used,
      reason: `${taskLabel} 调用上限为 ${limit}（${configKey}），按「一次都不许调」拦截。如需恢复${taskNoun}请把 book.yaml 的 ${configKey} 调回正数`,
    }
  }
  if (used >= limit) {
    return {
      ok: false,
      used,
      reason: `本书${taskNoun}已调用 ${used} 次（上限 ${limit}，${configKey}）。可临时提高 book.yaml 的 ${configKey}，或降低${rateHint}频率`,
    }
  }
  return { ok: true, used }
}

/**
 * 记一次 task 维度 AI 调用（全端点覆盖；不重置）。
 *
 * 由 runTask 末尾自动调用（有 bookRoot + task 时）。
 */
export function recordTaskUsage(bookRoot: string, task: string, usage: TokenUsage | null): void {
  // 与 recordAiCall 同队列串行化（chapter/tasks 两块同文件，互斥同一链）
  serializedWrite(bookRoot, () => recordTaskUsageLocked(bookRoot, task, usage))
}

function recordTaskUsageLocked(bookRoot: string, task: string, usage: TokenUsage | null): void {
  const { rec, corrupt } = readRecord(bookRoot)
  // 与 recordAiCall 同口径——损坏不重置，保守阻断保持
  if (corrupt) {
    log.error('calls', '.cache/ai-calls.json 损坏，本次记账跳过（保守阻断保持）')
    return
  }
  const base: CallRecord = rec ?? { chapter: { num: 0, used: 0, inputTokens: 0, outputTokens: 0 }, tasks: {} }
  applyTaskUsage(base, task, usage)
  writeRecord(bookRoot, base)
}

/** task 计数 +1 并累计 tokens（自 recordTaskUsageLocked 拆出的单源突变段，
 *  与 recordUsageBothLocked 共用——两入口写入语义逐字段一致，防手抄漂移） */
function applyTaskUsage(rec: CallRecord, task: string, usage: TokenUsage | null): void {
  const t = rec.tasks[task] ?? { used: 0, inputTokens: 0, outputTokens: 0 }
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
    // 同 applyCall——估计口径粘性标记
    if (usage.estimated) t.estimated = true
  }
  rec.tasks[task] = t
}

/**
 * runner 每 attempt 的 task/chapter 双块记账合并单写段——此前
 * recordTaskUsage 与 recordAiCall 先后各走一次「跨进程锁 + readRecord + writeRecord
 * （+fsync）」，同账本两段 RMW 纯增争用窗口与 IO。本函数一次锁 + 一次读 + 一次原子写
 * 同改两块：task 块经 applyTaskUsage（= recordTaskUsageLocked 逐字段），chapter 块经
 * applyCall + 换章 fresh 重置（= recordAiCallLocked 逐字段，含「无记录/换章重置 +
 * tasks 保留」口径）；损坏保守跳过同口径（合并后只 log 一次）。原两函数保留不动
 * （rag/index.ts 等其它调用方与测试面零改动）。task/chapter 双缺省 = 无可记块，
 * 不进写段（与旧「两 if 各自跳过」等价）。
 */
export function recordUsageBoth(
  bookRoot: string,
  task: string | undefined,
  chapter: number | undefined,
  usage: TokenUsage | null,
  costUsd?: number,
): void {
  if (task === undefined && chapter === undefined) return
  serializedWrite(bookRoot, () => recordUsageBothLocked(bookRoot, task, chapter, usage, costUsd))
}

function recordUsageBothLocked(
  bookRoot: string,
  task: string | undefined,
  chapter: number | undefined,
  usage: TokenUsage | null,
  costUsd?: number,
): void {
  const { rec, corrupt } = readRecord(bookRoot)
  if (corrupt) {
    log.error('calls', '.cache/ai-calls.json 损坏，本次记账跳过（保守阻断保持）')
    return
  }
  const base: CallRecord = rec ?? { chapter: { num: 0, used: 0, inputTokens: 0, outputTokens: 0 }, tasks: {} }
  // task 块（与 recordTaskUsageLocked 逐字段一致）
  if (task !== undefined) applyTaskUsage(base, task, usage)
  // chapter 块（与 recordAiCallLocked 逐字段一致：换章 fresh 重置 chapter、tasks 保留）
  if (chapter !== undefined) {
    if (!rec || rec.chapter.num !== chapter) {
      const fresh: CallRecord = {
        chapter: { num: chapter, used: 0, inputTokens: 0, outputTokens: 0 },
        tasks: base.tasks,
      }
      applyCall(fresh, usage, costUsd)
      writeRecord(bookRoot, fresh)
      return
    }
    applyCall(base, usage, costUsd)
  }
  writeRecord(bookRoot, base)
}
