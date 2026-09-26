/**
 * rebuild 报告级分流与 strict 短篇 unreadable/degraded 升红。
 *
 * 档源（2 档并 1，按被测行为合并；断言逐条保留、去重 0 条）：
 * - r51-en1-en2-rebuild-advisory-strict.test.ts（E-N1 / E-N2 / 重评-P2-4）
 * - r29-check-machine-correctness.test.ts 的 R29-5 组（同文件其余组按被测行为
 *   分别并入 quoted-span-dialogue-strip / roster-new-names / check-config-thresholds /
 *   tree-issues-epoch-fingerprint 各档）
 * - r31b-machine-correctness.test.ts 的 R31-3 组（兑现侧读失败降级——与 E-N2/P2-4
 *   同属「unreadable 黄项族」，同一 fs-deny 注入缝）
 *
 * E-N1（五十一轮）：rebuild 的「健康报告级」降级事实（book.yaml 解析失败、摘要命名
 *   不合规）原混入 errors 桶，被消费面当硬闸：单章机检恒 REBUILD_FAIL（500）、树红点
 *   机检全灭、进门 state 2、R29-5 book-config-degraded 黄项被前置闸阻断为稳态不可达
 *   ——一个手放 `笔记.md` 即瘫全链。分流后 errors 只承载真「源文件解析失败」，warnings
 *   走 log + meta 健康报告（不驱动任何红闸）。
 * E-N2（五十一轮）：strict 短篇升红集补 unreadable/degraded 族——严格承诺「机检全绿
 *   才过定稿闸」，「检查没跑成」（章纲/名册/布线读不出）不得以黄项绿灯过闸。
 * R29-5（二十九轮批 A）：book.yaml 降级黄项（book-config-degraded）在单章路径透出。
 * 重评-P2-4（2026-09-09 全量代码重评）：strict 生效判定 kind 门控（run.ts 后置升红
 * 路径统一走 effectiveShort——长篇误写 short 段不升红）。
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuild } from '../../src/cache/rebuild.js'
import { runCheckForDocument } from '../../src/check/run.js'
import { runAllChecks, hasRed, getRedItems } from '../../src/check/runner.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { ChapterMeta, BookConfig } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { denyRead } from '../helpers/fs-deny.js'

// win 臂 EACCES 注入的模块包装（posix 臂走 chmod 不依赖）——见 helpers/fs-deny.ts 头注
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { armFsNamespace } = await import('../helpers/fs-deny.js')
  return armFsNamespace('fs', actual)
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const { armFsNamespace } = await import('../helpers/fs-deny.js')
  return armFsNamespace('fsp', actual)
})


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

// ── 重评-P2-4（2026-09-09 全量代码重评）：strict 生效判定 kind 门控（run.ts 后置升红路径）──
//
// run.ts 三处后置 promote 此前判 config.short?.strict === true（不看 kind）：长篇误写
// short 段时 unreadable 族黄项被误升红，与 runner 报告内路径（kind==='short' 门控）口径
// 分裂。现统一走 effectiveShort——长篇误写不升红、短篇照旧升红。book.yaml 须原文直写
// （stringifyBookConfig 对长篇不输出 short 段，写不出「误写」形态）。

/** 布线书 fixture：账本推进.md 待注入后 chmod 000 触发 lead-updates-unreadable（R31-3 同款） */
function makeWiringBookWithShort(kind: 'long' | 'short'): string {
  const root = mkdtempTracked(join(tmpdir(), 'clw-p2-4-'))
  writeFileSync(
    join(root, 'book.yaml'),
    [
      'spec_version: 1',
      `kind: ${kind}`,
      'book:',
      '  title: 测试书',
      'host: cc',
      'leads:',
      '  enabled: []',
      'short:',
      '  strict: true',
      '',
    ].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '写作', '正文', '001-夜访.md'),
    '---\n章号: 1\n标题: 夜访\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的钟声在雨夜里连响了三下。\n',
    'utf-8',
  )
  writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: [悬念-001]\n---\n\n本章细纲。\n', 'utf-8')
  return root
}

