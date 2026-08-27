/**
 * R66-7（十四轮）回归：outline prompt 注入源全量登记（铁律①「模型可见⟺已记录」）。
 *
 * 缺陷：buildOutlinePrompt 实际注入 总纲/设定/账本/前章/卷摘要 等来源文本，但端点
 * promptFiles 只登记卷进度文件——总纲/设定/账本注入无事件凭据，重放与审计对账失真。
 *
 * 修复：buildOutlinePromptWithFiles 返回 {prompt, files}（draft-pipeline Q-5 模式），
 * 每个真实注入源 pushFile 登记；端点把 files 全量落 promptFiles（llm/call promptMeta）。
 *
 * 另含 R66-27（outline 侧）：volumeProgressOf 的 existsSync→readFileSync 竞态读失败
 * （用「卷摘要路径是目录」稳定复现 EISDIR）应降级为整段省略，不裸穿 500。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildOutlinePrompt,
  buildOutlinePromptWithFiles,
  volumeProgressOf,
} from '../../src/studio/server/api/outline.js'

let root = ''

function makeChapter(dir: string, fileName: string, fm: string, body = '正文内容。'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), `---\n${fm}---\n\n${body}\n`, 'utf-8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-r66-7-'))
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 长篇 fixture：总纲 + 卷摘要 + 前章×2 + 角色卡 + 境界体系 + 账本（进行中/已收尾各一） */
function makeLongBook(): void {
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 登记测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  mkdirSync(join(root, '大纲'), { recursive: true })
  writeFileSync(join(root, '大纲', '总纲.md'), '# 总纲\n仙侠长篇主线。\n', 'utf-8')
  // 卷摘要：chapter 51 ∈ 卷 2（默认卷长 50）→ 注入卷 1 摘要
  mkdirSync(join(root, '定稿', '摘要', '卷摘要'), { recursive: true })
  writeFileSync(join(root, '定稿', '摘要', '卷摘要', '1.md'), '# 第 1 卷\n\n第一卷的进展。\n', 'utf-8')
  makeChapter(join(root, '写作', '正文'), '0049-追杀.md', '章号: 49\n标题: 追杀\n钩子类型: 危机钩\n情绪定位: 压抑\n')
  makeChapter(join(root, '写作', '正文'), '0050-破局.md', '章号: 50\n标题: 破局\n钩子类型: 悬念钩\n情绪定位: 转折\n')
  // 设定层：角色卡（无 fm 走降级分支，仍注入）+ 境界体系
  mkdirSync(join(root, '设定', '角色'), { recursive: true })
  writeFileSync(join(root, '设定', '角色', '林远.md'), '林远的自由描述正文。\n', 'utf-8')
  writeFileSync(
    join(root, '设定', '境界体系.md'),
    '---\n体系:\n  - 名称: 修真\n    序列: [炼气, 筑基, 金丹]\n---\n修真境界说明。\n',
    'utf-8',
  )
  // 账本：布线/悬念（基础类）——进行中注入并登记；已收尾不注入不登记
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '布线', '悬念', '悬念-002-黑手.md'),
    '---\n编号: 悬念-002\n标题: 黑手\n类型: 悬念\n状态: 已收尾\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
}

describe('R66-7: outline promptFiles 全源登记（铁律①）', () => {
  it('长篇：总纲/卷摘要/前章/角色卡/境界体系/进行中账本 全部进 files（注入序）', () => {
    makeLongBook()
    const { prompt, files } = buildOutlinePromptWithFiles(root, 51, 'long')
    // 注入内容确在 prompt（总纲切片/卷摘要/前章行/设定层/账本行集）
    expect(prompt).toContain('仙侠长篇主线')
    expect(prompt).toContain('第 1 卷摘要')
    expect(prompt).toContain('第50章 破局')
    expect(prompt).toContain('林远')
    expect(prompt).toContain('悬念-001 灭门真凶')
    // 修复核心断言：每个真实注入源都出现在 files 清单（此前只登卷摘要）
    expect(files).toEqual([
      '大纲/总纲.md',
      '定稿/摘要/卷摘要/1.md',
      '写作/正文/0050-破局.md',
      '写作/正文/0049-追杀.md',
      '设定/角色/林远.md',
      '设定/境界体系.md',
      '布线/悬念/悬念-001-灭门真凶.md',
    ])
  })

  it('长篇：已收尾账本不注入 → 不登记（只列真实入 prompt 的段）', () => {
    makeLongBook()
    const { prompt, files } = buildOutlinePromptWithFiles(root, 51, 'long')
    expect(prompt).not.toContain('悬念-002')
    expect(files).not.toContain('布线/悬念/悬念-002-黑手.md')
  })

  it('短篇：总纲/前章/本章章纲/设定层 进 files', () => {
    writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: short\nbook:\n  title: 短篇书\nhost: cc\n', 'utf-8')
    mkdirSync(join(root, '大纲'), { recursive: true })
    writeFileSync(join(root, '大纲', '总纲.md'), '# 总纲\n短篇主线。\n', 'utf-8')
    makeChapter(
      join(root, '写作', '正文'),
      '0001-旧案.md',
      '章号: 1\n标题: 旧案\n目标情绪: 震撼\n核心反转: 认主\n',
    )
    makeChapter(join(root, '大纲', '章纲'), '0002-转折.md', '章号: 2\n标题: 转折\n')
    mkdirSync(join(root, '设定'), { recursive: true })
    writeFileSync(
      join(root, '设定', '境界体系.md'),
      '---\n体系:\n  - 名称: 修真\n    序列: [炼气, 筑基]\n---\n说明。\n',
      'utf-8',
    )
    const { prompt, files } = buildOutlinePromptWithFiles(root, 2, 'short')
    expect(prompt).toContain('短篇主线')
    expect(prompt).toContain('第1章 旧案')
    expect(files).toEqual([
      '大纲/总纲.md',
      '写作/正文/0001-旧案.md',
      '大纲/章纲/0002-转折.md',
      '设定/境界体系.md',
    ])
  })

  it('空书：无任何注入源 → files 为空（缺失可从 promptMeta 查「未注入」）', () => {
    writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 空书\nhost: cc\n', 'utf-8')
    const { prompt, files } = buildOutlinePromptWithFiles(root, 1, 'long')
    expect(prompt).toContain('为第 1 章生成细纲')
    expect(files).toEqual([])
  })

  it('buildOutlinePrompt 薄壳返回纯文本（既有 string 调用方兼容）', () => {
    makeLongBook()
    const withFiles = buildOutlinePromptWithFiles(root, 51, 'long')
    expect(buildOutlinePrompt(root, 51, 'long')).toBe(withFiles.prompt)
    expect(typeof buildOutlinePrompt(root, 51, 'long')).toBe('string')
  })
})

describe('R66-27: volumeProgressOf 读稿守卫', () => {
  it('卷摘要路径被目录占位（existsSync true + read 抛 EISDIR）→ 整段省略不裸穿', () => {
    writeFileSync(
      join(root, 'book.yaml'),
      'spec_version: 1\nkind: long\nbook:\n  title: 守卫书\nhost: cc\n',
      'utf-8',
    )
    // 建「卷摘要/1.md」为目录：existsSync 命中但 readFileSync 必抛——稳定复现
    // existsSync→read 间读失败的竞态形态（修复前 EISDIR 裸穿端点 500）
    mkdirSync(join(root, '定稿', '摘要', '卷摘要', '1.md'), { recursive: true })
    expect(() => volumeProgressOf(root, 51, null)).not.toThrow()
    expect(volumeProgressOf(root, 51, null)).toEqual({ section: null, file: null })
  })
})
