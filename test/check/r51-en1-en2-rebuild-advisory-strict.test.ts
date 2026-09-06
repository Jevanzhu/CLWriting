/**
 * R51-E-N1 / E-N2（五十一轮）回归——rebuild 报告级分流 + strict 短篇 unreadable/degraded 升红。
 *
 * E-N1：rebuild 的「健康报告级」降级事实（book.yaml 解析失败、摘要命名不合规）原混入
 *   errors 桶，被消费面当硬闸：单章机检恒 REBUILD_FAIL（500）、树红点机检全灭、进门
 *   state 2、R29-5 book-config-degraded 黄项被前置闸阻断为稳态不可达——一个手放
 *   `笔记.md` 即瘫全链。分流后 errors 只承载真「源文件解析失败」，warnings 走 log +
 *   meta 健康报告（不驱动任何红闸）。
 * E-N2：strict 短篇升红集补 unreadable/degraded 族——严格承诺「机检全绿才过定稿闸」，
 *   「检查没跑成」（章纲/名册/布线读不出）不得以黄项绿灯过闸。
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuild } from '../../src/cache/rebuild.js'
import { runCheckForDocument } from '../../src/check/run.js'
import { runAllChecks, hasRed } from '../../src/check/runner.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { ChapterMeta, BookConfig } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let root = ''

/** 最小长篇 fixture：布线目录（触发 rebuild 链）+ 1 个好章 + 合法 book.yaml */
function makeWiredBook(): void {
  writeBookConfig(join(root, 'book.yaml'), {
    ...DEFAULT_CONFIG,
    book: { title: '书', genre: '玄幻' },
  } as BookConfig)
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n正文', 'utf-8')
}

/** 破坏 book.yaml（顶层重复键，r50-c2 同款确定失败形态） */
function corruptBookYaml(): void {
  writeFileSync(join(root, 'book.yaml'), 'book:\n  title: a\nbook:\n  title: b\n', 'utf-8')
}

describe('R51-E-N1: rebuild 报告级分流', () => {
  beforeEach(() => {
    root = mkdtempTracked(join(tmpdir(), 'clw-r51-en1-'))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('E-N1: book.yaml 损坏 + 摘要命名不合规 → warnings 在册、errors 空', () => {
    makeWiredBook()
    corruptBookYaml()
    mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
    writeFileSync(join(root, '定稿', '摘要', '章摘要', '手放笔记.md'), '误放文件', 'utf-8')
    const r = rebuild(root, join(root, '.cache', 'index.db'))
    expect(r.errors).toHaveLength(0) // 原实现两处降级事实全入 errors——回归红
    expect(r.warnings.some((w) => w.message.includes('摘要文件名'))).toBe(true)
    expect(r.warnings.some((w) => w.file === join(root, 'book.yaml'))).toBe(true)
  })

  test('E-N1: 报告级降级不再触发单章机检 REBUILD_FAIL，R29-5 黄项可达', () => {
    makeWiredBook()
    corruptBookYaml()
    mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
    writeFileSync(join(root, '定稿', '摘要', '章摘要', '手放笔记.md'), '误放文件', 'utf-8')
    const outcome = runCheckForDocument(root, join(root, '写作', '正文', '0001-开篇.md'), null)
    expect(outcome.ok).toBe(true) // 原实现 REBUILD_FAIL（单章机检全 500）——回归红
    if (!outcome.ok) return
    const items = outcome.report.sections.flatMap((s) => s.items)
    expect(items.some((i) => i.checkId === 'book-config-degraded' && i.level === 'yellow')).toBe(true)
  })

  test('E-N1: 真源文件解析失败仍入 errors → REBUILD_FAIL 硬闸保持', () => {
    makeWiredBook()
    writeFileSync(join(root, '写作', '正文', '0002-坏章.md'), '无 frontmatter 的裸文件', 'utf-8')
    const outcome = runCheckForDocument(root, join(root, '写作', '正文', '0001-开篇.md'), null)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('REBUILD_FAIL')
  })
})

// ── E-N2：strict 短篇 unreadable 族升红 ──────────────────────────────

function shortConfig(): BookConfig {
  return { ...DEFAULT_CONFIG, kind: 'short', short: {} }
}

const ch: ChapterMeta = {
  章号: 1,
  标题: '雪夜',
  钩子类型: '悬念钩',
  钩子强弱: '中',
  情绪定位: '铺垫',
  // 章纲定位入口（runner: short && chapter._path）——basename 与 大纲/章纲/ 下夹具同名
  _path: '写作/正文/001-雪夜.md',
}

test('E-N2: strict 短篇——章纲在盘不可读（piece-list-unreadable）黄升红；非严格维持黄', () => {
  root = mkdtempTracked(join(tmpdir(), 'clw-r51-en2-'))
  try {
    // 章纲定位走 existsSync（目录也为真）+ readFileSync EISDIR → readPieceList ok:false
    //（跨平台确定的「在盘不可读」形态，免去 chmod 的 win 平台分叉）
    mkdirSync(join(root, '大纲', '章纲', '001-雪夜.md'), { recursive: true })
    const base = {
      bookRoot: root,
      config: shortConfig(),
      chapter: ch,
      body: '正文',
      fileName: '001-雪夜.md',
    }
    const plain = runAllChecks(base)
    const plainItem = plain.sections.flatMap((s) => s.items).find((i) => i.checkId === 'piece-list-unreadable')
    expect(plainItem?.level).toBe('yellow')
    const strict = runAllChecks({ ...base, strictShort: true })
    expect(hasRed(strict)).toBe(true)
    const strictItem = strict.sections.flatMap((s) => s.items).find((i) => i.checkId === 'piece-list-unreadable')
    expect(strictItem?.level).toBe('red') // 原实现维持黄（「检查没跑成」绿灯过闸）——回归红
    expect(String(strictItem?.message).startsWith('短篇严格模式：')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
