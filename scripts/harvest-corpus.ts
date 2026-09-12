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
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename, relative } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { readBookConfig } from '../src/format/yaml.js'
import { atomicWriteFile } from '../src/fs/atomic.js'
import { applyGlobalDefaults } from '../src/format/global-defaults.js'
import { readChapterDir } from '../src/format/chapters.js'
import { readManifest } from '../src/document/manifest.js'
import { listVersions, readVersion, VERSIONS_DIR_NAME } from '../src/document/version.js'
import { runAllChecks } from '../src/check/runner.js'
// R51-J-1（五十一轮）：simile-density 的锚改用引擎同款正则直扫正文（message 只报
// 次数不带命中文本，文案解析提不出锚）——单一真相源，防两处正则漂移
import { SIMILE_RE } from '../src/check/count.js'
import { rebuild } from '../src/cache/rebuild.js'
import { DEFAULT_IMAGERY_WORDS } from '../src/check/imagery-seed.js'
import { bodyOf } from '../src/format/frontmatter-core.js'

// 重评-26（全库代码重评审 2026-09-05）：入参此前只验 existsSync 不验目录——误传
// 文件路径时校验放行，readBookConfig(join(bookRoot, 'book.yaml')) 以文件为根拼路径
// 裸栈 ENOENT 崩穿。改 statSync + isDirectory 校验，失败打人话 usage 后 fail-closed
// 退出（exit 1，口径同 corpus-commit.ts / check-knowledge.ts 的显式报错出口）。
const bookRoot = process.argv[2]
if (!bookRoot) {
  console.error('用法：npx tsx scripts/harvest-corpus.ts <bookRoot>')
  console.error('  <bookRoot>：书目录路径（含 book.yaml 的目录），不是文件。')
  process.exit(1)
}
if (!existsSync(bookRoot) || !statSync(bookRoot).isDirectory()) {
  console.error(`[harvest-corpus] 错误：<bookRoot> 不是存在的目录：${bookRoot}`)
  console.error('用法：npx tsx scripts/harvest-corpus.ts <bookRoot>（指向含 book.yaml 的书目录）')
  process.exit(1)
}

// R48-69（四十八轮）：人话守卫——book.yaml 缺失/损坏此前静默回落默认配置继续跑
//（收割面口径无声漂移），同目录脚本均有人话守卫口径
const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
if (!cfgResult.ok) {
  console.error(`book.yaml 不可用（${cfgResult.error.message}）——语料收割依赖书级配置（账本启用类等），请先补齐 book.yaml 后重试`)
  process.exit(1)
}
const config = applyGlobalDefaults(cfgResult.config, null)
const hasWiring = existsSync(join(bookRoot, '布线'))

// 有布线的书需要 db（账本检查）——rebuild 一次拿现行索引
let db: DatabaseSync | null = null
// R0912-3（2026-09-12 全量重评 #42）：清单缺失早退旗标——原 process.exit(1) 在 try 内
// 硬退、绕过 finally{db?.close()}（R71-34「db 由 finally 统一收口」不变量该路径不成立；
// 进程即退无实害，仍按纪律修）。改「置旗标 → break 出 try（finally 照跑）→ 收口后再
// exit(1)」：退出码与「不进产出段」（不覆盖写候选文件）语义均不变。
let manifestMissing = false

/** 命中词提取（R51-J-1 五十一轮重写，原 quotedOf）：message 里的「」/『』/“”引号
 *  片段（禁词/意象等检查项带）+ 「词×N」形态（身体部位/比喻堆砌类：`眼睛×6`）。
 *  与引擎 message 模板的两处漂移修复：
 *  ① 截断前缀模板（style-sentence-overlong「前16字…」/style-parallel-streak「前缀…」）：
 *     省略号在引号内，finalBody.includes(带…锚) 恒 false → 恒判「被改掉」。剥尾部
 *     省略号后用前缀作锚（头缀幸存即计幸存的确定性采样口径）。
 *  ② simile-density 的「像…」是模板字面量（message 只报次数）→ 改用引擎同款
 *     SIMILE_RE 直扫被检正文取真实比喻短语作锚（结构化关键词优先于文案解析），
 *     去重后逐短语判定。
 *  另：剥省略号后退化为单字的锚（如未来模板再漂移出「X…」字面量）不可用——
 *  includes 恒真会灌水幸存统计，丢弃之；合法的单字引号锚（无省略号）不受影响。 */
