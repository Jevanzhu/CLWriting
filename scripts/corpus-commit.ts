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
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
// R73-50（二十一轮）：语料 JSON 落盘走原子写原语（同目录 tmp + rename）——写中途被杀
// 不得留半截文件（checkId.json 是 CI 回归门 corpus.test.ts 的输入，截断即门挂）
import { atomicWriteFile } from '../src/fs/atomic.js'

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
let rejectedCheckIds = 0
function parseFile(fp: string, expect: Entry['expect']): ParsedLine[] {
  if (!existsSync(fp)) return []
  const out: ParsedLine[] = []
  let checkId = ''
  for (const line of readFileSync(fp, 'utf8').split('\n')) {
    const h = /^### checkId:\s*(\S+)\s*$/.exec(line)
    if (h) {
      // R63-13：checkId 直接 join 进写出路径——含路径段（/ \ 或 ..）即路径穿越，
      // 手编候选 md 的 `### checkId: ../../evil` 会逃出 corpusDir，拒绝入库
      // R33-96（三十三轮）：win 上 `:` 等非法字符与保留设备名（con/nul/aux/prn/com1..lpt9，
      // 含扩展名同样保留）会让 <checkId>.json 落盘 EINVAL/ENOENT 崩脚本——统一拒绝
      // R35-12（三十五轮）：字符类补 `\\`（原 `[\/\]` 里 `\]` 是转义的 `]`、`\` 恰漏网——
      // win 上 `a\b` 的 `\` 是分隔符，atomicWriteFile 建子目录落盘而语料门非递归装载
      // 永远看不到该文件）；保留设备名改按 / \ 切分后的每个路径分量判定（整串判定
      // 可被 `sub\CON` 形态绕过）
      const id = h[1]!
      const reservedDevice = id
        .split(/[\\/]/)
        .some((part) => /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(part.split('.')[0]!))
      if (/[\\/]|[<>:"|?*]|\.\./.test(id) || reservedDevice) {
        console.error(`[corpus:commit] checkId 含路径段/非法字符（/ \ .. : < > " | ? *）或为保留设备名，拒绝入库：${id}`)
        rejectedCheckIds++
        checkId = ''
      } else {
        checkId = id
      }
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
  // R34D-6（三十四轮）：空集早退不得绕过尾部退出码哨兵——此前此处无条件 exit(0)，
  // 「勾选行全部摘录解析失败（droppedExcerpts>0）或全部落在被拒 checkId 节下」时
  // 以退出码 0 收场：语料门入库端假成功（作者以为入库了，CI 回归门实则零新增且
  // 无任何告警口径）。真没勾才退出 0；勾了但全军覆没按尾部哨兵（见文件尾 R63-13/
  // R63-11/R64-36 同款）标红退出 1——语料门 fail-closed
  if (rejectedCheckIds > 0 || droppedExcerpts > 0) {
    console.error(
      `[corpus:commit] 未完全成功：${rejectedCheckIds} 个 checkId 被拒（路径穿越）＋ ${droppedExcerpts} 行勾选摘录解析被丢——0 条入库（见上方逐条告警），修复候选 md 后重跑`,
    )
    process.exit(1)
  }
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
let failedExisting = 0
for (const [checkId, entries] of byCheck) {
  const fp = join(corpusDir, `${checkId}.json`)
  let existing: Entry[] = []
  if (existsSync(fp)) {
    try {
      existing = JSON.parse(readFileSync(fp, 'utf8')) as Entry[]
    } catch {
      // R63-11：存量解析失败不得按空数组整写覆盖（= 静默清空既有回归门条目）。
      // 跳过该 checkId 合并、原文件保持原样，作者手工修档后重跑
      console.error(`[corpus:commit] 存量语料解析失败，跳过合并（原文件保持原样）：${fp}`)
      failedExisting++
      continue
    }
  }
  // 按 excerpt 去重合并（后到覆盖先到——重标以最近一次为准）
  const merged = new Map(existing.map((e) => [e.excerpt, e] as const))
  for (const e of entries) merged.set(e.excerpt, e)
  const final = [...merged.values()]
  atomicWriteFile(fp, JSON.stringify(final, null, 2) + '\n') // R73-50：原子替换，防半截 JSON
  written++
  console.log(`[corpus:commit] ${fp} ← ${final.length} 条`) // R62-55：打实际 fp，自定义 corpusDir 不误导
}
console.log(`[corpus:commit] 完成：${all.length} 条入库（${written} 个检查器），CI 回归门（corpus.test.ts）即刻生效`)
// R63-13/R63-11/R64-36：拒绝/跳过/丢条不静默——有效条目照常入库，但退出码标红让作者看见告警
if (rejectedCheckIds > 0 || failedExisting > 0 || droppedExcerpts > 0) {
  console.error(
    `[corpus:commit] 未完全成功：${rejectedCheckIds} 个 checkId 被拒（路径穿越）＋ ${failedExisting} 个存量文件解析失败被跳过＋ ${droppedExcerpts} 行勾选摘录解析被丢——见上方逐条告警`,
  )
  process.exitCode = 1
}
