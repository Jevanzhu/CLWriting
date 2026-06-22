import { test, expect, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { healthCommand } from '../../src/cli/health.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { createAllTables } from '../../src/cache/schema.js'
import { appendMetric, type MetricRecord } from '../../src/metrics/ledger.js'
import { writeChapter } from '../../src/format/chapters.js'
import { writePiece } from '../../src/format/pieces.js'
import { writePieceList } from '../../src/format/manifest.js'
import { writeSample } from '../../src/format/style.js'
import { baselinePath } from '../../src/metrics/style.js'
import type { ChapterMeta, PieceList } from '../../src/format/types.js'
function captureHealth(args: string[], bookRoot: string): { out: string; err: string; exitCalled: boolean } {
  const out: string[] = []
  const err: string[] = []
  let exitCalled = false
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')))
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.map(String).join(' ')))
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((d: string | Uint8Array) => {
    out.push(String(d))
    return true
  }) as typeof process.stdout.write)
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    exitCalled = true
    throw new Error(`process.exit ${String(code)}`)
  }) as typeof process.exit)

  try {
    healthCommand([...args, bookRoot])
  } catch {
    // process.exit 抛出，正常
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
    writeSpy.mockRestore()
    exitSpy.mockRestore()
  }
  return { out: out.join('\n'), err: err.join('\n'), exitCalled }
}

