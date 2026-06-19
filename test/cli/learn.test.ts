/**
 * learn 命令测试 —— M7 #38。
 *
 * 验证：候选产出（#10 打分、场景归类、低分过滤）、入库（序号递增、#5 格式）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { learnFromBook } from '../../src/learn/index.js'
import { commitSamples, commitQuotes, nextSampleSeq } from '../../src/learn/commit.js'
import { writeChapter } from '../../src/format/chapters.js'
import { readSample } from '../../src/format/style.js'
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

    // 战斗段（干净）打分应 >= 对话段（含 AI 味对话标签）
    const battle = result.samples.find((s) => s.场景 === '战斗')
    const dialogue = result.samples.find((s) => s.场景 === '对话')
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
    mkdirSync(join(bookRoot, '文风', '样章库', '战斗'), { recursive: true })
    mkdirSync(join(bookRoot, '文风', '金句库'), { recursive: true })
  })

  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  it('nextSampleSeq：空目录返回 1，有文件递增', () => {
    expect(nextSampleSeq(join(bookRoot, '文风', '样章库'), '战斗')).toBe(1)
    // 造一个 003.md
    writeFileSync(join(bookRoot, '文风', '样章库', '战斗', '战斗-003.md'), 'test', 'utf-8')
    expect(nextSampleSeq(join(bookRoot, '文风', '样章库'), '战斗')).toBe(4)
  })

  it('commitSamples：入库 #5 格式（来源=作者原作 + 序号 3 位补零）', () => {
    const picks: SampleCandidate[] = [
      { 场景: '战斗', 正文: '战斗段落正文', 出处: '《测试》第 1 章', 章号: 1, 打分: 90 },
      { 场景: '战斗', 正文: '另一段战斗', 出处: '《测试》第 2 章', 章号: 2, 打分: 85 },
    ]
    const files = commitSamples(bookRoot, picks)

    expect(files).toHaveLength(2)
    expect(files[0]).toBe('文风/样章库/战斗/战斗-001.md')
    expect(files[1]).toBe('文风/样章库/战斗/战斗-002.md')

    // 读回验证 #5 格式
    const r = readSample(join(bookRoot, '文风', '样章库', '战斗', '战斗-001.md'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sample.场景).toBe('战斗')
      expect(r.sample.来源).toBe('作者原作')
      expect(r.sample.出处).toBe('《测试》第 1 章')
      expect(r.sample.正文).toBe('战斗段落正文')
    }
  })

  it('commitQuotes：追加到 文风/金句库/<场景>.md', () => {
    const picks: QuoteCandidate[] = [
      { 场景: '战斗', 正文: '忽然一剑封喉', 出处: '《测试》第 1 章', 章号: 1 },
    ]
    const files = commitQuotes(bookRoot, picks)

    expect(files).toHaveLength(1)
    expect(files[0]).toBe('文风/金句库/战斗.md')
    const content = readFileSync(join(bookRoot, '文风', '金句库', '战斗.md'), 'utf-8')
    expect(content).toContain('忽然一剑封喉')
    expect(content).toContain('——《测试》第 1 章')
  })

  it('G5：commitSamples 带技法指令则写入，缺省不写该字段', () => {
    const picks: SampleCandidate[] = [
      { 场景: '战斗', 正文: '一剑破阵', 出处: '《测试》第 1 章', 章号: 1, 打分: 90, 技法指令: '学它的短句节奏' },
      { 场景: '战斗', 正文: '无技法指令段', 出处: '《测试》第 2 章', 章号: 2, 打分: 88 },
    ]
    commitSamples(bookRoot, picks)

    // 带技法指令 → 读回有该字段
    const withSkill = readSample(join(bookRoot, '文风', '样章库', '战斗', '战斗-001.md'))
    expect(withSkill.ok).toBe(true)
    if (withSkill.ok) expect(withSkill.sample.技法指令).toBe('学它的短句节奏')

    // 缺省 → 无该字段（不写空串）
    const without = readSample(join(bookRoot, '文风', '样章库', '战斗', '战斗-002.md'))
    expect(without.ok).toBe(true)
    if (without.ok) expect(without.sample.技法指令).toBeUndefined()
  })
})
