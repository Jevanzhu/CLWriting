#!/usr/bin/env node
/**
 * B2（批 6）：语料候选入库——把作者勾选（[x]）的候选固化为仓库回归用例。
 *
 * 用法：npm run corpus:commit [-- <bookRoot>]
 * 读 <bookRoot>/工作区/语料候选/{误报候选,命中候选}.md 的 `- [x]` 行 →
 * 追加/合并到 test/corpus/checks/<checkId>.json（形如 [{excerpt, expect}]），
 * expect：误报=silent（回归门断言不再命中）、命中=fire（断言仍命中）。
 * 合并去重按 excerpt 全文；入库即进 CI（test/check/corpus.test.ts）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const bookRoot = process.argv[2] ?? '.'
// 第二可选参：语料输出目录（缺省仓库 test/corpus/checks；测试传 tmp 隔离）
const corpusDir = process.argv[3] ?? join('test', 'corpus', 'checks')

interface Entry {
  excerpt: string
  expect: 'fire' | 'silent'
}

interface ParsedLine {
  checkId: string
  excerpt: string
  expect: Entry['expect']
}

/** 解析候选 md：### checkId: <id> 分节 + `- [x] 章号 N ｜ 判定：… ｜ 摘录："…"（…）` */
let droppedExcerpts = 0
function parseFile(fp: string, expect: Entry['expect']): ParsedLine[] {
  if (!existsSync(fp)) return []
  const out: ParsedLine[] = []
  let checkId = ''
  for (const line of readFileSync(fp, 'utf8').split('\n')) {
    const h = /^### checkId:\s*(\S+)\s*$/.exec(line)
    if (h) {
      checkId = h[1]!
      continue
    }
    if (!checkId) continue
    // R62-24：非贪婪 `(".+?")（` 遇摘录内转义引号邻接 `（` 会提前收口（截断 →
    // JSON.parse 失败 → catch 静默丢条，作者勾选条目不入库且无告警）。改贪婪
    // `(".*")（` 取末个 `"`+`（`（摘录闭合引号后跟的 `（` 必为末个），摘录 JSON
    // 全文进 m[1]——含内层转义引号也完整进串。
    const m = /^- \[x\].*摘录：(".*")（/.exec(line)
    if (!m) continue
    try {
      const excerpt = JSON.parse(m[1]!) as string
      if (excerpt.trim()) out.push({ checkId, excerpt, expect })
    } catch {
      // R62-24：手写/畸形摘录行——此前静默跳过；改为显式 warn（不再无告警丢条）
      droppedExcerpts++
      console.warn(`[corpus:commit] 摘录行未被解析（JSON 格式异常，已跳过不入库）：${line}`)
    }
  }
  return out
}

const falsePos = parseFile(join(bookRoot, '工作区', '语料候选', '误报候选.md'), 'silent')
const hits = parseFile(join(bookRoot, '工作区', '语料候选', '命中候选.md'), 'fire')
const all = [...falsePos, ...hits]
if (droppedExcerpts > 0) {
  console.warn(`[corpus:commit] ${droppedExcerpts} 行勾选条目未被解析（见上方逐行警告）——修复候选 md 后再提交，否则静默丢条`)
}
if (all.length === 0) {
  console.log('[corpus:commit] 无勾选条目（在 工作区/语料候选/*.md 把 `[ ]` 改 `[x]` 后重跑）')
  process.exit(0)
}

mkdirSync(corpusDir, { recursive: true })
const byCheck = new Map<string, Entry[]>()
for (const e of all) {
  const arr = byCheck.get(e.checkId) ?? []
  arr.push({ excerpt: e.excerpt, expect: e.expect })
  byCheck.set(e.checkId, arr)
}

let written = 0
for (const [checkId, entries] of byCheck) {
  const fp = join(corpusDir, `${checkId}.json`)
  let existing: Entry[] = []
  if (existsSync(fp)) {
    try {
      existing = JSON.parse(readFileSync(fp, 'utf8')) as Entry[]
    } catch {
      existing = []
    }
  }
  // 按 excerpt 去重合并（后到覆盖先到——重标以最近一次为准）
  const merged = new Map(existing.map((e) => [e.excerpt, e] as const))
  for (const e of entries) merged.set(e.excerpt, e)
  const final = [...merged.values()]
  writeFileSync(fp, JSON.stringify(final, null, 2) + '\n')
  written++
  console.log(`[corpus:commit] ${fp} ← ${final.length} 条`) // R62-55：打实际 fp，自定义 corpusDir 不误导
}
console.log(`[corpus:commit] 完成：${all.length} 条入库（${written} 个检查器），CI 回归门（corpus.test.ts）即刻生效`)
