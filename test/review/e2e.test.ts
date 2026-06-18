import { test, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead, syncChapter } from '../../src/cache/sync.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { doConfirm } from '../../src/gate/confirm.js'
import { doFinalize } from '../../src/finalize/commit.js'
import { recordAiCall } from '../../src/ai/calls.js'
import { buildReviewPacket, collectReviewIssues, writeReviewVerdict, readReviewVerdict, lensIssuesFileName, REVIEW_VERDICT_MARKER } from '../../src/review/run.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { ReviewIssue } from '../../src/review/contract.js'

/**
 * 出口验收场景（M4）：账本声明推进，但正文无证据 → 设定校对产出 ledger blocker
 * → 审稿单不成立 → 即使作者想 override 放行，finalize 仍能读裁决；无裁决则拒绝定稿。
 *
 * 这是「账本造假被设定校对逮住」的核心闭环。
 */

/** 造一本有 1 章已定稿、第 2 章正在写的书。账本 伏笔-031 在第 2 章履历里写了「推进」。 */
function makeBookWithLedgerClaim(): { root: string; workDir: string } {
  const root = mkdtempSync(join(tmpdir(), '账本造假-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email test@test.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name test', { cwd: root, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })

  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })

  // 缓存：伏笔-031 第 1 章埋下、第 2 章推进（本章待审）
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  syncLead(db, {
    编号: '伏笔-031', 标题: '灭门真凶', 类型: '伏笔', 状态: '进行中', 开启章: 1,
    履历: [
      { 章号: 1, 动词: '埋下', 证据: '焦痕' },
      { 章号: 2, 动词: '推进', 证据: '他终于看见焦痕背后的掌印。' },
    ],
    _path: join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'),
  })
  syncChapter(db, { 章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' })
  db.close()

  // 账本 md（履历含第 2 章推进声明）
  writeFileSync(
    join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'),
    '---\n编号: 伏笔-031\n标题: 灭门真凶\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：焦痕\n- 第002章 推进：他终于看见焦痕背后的掌印。\n',
    'utf-8',
  )

  execSync('git add -A', { cwd: root, stdio: 'pipe' })
  execSync('git commit -m "init"', { cwd: root, stdio: 'pipe' })

  return { root, workDir: join(root, '工作区') }
}

test('端到端: 账本声明推进但正文无证据 → 设定校对 ledger blocker → finalize 无裁决拒绝', () => {
  const { root, workDir } = makeBookWithLedgerClaim()

  // 1. 工作区准备：细纲确认 + 草稿（正文刻意不写掌印推进，制造「账本造假」）
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '第2章细纲：主角发现线索。', 'utf-8')
  doConfirm(workDir, 2, outline, 'manual', DEFAULT_CONFIG)
  writeFileSync(
    join(workDir, '草稿-1.md'),
    '---\n章号: 2\n标题: 第二章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n主角走进房间，看了看四周。什么也没发生。\n',
    'utf-8',
  )

  // 2. 三审执行包：满审，账本清单进设定校对
  const built = buildReviewPacket({
    checkReport: {
      sections: [],
      byproducts: {
        // 机检算出的本章账本变动（伏笔-031 第 2 章推进）→ 设定校对要核对
        leadChanges: [{ leadId: '伏笔-031', chapter: 2, verb: '推进', evidence: '他终于看见焦痕背后的掌印。' }],
      },
    },
    body: '主角走进房间，看了看四周。什么也没发生。',
    chapter: 2,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
  })
  expect(built.ok).toBe(true)
  if (!built.ok) return

  // 3. 宿主回写 issues：设定校对逮到账本造假（正文无掌印证据）
  mkdirSync(built.packet.out_dir, { recursive: true })
  writeFileSync(join(built.packet.out_dir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(built.packet.out_dir, lensIssuesFileName('editor')), '[]', 'utf-8')
  const continuityIssues: ReviewIssue[] = [
    {
      lens: 'continuity',
      severity: 'S2',
      category: 'ledger',
      location: '第2章正文',
      evidence: ['正文只写「看了看四周，什么也没发生」，未见掌印推进描写'],
      issue: '账本 伏笔-031 声明第2章「推进」，但正文无对应证据，疑似账本造假。',
      fix: '补出掌印推进的具体描写，或修正账本动词为「提及」。',
    },
  ]
  writeFileSync(join(built.packet.out_dir, lensIssuesFileName('continuity')), JSON.stringify(continuityIssues), 'utf-8')

  // 4. collect → 归一化 → 写审稿单
  const collected = collectReviewIssues({ packet: built.packet })
  expect(collected.ok).toBe(true)
  const ledgerBlockers = collected.normalized.blockers.filter((i) => i.category === 'ledger')
  expect(ledgerBlockers).toHaveLength(1)
  expect(ledgerBlockers[0]!.issue).toContain('账本造假')
  expect(collected.normalized.passed).toBe(false) // 审稿单不成立

  const verdictPath = writeReviewVerdict(workDir, collected)
  const verdictText = readFileSync(verdictPath, 'utf-8')
  expect(verdictText).toContain('账本核对阻断')
  expect(verdictText).toContain('疑似账本造假')

  // 5. finalize 前置闸：审稿单未裁决（作者没拍板）→ 拒绝
  expect(readReviewVerdict(workDir).approved).toBe(false)
  const ch: ChapterMeta = { 章号: 2, 标题: '第二章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const r1 = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '主角走进房间，看了看四周。什么也没发生。', fileName: '2-第二章.md',
    hasReviewVerdict: readReviewVerdict(workDir).approved,
  })
  expect(r1.ok).toBe(false)
  if (!r1.ok) expect(r1.reason).toContain('拍板')
  db.close()

  rmSync(root, { recursive: true, force: true })
})

