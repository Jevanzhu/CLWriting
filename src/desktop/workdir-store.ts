/**
 * 工作目录（书库）持久化存储 —— 纯数据变换，零 Electron 依赖（可单测）。
 *
 * 持久化文件 `<共享根>/workdir.json`（多库多窗起脱离 Electron userData——Electron 的
 * userData 已随实例目录，库注册表须跨实例共享；路径解析见 workdir-controller.storePath）：
 *   { current: "/abs/path" | null, recent: [{ path, label }, ...] }
 *
 * 关联：Dev/Plans/desktop-workdir-方案.md（决策③ 多数库切换）。
 */
import { basename } from 'node:path'
import { stat as statAsync } from 'node:fs/promises'
// 路径等值判定单源——win（NTFS）与 mac（默认 APFS）卷大小写
// 不敏感，路径经启动器/手工输入/Finder 可 case-only 漂移，字符串全等会把同一书库
// 劈成两条记录（展示面污染）。samePath 已在 darwin/win32 折叠（单源）。
import { samePath } from '../fs/user-data-path.js'

interface RecentItem {
  /** 书库绝对路径 */
  path: string
  /** 展示名（目录 basename） */
  label: string
}

export interface WorkDirStore {
  /** 当前书库目录；null = 未选 */
  current: string | null
  /** 最近书库（不含 current），最多 MAX_RECENT 条 */
  recent: RecentItem[]
}

/** 最近书库列表上限（决策③）。 */
export const MAX_RECENT = 5

/** 空存储（首次启动 / 文件损坏）。每次返回新对象避免共享引用。 */
export function emptyStore(): WorkDirStore {
  return { current: null, recent: [] }
}

/** 校验一个值是否为合法 RecentItem。 */
function isRecentItem(v: unknown): v is RecentItem {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o['path'] === 'string' && typeof o['label'] === 'string'
}

/**
 * recent 候选列表的规范化单源（去重 / 剔除与 current 同库项 / 截断上限，保序）——
 * parseStore（解析容错）、setCurrent（切换重排）、rollbackStore（回滚合并）三处共用，
 * 各写一份会让「上限与判重口径」随消费点漂移。
 * 判重走 samePath（win/mac 大小写不敏感卷上 case-only 漂移的同一库不劈成两条），
 * 与 MAX_RECENT 上限同为本域对外不变量：任何写方落盘的 recent 都满足二者。
 * current 传 null = 不施加「recent 不含 current」剔除（parseStore 只做容错解析，
 * 不重排既有盘内容——盘上历史里残留的 current 同名项由下一次 setCurrent 收口）。
 */
function normalizeRecent(candidates: RecentItem[], current: string | null): RecentItem[] {
  const seen: string[] = []
  return candidates
    .filter((r) => current === null || !samePath(r.path, current))
    .filter((r) => {
      // samePath 等值判重（上限 5 条，线性扫描无规模面）
      if (seen.some((p) => samePath(p, r.path))) return false
      seen.push(r.path)
      return true
    })
    .slice(0, MAX_RECENT)
}

/**
 * 解析 workdir.json 原文为 WorkDirStore（容错）。
 * 损坏 / 缺字段 / 类型不符 → 空存储，不抛异常。
 * 判重改 samePath 等值——win/mac 大小写不敏感卷上 case-only
 * 漂移的同库双条目（如手工改写 workdir.json 或历史版本落盘的异形路径）不再双显；
 * 大小写敏感卷（linux）维持精确全等，合法异名共存不受影响。
 */
export function parseStore(raw: string): WorkDirStore {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return emptyStore()
  }
  if (typeof obj !== 'object' || obj === null) return emptyStore()
  const o = obj as Record<string, unknown>
  const current = typeof o['current'] === 'string' ? (o['current'] as string) : null
  const recentRaw = Array.isArray(o['recent']) ? o['recent'] : []
  // 非法项过滤 + 去重 + 截断走 normalizeRecent 单源（current 传 null：解析不重排内容）
  const recent = normalizeRecent(recentRaw.filter(isRecentItem), null)
  return { current, recent }
}

