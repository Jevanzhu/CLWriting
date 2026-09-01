/**
 * 字数日记（§5.4 今日字数基线方案）。
 *
 * 每日一条 { date, baseline } append 到 `项目/字数日记.jsonl`。
 * 「今日字数」= 当前已写 − 今日基线；每日首次打开记当日「已写」为基线。
 * 参考 metrics/ledger.ts 的 jsonl 模式（appendFileSync + '\n'）。
 *
 * 精度限制（§5.4）：跨零点写作 / 一天多次多端打开时基线有偏差，基线方案可接受。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  let sum = 0
  let found = false
  for (const line of lines) {
    if (!line) continue
    try {
      const rec = JSON.parse(line) as { date?: unknown; delta?: unknown }
      if (rec.date === date && typeof rec.delta === 'number') {
        sum += rec.delta
        found = true
      }
    } catch {
      // 跳过坏行（baseline 条目无 delta 字段，parse 成功但 delta undefined → 跳过）
    }
  }
  return found ? sum : null
}
