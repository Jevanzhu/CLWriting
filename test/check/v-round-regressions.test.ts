/**
 * v 轮（2026-08-14）机检/三审层 P1/P2 修复回归。
 *
 * V-P1-4 byproducts 章号、V-P1-5 真实文件名、V-P1-6/7 引号体系与对话标签、
 * V-P1-8 满审预算=视角数、V-P2-12 证据引号、V-P2-14 细纲章号守卫、V-P2-17 境界前缀匹配。
 */
import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { runAllChecks } from '../../src/check/runner.js'
import { checkWithDb } from '../../src/check/run.js'
import { computeStyleMetrics } from '../../src/check/count.js'
import { readOutlineLeads } from '../../src/check/outline-leads.js'
import { leadUpdatesInScopeForChapter } from '../../src/check/lead-updates.js'
import { extractEvidenceCore } from '../../src/check/leads.js'
import { selectReviewTier, buildReviewTasks } from '../../src/review/contract.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { CheckReport } from '../../src/check/types.js'
import type { BookConfig, ChapterMeta, RealmDoc } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const CONFIG: BookConfig = { ...DEFAULT_CONFIG, book: { title: '回归', genre: '仙侠' } }
const CH: ChapterMeta = { 章号: 5, 标题: '回归章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }

// ── V-P1-4：byproducts.leadChanges 必须按被检章（非全书最高已定稿章）──────────────

test('V-P1-4: 三审账本变动 = 被检章自身的履历（不是最高已定稿章的）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'clw-v4-'))
  try {
    mkdirSync(join(root, '布线'), { recursive: true }) // hasWiring → 走账本 byproducts
    const db = new DatabaseSync(':memory:')
    createAllTables(db)
    db.prepare(`INSERT INTO leads (id, type, title, status, opened_at, path) VALUES ('悬念-001', '悬念', 't', '进行中', 0, 'p')`).run()
    const insert = db.prepare(`INSERT INTO lead_history (lead_id, seq, chapter, verb, evidence, backfill) VALUES (?, ?, ?, ?, ?, 0)`)
    insert.run('悬念-001', 1, 3, '推进', '第三章证据') // 最高已定稿章（maxWrittenChapter）
    insert.run('悬念-001', 2, 5, '推进', '第五章证据') // 被检章

    const report: CheckReport = runAllChecks({
      db,
      bookRoot: root,
      config: CONFIG,
      chapter: CH,
      body: '正文。',
      fileName: '005-回归章.md',
      maxWrittenChapter: 3, // 树红点/三审端点会传入全书最高章
    })
    const changes = report.byproducts?.leadChanges ?? []
    expect(changes).toHaveLength(1)
    expect(changes[0]!.chapter).toBe(5) // 修复前：错拿第 3 章（最高已定稿章）的履历
    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── V-P1-5：fm-chapter-mismatch 用真实文件名（生产路径不再恒真空）─────────────────

test('V-P1-5: checkWithDb 用真实文件名 → 章号≠文件名报红', () => {
  const root = mkdtempTracked(join(tmpdir(), 'clw-v5-'))
  try {
    writeBookConfig(join(root, 'book.yaml'), CONFIG)
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    const abs = join(root, '写作', '正文', '007-标题.md') // 文件名 007，fm 章号 6
    writeFileSync(abs, '---\n章号: 6\n标题: 标题\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文。', 'utf-8')

    const outcome = checkWithDb(root, abs, null, CONFIG)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      const hit = outcome.report.sections.flatMap((s) => s.items).find((i) => i.checkId === 'fm-chapter-mismatch')
      expect(hit).toBeDefined() // 修复前：fileName 从章号合成，此项永不触发
      expect(hit!.level).toBe('red')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── V-P1-6/7：引号体系统一 + 对话标签只看引号外提示语 ─────────────────────────────

test('V-P1-6: 弯引号（“”）对话行计入对话行分母', () => {
  const body = ['“你好。”他说。', '“再见。”她答。', '“我走了。”', '叙述一行没有引号。'].join('\n')
  const stats = computeStyleMetrics(body, {})
  expect(stats._dialogueLines).toBe(3) // 修复前：“ 开引号缺失 → 弯引号行永不匹配
})

test('V-P1-7: 对白内容里的“知道/笑道”不算对话标签；引号外提示语才算', () => {
  // 两行对白：引号内含疑似标签词（知道/别叫），引号外无提示语 → 标签占比 0
  const noTag = computeStyleMetrics('“我知道你要说什么。”\n“你别叫了。”', { maxDialogueTagRatio: 0.3 })
  expect(noTag.dialogueTagRatio).toBe(0)
  // 一行引号外有提示语 → 该行计为标签行
  const withTag = computeStyleMetrics('“住手。”他喊道。', { maxDialogueTagRatio: 0.3 })
  expect(withTag.dialogueTagRatio).toBe(1)
})

// ── V-P2-12：证据核心片段识别中文弯引号/直角引号 ────────────────────────────────

test('V-P2-12: extractEvidenceCore 覆盖中文弯引号与直角引号', () => {
  expect(extractEvidenceCore('他在“藏经阁的暗格里找到了半卷残书”之后离开')).toBe('藏经阁的暗格里找到了半卷残书')
  expect(extractEvidenceCore('「剑冢深处的封印松动了」')).toBe('剑冢深处的封印松动了')
  expect(extractEvidenceCore('无引号证据的前八字之后的补足内容')).toBe('无引号证据的前八') // 无引号 → slice(0,8) 兜底
})

// ── V-P2-14：细纲声明按被检章过滤 ────────────────────────────────────────────────

test('V-P2-14: 细纲章号与被检章不一致 → 声明侧置空；一致/缺省 → 沿用', () => {
  const root = mkdtempTracked(join(tmpdir(), 'clw-v14-'))
  try {
    mkdirSync(join(root, '工作区'), { recursive: true })
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 6\n推进: 悬念-001\n---\n\n第六章细纲', 'utf-8')
    expect(readOutlineLeads(root, 6)).toEqual(['悬念-001']) // 一致 → 声明可用
    expect(readOutlineLeads(root, 5)).toEqual([]) // 不一致 → 置空（旧草稿复检不误报）
    expect(readOutlineLeads(root)).toEqual(['悬念-001']) // 不传章号 → 旧行为

    writeFileSync(join(root, '工作区', '细纲.md'), '---\n推进: 悬念-001\n---\n\n旧格式细纲', 'utf-8')
    expect(readOutlineLeads(root, 5)).toEqual(['悬念-001']) // 旧书无章号 → 宽容沿用
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── V-P1-8：满审预算 = 实际视角数（短篇 5，非硬编码 3）────────────────────────────

test('V-P1-8: 短篇 5 视角满审需 5 次调用（预算 3 只能合审）', () => {
  const caps = { parallel_subagents: true, multiple_calls: true }
  const lenses = ['reader', 'editor', 'hook', 'emotion_peak', 'payoff'] as const
  const d3 = selectReviewTier({ capabilities: caps, remaining_calls: 3, high_risk: false, lenses: [...lenses] })
  expect(d3.ok).toBe(true)
  if (d3.ok) expect(d3.tier).toBe('combined') // 修复前：3 次预算就放行 full（calls:3 ≠ 5 份分包）

  const d5 = selectReviewTier({ capabilities: caps, remaining_calls: 5, high_risk: false, lenses: [...lenses] })
  expect(d5.ok).toBe(true)
  if (d5.ok) {
    expect(d5.tier).toBe('full')
    expect(d5.calls).toBe(5)
  }

  const hr = selectReviewTier({ capabilities: caps, remaining_calls: 3, high_risk: true, lenses: [...lenses] })
  expect(hr.ok).toBe(false) // 高风险章必须满审：3 < 5 → 拒绝而非放行
})

test('V-P1-8: 长篇基础二视角满审 calls = 2', () => {
  const report: CheckReport = { sections: [], byproducts: {} }
  const lenses = buildReviewTasks(report, { hasWiring: false, hasShort: false }).map((t) => t.lens)
  const d = selectReviewTier({ capabilities: { parallel_subagents: true, multiple_calls: true }, remaining_calls: 2, high_risk: false, lenses })
  expect(d.ok).toBe(true)
  if (d.ok) {
    expect(d.tier).toBe('full')
    expect(d.calls).toBe(2)
  }
})

// ── V-P2-17：境界前缀匹配（炼气一层 vs 序列枚举 炼气）───────────────────────────

test('V-P2-17: 当前境界为序列枚举的细化（炼气一层）→ 不误报 growth-realm-miss', async () => {
  const { checkGrowth } = await import('../../src/check/growth.js')
  const db = new DatabaseSync(':memory:')
  createAllTables(db)
  db.prepare(`INSERT INTO leads (id, type, title, status, opened_at, cur_realm, path) VALUES ('成长线-001', '成长线', 't', '进行中', 0, '炼气一层', 'p')`).run()
  const realmDoc: RealmDoc = { 体系: [{ 名称: '修为', 序列: ['炼气', '筑基', '金丹'] }] }
  const r = checkGrowth(db, realmDoc, ['成长线-001'], 2)
  expect(r.items.some((i) => i.checkId === 'growth-realm-miss')).toBe(false) // 修复前：精确 includes 误报红
  db.close()
})

// ── R61-14（第六十一轮）：实际侧（账本推进主文件）按被检章过滤 ────────────────────

test('R61-14: 账本推进章标签与被检章不一致 → 实际侧置空；一致/缺省 → 沿用（V-P2-14 声明侧同向）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'clw-r61-14-'))
  try {
    mkdirSync(join(root, '工作区'), { recursive: true })
    writeFileSync(join(root, '工作区', '账本推进.md'), '# 第6章 账本推进\n\n- 悬念-001 推进：密室尽头的青铜灯亮了\n', 'utf-8')
    expect(leadUpdatesInScopeForChapter(root, 6)).toBe(true) // 一致 → 实际侧可用
    expect(leadUpdatesInScopeForChapter(root, 2)).toBe(false) // 不一致 → 置空（复检旧章不误判「已兑现」）

    writeFileSync(join(root, '工作区', '账本推进.md'), '- 悬念-001 推进：无标签旧文件\n', 'utf-8')
    expect(leadUpdatesInScopeForChapter(root, 2)).toBe(true) // 旧书无标签 → 宽容沿用

    rmSync(join(root, '工作区', '账本推进.md'))
    expect(leadUpdatesInScopeForChapter(root, 2)).toBe(true) // 无文件（无标签同判）→ 沿用（R30-17：读取端为 readChapterUpdatesForChapter，返回 [] 空集无害）
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