/** 造一个 git 干净的书仓库（有若干章定稿正文 + metrics 账） */
function makeBookWithMetrics(count = 1): string {
  const root = mkdtempSync(join(tmpdir(), 'health-modes-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '文风'), { recursive: true })
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '对话标签占比: 50%', 'utf-8')

  for (let i = 1; i <= count; i++) {
    const title = `第${i}章`
    const ch: ChapterMeta = { 章号: i, 标题: title, 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
    writeChapter(join(root, '定稿', '正文', `${i}-${title}.md`), ch, '「来了。」他说。\n雪落无声。')
    const rec: MetricRecord = {
      kind: 'long', num: i, title, words: 10, at: `2026-06-20T00:00:0${i}.000Z`,
      calls: { outline: 1, draft: 1, review: 3, total: 5, limit: 8 }, tokens: null,
      review: { tier: 'full', downgrade: false, downgrade_reason: null, blockers: 0, warnings: 1, invalid: 0, lenses: ['reader', 'editor', 'continuity'] },
    }
    appendMetric(root, rec)
  }
  // 缓存 + git 干净
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  db.close()
  execSync('git add -A && git commit -m "init"', { cwd: root, stdio: 'pipe' })
  return root
}

function makeShortBookWithRepeats(): string {
  const root = mkdtempSync(join(tmpdir(), 'health-short-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '对话标签占比: 50%', 'utf-8')
  for (let i = 1; i <= 3; i++) {
    const dir = join(root, '篇', `${String(i).padStart(3, '0')}-雪夜${i}`)
    mkdirSync(dir, { recursive: true })
    writePiece(join(dir, '正文.md'), {
      篇号: i,
      标题: `雪夜${i}`,
      目标情绪: '惊悚',
      核心反转: i < 3 ? '来客就是死者' : '门后的人是死者',
    }, '「来了。」他说。\n雪落无声。')
    const list: PieceList = {
      反转线索表: {
        核心反转: i < 3 ? '来客就是死者' : '门后的人是死者',
        铺垫点: [
          { 位置: '开头钩子', 内容: '门外没有脚印' },
          { 位置: '铺垫', 内容: '镜中没有影子' },
          { 位置: '升级', 内容: '钟表倒走' },
        ],
      },
      情绪曲线: [
        { 段落: '开头钩子', 情绪: '惊悚', 强度: 3 },
        { 段落: '铺垫', 情绪: '惊悚', 强度: 5 },
        { 段落: '升级', 情绪: '惊悚', 强度: 7 },
        { 段落: '反转', 情绪: '惊悚', 强度: 9 },
        { 段落: '余韵', 情绪: '后怕', 强度: 6 },
      ],
      伏笔回收: [{ 伏笔: '门外没有脚印', 回收位置: '结尾' }],
    }
    writePieceList(join(dir, '清单.md'), list)
    appendMetric(root, {
      kind: 'short', num: i, title: `雪夜${i}`, words: 10, at: `2026-06-20T00:00:0${i}.000Z`,
      calls: { outline: 1, draft: 1, review: 3, total: 5, limit: 8 }, tokens: null,
      review: { tier: 'full', downgrade: false, downgrade_reason: null, blockers: 0, warnings: 1, invalid: 0, lenses: ['hook', 'emotion_peak', 'payoff'] },
    })
  }
  execSync('git add -A && git commit -m "init"', { cwd: root, stdio: 'pipe' })
  return root
}

test('health 无参 → git 体检（默认路径不受子参数影响）', () => {
  const root = makeBookWithMetrics()
  const { out } = captureHealth([], root)
  expect(out).toContain('git 干净') // 干净时报平安
  rmSync(root, { recursive: true, force: true })
})

test('health --metrics → 成本/审查段输出', () => {
  const root = makeBookWithMetrics()
  const { out } = captureHealth(['--metrics'], root)
  expect(out).toContain('成本')
  expect(out).toContain('审查')
  expect(out).toContain('满审率')
  rmSync(root, { recursive: true, force: true })
})

test('health --style → 文风段输出（无基线标注仅绝对值）', () => {
  const root = makeBookWithMetrics()
  const { out } = captureHealth(['--style'], root)
  expect(out).toContain('文风对齐体检')
  expect(out).toContain('无基线') // 未冻结
  rmSync(root, { recursive: true, force: true })
})

test('health --style --last=N → 文风只看近 N 章', () => {
  const root = makeBookWithMetrics(3)
  const { out } = captureHealth(['--style', '--last=1'], root)
  expect(out).toContain('文风对齐体检 · 基于 1 章')
  rmSync(root, { recursive: true, force: true })
})

test('health --report → 文风段 + 成本/审查段都输出（合龙）', () => {
  const root = makeBookWithMetrics()
  const { out } = captureHealth(['--report'], root)
  expect(out).toContain('文风对齐体检') // 块 B 段
  expect(out).toContain('成本') // 块 A 段
  expect(out).toContain('审查')
  rmSync(root, { recursive: true, force: true })
})

test('health --report --last=N → 文风和指标都只看近 N 章', () => {
  const root = makeBookWithMetrics(3)
  const { out } = captureHealth(['--report', '--last=2'], root)
  expect(out).toContain('文风对齐体检 · 基于 2 章')
  expect(out).toContain('成本/审查体检 · 2 条记录（第 2–3 章）')
  rmSync(root, { recursive: true, force: true })
})

test('health --report short: 追加短篇集节奏体检与重复风险', () => {
  const root = makeShortBookWithRepeats()
  const { out } = captureHealth(['--report'], root)
  expect(out).toContain('短篇集节奏体检')
  expect(out).toContain('最近 3 篇目标情绪都为「惊悚」')
  expect(out).toContain('结构物件/伏笔「门外没有脚印」重复出现')
  rmSync(root, { recursive: true, force: true })
})

test('health --style --freeze → 冻结基线.json', () => {
  const root = makeBookWithMetrics()
  // 加样章才能冻结
  mkdirSync(join(root, '文风', '样章库', '对话'), { recursive: true })
  writeSample(join(root, '文风', '样章库', '对话', '对话-001.md'), {
    场景: '对话', 来源: '作者原作', 正文: '「你来了。」\n「我来了。」\n两人对视。',
  })
  expect(existsSync(baselinePath(root))).toBe(false)
  const { out } = captureHealth(['--style', '--freeze'], root)
  expect(out).toContain('已冻结')
  expect(existsSync(baselinePath(root))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('health --style --freeze 空样章 → 报错不写文件', () => {
  const root = makeBookWithMetrics()
  // 无样章库
  const { err, exitCalled } = captureHealth(['--style', '--freeze'], root)
  expect(err).toContain('样章库')
  expect(exitCalled).toBe(true)
  expect(existsSync(baselinePath(root))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('health --help → 含各子参数说明', () => {
  const root = makeBookWithMetrics()
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => lines.push(a.map(String).join(' ')))
  try {
    healthCommand(['--help'])
  } finally {
    spy.mockRestore()
  }
  const out = lines.join('\n')
  expect(out).toContain('--metrics')
  expect(out).toContain('--style')
  expect(out).toContain('--report')
  expect(out).toContain('--last')
  rmSync(root, { recursive: true, force: true })
})

test('health --metrics 无指标账 → 友好提示不崩', () => {
  const root = mkdtempSync(join(tmpdir(), 'health-empty-'))
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  const { out, exitCalled } = captureHealth(['--metrics'], root)
  expect(out).toContain('尚无定稿指标')
  expect(exitCalled).toBe(false)
  rmSync(root, { recursive: true, force: true })
})
