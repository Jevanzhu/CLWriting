#!/usr/bin/env node
/**
 * B2（批 6，P5-①）：存量书自举标注语料——幸存者判定（确定性、零 token）。
 *
 * 用法：npx tsx scripts/harvest-corpus.ts <bookRoot>
 *
 * 数据源 = 工作区/.版本/ 章快照（AI 稿版本档案）+ 定稿正文 + 现行机检：
 * 对每章各版快照跑机检，按 checkId 对齐命中词（message 引号片段）——
 *   命中词在定稿正文仍出现 ⇒ 作者看了没改 ⇒ 误报候选（expect: silent）
 *   命中词被改写消失 ⇒ 作者认可命中 ⇒ 命中候选（expect: fire）
 * 同款判定技术先例：src/ai/author-signal.ts（保存时 diff 规则命中）。
 *
 * 产出（候选制——作者勾选后 npm run corpus:commit 固化为仓库用例）：
 *   工作区/语料候选/误报候选.md / 命中候选.md（`- [ ]` 勾选行）
 *   工作区/语料候选/误报率统计.md（imagery-seed 种子短语误报率，>30% 列剔除候选）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename, relative } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { readBookConfig } from '../src/format/yaml.js'
import { applyGlobalDefaults } from '../src/format/global-defaults.js'
import { readChapterDir } from '../src/format/chapters.js'
import { readManifest } from '../src/document/manifest.js'
import { listVersions, readVersion, VERSIONS_DIR_NAME } from '../src/document/version.js'
import { runAllChecks } from '../src/check/runner.js'
import { rebuild } from '../src/cache/rebuild.js'
import { DEFAULT_IMAGERY_WORDS } from '../src/check/imagery-seed.js'

const bookRoot = process.argv[2]
if (!bookRoot || !existsSync(bookRoot)) {
  console.error('用法：npx tsx scripts/harvest-corpus.ts <bookRoot>')
  process.exit(1)
}

const config = applyGlobalDefaults(readBookConfig(join(bookRoot, 'book.yaml')).config, null)
const hasWiring = existsSync(join(bookRoot, '布线'))

// 有布线的书需要 db（账本检查）——rebuild 一次拿现行索引
let db: DatabaseSync | null = null
if (hasWiring) {
  const cachePath = join(bookRoot, '.cache', 'index.db')
  rebuild(bookRoot, cachePath)
  db = new DatabaseSync(cachePath, { readOnly: true })
}

/** 命中词提取：message 里的「」/『』/“”引号片段（禁词/意象/复读等检查项带）
 *  + 「词×N」形态（身体部位/比喻等堆砌类 message：`眼睛×6`）。两形态都覆盖，
 *  摘录与幸存者判定才有锚点。 */
function quotedOf(message: string): string[] {
  const out: string[] = []
  for (const m of message.matchAll(/[「『“]([^」』”]{1,40})[」』”]/g)) out.push(m[1]!)
  for (const m of message.matchAll(/([\u4e00-\u9fffA-Za-z0-9·]{1,20})×\d+/g)) out.push(m[1]!)
  return out
}

function excerptAround(body: string, kw: string): string {
  const idx = body.indexOf(kw)
  if (idx < 0) return body.slice(0, 200)
  const start = Math.max(0, idx - 50)
  const excerpt = body.slice(start, Math.min(body.length, idx + kw.length + 50))
  return excerpt.length > 200 ? excerpt.slice(0, 200) : excerpt
}

interface Candidate {
  checkId: string
  chapter: number
  keyword: string
  verdict: '幸存（定稿未改，大概率误报）' | '被改掉（作者认可命中）'
  excerpt: string
  versionId: string
  versionOrigin: string
}

const candidates: Candidate[] = []
/** imagery 种子误报统计：短语 → {survived, removed} */
const imageryStats = new Map<string, { survived: number; removed: number }>()