test('端到端: 作者 override 放行账本阻断 → finalize 读裁决通过（作者自负）', () => {
  const { root, workDir } = makeBookWithLedgerClaim()
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '第2章细纲。', 'utf-8')
  doConfirm(workDir, 2, outline, 'manual', DEFAULT_CONFIG)
  writeFileSync(
    join(workDir, '草稿-1.md'),
    '---\n章号: 2\n标题: 第二章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n正文。\n',
    'utf-8',
  )

  // 三审跑出 ledger blocker，但作者判断可放行，显式 override
  const built = buildReviewPacket({
    checkReport: { sections: [], byproducts: { leadChanges: [{ leadId: '伏笔-031', chapter: 2, verb: '推进', evidence: '掌印' }] } },
    body: '正文。', chapter: 2, workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8, high_risk: false,
  })
  if (!built.ok) return
  mkdirSync(built.packet.out_dir, { recursive: true })
  writeFileSync(join(built.packet.out_dir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(built.packet.out_dir, lensIssuesFileName('editor')), '[]', 'utf-8')
  writeFileSync(join(built.packet.out_dir, lensIssuesFileName('continuity')), JSON.stringify([
    { lens: 'continuity', severity: 'S2', category: 'ledger', location: '正文', evidence: ['无推进'], issue: '账本造假', fix: '补' },
  ]), 'utf-8')
  const collected = collectReviewIssues({ packet: built.packet })
  const verdictPath = writeReviewVerdict(workDir, collected)

  // 作者 override 放行
  const text = readFileSync(verdictPath, 'utf-8')
  writeFileSync(verdictPath, `${text}\n${REVIEW_VERDICT_MARKER} verdict: 通过\n${REVIEW_VERDICT_MARKER} override: 已人工核对账本\n`, 'utf-8')

  const verdict = readReviewVerdict(workDir)
  expect(verdict.approved).toBe(true)
  expect(verdict.hasOverride).toBe(true)
  expect(verdict.overrideReason).toContain('人工核对')

  // finalize 读裁决通过（作者自负放行）
  const ch: ChapterMeta = { 章号: 2, 标题: '第二章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '正文。', fileName: '2-第二章.md',
    hasReviewVerdict: verdict.approved,
  })
  expect(r.ok).toBe(true)
  db.close()

  rmSync(root, { recursive: true, force: true })
})

test('端到端: 三审 collect 记账调用预算（满审 +3）', () => {
  const { root, workDir } = makeBookWithLedgerClaim()
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '第2章细纲。', 'utf-8')
  doConfirm(workDir, 2, outline, 'manual', DEFAULT_CONFIG)

  // 三审 collect 后应记账 +3（满审）
  recordAiCall({ workDir, chapter: 2, config: DEFAULT_CONFIG, step: 'outline', calls: 2, at: '2026-06-18T00:00:00.000Z' })

  const built = buildReviewPacket({
    checkReport: { sections: [], byproducts: { leadChanges: [] } },
    body: '正文。', chapter: 2, workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 6, high_risk: false,
  })
  if (!built.ok) return
  mkdirSync(built.packet.out_dir, { recursive: true })
  writeFileSync(join(built.packet.out_dir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(built.packet.out_dir, lensIssuesFileName('editor')), '[]', 'utf-8')
  writeFileSync(join(built.packet.out_dir, lensIssuesFileName('continuity')), '[]', 'utf-8')

  // collect 后记账 +3
  const recorded = recordAiCall({ workDir, chapter: 2, config: DEFAULT_CONFIG, step: 'review', calls: 3 })
  expect(recorded.ok).toBe(true)
  if (recorded.ok) expect(recorded.record.used).toBe(5) // 2 outline + 3 review

  rmSync(root, { recursive: true, force: true })
})
