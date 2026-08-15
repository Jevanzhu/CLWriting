/**
 * 账本推进草拟（W-P1-3 右端）单元测试。
 *
 * 覆盖：
 * - parseLeadUpdateDraft：编号白名单 + 动词合法表过滤（臆造编号/非法动词被剔除）
 * - buildLeadUpdatePrompt：注入正文 + 细纲声明 + 进行中账本
 * - 与 check/lead-updates.ts 读取格式同构（两端闭合右侧数据源闭环）
 */
import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLeadUpdateDraft, buildLeadUpdatePrompt } from '../../src/process/lead-update-draft.js'
import { readChapterLeadUpdates } from '../../src/check/lead-updates.js'

/** 造一本有布线的短书（book.yaml + 布线/悬念 一条进行中线） */
function makeWiringBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'lead-draft-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  // 悬念-001 进行中
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  // 成长线-001 未启用类 → 不在白名单
  return root
}

test('parseLeadUpdateDraft: 合法行保留，臆造编号/非法动词剔除', () => {
  const root = makeWiringBook()
  try {
    const text = [
      '# 本章账本推进',
      '- 悬念-001 递进：焦痕在烛火下泛着暗红。',
      '- 悬念-999 递进：臆造编号应被剔除。',
      '- 悬念-001 胡诌：非法动词应被剔除。',
      '- 成长线-001 起步：未启用类不在白名单。',
    ].join('\n')
    const out = parseLeadUpdateDraft(text, root)
    expect(out).toEqual([{ leadId: '悬念-001', 动词: '递进', 证据: '焦痕在烛火下泛着暗红。' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseLeadUpdateDraft: 无推进 → 空数组', () => {
  const root = makeWiringBook()
  try {
    expect(parseLeadUpdateDraft('无推进', root)).toEqual([])
    expect(parseLeadUpdateDraft('', root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildLeadUpdatePrompt: 注入正文 + 细纲声明 + 进行中账本', () => {
  const root = makeWiringBook()
  try {
    // 细纲声明推进 悬念-001（带章号 1）
    mkdirSync(join(root, '工作区'), { recursive: true })
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: [悬念-001]\n---\n\n本章细纲正文。\n', 'utf-8')
    const prompt = buildLeadUpdatePrompt(root, 1, '焦痕在烛火下泛着暗红。正文内容。')
    expect(prompt).toContain('本章正文')
    expect(prompt).toContain('细纲声明推进')
    expect(prompt).toContain('悬念-001')
    expect(prompt).toContain('进行中账本')
    expect(prompt).toContain('焦痕在烛火下泛着暗红')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('闭环：parseLeadUpdateDraft 产出可被 readChapterLeadUpdates 读回（格式同构）', () => {
  const root = makeWiringBook()
  try {
    const text = '- 悬念-001 递进：焦痕在烛火下泛着暗红。\n'
    const parsed = parseLeadUpdateDraft(text, root)
    expect(parsed.length).toBe(1)
    // 模拟生成函数落盘 → 读取端解析
    mkdirSync(join(root, '工作区'), { recursive: true })
    writeFileSync(
      join(root, '工作区', '账本推进.md'),
      parsed.map((u) => '- ' + u.leadId + ' ' + u.动词 + '：' + u.证据).join('\n') + '\n',
      'utf-8',
    )
    expect(readChapterLeadUpdates(root)).toEqual([{ leadId: '悬念-001', 动词: '递进', 证据: '焦痕在烛火下泛着暗红。' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