function keywordsOf(item: { checkId: string; message: string }, body: string): string[] {
  if (item.checkId === 'simile-density') {
    return [...new Set([...body.matchAll(SIMILE_RE)].map((m) => m[0]))]
  }
  const out: string[] = []
  for (const m of item.message.matchAll(/[「『“]([^」』”]{1,40})[」』”]/g)) {
    const raw = m[1]!
    const stripped = raw.replace(/(?:…+|\.{3})$/u, '')
    if (stripped !== raw && [...stripped.trim()].length < 2) continue
    out.push(stripped)
  }
  for (const m of item.message.matchAll(/([\u4e00-\u9fffA-Za-z0-9·]{1,20})×\d+/g)) out.push(m[1]!)
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
// R51-J-1：无锚命中计数（checkId → 条数）——repeat 等统计类消息无锚文本属已知
// 形态；修复前静默零候选（采集面「候选 0 条」无从归因），现末尾人话告警。
// 不设退出码哨兵：结构上无锚的检查项本就不参与幸存者判定，与 R63-14/R34D-31
// 的「收割不完整」失败哨兵不同级。
const unanchoredByCheck = new Map<string, number>()
/** imagery 种子误报统计：短语 → {survived, removed} */
const imageryStats = new Map<string, { survived: number; removed: number }>()
// R63-14：单版快照失败计数与首错（catch-all 不再零告警——产出段统一告警）
let failedSnapshots = 0
let firstSnapshotError: string | null = null
// R30-29（三十轮）：章级解析失败不再被解构丢弃——聚合为批级清单，末尾 warn 汇总
// （书名/章名/原因）+ 结果统计带 failedChapters 计数。此前章级失败静默跳过，
// 系统性故障会以「候选 0 条」成功口径收场（对比 src/learn/index.ts 的显式报错口径）
const failedChapters: Array<{ file: string; line: number; message: string }> = []

harvestScan: try {
  // R71-34（总七十一轮）：rebuild/开库移入 try/finally——此前在 try 外，BEGIN busy/
  // 磁盘故障裸栈崩穿（不走 finally 收尾）；db 由 finally 统一 close
  if (hasWiring) {
    const cachePath = join(bookRoot, '.cache', 'index.db')
    rebuild(bookRoot, cachePath)
    db = new DatabaseSync(cachePath, { readOnly: true })
  }
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  // R48-69（四十八轮）：清单缺失人话守卫——此前 readManifest 容错空表默默零候选，
  // 「候选 0 条」假成功无从归因
  if (!existsSync(manifestPath)) {
    console.error(`文档清单缺失（${manifestPath}）——请先在应用中打开一次本书生成清单后重试`)
    manifestMissing = true
    break harvestScan
  }
  const manifest = readManifest(manifestPath)
  const versionsDir = join(bookRoot, '工作区', VERSIONS_DIR_NAME)
  // R30-29（三十轮）：errors 并入批级 failedChapters（原 `const { chapters } = …` 把
  // 章级解析失败静默丢弃）
  const { chapters, errors: chapterErrors } = readChapterDir(join(bookRoot, '写作', '正文'))
  failedChapters.push(...chapterErrors)
  // manifest 路径 → docId 一次建索引（原每章全量扫 entries，O(章×条目)）
  const docIdByPath = new Map<string, string>()
  for (const [id, e] of manifest.entries) {
    if (e.nodeType === 'document') docIdByPath.set(e.path, id)
  }

  for (const ch of chapters) {
    if (!ch._path) continue
    const relPath = relative(bookRoot, ch._path).split('\\').join('/')
    const docId = docIdByPath.get(relPath)
    if (!docId) continue
    const versions = existsSync(versionsDir) ? listVersions(versionsDir, docId) : []
    // 幸存者基准 = 最后一次定稿内容（pinned finalize 版本，新的在前取首个）——正文
    // 文件是「当前草稿」，定稿后继续写会让基准漂移（草稿又改丢 ≠ 作者否定命中）；
    // 从未定稿 → 现行文件即最近内容，退化为原口径
    let finalBody: string | null = null
    for (const v of versions) {
      const fr = readVersion(versionsDir, docId, v.id)
      if (fr?.meta.pinned && fr.meta.origin === 'finalize') {
        // R71-34：剥 fm 统一走 bodyOf（frontmatter-core，BOM/CRLF 口径）——替代手写正则
        finalBody = bodyOf(fr.content)
        break
      }
    }
    // 重评2-P3-5（2026-09-09 全量重评 GLM-5.3，scripts 域 P3-③）：现行正文兜底读位于
    // 「只有 finally 无 catch」的外层 try 内——章文件在 readChapterDir 列目与本处读取
    // 之间被并发移走/瞬删（TOCTOU）时 ENOENT 裸栈崩穿整次收割（同文件单版快照判定
    // R63-14 已配同款守卫，此处漏配）。补 catch 对齐 R63-14「计数 + 首错 + 产出段
    // 人话告警」口径：本章跳过继续收割（同 R63-14「跳过不中断」语义），复用
    // failedSnapshots/firstSnapshotError 承载（首错单槽、部分失败 exitCode=1 哨兵
    // 按既有口径不变），末尾告警文案随计数面同步扩为「快照/基准正文」。
    // 修复批二段（主审复核）：`if (finalBody === null)` 守卫必须保留——初版漏挂条件
    // 致 pinned 锚定基准被现行正文无条件覆盖，「定稿后再改正文不改变判定」失守
    // （corpus-domain 幸存者基准用例红即此因）。守卫保留还使有锚定章免读现行文件，
    // 本条 TOCTOU 面同步收窄。
    if (finalBody === null) {
      try {
        finalBody = bodyOf(readFileSync(ch._path, 'utf8'))
      } catch (e) {
        if (firstSnapshotError === null) {
          firstSnapshotError = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)
        }
        failedSnapshots++
        continue
      }
    }
    for (const v of versions) {
      const r = readVersion(versionsDir, docId, v.id)
      if (!r || !r.content.trim()) continue
      // R71-34：机检输入与幸存者基准统一剥 fm——此前被检文本带 fm 而基准剥了，
      // fm 独有命中词（章号/标题等元数据）会被误判「定稿仍出现 ⇒ 幸存（误报候选）」
      const checkedBody = bodyOf(r.content)
      try {
        const report = runAllChecks({
          ...(db ? { db } : {}),
          bookRoot,
          config,
          chapter: ch,
          body: checkedBody,
          fileName: basename(ch._path),
        })
        for (const item of report.sections.flatMap((s) => s.items)) {
          // R51-J-1：提取不到锚点的命中按 checkId 计数（末尾人话告警），不再静默
          const kws = keywordsOf(item, checkedBody)
          if (kws.length === 0) {
            unanchoredByCheck.set(item.checkId, (unanchoredByCheck.get(item.checkId) ?? 0) + 1)
            continue
          }
          for (const kw of kws) {
            if (!kw.trim()) continue
            const survived = finalBody.includes(kw)
            candidates.push({
              checkId: item.checkId,
              chapter: ch.章号,
              keyword: kw,
              verdict: survived ? '幸存（定稿未改，大概率误报）' : '被改掉（作者认可命中）',
              excerpt: excerptAround(checkedBody, kw),
              versionId: v.id,
              versionOrigin: r.meta.origin,
            })
            // imagery 种子短语误报率（同短语同章多版本去重：每版本各计一次口径，
            // 统计的是「检查器叫了多少次、作者认了多少次」）。R50-F-1（五十轮）：
            // checkId 对齐生产侧 count.ts 实际产出的 'imagery-overuse'——原比对
            // 'imagery' 恒不匹配，误报率统计表永为「无 imagery 命中样本」空表
            if (item.checkId === 'imagery-overuse' && (DEFAULT_IMAGERY_WORDS as readonly string[]).includes(kw)) {
              const s = imageryStats.get(kw) ?? { survived: 0, removed: 0 }
              if (survived) s.survived++
              else s.removed++
              imageryStats.set(kw, s)
            }
          }
        }
      } catch (e) {
        // R63-14：单版快照失败不再零告警吞掉——系统性失败（如 db 打不开）会让全书
        // 版本静默跳过且以成功口径打印「候选 0 条」；此处记首错+计数，产出段统一告警
        if (firstSnapshotError === null) {
          firstSnapshotError = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)
        }
        failedSnapshots++
      }
    }
  }
} finally {
  db?.close()
}
// R0912-3（#42）：finally 收口 db 后再硬退（退出码 1 与原早退一致；此处退出保证
// 清单缺失时不进下方产出段——空候选覆盖写会清掉作者既有候选清单）
if (manifestMissing) process.exit(1)

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
  atomicWriteFile(join(outDir, file), lines.join('\n') + '\n')
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
  atomicWriteFile(join(outDir, '误报率统计.md'), lines.join('\n') + '\n')
}

