/**
 * kind 分支单测(横切 P1):验证长短篇分支逻辑纯函数。
 *
 * kind 分支核心在纯函数(buildDraftPrompt/buildOutlinePrompt/lensToRole/draftFileName/buildRewritePrompt);
 * http 层无 kind 逻辑。直接测纯函数 = 覆盖 API 端点背后的 kind 分支。
 * buildDraftPrompt/buildOutlinePrompt 读 bookRoot 文件,用临时 fixture(不调大模型/CLI)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDraftPrompt } from '../../src/studio/server/api/draft.js'
import { buildOutlinePrompt } from '../../src/studio/server/api/outline.js'
import { lensToRole } from '../../src/studio/server/api/review.js'
import { buildRewritePrompt, draftFileName } from '../../src/studio/server/api/rewrite.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-kind-'))
  mkdirSync(join(root, '大纲'), { recursive: true })
  writeFileSync(join(root, '大纲', '总纲.md'), '# 总纲\n仙侠:林远/清虚门/玉佩/旧案反转')
  mkdirSync(join(root, '工作区'), { recursive: true })
  writeFileSync(join(root, '工作区', '细纲.md'), '# 细纲\n场景:夜战 / 反转:玉佩认主')
  writeFileSync(join(root, '工作区', '本章写作材料.md'), '# 备料\n境界:练气')
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('buildDraftPrompt(kind 分支)', () => {
  it('短篇:篇 front matter + 8k-20k 字单篇闭合', () => {
    const p = buildDraftPrompt(root, 1, 'short')
    expect(p).toContain('短篇')
    expect(p).toContain('篇号: 1')
    expect(p).toContain('目标情绪')
    expect(p).toContain('核心反转')
    expect(p).toContain('8000-20000 字')
    expect(p).toContain('单篇完整开合')
    expect(p).not.toContain('章尾留钩')
  })

  it('长篇:章 front matter + 2k-4k 字章尾留钩', () => {
    const p = buildDraftPrompt(root, 5, 'long')
    expect(p).toContain('长篇')
    expect(p).toContain('章号: 5')
    expect(p).toContain('钩子类型')
    expect(p).toContain('2000-4000 字')
    expect(p).toContain('章尾留钩')
    expect(p).not.toContain('单篇闭合')
  })

  it('短篇 prompt 注入本篇细纲', () => {
    expect(buildDraftPrompt(root, 1, 'short')).toContain('本篇细纲')
  })

  it('长篇 prompt 注入本章细纲 + 备料', () => {
    const p = buildDraftPrompt(root, 1, 'long')
    expect(p).toContain('本章细纲')
    expect(p).toContain('备料')
  })
})

describe('buildOutlinePrompt(kind 分支)', () => {
  it('短篇:篇纲 + 目标情绪/核心反转/单篇开合', () => {
    const p = buildOutlinePrompt(root, 2, 'short')
    expect(p).toContain('篇纲')
    expect(p).toContain('目标情绪')
    expect(p).toContain('核心反转')
    expect(p).toContain('8000-20000')
  })

  it('长篇:细纲 + 场景/账本推进/章尾钩', () => {
    const p = buildOutlinePrompt(root, 2, 'long')
    expect(p).toContain('细纲')
    expect(p).toContain('账本推进')
    expect(p).toContain('章尾钩')
  })

  it('短篇:有前篇时注入前篇摘要(避重复主题/情绪)', () => {
    mkdirSync(join(root, '篇', '001-旧案'), { recursive: true })
    writeFileSync(
      join(root, '篇', '001-旧案', '正文.md'),
      '---\n篇号: 1\n标题: 旧案\n目标情绪: 震撼\n核心反转: 认主\n---\n正文…',
    )
    const p = buildOutlinePrompt(root, 2, 'short')
    expect(p).toContain('前篇')
    expect(p).toContain('第1篇')
    expect(p).toContain('震撼')
  })

  it('长篇:无定稿正文时不崩(前章段省略)', () => {
    const p = buildOutlinePrompt(root, 1, 'long')
    expect(p).toContain('细纲') // 任务+要求仍在
  })
})

describe('lensToRole(镜头 → 角色文件映射)', () => {
  it('emotion_peak → emotion-review(名不一致,核心映射)', () => {
    expect(lensToRole('emotion_peak')).toBe('emotion-review')
  })
  it('短篇镜头 hook/payoff → 同名 -review', () => {
    expect(lensToRole('hook')).toBe('hook-review')
    expect(lensToRole('payoff')).toBe('payoff-review')
  })
  it('长篇镜头 reader/editor/continuity → 同名 -review', () => {
    expect(lensToRole('reader')).toBe('reader-review')
    expect(lensToRole('editor')).toBe('editor-review')
    expect(lensToRole('continuity')).toBe('continuity-review')
  })
})

describe('draftFileName(kind 分支)', () => {
  it('短篇:候选序号 草稿-1.md(与篇号无关)', () => {
    expect(draftFileName(1, 'short')).toBe('草稿-1.md')
    expect(draftFileName(5, 'short')).toBe('草稿-1.md')
  })
  it('长篇:草稿-<章号>.md', () => {
    expect(draftFileName(1, 'long')).toBe('草稿-1.md')
    expect(draftFileName(5, 'long')).toBe('草稿-5.md')
  })
})

describe('buildRewritePrompt(kind 分支)', () => {
  it('whole 短篇:第N篇 + 8k-20k 字单篇开合', () => {
    const p = buildRewritePrompt('whole', '原篇正文', '', '更紧张', [], 3, 'short')
    expect(p).toContain('第 3 篇')
    expect(p).toContain('8000-20000 字')
    expect(p).toContain('单篇完整开合')
  })
  it('whole 长篇:第N章 + 2k-4k 字单章钩', () => {
    const p = buildRewritePrompt('whole', '原章正文', '', '更紧张', [], 3, 'long')
    expect(p).toContain('第 3 章')
    expect(p).toContain('2000-4000 字')
    expect(p).toContain('章尾留钩')
  })
  it('local:选段改写,不分 kind(两 kind 输出结构一致)', () => {
    const pShort = buildRewritePrompt('local', '原', '选中段', '精简', [], 1, 'short')
    const pLong = buildRewritePrompt('local', '原', '选中段', '精简', [], 1, 'long')
    expect(pShort).toContain('选中段落')
    expect(pLong).toContain('选中段落')
  })
  it('whole 带审稿意见:逐条采纳', () => {
    const p = buildRewritePrompt('whole', '原', '', '改', ['OOC:林远', '逻辑:玉佩'], 1, 'long')
    expect(p).toContain('审稿意见')
    expect(p).toContain('1. OOC:林远')
    expect(p).toContain('2. 逻辑:玉佩')
  })
})