/**
 * 切换 current：把 newCurrent 设为当前，旧 current（若与新不同）推入 recent 头部。
 * recent 去重（按 path）、剔除等于新 current 的项、截断 MAX_RECENT。
 * 同值切换是 no-op（不把自己塞进 recent）。
 * 三处等值判定（新旧 current 比较 / recent 剔除 / 判重）改
 * samePath——win 大小写漂移下 current 与 recent 同库异形并存、切回时不剔除旧条目
 * 的展示面污染同源收口。注意 current 仍按调用方原样字串落盘（不归一化改写用户数据，
 * 物理身份判定另有 samePhysicalPath 消费面）。
 */
export function setCurrent(store: WorkDirStore, newCurrent: string): WorkDirStore {
  const oldCurrent = store.current && !samePath(store.current, newCurrent) ? store.current : null
  const candidates: RecentItem[] = [
    ...(oldCurrent ? [{ path: oldCurrent, label: basename(oldCurrent) }] : []),
    ...store.recent,
  ]
  return { current: newCurrent, recent: normalizeRecent(candidates, newCurrent) }
}

/**
 * 回滚合并（切库取消路径专用）：current 归位到快照值，recent 并入盘上「本实例不知情」的条目。
 *
 * 为什么以快照为基底而非以盘上为基底：要撤销的正是本次切换对 recent 的改动——目标库被
 * 从 recent 摘走、旧 current 被顶进 recent 头、超上限的尾项被挤掉。这些「缺失」只存在于
 * 快照里，盘上无从反推；盘上独有条目 = 他实例（同机另一库窗口，共享根 workdir.json）
 * 在「快照读取 → 本次回滚」窗口内的并发新增，必须保留。
 *
 * 次序：盘上独有条目在前、快照条目随后——独有条目是窗口内最新的写入，recent 是
 * 「最近在前」的窗口（首个元素即起点记忆锚，见 pickLibraryDefaultDir），故新者在前才与
 * 该语义一致；也正因如此，上限逼出的截断落在快照尾项（最旧）而不是他实例新增（最新）——
 * 「保留他实例新增」不因上限形同虚设。快照唯一可能被截掉的场景是「盘上另有新增且
 * 快照已满」，二者取新。
 *
 * 无并发的逐位一致性：本次切换的写盘结果里，「本实例不知情」的条目只有一项——被顶进
 * recent 头的旧 current；而它恰是本函数恢复的 current，由 normalizeRecent 剔除，
 * 故合并结果与快照逐位相等（与按快照整写零差异）。盘上就是快照本身时（本次写盘亦未
 * 发生）直接返回快照对象，逐字不重排——手改文件里 current 混在 recent 之类违反不变量的
 * 既有内容不被本函数顺手改写。
 *
 * current 只认快照：那是本次操作唯一改动的字段，盘上 current 即本次写入的新库，
 * 不作基底亦不保留。合并不变量（去重 / 不含 current / 上限 5 条）由 normalizeRecent
 * 单源兜住，不为合并放宽上限。
 */
export function rollbackStore(disk: WorkDirStore, snapshot: WorkDirStore): WorkDirStore {
  if (sameStore(disk, snapshot)) return snapshot
  // 盘上独有条目（本实例的切换不可能写出来）：他实例并发新增，或外部手改
  const added = disk.recent.filter((r) => !snapshot.recent.some((s) => samePath(s.path, r.path)))
  return {
    current: snapshot.current,
    recent: normalizeRecent([...added, ...snapshot.recent], snapshot.current),
  }
}

/** 两个 store 是否逐字相等（path 按原串比：本函数只服务「盘上就是快照」的判定，
 *  折叠大小写会把异形路径误判为同一份而跳过合并——宁可多一次合并，不可漏他方新增）。 */
function sameStore(a: WorkDirStore, b: WorkDirStore): boolean {
  return (
    a.current === b.current &&
    a.recent.length === b.recent.length &&
    a.recent.every((r, i) => r.path === b.recent[i]?.path && r.label === b.recent[i]?.label)
  )
}

