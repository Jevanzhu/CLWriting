/**
 * R34D-3（三十四轮）回归：定稿闸锁内重读——履历回写不得消费锁外预解析快照。
 *
 * 缺陷：resolveLeadUpdateTargets 在布线锁/清单锁外解析 updates（ff-P1-1 注释宣称
 * 「闸看到的=回写要写的」），applyLeadUpdatesLocked 却按陈旧 targets.updates 回写履历
 * 并清空主文件。账本推进.md 在编辑器白名单内，作者在锁等待窗（~10s）内删改账目 →
 * 旧快照仍写入履历、新措辞被无痕清空（R33D-4 锁内复核只查章标签不查内容）。
 *
 * 修法：LeadUpdateTargets 增加 bookRoot；持锁核心开头对主文件/归档重跑
 * readChapterUpdatesForChapter，以重读结果生成履历条目与 residue。
 *
 * 测法（行为级，单进程直接函数调用模拟锁窗）：
 *   resolveLeadUpdateTargets（= finalize 锁外预解析）→ 模拟作者在锁窗内删改主文件
 *   → applyLeadUpdatesLocked（= 持锁核心）→ 断言回写结果与改后内容一致。
 */
import { test, expect, describe, it, vi } from 'vitest'
import { rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { scaffoldBook } from '../helpers/book.js'
import { join } from 'node:path'
// existsSync 条件注入（默认不武装）：对指定线索文件路径条件性返 false——模拟
// 「读到源文件成功、writeLead 落位前复核点盘面已无源文件」的竞态时序；readFileSync 等
// 其余全部透传真 fs（读到源文件成功的前提）。
const ghost = vi.hoisted(() => ({ absentPath: null as string | null }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (p: string) => {
      if (typeof p === 'string' && p === ghost.absentPath) return false
      return actual.existsSync(p)
    },
  }
})

import { resolveLeadUpdateTargets, applyLeadUpdatesLocked } from '../../src/document/lead-finalize.js'
import { readLead } from '../../src/format/leads.js'

const SENTENCE_A = '玉佩在火光里泛出微芒。'
const SENTENCE_B = '山门外的钟声在雨夜里连响了三下。'

/** 造一本长篇书骨架：正文第 1 章 + 两条布线悬念线（履历空）+ 工作区。 */
function makeBook(): string {
  const { root } = scaffoldBook({
    prefix: 'r34d-lead-reread-',
    flatRoot: true, // 原盘面：root 即临时目录（无书名子层）
    dirs: ['工作区'],
    files: [
      { rel: '写作/正文/0001-开篇.md', content: `---\n章号: 1\n标题: 开篇\n---\n\n${SENTENCE_A}\n` },
      {
        rel: '布线/悬念/悬念-001-玉佩.md',
        content: '---\n编号: 悬念-001\n标题: 玉佩\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
      },
      {
        rel: '布线/悬念/悬念-002-钟声.md',
        content: '---\n编号: 悬念-002\n标题: 钟声\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
      },
    ],
  })
  return root
}

function leadFile(root: string, name: string): string {
  return join(root, '布线', '悬念', name)
}

function historyOf(root: string, name: string): { 章号: number; 动词: string; 证据: string }[] {
  const r = readLead(leadFile(root, name))
  expect(r.ok).toBe(true)
  if (!r.ok) return []
  return r.lead.履历
}