// 重评-0914-三轮 P3-11：读失败注入改 fs-deny 平台分派（win 臂 spy 注入 EACCES），摘除 skipIf(win32)
test('重评-P2-4: 长篇误写 short.strict + 账本推进读失败 → unreadable 黄项不升红', () => {
  const root = makeWiringBookWithShort('long')
  try {
    const ledger = join(root, '工作区', '账本推进.md')
    writeFileSync(ledger, '# 第1章 账本推进\n- 悬念-001 推进：钟声三响\n', 'utf-8')
    const deny = denyRead(ledger) // 账本推进.md 不可读（win 臂 spy / posix 臂 chmod 0o000）
    try {
      const outcome = runCheckForDocument(root, join(root, '写作', '正文', '001-夜访.md'))
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const item = outcome.report.sections.flatMap((s) => s.items).find((i) => i.checkId === 'lead-updates-unreadable')
      expect(item?.level).toBe('yellow') // 修复前 config.short?.strict === true 误升红——回归红
      expect(String(item?.message).startsWith('短篇严格模式：')).toBe(false)
    } finally {
      deny.restore()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 重评-0914-三轮 P3-11：fs-deny 平台分派注入，摘除 skipIf(win32)
test('重评-P2-4: 短篇 short.strict + 账本推进读失败 → unreadable 黄项照旧升红', () => {
  const root = makeWiringBookWithShort('short')
  try {
    const ledger = join(root, '工作区', '账本推进.md')
    writeFileSync(ledger, '# 第1章 账本推进\n- 悬念-001 推进：钟声三响\n', 'utf-8')
    const deny = denyRead(ledger) // 账本推进.md 不可读（win 臂 spy / posix 臂 chmod 0o000）
    try {
      const outcome = runCheckForDocument(root, join(root, '写作', '正文', '001-夜访.md'))
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const item = outcome.report.sections.flatMap((s) => s.items).find((i) => i.checkId === 'lead-updates-unreadable')
      expect(item?.level).toBe('red')
      expect(String(item?.message).startsWith('短篇严格模式：')).toBe(true)
    } finally {
      deny.restore()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R29-5（并入档）：book.yaml 降级黄项在单章路径透出 ─────────────

const VALID_YAML = 'spec_version: 1\nkind: long\nbook:\n  title: 降级书\nhost: cc\nleads:\n  enabled: []\n'
// 顶层段重复 → sectionsToConfig fail-loud → readBookConfig ok:false（可确定性触发损坏）
const BROKEN_YAML = 'spec_version: 1\nbook:\n  title: A\nbook:\n  title: B\n'
const DRAFT_FM = '---\n章号: 1\n标题: 章一\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文一句。'

describe('R29-5：book.yaml 解析失败的降级黄项透出', () => {
  test('R29-5: book.yaml 解析失败 → 机检报告透出 book-config-degraded 黄项（不阻断）', () => {
    const bookRoot = mkdtempTracked(join(tmpdir(), 'book-config-degraded-'))
    try {
      writeFileSync(join(bookRoot, 'book.yaml'), BROKEN_YAML, 'utf8')
      const draftPath = join(bookRoot, '0001-章一.md')
      writeFileSync(draftPath, DRAFT_FM, 'utf8')

      const outcome = runCheckForDocument(bookRoot, draftPath, null)
      expect(outcome.ok).toBe(true) // 降级不阻断
      if (!outcome.ok) return
      const degraded = outcome.report.sections
        .flatMap((s) => s.items)
        .find((i) => i.checkId === 'book-config-degraded')
      expect(degraded).toBeDefined()
      expect(degraded!.level).toBe('yellow')
      expect(degraded!.message).toContain('降级')
      expect(degraded!.chapter).toBe(1)
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })

  test('R29-5: book.yaml 正常 → 无降级黄项', () => {
    const bookRoot = mkdtempTracked(join(tmpdir(), 'book-config-ok-'))
    try {
      writeFileSync(join(bookRoot, 'book.yaml'), VALID_YAML, 'utf8')
      const draftPath = join(bookRoot, '0001-章一.md')
      writeFileSync(draftPath, DRAFT_FM, 'utf8')
      const outcome = runCheckForDocument(bookRoot, draftPath, null)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.report.sections.flatMap((s) => s.items).some((i) => i.checkId === 'book-config-degraded')).toBe(false)
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })
})

// ── R31-3（并入档；原 r31b-machine-correctness.test.ts）：兑现侧读失败降级 ──
// 账本推进「兑现侧」读失败 ≠「无推进」——细纲声明在而 账本推进.md 不可读时，
// 两端闭合跳过（不产 lead-declared-not-done 红硬阻断定稿），改报
// lead-updates-unreadable 黄（fail-noisy）。对齐声明侧 R70-15。

/** 造一本有布线的完整书（同 two-end-closure 骨架） */
function makeWiringBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'lead-unreadable-book-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '写作', '正文', '001-夜访.md'),
    '---\n章号: 1\n标题: 夜访\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的钟声在雨夜里连响了三下。\n',
    'utf-8',
  )
  writeFileSync(join(root, '大纲', '章纲', '001-夜访.md'), '---\n章号: 1\n标题: 夜访\n---\n\n## 反转线索表\n- 核心反转：x\n', 'utf-8')
  return root
}

// 重评-0914-三轮 P3-11：读失败注入改 fs-deny 平台分派（win 臂 spy 注入 EACCES），摘除 skipIf(win32)
test('R31-3: 账本推进读失败 → 黄项降级，不产 declared-not-done 红', () => {
  const root = makeWiringBook()
  try {
    // 细纲声明 悬念-001（若兑现侧可读且无推进 → 本应红 lead-declared-not-done）
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: [悬念-001]\n---\n\n本章细纲。\n', 'utf-8')
    // 账本推进.md 在但不可读（chmod 000 模拟权限/瞬态占用；存在≠无推进）
    const ledger = join(root, '工作区', '账本推进.md')
    writeFileSync(ledger, '# 第1章 账本推进\n- 悬念-001 推进：钟声三响\n', 'utf-8')
    const deny = denyRead(ledger) // 账本推进.md 在但不可读（win 臂 spy / posix 臂 chmod 0o000）
    try {
      const outcome = runCheckForDocument(root, join(root, '写作', '正文', '001-夜访.md'))
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      // 红闸不触发：清单未知不冒充「已声明未兑现」
      expect(getRedItems(outcome.report).some((i) => i.checkId === 'lead-declared-not-done')).toBe(false)
      // fail-noisy：降级黄项随报告透出
      const yellows = outcome.report.sections.flatMap((s) => s.items).filter((i) => i.level === 'yellow')
      expect(yellows.some((i) => i.checkId === 'lead-updates-unreadable')).toBe(true)
    } finally {
      deny.restore()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R31-3: 文件不存在仍属「无推进」已知态（declared-not-done 红照常，未回归）', () => {
  const root = makeWiringBook()
  try {
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: [悬念-001]\n---\n\n本章细纲。\n', 'utf-8')
    const outcome = runCheckForDocument(root, join(root, '写作', '正文', '001-夜访.md'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(getRedItems(outcome.report).some((i) => i.checkId === 'lead-declared-not-done')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
