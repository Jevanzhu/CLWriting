#!/usr/bin/env node
/**
 * 源码注释门（comment-surface）：注释只留约束、不变量、平台差与语义说明——修复史归 git。
 *
 * 背景（质量债 P3-1「注释考古化」）：批号标签曾是注释主体（评审度量：全库注释 28.8%、
 * 带标注释行 7484 行 / 标签 11098 个），现行契约要从修复叙事里打捞，且行号引用、悬空
 * 路径、过时状态已开始腐烂。本门仿 check:docs 先例，把「注释不写修复史」从纪律升级为
 * 机器门：源码注释中出现批号标签形态即红，防止清理后回弹。
 *
 * 扫描范围：`src/**`（含 `src/studio/web-next/src/**`）+ 根构建配置四件
 * （tsup / vitest / eslint / playwright config）。排除 node_modules、`*.d.ts`。
 * `test/` 不入门——测试文件头注释留批次号是纪律允许形态（CLAUDE.md 测试分层）。
 *
 * 标签形态（按全库实测标定，均为「只可能是批号 / 轮次 / 评审史」的高置信形态）：
 * - R 系批号：`R40`、`R68-3`、`R51-C-3`、`R34D-19`、`R0916-7-P3-3`、`R1a`、`R-5`
 * - 小写 r 系：`r0912`、`r30`（多为旧测试文件名残留引用，同样算腐烂）
 * - 质量债 ID：`P3`、`P2-1`（域前缀形态 `CC-P2-3`、`Z-P2-4` 由尾部 P 系命中）
 * - 专项系列：`PM-10`；`X-P1-3` 由 P 系尾部命中
 * - 轮次：`第 5 轮`、`第六十轮`、括注 `（三十七轮）`
 * - 批次括注：`（批 5）`
 * - 日期戳：`2026-09-11`、`2026年9月`
 * - 评审过程词：`复审`、`重审`
 * - 单字母域号：`A-6`、`N-10`、`T5`、`Q2`、`D3`、`B5`（全库实测全部为旧修复批域号，
 *   无合法术语撞形；UTF-8 / SHA-256 / MD5 / GB2312 等字母对因词边界不在射程）
 * - 已知豁免术语：`V8`（引擎名）、`K8s`——真实技术术语，显式例外表放行
 *
 * 字符串字面量零误报：扫描器是逐字符状态机（字符串 / 模板串含 ${} 嵌套 / 正则字面量 /
 * .vue 模板 HTML 注释 / CSS url 裸 URL），字符串内容里的 `R40`、`//` 一律不进注释判定
 * ——清理只动注释、绝不碰生产字面量（此前有误删字面量的事故，本门是该红线的机器化）。
 *
 * allowlist（承重锚注）：若某注释被测试 readFileSync 源码断言钉住（删改即测试红），
 * 在 ANCHOR_ALLOWLIST 登记「文件 + 行内容子串 + 钉住它的测试」放行。开工盘点
 * （方法：全量 test/ 中 readFileSync 读 src 的断言字面量反查注释行）结论：当前零批号
 * 锚注——原「R43-8（四十三轮）」类锚已随测试资产行为化移除，R40 静态锚全部改钉代码
 * 形态——故本表启动为空；机制与直测在位，日后发现承重锚注在此登记，不在注释里续命。
 *
 * 用法：npm run check:comments（退出码 1 = 命中，列出文件:行 + 形态 + 原文供修）。
 * 纯函数 export，直测见 test/scripts/check-comments.test.ts。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * 扫描的根配置文件（构建配置同病：构建期注释曾数倍于代码）。
 * prettier.config.mjs 同属根配置面——工具链配置的注释同样只该写约束与取值依据。
 */
export const ROOT_CONFIG_FILES = [
  'tsup.config.ts',
  'vitest.config.ts',
  'eslint.config.js',
  'prettier.config.mjs',
  'playwright.config.ts',
]

/** 扫描的源码扩展名；`.d.ts` 排除（环境声明非叙述面）。 */
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.vue', '.js', '.mjs', '.cjs'])

/** 豁免目录名（任意层级）。 */
const EXCLUDED_DIRS = new Set(['node_modules'])

