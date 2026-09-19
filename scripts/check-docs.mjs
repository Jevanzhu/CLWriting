#!/usr/bin/env node
/**
 * 文档篇幅门（docs-surface）：防「废话回弹」——索引面短小、介绍面对外、明细归 git 历史。
 *
 * 背景（2026-09-19 作者指令「也要保证后续不会塞废话进去」+「根目录 README 只是项目介绍，
 * 不要把项目进展什么的塞进去」）：精简前四件分别为 4.0K / 46.2K / 2.6K / 6.9K，其中根
 * README 的开发段是单个 32KB 行——历代 L2 亲跑实录（逐批文件/过数/跳/败 + 九门明细 +
 * 差值锚沿革 + CI 跑红根因复盘）全堆在里面。此前只靠 CLAUDE.md「记档」条的自律，两日即
 * 回弹；正如 check-counts 的 X-P2-16 先例（对账自律 → 升级门禁），本门把篇幅纪律升级为
 * 机器门。
 *
 * 两个面，口径不同：
 * - **索引面**（治理/索引文档）：只写结论 + 指针，不装明细。
 * - **介绍面**（根 README）：对外介绍（是什么/怎么装/怎么跑/技术栈/许可证），
 *   **禁一切项目进展**——批级实录、沿革、修复记、跑红复盘、锚号都不属于它。
 *   仅放行机器门依赖的稳定口径数字（check:counts 从本文件抓声称值）。
 *
 * 三档口径（均为上限，宽松留白——只拦堆砌，不拦正常写作）：
 * 1. 单行长度：超长行即红（长实录行的直接指纹）。
 * 2. 文件体积：各件独立上限（按精简后实测值 + 留白拟定，非紧贴）。
 * 3. 禁止短语：实录链/进展记的独特签名出现即红。
 *
 * 豁免：表格行（`|` 开头）、代码块围栏内、纯 URL 行——天然长而合法。行内代码与
 * 块引用的极端长行不豁免（那正是旧实录的形态）。
 *
 * 用法：npm run check:docs（退出码 1 = 超限，列出违规行与实测值供修）。
 * 纯函数 export，直测见 test/scripts/check-docs.test.ts。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// ─ 索引面清单与上限 ─────────────────────────────────────────────────
// 实测单行最长（2026-09-19 精简后）= CLAUDE 589 / 总览 486 / DD-README 220。
export const INDEX_FILES = [
  { path: 'CLAUDE.md', maxLine: 700, maxBytes: 6000, label: 'CLAUDE.md（治理正本）' },
  { path: 'Dev/Docs/README.md', maxLine: 400, maxBytes: 3000, label: 'Dev/Docs/README.md' },
  {
    path: 'Dev/Docs/00-总览与实施路线-2026-08-15.md',
    maxLine: 700,
    maxBytes: 6000,
    label: '总览（00-总览与实施路线）',
  },
]

// ─ 介绍面清单与上限 ─────────────────────────────────────────────────
// 根 README = 对外门面：项目是什么 / 怎么装 / 怎么跑 / 技术栈 / 许可证。
// 实测精简后 14.6K（含徽章、命令块、介绍长句），上限留白至 20K。
export const INTRO_FILES = [
  { path: 'README.md', maxLine: 1400, maxBytes: 20000, label: '根 README.md（对外介绍面）' },
]

// ── 实录链签名短语（出现即红，两个面通用）────────────────────────────
// 旧实录的独特语料：只有「把历批跑门日志堆进文档」才会写出这些串。正常行文不会用到。
// 注意：门槛段旧口径句「过数实测差 68 恒定」曾是 check-counts 分账依赖串，静态口径批
//（vitest 5 升级，阶段 39）后 check-counts 不再解析该句、README 已删——本表仍只禁其
// 沿革扩展形态（差值锚重锚明细语料），退役裸句不回填禁表（防误伤历史引用行文）。
export const FORBIDDEN_PHRASES = [
  { phrase: '实测差 68 恒定〔', why: '平台门差值的沿革实录链（差值锚重锚明细）应归 git 历史' },
  { phrase: '前锚 **', why: '差值锚重锚沿革（「前锚」链）应归 git 历史' },
  { phrase: '九门全绿 =', why: '逐批 L2 九门明细应归 commit message / 报告正本' },
  { phrase: '批记 = `Archive/README.md`', why: 'Archive README 已撤除；批记随 commit message' },
  { phrase: '实跑实录（前史）', why: '逐批实跑实录链应归 git 历史' },
  { phrase: '本批徽章', why: '徽章修账实录应归 git 历史' },
]

// ── 介绍面专禁短语（项目进展进对外门面）──────────────────────────────
// 作者指令「根目录 README 只是项目介绍，不要把项目进展什么的塞进去」。
export const FORBIDDEN_INTRO_PHRASES = [
  { phrase: '亲跑实录', why: '跑门实录属于批级明细（commit message / 报告正本）' },
  { phrase: '九门', why: 'L2 九门明细属于批级明细' },
  { phrase: '修复批', why: '批级修复记不属于对外介绍' },
  { phrase: '重评', why: '历轮评审沿革不属于对外介绍' },
  { phrase: '作者拍板', why: '决策过程不属于对外介绍' },
  { phrase: '差值锚', why: '测试口径沿革不属于对外介绍' },
  { phrase: '复原锚', why: '文档治理沿革不属于对外介绍' },
  { phrase: 'git show', why: 'git 复原锚不属于对外介绍' },
  { phrase: '台账', why: '内部治理术语不属于对外介绍' },
  { phrase: '批记', why: '批记链不属于对外介绍' },
]

/**
 * 行是否豁免长度检查：表格行 / 代码块围栏 / 纯 URL 行。
 */