console.log(
  `[harvest-corpus] 章快照判定完成：误报候选 ${candidates.filter((c) => c.verdict.startsWith('幸存')).length} 条、命中候选 ${candidates.filter((c) => c.verdict.startsWith('被改')).length} 条${failedChapters.length > 0 ? `、章级解析失败 ${failedChapters.length} 章` : ''} → ${outDir}`,
)

// R63-14：快照失败不再静默——首错 + 计数随成功口径一并打印（系统性失败时
// 「候选 0 条」有了排障入口，而不是被当成真的没有候选）
// 重评2-P3-5：计数面扩入现行基准正文兜底读失败（见循环内注）——文案同步，
// 容错/退出码口径仍 R63-14（部分失败不静默成功，exitCode=1）
if (failedSnapshots > 0 && firstSnapshotError !== null) {
  console.error(`[harvest-corpus] 警告：${failedSnapshots} 个版本快照/基准正文判定失败被跳过（首错如下，若为系统性失败请先修复再采信候选数）`)
  console.error(firstSnapshotError)
  process.exitCode = 1
}

// R30-29（三十轮）：章级解析失败汇总——书名/章名/原因逐条留痕（0 失败时输出
// 逐位不变，成功路径零扰动；计数已并入上方结果统计）
if (failedChapters.length > 0) {
  console.warn(`[harvest-corpus] 警告：${failedChapters.length} 个章节解析失败被跳过（书：${basename(bookRoot)}）`)
  for (const err of failedChapters) {
    console.warn(`  - 章 ${basename(err.file)}（行 ${err.line}）：${err.message}`)
  }
  // R34D-31（三十四轮）：章级失败补退出码哨兵——与上方快照失败路径（R63-14 设 1）
  // 口径统一。此前只 warn 不设 exitCode=1，收割部分失败仍绿（R30-29 修一半），
  // 脚本出口的调用方（作者/CI）无法以退出码感知「候选集不完整」
  process.exitCode = 1
}

// R51-J-1：无锚命中人话告警——repeat 等统计类消息无锚文本，修复前静默零候选；
// 名单化后「哪些 checkId 没进幸存者判定」可归因（意外 checkId 出现 = 模板口径
// 又漂移了，核对 count.ts 的 message 模板）。不设退出码：无锚检查项本就不参与
// 幸存者判定，与上方「收割不完整」失败哨兵不同级。
if (unanchoredByCheck.size > 0) {
  const total = [...unanchoredByCheck.values()].reduce((a, b) => a + b, 0)
  const parts = [...unanchoredByCheck.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, n]) => `${id}×${n}`)
    .join('、')
  console.warn(`[harvest-corpus] 警告：${total} 个机检命中提取不到关键词锚点，未参与幸存者判定（${parts}）——统计类消息无锚文本属已知形态，意外 checkId 请核对 count.ts message 模板口径`)
}
