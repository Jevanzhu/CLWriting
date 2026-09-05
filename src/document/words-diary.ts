/**
 * 字数日记（§5.4 今日字数基线方案）。
 *
 * 每日一条 { date, baseline } append 到 `项目/字数日记.jsonl`。
 * 「今日字数」= 当前已写 − 今日基线；每日首次打开记当日「已写」为基线。
 * 参考 metrics/ledger.ts 的 jsonl 模式（appendFileSync + '\n'）。
 *
 * 精度限制（§5.4）：跨零点写作 / 一天多次多端打开时基线有偏差，基线方案可接受。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tryAcquireCrossProcessLock } from '../fs/cross-process-lock.js'
import { atomicWriteFile } from '../fs/atomic.js'

/** 字数日记路径：`项目/字数日记.jsonl`。 */
export function wordsDiaryPath(bookRoot: string): string {
  return join(bookRoot, '项目', '字数日记.jsonl')
}

interface DailyBaseline {
  date: string
  baseline: number
}

/**
 * 读某日基线（jsonl 倒序找首条匹配 date；无则 null）。
 * 一日多条（多端打开）→ 取最后一条（最近记录）。
 */
export function readBaseline(bookRoot: string, date: string): number | null {
  const fp = wordsDiaryPath(bookRoot)
  if (!existsSync(fp)) return null
  let lines: string[]
  try {
    lines = readFileSync(fp, 'utf-8').split('\n').filter(Boolean)
  } catch {
    // P5-数据层（第七轮）：读失败（EACCES/EISDIR）降级无基线（与缺文件同口径）——
    // 原先裸抛，documents 端点直接 500
    return null
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]!) as DailyBaseline
      // R34D-13（三十四轮）：命中须**同为基线条目**（typeof baseline === 'number'）——
      // E4 起 delta 条目与 baseline 条目共存同一 jsonl，真实时序「晨基线 → 日间 delta」
      // 下倒序首个同日命中是 delta 行（无 baseline 字段），原实现命中即返回 rec.baseline
      // （undefined）违背 number | null 契约，当日二次 GET 恒 undefined。收紧后 delta 行
      // continue 落到更早行，找到当日真正的基线条目；全无基线条目仍返 null。
      if (rec.date === date && typeof rec.baseline === 'number') return rec.baseline
    } catch {
      // 跳过坏行
    }
  }
  return null
}

/** 记某日基线（append 一行；mkdir 防 `项目/` 不存在）。 */
export function appendBaseline(bookRoot: string, date: string, baseline: number): void {
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  appendFileSync(wordsDiaryPath(bookRoot), JSON.stringify({ date, baseline }) + '\n', 'utf-8')
  // PM-5（性能与内存专项）：每日首次写基线是天然低频时机——顺带检查跨日压缩
  //（append 在前：基线先落盘，压缩 best-effort 失败不反噬本行）。
  maybeCompactWordsDiary(bookRoot, date)
}

/** 今日日期（本地时区，YYYY-MM-DD）。 */
export function todayDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ── E4：今日字数精确增量（每次 save settled 记 delta，当日累加）───

/** 单次保存的字数增量条目（与 baseline 条目共存于同一 jsonl，靠 delta 字段区分）。 */
interface WordsDeltaEntry {
  date: string
  delta: number
  ts: string
  docId?: string
}

/**
 * 记一次保存的字数增量（save settled 时调）。
 * delta 可正可负（删减内容）；append 一行到 `项目/字数日记.jsonl`。
 *
 * R73-45（二十一轮·裁定维持不加锁）：appendFileSync 以 O_APPEND 语义打开——单次
 * write() 的「定位 + 写入」内核级原子，双进程并发 append 最多乱序、不会行内交错或
 * 互相覆盖（本条目序列化后 < 200 字节，远低于任何文件系统的原子写上限）；唯一损失
 * 形态是崩溃半写截断末行，读侧（readBaseline/readTodayDelta）逐行容错跳过坏行，
 * 单行损失仅影响当日字数统计的个位精度——统计口径本就是「今日字数基线方案」的近似
 * （§5.4 精度限制已认）。加锁反而给每次保存平添一次锁文件创建/删除开销。
 */
export function appendWordsDelta(
  bookRoot: string,
  date: string,
  delta: number,
  docId?: string,
): void {
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  const entry: WordsDeltaEntry = { date, delta, ts: new Date().toISOString() }
  if (docId) entry.docId = docId
  appendFileSync(wordsDiaryPath(bookRoot), JSON.stringify(entry) + '\n', 'utf-8')
}

/**
 * 读今日累计字数增量（sum 当日所有 delta 条目）。
 * 无 delta 条目（旧书未走过新链路 / 当日无保存）→ null，调用方回退 baseline 方案。
 * 跨零点按 settle 时刻（条目 ts 当日 date）归日，天然正确。
 */