/** recent 有效性预探超时哨兵（race reject 载体——stat 真实异常带 errno code，唯超时无）。 */
const RECENT_PROBE_TIMEOUT = Symbol('recent-probe-timeout')

/**
 * 「Promise.race + 超时哨兵 + finally clearTimeout」三处
 * 同型（本文件 filterValidRecentBudgeted / main.ts 拆分后 workdir-controller 的
 * probeDirReachable / lifecycle 的 flushRendererWithBudget）收敛单源——本文件零 Electron
 * 依赖可单测，故落此。超时以传入哨兵 reject 后归一为哨兵返回值（区分「超时」与「任务
 * 真实异常」——后者照抛由调用方分诊，与原三处手写 catch 内 `e === 哨兵` 判定逐位等价）；
 * race 落定即 clearTimeout（计时器卫生收编于此）。
 */
export async function raceWithTimeout<T, S extends symbol>(
  task: Promise<T>,
  timeoutMs: number,
  timeoutSentinel: S,
): Promise<T | S> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutSentinel), timeoutMs)
      }),
    ])
  } catch (e) {
    if (e === timeoutSentinel) return timeoutSentinel
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 单条预探默认预算（ms）；调用方（main.ts bootstrap）注入 CLW_BOOTSTRAP_PROBE_TIMEOUT_MS 口径。 */
const RECENT_PROBE_DEFAULT_TIMEOUT_MS = 2_000

/** 预探注入形态（默认 node:fs/promises stat；测试注入挂起/失败形态）。 */
export type StatLike = (p: string) => Promise<{ isDirectory(): boolean }>

/**
 * 过滤掉 recent 中已失效的项 —— 启动时清理一次（current 失效不在本函数处理，由调用方
 * 决定是否弹选择器重选）。
 * 目录有效性判定含 isDirectory——existsSync 对「同路径普通文件」
 * 也为 true：书库目录被同名文件顶替（误删后重建/解压残留）时该 recent 项不再可用，
 * 却原样保留 → 点击切换后链路把文件路径当书库目录用。
 * 同步 existsSync+statSync 改
 * 「fs/promises stat + 超时预算」——原实现逐条同步 stat，recent 残留失联网络卷
 * （NAS/SMB 挂载点在而服务器无响应）时启动首读同步冻主进程数十秒（/
 * -1 反复修复的同一冻结族，readStore 首读入口漏网——probeDirReachable 防线只护
 * current/cwd）。三态分诊（probeDirReachable 同款口径）：
 *   stat 通过且 isDirectory → 保留；确定性快速失败（ENOENT/EACCES/ENOTDIR 等）→ 剔除
 *   （原语义不变，判定窗口内被删/权限按无效处理，不裸抛破坏容错契约）；
 *   超时（失联卷挂死面）→ 跳过判定保留展示——失联不等于失效，择库守卫另有预探拦截
 * 兜底「残留只污展示面不产行为错」取舍口径不变。
 * 逐条独立预算并行探测（recent ≤ MAX_RECENT 条，并行后总预算 = 单条预算，不串行放大
 * 启动延迟）；返回新对象，保序过滤。
 */
export async function filterValidRecentBudgeted(
  store: WorkDirStore,
  opts?: { timeoutMs?: number; stat?: StatLike },
): Promise<WorkDirStore> {
  const timeoutMs = opts?.timeoutMs ?? RECENT_PROBE_DEFAULT_TIMEOUT_MS
  const stat = opts?.stat ?? statAsync
  const verdicts = await Promise.all(
    store.recent.map(async (r) => {
      try {
        const s = await raceWithTimeout(stat(r.path), timeoutMs, RECENT_PROBE_TIMEOUT)
        // 超时保留（失联≠失效）；stat 通过交 isDirectory 判定
        return s === RECENT_PROBE_TIMEOUT ? true : s.isDirectory()
      } catch {
        // 确定性失败剔除（原语义：判定窗口内被删/权限按无效处理，不裸抛破坏容错契约）
        return false
      }
    }),
  )
  return { current: store.current, recent: store.recent.filter((_, i) => verdicts[i]) }
}

/** 序列化为 workdir.json 文本（pretty + 尾换行）。 */
export function serializeStore(store: WorkDirStore): string {
  return JSON.stringify(store, null, 2) + '\n'
}

// ── 预探熔断（进程级短期熔断）────────────────────────────

/**
 * 探测熔断器：键（探测目标路径）→ 最近一次「探不通」的时刻。
 *
 * 只收「超时」这一态——超时意味着底层 stat 请求仍挂在线程池里（放弃等待≠取消请求），
 * 在失联网络卷上每次交互都新增一个挂死请求：libuv 线程池（默认 4 线程）被占满后，
 * 全部 fs 异步调用（含日志 appendFile）排队冻结，与该预探「不冻主进程」的目的相反。
 * 熔断把「每次交互各挂一个」收敛为「每个窗口至多一个」：窗口内直接判探不通，不再发
 * 起新的底层探测。确定性失败（ENOENT/EACCES 等）立即落定、无残留请求，故不与熔断。
 *
 * 键 = 调用方给出的路径原文，刻意不做归一化（不 resolve、不折叠大小写）：
 * 归一化在失联卷上不提高准确性，却把「同一目录的不同书写形」并成一键——一旦折叠口径
 * 与物理卷不符（如大小写敏感卷上仅大小写异名的两个合法目录），健康库会被同一键误判为
 * 不可达。保守方向 = 宁可多探几次，也不误判。故失联卷上最坏代价是「每个被独立探测的
 * 路径各挂一个」，仍远小于按次累积。
 *
 * 窗口由调用方按「多久算恢复」定档（长窗口 = 挂死请求更少、但卷恢复后拒绝更久）；
 * ttlMs 取 getter、now 可注入——测试用注入时钟推进窗口，不真等。
 * 表容量封顶并逐出最旧键：键来自用户交互路径（含目录选择器，路径不受调用方控制），
 * 窗口内活跃键数已天然有界，封顶只为兜住无界增长；被逐出的键退化为「下次照常真探」，
 * 不影响任何判定结果（无非是少一次熔断）。
 */
export interface ReachabilityBreaker {
  /** 该键是否在窗口内已判定探不通（真 = 不再发起底层探测）。窗口过期即失效。 */
  isOpen(key: string): boolean
  /** 记一次「探不通」（仅超时形态），自此刻起开窗。 */
  trip(key: string): void
}

/** 熔断键表容量上限（见 ReachabilityBreaker 头注：只兜无界增长，非常态容量）。 */
const BREAKER_MAX_KEYS = 32

export function createReachabilityBreaker(opts: {
  /** 熔断窗口毫秒（getter：生产接常量档，测试可直接给固定值）。 */
  ttlMs: () => number
  /** 时钟源（测试注入用）。 */
  now?: () => number
  /** 键表容量上限；缺省 BREAKER_MAX_KEYS。 */
  maxKeys?: number
}): ReachabilityBreaker {
  const now = opts.now ?? Date.now
  const maxKeys = opts.maxKeys ?? BREAKER_MAX_KEYS
  const trippedAt = new Map<string, number>()
  return {
    isOpen(key: string): boolean {
      const at = trippedAt.get(key)
      if (at === undefined) return false
      if (now() - at < opts.ttlMs()) return true
      trippedAt.delete(key) // 窗口过期即落表——表只留窗口内存活键
      return false
    },
    trip(key: string): void {
      const t = now()
      for (const [k, at] of trippedAt) {
        if (t - at >= opts.ttlMs()) trippedAt.delete(k)
      }
      // 先删后插把该键移到表尾：逐出按最旧插入序，重探（刷新窗口）不应因旧位序被先逐出
      trippedAt.delete(key)
      trippedAt.set(key, t)
      while (trippedAt.size > maxKeys) {
        const oldest = trippedAt.keys().next().value
        if (oldest === undefined) break
        trippedAt.delete(oldest)
      }
    },
  }
}