test('R34D-3: 锁窗内证据措辞被作者改写 → 履历回写新措辞（旧快照不复活）', () => {
  const root = makeBook()
  try {
    const main = join(root, '工作区', '账本推进.md')
    writeFileSync(main, `# 第1章 账本推进\n- 悬念-001 递进：${SENTENCE_A}\n`, 'utf-8')
    // finalize 锁外预解析（快照 = 旧措辞）
    const targets = resolveLeadUpdateTargets(root, 1)
    expect(targets.updates).toHaveLength(1)
    expect(targets.bookRoot).toBe(root)
    // 锁等待窗内作者改写证据措辞
    const EDITED = '玉佩在火光里泛出微芒，裂了一道缝。'
    writeFileSync(main, `# 第1章 账本推进\n- 悬念-001 递进：${EDITED}\n`, 'utf-8')
    // 持锁核心：以重读结果回写
    const applied = applyLeadUpdatesLocked(1, targets)
    expect(applied).toBe(1)
    const hist = historyOf(root, '悬念-001-玉佩.md')
    expect(hist).toEqual([{ 章号: 1, 动词: '递进', 证据: EDITED }])
    // 回写后主文件清空（无残留）
    expect(readFileSync(main, 'utf-8')).toBe('')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R34D-3: 锁窗内作者删除一条 → 该条既不回写也不进 residue（尊重删除）', () => {
  const root = makeBook()
  try {
    const main = join(root, '工作区', '账本推进.md')
    writeFileSync(main, `# 第1章 账本推进\n- 悬念-001 递进：${SENTENCE_A}\n- 悬念-002 递进：${SENTENCE_B}\n`, 'utf-8')
    const targets = resolveLeadUpdateTargets(root, 1)
    expect(targets.updates).toHaveLength(2)
    // 锁窗内作者删除 悬念-002 条目
    writeFileSync(main, `# 第1章 账本推进\n- 悬念-001 递进：${SENTENCE_A}\n`, 'utf-8')
    const applied = applyLeadUpdatesLocked(1, targets)
    expect(applied).toBe(1)
    // 幸存条目正常回写
    expect(historyOf(root, '悬念-001-玉佩.md')).toEqual([{ 章号: 1, 动词: '递进', 证据: SENTENCE_A }])
    // 被删条目：不回写、不留 residue 警告
    expect(historyOf(root, '悬念-002-钟声.md')).toEqual([])
    expect(readFileSync(main, 'utf-8')).toBe('')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R34D-3: 锁窗内新增条目（布线锁未预取）→ 不落写，走 not-found 通道留源待重试', () => {
  const root = makeBook()
  try {
    const main = join(root, '工作区', '账本推进.md')
    writeFileSync(main, `# 第1章 账本推进\n- 悬念-001 递进：${SENTENCE_A}\n`, 'utf-8')
    const targets = resolveLeadUpdateTargets(root, 1)
    expect(targets.files.has('悬念-002')).toBe(false)
    // 锁窗内作者追加 悬念-002 条目（该线的布线锁未在预取集内）
    writeFileSync(main, `# 第1章 账本推进\n- 悬念-001 递进：${SENTENCE_A}\n- 悬念-002 递进：${SENTENCE_B}\n`, 'utf-8')
    const applied = applyLeadUpdatesLocked(1, targets)
    // 已持锁的 001 正常回写；002 不写未持锁文件（fail-closed），走 not-found 留源
    expect(applied).toBe(1)
    expect(historyOf(root, '悬念-001-玉佩.md')).toEqual([{ 章号: 1, 动词: '递进', 证据: SENTENCE_A }])
    expect(historyOf(root, '悬念-002-钟声.md')).toEqual([])
    // residue 写回本章源：002 条目保留 + 处置指引可见（不静默丢弃）
    const residue = readFileSync(main, 'utf-8')
    expect(residue).toContain('悬念-002')
    expect(residue).toContain(SENTENCE_B)
    expect(residue).toContain('查无此线')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R34D-3: 未改场景行为不变——快照与盘上一致时照常回写并清空', () => {
  const root = makeBook()
  try {
    const main = join(root, '工作区', '账本推进.md')
    writeFileSync(main, `# 第1章 账本推进\n- 悬念-001 递进：${SENTENCE_A}\n- 悬念-002 递进：${SENTENCE_B}\n`, 'utf-8')
    const targets = resolveLeadUpdateTargets(root, 1)
    const applied = applyLeadUpdatesLocked(1, targets)
    expect(applied).toBe(2)
    expect(historyOf(root, '悬念-001-玉佩.md')).toEqual([{ 章号: 1, 动词: '递进', 证据: SENTENCE_A }])
    expect(historyOf(root, '悬念-002-钟声.md')).toEqual([{ 章号: 1, 动词: '递进', 证据: SENTENCE_B }])
    expect(readFileSync(main, 'utf-8')).toBe('')
    // 归档路径不涉及：无归档文件
    expect(existsSync(join(root, '工作区', '.账本推进暂存', '第1章.md'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 布线回写 writeLead 落位前的旧路径 existsSync 复核：跨进程结构性移动（link+rm）恰在
// 「持锁读到源文件 → writeLead」毫秒窗内搬走线索源文件时，writeLead → atomicWriteFile 的
// mkdir recursive 会在旧路径复活幽灵线索文件（同编号双文件）。修后：复核不存在 → 放弃
// 该条按既有 not-found 分支处理（留源不写，下次定稿重解析自动重试）。──

describe('writeLead 落位前旧路径复核（幽灵复活守卫）', () => {
  const LEAD_REL = '布线/悬念/悬念-001-灭门真凶.md'

  /** 造一本带布线的短书 + 一条悬念线 + 账本推进.md（真 fs，不开 mock 旗） */
  function makeGhostBook(): string {
    const { root } = scaffoldBook({
      prefix: 'r43-lead-ghost-',
      flatRoot: true, // 原盘面：root 即临时目录（无书名子层）
      files: [
        {
          rel: LEAD_REL,
          content: '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
        },
        { rel: '工作区/账本推进.md', content: '- 悬念-001 递进：焦痕在烛火下泛着暗红。\n' },
      ],
    })
    return root
  }

  it('读到源文件后被搬走（复核 existsSync=false）→ 放弃本条：不复活幽灵、留源不写', () => {
    const root = makeGhostBook()
    const leadPath = join(root, LEAD_REL)
    const targets = resolveLeadUpdateTargets(root, 3) // 锁外预取（真 fs，解析到目标文件）
    expect(targets.updates.length).toBe(1)
    expect(targets.files.get('悬念-001')).toBe(leadPath)
    // 竞态时序注入：readFileSync 读到源文件成功、writeLead 落位前复核点盘面已无源文件
    ghost.absentPath = leadPath
    try {
      const n = applyLeadUpdatesLocked(3, targets)
      expect(n).toBe(0) // 放弃本条（not-found 通道），不 writeLead
    } finally {
      ghost.absentPath = null
    }
    // 线索文件内容原样：修复前 writeLead → atomicWriteFile（mkdir recursive + rename）
    // 会在旧路径复活含新履历行的幽灵文件（内容会出现「第003章」——履历行章号按现有
    // 补零口径 3 位）
    const after = readFileSync(leadPath, 'utf-8')
    expect(after).not.toContain('第003章')
    expect(after).not.toContain('递进')
    // 本章源未动（applied=0 不清空——条目留源，下次定稿自动重试）
    expect(readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')).toBe('- 悬念-001 递进：焦痕在烛火下泛着暗红。\n')
  })

  it('对照：复核通过（文件仍在）→ 正常回写履历（mock 旗关闭，守卫不误伤 happy path）', () => {
    const root = makeGhostBook()
    const leadPath = join(root, LEAD_REL)
    const targets = resolveLeadUpdateTargets(root, 3)
    expect(applyLeadUpdatesLocked(3, targets)).toBe(1)
    const after = readFileSync(leadPath, 'utf-8')
    expect(after).toContain('第003章')
    expect(after).toContain('递进：焦痕在烛火下泛着暗红。')
  })
})