/**
 * 标签形态表。re 必须带 g 旗（matchAll 消费）；每命中一处算一个 hit。
 * 不收编全部历史域号 token 的原因：门防的是回弹，只需收未来注释里「只可能是批号」
 * 的形态——单字母域号两形经全库实测零合法撞形，已收录。
 */
export const TAG_PATTERNS = [
  { name: 'R系批号', re: /\bR-?\d{1,4}[A-Za-z]?(?:-[A-Za-z0-9]+)*/g, why: '修复批号叙事应归 commit message' },
  { name: 'r系批号', re: /\br\d{2,4}(?:-[A-Za-z0-9]+)*/g, why: '旧测试名/批号残留引用应改指现行名或删除' },
  { name: '质量债ID', re: /\bP[123](?:-\d+)*/g, why: '质量债编号叙事应归报告正本 / commit message' },
  { name: 'PM专项', re: /\bPM-\d+\b/g, why: '专项审查项编号应归报告正本' },
  { name: '域前缀债ID', re: /\b[A-Z]{1,5}(?:-[A-Za-z]{1,8})?-P[123](?:-\d+)*/g, why: '域内质量债编号应归报告正本' },
  { name: '单字母域号-横', re: /\b[A-Z]-\d{1,3}(?:-[A-Za-z0-9]+)*/g, why: '旧修复批域号叙事应归 commit message' },
  { name: '单字母域号', re: /\b[A-Z]\d(?![\dA-Za-z])(?:-[A-Za-z0-9]+)*/g, why: '旧修复批域号叙事应归 commit message' },
  // 多字母-数字形态（UTF-8 / GLM-5.3 / X11）合法术语密度高，不设形态——DSH-18 类条目号
  // 仅个位数存量，靠清理批次移除；门只防高频回弹形态。
  { name: '轮次', re: /第\s*[零一二三四五六七八九十百\d]+\s*轮/g, why: '轮次叙事应归 commit message' },
  { name: '括注轮次', re: /[（(]\s*[零一二三四五六七八九十百]+\s*轮\s*[）)]/g, why: '轮次叙事应归 commit message' },
  { name: '批次括注', re: /[（(]\s*批\s*[\dA-Za-z]{1,3}\s*[）)]/g, why: '批次叙事应归 commit message' },
  { name: '日期戳', re: /\b20\d{2}-\d{1,2}-\d{1,2}\b|20\d{2}\s*年/g, why: '修订日期应归 git 历史（blame 可查）' },
  { name: '评审过程词', re: /复审|重审/g, why: '评审沿革叙事应归报告正本' },
]

/** 真实技术术语豁免（形态撞上单字母域号，但属正常术语）。 */
export const TOKEN_EXCEPTIONS = new Set(['V8', 'K8s'])

/**
 * 承重锚注 allowlist：被测试源码断言钉住、不得删改的注释。
 * file = 相对仓库根或相对 src/ 的路径（按路径后缀匹配）；contains = 注释行内的原文子串；
 * why = 钉住它的测试文件。命中行满足 file + contains 即放行。
 */
export const ANCHOR_ALLOWLIST = []

// 正则字面量起判位置：上一有效符号在这些字符后、或上一完整词是这些关键字时，
// `/` 开正则态而非除法。（`return /re/` vs `a / b` 的经典歧义启发式。）
const REGEX_AFTER = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
  '\n',
])
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'do',
  'else',
  'yield',
  'await',
  'instanceof',
])

/**
 * 逐字符状态机：抽出每行的注释片段。字符串 / 模板串 / 正则字面量内容一律不算注释。
 * 返回 [{ line, col, endCol, text }]——text = 该行注释区域原文（不含换行），
 * col/endCol = 该行内注释起止列；无注释的行不出现。ext = '.vue' 时启用 HTML 注释态。
 */