export function readTodayDelta(bookRoot: string, date: string): number | null {
  const fp = wordsDiaryPath(bookRoot)
  if (!existsSync(fp)) return null
  let lines: string[]
  try {
    lines = readFileSync(fp, 'utf-8').split('\n')
  } catch {
    // P5-数据层（第七轮）：读失败降级无增量（与缺文件同口径，baseline 方案兜底）
    return null
  }
  // R47-25（四十七轮）：倒序扫描——本文件只 append（appendBaseline/appendWordsDelta），
  // 行按日期 append 序：从尾部累计目标日期行、遇首条「日期 < 目标日」的完好行即停
  //（更早日期块开始，目标日行已扫尽）——O(当日行数)，不再逐行 parse 全部历史
  //（readBaseline 同文件倒序先例）。日期 > 目标日的行（历史日期查询时尾部的更新行）
  // 跳过不停扫——返回值语义与正序全量求和逐位一致（既有「跨日归日」用例锚定：文件
  // 尾是 07-24 行时查 07-23 仍须穿透累计）。坏行容错保持：parse 失败（崩溃半写截断
  // 等）与无 date 字段的外来行照旧跳过。日期乱序的外部改写不在本文件写入口径内
  //（见文件头 §5.4 精度限制）。
  let sum = 0
  let found = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    try {
      const rec = JSON.parse(line) as { date?: unknown; delta?: unknown }
      if (typeof rec.date === 'string') {
        if (rec.date === date) {
          if (typeof rec.delta === 'number') {
            sum += rec.delta
            found = true
          }
        } else if (rec.date < date) {
          // 首条更早日期的完好行 → 目标日块已扫完，停（日期串 YYYY-MM-DD 字典序即时间序）
          return found ? sum : null
        }
        // rec.date > date：目标日之后写入的更新行——跳过继续（正序版同款不计入）
      }
      // 无 date 字段的外来/损坏行：容错跳过（正序版同款跳过语义）
    } catch {
      // 跳过坏行（baseline 条目无 delta 字段，parse 成功但 delta undefined → 跳过）
    }
  }
  return found ? sum : null
}

// ── PM-5（性能与内存专项）：跨日 compaction ───────────────────────

/**
 * PM-5：字数日记 compact 阈值（字节数）。append-only jsonl 每日 1 条 baseline +
 * 每次 settled 保存 1 条 delta，长年写作无界膨胀；读侧倒序短路（R47-25）已把
 * parse 循环收敛到 O(当日)，但 readFileSync 全文件 + split('\n') 的固定成本随
 * 文件线性变贵。超此值时在 appendBaseline（每日首条基线，低频时机）触发跨日
 * 压缩：历史日归并为每日至多两行，文件大小封顶在「历史日数 × 2 行 + 当日行」。
 */
export const WORDS_DIARY_COMPACT_BYTES = 1024 * 1024

/** 生效值（模块内可变）：初值 = 常量；仅注入钩子可改（journal R30-18 先例——
 *  export let 可被任一 import 方静默改写，改 const + 内部可变生效值，生产恒用常量）。 */
let wordsDiaryCompactBytes = WORDS_DIARY_COMPACT_BYTES

/** 测试注入钩子（生产零调用）。 */
export function __setWordsDiaryCompactBytesForTest(bytes: number): void {
  wordsDiaryCompactBytes = bytes
}

/** 历史日的归组累计。docId 已核实无任何读方依赖（readBaseline 只读 date/baseline、
 *  readTodayDelta 只读 date/delta，全仓仅 documents.ts 调这两个函数；docId 是
 *  write-only 审计字段），压缩行省略之。 */
interface CompactedDay {
  /** 该日最后一条 baseline 行的值（typeof number 才计；无则 undefined → 省略该行）。 */
  baseline: number | undefined
  /** 该日是否出现过 delta 行（typeof number 才计）——与「deltaSum 是否有效」独立
   *  （末条 delta 可能缺 ts 字段，ts 可为 undefined 但行仍须产出）。 */
  hasDelta: boolean
  deltaSum: number
  /** 该日最后一条 delta 行的 ts（该行缺 ts 字段则 undefined → 输出行省略 ts）。 */
  lastDeltaTs: string | undefined
}

/** 压缩循环里的宽松行形态（字段 typeof 逐一校验后才使用）。 */
type RawDiaryRow = { date?: unknown; baseline?: unknown; delta?: unknown; ts?: unknown }

