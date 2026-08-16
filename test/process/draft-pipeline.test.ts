/**
 * draft-pipeline 单测（第十一轮 P1-TST-2）：
 * buildDraftPrompt 长短篇分支 + 上下文组装。
 *
 * snapshotBeforeOverwrite / saveDraft 涉及 manifest + tree + git 多模块交互，
 * 此处聚焦 buildDraftPrompt 的 prompt 组装正确性（AI 写稿质量根基）。
 *
 * C3（DSH-17）：设定注入改预算制——世界观/角色/境界共享 SETTINGS_BUDGET_CHARS，
 * 预算内世界观全文直入（B3 的 1200 阈值无差别 prune 在本链路被取代）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDraftPrompt, SETTINGS_BUDGET_CHARS } from '../../src/process/draft-pipeline.js'

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

  it('有世界观 → 含世界观段', () => {
    mkdirSync(join(dir, '设定'), { recursive: true })
    writeFileSync(join(dir, '设定', '世界观.md'), '修仙世界，灵气复苏')
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).toContain('修仙世界')
    expect(p).toContain('## 世界观(本书设定,保持设定一致)')
  })
})

describe('buildDraftPrompt: 设定预算注入（C3 / DSH-17）', () => {
  it('世界观超 1200 但预算内 → 全文直入（B3 修剪在本链路被预算机制取代）', () => {
    mkdirSync(join(dir, '设定'), { recursive: true })
    const long = '界'.repeat(3000)
    writeFileSync(join(dir, '设定', '世界观.md'), long)
    const p = buildDraftPrompt(dir, 1, 'long')
    // 3000 < SETTINGS_BUDGET_CHARS(6000)：全文注入，不再按 B3 的 1200 阈值头尾修剪
    expect(p).toContain(long)
    expect(p).not.toContain('[...中段已省略...]')
    expect(p).not.toContain('超预算')
  })

  it('世界观超预算 → 截断声明 + 注入量受控', () => {
    mkdirSync(join(dir, '设定'), { recursive: true })
    writeFileSync(join(dir, '设定', '世界观.md'), '界'.repeat(8000))
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).toContain('## 世界观(本书设定,保持设定一致)')
    // in-band 声明指名截断了什么；prune 头尾保留 + 中段省略
    expect(p).toContain('（世界观超预算已截断）')
    expect(p).toContain('[...中段已省略...]')
    // '界' 出现次数受预算约束（8000 全文 → 远小于 8000，恒 ≤ 预算量级）
    expect(p.split('界').length - 1).toBeLessThan(SETTINGS_BUDGET_CHARS)
  })

  it('世界观 + 角色 + 境界 → 同一预算段注入（层序：世界观→角色→境界）', () => {
    mkdirSync(join(dir, '设定', '角色'), { recursive: true })
    writeFileSync(join(dir, '设定', '世界观.md'), '修仙世界，灵气复苏')
    writeFileSync(join(dir, '设定', '角色', '林远.md'), '---\n姓名: 林远\n身份: 清虚门弟子\n境界: 练气\n---\n正文')
    writeFileSync(
      join(dir, '设定', '境界体系.md'),
      '---\n体系:\n  - 名称: 修真\n    序列: [炼气, 筑基]\n---\n说明',
    )
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).toContain('## 世界观(本书设定,保持设定一致)')
    expect(p).toContain('## 角色设定(供参考,保持人物一致)')
    expect(p).toContain('## 境界体系(成长线机检依据)')
    expect(p).toContain('林远')
    expect(p).toContain('炼气')
    // 层序 = 传入序（世界观最前，境界最后），不按 specificity 重排
    expect(p.indexOf('## 世界观')).toBeLessThan(p.indexOf('## 角色设定'))
    expect(p.indexOf('## 角色设定')).toBeLessThan(p.indexOf('## 境界体系'))
  })
})

describe('buildDraftPrompt: 短篇', () => {
  it('基本结构 → 含短篇要求', () => {
    const p = buildDraftPrompt(dir, 1, 'short')
    expect(p).toContain('短篇')
    expect(p).toContain('8000-20000 字')
    expect(p).toContain('铺垫→反转→收尾')
  })

  it('CC-P2-22: 要求五段 ## 标题（与节数机检同口径），不再「禁 markdown 标题」', () => {
    // 节数守恒机检按 ## 标题计数（checkSectionCount），守规稿不应再因无标题被报项
    const p = buildDraftPrompt(dir, 1, 'short')
    expect(p).toContain('## 开头钩子')
    expect(p).toContain('## 余韵')
    expect(p).not.toContain('禁 markdown 标题')
  })

  it('CC-P2-22: 长篇维持纯叙事文本（禁 markdown 标题——长篇无节数机检）', () => {
    const p = buildDraftPrompt(dir, 1, 'long')
    expect(p).toContain('禁 markdown 标题')
    expect(p).not.toContain('## 开头钩子')
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