export function extractCommentLines(text, ext = '.ts') {
  const out = []
  const n = text.length
  let i = 0
  let line = 1
  // 注释态：'line' | 'block' | 'html' | null
  let mode = null
  let regionStart = -1 // 注释区域起始偏移（全文）
  let regionLine = -1
  // 模板串栈：'tpl'（模板文本段）| 'interp'（${} 内代码段）
  const stack = []
  let braceDepth = 0
  let prevSig = ''
  let prevWord = ''

  const isWordCh = (c) => /[A-Za-z0-9_$]/.test(c)

  const lineStartOf = (idx) => {
    const nl = text.lastIndexOf('\n', idx - 1)
    return nl + 1
  }

  // 注释区域 [regionStart, endIdx) 按行拆片登记
  const pushRegion = (endIdx) => {
    let segStart = regionStart
    let segLine = regionLine
    while (segStart < endIdx) {
      const nl = text.indexOf('\n', segStart)
      const segEnd = nl === -1 || nl >= endIdx ? endIdx : nl
      const col = segStart - lineStartOf(segStart)
      out.push({ line: segLine, col, endCol: segEnd - lineStartOf(segStart), text: text.slice(segStart, segEnd) })
      if (nl === -1 || nl >= endIdx) break
      segStart = nl + 1
      segLine++
    }
  }

  while (i < n) {
    const c = text[i]
    const next = i + 1 < n ? text[i + 1] : ''

    if (c === '\n') {
      if (mode === 'line') {
        pushRegion(i)
        mode = null
        regionStart = -1
      }
      line++
      i++
      continue
    }

    if (mode === 'line' || mode === 'block' || mode === 'html') {
      if (mode === 'block' && c === '*' && next === '/') {
        pushRegion(i + 2)
        mode = null
        regionStart = -1
        prevSig = '/'
        prevWord = ''
        i += 2
        continue
      }
      if (mode === 'html' && c === '-' && next === '-' && text[i + 2] === '>') {
        pushRegion(i + 3)
        mode = null
        regionStart = -1
        prevSig = '>'
        prevWord = ''
        i += 3
        continue
      }
      i++
      continue
    }

    // ── 模板文本态（先于一切代码态分支——闭合反引号 / 引号 / ${} 都归它管）──
    if (stack.length && stack[stack.length - 1] === 'tpl') {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '$' && next === '{') {
        stack.push('interp')
        braceDepth = 0
        prevSig = '{'
        prevWord = ''
        i += 2
        continue
      }
      if (c === '`') {
        stack.pop()
        prevSig = '`'
        prevWord = ''
        i++
        continue
      }
      i++
      continue
    }

    // ── 代码 / 字符串 / 正则态（含 ${} 插值内的代码）──
    if (c === "'" || c === '"') {
      const quote = c
      i++
      while (i < n && text[i] !== quote && text[i] !== '\n') {
        if (text[i] === '\\') i++
        i++
      }
      if (text[i] === quote) i++
      prevSig = quote
      prevWord = ''
      continue
    }
    if (c === '`') {
      stack.push('tpl')
      i++
      continue
    }
    if (c === '}' && braceDepth === 0 && stack.length && stack[stack.length - 1] === 'interp') {
      stack.pop() // ${ } 插值收口，回模板文本态
      prevSig = '}'
      prevWord = ''
      i++
      continue
    }
    if (c === '{') {
      braceDepth++
      prevSig = '{'
      prevWord = ''
      i++
      continue
    }
    if (c === '}') {
      if (braceDepth > 0) braceDepth--
      prevSig = '}'
      prevWord = ''
      i++
      continue
    }
    if (c === '/' && next === '/' && text[i - 1] !== ':') {
      // `://`（裸 URL scheme）不开行注释（CSS url() 内合法）
      mode = 'line'
      regionStart = i
      regionLine = line
      i += 2
      continue
    }
    if (c === '/' && next === '*') {
      mode = 'block'
      regionStart = i
      regionLine = line
      i += 2
      continue
    }
    if (ext === '.vue' && c === '<' && next === '!' && text[i + 2] === '-' && text[i + 3] === '-') {
      mode = 'html'
      regionStart = i
      regionLine = line
      i += 4
      continue
    }
    if (c === '/' && (REGEX_AFTER.has(prevSig) || REGEX_KEYWORDS.has(prevWord))) {
      // 正则字面量态：跳到收尾 /（字符类外，转义与换行尊重）
      i++
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === '/') {
          i++
          break
        }
        i++
      }
      prevSig = '/'
      prevWord = ''
      continue
    }
    if (c === '/') {
      prevSig = '/'
      prevWord = ''
      i++
      continue
    }
    if (isWordCh(c)) {
      prevWord = isWordCh(prevSig) || prevWord === '' ? prevWord + c : c
      prevSig = c
      i++
      continue
    }
    // 空白不覆盖 prevSig——`return /re/`、`= /re/` 的关键字/符号与 `/` 之间可隔空白
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    prevSig = c
    prevWord = ''
    i++
  }
  if (mode === 'line') pushRegion(n)
  return out
}