export function isExemptLine(line) {
  const t = line.trim()
  if (t.startsWith('|')) return true
  if (t.startsWith('```')) return true
  if (/^https?:\/\/\S+$/.test(t)) return true
  return false
}

/** 找超长行（跳过表格/围栏/URL 行）。返回 [{ line, length, preview }]。 */
export function findLongLines(content, maxLine) {
  const hits = []
  const lines = content.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (isExemptLine(line)) continue
    if (line.length > maxLine) {
      hits.push({ line: i + 1, length: line.length, preview: line.slice(0, 80) })
    }
  }
  return hits
}

/** 命中的禁止短语（含行号）。返回 [{ phrase, why, line, preview }]。 */
export function forbiddenPhrasesIn(content, list = FORBIDDEN_PHRASES) {
  const hits = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const { phrase, why } of list) {
      if (lines[i].includes(phrase)) {
        hits.push({ phrase, why, line: i + 1, preview: lines[i].slice(0, 80) })
      }
    }
  }
  return hits
}

// ─ 修订日期标注（索引面禁）─────────────────────────────────────────
// 作者指令：「为什么一定要加修订日期之类的……特别是 CLAUDE.md，不是记录文档，是规则！」
// 规则/索引文档写的是「现在是什么规矩」，不是「哪批改的」——批号与日期正本 = git 历史
// （blame 一查即得）。文件名内的日期（`…-2026-08-15.md`）是命名要素，放行；只禁**括号
// 标注形态**「（2026-09-19 …）」「（2026-09-19）」这类挂在条目上的修订日期。
const DATE_ANNOTATION_RE = /[（(]\s*\d{4}-\d{2}-\d{2}\s*[)）]|[（(]\s*\d{4}-\d{2}-\d{2}\s+[^)）]{0,40}[)）]/

/** 命中的括号日期标注（含行号与原文）。返回 [{ line, text, preview }]。 */
export function findDateAnnotations(content) {
  const hits = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DATE_ANNOTATION_RE)
    if (m) hits.push({ line: i + 1, text: m[0], preview: lines[i].slice(0, 80) })
  }
  return hits
}

/**
 * 校验一份文档。list = 该面适用的禁止短语表。返回人话问题串数组（空 = 通过）。
 * dateAnnotations=true 时额外禁括号修订日期标注（索引面规则文档专用）。
 */
export function checkDocSurface(content, spec, list = FORBIDDEN_PHRASES, dateAnnotations = false) {
  const problems = []
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > spec.maxBytes) {
    problems.push(
      `${spec.label}：体积 ${bytes} 字节超上限 ${spec.maxBytes}（只写结论 + 指针，明细归 git 历史/报告正本）。`,
    )
  }
  for (const h of findLongLines(content, spec.maxLine)) {
    problems.push(
      `${spec.label}:${h.line}：单行 ${h.length} 字符超上限 ${spec.maxLine}（长实录行的典型指纹——请压成「一句 + 锚」或移出）。行首：${h.preview}…`,
    )
  }
  for (const h of forbiddenPhrasesIn(content, list)) {
    problems.push(`${spec.label}:${h.line}：命中禁止短语「${h.phrase}」——${h.why}。行首：${h.preview}…`)
  }
  if (dateAnnotations) {
    for (const h of findDateAnnotations(content)) {
      problems.push(
        `${spec.label}:${h.line}：命中括号修订日期标注「${h.text}」——规则/索引文档写「现在是什么规矩」，不写「哪批改的」（日期与沿革正本 = git 历史）。行首：${h.preview}…`,
      )
    }
  }
  return problems
}

/** 索引面校验（结论 + 指针面；禁实录链与括号修订日期）。 */
export function checkDocsIndex(content, spec) {
  return checkDocSurface(content, spec, FORBIDDEN_PHRASES, true)
}

/** 介绍面校验（对外门面，禁项目进展）。 */
export function checkIntroDoc(content, spec) {
  return checkDocSurface(content, spec, [...FORBIDDEN_PHRASES, ...FORBIDDEN_INTRO_PHRASES])
}

export function main() {
  const mismatch = []
  const surfaces = [
    { files: INDEX_FILES, check: checkDocsIndex },
    { files: INTRO_FILES, check: checkIntroDoc },
  ]
  for (const { files, check } of surfaces) {
    for (const spec of files) {
      let content
      try {
        content = readFileSync(`${root}${spec.path}`, 'utf8')
      } catch {
        mismatch.push(`${spec.label}：文件不存在（${spec.path}）——清单需随文档结构变更同步。`)
        continue
      }
      mismatch.push(...check(content, spec))
    }
  }
  if (mismatch.length) {
    console.error('文档篇幅门未过（docs-surface）：索引面只写结论 + 指针；根 README 是对外介绍面，禁项目进展。')
    for (const m of mismatch) console.error(`  • ${m}`)
    console.error('  修法：实录/沿革/批记压成「一句结论 + git 锚」，明细移入 commit message 或报告本体。')
    process.exit(1)
  }
  console.log('check:docs 通过：索引面三件与介绍面一篇篇幅、禁语均合规。')
}

// 直跑判据走 pathToFileURL——argv[1] 可能是相对路径（`node scripts/check-docs.mjs`），
// 裸拼 `file://${argv[1]}` 与之不等，main() 会静默不执行（门形同虚设）。
if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
