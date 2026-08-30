/**
 * 批 A · 机检正确性（二十九轮）回归：
 * - R29-4 checkOpeningNoEnv 开头窗口剥对白引号 span
 * - B-12 checkNewNames 混排行「引导词 + 引语」伪专名守卫
 * - R29-5 runCheckForDocument book.yaml 降级黄项透出（book-config-degraded）
 * - B-8 章级缓存指纹毫秒 → µs/ns 精度（方案升级旧行自然失效）
 * - B-7 读侧：opening_env_chars 显式 0 = 关闭「开头零环境」检查
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { checkOpeningNoEnv, checkNewNames } from '../../src/check/count.js'
import { runAllChecks } from '../../src/check/runner.js'
import { runCheckForDocument, collectTreeIssues } from '../../src/check/run.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import type { ChapterMeta } from '../../src/format/types.js'

const CH: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }

// ── R29-4：开头零环境剥引号 ─────────────────────────

test('R29-4: 开头窗口内对白引号里的环境词不再报黄', () => {
  // 「天气」出现在对白 span 内——角色嘴里说的不算环境描写（叙述面）
  expect(checkOpeningNoEnv('「今天天气真好。」他拔刀出鞘。').items).toHaveLength(0)
  // 对照：叙述面同词照报
  const r = checkOpeningNoEnv('天气晴得刺眼。他拔刀出鞘。')
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.checkId).toBe('opening-env')
})

// ── B-12：混排行伪专名引导词守卫 ─────────────────────

/** 空名册（候选全部上报）的小工具 */
function candidatesOf(body: string): string[] {
  const dir = mkdtempTracked(join(tmpdir(), 'r29-names-'))
  try {
    const roster = join(dir, '名册.md')
    writeFileSync(roster, '空名册', 'utf-8')
    return checkNewNames(body, roster).items.map((i) => i.message.match(/「(.+?)」/)?.[1] ?? '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('B-12: 动作+无句读短引语的混排行不再产伪专名黄项', () => {
  // 引导词紧邻（隔一个冒号也算紧邻）→ span 判为对白引用跳过（修复前「别动」报伪专名）
  expect(candidatesOf('他低声道：「别动」，然后按住她的肩。')).toEqual([])
  expect(candidatesOf('林晚喊道「站住」，追了出去。')).toEqual([])
})

test('B-12: 引导词不在紧邻窗口 / 词表外 / 引号外 → 真候选照报', () => {
  // 引导词不在紧邻窗口（中间隔了「了很多」）→ 「诚实」照报
  expect(candidatesOf('他说了很多，「诚实」才是关键。')).toContain('诚实')
  // 词表外引导（「名叫」的「叫」不是说话动词）→ 真专名不误杀
  expect(candidatesOf('名叫「萧破军」的人影闪进巷子。')).toContain('萧破军')
  // 同行混合：对白 span 豁免，引号外真提及（另一 span、无引导词）照报
  expect(candidatesOf('林晚喊道「站住」，远处「萧破军」的杀声逼近。')).toEqual(['萧破军'])
})

// ── R29-5：book.yaml 降级黄项透出（单章路径）──────────

const VALID_YAML = 'spec_version: 1\nkind: long\nbook:\n  title: 降级书\nhost: cc\nleads:\n  enabled: []\n'
// 顶层段重复 → sectionsToConfig fail-loud → readBookConfig ok:false（可确定性触发损坏）
const BROKEN_YAML = 'spec_version: 1\nbook:\n  title: A\nbook:\n  title: B\n'
const DRAFT_FM = '---\n章号: 1\n标题: 章一\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文一句。'

test('R29-5: book.yaml 解析失败 → 机检报告透出 book-config-degraded 黄项（不阻断）', () => {
  const bookRoot = mkdtempTracked(join(tmpdir(), 'r29-degraded-'))
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
  const bookRoot = mkdtempTracked(join(tmpdir(), 'r29-nodegraded-'))
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

// ── B-7 读侧：opening_env_chars 显式 0 = 关检 ─────────

function runShort(shortCfg: NonNullable<typeof DEFAULT_CONFIG['short']>): string[] {
  const bookRoot = mkdtempTracked(join(tmpdir(), 'r29-short-'))
  try {
    return runAllChecks({
      bookRoot,
      config: { ...DEFAULT_CONFIG, kind: 'short', short: shortCfg },
      chapter: CH,
      body: '阳光洒满街道，他推开门。',
      fileName: '001-雪夜.md',
    }).sections.flatMap((s) => s.items.map((i) => i.checkId))
  } finally {
    rmSync(bookRoot, { recursive: true, force: true })
  }
}

test('B-7 读侧: opening_env_chars 显式 0 → 无 opening-env 项（检查关闭）；未设 → 默认检查在跑', () => {
  expect(runShort({ opening_env_chars: 0 })).not.toContain('opening-env')
  expect(runShort({})).toContain('opening-env') // 未设 = 默认 300，检查照跑
})

// ── B-8：章级缓存指纹精度升级（毫秒 → µs/ns）──────────

test('B-8: 章级缓存行指纹落 µs 级整数（旧毫秒行值域不相交，天然整表失效无脏读）', () => {
  const bookRoot = mkdtempTracked(join(tmpdir(), 'r29-fp-'))
  try {
    mkdirSync(join(bookRoot, '布线', '悬念'), { recursive: true })
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    mkdirSync(join(bookRoot, '项目'), { recursive: true })
    writeFileSync(join(bookRoot, 'book.yaml'), VALID_YAML, 'utf8')
    writeFileSync(
      join(bookRoot, '布线', '悬念', '悬念-001-灭门真凶.md'),
      '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
      'utf-8',
    )
    const draftPath = join(bookRoot, '写作', '正文', '001-章一.md')
    writeFileSync(draftPath, DRAFT_FM, 'utf8')
    const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    upsertEntry(m, { id: generateDocId(), nodeType: 'document', path: '写作/正文/001-章一.md', parentId: null })
    writeManifest(manifestPath, m)

    // 第一轮落缓存；第二轮命中（结果同构）
    const first = collectTreeIssues(bookRoot, () => undefined)
    const second = collectTreeIssues(bookRoot, () => undefined)
    expect(second.issues).toEqual(first.issues)

    // 直查缓存行：mtime 列应为 µs 级（~1.7e15），与旧毫秒值（~1.7e12）值域隔离
    const db = new DatabaseSync(join(bookRoot, '.cache', 'index.db'))
    try {
      const row = db.prepare('SELECT mtime_ms FROM tree_issues_cache LIMIT 1').get() as { mtime_ms: number } | undefined
      expect(row).toBeDefined()
      expect(row!.mtime_ms).toBeGreaterThan(1e15) // µs since epoch
      expect(row!.mtime_ms).toBeLessThan(1e16)
    } finally {
      db.close()
    }
  } finally {
    rmSync(bookRoot, { recursive: true, force: true })
  }
})