/**
 * allowlist 判定：file 按路径后缀匹配（支持仓库根相对与 src/ 相对两种写法）。
 */
export function isAllowlisted(file, lineText, allowlist = ANCHOR_ALLOWLIST) {
  return allowlist.some(
    (a) =>
      (file === a.file ||
        file.endsWith(sep + a.file) ||
        file.endsWith('/' + a.file) ||
        file.replace(/^src\//, '') === a.file) &&
      lineText.includes(a.contains),
  )
}

/**
 * 对单文件内容找标签命中。返回 [{ line, name, match, text }]。
 */
export function findTagHits(content, { file = '', ext = '.ts', allowlist = ANCHOR_ALLOWLIST } = {}) {
  const hits = []
  for (const { line, text } of extractCommentLines(content, ext)) {
    if (isAllowlisted(file, text, allowlist)) continue
    // 收全部形态命中后按「位置优先、同位长者优先」去重叠——R2W-7 由 R系 + 单字母两形
    // 撞出时只报覆盖最长的那个，命中数 = 真实标签数而非形态数。
    const found = []
    for (const { name, re } of TAG_PATTERNS) {
      re.lastIndex = 0
      for (const m of text.matchAll(re)) {
        if (TOKEN_EXCEPTIONS.has(m[0])) continue
        found.push({ start: m.index, end: m.index + m[0].length, name, match: m[0] })
      }
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end)
    const kept = []
    for (const f of found) {
      if (kept.some((k) => f.start < k.end && k.start < f.end)) continue
      kept.push(f)
    }
    for (const k of kept) {
      hits.push({ line, name: k.name, match: k.match, text: text.trim().slice(0, 120) })
    }
  }
  return hits
}

/** 收集待扫文件清单（src/** + 根配置）。 */
export function collectFiles(base = root) {
  const files = []
  const walk = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const p = join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!EXCLUDED_DIRS.has(name)) walk(p)
        continue
      }
      if (!SCAN_EXTS.has(name.slice(name.lastIndexOf('.')))) continue
      if (name.endsWith('.d.ts')) continue
      files.push(p)
    }
  }
  walk(join(base, 'src'))
  for (const f of ROOT_CONFIG_FILES) {
    try {
      statSync(join(base, f))
      files.push(join(base, f))
    } catch {
      /* 配置可缺席 */
    }
  }
  return files
}

/** 全库扫描。返回 [{ file, line, name, match, text }]（file 为相对仓库根的 POSIX 路径）。 */
export function scanRepo(base = root) {
  const all = []
  for (const abs of collectFiles(base)) {
    const rel = relative(base, abs).split(sep).join('/')
    let content
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const ext = abs.endsWith('.vue') ? '.vue' : abs.slice(abs.lastIndexOf('.'))
    for (const h of findTagHits(content, { file: rel, ext })) {
      all.push({ file: rel, ...h })
    }
  }
  return all
}

export function main() {
  const hits = scanRepo()
  if (hits.length) {
    console.error('源码注释门未过（comment-surface）：注释里出现批号标签 / 轮次 / 日期戳 / 评审史。')
    console.error('  纪律：注释只留约束、不变量、平台差与语义说明；修复史正本 = git 历史（commit message）。')
    let lastFile = ''
    for (const h of hits) {
      if (h.file !== lastFile) {
        console.error(`  ${h.file}`)
        lastFile = h.file
      }
      console.error(`    :${h.line} [${h.name}「${h.match}」] ${h.text}`)
    }
    console.error(`  共 ${hits.length} 处命中。承重锚注（被测试钉住、不得删改）经 ANCHOR_ALLOWLIST 登记。`)
    process.exit(1)
  }
  console.log(`check:comments 通过：src 与根配置注释零批号标签（扫描 ${collectFiles().length} 个文件）。`)
}

// 直跑判据走 pathToFileURL——argv[1] 可能是相对路径（`node scripts/check-comments.mjs`），
// 裸拼 `file://${argv[1]}` 与之不等，main() 会静默不执行（门形同虚设）。
// argv[1] 可缺席（node -e / REPL 动态 import），缺席即非直跑。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
