/**
 * B3+B4 规则命中统计 + 反馈前置单测。
 *
 * 覆盖：
 * 1. recordRuleHits / readRuleHits / topRuleHits（命中统计）
 * 2. rulesToPrompt 的 B4 前置注入（高频违规预防指令）
 *
 * 测试自包含，临时目录 mkdtempSync 创建、rmSync 清理。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordRuleHits, readRuleHits, topRuleHits } from '../../src/ai/rule-hits.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { rulesToPrompt } from '../../src/ai/rules/index.js'
import type { RuleViolation } from '../../src/ai/rules/index.js'

describe('B3 规则命中统计（rule-hits.ts）', () => {
  let bookRoot: string
  const aiCliche: RuleViolation = { ruleId: 'ai-cliche', level: 'yellow', message: 'AI高频套话「值得一提的是」——删除或替换为具体描写' }
  const styleHit: RuleViolation = { ruleId: 'style-consistency', level: 'yellow', message: '句长方差 45.2 偏离基线 20.0（偏高 126%），建议调整句式节奏' }

  beforeAll(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-rule-hits-'))
  })

  afterAll(() => {
    if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
  })

  it('空库（无 .cache/rule-hits.json）readRuleHits 返回空数组', () => {
    expect(readRuleHits(bookRoot)).toEqual([])
    expect(topRuleHits(bookRoot, 3)).toEqual([])
  })

  it('recordRuleHits 记录违规 → readRuleHits 按 hits 降序', () => {
    recordRuleHits(bookRoot, [aiCliche, styleHit])
    const hits = readRuleHits(bookRoot)
    expect(hits).toHaveLength(2)
    expect(hits[0]!.ruleId).toBe('ai-cliche')
    expect(hits[0]!.hits).toBe(1)
    expect(hits[0]!.recentMessages[0]).toContain('值得一提的是')
    expect(existsSync(join(bookRoot, '.cache', 'rule-hits.json'))).toBe(true)
  })

  it('多次命中累加 + recentMessages 保留最近 5 条', () => {
    recordRuleHits(bookRoot, [aiCliche])
    recordRuleHits(bookRoot, [styleHit, styleHit])
    const hits = readRuleHits(bookRoot)
    const cliche = hits.find((h) => h.ruleId === 'ai-cliche')!
    const style = hits.find((h) => h.ruleId === 'style-consistency')!
    expect(cliche.hits).toBe(2)
    expect(style.hits).toBe(3)
    expect(style.recentMessages.length).toBeLessThanOrEqual(5)
  })

  it('topRuleHits 取 Top-N', () => {
    const top = topRuleHits(bookRoot, 1)
    expect(top).toHaveLength(1)
    expect(top[0]!.ruleId).toBe('style-consistency') // hits=3 最高
  })
})

describe('B4 反馈前置（rulesToPrompt 预防指令）', () => {
  let bookRoot: string

  beforeAll(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-prevention-'))
    // 造一条命中：ai-cliche 已检出 2 次
    const v: RuleViolation = { ruleId: 'ai-cliche', level: 'yellow', message: 'AI高频套话「不禁」——删除或替换为具体描写' }
    recordRuleHits(bookRoot, [v, v])
  })

  afterAll(() => {
    if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
  })

  it('有命中时 rulesToPrompt 含「本书近期常见问题」+ 中文标签 + 命中次数', () => {
    const text = rulesToPrompt('self-heal', bookRoot)
    expect(text).toContain('本书近期常见问题')
    expect(text).toContain('AI高频套话')
    expect(text).toContain('已被检出 2 次')
    expect(text).toContain('不禁')
  })

  it('无命中时 rulesToPrompt 不含预防指令（行为同现状）', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'clwriting-prevention-empty-'))
    try {
      const text = rulesToPrompt('self-heal', emptyRoot)
      expect(text).not.toContain('本书近期常见问题')
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })

  it('bookRoot 为空时零注入', () => {
    const text = rulesToPrompt('self-heal', undefined)
    expect(text).not.toContain('本书近期常见问题')
    // 仍含内置规则约束（ai-cliche）
    expect(text).toContain('避免AI味')
  })
})

describe('F1-P3 rule/hit 事件化（可选 userDataPath 双写）', () => {
  it('带 userDataPath → workspace 会话写 rule/hit 事件；缺省不写', () => {
    const root = mkdtempSync(join(tmpdir(), 'clwriting-rule-hits-ev-'))
    try {
      const ud = mkdtempSync(join(tmpdir(), 'clwriting-rule-hits-ud-'))
      try {
        const v: RuleViolation = { ruleId: 'ai-cliche', level: 'yellow', message: 'AI高频词' }
        // 缺省（无 userDataPath）：不写事件
        recordRuleHits(root, [v])
        const store0 = openSessionStore(ud, root)!
        try {
          expect(store0.listEvents(bookHash(root))).toHaveLength(0)
        } finally {
          store0.close()
        }
        // 带 userDataPath：写事件
        recordRuleHits(root, [v], ud)
        const store = openSessionStore(ud, root)!
        try {
          const evs = store.listEvents(bookHash(root))
          const rules = evs.filter((e) => e.type === 'rule/hit')
          expect(rules).toHaveLength(1)
          expect(rules[0]!.data).toMatchObject({ ruleId: 'ai-cliche', task: 'check' })
        } finally {
          store.close()
        }
      } finally {
        rmSync(ud, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('json 读路径不受影响（双写兼容）', () => {
    const root = mkdtempSync(join(tmpdir(), 'clwriting-rule-hits-json-'))
    try {
      const v: RuleViolation = { ruleId: 'banned-word', level: 'red', message: '命中禁词' }
      recordRuleHits(root, [v], undefined)
      const hits = readRuleHits(root)
      expect(hits).toHaveLength(1)
      expect(hits[0]!.ruleId).toBe('banned-word')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})