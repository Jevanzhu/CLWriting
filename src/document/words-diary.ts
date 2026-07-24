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
  const lines = readFileSync(fp, 'utf-8').split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]!) as DailyBaseline
      if (rec.date === date) return rec.baseline
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
