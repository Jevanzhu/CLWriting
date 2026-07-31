/**
 * learn 命令测试 —— M7 #38。
 *
 * 验证：候选产出（#10 打分、低分过滤）、入库（条目库样章条目，S8）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { learnFromBook } from '../../src/learn/index.js'
import { commitSamples, commitQuotes } from '../../src/learn/commit.js'
import { writeChapter } from '../../src/format/chapters.js'
import { readEntries, ENTRIES_DIR } from '../../src/format/style-entry.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { SampleCandidate, QuoteCandidate } from '../../src/learn/index.js'

describe('learnFromBook', () => {
  let bookRoot: string

  beforeEach(() => {
    bookRoot = join(tmpdir(), `clwriting-learn-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(bookRoot, { recursive: true })
    mkdirSync(join(bookRoot, '定稿', '正文'), { recursive: true })

    // 写入测试章节：战斗段（干净，高分）+ 对话段（含 AI 味「微笑着地说」，扣分）
    const chapters: Array<{ 章号: number; 标题: string; body: string }> = [
      {
        章号: 1,
        标题: '战斗章',
        body: `剑光闪过，他猛然挥剑斩向敌人。敌人闪避不及，被刺中要害。鲜血喷涌而出，染红了整片天空。这场战斗已经持续了整整三个时辰，双方都已经筋疲力尽。

忽然间，他抓住破绽，一剑刺穿了敌人的心脏。敌人惊恐地看着他，缓缓倒下，眼中满是不甘和绝望。这场漫长的战斗终于结束了。`,
      },
      {
        章号: 2,
        标题: '对话章',
        body: `"你来了。"她微笑着地说，眼中满是期待和喜悦。阳光透过窗户洒在她的脸上，让她显得格外温柔动人。

"我答应过会来的。"他回答道，声音中带着一丝歉意和深情。他紧紧握住她的手，感受着她的温度。`,
      },
    ]
    for (const ch of chapters) {
      const meta: ChapterMeta = {
        章号: ch.章号, 标题: ch.标题, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
        _path: '', _wordCount: ch.body.length,
      }
      writeChapter(join(bookRoot, '定稿', '正文', `${ch.章号}-${ch.标题}.md`), meta, ch.body)
    }

    // book.yaml + 文风铁律（scaffold 的默认模板）
    writeFileSync(
      join(bookRoot, 'book.yaml'),
      'spec_version: 1\n\nbook:\n  title: 测试书名\n  genre: 玄幻\n\nleads:\n  enabled: [主线]\n',
      'utf-8',
    )
    mkdirSync(join(bookRoot, '文风'), { recursive: true })
    writeFileSync(
      join(bookRoot, '文风', '文风铁律.md'),
      '# 文风铁律\n\n## 反和解段（AI 味防御）\n\n（待补）\n\n## 可量化约束\n\n- 对话占比：目标 30–50%\n- 平均句长：目标 15–25 字\n',
      'utf-8',
    )
  })

  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  it('产出样章+金句候选，落 工作区/learn候选/', () => {
    const result = learnFromBook(bookRoot)

    expect(result.ok).toBe(true)
    expect(result.sampleCount).toBeGreaterThan(0)
    expect(result.candidateDir).toBe('工作区/learn候选')
    expect(result.samples).toBeDefined()

    // 候选文件落盘
    const sampleDir = join(bookRoot, '工作区', 'learn候选', '样章')
    expect(existsSync(sampleDir)).toBe(true)
    const sampleFiles = readdirSync(sampleDir).filter((f) => f.endsWith('.md'))
    expect(sampleFiles.length).toBe(result.sampleCount)

    // 候选 front matter 格式
    if (sampleFiles.length > 0) {
      const first = readFileSync(join(sampleDir, sampleFiles[0]!), 'utf-8')
      expect(first).toContain('场景:')
      expect(first).toContain('来源: 作者原作')
      expect(first).toContain('打分:')
      expect(first).toContain('---')
    }
  })

  it('打分用 #10：含「微笑着地说」的段落扣分低于干净段落', () => {
    const result = learnFromBook(bookRoot)
    expect(result.ok).toBe(true)
    if (!result.samples) return

    // 战斗段（干净，第 1 章）打分应 >= 对话段（含 AI 味对话标签，第 2 章）
    const battle = result.samples.find((s) => s.章号 === 1)
    const dialogue = result.samples.find((s) => s.章号 === 2)
    if (battle && dialogue) {
      expect(battle.打分).toBeGreaterThanOrEqual(dialogue.打分)
    }
  })

  it('空书报错', () => {
    const empty = join(tmpdir(), `clwriting-learn-empty-${Date.now()}`)
    mkdirSync(empty, { recursive: true })
    const result = learnFromBook(empty)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('没有定稿正文可收割')
    rmSync(empty, { recursive: true, force: true })
  })
})

describe('commitSamples / commitQuotes', () => {
  let bookRoot: string

  beforeEach(() => {
    bookRoot = join(tmpdir(), `clwriting-commit-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(bookRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  it('commitSamples：入条目库样章条目（来源=收割 + 序号 3 位补零）', () => {
    const picks: SampleCandidate[] = [
      { 场景: '通用', 正文: '战斗段落正文', 出处: '《测试》第 1 章', 章号: 1, 打分: 90 },
      { 场景: '通用', 正文: '另一段战斗', 出处: '《测试》第 2 章', 章号: 2, 打分: 85 },
    ]
    const files = commitSamples(bookRoot, picks)

    expect(files).toHaveLength(2)
    expect(files[0]).toBe('文风/条目/样章/通用-001.md')
    expect(files[1]).toBe('文风/条目/样章/通用-002.md')

    // 读回验证条目字段
    const { entries, errors } = readEntries(join(bookRoot, ENTRIES_DIR), '样章')
    expect(errors).toHaveLength(0)
    const first = entries.find((e) => e.出处 === '《测试》第 1 章')
    expect(first).toBeDefined()
    expect(first?.来源).toBe('收割')
    expect(first?.场景).toBe('通用')
    expect(first?.正文).toBe('战斗段落正文')
  })

  it('commitQuotes：金句作为样章条目入库（标签带 金句）', () => {
    const picks: QuoteCandidate[] = [
      { 场景: '通用', 正文: '忽然一剑封喉', 出处: '《测试》第 1 章', 章号: 1 },
    ]
    const files = commitQuotes(bookRoot, picks)

    expect(files).toHaveLength(1)
    expect(files[0]).toBe('文风/条目/样章/通用-001.md')
    const { entries } = readEntries(join(bookRoot, ENTRIES_DIR), '样章')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.标签).toContain('金句')
    expect(entries[0]?.正文).toBe('忽然一剑封喉')
    expect(entries[0]?.出处).toBe('《测试》第 1 章')
  })

  it('G5：commitSamples 带技法指令则落 说明 字段，缺省不写该字段', () => {
    const picks: SampleCandidate[] = [
      { 场景: '通用', 正文: '一剑破阵', 出处: '《测试》第 1 章', 章号: 1, 打分: 90, 技法指令: '学它的短句节奏' },
      { 场景: '通用', 正文: '无技法指令段', 出处: '《测试》第 2 章', 章号: 2, 打分: 88 },
    ]
    commitSamples(bookRoot, picks)

    const { entries } = readEntries(join(bookRoot, ENTRIES_DIR), '样章')
    // 带技法指令 → 说明 写入
    const withSkill = entries.find((e) => e.出处 === '《测试》第 1 章')
    expect(withSkill?.说明).toBe('学它的短句节奏')

    // 缺省 → 无该字段（不写空串）
    const without = entries.find((e) => e.出处 === '《测试》第 2 章')
    expect(without).toBeDefined()
    expect(without?.说明).toBeUndefined()
  })
})