/**
 * PM-5：计算压缩后的整文件文本（纯函数，便于推理与测试锚定）。语义：
 * - 历史行（date 严格早于 today，字典序比较——YYYY-MM-DD 与 readTodayDelta 的
 *   `<` 停扫同口径）按日期升序归组，每日至多两行：`{date, baseline}`（该日最后
 *   一条基线）+ `{date, delta: 当日 delta 之和, ts: 当日最后一条 delta 的 ts}`。
 * - 今日/未来行原样保留（理论上无未来行，防御保留），维持原相对顺序。
 * - 坏行（JSON.parse 失败 / 无 date 字段）原样移至文件尾部（不丢弃，保审计）。
 * - 空 split 段（空行）丢弃——两读函数本就过滤空行。
 * - 带 date 但 baseline/delta 均非 number 的行：归组两分支均不命中 → 该行自然
 *   消失——readBaseline / readTodayDelta 对此类行本就跳过（R47-25 语义），读侧等价。
 *
 * 读侧逐位等价论证（对 append 序 = 日期序的真实文件）：产物保持「历史块（日期
 * 升序，每日 baseline 行在 delta 行前）→ 今日/未来行 → 坏行」的日期单调序，
 * readTodayDelta 倒序停扫依赖的序不变量不变；坏行 parse 必败，位置后移不改变
 * 两读函数的跳过语义。日期乱序的外部改写不在口径内（与 R47-25 同款限定）。
 */
function compactWordsDiaryText(text: string, today: string): string {
  const days = new Map<string, CompactedDay>()
  const tail: string[] = [] // 今日/未来行（原样、原相对顺序）
  const bad: string[] = [] // 坏行（原样，移尾部）
  for (const raw of text.split('\n')) {
    if (!raw) continue
    let rec: RawDiaryRow
    try {
      rec = JSON.parse(raw) as RawDiaryRow
    } catch {
      bad.push(raw)
      continue
    }
    if (typeof rec.date !== 'string') {
      bad.push(raw)
      continue
    }
    if (rec.date >= today) {
      tail.push(raw)
      continue
    }
    let day = days.get(rec.date)
    if (!day) {
      day = { baseline: undefined, hasDelta: false, deltaSum: 0, lastDeltaTs: undefined }
      days.set(rec.date, day)
    }
    if (typeof rec.baseline === 'number') day.baseline = rec.baseline // 后行覆盖前行 = 该日最后一条
    if (typeof rec.delta === 'number') {
      day.hasDelta = true
      day.deltaSum += rec.delta
      day.lastDeltaTs = typeof rec.ts === 'string' ? rec.ts : undefined
    }
  }
  const out: string[] = []
  for (const date of [...days.keys()].sort()) {
    // 日期串字典序即时间序（与读侧比较同口径），保证产物仍是日期升序 append 序
    const day = days.get(date)!
    if (day.baseline !== undefined) out.push(JSON.stringify({ date, baseline: day.baseline }))
    if (day.hasDelta) {
      // ts: undefined 时 JSON.stringify 自然省略该键（末条 delta 缺 ts 字段的形态）
      out.push(JSON.stringify({ date, delta: day.deltaSum, ts: day.lastDeltaTs }))
    }
  }
  out.push(...tail)
  out.push(...bad)
  return out.length > 0 ? out.join('\n') + '\n' : ''
}

/**
 * PM-5：超阈值时压缩字数日记（appendBaseline 后触发，best-effort——任何异常吞掉，
 * 不影响基线写入主路径，下次触发再试）。
 *
 * 并发口径照 journal maybeCompactJournal 先例（N4）：append 侧不加锁维持 R73-45
 * O_APPEND 原子裁定；compact 侧非阻塞占锁（拿不到直接弃本轮）+ 锁内基线 stat →
 * 读算 → rename 前重 stat 复核（size/mtime 任变 = 读算期间他进程有 append →
 * 放弃本轮，新行随原文件完整保留）。原子写 fsync: true 同 journal compact。
 * 残余窗口 = 复核 stat 与 rename 之间的 µs 级（与 journal N4 同级，如实记档）：
 * 该窗内他进程 append 的行会被 rename 整文件替换吞掉，最坏损失当日一条 delta
 * （读侧逐行容错、§5.4 统计口径本为近似），且触发点是每日首基线的低频时刻。
 */
function maybeCompactWordsDiary(bookRoot: string, today: string): void {
  try {
    const fp = wordsDiaryPath(bookRoot)
    if (!existsSync(fp)) return
    if (statSync(fp).size < wordsDiaryCompactBytes) return
    // 非阻塞占锁（best-effort：拿不到直接弃本轮）
    const release = tryAcquireCrossProcessLock(`${fp}.lock`)
    if (!release) return
    try {
      // 锁内基线 stat（N4：等锁期间他进程的合法 append 不误判为压缩窗口内变化）
      const before = statSync(fp)
      if (before.size < wordsDiaryCompactBytes) return
      const compacted = compactWordsDiaryText(readFileSync(fp, 'utf-8'), today)
      // rename 前重 stat 复核——读算期间若被他进程追加新行（size 变 = 有新行），
      // 放弃本轮压缩，新行随原文件完整保留
      const after = statSync(fp)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return
      atomicWriteFile(fp, compacted, { fsync: true })
    } finally {
      release()
    }
  } catch {
    // best-effort：压缩失败不影响 appendBaseline 主路径，下次触发再试
  }
}