try {
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const versionsDir = join(bookRoot, '工作区', VERSIONS_DIR_NAME)
  const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))

  for (const ch of chapters) {
    if (!ch._path) continue
    const relPath = relative(bookRoot, ch._path).split('\\').join('/')
    let docId: string | null = null
    for (const [id, e] of manifest.entries) {
      if (e.nodeType === 'document' && e.path === relPath) {
        docId = id
        break
      }
    }
    if (!docId) continue
    const finalBody = readFileSync(ch._path, 'utf8').replace(/^---[\s\S]*?---\n?/, '')
    const versions = existsSync(versionsDir) ? listVersions(versionsDir, docId) : []
    for (const v of versions) {
      const r = readVersion(versionsDir, docId, v.id)
      if (!r || !r.content.trim()) continue
      try {
        const report = runAllChecks({
          ...(db ? { db } : {}),
          bookRoot,
          config,
          chapter: ch,
          body: r.content,
          fileName: basename(ch._path),
        })
        for (const item of report.sections.flatMap((s) => s.items)) {
          for (const kw of quotedOf(item.message)) {
            if (!kw.trim()) continue
            const survived = finalBody.includes(kw)
            candidates.push({
              checkId: item.checkId,
              chapter: ch.章号,
              keyword: kw,
              verdict: survived ? '幸存（定稿未改，大概率误报）' : '被改掉（作者认可命中）',
              excerpt: excerptAround(r.content, kw),
              versionId: v.id,
              versionOrigin: r.meta.origin,
            })
            // imagery 种子短语误报率（同短语同章多版本去重：每版本各计一次口径，
            // 统计的是「检查器叫了多少次、作者认了多少次」）
            if (item.checkId === 'imagery' && (DEFAULT_IMAGERY_WORDS as readonly string[]).includes(kw)) {
              const s = imageryStats.get(kw) ?? { survived: 0, removed: 0 }
              if (survived) s.survived++
              else s.removed++
              imageryStats.set(kw, s)
            }
          }
        }
      } catch {
        /* 单版快照解析失败跳过（不阻断全书） */
      }
    }
  }
} finally {
  db?.close()
}

// ── 产出（候选制：作者勾选 [x] 后 npm run corpus:commit 入库）──────────
const outDir = join(bookRoot, '工作区', '语料候选')
mkdirSync(outDir, { recursive: true })

function writeCandidates(file: string, title: string, want: Candidate['verdict']): void {
  const list = candidates.filter((c) => c.verdict === want)
  const lines = [`# ${title}（${list.length} 条）`, '', '> 勾选（`[ ]` → `[x]`）后运行 `npm run corpus:commit` 固化为仓库回归用例。', '']
  const byCheck = new Map<string, Candidate[]>()
  for (const c of list) {
    const arr = byCheck.get(c.checkId) ?? []
    arr.push(c)
    byCheck.set(c.checkId, arr)
  }
  for (const checkId of [...byCheck.keys()].sort()) {
    lines.push(`### checkId: ${checkId}`)
    for (const c of byCheck.get(checkId)!) {
      lines.push(
        `- [ ] 章号 ${c.chapter} ｜ 判定：${want === '幸存（定稿未改，大概率误报）' ? '幸存' : '改掉'} ｜ 摘录：${JSON.stringify(c.excerpt)}（版本 ${c.versionId} / ${c.versionOrigin}）`,
      )
    }
    lines.push('')
  }
  writeFileSync(join(outDir, file), lines.join('\n') + '\n')
}

writeCandidates('误报候选.md', '误报候选（命中区间在定稿幸存）', '幸存（定稿未改，大概率误报）')
writeCandidates('命中候选.md', '命中候选（被作者改写消失）', '被改掉（作者认可命中）')

// imagery 种子误报率统计（B3 前置：>30% 列入剔除候选）
{
  const lines = ['# imagery 种子误报率统计', '', '| 种子短语 | 叫了（版本命中） | 作者改掉 | 误报率 | 建议 |', '|---|---|---|---|---|']
  const phrases = [...imageryStats.keys()].sort()
  for (const p of phrases) {
    const s = imageryStats.get(p)!
    const total = s.survived + s.removed
    const rate = total > 0 ? s.survived / total : 0
    lines.push(`| ${p} | ${total} | ${s.removed} | ${(rate * 100).toFixed(0)}% | ${rate > 0.3 ? '**>30%，列入剔除候选（改 imagery-seed.ts 走人工提交 + 回归门）**' : '保留' } |`)
  }
  if (phrases.length === 0) lines.push('|（无 imagery 命中样本）| | | | |')
  writeFileSync(join(outDir, '误报率统计.md'), lines.join('\n') + '\n')
}

console.log(
  `[harvest-corpus] 章快照判定完成：误报候选 ${candidates.filter((c) => c.verdict.startsWith('幸存')).length} 条、命中候选 ${candidates.filter((c) => c.verdict.startsWith('被改')).length} 条 → ${outDir}`,
)
