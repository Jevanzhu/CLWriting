/**
 * draft-pipeline 单测（第十一轮 P1-TST-2）：
 * buildDraftPrompt 长短篇分支 + 上下文组装。
 *
 * snapshotBeforeOverwrite / saveDraft 涉及 manifest + tree + git 多模块交互，
 * 此处聚焦 buildDraftPrompt 的 prompt 组装正确性（AI 写稿质量根基）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDraftPrompt } from '../../src/process/draft-pipeline.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clw-draft-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('buildDraftPrompt: 长篇', () => {
  it('基本结构 → 含任务/要求段', () => {
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).toContain('长篇')
    expect(p).toContain('2000-4000 字')
    expect(p).toContain('章尾留钩')
  })

  it('有细纲 → 含细纲段', () => {
    mkdirSync(join(dir, '工作区'), { recursive: true })
    writeFileSync(join(dir, '工作区', '细纲.md'), '细纲内容：主角登场')
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).toContain('细纲内容：主角登场')
  })

  it('无细纲 → 不含细纲段', () => {
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).not.toContain('本章细纲')
  })

  it('有世界观 → 含世界观段（截断 1200 字）', () => {
    mkdirSync(join(dir, '设定'), { recursive: true })
    writeFileSync(join(dir, '设定', '世界观.md'), '修仙世界，灵气复苏')
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).toContain('修仙世界')
  })
})

describe('buildDraftPrompt: 短篇', () => {
  it('基本结构 → 含短篇要求', () => {
    const p = buildDraftPrompt(dir, 1, 'short')
    expect(p).toContain('短篇')
    expect(p).toContain('8000-20000 字')
    expect(p).toContain('铺垫→反转→收尾')
  })

  it('有细纲+章纲+备料 → 全部拼入', () => {
    mkdirSync(join(dir, '工作区'), { recursive: true })
    writeFileSync(join(dir, '工作区', '细纲.md'), '短篇细纲')
    writeFileSync(join(dir, '工作区', '本章写作材料.md'), '参考材料')
    mkdirSync(join(dir, '大纲', '章纲'), { recursive: true })
    writeFileSync(join(dir, '大纲', '章纲', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n章纲详情')
    const p = buildDraftPrompt(dir, 1, 'short')
    expect(p).toContain('短篇细纲')
    expect(p).toContain('参考材料')
    expect(p).toContain('章纲详情')
  })
})

describe('buildDraftPrompt: 章号注入', () => {
  it('长篇 → 正确章号', () => {
    const p = buildDraftPrompt(dir, 7, 'long')
    expect(p).toContain('第 7 章')
  })

  it('短篇 → 正确章号', () => {
    const p = buildDraftPrompt(dir, 3, 'short')
    expect(p).toContain('第 3 章')
  })
})
