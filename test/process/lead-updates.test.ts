/**
 * 账本推进声明读取 单元测试 —— 账本 CLI 接缝修复。
 *
 * 覆盖 readChapterLeadUpdates（兑现层）+ readOutlineLeads（计划层）。
 */

import { test, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { leadEvidenceMatchesBody, parseLeadUpdateLines, readChapterLeadUpdates } from '../../src/check/lead-updates.js'
import { readOutlineLeads } from '../../src/check/outline-leads.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function tmpWorkDir(): string {
  return mkdtempTracked(join(tmpdir(), 'lead-updates-'))
}

test('readChapterLeadUpdates: 解析标准行（编号/动词/证据，全角冒号）', () => {
  const wd = tmpWorkDir()
  try {
    const wsDir = join(wd, '工作区')
    mkdirSync(wsDir, { recursive: true })
    writeFileSync(
      join(wsDir, '账本推进.md'),
      '- 成长线-001 起步：林开脉，踏入炼气一层。\n- 设定线-001 树立：灵脉体系——天地灵气分九品。\n',
      'utf-8',
    )
    expect(readChapterLeadUpdates(wd)).toEqual([
      { leadId: '成长线-001', 动词: '起步', 证据: '林开脉，踏入炼气一层。' },
      { leadId: '设定线-001', 动词: '树立', 证据: '灵脉体系——天地灵气分九品。' },
    ])
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('readChapterLeadUpdates: 半角冒号 + 忽略非列表行', () => {
  const wd = tmpWorkDir()
  try {
    const wsDir = join(wd, '工作区')
    mkdirSync(wsDir, { recursive: true })
    writeFileSync(join(wsDir, '账本推进.md'), '# 本章推进\n说明文字一行\n- 悬念-002 埋下: 桌上多了一封信\n', 'utf-8')
    expect(readChapterLeadUpdates(wd)).toEqual([{ leadId: '悬念-002', 动词: '埋下', 证据: '桌上多了一封信' }])
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('readChapterLeadUpdates: 空证据行忽略', () => {
  const wd = tmpWorkDir()
  try {
    const wsDir = join(wd, '工作区')
    mkdirSync(wsDir, { recursive: true })
    writeFileSync(join(wsDir, '账本推进.md'), '- 悬念-002 埋下:    \n', 'utf-8')
    expect(readChapterLeadUpdates(wd)).toEqual([])
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('leadEvidenceMatchesBody: 空证据核心不算正文命中', () => {
  expect(leadEvidenceMatchesBody('任意正文都不该让空证据通过。', '   ')).toBe(false)
})

test('readChapterLeadUpdates: 无文件 → []', () => {
  const wd = tmpWorkDir()
  try {
    expect(readChapterLeadUpdates(wd)).toEqual([])
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('readOutlineLeads: 多值 / 单值 / 缺省', () => {
  const wd = tmpWorkDir()
  try {
    // readOutlineLeads 从 bookRoot/工作区/细纲.md 读
    const wsDir = join(wd, '工作区')
    mkdirSync(wsDir, { recursive: true })
    writeFileSync(join(wsDir, '细纲.md'), '---\n章号: 1\n推进: [成长线-001, 设定线-001]\n---\n正文', 'utf-8')
    expect(readOutlineLeads(wd)).toEqual(['成长线-001', '设定线-001'])

    writeFileSync(join(wsDir, '细纲.md'), '---\n章号: 1\n推进: 成长线-001\n---\n正文', 'utf-8')
    expect(readOutlineLeads(wd)).toEqual(['成长线-001'])

    writeFileSync(join(wsDir, '细纲.md'), '---\n章号: 1\n---\n正文', 'utf-8')
    expect(readOutlineLeads(wd)).toEqual([])
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

// ── R75-2（二十三轮）：ATX 标题不折入声明证据（「声明了没兑现」定稿假红防线） ──

test('parseLeadUpdateLines: 节终标题行不折入上一条证据，其后人工备注不再触碰条目', () => {
  const text = [
    '- 悬念-001 埋下：焦痕在烛火下泛着暗红。',
    '',
    '## 备注',
    '',
    '作者备注：下章揭晓。',
  ].join('\n')
  // 此前「## 备注」「作者备注：下章揭晓。」都被 R73-23 续行折拼进上一条证据——
  // 证据 needle 命中正文必败 → 定稿闸「声明了没兑现」假红
  expect(parseLeadUpdateLines(text)).toEqual([
    { leadId: '悬念-001', 动词: '埋下', 证据: '焦痕在烛火下泛着暗红。' },
  ])
})

test('parseLeadUpdateLines: 首行章标签维持忽略；分组标题跳过、后随条目照常解析', () => {
  const text = [
    '# 第12章 账本推进',
    '',
    '- 悬念-001 埋下：焦痕',
    '',
    '### 第二批',
    '',
    '- 设定线-001 树立：灵脉分九品',
  ].join('\n')
  const out = parseLeadUpdateLines(text)
  expect(out).toHaveLength(2)
  expect(out[0]!.证据).toBe('焦痕')
  expect(out[1]!.leadId).toBe('设定线-001')
})

test('parseLeadUpdateLines: R73-23 普通续行折入维持（非标题文本仍折，不回归）', () => {
  const text = '- 悬念-001 埋下：焦痕\n第二行续文'
  const out = parseLeadUpdateLines(text)
  expect(out[0]!.证据).toBe('焦痕 第二行续文')
})
